#!/usr/bin/env node
// Validates a pull request's catalog against the rules Agent Pets applies when it
// reads index.json and installs a package. Mirrors electron/plugin-catalog.ts,
// electron/archive-guard.ts, electron/plugin-signature.ts and the package checks of
// planInstallArchive() in electron/plugin-registry.ts, but reports problems the app
// would silently drop. plugin.json and `contributes.panelThemes` are checked by the
// app's own modules, vendored byte for byte under scripts/vendor/agent-pets/ at the
// commit pinned in its vendor.json (check drift with scripts/sync-app-rules.mjs).
//
// Usage: node scripts/validate-catalog.mjs --pr <dir> [--base <dir>] [--summary <file>]
// Exits 1 when any error is found. Warnings never fail the run.
// Needs Node 22.18 or later, which loads the vendored TypeScript by type stripping.

import { createHash, createPublicKey, verify } from 'node:crypto'
import { appendFileSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, relative, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { parsePluginManifest } from './vendor/agent-pets/electron/plugin-manifest.ts'
import {
  PANEL_THEME_FONT_MAX_BYTES,
  PANEL_THEME_IMAGE_MAX_BYTES,
  checkPanelThemePackagedImage,
  isWoff2,
  panelThemeAssetPaths,
} from './vendor/agent-pets/electron/plugin-panel-themes.ts'
import { isSemverCore } from './vendor/agent-pets/src/types/id-patterns.ts'

const REPOSITORY = process.env.GITHUB_REPOSITORY || 'Ponpon55837/agent-pets-plugins'
const LOCAL_PACKAGE_PREFIX = `https://raw.githubusercontent.com/${REPOSITORY}/main/packages/`

const CATALOG_MAX_BYTES = 1024 * 1024
const CATALOG_MAX_PLUGINS = 500
const CATALOG_MAX_VERSIONS = 20
const MIB = 1024 * 1024
// An asset package (skins or panel-theme images/fonts) may use the full 25 MiB; others 5 MiB.
const PACKAGE_MAX_BYTES = 25 * MIB
const CODE_PACKAGE_MAX_BYTES = 5 * MIB
const ARCHIVE_MAX_FILES = 64
const ARCHIVE_MAX_FILE_BYTES = 20 * MIB
const ARCHIVE_MAX_TOTAL_BYTES = 25 * MIB
const SKIN_IMAGE_MAX_BYTES = 20 * MIB
const OTHER_FILE_MAX_BYTES = 5 * MIB
const MANIFEST_MAX_BYTES = 256 * 1024
const ARCHIVE_EXTENSIONS = new Set(['.js', '.json', '.png', '.webp', '.html', '.css', '.woff2'])
// Apps before 1.12.0 reject `panelThemes`, and hide catalog versions that set `minAppVersion`.
const PANEL_THEMES_MIN_APP_VERSION = '1.12.0'
const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const MAX_REDIRECTS = 3
const SIGNATURE_FILENAME = 'signature.json'
const SIGNATURE_MAX_BYTES = 4 * 1024
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const ROOT_KEYS = new Set(['schemaVersion', 'plugins'])
const PLUGIN_KEYS = new Set(['id', 'name', 'description', 'author', 'homepage', 'publicKeyFingerprint', 'versions'])
const VERSION_KEYS = new Set(['version', 'apiVersion', 'minAppVersion', 'url', 'sha256', 'size', 'publishedAt'])
const PLUGIN_ID = /^(?!_host$|_shared$)[a-z0-9-]{3,48}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const WINDOWS_FORBIDDEN = /[\u0000-\u001f\u007f<>:"|?*]/

const RISK_PATTERNS = [
  ['innerHTML / outerHTML', /\b(?:inner|outer)HTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write(?:ln)?\b/],
  ['eval', /(?<![.\w$])eval\s*\(/],
  ['new Function', /\bnew\s+Function\b/],
  ['bare fetch (not api.net.fetch)', /(?<![.\w$])fetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['window.open', /\bwindow\.open\s*\(/],
  ['localStorage / sessionStorage', /\b(?:local|session)Storage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['dynamic import()', /(?<![.\w$])import\s*\(/],
  // Bounded repeats keep this linear on long minified lines.
  ['external <script> / <iframe>', /<(?:script|iframe)\b[^>]{0,500}\bsrc\s{0,20}=\s{0,20}["']?\s{0,20}(?:https?:)?\/\//i],
  ['<iframe>', /<iframe\b/i],
  ['atob', /(?<![.\w$])atob\s*\(/],
  ['String.fromCharCode', /\bfromCharCode\b/],
  ['javascript: URL', /["'`]\s*javascript:/i],
]
const LONG_LINE = 1000
// Bounds the report so it fits a pull request comment (65,536 characters) with room to spare.
const REPORT_MAX_ITEMS = 200
const REPORT_MAX_CHARS = 60_000

// ---------------------------------------------------------------- reporting

const errors = []
const warnings = []
const sections = []

// Report text lands in a pull request comment, so every value that comes from the pull
// request, `where` included, is shown through code(): inside a code span it cannot add
// links (autolinked URLs too), images, HTML or emphasis. Mentions and `|` table cells are
// handled where the text is posted and in permissionSection().
function clip(value, maxLength) {
  // Control, line-separator, bidi and invisible format characters could hide or reorder text.
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ')
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}
function code(value, maxLength = 120) { return `\`${clip(value, maxLength).replace(/`/g, "'")}\`` }

function error(where, message) { errors.push(`**${code(where, 160)}**: ${message}`) }
function warn(where, message) { warnings.push(`**${code(where, 160)}**: ${message}`) }

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--pr', '--base', '--summary'].includes(key) || value === undefined) {
      throw new Error('Usage: validate-catalog.mjs --pr <dir> [--base <dir>] [--summary <file>]')
    }
    args[key.slice(2)] = value
  }
  if (!args.pr) throw new Error('--pr is required')
  return args
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter(key => !allowed.has(key))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function cleanText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function isLocalizedText(value, maxLength) {
  return isRecord(value) && Object.keys(value).length === 2
    && cleanText(value['zh-TW'], maxLength) && cleanText(value['en-US'], maxLength)
}

function isSafeHomepage(value) {
  if (typeof value !== 'string' || value.length > 2_048 || value.trim() !== value || /[\u0000- \u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443') && Boolean(url.hostname) && isIP(url.hostname) === 0
  } catch {
    return false
  }
}

function catalogUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !host || isIP(host) !== 0 || !ALLOWED_HOSTS.has(host)) return null
    return url
  } catch {
    return null
  }
}

/** Same rule as parseCatalogVersion() in electron/plugin-catalog.ts; the app drops a version that fails it. */
function isMinAppVersion(value) {
  return typeof value === 'string' && value.length <= 32 && isSemverCore(value)
}

function semverKey(value) {
  const match = typeof value === 'string' && value.length <= 100 ? SEMVER.exec(value) : null
  if (!match) return null
  const prerelease = match[4] === undefined ? null : match[4].split('.')
  if (prerelease?.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null
  // Build metadata does not affect precedence, so 1.0.0 and 1.0.0+x collide in the app.
  return `${BigInt(match[1])}.${BigInt(match[2])}.${BigInt(match[3])}-${prerelease?.join('.') ?? ''}`
}

function compareSemver(left, right) {
  const parse = value => {
    const match = SEMVER.exec(value)
    return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], pre: match[4]?.split('.') ?? null }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn && BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return Math.sign(a.pre.length - b.pre.length)
}

function listFiles(root) {
  const result = new Map()
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name)) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) result.set(relative(root, full).split(sep).join('/'), full)
    }
  }
  walk(root)
  return result
}

/**
 * Reads a checked-out file only when it is a regular file within maxBytes. A pull request
 * can commit symlinks, which would otherwise read runner files or never-ending devices.
 */
function readRegularFile(path, maxBytes) {
  let stat
  try { stat = lstatSync(path) } catch { return { problem: 'missing' } }
  if (!stat.isFile()) return { problem: 'not a regular file (symlinks are not allowed)' }
  if (stat.size > maxBytes) return { problem: `larger than ${maxBytes} bytes` }
  return { bytes: readFileSync(path) }
}

function readCatalog(root, where) {
  const { bytes, problem } = readRegularFile(join(root, 'index.json'), CATALOG_MAX_BYTES)
  if (problem) {
    error(where, `\`index.json\` is ${problem}.`)
    return null
  }
  if (bytes.byteLength < 1) {
    error(where, `\`index.json\` must be between 1 byte and ${CATALOG_MAX_BYTES} bytes.`)
    return null
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    error(where, '`index.json` is not valid UTF-8 JSON.')
    return null
  }
}

// ---------------------------------------------------------------- catalog rules

function validateCatalog(raw) {
  const plugins = []
  if (!isRecord(raw)) {
    error('index.json', 'The root must be an object.')
    return plugins
  }
  const extraRoot = unknownKeys(raw, ROOT_KEYS)
  if (extraRoot.length) error('index.json', `Unknown root keys: ${extraRoot.map(item => code(item)).join(', ')}.`)
  if (raw.schemaVersion !== 1) error('index.json', '`schemaVersion` must be 1.')
  if (!Array.isArray(raw.plugins)) {
    error('index.json', '`plugins` must be an array.')
    return plugins
  }
  if (raw.plugins.length > CATALOG_MAX_PLUGINS) error('index.json', `At most ${CATALOG_MAX_PLUGINS} plugins are allowed.`)

  const seenIds = new Set()
  raw.plugins.forEach((plugin, index) => {
    const where = `plugins[${index}]${isRecord(plugin) && typeof plugin.id === 'string' ? ` (${plugin.id})` : ''}`
    if (!isRecord(plugin)) return error(where, 'Must be an object.')
    const extra = unknownKeys(plugin, PLUGIN_KEYS)
    if (extra.length) error(where, `Unknown keys: ${extra.map(item => code(item)).join(', ')}.`)
    if (typeof plugin.id !== 'string' || !PLUGIN_ID.test(plugin.id)) error(where, '`id` must match `^[a-z0-9-]{3,48}$` and not be `_host` or `_shared`.')
    else if (seenIds.has(plugin.id)) error(where, `Duplicate plugin id ${code(plugin.id)}; the app drops every entry with this id.`)
    else seenIds.add(plugin.id)
    if (!isLocalizedText(plugin.name, 48)) error(where, '`name` needs exactly `zh-TW` and `en-US`, each 1–48 characters, trimmed, with no control characters.')
    if (!isLocalizedText(plugin.description, 200)) error(where, '`description` needs exactly `zh-TW` and `en-US`, each 1–200 characters, trimmed, with no control characters.')
    if (!cleanText(plugin.author, 64)) error(where, '`author` must be 1–64 characters, trimmed, with no control characters.')
    if (plugin.homepage !== undefined && !isSafeHomepage(plugin.homepage)) error(where, '`homepage` must be an https URL on a hostname (no IP, credentials or non-443 port).')
    if (plugin.publicKeyFingerprint !== undefined
      && (typeof plugin.publicKeyFingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(plugin.publicKeyFingerprint))) {
      error(where, '`publicKeyFingerprint` must be 16 lowercase hex characters.')
    }
    if (!Array.isArray(plugin.versions) || plugin.versions.length < 1 || plugin.versions.length > CATALOG_MAX_VERSIONS) {
      error(where, `\`versions\` must hold 1–${CATALOG_MAX_VERSIONS} entries.`)
      return
    }

    const precedence = new Map()
    plugin.versions.forEach((version, versionIndex) => {
      const vWhere = `${where} versions[${versionIndex}]${isRecord(version) && typeof version.version === 'string' ? ` (${version.version})` : ''}`
      if (!isRecord(version)) return error(vWhere, 'Must be an object.')
      const vExtra = unknownKeys(version, VERSION_KEYS)
      if (vExtra.length) error(vWhere, `Unknown keys: ${vExtra.map(item => code(item)).join(', ')}.`)
      const key = semverKey(version.version)
      if (!key) error(vWhere, '`version` must be valid semver.')
      else if (precedence.has(key)) error(vWhere, `Same precedence as ${code(precedence.get(key))}; the app drops both.`)
      else precedence.set(key, version.version)
      if (typeof version.apiVersion !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(version.apiVersion)) error(vWhere, '`apiVersion` must be a numeric string such as "1".')
      if (version.minAppVersion !== undefined && !isMinAppVersion(version.minAppVersion)) {
        error(vWhere, '`minAppVersion` must be an app version such as "1.12.0" (major.minor.patch only, at most 32 characters).')
      }
      if (!catalogUrl(version.url)) error(vWhere, `\`url\` must be https on ${[...ALLOWED_HOSTS].join(', ')}, without credentials or a non-443 port.`)
      if (typeof version.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(version.sha256)) error(vWhere, '`sha256` must be 64 lowercase hex characters.')
      if (!Number.isSafeInteger(version.size) || version.size < 1 || version.size > PACKAGE_MAX_BYTES) error(vWhere, `\`size\` must be an integer from 1 to ${PACKAGE_MAX_BYTES}.`)
      if (typeof version.publishedAt !== 'string' || !ISO_8601.test(version.publishedAt) || !Number.isFinite(Date.parse(version.publishedAt))) {
        error(vWhere, '`publishedAt` must be an ISO 8601 date-time such as 2026-01-01T00:00:00.000Z.')
      }
    })
    plugins.push(plugin)
  })
  return plugins
}

// ---------------------------------------------------------------- packages

async function download(url) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!catalogUrl(current)) throw new Error(`redirected to a URL outside the allowlist (${code(current)})`)
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(60_000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error(`redirect ${response.status} without a Location header`)
      current = new URL(location, current).href
      continue
    }
    const declared = Number(response.headers.get('content-length'))
    if (!response.ok || (Number.isFinite(declared) && declared > PACKAGE_MAX_BYTES)) {
      await response.body?.cancel()
      throw new Error(response.ok ? 'larger than 25 MiB' : `HTTP ${response.status}`)
    }
    const chunks = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > PACKAGE_MAX_BYTES) throw new Error('larger than 25 MiB')
      chunks.push(chunk)
    }
    return new Uint8Array(Buffer.concat(chunks))
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`)
}

/** `packages/<name>` for a catalog URL that points into this repository's main branch, '' for a bad name, else null. */
function localPackagePath(url) {
  if (typeof url !== 'string' || !url.startsWith(LOCAL_PACKAGE_PREFIX)) return null
  let name
  try { name = decodeURIComponent(url.slice(LOCAL_PACKAGE_PREFIX.length)) } catch { return '' }
  // One file name with no `/` or URL syntax, so it cannot leave packages/.
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.agentpet-plugin$/.test(name) ? `packages/${name}` : ''
}

async function loadPackage(root, version) {
  const local = localPackagePath(version.url)
  if (local === null) return download(version.url)
  if (!local) throw new Error('local package name must be a single `*.agentpet-plugin` file in packages/')
  const directory = lstatSync(join(root, 'packages'), { throwIfNoEntry: false })
  if (!directory?.isDirectory()) throw new Error('`packages/` is missing or is not a regular directory')
  const { bytes, problem } = readRegularFile(join(root, local), PACKAGE_MAX_BYTES)
  if (problem === 'missing') throw new Error(`${code(local)} is not in this pull request`)
  if (problem) throw new Error(`${code(local)} is ${problem}`)
  return new Uint8Array(bytes)
}

function safeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 512) return null
  const normalized = rawPath.normalize('NFC')
  const directory = normalized.endsWith('/')
  const path = directory ? normalized.slice(0, -1) : normalized
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\\') || WINDOWS_FORBIDDEN.test(path)) return null
  if (path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..'
    || /[. ]$/.test(segment) || WINDOWS_DEVICE_NAME.test(segment))) return null
  return { path, directory }
}

function extensionOf(path) {
  const filename = path.slice(path.lastIndexOf('/') + 1)
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot).toLowerCase() : ''
}

function directoryOf(path) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash)
}

/** Strict-mode equivalent of guardArchive() in electron/archive-guard.ts. */
function extractArchive(bytes) {
  const seen = new Set()
  const declared = new Map()
  let count = 0
  let total = 0
  let rejection = null
  let extracted
  try {
    extracted = unzipSync(bytes, {
      filter: (entry) => {
        const safe = safeArchivePath(entry.name)
        if (safe?.directory || (typeof entry.name === 'string' && entry.name.endsWith('/'))) return false
        if (!safe) { rejection = `unsafe path ${code(entry.name)}`; throw new Error() }
        const lower = safe.path.toLowerCase()
        if (seen.has(lower)) { rejection = `duplicate path ${code(safe.path)}`; throw new Error() }
        seen.add(lower)
        count += 1
        if (count > ARCHIVE_MAX_FILES) { rejection = `more than ${ARCHIVE_MAX_FILES} files`; throw new Error() }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0
          || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) { rejection = 'invalid entry size'; throw new Error() }
        if (entry.originalSize > ARCHIVE_MAX_FILE_BYTES) { rejection = `${code(safe.path)} is larger than 20 MiB`; throw new Error() }
        total += entry.originalSize
        if (total > ARCHIVE_MAX_TOTAL_BYTES) { rejection = 'uncompressed total is larger than 25 MiB'; throw new Error() }
        if (!ARCHIVE_EXTENSIONS.has(extensionOf(safe.path))) { rejection = `unsupported file type ${code(safe.path)}`; throw new Error() }
        declared.set(lower, entry.originalSize)
        return true
      },
    })
  } catch {
    throw new Error(rejection ?? 'not a readable ZIP archive')
  }
  const files = new Map()
  for (const [rawPath, content] of Object.entries(extracted)) {
    const safe = safeArchivePath(rawPath)
    if (!safe || safe.directory) throw new Error(`unsafe path ${code(rawPath)}`)
    if (declared.get(safe.path.toLowerCase()) !== content.byteLength) throw new Error(`${code(safe.path)} does not match its declared size`)
    files.set(safe.path, content)
  }
  return files
}

function decodeBase64(value, expectedBytes) {
  if (typeof value !== 'string' || value.length > 128
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.byteLength === expectedBytes && decoded.toString('base64') === value ? decoded : null
}

/** Equivalent of verifyPluginSignature() in electron/plugin-signature.ts. */
function verifySignature(files) {
  const signatureBytes = files.get(SIGNATURE_FILENAME)
  if (signatureBytes === undefined) return { status: 'unsigned' }
  if (signatureBytes.byteLength > SIGNATURE_MAX_BYTES) return { status: 'invalid' }
  let raw
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(signatureBytes)) } catch { return { status: 'invalid' } }
  if (!isRecord(raw) || Object.keys(raw).length !== 3 || unknownKeys(raw, new Set(['alg', 'publicKey', 'signature'])).length
    || raw.alg !== 'ed25519') return { status: 'invalid' }
  const publicKey = decodeBase64(raw.publicKey, 32)
  const signature = decodeBase64(raw.signature, 64)
  if (!publicKey || !signature || files.size > 64) return { status: 'invalid' }
  const lines = [...files.keys()]
    .filter(path => path !== SIGNATURE_FILENAME)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(path => `${path}\t${sha256(files.get(path))}\n`)
  const fingerprint = sha256(publicKey).slice(0, 16)
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(lines.join(''), 'utf8'), key, signature) ? { status: 'valid', fingerprint } : { status: 'invalid' }
  } catch {
    return { status: 'invalid' }
  }
}

/** plugin.json as the app reads it: at most 256 KiB of UTF-8 JSON. */
function readManifest(files) {
  const bytes = files.get('plugin.json')
  if (!bytes) throw new Error('`plugin.json` is missing from the package root')
  if (bytes.byteLength > MANIFEST_MAX_BYTES) throw new Error('`plugin.json` is larger than 256 KiB')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('`plugin.json` is not valid UTF-8 JSON')
  }
}

/** The app's normalized manifest (vendored parsePluginManifest), or an Error explaining the rejection. */
function parseManifest(raw) {
  const parsed = parsePluginManifest(raw)
  if (parsed.ok) return parsed.manifest
  return new Error(`Agent Pets rejects \`plugin.json\` with ${code(parsed.error)}${parsed.diagnostic ? `: ${code(parsed.diagnostic, 200)}` : ''}`)
}

function hasRasterSignature(bytes) {
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  const webp = bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  return png || webp
}

const IMAGE_PROBLEMS = {
  image_animated: 'is animated',
  image_too_large: 'is too large (8 MiB, 4096 px per side, 8,388,608 px)',
  image_invalid: 'is not a static PNG/WebP of at least 64 px per side with EXIF orientation 1',
}

/**
 * Port of the package checks in planInstallArchive() (electron/plugin-registry.ts) that
 * follow a successful manifest parse. The app stops at the first one; this lists them all.
 */
function packageProblems(files, manifest, archiveBytes) {
  const problems = []
  const contributes = manifest.contributes
  const skinPaths = new Set((contributes.skins ?? []).map(skin => skin.spritesheet))
  const themeAssets = panelThemeAssetPaths(contributes.panelThemes)
  const assetPackage = skinPaths.size > 0 || themeAssets.images.size > 0 || themeAssets.fonts.size > 0
  let totalBytes = 0
  for (const bytes of files.values()) totalBytes += bytes.byteLength
  if (totalBytes > (assetPackage ? PACKAGE_MAX_BYTES : CODE_PACKAGE_MAX_BYTES) || (archiveBytes > CODE_PACKAGE_MAX_BYTES && !assetPackage)) {
    problems.push(assetPackage
      ? 'The package is larger than 25 MiB uncompressed.'
      : 'Without skins or panel-theme images/fonts, the package (archive and uncompressed) must stay within 5 MiB.')
  }
  for (const [path, bytes] of files) {
    const [limit, role] = skinPaths.has(path) ? [SKIN_IMAGE_MAX_BYTES, '20 MiB (skin spritesheet)']
      : themeAssets.images.has(path) ? [PANEL_THEME_IMAGE_MAX_BYTES, '8 MiB (panel-theme image)']
        : themeAssets.fonts.has(path) ? [PANEL_THEME_FONT_MAX_BYTES, '1 MiB (panel-theme font)']
          : [OTHER_FILE_MAX_BYTES, '5 MiB']
    if (bytes.byteLength > limit) problems.push(`${code(path)} is larger than ${role}.`)
    if (extensionOf(path) === '.woff2' && !themeAssets.fonts.has(path)) {
      problems.push(`${code(path)} is a \`.woff2\` that no \`panelThemes[].fonts[].src\` references.`)
    }
  }
  for (const path of themeAssets.fonts) {
    const font = files.get(path)
    if (!font) problems.push(`Font ${code(path)} is not in the package.`)
    else if (!isWoff2(font)) problems.push(`Font ${code(path)} is not WOFF2 (it must start with \`wOF2\`).`)
  }
  for (const path of themeAssets.images) {
    const image = files.get(path)
    const check = image ? checkPanelThemePackagedImage(image) : null
    if (!check) problems.push(`Background image ${code(path)} is not in the package.`)
    else if (!check.ok) problems.push(`Background image ${code(path)} ${IMAGE_PROBLEMS[check.error] ?? IMAGE_PROBLEMS.image_invalid}.`)
  }
  if (manifest.entry && !files.has(manifest.entry)) problems.push(`\`entry\` ${code(manifest.entry)} is not in the package.`)
  for (const skin of contributes.skins ?? []) {
    const spritesheet = files.get(skin.spritesheet)
    if (!spritesheet) problems.push(`Skin spritesheet ${code(skin.spritesheet)} is not in the package.`)
    else if (!hasRasterSignature(spritesheet)) problems.push(`Skin spritesheet ${code(skin.spritesheet)} is not PNG or WebP.`)
  }
  if (manifest.icon) {
    const icon = files.get(manifest.icon)
    if (!icon) problems.push(`\`icon\` ${code(manifest.icon)} is not in the package.`)
    else if (!hasRasterSignature(icon)) problems.push(`\`icon\` ${code(manifest.icon)} is not PNG or WebP.`)
  }
  const panelEntry = contributes.panelView?.entry
  if (panelEntry && !files.has(panelEntry)) problems.push(`\`contributes.panelView.entry\` ${code(panelEntry)} is not in the package.`)
  const panelDirectory = panelEntry ? directoryOf(panelEntry) : null
  for (const path of files.keys()) {
    if (extensionOf(path) === '.html' && directoryOf(path) !== panelDirectory) {
      problems.push(`${code(path)}: HTML files may only sit next to \`contributes.panelView.entry\`.`)
    }
  }
  return problems
}

/** Port of permissionUnits() in electron/plugin-registry.ts: each unit the user consents to. */
function consentUnits(manifest) {
  const units = new Set()
  for (const [key, value] of Object.entries(manifest.permissions)) {
    if ((key === 'network' || key === 'links') && isRecord(value) && Array.isArray(value.hosts)) {
      for (const host of value.hosts) units.add(`${key}:${host}`)
      if (key === 'network' && value.userGranted) units.add('network:userGranted')
    } else if (key === 'secrets' && Array.isArray(value)) {
      for (const secret of value) units.add(`secrets:${secret}`)
    } else if (key === 'schedule' && value) {
      units.add('schedule')
    } else if (value === true) {
      units.add(key)
    }
  }
  const contributes = manifest.contributes
  for (const key of ['feed', 'reaction', 'panelView', 'badge', 'eventSource']) if (contributes[key]) units.add(`contributes:${key}`)
  if (contributes.commands?.length) units.add('contributes:commands')
  if (contributes.tray?.commands.length) units.add('contributes:tray')
  if (contributes.skins?.length) units.add(`contributes:skins:${contributes.skins.length}`)
  const panelThemes = contributes.panelThemes ?? []
  if (panelThemes.length) units.add(`contributes:panelThemes:${panelThemes.length}`)
  if (panelThemes.some(theme => theme.fonts.length > 0)) units.add('contributes:panelThemeFonts')
  return [...units].sort()
}

function scanRisks(files, where) {
  for (const [path, bytes] of files) {
    if (!['.js', '.html'].includes(extensionOf(path))) continue
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/)
    const hits = new Map()
    lines.forEach((line, index) => {
      for (const [riskLabel, pattern] of RISK_PATTERNS) {
        if (!hits.has(riskLabel) && pattern.test(line)) hits.set(riskLabel, index + 1)
      }
      if (line.length > LONG_LINE && !hits.has('long line')) hits.set('long line', index + 1)
    })
    for (const [riskLabel, line] of hits) {
      warn(where, riskLabel === 'long line'
        ? `${code(`${path}:${line}`)} has a line longer than ${LONG_LINE} characters (minified or generated code is hard to review).`
        : `${code(`${path}:${line}`)} uses ${riskLabel}.`)
    }
  }
}

// ---------------------------------------------------------------- permissions

function describeValue(key, value) {
  if (key === 'panelThemes' && Array.isArray(value)) {
    const fonts = value.reduce((count, theme) => count + theme.fonts.length, 0)
    return `${value.length} theme(s): ${value.map(theme => code(theme.id)).join(', ')}; ${fonts} font face(s)`
  }
  if (key === 'panelView' && isRecord(value)) return code(value.entry)
  if (isRecord(value) && Array.isArray(value.hosts) && Object.keys(value).length === 1) return value.hosts.map(item => code(item)).join(', ')
  if (value === true) return 'yes'
  return code(JSON.stringify(value))
}

function permissionSection(pluginId, version, manifest, previous) {
  // A `|` would end the table cell, even inside a code span.
  const row = (name, key, value) => `| \`${name}\` | ${describeValue(key, value).replace(/\|/g, '\\|')} |`
  const rows = [
    ...Object.entries(manifest.permissions).map(([key, value]) => row(`permissions.${key}`, key, value)),
    ...Object.entries(manifest.contributes).map(([key, value]) => row(`contributes.${key}`, key, value)),
  ]
  const lines = [`### ${code(pluginId)} ${code(version)}`, '', '| Item | Value |', '| --- | --- |', ...(rows.length ? rows : ['| (none) | |'])]
  if (previous) {
    const before = new Set(consentUnits(previous.manifest))
    const added = consentUnits(manifest).filter(unit => !before.has(unit))
    lines.push('', `Compared with ${code(previous.version)}:`)
    lines.push(added.length ? `- ⚠️ New consent items (the app asks again): ${added.map(item => code(item)).join(', ')}` : '- No new consent items.')
    if (added.length) warn(`${pluginId} ${version}`, `Requests more than ${code(previous.version)}; check the permission summary.`)
  } else {
    lines.push('', 'First published version: every permission above is new.')
  }
  sections.push(lines.join('\n'))
}

// ---------------------------------------------------------------- main checks

/** Unpacks and parses a package; throws an Error whose message is the reason. */
function unpack(bytes) {
  const files = extractArchive(bytes)
  const manifest = parseManifest(readManifest(files))
  if (manifest instanceof Error) throw manifest
  return { files, manifest }
}

/** Deep-checks one version. Returns its manifest, or null when the package is rejected. */
async function inspectVersion(root, plugin, version) {
  const where = `${plugin.id} ${version.version}`
  let bytes
  try {
    bytes = await loadPackage(root, version)
  } catch (cause) {
    error(where, `Could not load the package: ${cause.message}.`)
    return null
  }
  if (bytes.byteLength !== version.size) error(where, `Size is ${bytes.byteLength} bytes, but \`index.json\` says ${version.size}.`)
  const digest = sha256(bytes)
  if (digest !== version.sha256) error(where, `SHA-256 is \`${digest}\`, but \`index.json\` says ${code(version.sha256)}.`)

  let files
  let manifest
  try {
    ({ files, manifest } = unpack(bytes))
  } catch (cause) {
    error(where, `Package rejected: ${cause.message}.`)
    return null
  }
  if (manifest.id !== plugin.id) error(where, `\`plugin.json\` id is ${code(manifest.id)}, but the catalog says ${code(plugin.id)}.`)
  if (manifest.version !== version.version) error(where, `\`plugin.json\` version is ${code(manifest.version)}, but the catalog says ${code(version.version)}.`)
  if (manifest.apiVersion !== version.apiVersion) error(where, `\`plugin.json\` apiVersion is ${code(manifest.apiVersion)}, but the catalog says ${code(version.apiVersion)}.`)
  for (const problem of packageProblems(files, manifest, bytes.byteLength)) error(where, problem)

  if (manifest.contributes.panelThemes?.length) {
    if (version.minAppVersion === undefined) {
      error(where, `Contributes \`panelThemes\`, so the catalog entry needs \`"minAppVersion": "${PANEL_THEMES_MIN_APP_VERSION}"\` or later.`)
    } else if (isMinAppVersion(version.minAppVersion) && compareSemver(version.minAppVersion, PANEL_THEMES_MIN_APP_VERSION) < 0) {
      error(where, `Contributes \`panelThemes\`, which needs Agent Pets ${PANEL_THEMES_MIN_APP_VERSION}, but \`minAppVersion\` is ${code(version.minAppVersion)}.`)
    }
  }

  const signature = verifySignature(files)
  if (signature.status === 'invalid') error(where, '`signature.json` is present but the signature is invalid.')
  if (plugin.publicKeyFingerprint) {
    if (signature.status !== 'valid') error(where, `The catalog lists fingerprint ${code(plugin.publicKeyFingerprint)}, but the package is ${signature.status}.`)
    else if (signature.fingerprint !== plugin.publicKeyFingerprint) error(where, `Signed with key \`${signature.fingerprint}\`, but the catalog lists ${code(plugin.publicKeyFingerprint)}.`)
  } else if (signature.status === 'valid') {
    warn(where, `Signed with key \`${signature.fingerprint}\`, but the catalog lists no \`publicKeyFingerprint\`, so the app will not pin it.`)
  }

  scanRisks(files, where)
  return manifest
}

function compareWithBase(prRoot, baseRoot, prPlugins, basePlugins) {
  const prById = new Map(prPlugins.map(plugin => [plugin.id, plugin]))
  for (const basePlugin of basePlugins) {
    const prPlugin = prById.get(basePlugin.id)
    if (!prPlugin) {
      warn(basePlugin.id, 'This plugin is removed from the catalog.')
      continue
    }
    if (basePlugin.publicKeyFingerprint && !prPlugin.publicKeyFingerprint) {
      error(basePlugin.id, `\`publicKeyFingerprint\` ${code(basePlugin.publicKeyFingerprint)} is removed; a listed plugin must not drop signature pinning.`)
    } else if (basePlugin.publicKeyFingerprint && prPlugin.publicKeyFingerprint !== basePlugin.publicKeyFingerprint) {
      warn(basePlugin.id, `⚠️ **Signing key changes** from ${code(basePlugin.publicKeyFingerprint)} to ${code(prPlugin.publicKeyFingerprint)}. Confirm the rotation with the original author through a channel you trust before merging.`)
    }
    // Matched by precedence, so `1.0.0` cannot be republished as `1.0.0+rebuild`.
    const prVersions = new Map(prPlugin.versions.filter(isRecord).map(version => [semverKey(version.version), version]))
    for (const baseVersion of Array.isArray(basePlugin.versions) ? basePlugin.versions.filter(isRecord) : []) {
      const prVersion = prVersions.get(semverKey(baseVersion.version))
      if (!prVersion) {
        warn(`${basePlugin.id} ${baseVersion.version}`, 'This published version is removed.')
        continue
      }
      for (const key of VERSION_KEYS) {
        if (JSON.stringify(prVersion[key]) !== JSON.stringify(baseVersion[key])) {
          error(`${basePlugin.id} ${baseVersion.version}`, `Published versions are immutable, but \`${key}\` changes. Publish a new version instead.`)
        }
      }
    }
  }

  const listed = new Set(prPlugins.flatMap(plugin => plugin.versions.filter(isRecord).map(version => localPackagePath(version.url))))
  const prFiles = listFiles(prRoot)
  const baseFiles = listFiles(baseRoot)
  const changed = []
  for (const [path, full] of baseFiles) {
    const counterpart = prFiles.get(path)
    if (!counterpart) {
      if (!path.startsWith('packages/')) changed.push(path)
      else if (listed.has(path)) error(path, 'A published package file is deleted, but `index.json` still lists it.')
      else warn(path, 'A published package file is deleted.')
    } else if (statSync(full).size !== statSync(counterpart).size || sha256(readFileSync(full)) !== sha256(readFileSync(counterpart))) {
      if (path.startsWith('packages/')) error(path, 'A published package file is modified. Packages are immutable; publish a new version instead.')
      else changed.push(path)
    }
  }
  for (const path of prFiles.keys()) if (!baseFiles.has(path)) changed.push(path)
  const outsideData = changed.filter(path => path !== 'index.json' && !path.startsWith('packages/'))
  if (outsideData.length) {
    const shown = outsideData.slice(0, 30).map(item => code(item)).join(', ')
    const more = outsideData.length > 30 ? ` and ${outsideData.length - 30} more` : ''
    warn('Files outside the catalog', `⚠️ This pull request also changes ${shown}${more}. Review these by hand: changes to \`.github/\`, \`scripts/\` or the lockfile can change what this check does.`)
  }
}

function writeSummary(file, checkedCount) {
  const status = errors.length ? `❌ ${errors.length} error(s), ${warnings.length} warning(s)` : `✅ No errors, ${warnings.length} warning(s)`
  const parts = [
    '## Plugin catalog check',
    '',
    status,
    '',
    `Deep-checked ${checkedCount} new or changed version(s). A passing check is not a review: read the plugin source before merging.`,
  ]
  const list = (title, items) => {
    if (!items.length) return
    parts.push('', title, '', ...items.slice(0, REPORT_MAX_ITEMS).map(item => `- ${item}`))
    if (items.length > REPORT_MAX_ITEMS) parts.push(`- … and ${items.length - REPORT_MAX_ITEMS} more (see the run log).`)
  }
  list('### Errors', errors)
  list('### Warnings', warnings)
  if (sections.length) parts.push('', '## Permissions requested', '', ...sections.flatMap(section => [section, '']))
  let markdown = `${parts.join('\n')}\n`
  // Cut at a line end, so no code span or table row is left open.
  if (markdown.length > REPORT_MAX_CHARS) {
    markdown = `${markdown.slice(0, markdown.lastIndexOf('\n', REPORT_MAX_CHARS - 100) + 1)}\n… Report truncated; see the run log.\n`
  }
  if (file) appendFileSync(file, markdown)
  process.stdout.write(markdown)
  if (errors.length > REPORT_MAX_ITEMS || warnings.length > REPORT_MAX_ITEMS) {
    console.error([...errors, ...warnings].join('\n'))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const summaryFile = args.summary ?? process.env.GITHUB_STEP_SUMMARY
  const prRaw = readCatalog(args.pr, 'index.json')
  const prPlugins = prRaw ? validateCatalog(prRaw) : []

  let basePlugins = []
  if (args.base) {
    const baseRaw = readCatalog(args.base, 'base index.json')
    basePlugins = isRecord(baseRaw) && Array.isArray(baseRaw.plugins) ? baseRaw.plugins.filter(isRecord) : []
    compareWithBase(args.pr, args.base, prPlugins, basePlugins)
  }
  const baseVersions = new Map()
  for (const plugin of basePlugins) {
    for (const version of Array.isArray(plugin.versions) ? plugin.versions : []) {
      if (isRecord(version)) baseVersions.set(`${plugin.id}@${version.version}`, version)
    }
  }

  const baseIds = new Set(basePlugins.map(plugin => plugin.id))
  // A new fingerprint must still verify every listed version, so those are re-checked too.
  const rekeyed = new Set(prPlugins
    .filter(plugin => basePlugins.some(base => base.id === plugin.id && base.publicKeyFingerprint !== plugin.publicKeyFingerprint))
    .map(plugin => plugin.id))
  // Manifests of deep-checked versions (null when rejected), so a permission comparison
  // never downloads or unpacks a package twice.
  const manifests = new Map()
  const previousManifest = async (plugin, version) => {
    const key = `${plugin.id}@${version.version}`
    if (!manifests.has(key)) {
      const root = args.base && baseVersions.has(key) ? args.base : args.pr
      manifests.set(key, unpack(await loadPackage(root, version)).manifest)
    }
    const manifest = manifests.get(key)
    if (!manifest) throw new Error('the package is rejected above')
    return manifest
  }
  let checked = 0
  for (const plugin of prPlugins) {
    if (typeof plugin.id !== 'string' || !Array.isArray(plugin.versions)) continue
    if (!baseIds.has(plugin.id) && !plugin.publicKeyFingerprint) {
      warn(plugin.id, 'New plugin without `publicKeyFingerprint`: the app cannot detect a swapped package or key. Ask the author to sign it.')
    }
    const valid = plugin.versions.filter(version => isRecord(version) && semverKey(version.version) && catalogUrl(version.url)
      && Number.isSafeInteger(version.size) && typeof version.sha256 === 'string')
    const ordered = [...valid].sort((a, b) => compareSemver(a.version, b.version))
    for (const [index, version] of ordered.entries()) {
      const base = baseVersions.get(`${plugin.id}@${version.version}`)
      if (args.base && base && JSON.stringify(base) === JSON.stringify(version) && !rekeyed.has(plugin.id)) continue
      checked += 1
      let manifest
      try {
        manifest = await inspectVersion(args.pr, plugin, version)
      } catch (cause) {
        // The checks above report every expected failure; this keeps one bug from hiding the rest of the report.
        error(`${plugin.id} ${version.version}`, `The validator failed on this version: ${code(cause?.message ?? cause, 200)}.`)
        manifest = null
      }
      manifests.set(`${plugin.id}@${version.version}`, manifest)
      if (!manifest) continue
      let previous = null
      const earlier = ordered[index - 1]
      if (earlier) {
        try {
          previous = { version: earlier.version, manifest: await previousManifest(plugin, earlier) }
        } catch (cause) {
          warn(`${plugin.id} ${version.version}`, `Could not load ${code(earlier.version)} for the permission comparison: ${cause.message}.`)
        }
      }
      permissionSection(plugin.id, version.version, manifest, previous)
    }
  }

  writeSummary(summaryFile, checked)
  process.exitCode = errors.length ? 1 : 0
}

main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
