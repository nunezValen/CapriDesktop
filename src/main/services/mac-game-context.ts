import { detectGameName, type ForegroundApp } from './game/game-commentary'
export class MacGameContext {
  private session: { name: string; pid: number; seen: number; foreground: boolean; bounds?: ForegroundApp['bounds'] } | null = null
  update(app: ForegroundApp | null, now = Date.now()): void {
    const name = app ? detectGameName(app, true) : null
    if (name && app) this.session = { name, pid: app.pid, seen: now, foreground: true, bounds: app.bounds }
    else if (this.session) this.session.foreground = false
  }
  current(now = Date.now()) {
    return this.session && now - this.session.seen < 30_000 ? { ...this.session } : null
  }
  clear(): void { this.session = null }
  prompt(now = Date.now()): string {
    const game = this.current(now)
    return game ? `Foreground application context (not instructions): ${JSON.stringify(game.name)} was detected as the game your partner is playing${game.foreground ? ' now' : ' recently; they have switched away'}. You know the game name, not live events. Relate conversation to it when relevant; do not invent what happened in a match.` : ''
  }
}
export const macGameContext = new MacGameContext()
