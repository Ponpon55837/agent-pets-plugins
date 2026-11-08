import type { PetImportAtlas, PetImportWarning } from '../src/types/pet-import.ts'

// Structural checks for imported spritesheets: the renderer slices a fixed
// 192x208 grid, so a sheet with other dimensions renders as blank or garbled
// cells without any error. These read only the image header.

export const SPRITE_CELL_WIDTH = 192
export const SPRITE_CELL_HEIGHT = 208
/** Rows 0-8 (idle ... review) are required by every atlas version. */
export const SPRITE_MIN_ROWS = 9

export type SpriteValidationError = 'E_TYPE' | 'E_SIZE' | 'E_ROWS' | 'E_ORIENTATION'

export const SPRITE_ERROR_MESSAGES: Record<SpriteValidationError, string> = {
  E_TYPE: 'Spritesheet dimensions could not be read',
  E_SIZE: 'Spritesheet size must be a multiple of the 192x208 frame grid and within the maximum dimensions',
  E_ROWS: 'Spritesheet needs at least 9 animation rows',
  E_ORIENTATION: 'Spritesheet has EXIF rotation; save it again without rotation',
}

export interface ImageSize {
  width: number
  height: number
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readPngSize(bytes: Uint8Array): ImageSize | null {
  // The first chunk must be IHDR; its dimensions are what a decoder allocates.
  if (bytes.length < 24 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

function readWebpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (chunk === 'VP8X') {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  }
  if (chunk === 'VP8 ') {
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

const JPEG_SOS = 0xda
const JPEG_EOI = 0xd9
const JPEG_SOI = 0xd8
const JPEG_APP1 = 0xe1

function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
}

interface JpegInfo {
  size: ImageSize
  orientation: number
}

/**
 * Walks every JPEG segment, including the entropy-coded data after each SOS,
 * so the frame size we cap is the one a decoder uses: 0xFF fill bytes are
 * skipped (not read as a marker), exactly one SOF is allowed and it must come
 * before the first SOS, and a segment running past EOF is invalid. O(bytes).
 */
function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  let offset = 2
  let size: ImageSize | null = null
  let orientation = 1
  let scanned = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return null
    const marker = bytes[offset]
    offset += 1
    if (marker === JPEG_EOI) break
    if (marker === JPEG_SOI || marker === 0x00) return null
    if (isStandaloneMarker(marker)) continue
    if (offset + 2 > bytes.length) return null
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) return null
    if (isJpegSof(marker)) {
      if (size || scanned || length < 8) return null
      size = { height: (bytes[offset + 3] << 8) | bytes[offset + 4], width: (bytes[offset + 5] << 8) | bytes[offset + 6] }
    } else if (marker === JPEG_APP1 && length >= 8 && String.fromCharCode(...bytes.subarray(offset + 2, offset + 6)) === 'Exif'
      && bytes[offset + 6] === 0 && bytes[offset + 7] === 0) {
      orientation = readTiffOrientation(bytes.subarray(offset + 8, offset + length)) ?? orientation
    }
    offset += length
    if (marker === JPEG_SOS) {
      if (!size) return null
      scanned = true
      // Skip entropy-coded data: FF00 is a stuffed byte, FFD0-FFD7 a restart
      // marker, FFFF fill; any other FFxx starts the next segment.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue }
        const next = bytes[offset + 1]
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue }
        if (next === 0xff) { offset += 1; continue }
        break
      }
    }
  }
  return size && scanned ? { size, orientation } : null
}

function readJpegSize(bytes: Uint8Array): ImageSize | null {
  return readJpegInfo(bytes)?.size ?? null
}

/** EXIF (TIFF) Orientation tag 0x0112 from IFD0; null when absent or unreadable. */
export function readTiffOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null
  const u16 = (at: number) => (little ? tiff[at] | (tiff[at + 1] << 8) : (tiff[at] << 8) | tiff[at + 1])
  const u32 = (at: number) => (little
    ? (tiff[at] | (tiff[at + 1] << 8) | (tiff[at + 2] << 16) | (tiff[at + 3] << 24)) >>> 0
    : u32be(tiff, at))
  if (u16(2) !== 42) return null
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return null
  const count = u16(ifd)
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > tiff.length) return null
    if (u16(entry) === 0x0112) return u16(entry + 8)
  }
  return null
}

function readPngOrientation(bytes: Uint8Array): number {
  // Chunks before IDAT only; eXIf must precede image data.
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'IDAT' || type === 'IEND' || offset + 12 + length > bytes.length) break
    if (type === 'eXIf') return readTiffOrientation(bytes.subarray(offset + 8, offset + 8 + length)) ?? 1
    offset += 12 + length
  }
  return 1
}

function readWebpOrientation(bytes: Uint8Array): number {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const length = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0
    if (offset + 8 + length > bytes.length) break
    if (type === 'EXIF') {
      const exif = bytes.subarray(offset + 8, offset + 8 + length)
      // Some writers keep the JPEG-style "Exif\0\0" prefix inside the chunk.
      const tiff = String.fromCharCode(...exif.subarray(0, 4)) === 'Exif' ? exif.subarray(6) : exif
      return readTiffOrientation(tiff) ?? 1
    }
    offset += 8 + length + (length & 1)
  }
  return 1
}

/**
 * EXIF orientation the renderer would apply (Chromium honours it by default,
 * including for detached Image objects drawn to a canvas). Anything other
 * than 1 would swap or mirror the 192x208 grid we validated.
 */
export function readImageOrientation(bytes: Uint8Array): number {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return readPngOrientation(bytes)
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return readWebpOrientation(bytes)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpegInfo(bytes)?.orientation ?? 1
  return 1
}

function isPngAnimated(bytes: Uint8Array): boolean {
  // APNG：acTL chunk 必須出現在第一個 IDAT 之前。
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND' || offset + 12 + length > bytes.length) return false
    offset += 12 + length
  }
  return false
}

function isWebpAnimated(bytes: Uint8Array): boolean {
  if (bytes.length >= 21 && String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) === 'VP8X'
    && (bytes[20]! & 0x02) !== 0) return true
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
    if (type === 'ANIM' || type === 'ANMF') return true
    const length = (bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24)) >>> 0
    if (offset + 8 + length > bytes.length) return false
    offset += 8 + length + (length & 1)
  }
  return false
}

/**
 * 動畫的檔頭走訪：PNG 的 `acTL` 在 `IDAT` 之前；WebP 的 VP8X 動畫
 * 旗標（byte 20、bit 0x02）或 ANIM/ANMF chunk。JPEG 永遠不是動畫。
 * O(chunks)；不做任何解碼。
 */
export function readImageAnimated(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return isPngAnimated(bytes)
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return isWebpAnimated(bytes)
  return false
}

export function readImageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return readPngSize(bytes)
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return readWebpSize(bytes)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpegSize(bytes)
  return null
}

// Upper bounds read from the image header (no decode needed) so a tiny, highly compressed file
// cannot make the renderer allocate gigabytes.
export const SPRITE_MAX_WIDTH = SPRITE_CELL_WIDTH * 32
export const SPRITE_MAX_HEIGHT = SPRITE_CELL_HEIGHT * 64
export const SPRITE_MAX_PIXELS = 16 * 1024 * 1024

export function validateSpriteSheet(bytes: Uint8Array): { ok: true; size: ImageSize } | { ok: false; code: SpriteValidationError } {
  const size = readImageSize(bytes)
  if (!size || size.width <= 0 || size.height <= 0) return { ok: false, code: 'E_TYPE' }
  if (size.width % SPRITE_CELL_WIDTH !== 0 || size.height % SPRITE_CELL_HEIGHT !== 0) {
    return { ok: false, code: 'E_SIZE' }
  }
  if (size.width > SPRITE_MAX_WIDTH || size.height > SPRITE_MAX_HEIGHT || size.width * size.height > SPRITE_MAX_PIXELS) {
    return { ok: false, code: 'E_SIZE' }
  }
  if (size.height / SPRITE_CELL_HEIGHT < SPRITE_MIN_ROWS) return { ok: false, code: 'E_ROWS' }
  if (readImageOrientation(bytes) !== 1) return { ok: false, code: 'E_ORIENTATION' }
  return { ok: true, size }
}

// Codex pet atlas versions, from the bundled fixtures (public/pets/*):
//   v1: 8 columns x 9 rows   (1536x1872) - idle, running-right, running-left,
//       waving, jumping, failed, waiting, running, review
//   v2: 8 columns x 11 rows  (1536x2288) - v1 plus rows 9-10, which are
//       look-direction rows ("look-000-to-157.5", "look-180-to-337.5" in
//       public/pets/qitian-dasheng/validation.json), not walk or sleep.
export const SPRITE_ATLAS_COLUMNS = 8
export const SPRITE_V1_ROWS = 9
export const SPRITE_V2_ROWS = 11
/** Row 1 is "running-right" in both atlas versions. */
export const SPRITE_ATLAS_WALK_ROW = 1

export type SpriteAtlasWarning = Exclude<PetImportWarning, 'ignored-entries'>

export interface SpriteAtlasInfo extends PetImportAtlas {
  warnings: SpriteAtlasWarning[]
}

/**
 * The image is the source of truth: 11+ rows is v2, 9-10 rows is v1. A
 * declared `spriteVersionNumber` that disagrees only produces a warning.
 */
export function detectSpriteAtlas(size: ImageSize, declaredVersion?: unknown): SpriteAtlasInfo {
  const columns = Math.floor(size.width / SPRITE_CELL_WIDTH)
  const rows = Math.floor(size.height / SPRITE_CELL_HEIGHT)
  const version: PetImportAtlas['version'] = rows >= SPRITE_V2_ROWS ? 2 : 1
  const warnings: SpriteAtlasWarning[] = []
  if ((declaredVersion === 1 || declaredVersion === 2) && declaredVersion !== version) warnings.push('declared-version-mismatch')
  if (rows !== SPRITE_V1_ROWS && rows !== SPRITE_V2_ROWS) warnings.push('unexpected-row-count')
  if (columns !== SPRITE_ATLAS_COLUMNS) warnings.push('unexpected-column-count')
  return {
    version, columns, rows, width: size.width, height: size.height,
    frameWidth: SPRITE_CELL_WIDTH, frameHeight: SPRITE_CELL_HEIGHT, warnings,
  }
}
