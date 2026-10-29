#!/usr/bin/env node
// Validates a pull request's catalog against the rules Agent Pets applies when it
// reads index.json and installs a package. Mirrors electron/plugin-catalog.ts,
// electron/archive-guard.ts and electron/plugin-signature.ts in the app repo, but
// reports problems the app would silently drop.
//
// Usage: node scripts/validate-catalog.mjs --pr <dir> [--base <dir>] [--summary <file>]
// Exits 1 when any error is found. Warnings never fail the run.

import { createHash, createPublicKey, verify } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, relative, sep } from 'node:path'
import { unzipSync } from 'fflate'

const REPOSITORY = process.env.GITHUB_REPOSITORY || 'Ponpon55837/agent-pets-plugins'
const LOCAL_PACKAGE_PREFIX = `https://raw.githubusercontent.com/${REPOSITORY}/main/packages/`

const CATALOG_MAX_BYTES = 1024 * 1024
const CATALOG_MAX_PLUGINS = 500
const CATALOG_MAX_VERSIONS = 20
const PACKAGE_MAX_BYTES = 25 * 1024 * 1024
const ARCHIVE_MAX_FILES = 64
const ARCHIVE_MAX_FILE_BYTES = 20 * 1024 * 1024
const ARCHIVE_MAX_TOTAL_BYTES = 25 * 1024 * 1024
const ARCHIVE_EXTENSIONS = new Set(['.js', '.json', '.png', '.webp', '.html', '.css'])
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
const VERSION_KEYS = new Set(['version', 'apiVersion', 'url', 'sha256', 'size', 'publishedAt'])
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
  ['external <script> / <iframe>', /<(?:script|iframe)\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i],
  ['<iframe>', /<iframe\b/i],
  ['atob', /(?<![.\w$])atob\s*\(/],
  ['String.fromCharCode', /\bfromCharCode\b/],
  ['javascript: URL', /["'`]\s*javascript:/i],
]
const LONG_LINE = 1000

// ---------------------------------------------------------------- reporting

const errors = []
const warnings = []
const sections = []

function error(where, message) { errors.push(`**${where}**: ${message}`) }
function warn(where, message) { warnings.push(`**${where}**: ${message}`) }

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

function readCatalog(root, label) {
  const path = join(root, 'index.json')
  if (!existsSync(path)) {
    error(label, '`index.json` is missing.')
    return null
  }
  const bytes = readFileSync(path)
  if (bytes.byteLength < 1 || bytes.byteLength > CATALOG_MAX_BYTES) {
    error(label, `\`index.json\` must be between 1 byte and ${CATALOG_MAX_BYTES} bytes.`)
    return null
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    error(label, '`index.json` is not valid UTF-8 JSON.')
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
  if (extraRoot.length) error('index.json', `Unknown root keys: ${extraRoot.join(', ')}.`)
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
    if (extra.length) error(where, `Unknown keys: ${extra.join(', ')}.`)
    if (typeof plugin.id !== 'string' || !PLUGIN_ID.test(plugin.id)) error(where, '`id` must match `^[a-z0-9-]{3,48}$` and not be `_host` or `_shared`.')
    else if (seenIds.has(plugin.id)) error(where, `Duplicate plugin id \`${plugin.id}\`; the app drops every entry with this id.`)
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
      if (vExtra.length) error(vWhere, `Unknown keys: ${vExtra.join(', ')}.`)
      const key = semverKey(version.version)
      if (!key) error(vWhere, '`version` must be valid semver.')
      else if (precedence.has(key)) error(vWhere, `Same precedence as \`${precedence.get(key)}\`; the app drops both.`)
      else precedence.set(key, version.version)
      if (typeof version.apiVersion !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(version.apiVersion)) error(vWhere, '`apiVersion` must be a numeric string such as "1".')
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
    if (!catalogUrl(current)) throw new Error(`redirected to a host outside the allowlist (${new URL(current).hostname})`)
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(60_000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`redirect ${response.status} without a Location header`)
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > PACKAGE_MAX_BYTES) throw new Error('larger than 25 MB')
    const chunks = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > PACKAGE_MAX_BYTES) throw new Error('larger than 25 MB')
      chunks.push(chunk)
    }
    return new Uint8Array(Buffer.concat(chunks))
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`)
}

async function loadPackage(root, version) {
  if (version.url.startsWith(LOCAL_PACKAGE_PREFIX)) {
    const name = decodeURIComponent(version.url.slice(LOCAL_PACKAGE_PREFIX.length))
    if (!/^[A-Za-z0-9._-]+\.agentpet-plugin$/.test(name)) throw new Error('local package name must be a single `*.agentpet-plugin` file in packages/')
    const path = join(root, 'packages', name)
    if (!existsSync(path)) throw new Error(`\`packages/${name}\` is not in this pull request`)
    return { bytes: new Uint8Array(readFileSync(path)), local: `packages/${name}` }
  }
  return { bytes: await download(version.url), local: null }
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
        if (!safe) { rejection = `unsafe path \`${String(entry.name).slice(0, 120)}\``; throw new Error() }
        const lower = safe.path.toLowerCase()
        if (seen.has(lower)) { rejection = `duplicate path \`${safe.path}\``; throw new Error() }
        seen.add(lower)
        count += 1
        if (count > ARCHIVE_MAX_FILES) { rejection = `more than ${ARCHIVE_MAX_FILES} files`; throw new Error() }
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) { rejection = 'invalid entry size'; throw new Error() }
        if (entry.originalSize > ARCHIVE_MAX_FILE_BYTES) { rejection = `\`${safe.path}\` is larger than 20 MB`; throw new Error() }
        total += entry.originalSize
        if (total > ARCHIVE_MAX_TOTAL_BYTES) { rejection = 'uncompressed total is larger than 25 MB'; throw new Error() }
        if (!ARCHIVE_EXTENSIONS.has(extensionOf(safe.path))) { rejection = `unsupported file type \`${safe.path}\``; throw new Error() }
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
    if (!safe || safe.directory) throw new Error(`unsafe path \`${rawPath}\``)
    if (declared.get(safe.path.toLowerCase()) !== content.byteLength) throw new Error(`\`${safe.path}\` does not match its declared size`)
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

function readManifest(files) {
  const bytes = files.get('plugin.json')
  if (!bytes) throw new Error('`plugin.json` is missing from the package root')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('`plugin.json` is not valid UTF-8 JSON')
  }
}

function scanRisks(files, where) {
  for (const [path, bytes] of files) {
    if (!['.js', '.html'].includes(extensionOf(path))) continue
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/)
    const hits = new Map()
    lines.forEach((line, index) => {
      for (const [label, pattern] of RISK_PATTERNS) {
        if (pattern.test(line) && !hits.has(label)) hits.set(label, index + 1)
      }
      if (line.length > LONG_LINE && !hits.has('long line')) hits.set('long line', index + 1)
    })
    for (const [label, line] of hits) {
      warn(where, label === 'long line'
        ? `\`${path}:${line}\` has a line longer than ${LONG_LINE} characters (minified or generated code is hard to review).`
        : `\`${path}:${line}\` uses ${label}.`)
    }
  }
}

// ---------------------------------------------------------------- permissions

function hostsOf(manifest) {
  const hosts = new Set()
  for (const group of ['network', 'links']) {
    const list = manifest?.permissions?.[group]?.hosts
    if (Array.isArray(list)) for (const host of list) hosts.add(`${group}:${host}`)
  }
  return hosts
}

function describeValue(value) {
  if (isRecord(value) && Array.isArray(value.hosts) && Object.keys(value).length === 1) return value.hosts.map(host => `\`${host}\``).join(', ')
  if (value === true) return 'yes'
  return `\`${JSON.stringify(value)}\``
}

function permissionSection(pluginId, version, manifest, previous) {
  const rows = []
  const permissions = isRecord(manifest.permissions) ? manifest.permissions : {}
  for (const [key, value] of Object.entries(permissions)) rows.push(`| \`permissions.${key}\` | ${describeValue(value)} |`)
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : {}
  for (const [key, value] of Object.entries(contributes)) rows.push(`| \`contributes.${key}\` | ${key === 'panelView' && isRecord(value) ? `\`${value.entry}\`` : describeValue(value)} |`)
  const lines = [`### \`${pluginId}\` ${version}`, '', '| Item | Value |', '| --- | --- |', ...(rows.length ? rows : ['| (none) | |'])]
  if (previous) {
    const before = hostsOf(previous.manifest)
    const added = [...hostsOf(manifest)].filter(host => !before.has(host))
    const addedPermissions = Object.keys(permissions).filter(key => !(key in (previous.manifest.permissions ?? {})))
    lines.push('', `Compared with ${previous.version}:`)
    lines.push(added.length ? `- ⚠️ New hosts: ${added.map(host => `\`${host}\``).join(', ')}` : '- No new hosts.')
    if (addedPermissions.length) lines.push(`- ⚠️ New permissions: ${addedPermissions.map(key => `\`${key}\``).join(', ')}`)
    if (added.length || addedPermissions.length) warn(`${pluginId} ${version}`, `Requests more than ${previous.version}; check the permission summary.`)
  } else {
    lines.push('', 'First published version: every permission above is new.')
  }
  sections.push(lines.join('\n'))
}

// ---------------------------------------------------------------- main checks

async function inspectVersion(root, plugin, version) {
  const where = `${plugin.id} ${version.version}`
  let bytes
  try {
    ({ bytes } = await loadPackage(root, version))
  } catch (cause) {
    error(where, `Could not load the package: ${cause.message}.`)
    return null
  }
  if (bytes.byteLength !== version.size) error(where, `Size is ${bytes.byteLength} bytes, but \`index.json\` says ${version.size}.`)
  const digest = sha256(bytes)
  if (digest !== version.sha256) error(where, `SHA-256 is \`${digest}\`, but \`index.json\` says \`${version.sha256}\`.`)

  let files
  try {
    files = extractArchive(bytes)
  } catch (cause) {
    error(where, `Archive rejected: ${cause.message}.`)
    return null
  }

  let manifest
  try {
    manifest = readManifest(files)
  } catch (cause) {
    error(where, cause.message)
    return null
  }
  if (!isRecord(manifest)) {
    error(where, '`plugin.json` must be an object.')
    return null
  }
  if (manifest.id !== plugin.id) error(where, `\`plugin.json\` id is \`${manifest.id}\`, but the catalog says \`${plugin.id}\`.`)
  if (manifest.version !== version.version) error(where, `\`plugin.json\` version is \`${manifest.version}\`, but the catalog says \`${version.version}\`.`)
  if (manifest.apiVersion !== version.apiVersion) error(where, `\`plugin.json\` apiVersion is \`${manifest.apiVersion}\`, but the catalog says \`${version.apiVersion}\`.`)
  for (const [label, entry] of [['entry', manifest.entry], ['contributes.panelView.entry', manifest.contributes?.panelView?.entry]]) {
    if (entry === undefined) continue
    if (typeof entry !== 'string' || !files.has(entry)) error(where, `\`${label}\` points to \`${entry}\`, which is not in the package.`)
  }

  const signature = verifySignature(files)
  if (signature.status === 'invalid') error(where, '`signature.json` is present but the signature is invalid.')
  if (plugin.publicKeyFingerprint) {
    if (signature.status !== 'valid') error(where, `The catalog lists fingerprint \`${plugin.publicKeyFingerprint}\`, but the package is ${signature.status}.`)
    else if (signature.fingerprint !== plugin.publicKeyFingerprint) error(where, `Signed with key \`${signature.fingerprint}\`, but the catalog lists \`${plugin.publicKeyFingerprint}\`.`)
  } else if (signature.status === 'valid') {
    warn(where, `Signed with key \`${signature.fingerprint}\`, but the catalog lists no \`publicKeyFingerprint\`, so the app will not pin it.`)
  }

  scanRisks(files, where)
  return { manifest, files }
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
      error(basePlugin.id, `\`publicKeyFingerprint\` \`${basePlugin.publicKeyFingerprint}\` is removed; a listed plugin must not drop signature pinning.`)
    } else if (basePlugin.publicKeyFingerprint && prPlugin.publicKeyFingerprint !== basePlugin.publicKeyFingerprint) {
      warn(basePlugin.id, `⚠️ **Signing key changes** from \`${basePlugin.publicKeyFingerprint}\` to \`${prPlugin.publicKeyFingerprint}\`. Confirm the rotation with the original author through a channel you trust before merging.`)
    }
    const prVersions = new Map((prPlugin.versions ?? []).map(version => [version.version, version]))
    for (const baseVersion of basePlugin.versions ?? []) {
      const prVersion = prVersions.get(baseVersion.version)
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

  const prFiles = listFiles(prRoot)
  const baseFiles = listFiles(baseRoot)
  const changed = []
  for (const [path, full] of baseFiles) {
    const counterpart = prFiles.get(path)
    if (!counterpart) {
      if (path.startsWith('packages/')) warn(path, 'A published package file is deleted.')
      else changed.push(path)
    } else if (statSync(full).size !== statSync(counterpart).size || sha256(readFileSync(full)) !== sha256(readFileSync(counterpart))) {
      if (path.startsWith('packages/')) error(path, 'A published package file is modified. Packages are immutable; publish a new version instead.')
      else changed.push(path)
    }
  }
  for (const path of prFiles.keys()) if (!baseFiles.has(path)) changed.push(path)
  const outsideData = changed.filter(path => path !== 'index.json' && !path.startsWith('packages/'))
  if (outsideData.length) {
    warn('Files outside the catalog', `⚠️ This pull request also changes ${outsideData.map(path => `\`${path}\``).join(', ')}. Review these by hand: changes to \`.github/\`, \`scripts/\` or the lockfile can change what this check does.`)
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
  if (errors.length) parts.push('', '### Errors', '', ...errors.map(item => `- ${item}`))
  if (warnings.length) parts.push('', '### Warnings', '', ...warnings.map(item => `- ${item}`))
  if (sections.length) parts.push('', '## Permissions requested', '', ...sections.flatMap(section => [section, '']))
  const markdown = `${parts.join('\n')}\n`
  if (file) appendFileSync(file, markdown)
  process.stdout.write(markdown)
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
      const result = await inspectVersion(args.pr, plugin, version)
      if (!result) continue
      let previous = null
      const earlier = ordered[index - 1]
      if (earlier) {
        try {
          const { bytes } = await loadPackage(args.base && baseVersions.has(`${plugin.id}@${earlier.version}`) ? args.base : args.pr, earlier)
          previous = { version: earlier.version, manifest: readManifest(extractArchive(bytes)) }
        } catch (cause) {
          warn(`${plugin.id} ${version.version}`, `Could not load ${earlier.version} for the permission comparison: ${cause.message}.`)
        }
      }
      permissionSection(plugin.id, version.version, result.manifest, previous)
    }
  }

  writeSummary(summaryFile, checked)
  process.exitCode = errors.length ? 1 : 0
}

main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
