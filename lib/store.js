/**
 * dsh-model-router — durable UI state.
 *
 * The browser cannot write plugin config, so the UI's own edits (model pool,
 * presets, per-session control scope and pinned task type) live in a small JSON
 * file beside the profile, written atomically and debounced. Absent or corrupt
 * files degrade to the shipped defaults; nothing here can fail plugin load.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const EMPTY = Object.freeze({ version: 1, pool: null, presets: null, settings: null, last: null, prices: null, sessions: {} })

/** Resolve the state file from the host environment. */
export function resolveStoreFile(env = typeof process === 'undefined' ? {} : process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || '.', '.dsh')
  let profile = env.DSH_PROFILE
  if (!profile && typeof process !== 'undefined' && Array.isArray(process.argv)) {
    for (const arg of process.argv) {
      if (typeof arg === 'string' && (arg.includes('\\profiles\\') || arg.includes('/profiles/'))) {
        const parts = arg.split(/[\\/]/)
        const idx = parts.lastIndexOf('profiles')
        if (idx >= 0 && parts[idx + 1]) {
          profile = parts[idx + 1]
          break
        }
      }
    }
  }
  const profileDir = env.DSH_PROFILE_DIR || join(home, 'profiles', profile || 'desktop')
  return join(profileDir, '.model-router', 'state.json')
}

/** Open (or create) the store. Never throws. */
export function createStore(file = resolveStoreFile()) {
  let data = { ...EMPTY, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      data = { ...EMPTY, ...parsed, sessions: { ...(parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}) } }
    }
  } catch (_absentOrCorrupt) {
    // If target profile state is missing, check alternative profile (e.g. web fallback)
    try {
      const home = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || join((typeof process !== 'undefined' && process.env && (process.env.USERPROFILE || process.env.HOME)) || '.', '.dsh')
      const altFile = join(home, 'profiles', 'web', '.model-router', 'state.json')
      if (altFile !== file) {
        const alt = JSON.parse(readFileSync(altFile, 'utf8'))
        if (alt && typeof alt === 'object') {
          data = { ...EMPTY, ...alt, sessions: { ...(alt.sessions && typeof alt.sessions === 'object' ? alt.sessions : {}) } }
        }
      }
    } catch (_noAlt) { /* defaults */ }
  }
  let timer
  const flush = () => {
    timer = undefined
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(data, null, 2))
      renameSync(tmp, file)
    } catch (_unwritable) { /* state is advisory */ }
  }
  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(flush, 250)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  return {
    file,
    get pool() { return data.pool },
    set pool(value) { data.pool = value; schedule() },
    get presets() { return data.presets },
    set presets(value) { data.presets = value; schedule() },
    get settings() { return data.settings },
    set settings(value) { data.settings = value; schedule() },
    // The routing plan the user picked last: the default a conversation opens with.
    get last() { return data.last },
    set last(value) { data.last = value; schedule() },
    // The last OpenRouter price snapshot the user pulled: a compact
    // { fetchedAt, models: [{ id, name, level }] } used by auto-pricing.
    get prices() { return data.prices },
    set prices(value) { data.prices = value; schedule() },
    session(id) { return id ? data.sessions[id] : undefined },
    patchSession(id, patch) {
      if (!id) return undefined
      data.sessions[id] = { ...(data.sessions[id] || {}), ...patch }
      schedule()
      return data.sessions[id]
    },
    flush,
  }
}
