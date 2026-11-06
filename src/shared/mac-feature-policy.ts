export function commentMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 120) throw new Error('Choose 0 (off) or a whole number from 1 to 120 minutes.')
  return value
}
/** A normal drag never triggers this: three substantial direction changes are needed. */
export class ShakeDetector {
  private lastX: number | null = null
  private direction = 0
  private anchor = 0
  private turns = 0
  private started = 0
  update(x: number, now: number): boolean {
    if (this.lastX === null || now - this.started > 1400) {
      this.lastX=x; this.anchor=x; this.direction=0; this.turns=0; this.started=now; return false
    }
    const delta=x-this.anchor
    this.lastX=x
    if (Math.abs(delta)<35) return false
    const direction=Math.sign(delta)
    if (this.direction && direction!==this.direction) this.turns++
    this.direction=direction; this.anchor=x
    return this.turns>=3
  }
}
