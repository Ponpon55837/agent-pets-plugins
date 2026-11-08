import type {
  PluginEventSourceState,
  PluginEventSourceStatusView,
  PluginLocalizedText,
} from '../src/types/plugin.ts'
import { SlidingWindowLimiter } from './sliding-window-limiter.ts'
import { isPluginId } from '../src/types/id-patterns.ts'
import { isRecord } from './value-guards.ts'

export const PLUGIN_EVENT_SOURCE_WINDOW_MS = 60_000
export const PLUGIN_EVENT_SOURCE_RATE_PER_PLUGIN = 30
export const PLUGIN_EVENT_SOURCE_RATE_GLOBAL = 120
export const PLUGIN_EVENT_SOURCE_MAX_SESSIONS_PER_PLUGIN = 20
export const PLUGIN_EVENT_SOURCE_MAX_SESSIONS_GLOBAL = 100
export const PLUGIN_EVENT_SOURCE_MAX_EVENT_BYTES = 2 * 1024
export const PLUGIN_EVENT_SOURCE_MAX_SESSION_ID_BYTES = 64
export const PLUGIN_EVENT_SOURCE_MAX_DISPLAY_NAME_CODE_POINTS = 80
export const PLUGIN_EVENT_SOURCE_ACTIVE_TTL_MS = 2 * 60_000
export const PLUGIN_EVENT_SOURCE_TERMINAL_TTL_MS = 30_000
export const PLUGIN_EVENT_SOURCE_MAX_SESSION_LIFETIME_MS = 30 * 60_000

export const PLUGIN_EVENT_SOURCE_RESERVED_FAMILIES = new Set([
  'codex', 'claude', 'claude-code', 'opencode',
  'codex-desktop', 'claude-desktop', 'opencode-cli', 'opencode-desktop',
  'generic-http', 'agent-pets', 'plugin', 'system',
])

const SESSION_ID = /^[\x21-\x7e]{1,64}$/
const EVENT_STATES = new Set<PluginEventSourceState>(['thinking', 'tool-running', 'idle', 'done', 'error'])
const TERMINAL_STATES = new Set<PluginEventSourceState>(['done', 'error'])

export interface PluginEventSourceContext {
  enabled: boolean
  pluginsEnabled: boolean
  pluginName: PluginLocalizedText
  family: string
  displayName: PluginLocalizedText
}

export type PluginEventSourceEmitResult =
  | { accepted: true }
  | { ok: false; error: 'invalid_request' | 'rate_limited' | 'not_permitted' | 'disabled' }

interface PluginEventSourceEntry {
  key: number
  pluginId: string
  sessionId: string
  pluginName: PluginLocalizedText
  displayName: PluginLocalizedText
  family: string
  state: PluginEventSourceState
  createdAt: number
  updatedAt: number
  updatedAtWall: number
  timer: ReturnType<typeof setTimeout> | null
}

interface PluginEventSourceControllerOptions {
  getContext: (pluginId: string) => PluginEventSourceContext | null
  onChanged: (statuses: PluginEventSourceStatusView[]) => void
  now?: () => number
  wallNow?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}

function normalizeSafeLocalizedText(value: PluginLocalizedText): PluginLocalizedText | null {
  const locales = ['zh-TW', 'en-US'] as const
  const normalized: PluginLocalizedText = { 'zh-TW': '', 'en-US': '' }
  for (const language of locales) {
    const raw = value?.[language]
    if (typeof raw !== 'string') return null
    const text = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim()
    if (text.length === 0 || Array.from(text).length > PLUGIN_EVENT_SOURCE_MAX_DISPLAY_NAME_CODE_POINTS) return null
    normalized[language] = text
  }
  return normalized
}

export function normalizePluginEventSourceFamily(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80 || /[^\x00-\x7f]/.test(value)) return null
  const normalized = value.trim().toLowerCase().replace(/[_.\s]+/g, '-')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || PLUGIN_EVENT_SOURCE_RESERVED_FAMILIES.has(normalized)) return null
  return normalized
}

function createSessionKey(pluginId: string, family: string, sessionId: string): string {
  return `${pluginId}\u0000${family}\u0000${sessionId}`
}

export class PluginEventSourceController {
  private readonly getContext: PluginEventSourceControllerOptions['getContext']
  private readonly onChanged: PluginEventSourceControllerOptions['onChanged']
  private readonly now: () => number
  private readonly wallNow: () => number
  private readonly schedule: NonNullable<PluginEventSourceControllerOptions['schedule']>
  private readonly cancel: NonNullable<PluginEventSourceControllerOptions['cancel']>
  private readonly entries = new Map<string, PluginEventSourceEntry>()
  private readonly usedSessionIds = new Map<string, number>()
  private readonly pluginRates = new Map<string, SlidingWindowLimiter>()
  private readonly globalRate = new SlidingWindowLimiter(PLUGIN_EVENT_SOURCE_WINDOW_MS, PLUGIN_EVENT_SOURCE_RATE_GLOBAL)
  private sequence = 0

  constructor(options: PluginEventSourceControllerOptions) {
    this.getContext = options.getContext
    this.onChanged = options.onChanged
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? Date.now
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
    this.cancel = options.cancel ?? (timer => clearTimeout(timer))
  }

  emit(pluginId: string, rawEvent: unknown): PluginEventSourceEmitResult {
    if (!isPluginId(pluginId) || !isRecord(rawEvent)
      || Object.keys(rawEvent).length !== 2 || !Object.hasOwn(rawEvent, 'sessionId') || !Object.hasOwn(rawEvent, 'state')) {
      return { ok: false, error: 'invalid_request' }
    }
    let eventBytes: number
    try { eventBytes = Buffer.byteLength(JSON.stringify(rawEvent), 'utf8') } catch { return { ok: false, error: 'invalid_request' } }
    if (eventBytes > PLUGIN_EVENT_SOURCE_MAX_EVENT_BYTES
      || typeof rawEvent.sessionId !== 'string' || !SESSION_ID.test(rawEvent.sessionId)
      || Buffer.byteLength(rawEvent.sessionId, 'utf8') > PLUGIN_EVENT_SOURCE_MAX_SESSION_ID_BYTES
      || typeof rawEvent.state !== 'string' || !EVENT_STATES.has(rawEvent.state as PluginEventSourceState)) {
      return { ok: false, error: 'invalid_request' }
    }

    const context = this.readContext(pluginId)
    if (!context) return { ok: false, error: 'disabled' }
    const family = normalizePluginEventSourceFamily(context.family)
    if (!family
      || !normalizeSafeLocalizedText(context.pluginName)
      || !normalizeSafeLocalizedText(context.displayName)) return { ok: false, error: 'not_permitted' }

    const now = this.safeNow()
    if (now === null) return { ok: false, error: 'disabled' }
    this.prune(now)
    this.expireEntries(now)

    const sessionId = rawEvent.sessionId
    const state = rawEvent.state as PluginEventSourceState
    const key = createSessionKey(pluginId, family, sessionId)
    const current = this.entries.get(key)
    if (current && now - current.createdAt >= PLUGIN_EVENT_SOURCE_MAX_SESSION_LIFETIME_MS) this.removeEntry(key)
    const existing = this.entries.get(key)
    if (existing && TERMINAL_STATES.has(existing.state)) return { ok: false, error: 'invalid_request' }
    if (!existing && (this.usedSessionIds.get(key) ?? -1) > now) return { ok: false, error: 'invalid_request' }

    if (!existing) {
      const pluginSessions = [...this.entries.values()].filter(entry => entry.pluginId === pluginId).length
      if (pluginSessions >= PLUGIN_EVENT_SOURCE_MAX_SESSIONS_PER_PLUGIN
        || this.entries.size >= PLUGIN_EVENT_SOURCE_MAX_SESSIONS_GLOBAL) return { ok: false, error: 'rate_limited' }
    }

    const rate = this.consumeRate(pluginId, now)
    if (!rate) return { ok: false, error: 'rate_limited' }

    if (!existing) {
      const entry: PluginEventSourceEntry = {
        key: ++this.sequence,
        pluginId,
        sessionId,
        pluginName: normalizeSafeLocalizedText(context.pluginName)!,
        displayName: normalizeSafeLocalizedText(context.displayName)!,
        family,
        state,
        createdAt: now,
        updatedAt: now,
        updatedAtWall: this.safeWallNow(),
        timer: null,
      }
      this.entries.set(key, entry)
      this.usedSessionIds.set(key, now + PLUGIN_EVENT_SOURCE_MAX_SESSION_LIFETIME_MS)
      this.scheduleEntryExpiry(key, entry)
    } else {
      existing.state = state
      existing.updatedAt = now
      existing.updatedAtWall = this.safeWallNow()
      this.scheduleEntryExpiry(key, existing)
    }
    this.broadcast()
    return { accepted: true }
  }

  list(): PluginEventSourceStatusView[] {
    const now = this.safeNow()
    if (now !== null) {
      this.prune(now)
      this.expireEntries(now)
    }
    return this.snapshot()
  }

  clearPlugin(pluginId: string): void {
    let changed = false
    for (const [key, entry] of this.entries) {
      if (entry.pluginId !== pluginId) continue
      this.removeEntry(key)
      changed = true
    }
    this.pluginRates.delete(pluginId)
    this.globalRate.removeScope(pluginId)
    for (const key of this.usedSessionIds.keys()) if (key.startsWith(`${pluginId}\u0000`)) this.usedSessionIds.delete(key)
    if (changed) this.broadcast()
  }

  clearAll(): void {
    for (const entry of this.entries.values()) if (entry.timer) this.cancel(entry.timer)
    this.entries.clear()
    this.usedSessionIds.clear()
    this.pluginRates.clear()
    this.globalRate.clear()
    this.broadcast()
  }

  destroy(): void {
    this.clearAll()
  }

  private readContext(pluginId: string): PluginEventSourceContext | null {
    try {
      const context = this.getContext(pluginId)
      return context?.enabled && context.pluginsEnabled ? context : null
    } catch {
      return null
    }
  }

  private consumeRate(pluginId: string, now: number): boolean {
    const pluginTimes = this.pluginRates.get(pluginId)
    if ((pluginTimes?.size ?? 0) >= PLUGIN_EVENT_SOURCE_RATE_PER_PLUGIN
      || this.globalRate.size >= PLUGIN_EVENT_SOURCE_RATE_GLOBAL) return false
    let limiter = pluginTimes
    if (!limiter) {
      limiter = new SlidingWindowLimiter(PLUGIN_EVENT_SOURCE_WINDOW_MS, PLUGIN_EVENT_SOURCE_RATE_PER_PLUGIN)
      this.pluginRates.set(pluginId, limiter)
    }
    limiter.record(now)
    this.globalRate.record(now, pluginId)
    return true
  }

  private prune(now: number): void {
    this.globalRate.prune(now)
    for (const [pluginId, limiter] of this.pluginRates) {
      limiter.prune(now)
      if (limiter.size > 0) this.pluginRates.set(pluginId, limiter)
      else this.pluginRates.delete(pluginId)
    }
    for (const [key, expiry] of this.usedSessionIds) if (expiry <= now) this.usedSessionIds.delete(key)
  }

  private expireEntries(now: number): void {
    let changed = false
    for (const [key, entry] of this.entries) {
      if (now < this.entryExpiresAt(entry)) continue
      this.removeEntry(key)
      changed = true
    }
    if (changed) this.broadcast()
  }

  private entryExpiresAt(entry: PluginEventSourceEntry): number {
    const maxLifetime = entry.createdAt + PLUGIN_EVENT_SOURCE_MAX_SESSION_LIFETIME_MS
    const stateTtl = TERMINAL_STATES.has(entry.state) ? PLUGIN_EVENT_SOURCE_TERMINAL_TTL_MS : PLUGIN_EVENT_SOURCE_ACTIVE_TTL_MS
    return Math.min(maxLifetime, entry.updatedAt + stateTtl)
  }

  private scheduleEntryExpiry(key: string, entry: PluginEventSourceEntry): void {
    if (entry.timer) this.cancel(entry.timer)
    const delay = Math.max(0, this.entryExpiresAt(entry) - this.safeNow()!)
    entry.timer = this.schedule(() => {
      const current = this.entries.get(key)
      if (current !== entry) return
      const now = this.safeNow()
      if (now === null || now >= this.entryExpiresAt(entry)) {
        this.removeEntry(key)
        this.broadcast()
        return
      }
      this.scheduleEntryExpiry(key, entry)
    }, delay)
  }

  private removeEntry(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.timer) this.cancel(entry.timer)
    entry.timer = null
    this.entries.delete(key)
  }

  private snapshot(): PluginEventSourceStatusView[] {
    return [...this.entries.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.key - right.key)
      .map(({ key, pluginName, displayName, state, updatedAtWall }) => ({
        key,
        pluginName: { ...pluginName },
        displayName: { ...displayName },
        state,
        updatedAt: updatedAtWall,
      }))
  }

  private broadcast(): void {
    try { this.onChanged(this.snapshot()) } catch {}
  }

  private safeNow(): number | null {
    try {
      const value = this.now()
      return Number.isFinite(value) && value >= 0 ? value : null
    } catch {
      return null
    }
  }

  private safeWallNow(): number {
    try {
      const value = this.wallNow()
      return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
    } catch {
      return Date.now()
    }
  }
}
