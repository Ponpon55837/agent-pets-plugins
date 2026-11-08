import { isIP } from 'node:net'
import { parsePetBehaviorManifest } from './pet-behavior-manifest.ts'
import { normalizePluginEventSourceFamily } from './plugin-event-source.ts'
import { PanelThemeValidationError, parsePanelThemes } from './plugin-panel-themes.ts'
import { PLUGIN_CONTRIBUTION_REGISTRY } from '../src/types/plugin.ts'
import { isPluginId, isPluginCommandId, isSemverCore } from '../src/types/id-patterns.ts'
import type {
  PluginLocalizedText,
  PluginManifest,
  PluginSettingDefinition,
  PluginSettingScalar,
  PluginSettingsSchema,
} from '../src/types/plugin.ts'
import { isRecord } from './value-guards.ts'

const SECRET_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/
const PROPERTY_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_RELATIVE_PATH_LENGTH = 512
const MAX_SETTING_ENUM_ITEMS = 50
const MAX_SETTING_ENUM_TEXT_LENGTH = 256
const MAX_SETTING_STRING_LENGTH = 4_096

export type PluginManifestError =
  | 'invalid_manifest'
  | 'invalid_id'
  | 'invalid_name'
  | 'invalid_version'
  | 'unsupported_api_version'
  | 'invalid_author'
  | 'invalid_path'
  | 'invalid_permissions'
  | 'invalid_host'
  | 'invalid_settings'
  | 'invalid_contributions'
  | 'invalid_panel_theme'

export type PluginManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  /** `diagnostic` 是經過清理、最多 200 字元的作者提示（僅限面板主題）。 */
  | { ok: false; error: string; diagnostic?: string }

class ManifestValidationError extends Error {
  readonly code: PluginManifestError
  readonly diagnostic?: string

  constructor(code: PluginManifestError, diagnostic?: string) {
    super(code)
    this.code = code
    if (diagnostic) this.diagnostic = diagnostic
  }
}

function reject(code: PluginManifestError, diagnostic?: string): never {
  throw new ManifestValidationError(code, diagnostic)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed)
  return Object.keys(value).every(key => accepted.has(key))
}

function normalizePlainText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 0 && text.length <= maxLength ? text : null
}

function parseLocalizedText(value: unknown, maxLength: number): PluginLocalizedText | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['zh-TW', 'en-US'])) return null
  const zhTW = normalizePlainText(value['zh-TW'], maxLength)
  const enUS = normalizePlainText(value['en-US'], maxLength)
  if (!zhTW || !enUS) return null
  return { 'zh-TW': zhTW, 'en-US': enUS }
}

function parseEventSourceDisplayName(value: unknown): PluginLocalizedText | null {
  const localized = parseLocalizedText(value, 160)
  if (!localized || Object.values(localized).some(text => Array.from(text).length > 80)) return null
  return localized
}

function parseSchemaTitle(value: unknown): string | PluginLocalizedText | null {
  if (typeof value === 'string') return normalizePlainText(value, 48)
  return parseLocalizedText(value, 48)
}

function normalizeRelativePath(value: unknown, extension: readonly string[]): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RELATIVE_PATH_LENGTH) return null
  const normalized = value.normalize('NFC')
  if (normalized.startsWith('/')
    || normalized.startsWith('\\')
    || normalized.includes('\\')
    || normalized.includes('..')
    || normalized.includes(':')
    || /[\u0000-\u001f\u007f<>"|?*]/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || /[. ]$/.test(segment))) return null
  if (segments.some(segment => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment))) return null
  const suffix = `.${normalized.split('.').at(-1)?.toLowerCase() ?? ''}`
  if (!extension.includes(suffix)) return null
  return normalized
}

/** Validate a DNS hostname or a manifest wildcard host (for example *.example.com). */
export function isValidPluginNetworkHost(value: unknown, allowWildcard = true): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false
  const host = value.toLowerCase()
  if (host !== value.trim() || /[\s/@?#:]/.test(host)) return false

  const wildcard = host.startsWith('*.')
  if (wildcard && !allowWildcard) return false
  if (host.includes('*') && !wildcard) return false
  const domain = wildcard ? host.slice(2) : host
  const labels = domain.split('.')
  if (labels.length < 2 || labels.some(label => label.length === 0 || label.length > 63)) return false
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false
  const finalLabel = labels.at(-1)!
  if (/^\d+$/.test(finalLabel) || /^0x[0-9a-f]*$/i.test(finalLabel)) return false
  try {
    if (new URL(`https://${domain}`).hostname !== domain) return false
  } catch {
    return false
  }
  if (isIP(domain) !== 0) return false
  if (domain === 'localhost' || domain.endsWith('.localhost')
    || domain === 'local' || domain.endsWith('.local')
    || domain === 'internal' || domain.endsWith('.internal')) return false
  return true
}

function parseVersion(value: unknown): string | null {
  if (!isSemverCore(value)) return null
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? value : null
}

function parseSettingsSchema(value: unknown, secrets: ReadonlySet<string>): PluginSettingsSchema | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['type', 'properties']) || value.type !== 'object'
    || !isRecord(value.properties)) return null
  const entries = Object.entries(value.properties)
  if (entries.length > 20) return null

  const properties: Record<string, PluginSettingDefinition> = Object.create(null) as Record<string, PluginSettingDefinition>
  for (const [key, raw] of entries) {
    if (!PROPERTY_KEY_PATTERN.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype'
      || !isRecord(raw)
      || !hasOnlyKeys(raw, ['type', 'title', 'enum', 'maxLength', 'minimum', 'maximum', 'format', 'default'])) return null
    if (raw.type !== 'string' && raw.type !== 'number' && raw.type !== 'boolean') return null

    const property: PluginSettingDefinition = { type: raw.type }
    if (raw.title !== undefined) {
      const title = parseSchemaTitle(raw.title)
      if (!title) return null
      property.title = title
    }

    if (raw.maxLength !== undefined) {
      if (raw.type !== 'string' || typeof raw.maxLength !== 'number' || !Number.isSafeInteger(raw.maxLength)
        || raw.maxLength < 0 || raw.maxLength > MAX_SETTING_STRING_LENGTH) return null
      property.maxLength = raw.maxLength
    }

    if (raw.minimum !== undefined || raw.maximum !== undefined) {
      if (raw.type !== 'number') return null
      if (raw.minimum !== undefined) {
        if (typeof raw.minimum !== 'number' || !Number.isFinite(raw.minimum)) return null
        property.minimum = raw.minimum
      }
      if (raw.maximum !== undefined) {
        if (typeof raw.maximum !== 'number' || !Number.isFinite(raw.maximum)) return null
        property.maximum = raw.maximum
      }
      if (property.minimum !== undefined && property.maximum !== undefined
        && property.minimum > property.maximum) return null
    }

    if (raw.format !== undefined) {
      if (raw.type !== 'string' || raw.format !== 'secret' || !secrets.has(key)) return null
      property.format = 'secret'
    }

    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > MAX_SETTING_ENUM_ITEMS) return null
      const enumValues: PluginSettingScalar[] = []
      for (const item of raw.enum) {
        if (typeof item !== raw.type) return null
        if (typeof item === 'number' && !Number.isFinite(item)) return null
        if (typeof item === 'string' && (item.length > MAX_SETTING_ENUM_TEXT_LENGTH || CONTROL_CHARACTERS.test(item))) return null
        if (enumValues.some(existing => Object.is(existing, item))) return null
        enumValues.push(item)
      }
      property.enum = enumValues
    }

    if (Object.hasOwn(raw, 'default')) {
      const defaultValue = raw.default
      if (property.format === 'secret' || typeof defaultValue !== raw.type
        || (typeof defaultValue === 'number' && !Number.isFinite(defaultValue))
        || (typeof defaultValue === 'string'
          && (defaultValue.length > (property.maxLength ?? MAX_SETTING_ENUM_TEXT_LENGTH) || CONTROL_CHARACTERS.test(defaultValue)))
        || (typeof defaultValue === 'number'
          && ((property.minimum !== undefined && defaultValue < property.minimum)
            || (property.maximum !== undefined && defaultValue > property.maximum)))
        || (property.enum && !property.enum.some(item => Object.is(item, defaultValue)))) return null
      property.default = defaultValue as PluginSettingScalar
    }

    properties[key] = property
  }
  return { type: 'object', properties }
}

function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'name', 'version', 'apiVersion', 'author', 'entry', 'icon', 'permissions', 'contributes',
  ])) reject('invalid_manifest')

  if (!isPluginId(value.id)) {
    reject('invalid_id')
  }
  const name = parseLocalizedText(value.name, 48)
  if (!name) reject('invalid_name')
  const version = parseVersion(value.version)
  if (!version) reject('invalid_version')
  if (value.apiVersion !== '1') reject('unsupported_api_version')
  const author = normalizePlainText(value.author, 64)
  if (!author) reject('invalid_author')
  const entry = value.entry === undefined ? undefined : normalizeRelativePath(value.entry, ['.js'])
  if (value.entry !== undefined && !entry) reject('invalid_path')
  const icon = value.icon === undefined ? undefined : normalizeRelativePath(value.icon, ['.png', '.webp'])
  if (value.icon !== undefined && !icon) reject('invalid_path')

  if (!isRecord(value.permissions) || !hasOnlyKeys(value.permissions, [
    'network', 'links', 'secrets', 'schedule', 'storage', 'agentStatus',
  ])) reject('invalid_permissions')
  const permissions: PluginManifest['permissions'] = {}
  if (value.permissions.network !== undefined) {
    const network = value.permissions.network
    if (!isRecord(network) || !hasOnlyKeys(network, ['hosts', 'userGranted'])
      || !Array.isArray(network.hosts) || network.hosts.length === 0 || network.hosts.length > 20
      || network.hosts.some(host => !isValidPluginNetworkHost(host))
      || new Set(network.hosts).size !== network.hosts.length
      || (network.userGranted !== undefined && typeof network.userGranted !== 'boolean')) reject('invalid_host')
    permissions.network = {
      hosts: [...network.hosts] as string[],
      ...(network.userGranted === undefined ? {} : { userGranted: network.userGranted }),
    }
  }

  if (value.permissions.links !== undefined) {
    const links = value.permissions.links
    if (!isRecord(links) || !hasOnlyKeys(links, ['hosts'])
      || !Array.isArray(links.hosts) || links.hosts.length === 0 || links.hosts.length > 20
      || links.hosts.some(host => !isValidPluginNetworkHost(host, false))
      || new Set(links.hosts).size !== links.hosts.length) reject('invalid_host')
    permissions.links = { hosts: [...links.hosts] as string[] }
  }

  const secrets = value.permissions.secrets
  if (secrets !== undefined) {
    if (!Array.isArray(secrets) || secrets.length > 10
      || secrets.some(secret => typeof secret !== 'string' || !SECRET_KEY_PATTERN.test(secret))
      || new Set(secrets).size !== secrets.length) reject('invalid_permissions')
    permissions.secrets = [...secrets] as string[]
  }

  if (value.permissions.schedule !== undefined) {
    const schedule = value.permissions.schedule
    if (!isRecord(schedule) || !hasOnlyKeys(schedule, ['minIntervalSec'])
      || typeof schedule.minIntervalSec !== 'number' || !Number.isSafeInteger(schedule.minIntervalSec)
      || schedule.minIntervalSec < 30 || schedule.minIntervalSec > 3_600) reject('invalid_permissions')
    permissions.schedule = { minIntervalSec: schedule.minIntervalSec as number }
  }
  for (const key of ['storage', 'agentStatus'] as const) {
    const permission = value.permissions[key]
    if (permission !== undefined) {
      if (typeof permission !== 'boolean') reject('invalid_permissions')
      permissions[key] = permission
    }
  }
  const secretSet = new Set(permissions.secrets ?? [])

  if (!isRecord(value.contributes) || !hasOnlyKeys(value.contributes, Object.keys(PLUGIN_CONTRIBUTION_REGISTRY))) {
    reject('invalid_contributions')
  }
  const contributes: PluginManifest['contributes'] = {}
  for (const key of ['feed', 'reaction'] as const) {
    const contribution = value.contributes[key]
    if (contribution !== undefined) {
      if (typeof contribution !== 'boolean') reject('invalid_contributions')
      contributes[key] = contribution
    }
  }

  if (value.contributes.settings !== undefined) {
    const settings = parseSettingsSchema(value.contributes.settings, secretSet)
    if (!settings) reject('invalid_settings')
    contributes.settings = settings
  }

  if (value.contributes.panelView !== undefined) {
    const panelView = value.contributes.panelView
    if (!isRecord(panelView) || !hasOnlyKeys(panelView, ['entry', 'title', 'preferredSize'])) {
      reject('invalid_contributions')
    }
    const panelEntry = normalizeRelativePath(panelView.entry, ['.html'])
    const title = parseLocalizedText(panelView.title, 48)
    if (!panelEntry || !title) reject('invalid_path')
    let preferredSize: { width: number; height: number } | undefined
    if (panelView.preferredSize !== undefined) {
      const size = panelView.preferredSize
      if (!isRecord(size) || !hasOnlyKeys(size, ['width', 'height'])
        || typeof size.width !== 'number' || !Number.isSafeInteger(size.width)
        || typeof size.height !== 'number' || !Number.isSafeInteger(size.height)) reject('invalid_contributions')
      preferredSize = {
        width: Math.max(320, Math.min(960, size.width as number)),
        height: Math.max(240, Math.min(800, size.height as number)),
      }
    }
    contributes.panelView = {
      entry: panelEntry,
      title,
      ...(preferredSize ? { preferredSize } : {}),
    }
  }

  if (value.contributes.commands !== undefined) {
    const commands = value.contributes.commands
    if (!Array.isArray(commands) || commands.length > 10) reject('invalid_contributions')
    const parsedCommands = []
    const ids = new Set<string>()
    for (const command of commands) {
      if (!isRecord(command) || !hasOnlyKeys(command, ['id', 'title'])
        || !isPluginCommandId(command.id) || ids.has(command.id)) {
        reject('invalid_contributions')
      }
      const title = parseLocalizedText(command.title, 32)
      if (!title) reject('invalid_contributions')
      ids.add(command.id)
      parsedCommands.push({ id: command.id, title })
    }
    contributes.commands = parsedCommands
  }
  if (value.contributes.tray !== undefined) {
    const tray = value.contributes.tray
    const commandIds = new Set((contributes.commands ?? []).map(command => command.id))
    if (!isRecord(tray) || !hasOnlyKeys(tray, ['commands']) || !Array.isArray(tray.commands)
      || tray.commands.length > 5 || tray.commands.some(id => typeof id !== 'string' || !commandIds.has(id))
      || new Set(tray.commands).size !== tray.commands.length) reject('invalid_contributions')
    contributes.tray = { commands: [...tray.commands] as string[] }
  }
  if (value.contributes.badge !== undefined) {
    if (typeof value.contributes.badge !== 'boolean') reject('invalid_contributions')
    contributes.badge = value.contributes.badge
  }
  if (value.contributes.skins !== undefined) {
    const skins = value.contributes.skins
    if (!Array.isArray(skins) || skins.length === 0 || skins.length > 5) reject('invalid_contributions')
    const parsedSkins = []
    const ids = new Set<string>()
    for (const skin of skins) {
      if (!isRecord(skin) || !hasOnlyKeys(skin, ['id', 'displayName', 'spritesheet', 'kind', 'behaviorManifest'])
        || typeof skin.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(skin.id) || ids.has(skin.id)
        || (skin.kind !== 'person' && skin.kind !== 'animal')) reject('invalid_contributions')
      const displayName = parseLocalizedText(skin.displayName, 48)
      const spritesheet = normalizeRelativePath(skin.spritesheet, ['.webp', '.png'])
      if (!displayName || !spritesheet) reject('invalid_contributions')
      let behaviorManifest
      if (skin.behaviorManifest !== undefined) {
        behaviorManifest = parsePetBehaviorManifest(skin.behaviorManifest)
        if (!behaviorManifest) reject('invalid_contributions')
      }
      ids.add(skin.id)
      parsedSkins.push({
        id: skin.id,
        displayName,
        spritesheet,
        kind: skin.kind as 'person' | 'animal',
        ...(behaviorManifest ? { behaviorManifest } : {}),
      })
    }
    contributes.skins = parsedSkins
  }
  if (value.contributes.eventSource !== undefined) {
    const eventSource = value.contributes.eventSource
    if (!isRecord(eventSource) || !hasOnlyKeys(eventSource, ['family', 'displayName'])) reject('invalid_contributions')
    const family = normalizePluginEventSourceFamily(eventSource.family)
    const displayName = parseEventSourceDisplayName(eventSource.displayName)
    if (!family || !displayName) reject('invalid_contributions')
    contributes.eventSource = { family, displayName }
  }
  if (value.contributes.panelThemes !== undefined) {
    try {
      contributes.panelThemes = parsePanelThemes(value.contributes.panelThemes).contributions
    } catch (error) {
      reject('invalid_panel_theme', error instanceof PanelThemeValidationError ? error.diagnostic : undefined)
    }
  }
  if (!entry) {
    // 無 Worker：沒有權限，且宣告的每項貢獻都是
    // 無 Worker 類型（skins、panelThemes）並至少含一個項目。
    const workerlessContributionIds = new Set(Object.entries(PLUGIN_CONTRIBUTION_REGISTRY)
      .filter(([, definition]) => 'allowsWorkerlessPlugin' in definition && definition.allowsWorkerlessPlugin === true)
      .map(([id]) => id))
    const declaredKeys = Object.keys(value.contributes)
    const workerlessOnly = declaredKeys.length > 0
      && declaredKeys.every(key => workerlessContributionIds.has(key)
        && Array.isArray(contributes[key as 'skins' | 'panelThemes']) && (contributes[key as 'skins' | 'panelThemes']?.length ?? 0) > 0)
    if (!workerlessOnly || Object.keys(value.permissions).length > 0) reject('invalid_contributions')
  }

  return {
    id: value.id,
    name,
    version,
    apiVersion: '1',
    author,
    ...(entry ? { entry } : {}),
    ...(icon ? { icon } : {}),
    permissions,
    contributes,
  }
}

export function parsePluginManifest(value: unknown): PluginManifestParseResult {
  try {
    return { ok: true, manifest: parseManifest(value) }
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      return { ok: false, error: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }
    }
    return { ok: false, error: 'invalid_manifest' }
  }
}
