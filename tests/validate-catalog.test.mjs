// Runs scripts/validate-catalog.mjs on throwaway catalogs built from in-memory packages.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { readVendorManifest, vendoredDrift } from '../scripts/lib/app-rules.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VALIDATOR = join(ROOT, 'scripts/validate-catalog.mjs')
const REPOSITORY = 'Ponpon55837/agent-pets-plugins'
const PACKAGE_PREFIX = `https://raw.githubusercontent.com/${REPOSITORY}/main/packages/`
const WORK = mkdtempSync(join(tmpdir(), 'catalog-test-'))
after(() => rmSync(WORK, { recursive: true, force: true }))

const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0])

function lightMode(colors = {}) {
  return {
    colors: {
      bg: '#eef6f6',
      surface: '#f8fcfc',
      surface2: '#e2eeee',
      text: '#10282c',
      textSecondary: '#2f4a4f',
      textMuted: '#3d585c',
      accent: '#1f7a80',
      accentText: '#135a5f',
      onAccent: '#ffffff',
      border: 'rgb(16 40 44 / 0.18)',
      ...colors,
    },
    background: { type: 'gradient', kind: 'linear', angle: 160, stops: [{ color: '#eef6f6', at: 0 }, { color: '#dcebec', at: 100 }] },
  }
}

const DARK_MODE = {
  colors: {
    bg: '#0d1b22',
    surface: '#13252e',
    surface2: '#1b313b',
    text: '#e6f4f5',
    textSecondary: '#c0d8db',
    textMuted: '#a3c0c4',
    accent: '#4fc3c9',
    accentText: '#8adfe3',
    onAccent: '#0d1b22',
    border: 'rgb(230 244 245 / 0.18)',
  },
}

function themeManifest({ light = lightMode(), fontSrc = 'fonts/body.woff2' } = {}) {
  return {
    id: 'theme-fixture',
    name: { 'zh-TW': '主題測試', 'en-US': 'Theme Fixture' },
    version: '1.0.0',
    apiVersion: '1',
    author: 'Catalog Test',
    permissions: {},
    contributes: {
      panelThemes: [{
        id: 'aurora',
        displayName: { 'zh-TW': '極光', 'en-US': 'Aurora' },
        fonts: [{ id: 'body', src: fontSrc, weight: 400, style: 'normal' }],
        typography: { body: ['@body', 'system-ui', 'sans-serif'] },
        modes: { light, dark: DARK_MODE },
      }],
    },
  }
}

const json = value => new TextEncoder().encode(JSON.stringify(value))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function runValidator(args) {
  const env = { ...process.env, GITHUB_REPOSITORY: REPOSITORY }
  delete env.GITHUB_STEP_SUMMARY
  const result = spawnSync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
  return { status: result.status, report: `${result.stdout}${result.stderr}`, stdout: result.stdout }
}

/** Writes a one-plugin catalog with one version and returns its directory. */
function writeCatalog(name, { manifest = themeManifest(), files = { 'fonts/body.woff2': WOFF2 }, entry = {}, plugin = {} } = {}) {
  const dir = join(WORK, name)
  mkdirSync(join(dir, 'packages'), { recursive: true })
  const archive = zipSync({ 'plugin.json': json(manifest), ...files })
  const fileName = `${manifest.id}-${manifest.version}.agentpet-plugin`
  writeFileSync(join(dir, 'packages', fileName), archive)
  const version = {
    version: manifest.version,
    apiVersion: '1',
    minAppVersion: '1.12.0',
    url: `${PACKAGE_PREFIX}${fileName}`,
    sha256: sha256(archive),
    size: archive.byteLength,
    publishedAt: '2026-11-08T00:00:00.000Z',
    ...entry,
  }
  for (const [key, value] of Object.entries(version)) if (value === undefined) delete version[key]
  const catalog = {
    schemaVersion: 1,
    plugins: [{
      id: manifest.id,
      name: { 'zh-TW': '主題測試', 'en-US': 'Theme Fixture' },
      description: { 'zh-TW': '測試用。', 'en-US': 'For tests.' },
      author: 'Catalog Test',
      versions: [version],
      ...plugin,
    }],
  }
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  return dir
}

const runCatalog = (name, options) => runValidator(['--pr', writeCatalog(name, options)])

function assertRejected(result, pattern) {
  assert.equal(result.status, 1, result.report)
  assert.match(result.report, /❌/)
  assert.match(result.report, pattern)
}

test('a valid panel-theme package passes', () => {
  const result = runCatalog('valid')
  assert.equal(result.status, 0, result.report)
  assert.match(result.report, /✅ No errors/)
  assert.match(result.report, /1 theme\(s\): `aurora`; 1 font face\(s\)/)
})

test('the published catalog passes', () => {
  const result = runValidator(['--pr', ROOT])
  assert.equal(result.status, 0, result.report)
})

test('changing minAppVersion on a published version fails', () => {
  const base = writeCatalog('published-base', { entry: { minAppVersion: '1.12.0' } })
  const pr = writeCatalog('published-pr', { entry: { minAppVersion: '1.12.1' } })
  assertRejected(runValidator(['--pr', pr, '--base', base]), /Published versions are immutable, but `minAppVersion` changes/)
})

test('an invalid colour fails', () => {
  assertRejected(runCatalog('bad-colour', { manifest: themeManifest({ light: lightMode({ accent: '#12345g' }) }) }), /invalid_panel_theme.*not an allowed colour/)
})

test('a contrast failure fails', () => {
  assertRejected(runCatalog('low-contrast', { manifest: themeManifest({ light: lightMode({ text: '#d8e4e4' }) }) }), /invalid_panel_theme`: `aurora\.light\.colors\.text: [\d.]+:1 < 4\.5:1 on surface`/)
})

test('a font that is not WOFF2 fails', () => {
  const ttf = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x80])
  assertRejected(runCatalog('bad-woff2', { files: { 'fonts/body.woff2': ttf } }), /is not WOFF2/)
})

test('a WOFF2 font larger than 1 MiB fails', () => {
  const large = new Uint8Array(1024 * 1024 + 1)
  large.set(WOFF2)
  assertRejected(runCatalog('large-woff2', { files: { 'fonts/body.woff2': large } }), /larger than 1 MiB/)
})

test('a WOFF2 file that no theme references fails', () => {
  assertRejected(runCatalog('stray-woff2', { files: { 'fonts/body.woff2': WOFF2, 'fonts/extra.woff2': WOFF2 } }), /`fonts\/extra\.woff2` is a `\.woff2` that no/)
})

test('a font path that leaves the package fails', () => {
  assertRejected(runCatalog('traversal-src', { manifest: themeManifest({ fontSrc: '../body.woff2' }) }), /invalid_panel_theme/)
})

test('an archive entry that leaves the package fails', () => {
  assertRejected(runCatalog('traversal-entry', { files: { 'fonts/body.woff2': WOFF2, '../evil.woff2': WOFF2 } }), /unsafe path/)
})

test('a panel-theme version without minAppVersion fails', () => {
  assertRejected(runCatalog('no-min-app', { entry: { minAppVersion: undefined } }), /needs `"minAppVersion": "1\.12\.0"`/)
})

test('a panel-theme version with a minAppVersion below 1.12.0 fails', () => {
  assertRejected(runCatalog('low-min-app', { entry: { minAppVersion: '1.11.5' } }), /needs Agent Pets 1\.12\.0, but `minAppVersion` is `1\.11\.5`/)
})

test('a minAppVersion that is not major.minor.patch fails', () => {
  assertRejected(runCatalog('bad-min-app', { entry: { minAppVersion: '1.12.0-beta.1' } }), /`minAppVersion` must be an app version/)
})

// Every pull-request value must sit inside a code span: outside one, GitHub renders it
// as an image or link, and autolinks a bare URL.
function assertOnlyInCodeSpans(report, needle) {
  for (const line of report.split('\n').filter(item => item.includes(needle))) {
    const outside = line.split('`').filter((_, index) => index % 2 === 0).join('')
    assert.ok(!outside.includes(needle), `outside a code span: ${line}`)
  }
}

test('report text cannot inject markdown', () => {
  const result = runCatalog('markdown', { entry: { version: '`![x](https://example.invalid/x.png)' } })
  assert.equal(result.status, 1)
  assert.match(result.report, /\*\*`plugins\[0\] \(theme-fixture\) versions\[0\] \('!\[x\]/)
  assertOnlyInCodeSpans(result.stdout, 'example.invalid')
})

test('a plugin id cannot add a link to the report', () => {
  const result = runCatalog('autolink', { plugin: { id: 'see https://example.invalid/login' } })
  assert.equal(result.status, 1)
  assertOnlyInCodeSpans(result.stdout, 'example.invalid')
})

test('the report is capped at a comment-sized length', () => {
  const dir = join(WORK, 'many-errors')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 1, plugins: Array(450).fill(1) }))
  const result = runValidator(['--pr', dir])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /… and 250 more \(see the run log\)/)
  assert.ok(result.stdout.length <= 60_000, `${result.stdout.length} characters`)
})

test('a symlinked package is rejected without being read', () => {
  const dir = writeCatalog('symlink-package')
  const target = join(dir, 'packages', 'theme-fixture-1.0.0.agentpet-plugin')
  const real = join(WORK, 'symlink-target.agentpet-plugin')
  writeFileSync(real, readFileSync(target))
  unlinkSync(target)
  symlinkSync(real, target)
  assertRejected(runValidator(['--pr', dir]), /is not a regular file \(symlinks are not allowed\)/)
})

test('a symlinked index.json is rejected', () => {
  const dir = writeCatalog('symlink-index')
  const real = join(WORK, 'symlink-index.json')
  writeFileSync(real, readFileSync(join(dir, 'index.json')))
  unlinkSync(join(dir, 'index.json'))
  symlinkSync(real, join(dir, 'index.json'))
  assertRejected(runValidator(['--pr', dir]), /`index\.json` is not a regular file/)
})

test('a local package larger than 25 MiB is rejected before it is read', () => {
  const dir = writeCatalog('huge-package')
  truncateSync(join(dir, 'packages', 'theme-fixture-1.0.0.agentpet-plugin'), 25 * 1024 * 1024 + 1)
  assertRejected(runValidator(['--pr', dir]), /is larger than 26214400 bytes/)
})

test('a published version cannot be republished with new build metadata', () => {
  const base = writeCatalog('precedence-base')
  const pr = writeCatalog('precedence-pr', { entry: { version: '1.0.0+rebuild' } })
  assertRejected(runValidator(['--pr', pr, '--base', base]), /Published versions are immutable, but `version` changes/)
})

test('deleting a package that index.json still lists fails', () => {
  const base = writeCatalog('deleted-base')
  const pr = join(WORK, 'deleted-pr')
  cpSync(base, pr, { recursive: true })
  unlinkSync(join(pr, 'packages', 'theme-fixture-1.0.0.agentpet-plugin'))
  assertRejected(runValidator(['--pr', pr, '--base', base]), /A published package file is deleted, but `index\.json` still lists it/)
})

test('a new version lists the consent items it adds over the previous one', () => {
  const base = writeCatalog('consent-base')
  const next = themeManifest()
  next.version = '1.1.0'
  next.contributes.panelThemes.push({ ...next.contributes.panelThemes[0], id: 'boreal' })
  const pr = writeCatalog('consent-pr', { manifest: next })
  cpSync(join(base, 'packages'), join(pr, 'packages'), { recursive: true })
  const catalog = JSON.parse(readFileSync(join(pr, 'index.json'), 'utf8'))
  catalog.plugins[0].versions.push(JSON.parse(readFileSync(join(base, 'index.json'), 'utf8')).plugins[0].versions[0])
  writeFileSync(join(pr, 'index.json'), JSON.stringify(catalog))
  const result = runValidator(['--pr', pr, '--base', base])
  assert.equal(result.status, 0, result.report)
  assert.match(result.report, /Deep-checked 1 new or changed version/)
  assert.match(result.report, /Compared with `1\.0\.0`:\n- ⚠️ New consent items \(the app asks again\): `contributes:panelThemes:2`/)
})

test('a long minified line is scanned in linear time', () => {
  const files = { 'fonts/body.woff2': WOFF2, 'extra.js': new TextEncoder().encode('<script '.repeat(250_000)) }
  const started = Date.now()
  const result = runCatalog('long-line', { files })
  assert.equal(result.status, 0, result.report)
  assert.match(result.report, /`extra\.js:1` has a line longer than 1000 characters/)
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`)
})

test('vendored app rules match the pinned hashes', () => {
  const manifest = readVendorManifest()
  assert.match(manifest.commit, /^[0-9a-f]{40}$/)
  assert.deepEqual(vendoredDrift(manifest), [])
})
