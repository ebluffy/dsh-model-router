import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RESERVE_THRESHOLD,
  DEFAULT_EXHAUSTED_THRESHOLD,
  LOW_QUOTA_PENALTY,
  modelFamilyOf,
  resolveModelQuota,
  quotaScoreDelta,
  findHealthyAlternativeAccount,
  buildQuotaSummary,
} from '../lib/quotas.js'

const MOCK_POOL = {
  version: 1,
  activeAccountIds: {
    anthropic: 'acc_primary',
    openai: 'acc_primary',
    google: 'acc_primary',
  },
  accounts: [
    {
      id: 'acc_primary',
      email: 'primary@example.com',
      enabled: true,
      quotas: {
        google: {
          remainingFraction: 0.58,
          weeklyFraction: 0.93,
          resetTime: '2026-10-09T23:20:00Z',
        },
        anthropic: {
          remainingFraction: 0.172,
          weeklyFraction: 0.59,
          resetTime: '2026-10-09T22:00:00Z',
        },
        openai: {
          remainingFraction: 0.172,
          weeklyFraction: 0.59,
          resetTime: '2026-10-09T22:00:00Z',
        },
      },
      cooldowns: {},
    },
    {
      id: 'acc_backup',
      email: 'backup@example.com',
      enabled: true,
      quotas: {
        anthropic: {
          remainingFraction: 1.0,
          weeklyFraction: 0.31,
          resetTime: '2026-10-09T22:20:00Z',
        },
      },
      cooldowns: {},
    },
    {
      id: 'acc_cooldown',
      email: 'cooldown@example.com',
      enabled: true,
      quotas: {
        google: { remainingFraction: 0.8 },
      },
      cooldowns: {
        google: { cooldownUntil: Date.now() + 600000, reason: 'rate limit' },
      },
    },
  ],
}

test('modelFamilyOf identifies families from slugs', () => {
  assert.equal(modelFamilyOf('claude-opus-4-6-thinking'), 'anthropic')
  assert.equal(modelFamilyOf('claude-sonnet-4-6'), 'anthropic')
  assert.equal(modelFamilyOf('gemini-3.8-flash'), 'google')
  assert.equal(modelFamilyOf('gemini-2.5-pro'), 'google')
  assert.equal(modelFamilyOf('gpt-oss-120b-medium'), 'openai')
  assert.equal(modelFamilyOf('openai/gpt-4o'), 'openai')
  assert.equal(modelFamilyOf('unknown-model'), 'unknown')
  assert.equal(modelFamilyOf(''), 'unknown')
  assert.equal(modelFamilyOf(null), 'unknown')
})

test('resolveModelQuota tracks antigravity models and ignores other providers', () => {
  const other = resolveModelQuota('aihope/gpt-6-luna', MOCK_POOL)
  assert.equal(other.isTracked, false)

  const deepseek = resolveModelQuota('deepseek-official/deepseek-flash', MOCK_POOL)
  assert.equal(deepseek.isTracked, false)

  const claude = resolveModelQuota('antigravity/claude-opus-4-6-thinking', MOCK_POOL)
  assert.equal(claude.isTracked, true)
  assert.equal(claude.family, 'anthropic')
  assert.equal(claude.remainingFraction, 0.172)
  assert.equal(claude.status, 'reserve')
  assert.equal(claude.isLowQuota, true)
  assert.equal(claude.isExhausted, false)

  const gemini = resolveModelQuota('antigravity/gemini-3.8-flash', MOCK_POOL)
  assert.equal(gemini.isTracked, true)
  assert.equal(gemini.family, 'google')
  assert.equal(gemini.remainingFraction, 0.58)
  assert.equal(gemini.status, 'healthy')
  assert.equal(gemini.isLowQuota, false)
  assert.equal(gemini.isExhausted, false)
})

test('resolveModelQuota detects exhausted and cooldown models', () => {
  const poolExhausted = {
    accounts: [
      {
        id: 'acc1',
        enabled: true,
        quotas: { anthropic: { remainingFraction: 0.01 } },
        cooldowns: {},
      },
    ],
  }
  const q = resolveModelQuota('antigravity/claude-sonnet-4-6', poolExhausted)
  assert.equal(q.status, 'exhausted')
  assert.equal(q.isExhausted, true)

  const poolCd = {
    accounts: [
      {
        id: 'acc1',
        enabled: true,
        quotas: { google: { remainingFraction: 0.5 } },
        cooldowns: { google: { cooldownUntil: Date.now() + 50000 } },
      },
    ],
  }
  const qCd = resolveModelQuota('antigravity/gemini-3.8-flash', poolCd)
  assert.equal(qCd.status, 'cooldown')
  assert.equal(qCd.isExhausted, true)
})

test('quotaScoreDelta penalizes reserve models and rewards healthy ones', () => {
  const claudeQ = resolveModelQuota('antigravity/claude-opus-4-6-thinking', MOCK_POOL)
  const penalty = quotaScoreDelta(claudeQ)
  assert.equal(penalty, LOW_QUOTA_PENALTY) // 80 points penalty

  const geminiQ = resolveModelQuota('antigravity/gemini-3.8-flash', MOCK_POOL)
  const delta = quotaScoreDelta(geminiQ)
  assert.ok(delta < 0) // negative delta means score bonus

  const untracked = resolveModelQuota('aihope/gpt-6-luna', MOCK_POOL)
  assert.equal(quotaScoreDelta(untracked), 0)
})

test('findHealthyAlternativeAccount finds backup account with abundant quota', () => {
  const alt = findHealthyAlternativeAccount('anthropic', MOCK_POOL)
  assert.ok(alt)
  assert.equal(alt.id, 'acc_backup')
  assert.equal(alt.quotas.anthropic.remainingFraction, 1.0)
})

test('buildQuotaSummary formats telemetry for the client', () => {
  const summary = buildQuotaSummary(MOCK_POOL)
  assert.equal(summary.accounts.length, 3)
  assert.equal(summary.reserveThreshold, DEFAULT_RESERVE_THRESHOLD)
  assert.equal(summary.accounts[0].quotas.anthropic.remainingFraction, 0.172)
})
