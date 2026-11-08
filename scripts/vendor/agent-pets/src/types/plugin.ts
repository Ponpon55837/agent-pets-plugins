export type PluginLocalizedText = {
  'zh-TW': string
  'en-US': string
}

export type PluginSettingScalar = string | number | boolean

export type PluginPanelViewCloseReason =
  | 'closed'
  | 'replaced'
  | 'load_failed'
  | 'renderer_crashed'
  | 'destroyed'
  | 'disabled'
  | 'renderer_unavailable'
  | 'hidden'

export interface PluginPanelViewClosedEvent {
  pluginId: string
  openToken: number
  reason: PluginPanelViewCloseReason
}

export interface PluginSettingDefinition {
  type: 'string' | 'number' | 'boolean'
  title?: PluginLocalizedText | string
  enum?: PluginSettingScalar[]
  maxLength?: number
  minimum?: number
  maximum?: number
  format?: 'secret'
  default?: PluginSettingScalar
}

export interface PluginSettingsSchema {
  type: 'object'
  properties: Record<string, PluginSettingDefinition>
}

export interface PluginCommandContribution {
  id: string
  title: PluginLocalizedText
}

export type PluginBadgeTone = 'neutral' | 'info' | 'warning'

export interface PluginBadgeInput {
  text: string
  tone?: PluginBadgeTone
}

export interface PluginBadgeView {
  pluginId: string
  pluginName: PluginLocalizedText
  targetPetId: string | null
  text: string
  tone: PluginBadgeTone
  updatedAt: number
}

export interface PluginSkinContribution {
  id: string
  displayName: PluginLocalizedText
  spritesheet: string
  kind: 'person' | 'animal'
  behaviorManifest?: Record<string, { row: number; frames?: number; frameDurations?: number[] }>
}

export type PluginEventSourceState = 'thinking' | 'tool-running' | 'idle' | 'done' | 'error'

export interface PluginEventSourceContribution {
  family: string
  displayName: PluginLocalizedText
}

export interface PluginPanelViewContribution {
  entry: string
  title: PluginLocalizedText
  preferredSize?: { width: number; height: number }
}

export type PluginPanelThemeFit = 'cover' | 'contain' | 'tile'
export type PluginPanelThemePosition =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export type PluginPanelThemeColorKey =
  | 'bg' | 'surface' | 'surface2' | 'surfaceWarm' | 'surfaceSage' | 'surfaceSageSoft' | 'surfaceOff'
  | 'text' | 'textSecondary' | 'textMuted' | 'textFaint'
  | 'accent' | 'accentHover' | 'accentText' | 'onAccent' | 'accentGlow' | 'accentTrack' | 'accentOnHover'
  | 'sage' | 'sageDeep' | 'sageDark' | 'sageTrack'
  | 'border' | 'borderSoft'
  | 'dangerText' | 'successText' | 'warnText' | 'scrim'
  | 'infoText' | 'shadow' | 'highlight'

/** 正規化後的 manifest 顏色：主機標準的 `rgb(R G B / A)` 字串（spec §3.3）。 */
export type PluginPanelThemeColors = Partial<Record<PluginPanelThemeColorKey, string>>

export interface PluginPanelThemeOverlay { color: string; opacity: number }

export type PluginPanelThemeBackground =
  | { type: 'solid' }
  | { type: 'gradient'; kind: 'linear'; angle: number; stops: Array<{ color: string; at: number }> }
  | { type: 'gradient'; kind: 'radial'; position: PluginPanelThemePosition; stops: Array<{ color: string; at: number }> }
  | {
      type: 'image'
      src: string
      fit: PluginPanelThemeFit
      position: PluginPanelThemePosition
      opacity: number
      blur: number
      overlay: PluginPanelThemeOverlay
    }

export interface PluginPanelThemeModeDefinition {
  colors: PluginPanelThemeColors
  background: PluginPanelThemeBackground
  userImage?: { allowed: true; fit: PluginPanelThemeFit; overlay: PluginPanelThemeOverlay }
  petStatus?: Partial<Record<'background' | 'border' | 'text' | 'textMuted' | 'quotaFill' | 'quotaTrack' | 'quotaWarn', string>>
}

export interface PluginPanelThemeFontFace {
  id: string
  src: string
  weight: 400 | 600 | 700
  style: 'normal' | 'italic'
}

/** 已驗證並套用預設值的 `contributes.panelThemes[]` 項目（electron/plugin-panel-themes.ts）。 */
export interface PluginPanelThemeContribution {
  id: string
  displayName: PluginLocalizedText
  description?: PluginLocalizedText
  fonts: PluginPanelThemeFontFace[]
  typography: { body?: string[]; heading?: string[]; scale: number }
  shape: { radiusSm: number; radiusMd: number; radiusLg: number }
  modes: Partial<Record<'light' | 'dark', PluginPanelThemeModeDefinition>>
}

/** One registry row owns the contribution identifier, implementation entry point, and public API mapping. */
export const PLUGIN_CONTRIBUTION_REGISTRY = Object.freeze({
  feed: { implementationFile: 'electron/plugin-feed.ts', hostApi: 'feed.notify' },
  reaction: { implementationFile: 'electron/plugin-broker.ts', hostApi: 'pet.react' },
  settings: { implementationFile: 'electron/plugin-settings.ts', hostApi: 'settings.get' },
  panelView: { implementationFile: 'electron/plugin-panel-view.ts', hostApi: 'ui.postMessage' },
  commands: { implementationFile: 'electron/plugin-commands.ts', hostApi: 'commands.onInvoke' },
  tray: { implementationFile: 'electron/plugin-tray.ts', hostApi: null },
  badge: { implementationFile: 'electron/plugin-badges.ts', hostApi: 'badge.set' },
  skins: { implementationFile: 'electron/plugin-skins.ts', hostApi: null, allowsWorkerlessPlugin: true },
  eventSource: { implementationFile: 'electron/plugin-event-source.ts', hostApi: 'agent.emit' },
  panelThemes: { implementationFile: 'electron/plugin-panel-themes.ts', hostApi: null, allowsWorkerlessPlugin: true },
} as const)

export type PluginContributionId = keyof typeof PLUGIN_CONTRIBUTION_REGISTRY

export interface PluginContributionValueMap {
  feed: boolean
  reaction: boolean
  settings: PluginSettingsSchema
  panelView: PluginPanelViewContribution
  commands: PluginCommandContribution[]
  tray: { commands: string[] }
  badge: boolean
  skins: PluginSkinContribution[]
  eventSource: PluginEventSourceContribution
  panelThemes: PluginPanelThemeContribution[]
}

type AssertPluginContributionKeysMatch<T extends true> = T
type PluginContributionRegistryCoverage = AssertPluginContributionKeysMatch<
  [Exclude<PluginContributionId, keyof PluginContributionValueMap>, Exclude<keyof PluginContributionValueMap, PluginContributionId>] extends [never, never]
    ? true
    : false
>

export type PluginContributions = Partial<Pick<PluginContributionValueMap, PluginContributionId>>

export interface PluginEventSourceStatusView {
  key: number
  pluginName: PluginLocalizedText
  displayName: PluginLocalizedText
  state: PluginEventSourceState
  updatedAt: number
}

export interface PluginManifest {
  id: string
  name: PluginLocalizedText
  version: string
  apiVersion: '1'
  author: string
  entry?: string
  icon?: string
  permissions: {
    network?: {
      hosts: string[]
      userGranted?: boolean
    }
    links?: {
      hosts: string[]
    }
    secrets?: string[]
    schedule?: {
      minIntervalSec: number
    }
    storage?: boolean
    agentStatus?: boolean
  }
  contributes: PluginContributions
}

export interface FeedItemInput {
  title: string
  body: string
  link?: string
  icon?: string
  priority?: 'low' | 'normal'
  ttlMs?: number
  dedupeKey?: string
}

export interface PluginFeedItem {
  id: string
  pluginId: string
  targetPetId?: string
  pluginName: PluginLocalizedText
  iconUrl?: string
  title: string
  body: string
  link?: string
  priority: 'low' | 'normal'
  createdAt: number
  expiresAt: number
  /** Renderer hint only; Main still validates the current manifest before opening a panel page. */
  panelViewAvailable?: boolean
}

export interface PetStatusChange {
  petId: string
  name: string
  agentFamily: 'codex' | 'claude-code' | 'opencode' | null
  previousState: string
  visibleState: string
  dnd: boolean
  at: number
}

export interface PluginResourceLimits {
  maxEnabledPlugins: number
  memoryMbPerPlugin: number
  netMaxResponseBytes: number
  netTimeoutSeconds: number
  netRequestsPerMinute: number
  storageBytesPerPlugin: number
  globalFeedPer10Min: number
  scheduleMinIntervalSeconds: number
}

export interface PluginInstancePreferences {
  enabled: boolean
  muted: boolean
  rateLimitPer10Min: number
  targetPetId: string | null
  grantedHosts: string[]
}

export interface PluginPreferences {
  pluginsEnabled: boolean
  developerMode: boolean
  onlineCatalogEnabled: boolean
  dailyUpdateCheck: boolean
  catalogUrl: string
  resources: PluginResourceLimits
  plugins: Record<string, PluginInstancePreferences>
}

export interface PluginGlobalPreferencesPatch {
  pluginsEnabled?: boolean
  developerMode?: boolean
  onlineCatalogEnabled?: boolean
  dailyUpdateCheck?: boolean
  catalogUrl?: string
  resources?: Partial<PluginResourceLimits>
}

export const PLUGIN_ERROR_CODES = Object.freeze([
  'not_permitted', 'rate_limited', 'invalid_request', 'too_large', 'timeout', 'host_not_allowed', 'disabled',
  'queue_full', 'duplicate', 'not_found', 'too_many_enabled', 'host_unavailable', 'too_many_redirects',
  'secret_unavailable', 'secret_not_found', 'settings_invalid', 'schedule_invalid', 'agent_status_unavailable', 'denied',
] as const)

export type PluginErrorCode = typeof PLUGIN_ERROR_CODES[number]

const pluginErrorCodeSet: ReadonlySet<string> = new Set(PLUGIN_ERROR_CODES)
export function isPluginErrorCode(value: unknown): value is PluginErrorCode {
  return typeof value === 'string' && pluginErrorCodeSet.has(value)
}

export type PluginRuntimeState = 'installed' | 'enabled' | 'disabled_crashed' | 'incompatible'

export type PluginInstallKind = 'new' | 'update' | 'downgrade' | 'reinstall' | 'incompatible'
export type PluginSignatureStatus = 'unsigned' | 'valid' | 'unverified'
export type PluginSignatureChange = 'first-trust' | 'unsigned-to-signed' | 'key-changed' | 'signed-to-unsigned' | 'unchanged' | 'developer-unverified'

export interface PluginInstallPlan {
  token: string
  kind: PluginInstallKind
  source?: 'local' | 'catalog'
  pluginId?: string
  name?: PluginLocalizedText
  version?: string
  author?: string
  previousVersion?: string
  permissions?: PluginManifest['permissions']
  contributes?: PluginManifest['contributes']
  addedPermissions: string[]
  requiresReconsent: boolean
  signatureStatus?: 'unsigned' | 'valid'
  signatureFingerprint?: string
  previousTrustedFingerprint?: string
  signatureChange?: PluginSignatureChange
  requiresSignatureConfirmation?: boolean
  developerMode?: boolean
}

export interface PluginPanelPlugin {
  id: string
  currentVersion: string
  status: PluginRuntimeState
  installedAt: number
  grantedPermissions: unknown
  manifest: PluginManifest | null
  development: boolean
  signatureStatus?: PluginSignatureStatus
  signatureFingerprint?: string
  preference: PluginInstancePreferences
}

export interface PluginBrokerLogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface PluginBrokerDiagnostic {
  at: number
  code: PluginErrorCode
  method?: string
}

export interface PluginPanelSnapshot {
  preferences: PluginPreferences
  plugins: PluginPanelPlugin[]
}

export interface PluginPanelSettingsSnapshot {
  values: Record<string, PluginSettingScalar>
  secrets: Record<string, boolean>
}

export interface PluginNotificationRecord {
  item: PluginFeedItem
  read: boolean
}

export type PluginPanelResult<T> =
  | { ok: true; value: T }
  /** `diagnostic`：開發者模式安裝提示，經清理且最多 200 字元。 */
  | { ok: false; error: import('./ipc').IpcErrorCode; cancelled?: boolean; diagnostic?: string }
