import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCompactTokens,
  formatTokenNumber,
  normalizeTokenResponse,
  parseProvidersFromYaml,
  resolveProviderCredentials,
  tokenBalanceScoreDelta,
  fetchTokenBalance,
} from '../lib/token-balance.js'

test('parseProvidersFromYaml parses providers block from cordis patch yaml', () => {
  const yaml = `
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      aihope:
        apiKeyEnv: AIHOPE_API_KEY
        api: openai-completions
        baseURL: https://aihope.fun/v1
        models:
          - id: gpt-6-luna
      openrouter:
        apiKey: sk-or-test1234
        baseURL: https://openrouter.ai/api/v1
`
  const providers = parseProvidersFromYaml(yaml)
  assert.equal(providers.aihope.apiKeyEnv, 'AIHOPE_API_KEY')
  assert.equal(providers.aihope.baseURL, 'https://aihope.fun/v1')
  assert.equal(providers.openrouter.apiKey, 'sk-or-test1234')
  assert.equal(providers.openrouter.baseURL, 'https://openrouter.ai/api/v1')
})

test('normalizeTokenResponse handles exact aihope / New API payload', () => {
  const sample = {
    success: true,
    code: true,
    message: 'ok',
    data: {
      object: 'token_usage',
      name: 'ebluffy',
      tokens_granted: 155988220,
      tokens_available: 50194340,
      tokens_used: 105793880,
      tokens_description: 'Пакет: 50,194,340 доступно из 155,988,220 токенов',
      total_granted: 155988220,
      total_used: 105793880,
      total_available: 50194340,
      unlimited_quota: false,
      model_limits: {},
      model_limits_enabled: false,
      expires_at: -1,
    },
  }

  const res = normalizeTokenResponse(sample)
  assert.equal(res.isTracked, true)
  assert.equal(res.status, 'ok')
  assert.equal(res.availableTokens, 50194340)
  assert.equal(res.totalTokens, 155988220)
  assert.equal(res.usedTokens, 105793880)
  assert.equal(res.unlimited, false)
  assert.equal(res.level, 'normal')
  assert.equal(res.isLow, false)
  assert.equal(res.isExhausted, false)
  assert.equal(res.formattedAvailable, '50,194,340')
  assert.equal(res.compactAvailable, '50.2M')
  assert.ok(Math.abs(res.remainingFraction - 0.3217) < 0.01)
})

test('normalizeTokenResponse identifies low and exhausted token balances', () => {
  // Low balance (10% remaining)
  const lowSample = {
    success: true,
    data: {
      tokens_available: 10000000,
      tokens_granted: 100000000,
      unlimited_quota: false,
    },
  }
  const lowRes = normalizeTokenResponse(lowSample)
  assert.equal(lowRes.level, 'low')
  assert.equal(lowRes.isLow, true)
  assert.equal(lowRes.isExhausted, false)

  // Exhausted balance (0 tokens)
  const exhaustedSample = {
    success: true,
    data: {
      tokens_available: 0,
      tokens_granted: 100000000,
      unlimited_quota: false,
    },
  }
  const exhRes = normalizeTokenResponse(exhaustedSample)
  assert.equal(exhRes.level, 'exhausted')
  assert.equal(exhRes.isLow, false)
  assert.equal(exhRes.isExhausted, true)
})

test('normalizeTokenResponse handles unlimited quota and OpenRouter/OneAPI formats', () => {
  // Unlimited
  const unlimitedSample = {
    success: true,
    data: {
      unlimited_quota: true,
      tokens_available: -1,
    },
  }
  const unlRes = normalizeTokenResponse(unlimitedSample)
  assert.equal(unlRes.unlimited, true)
  assert.equal(unlRes.level, 'high')

  // OpenRouter credits
  const openRouterSample = {
    data: {
      total_credits: 50.0,
      total_usage: 10.0,
    },
  }
  const orRes = normalizeTokenResponse(openRouterSample)
  assert.equal(orRes.availableTokens, 40.0)
  assert.equal(orRes.remainingFraction, 0.8)
  assert.equal(orRes.level, 'high')

  // OneAPI classic billing
  const oneApiSample = {
    hard_limit_usd: 100,
    total_usage: 85,
  }
  const oaRes = normalizeTokenResponse(oneApiSample)
  assert.equal(oaRes.availableTokens, 15)
  assert.equal(oaRes.remainingFraction, 0.15)
  assert.equal(oaRes.level, 'low')
})

test('resolveProviderCredentials resolves API keys across sources', () => {
  const env = {
    AIHOPE_API_KEY: 'env-aihope-key',
    CUSTOM_ENV_KEY: 'custom-key',
  }

  // 1. apiKeyEnv match
  const c1 = resolveProviderCredentials('aihope', { apiKeyEnv: 'AIHOPE_API_KEY', baseURL: 'https://aihope.fun/v1' }, {}, env)
  assert.equal(c1.apiKey, 'env-aihope-key')

  // 2. Conventional <PROVIDER>_API_KEY match
  const c2 = resolveProviderCredentials('aihope', { baseURL: 'https://aihope.fun/v1' }, {}, env)
  assert.equal(c2.apiKey, 'env-aihope-key')

  // 3. User settings override wins
  const settings = {
    providers: {
      aihope: { apiKey: 'user-override-key' },
    },
  }
  const c3 = resolveProviderCredentials('aihope', { apiKeyEnv: 'AIHOPE_API_KEY', baseURL: 'https://aihope.fun/v1' }, settings, env)
  assert.equal(c3.apiKey, 'user-override-key')
})

test('fetchTokenBalance fetches and caches response without leaking credentials', async () => {
  const mockPayload = {
    success: true,
    data: {
      tokens_available: 50000000,
      tokens_granted: 100000000,
      unlimited_quota: false,
    },
  }

  let calledUrl = null
  let calledAuth = null
  const mockFetch = async (url, opts) => {
    calledUrl = url
    calledAuth = opts.headers.Authorization
    return {
      ok: true,
      status: 200,
      json: async () => mockPayload,
    }
  }

  const creds = {
    providerId: 'test_provider',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-secret-12345',
  }

  const res = await fetchTokenBalance(creds, mockFetch, 1000)
  assert.equal(calledUrl, 'https://api.example.com/api/usage/token')
  assert.equal(calledAuth, 'Bearer sk-secret-12345')
  assert.equal(res.isTracked, true)
  assert.equal(res.availableTokens, 50000000)
  assert.equal(res.apiKey, undefined) // Never leaks secret

  // Second call within TTL returns cached result without invoking fetch
  calledUrl = null
  const cached = await fetchTokenBalance(creds, mockFetch, 1500)
  assert.equal(calledUrl, null)
  assert.equal(cached.availableTokens, 50000000)
})

test('tokenBalanceScoreDelta applies score penalties and bonuses', () => {
  // Exhausted
  assert.equal(tokenBalanceScoreDelta({ isTracked: true, isExhausted: true }), 9999)

  // Low
  assert.equal(tokenBalanceScoreDelta({ isTracked: true, isLow: true }), 80)

  // Healthy (50%) -> bonus of -5
  assert.equal(tokenBalanceScoreDelta({ isTracked: true, isLow: false, isExhausted: false, remainingFraction: 0.5 }), -5)
})
