#!/usr/bin/env node
// Keeps scripts/vendor/agent-pets/ a byte-for-byte copy of the Agent Pets manifest and
// panel-theme validator at one pinned app commit (scripts/vendor/agent-pets/vendor.json).
//
//   node scripts/sync-app-rules.mjs
//       checks the vendored files against the hashes in vendor.json (exit 1 on drift)
//   node scripts/sync-app-rules.mjs --app <agent-pets checkout>
//       also compares them with the pinned commit, and warns when the checkout's HEAD
//       changed any of them since
//   node scripts/sync-app-rules.mjs --app <agent-pets checkout> --commit <rev>
//       copies the files from <rev> and pins vendor.json to its full hash
//
// Files are read with `git show <commit>:<path>`, so uncommitted edits are never vendored.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { VENDOR_DIR, VENDOR_FILE, readVendorManifest, sha256Hex, vendoredDrift } from './lib/app-rules.mjs'

function die(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

let options
try {
  ({ values: options } = parseArgs({ options: { app: { type: 'string' }, commit: { type: 'string' } }, strict: true }))
} catch (cause) {
  die(`${cause.message}\nusage: node scripts/sync-app-rules.mjs [--app <agent-pets checkout> [--commit <rev>]]`)
}
if (options.commit && !options.app) die('--commit needs --app')

const manifest = readVendorManifest()
// The checkout's own git config applies, but never GIT_* variables from this shell.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
const git = (app, args) => execFileSync('git', ['-C', app, ...args], { env: gitEnv, maxBuffer: 16 * 1024 * 1024 })
const showAt = (app, commit, path) => git(app, ['show', `${commit}:${path}`])

if (!options.app) {
  const drift = vendoredDrift(manifest)
  if (drift.length) die(`vendored app rules were edited:\n  ${drift.join('\n  ')}`)
  console.log(`ok: ${manifest.files.length} files match vendor.json (app ${manifest.commit.slice(0, 12)})`)
  process.exit(0)
}

const app = resolve(options.app)
if (!options.commit) {
  const problems = vendoredDrift(manifest)
  for (const file of manifest.files) {
    if (!showAt(app, manifest.commit, file.path).equals(readFileSync(resolve(VENDOR_DIR, file.path)))) {
      problems.push(`${file.path}: differs from the app at ${manifest.commit.slice(0, 12)}`)
    }
  }
  if (problems.length) die(`drift:\n  ${problems.join('\n  ')}`)
  console.log(`ok: vendored rules equal app ${manifest.commit.slice(0, 12)}`)
  const head = git(app, ['rev-parse', 'HEAD']).toString().trim()
  if (head !== manifest.commit) {
    const changed = manifest.files.filter(file => !showAt(app, head, file.path).equals(showAt(app, manifest.commit, file.path)))
    if (changed.length) console.warn(`warning: app HEAD ${head.slice(0, 12)} changed ${changed.map(file => file.path).join(', ')}; re-sync with --commit HEAD`)
  }
  process.exit(0)
}

// A revision name only: no option or path syntax can reach git.
if (!/^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,127}$/.test(options.commit)) die('--commit must be a revision name or hash')
const commit = git(app, ['rev-parse', '--verify', '--end-of-options', `${options.commit}^{commit}`]).toString().trim()
if (!/^[0-9a-f]{40}$/.test(commit)) die(`cannot resolve ${options.commit}`)
const files = manifest.files.map(file => {
  const bytes = showAt(app, commit, file.path)
  const target = resolve(VENDOR_DIR, file.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return { path: file.path, sha256: sha256Hex(bytes) }
})
writeFileSync(VENDOR_FILE, `${JSON.stringify({ ...manifest, commit, files }, null, 2)}\n`)
// A new runtime import in the app would fail here rather than in CI.
await import(resolve(VENDOR_DIR, 'electron/plugin-manifest.ts'))
console.log(`pinned ${files.length} files to app ${commit}`)
