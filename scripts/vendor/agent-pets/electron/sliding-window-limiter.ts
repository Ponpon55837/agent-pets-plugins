interface RateSample {
  at: number
  scope?: string
}

export interface SlidingWindowCheck {
  allowed: boolean
  retryAfterMs: number
}

/** Fixed-capacity circular timestamp queue for exact sliding-window limits. */
export class SlidingWindowLimiter {
  readonly windowMs: number
  private entries: Array<RateSample | undefined>
  private head = 0
  private count = 0
  private lastNow: number | null = null
  private orderedByTime = true

  constructor(windowMs: number, initialCapacity: number) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('windowMs must be positive')
    this.windowMs = windowMs
    const capacity = Number.isSafeInteger(initialCapacity) && initialCapacity > 0 ? initialCapacity : 1
    this.entries = new Array(capacity)
  }

  get size(): number {
    return this.count
  }

  get earliestTimestamp(): number | null {
    if (this.count === 0) return null
    if (this.orderedByTime) return this.first()?.at ?? null
    let earliest = Number.POSITIVE_INFINITY
    for (const entry of this.toArray()) earliest = Math.min(earliest, entry.at)
    return Number.isFinite(earliest) ? earliest : null
  }

  check(now: number, limit: number): SlidingWindowCheck {
    this.prepare(now)
    if (!Number.isSafeInteger(limit) || limit < 1) return { allowed: false, retryAfterMs: this.windowMs }
    const oldest = this.first()?.at ?? now
    return {
      allowed: this.count < limit,
      retryAfterMs: Math.max(1, this.windowMs - (now - oldest)),
    }
  }

  record(now: number, scope?: string): void {
    this.prepare(now)
    this.ensureCapacity(this.count + 1)
    const last = this.count > 0 ? this.entries[(this.head + this.count - 1) % this.entries.length] : undefined
    if (last && now < last.at) this.orderedByTime = false
    const index = (this.head + this.count) % this.entries.length
    this.entries[index] = { at: now, ...(scope === undefined ? {} : { scope }) }
    this.count += 1
  }

  consume(now: number, limit: number, scope?: string): SlidingWindowCheck {
    const check = this.check(now, limit)
    if (check.allowed) this.record(now, scope)
    return check
  }

  prune(now: number): void {
    this.prepare(now)
  }

  removeScope(scope: string): void {
    this.rebuild(this.toArray().filter(entry => entry.scope !== scope))
  }

  clear(): void {
    this.entries.fill(undefined)
    this.head = 0
    this.count = 0
    this.lastNow = null
    this.orderedByTime = true
  }

  private first(): RateSample | undefined {
    return this.count > 0 ? this.entries[this.head] : undefined
  }

  private prepare(now: number): void {
    if (!Number.isFinite(now) || now < 0) return
    if (this.lastNow !== null && now < this.lastNow) this.orderedByTime = false
    if (this.orderedByTime) {
      while (this.count > 0) {
        const entry = this.first()
        if (!entry || now - entry.at < this.windowMs) break
        this.entries[this.head] = undefined
        this.head = (this.head + 1) % this.entries.length
        this.count -= 1
      }
      if (this.count === 0) this.head = 0
    } else {
      const retained = this.toArray().filter(entry => now - entry.at < this.windowMs)
      this.rebuild(retained)
      this.orderedByTime = retained.every((entry, index) => index === 0 || retained[index - 1]!.at <= entry.at)
      if (this.count === 0) this.head = 0
    }
    this.lastNow = now
  }

  private toArray(): RateSample[] {
    const result: RateSample[] = []
    for (let index = 0; index < this.count; index += 1) {
      const entry = this.entries[(this.head + index) % this.entries.length]
      if (entry) result.push(entry)
    }
    return result
  }

  private rebuild(values: RateSample[]): void {
    const capacity = Math.max(this.entries.length, values.length, 1)
    this.entries = new Array(capacity)
    this.head = 0
    this.count = values.length
    values.forEach((entry, index) => { this.entries[index] = entry })
  }

  private ensureCapacity(required: number): void {
    if (required <= this.entries.length) return
    const values = this.toArray()
    const capacity = Math.max(required, this.entries.length * 2)
    this.entries = new Array(capacity)
    this.head = 0
    this.count = values.length
    values.forEach((entry, index) => { this.entries[index] = entry })
  }
}
