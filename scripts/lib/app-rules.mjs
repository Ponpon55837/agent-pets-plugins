// The pin for the vendored Agent Pets validator (scripts/vendor/agent-pets/): the app
// commit it was copied from and the SHA-256 of every file at that commit. The files
// keep their app paths, so their relative imports resolve unchanged.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/agent-pets')
export const VENDOR_FILE = resolve(VENDOR_DIR, 'vendor.json')

// A fixed shape, so an edited vendor.json cannot point a sync outside these app folders.
const VENDOR_PATH = /^(?:electron|src\/types)\/[a-z0-9-]+\.ts$/

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex')

export function readVendorManifest() {
  const manifest = JSON.parse(readFileSync(VENDOR_FILE, 'utf8'))
  if (typeof manifest.repository !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commit ?? '')
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('vendor.json needs repository, a 40-hex commit and files')
  }
  const seen = new Set()
  for (const file of manifest.files) {
    if (!VENDOR_PATH.test(file?.path ?? '') || !/^[0-9a-f]{64}$/.test(file.sha256 ?? '') || seen.has(file.path)) {
      throw new Error(`vendor.json has a bad entry: ${JSON.stringify(file)}`)
    }
    seen.add(file.path)
  }
  return manifest
}

/** Vendored files whose bytes no longer match the SHA-256 recorded in vendor.json. */
export function vendoredDrift(manifest = readVendorManifest()) {
  return manifest.files
    .filter(file => sha256Hex(readFileSync(resolve(VENDOR_DIR, file.path))) !== file.sha256)
    .map(file => `${file.path}: SHA-256 differs from vendor.json`)
}
