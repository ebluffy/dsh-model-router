/**
 * dsh-model-router — quota awareness and protection engine.
 *
 * Reads real-time quota telemetry from ~/.dsh/agy-accounts/pool.json.
 * Tracks 5-hour and weekly quotas for Antigravity accounts (Anthropic/Claude, OpenAI/GPT-OSS, Google/Gemini).
 * Protects models near exhaustion (< 20% reserve threshold) by demoting or excluding them from automatic selection,
 * reserving remaining quota for explicit user commands.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { splitModelId } from './routing.js'

/** Default quota reserve threshold (2%). Models are used fully down to 2% before reserve/exhaustion. */
export const DEFAULT_RESERVE_THRESHOLD = 0.02

/** Default exhaustion threshold (2%). At or below this fraction, models cannot be selected. */
export const DEFAULT_EXHAUSTED_THRESHOLD = 0.02

/** Score penalty applied to models in reserve so healthy alternatives win. */
export const LOW_QUOTA_PENALTY = 80

/** Resolve the location of the Antigravity pool.json file. */
export function resolvePoolFile(env = typeof process === 'undefined' ? {} : process.env) {
  const dshState = env.DSH_STATE_DIR || join(env.USERPROFILE || env.HOME || homedir(), '.dsh')
  return join(dshState, 'agy-accounts', 'pool.json')
}

let cachedPoolData = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 3000

/** Read and parse pool.json with a short TTL cache to avoid heavy sync disk I/O. */
export function readAccountPool(filePath = resolvePoolFile(), forceFresh = false) {
  const now = Date.now()
  if (!forceFresh && cachedPoolData && (now - cacheTimestamp < CACHE_TTL_MS)) {
    return cachedPoolData
  }
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.accounts)) {
        cachedPoolData = parsed
        cacheTimestamp = now
        return parsed
      }
    }
  } catch (_ignored) {
    // Return empty on parse or I/O error
  }
  return { version: 1, mode: 'sequential', accounts: [] }
}

/** Map a model slug to its backend quota counter family (anthropic, openai, google). */
export function modelFamilyOf(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'unknown'
  const id = modelId.toLowerCase()
  if (id.startsWith('claude-') || id.includes('claude') || id.includes('anthropic')) return 'anthropic'
  if (id.startsWith('gemini-') || id.startsWith('gemma-') || id.includes('gemini')) return 'google'
  if (id.startsWith('gpt-') || id.startsWith('openai/') || id.includes('gpt-oss')) return 'openai'
  return 'unknown'
}

/**
 * Resolve quota health for a candidate model.
 * @param {string|object} candidate - model id string or pool entry object
 * @param {object} poolData - data from readAccountPool()
 * @param {number} now - timestamp in ms
 * @param {number} reserveThreshold - fraction below which model is in reserve (0-1)
 * @returns {object} quota metadata
 */
export function resolveModelQuota(candidate, poolData = readAccountPool(), now = Date.now(), reserveThreshold = DEFAULT_RESERVE_THRESHOLD) {
  const id = typeof candidate === 'string' ? candidate : (candidate && candidate.id ? candidate.id : '')
  const split = splitModelId(id, 'deepseek-official')
  if (!split) return { isTracked: false, status: 'unknown' }

  // Only antigravity provider models have pool.json telemetry
  if (split.provider !== 'antigravity') {
    return {
      isTracked: false,
      provider: split.provider,
      model: split.model,
      status: 'untracked',
    }
  }

  const family = modelFamilyOf(split.model)
  if (family === 'unknown') {
    return {
      isTracked: false,
      provider: split.provider,
      model: split.model,
      status: 'untracked',
    }
  }

  const accounts = Array.isArray(poolData && poolData.accounts) ? poolData.accounts : []
  if (accounts.length === 0) {
    return {
      isTracked: true,
      provider: split.provider,
      model: split.model,
      family,
      status: 'no_accounts',
    }
  }

  // Determine active account for this family
  const activeId = poolData.activeAccountIds && poolData.activeAccountIds[family]
  let activeAccount = accounts.find((a) => a.id === activeId && a.enabled !== false)
  if (!activeAccount) {
    activeAccount = accounts.find((a) => a.id === poolData.lastActiveAccountId && a.enabled !== false)
  }
  if (!activeAccount) {
    activeAccount = accounts.find((a) => a.id === poolData.primaryAccountId && a.enabled !== false)
  }
  if (!activeAccount) {
    activeAccount = accounts.find((a) => a.enabled !== false) || accounts[0]
  }

  // Reading telemetry must not pretend to select a different AGY account.
  const quota = activeAccount && activeAccount.quotas ? activeAccount.quotas[family] : null
  const cooldown = activeAccount && activeAccount.cooldowns ? activeAccount.cooldowns[family] : null
  const inCooldown = !!(cooldown && typeof cooldown.cooldownUntil === 'number' && cooldown.cooldownUntil > now)

  const remainingFraction = quota && typeof quota.remainingFraction === 'number' ? quota.remainingFraction : null
  const weeklyFraction = quota && typeof quota.weeklyFraction === 'number' ? quota.weeklyFraction : null
  const resetTime = quota && typeof quota.resetTime === 'string' ? quota.resetTime : null
  const weeklyResetTime = quota && typeof quota.weeklyResetTime === 'string' ? quota.weeklyResetTime : null

  let status = 'healthy'
  if (inCooldown) {
    status = 'cooldown'
  } else if (remainingFraction !== null && remainingFraction <= DEFAULT_EXHAUSTED_THRESHOLD) {
    status = 'exhausted'
  } else if (remainingFraction !== null && remainingFraction <= reserveThreshold) {
    status = 'reserve'
  }

  return {
    isTracked: true,
    provider: split.provider,
    model: split.model,
    family,
    accountId: activeAccount ? activeAccount.id : null,
    accountEmail: activeAccount ? activeAccount.email : null,
    remainingFraction,
    weeklyFraction,
    resetTime,
    weeklyResetTime,
    inCooldown,
    cooldownUntil: cooldown ? cooldown.cooldownUntil : null,
    status,
    isExhausted: status === 'exhausted' || status === 'cooldown',
    isLowQuota: status === 'reserve',
  }
}

/**
 * Compute the score penalty or bonus based on quota health.
 * Positive return value penalizes the candidate, negative rewards it.
 */
export function quotaScoreDelta(quotaInfo, cfg = {}) {
  if (!quotaInfo || !quotaInfo.isTracked) return 0
  if (quotaInfo.isExhausted) return 9999
  if (quotaInfo.isLowQuota) {
    const penalty = (cfg.scoring && Number.isFinite(cfg.scoring.lowQuotaPenalty))
      ? cfg.scoring.lowQuotaPenalty
      : LOW_QUOTA_PENALTY
    return penalty
  }
  if (typeof quotaInfo.remainingFraction === 'number' && quotaInfo.remainingFraction > 0.02) {
    // Healthy models get a small bonus up to 10 points proportional to remaining quota
    return -Math.round(quotaInfo.remainingFraction * 10)
  }
  return 0
}

/**
 * Check if another enabled account in the pool has abundant quota for this family.
 */
export function findHealthyAlternativeAccount(family, poolData, now = Date.now(), minFraction = 0.50) {
  const accounts = Array.isArray(poolData && poolData.accounts) ? poolData.accounts : []
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    const cd = acc.cooldowns && acc.cooldowns[family]
    if (cd && cd.cooldownUntil > now) continue
    const q = acc.quotas && acc.quotas[family]
    if (q && typeof q.remainingFraction === 'number' && q.remainingFraction >= minFraction) {
      return acc
    }
  }
  return null
}

/**
 * Generate a clean summary of all tracked models and accounts for the UI.
 */
export function buildQuotaSummary(poolData = readAccountPool()) {
  const accounts = Array.isArray(poolData && poolData.accounts) ? poolData.accounts : []
  const summary = {
    accounts: accounts.map((acc) => ({
      id: acc.id,
      alias: acc.alias || acc.id,
      email: acc.email || acc.alias || acc.id,
      enabled: acc.enabled !== false,
      systemHome: !!acc.systemHome,
      cooldowns: acc.cooldowns || {},
      quotas: Object.fromEntries(
        Object.entries(acc.quotas || {}).map(([fam, q]) => [
          fam,
          {
            remainingFraction: q ? q.remainingFraction : null,
            weeklyFraction: q ? q.weeklyFraction : null,
            resetTime: q ? q.resetTime : null,
          },
        ])
      ),
    })),
    primaryAccountId: poolData && poolData.primaryAccountId,
    activeAccountIds: (poolData && poolData.activeAccountIds) || {},
    lastActiveAccountId: poolData && poolData.lastActiveAccountId,
    reserveThreshold: DEFAULT_RESERVE_THRESHOLD,
  }
  return summary
}
