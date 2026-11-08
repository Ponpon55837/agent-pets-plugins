import { isRecord } from './value-guards.ts'
export interface SanitizedPetBehaviorDefinition {
  row: number
  frames?: number
  frameDurations?: number[]
}

export type SanitizedPetBehaviorManifest = Partial<Record<'walk' | 'sleep', SanitizedPetBehaviorDefinition>>

const BEHAVIOR_NAMES = ['walk', 'sleep'] as const
const MAX_ROW = 10
const MAX_FRAMES = 16
const MIN_FRAME_MS = 60
const MAX_FRAME_MS = 3_000

function parseDefinition(value: unknown): SanitizedPetBehaviorDefinition | undefined {
  if (!isRecord(value)) return undefined
  const row = value.row
  if (typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0 || row > MAX_ROW) return undefined

  const frames = value.frames
  const frameDurations = value.frameDurations
  if (frames !== undefined && (typeof frames !== 'number' || !Number.isSafeInteger(frames) || frames < 1 || frames > MAX_FRAMES)) {
    return undefined
  }

  let safeDurations: number[] | undefined
  if (frameDurations !== undefined) {
    if (!Array.isArray(frameDurations) || frameDurations.length < 1 || frameDurations.length > MAX_FRAMES) {
      return undefined
    }
    safeDurations = frameDurations.map(value => (
      typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(MIN_FRAME_MS, Math.min(MAX_FRAME_MS, value)))
        : NaN
    ))
    if (safeDurations.some(value => !Number.isFinite(value))) return undefined
  }

  return {
    row,
    ...(frames === undefined ? {} : { frames }),
    ...(safeDurations ? { frameDurations: safeDurations } : {}),
  }
}

export function parsePetBehaviorManifest(value: unknown): SanitizedPetBehaviorManifest | undefined {
  if (!isRecord(value)) return undefined
  const result: SanitizedPetBehaviorManifest = {}
  for (const name of BEHAVIOR_NAMES) {
    const definition = parseDefinition(value[name])
    if (definition) result[name] = definition
  }
  return Object.keys(result).length > 0 ? result : undefined
}
