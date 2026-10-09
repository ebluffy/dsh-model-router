/**
 * dsh-model-router — OpenAI-compatible token balance tracking and protection.
 *
 * Supports New API, One API, aihope, OpenRouter, and standard OpenAI proxies.
 * Automatically discovers providers configured in cordis.patch.yml / cordis.yml
 * or explicitly overridden in model router settings.
 *
 * Normalizes remaining token balance into levels:
 *  - 'exhausted' (0% or <= 0 available tokens)
 *  - 'low'       (<= 20% or <= 100k tokens)
 *  - 'normal'    (20% - 50%)
 *  - 'high'      (>= 50% or unlimited)
 *  - 'unlimited' (unlimited_quota flag)
 *
 * Exposes clean, privacy-safe telemetry without leaking secret API keys.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_TOKEN_RESERVE_FRACTION = 0.20
export const DEFAULT_LOW_TOKEN_COUNT = 100000 // 100k tokens
export const TOKEN_CACHE_TTL_MS = 60000 // 60s cache

/** Cache map: providerId -> { data, timestamp } */
const balanceCache = new Map()

/** Resolve the active DSH profile directory. */
export function resolveProfileDir(env = typeof process === 'undefined' ? {} : process.env) {
  if (env.DSH_PROFILE_DIR && existsSync(env.DSH_PROFILE_DIR)) return env.DSH_PROFILE_DIR

  const candidates = []
  if (env.DSH_STATE_DIR) candidates.push(join(env.DSH_STATE_DIR, 'profiles', 'desktop'))
  if (env.USERPROFILE) {
    candidates.push(join(env.USERPROFILE, '.dsh', 'profiles', 'desktop'))
    const match = env.USERPROFILE.match(/^(.*?)[\\/]\.dsh[\\/]/)
    if (match) {
      candidates.push(join(match[1], '.dsh', 'profiles', 'desktop'))
    }
  }
  if (env.HOME) candidates.push(join(env.HOME, '.dsh', 'profiles', 'desktop'))
  candidates.push(join(homedir(), '.dsh', 'profiles', 'desktop'))

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0] || ''
}

/**
 * Lightweight YAML parser to extract custom providers from cordis.patch.yml.
 * Specifically looks for `providers:` blocks under plugins like `@deepseek-ai/dsh-llm-pi-ai`.
 */
export function parseProvidersFromYaml(content) {
  if (!content || typeof content !== 'string') return {}
  const providers = {}
  const ALLOWED_PROPS = new Set(['baseURL', 'apiKey', 'apiKeyEnv', 'api'])

  const lines = content.split(/\r?\n/)
  let inProviders = false
  let providersIndent = -1
  let currentProvider = null
  let providerIndent = -1

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = rawLine.search(/\S/)

    if (trimmed === 'providers:' || trimmed.endsWith('providers:')) {
      inProviders = true
      providersIndent = indent
      currentProvider = null
      providerIndent = -1
      continue
    }

    if (inProviders) {
      if (indent <= providersIndent && !trimmed.startsWith('-')) {
        inProviders = false
        currentProvider = null
        providerIndent = -1
        continue
      }

      // Check if this line is at the provider level (one level deeper than providers:)
      const keyMatch = trimmed.match(/^([a-zA-Z0-9_-]+):$/)
      if (keyMatch) {
        if (providerIndent === -1 || indent === providerIndent) {
          providerIndent = indent
          currentProvider = keyMatch[1]
          providers[currentProvider] = { id: currentProvider }
          continue
        }
      }

      // Check for property under provider (must have indent > providerIndent)
      if (currentProvider && indent > providerIndent && !trimmed.startsWith('-')) {
        const propMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
        if (propMatch) {
          const propKey = propMatch[1]
          if (ALLOWED_PROPS.has(propKey)) {
            let propVal = propMatch[2].trim()
            if ((propVal.startsWith('"') && propVal.endsWith('"')) || (propVal.startsWith("'") && propVal.endsWith("'"))) {
              propVal = propVal.slice(1, -1)
            }
            providers[currentProvider][propKey] = propVal
          }
        }
      }
    }
  }

  // Filter out any entries without baseURL or apiKey
  const valid = {}
  for (const [k, v] of Object.entries(providers)) {
    if (v.baseURL || v.apiKey || v.apiKeyEnv) {
      valid[k] = v
    }
  }
  return valid
}

/**
 * Discover all configured providers from cordis.patch.yml in the profile.
 */
export function discoverCordisProviders(profileDir = resolveProfileDir()) {
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const cordisFile = join(profileDir, 'cordis.yml')
  let providers = {}

  try {
    if (existsSync(patchFile)) {
      const raw = readFileSync(patchFile, 'utf8')
      providers = { ...providers, ...parseProvidersFromYaml(raw) }
    }
  } catch (_ignored) {}

  try {
    if (existsSync(cordisFile)) {
      const raw = readFileSync(cordisFile, 'utf8')
      providers = { ...providers, ...parseProvidersFromYaml(raw) }
    }
  } catch (_ignored) {}

  return providers
}

/**
 * Resolve effective credentials for a provider given discovered configs, settings, and env.
 */
export function resolveProviderCredentials(providerId, providerDef = {}, settings = {}, env = typeof process === 'undefined' ? {} : process.env) {
  const userSettings = (settings && settings.providers && settings.providers[providerId]) || {}
  const baseURL = userSettings.baseURL || providerDef.baseURL || ''
  
  // API key resolution order:
  // 1. Explicit user override in router settings
  // 2. Direct apiKey in cordis config
  // 3. Environment variable defined in apiKeyEnv
  // 4. Fallback conventional env: <PROVIDER>_API_KEY (e.g. AIHOPE_API_KEY)
  let apiKey = userSettings.apiKey || providerDef.apiKey || ''
  if (!apiKey && providerDef.apiKeyEnv && env[providerDef.apiKeyEnv]) {
    apiKey = env[providerDef.apiKeyEnv]
  }
  if (!apiKey) {
    const convKey = providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY'
    if (env[convKey]) apiKey = env[convKey]
  }
  if (!apiKey && providerId.toLowerCase() === 'openai' && env.OPENAI_API_KEY) {
    apiKey = env.OPENAI_API_KEY
  }

  return {
    providerId,
    baseURL,
    apiKey,
  }
}

/**
 * Format raw numbers with thousands separators (e.g. 50,194,340).
 */
export function formatTokenNumber(num) {
  if (typeof num !== 'number' || !Number.isFinite(num)) return '0'
  return Math.round(num).toLocaleString('en-US')
}

/**
 * Format compact token count (e.g. 50.2M, 450K).
 */
export function formatCompactTokens(num) {
  if (typeof num !== 'number' || !Number.isFinite(num)) return '0'
  if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B'
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(0) + 'K'
  return String(Math.round(num))
}

/**
 * Normalize API response from New API, One API, aihope, OpenRouter into a standard balance object.
 */
export function normalizeTokenResponse(json) {
  if (!json || typeof json !== 'object') {
    return { isTracked: false, status: 'invalid_response' }
  }

  // 1. New API / One API / aihope format:
  // { success: true, data: { tokens_available, total_available, tokens_granted, total_granted, unlimited_quota, ... } }
  const data = (json.data && typeof json.data === 'object') ? json.data : json

  const unlimited = data.unlimited_quota === true || data.unlimited === true
  let available = null
  let granted = null
  let used = null

  if (typeof data.tokens_available === 'number') available = data.tokens_available
  else if (typeof data.total_available === 'number') available = data.total_available
  else if (typeof data.available === 'number') available = data.available

  if (typeof data.tokens_granted === 'number') granted = data.tokens_granted
  else if (typeof data.total_granted === 'number') granted = data.total_granted
  else if (typeof data.granted === 'number') granted = data.granted

  if (typeof data.tokens_used === 'number') used = data.tokens_used
  else if (typeof data.total_used === 'number') used = data.total_used

  // 2. OpenRouter credits format:
  // { data: { total_credits, total_usage } }
  if (available === null && typeof data.total_credits === 'number') {
    const totalCredits = data.total_credits
    const totalUsage = typeof data.total_usage === 'number' ? data.total_usage : 0
    available = Math.max(0, totalCredits - totalUsage)
    granted = totalCredits
    used = totalUsage
  }

  // 3. One API USD billing format:
  // { hard_limit_usd, total_usage }
  if (available === null && typeof json.hard_limit_usd === 'number') {
    const limit = json.hard_limit_usd
    const totalUsage = typeof json.total_usage === 'number' ? json.total_usage : 0
    available = Math.max(0, limit - totalUsage)
    granted = limit
    used = totalUsage
  }

  if (available === null && !unlimited) {
    return { isTracked: false, status: 'unrecognized_format' }
  }

  let remainingFraction = 1.0
  if (unlimited) {
    remainingFraction = 1.0
  } else if (typeof available === 'number' && typeof granted === 'number' && granted > 0) {
    remainingFraction = Math.max(0, Math.min(1, available / granted))
  } else if (typeof available === 'number') {
    // If ceiling is not known, estimate from available token count
    remainingFraction = available > 1000000 ? 0.75 : (available > 100000 ? 0.35 : 0.10)
  }

  let level = 'normal'
  if (unlimited) {
    level = 'high'
  } else if (available !== null && available <= 0) {
    level = 'exhausted'
  } else if (typeof granted === 'number' && granted > 0) {
    // When granted total is known, level is determined by percentage
    if (remainingFraction <= DEFAULT_TOKEN_RESERVE_FRACTION) {
      level = 'low'
    } else if (remainingFraction >= 0.50) {
      level = 'high'
    } else {
      level = 'normal'
    }
  } else if (available !== null && available <= DEFAULT_LOW_TOKEN_COUNT) {
    level = 'low'
  } else if (remainingFraction >= 0.50) {
    level = 'high'
  }

  const isLow = level === 'low'
  const isExhausted = level === 'exhausted'

  return {
    isTracked: true,
    status: 'ok',
    availableTokens: available,
    totalTokens: granted,
    usedTokens: used,
    remainingFraction,
    unlimited,
    level,
    isLow,
    isExhausted,
    formattedAvailable: available !== null ? formatTokenNumber(available) : (unlimited ? 'Unlimited' : '0'),
    compactAvailable: available !== null ? formatCompactTokens(available) : (unlimited ? '∞' : '0'),
    description: data.tokens_description || null,
  }
}

/**
 * Fetch token balance for a single provider from its endpoint.
 */
export async function fetchTokenBalance(creds, fetchFn = (typeof fetch === 'function' ? fetch : null), now = Date.now()) {
  const { providerId, baseURL, apiKey } = creds
  if (!providerId) return { isTracked: false, status: 'no_provider' }
  if (!apiKey || !baseURL) {
    return {
      isTracked: false,
      providerId,
      status: !apiKey ? 'missing_api_key' : 'missing_base_url',
    }
  }

  // Check TTL cache
  const cached = balanceCache.get(providerId)
  if (cached && (now - cached.timestamp < TOKEN_CACHE_TTL_MS)) {
    return cached.data
  }

  if (typeof fetchFn !== 'function') {
    return { isTracked: false, providerId, status: 'fetch_unavailable' }
  }

  // Try candidate URLs:
  // 1. ${origin}/api/usage/token (standard New API / One API / aihope)
  // 2. ${baseURL.replace(/\/v1\/?$/, '')}/api/usage/token
  // 3. OpenRouter credits
  const candidateUrls = []
  try {
    const parsed = new URL(baseURL)
    candidateUrls.push(parsed.origin + '/api/usage/token')
    const stripped = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
    if (stripped + '/api/usage/token' !== parsed.origin + '/api/usage/token') {
      candidateUrls.push(stripped + '/api/usage/token')
    }
    if (baseURL.includes('openrouter.ai')) {
      candidateUrls.push('https://openrouter.ai/api/v1/credits')
    }
  } catch (_badUrl) {
    return { isTracked: false, providerId, status: 'invalid_base_url' }
  }

  let lastError = null
  for (const url of candidateUrls) {
    try {
      const timeoutSignal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
        ? AbortSignal.timeout(5000)
        : undefined

      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          Accept: 'application/json',
        },
        signal: timeoutSignal,
      })

      if (res.ok) {
        const json = await res.json()
        const normalized = normalizeTokenResponse(json)
        if (normalized.isTracked) {
          const result = {
            ...normalized,
            providerId,
            lastUpdated: now,
          }
          balanceCache.set(providerId, { data: result, timestamp: now })
          return result
        }
      } else if (res.status === 401 || res.status === 403) {
        const errorResult = {
          isTracked: true,
          providerId,
          status: 'auth_error',
          level: 'exhausted',
          isExhausted: true,
          isLow: true,
          formattedAvailable: 'Auth Error',
          compactAvailable: 'Auth Err',
          remainingFraction: 0,
        }
        balanceCache.set(providerId, { data: errorResult, timestamp: now })
        return errorResult
      }
    } catch (err) {
      lastError = err
    }
  }

  return {
    isTracked: false,
    providerId,
    status: 'unreachable',
    error: lastError ? String(lastError.message || lastError) : 'unknown',
  }
}

/**
 * Collect token balances for all configured providers.
 */
export async function collectAllTokenBalances(pool = [], settings = {}, env = typeof process === 'undefined' ? {} : process.env, fetchFn = (typeof fetch === 'function' ? fetch : null)) {
  const discovered = discoverCordisProviders()
  const providerIds = new Set()

  // Collect provider IDs from pool models
  for (const entry of pool) {
    if (entry && entry.provider) {
      let root = entry.provider
      if (root.startsWith('modlens-')) root = root.slice(8)
      if (root !== 'antigravity' && root !== 'deepseek-official') {
        providerIds.add(root)
      }
    }
  }

  // Also include any explicitly discovered or configured providers
  for (const p of Object.keys(discovered)) providerIds.add(p)
  if (settings && settings.providers) {
    for (const p of Object.keys(settings.providers)) providerIds.add(p)
  }

  const results = {}
  for (const pid of providerIds) {
    const creds = resolveProviderCredentials(pid, discovered[pid], settings, env)
    try {
      const balance = await fetchTokenBalance(creds, fetchFn)
      results[pid] = balance
      // If modlens wraps this provider, map alias as well
      results['modlens-' + pid] = balance
    } catch (_ignored) {
      results[pid] = { isTracked: false, providerId: pid, status: 'error' }
    }
  }

  return results
}

/**
 * Return cached balances synchronously (for instant UI state and routing loops).
 */
export function getCachedTokenBalances() {
  const result = {}
  for (const [pid, entry] of balanceCache.entries()) {
    result[pid] = entry.data
  }
  return result
}

/**
 * Compute the routing score delta for an entry based on its provider token balance.
 * Returns positive for penalty, negative for bonus.
 */
export function tokenBalanceScoreDelta(tokenBalance, cfg = {}) {
  if (!tokenBalance || !tokenBalance.isTracked) return 0
  if (tokenBalance.isExhausted) return 9999
  if (tokenBalance.isLow) {
    return (cfg.scoring && Number.isFinite(cfg.scoring.lowQuotaPenalty))
      ? cfg.scoring.lowQuotaPenalty
      : 80
  }
  if (typeof tokenBalance.remainingFraction === 'number' && tokenBalance.remainingFraction > 0.20) {
    return -Math.round(tokenBalance.remainingFraction * 10)
  }
  return 0
}
