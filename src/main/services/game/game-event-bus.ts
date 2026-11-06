import { isMac } from '../platform'
import { EventEmitter } from 'events'
import { GameAdapter, GameEvent } from './types'
import { reactionEngine } from './reaction-engine'
import { mockGameAdapter } from './adapters/mock-game-adapter'
import { lolLiveAdapter } from './adapters/lol'
import { cyberpunkAdapter } from './adapters/cyberpunk'

export class GameEventBus extends EventEmitter {
  private static instance: GameEventBus
  private adapters: Map<string, GameAdapter> = new Map()
  private pollTimer: NodeJS.Timeout | null = null
  private running = false

  public static getInstance(): GameEventBus {
    if (!GameEventBus.instance) {
      GameEventBus.instance = new GameEventBus()
    }
    return GameEventBus.instance
  }

  constructor() {
    super()
    // Auto-register the default adapters
    this.registerAdapter(mockGameAdapter)
    this.registerAdapter(lolLiveAdapter)
    this.registerAdapter(cyberpunkAdapter)
  }

  public registerAdapter(adapter: GameAdapter): void {
    if (this.adapters.has(adapter.id)) {
      console.log(`[GameEventBus] Adapter already registered: ${adapter.id}`)
      return
    }

    this.adapters.set(adapter.id, adapter)

    // Forward events to the bus and to the reaction engine
    adapter.on('game_event', (event: GameEvent) => {
      this.emitEvent(event)
    })

    console.log(`[GameEventBus] Registered adapter: ${adapter.name} (${adapter.id})`)
  }

  public unregisterAdapter(id: string): boolean {
    const adapter = this.adapters.get(id)
    if (!adapter) return false

    if (adapter.isRunning()) {
      adapter.stop()
    }
    adapter.removeAllListeners('game_event')
    this.adapters.delete(id)
    console.log(`[GameEventBus] Unregistered adapter: ${id}`)
    return true
  }

  public getAdapter<T extends GameAdapter = GameAdapter>(id: string): T | undefined {
    return this.adapters.get(id) as T | undefined
  }

  public getAdapters(): GameAdapter[] {
    return Array.from(this.adapters.values())
  }

  /**
   * Broadcast an event to subscribers and forward it to the Reaction Engine
   */
  public emitEvent(event: GameEvent): void {
    this.emit('game_event', event)
    reactionEngine.handleGameEvent(event)
  }

  public start(): void {
    if (isMac || this.running) return
    this.running = true
    console.log('[GameEventBus] Starting Game Event Bus...')

    // Auto-detection loop every 7 seconds
    this.pollTimer = setInterval(async () => {
      await this.checkAdapters()
    }, 7000)

    // Initial check
    setTimeout(() => this.checkAdapters(), 2000)
  }

  public stop(): void {
    if (!this.running) return
    this.running = false

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.isRunning()) {
        try {
          adapter.stop()
        } catch (err: any) {
          console.warn(`[GameEventBus] Error stopping adapter ${adapter.id}:`, err.message)
        }
      }
    }

    console.log('[GameEventBus] Stopped Game Event Bus.')
  }

  public isRunning(): boolean {
    return this.running
  }

  private async checkAdapters(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      // Don't auto-stop or auto-start the mock adapter; it is user/test controlled
      if (adapter.id === 'mock') continue

      try {
        const detected = await adapter.detect()
        if (detected && !adapter.isRunning()) {
          console.log(`[GameEventBus] Detected active game for adapter: ${adapter.name}. Starting...`)
          await adapter.start()
        } else if (!detected && adapter.isRunning()) {
          console.log(`[GameEventBus] Game closed for adapter: ${adapter.name}. Stopping...`)
          await adapter.stop()
        }
      } catch (err: any) {
        console.warn(`[GameEventBus] Detection error for ${adapter.id}:`, err.message)
      }
    }
  }
}

export const gameEventBus = GameEventBus.getInstance()
