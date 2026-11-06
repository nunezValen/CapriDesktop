import * as os from 'os'
import { isMac, isLinux, linuxSteamAppsDirs, listProcessNames, windowsSteamAppsDirs } from '../../../platform'
import { assetPath } from '../../../app-paths'
/** Cyberpunk 2077 adapter: process detection, local telemetry server (port 2077) and CET mod event files. */

import { EventEmitter } from 'events'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { exec } from '../../../hidden-process'
import { app } from 'electron'
import { GameAdapter, GameEvent, GameEventPriority, GameEventType } from '../../types'
import { CyberpunkRawEvent, CyberpunkGig } from './types'
import { consciousnessService } from '../../../consciousness-service'
import { windowManager } from '../../../../windows/window-manager'

export class CyberpunkAdapter extends EventEmitter implements GameAdapter {
  private lastRecommendationTimedOut = false
  private static instance: CyberpunkAdapter

  public readonly id = 'cyberpunk'
  public readonly name = 'Cyberpunk 2077'

  private running = false
  private isGameRunning = false
  private pollInterval: NodeJS.Timeout | null = null
  private filePollInterval: NodeJS.Timeout | null = null
  private httpServer: http.Server | null = null
  private fileWatchers: fs.FSWatcher[] = []
  private lastTelemetryTimestamp = 0
  private lastProcessedSeq = 0
  private lastProcessedEventTime = 0
  private adapterStartTime = 0
  private processedSeqSet = new Set<string>()
  private fileOffsets: Map<string, number> = new Map()
  private telemetryPort = 2077

  public static getInstance(): CyberpunkAdapter {
    if (!CyberpunkAdapter.instance) {
      CyberpunkAdapter.instance = new CyberpunkAdapter()
    }
    return CyberpunkAdapter.instance
  }

  public isRunning(): boolean {
    return this.running
  }

  public isCyberpunkActive(): boolean {
    return this.isGameRunning || Date.now() - this.lastTelemetryTimestamp < 45000
  }

  /**
   * Candidate directories where Cyberpunk 2077 and Cyber Engine Tweaks mods may reside
   */
  public getCandidateTelemetryDirs(): string[] {
    const relative = path.join('Cyberpunk 2077', 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'capri')
    const dirs: string[] = windowsSteamAppsDirs().map((apps) => path.join(apps, 'common', relative))
    for (const root of ['C:\\GOG Games', 'D:\\GOG Games', 'C:\\Program Files (x86)\\GOG Galaxy\\Games', 'C:\\Program Files\\Epic Games', 'D:\\Epic Games']) {
      dirs.push(path.join(root, relative))
    }

    if (isLinux) {
      // Proton keeps the game in the normal Linux Steam library; the mod folder is the same as on Windows
      dirs.length = 0
      for (const apps of linuxSteamAppsDirs()) dirs.push(path.join(apps, 'common', relative))
      dirs.push(path.join(os.homedir(), 'Games', 'Heroic', relative), path.join(os.homedir(), 'GOG Games', relative))
    }

    try {
      if (app && app.getPath) {
        dirs.push(path.join(app.getPath('documents'), 'Capri'))
      }
    } catch {}

    dirs.push(assetPath('game_data', 'cyberpunk_mod'))
    return Array.from(new Set(dirs))
  }

  /**
   * Probes if Cyberpunk 2077 is currently running or actively transmitting telemetry
   */
  public async detect(): Promise<boolean> {
    if (isMac) return false
    if (Date.now() - this.lastTelemetryTimestamp < 45000) {
      return true
    }

    if (isLinux) {
      const names = await listProcessNames()
      return names ? names.has('cyberpunk2077.exe') : this.running
    }

    return new Promise((resolve) => {
      exec('tasklist /fi "imagename eq Cyberpunk2077.exe" /fo csv /nh', { timeout: 5000 }, (err, stdout) => {
        // A failed check (tasklist can time out on a loaded PC) says nothing about the game
        if (err) return resolve(this.running)
        const active = /cyberpunk2077\.exe/i.test(stdout || '')
        resolve(active)
      })
    })
  }

  /**
   * Starts the Cyberpunk telemetry server, process monitor, and file watcher
   */
  public async start(): Promise<void> {
    if (isMac) return
    if (this.running) return
    this.running = true
    this.isGameRunning = true
    this.adapterStartTime = Date.now()
    this.processedSeqSet.clear()
    this.lastProcessedSeq = 0
    this.lastProcessedEventTime = 0
    console.log('[CyberpunkAdapter] Starting Cyberpunk 2077 adapter...')

    // Bookmark existing telemetry.json seq & timestamp so old match events are never replayed
    const candidateDirs = this.getCandidateTelemetryDirs()
    for (const dir of candidateDirs) {
      const jsonPath = path.join(dir, 'telemetry.json')
      const legacyPath = path.join(dir, 'cyberpunk_telemetry.json')
      const target = fs.existsSync(jsonPath) ? jsonPath : fs.existsSync(legacyPath) ? legacyPath : null
      if (target) {
        try {
          const raw = fs.readFileSync(target, 'utf-8')
          const parsed = JSON.parse(raw) as CyberpunkRawEvent
          if (parsed) {
            const seq = (parsed as any).seq || 0
            let t = parsed.timestamp || 0
            if (t > 0 && t < 10000000000) t *= 1000
            if (seq > this.lastProcessedSeq) this.lastProcessedSeq = seq
            if (t > this.lastProcessedEventTime) this.lastProcessedEventTime = t
            // Also mark existing event key as already processed
            const key = `${parsed.event}_${seq}_${parsed.timestamp || 0}`
            this.processedSeqSet.add(key)
          }
        } catch {}
      }
    }

    // Start Telemetry HTTP Receiver
    this.startHttpServer()

    // Start Telemetry File Watcher and Poller
    this.startFileWatcher()

    // Auto-engage Gaming Mode (docked in corner, still, screen-saver topmost)
    try {
      windowManager.setGamingMode(true)
    } catch {}

    // Emit Night City entrance event
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    const entranceGreeting = isEs
      ? '¡Conectada a la red de Night City, choomba! Cuidado con las corporaciones y los ciberpsicópatas.'
      : 'Jacking into the Night City subnet, {name}! Watch out for corps and cyberpsychos.'

    this.emitGameEvent('match_started', 'high', {
      customPhrase: entranceGreeting
    })

    // Polling loop every 5 seconds to track process lifecycle
    this.pollInterval = setInterval(async () => {
      const stillActive = await this.detect()
      if (!stillActive && this.isGameRunning) {
        console.log('[CyberpunkAdapter] Cyberpunk 2077 closed or disconnected.')
        this.isGameRunning = false
        this.stop()
      } else if (stillActive) {
        this.isGameRunning = true
      }
    }, 5000)
  }

  /**
   * Stops the adapter and closes network/file listeners
   */
  public async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.isGameRunning = false

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    if (this.filePollInterval) {
      clearInterval(this.filePollInterval)
      this.filePollInterval = null
    }

    for (const watcher of this.fileWatchers) {
      try {
        watcher.close()
      } catch {}
    }
    this.fileWatchers = []

    if (this.httpServer) {
      try {
        this.httpServer.close()
      } catch {}
      this.httpServer = null
    }

    try {
      windowManager.setGamingMode(false)
    } catch {}

    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    const departurePhrase = isEs
      ? 'Desconectando del enlace de Night City. Buen descanso para el ciberware, choomba.'
      : 'Disconnecting from Night City net. Rest up your chrome, {name}.'

    this.emitGameEvent('match_ended', 'high', {
      customPhrase: departurePhrase
    })

    console.log('[CyberpunkAdapter] Stopped Cyberpunk 2077 adapter.')
  }

  /**
   * Ingests and processes raw telemetry events from CET mod, file, or simulation
   */
  public processRawEvent(raw: CyberpunkRawEvent): void {
    if (!raw || !raw.event) return

    // Strict deduplication with session timestamp so new matches/restarts are never dropped
    const eventKey = `${raw.event}_${raw.seq || 0}_${raw.timestamp || 0}`
    if (this.processedSeqSet.has(eventKey)) {
      return
    }
    this.processedSeqSet.add(eventKey)
    if (this.processedSeqSet.size > 250) {
      const first = this.processedSeqSet.values().next().value
      if (first) this.processedSeqSet.delete(first)
    }

    // Normalize timestamp to milliseconds if CET sent epoch seconds
    let eventTime = typeof raw.timestamp === 'number' ? raw.timestamp : 0
    if (eventTime > 0 && eventTime < 10000000000) {
      eventTime *= 1000
    }

    // Discard stale events from previous games/sessions (older than 15s or before adapter started)
    if (eventTime > 0) {
      const ageMs = Date.now() - eventTime
      if (ageMs > 15000 || (this.adapterStartTime > 0 && eventTime < this.adapterStartTime - 3000)) {
        console.log(`[CyberpunkAdapter] Discarding stale historical event "${raw.event}" (${Math.round(ageMs / 1000)}s old)`)
        return
      }
    }

    this.lastTelemetryTimestamp = Date.now()

    if (!this.running) {
      this.start().catch(() => {})
    }

    console.log(`[CyberpunkAdapter] Received telemetry event: "${raw.event}"`, raw)

    switch (raw.event) {
      case 'civilian_killed':
        this.emitGameEvent('civilian_killed', 'critical', {
          victim: raw.victim || 'civilian',
          ...raw
        })
        break

      case 'high_speed_driving':
        this.emitGameEvent('high_speed_driving', 'high', {
          speed: raw.speed || 120,
          ...raw
        })
        break

      case 'extreme_speed':
        this.emitGameEvent('extreme_speed', 'high', {
          speed: raw.speed || 160,
          ...raw
        })
        break

      case 'vehicle_crash':
        this.emitGameEvent('vehicle_crash', 'critical', {
          speed: raw.speed || 80,
          ...raw
        })
        break

      case 'sandevistan_activated':
        this.emitGameEvent('sandevistan_activated', 'high', raw)
        break

      case 'kerenzikov_activated':
        this.emitGameEvent('kerenzikov_activated', 'high', raw)
        break

      case 'synaptic_accelerator_activated':
        this.emitGameEvent('synaptic_accelerator_activated', 'high', raw)
        break

      case 'overclock_activated':
        this.emitGameEvent('overclock_activated', 'high', raw)
        break

      case 'berserk_activated':
        this.emitGameEvent('berserk_activated', 'high', raw)
        break

      case 'player_quickhack':
        this.emitGameEvent('player_quickhack', 'high', raw)
        break

      case 'player_being_hacked':
        this.emitGameEvent('player_being_hacked', 'critical', raw)
        break

      case 'poi_marked':
      case 'tarot_marked' as any:
        this.emitGameEvent('poi_marked', 'high', {
          name: raw.name || 'Punto de Interés',
          district: raw.district || 'Night City',
          distance: raw.distance ?? 0,
          category: raw.category || 'ripperdoc',
          ...raw
        })
        break

      case 'gig_marked':
        this.emitGameEvent('gig_marked', 'high', {
          name: raw.name || 'Gig',
          district: raw.district || 'Night City',
          fixer: raw.fixer || 'Fixer',
          description: raw.description || '',
          distance: raw.distance ?? 0,
          ...raw
        })
        break
      case 'combat_started':
        this.emitGameEvent('combat_started', 'normal', raw)
        break

      case 'combat_ended':
        this.emitGameEvent('combat_ended', 'normal', raw)
        break

      case 'player_kill':
        this.emitGameEvent('player_kill', 'high', {
          victim: raw.victim || 'hostil de Night City',
          ...raw
        })
        break

      case 'player_died':
        this.emitGameEvent('player_died', 'critical', {
          killer: raw.killer || 'hostil de Night City',
          ...raw
        })
        break

      case 'low_health':
        this.emitGameEvent('low_health', 'high', {
          healthPercent: raw.healthPercent || 20,
          ...raw
        })
        break

      case 'wanted_level': {
        const stars = raw.wantedStars || 1
        const priority: GameEventPriority = stars >= 4 ? 'critical' : 'high'
        this.emitGameEvent('wanted_level', priority, {
          wantedStars: stars,
          ...raw
        })
        break
      }

      case 'district_entered':
        this.emitGameEvent('district_entered', 'normal', {
          district: raw.district || 'Night City',
          ...raw
        })
        break

      case 'implant_changed':
        this.emitGameEvent('implant_changed', 'normal', {
          implant: raw.implant || 'Ciberware',
          ...raw
        })
        break

      case 'match_started':
        this.emitGameEvent('match_started', 'high', raw)
        break

      case 'match_ended':
        this.emitGameEvent('match_ended', 'high', raw)
        break

      case 'custom':
      default:
        this.emitGameEvent('custom', 'normal', raw)
        break
    }
  }

  /**
   * Send command to CET mod via commands.json
   */
  public async sendCommand(command: {
    action: string
    target?: string
    [key: string]: any
  }): Promise<boolean> {
    const payload = {
      id: Date.now(),
      timestamp: Date.now(),
      ...command
    }
    const jsonStr = JSON.stringify(payload)
    const candidateDirs = this.getCandidateTelemetryDirs()
    let written = false

    for (const dir of candidateDirs) {
      try {
        if (fs.existsSync(dir)) {
          const cmdPath = path.join(dir, 'commands.json')
          fs.writeFileSync(cmdPath, jsonStr, 'utf-8')
          written = true
        }
      } catch (err) {
        console.warn(`[CyberpunkAdapter] Failed writing command to ${dir}:`, err)
      }
    }

    if (written) {
      console.log(`[CyberpunkAdapter] Dispatched command to Cyberpunk CET:`, payload)
    } else {
      console.warn(`[CyberpunkAdapter] Could not find CET mod directory to write commands.json`)
    }
    return written
  }

  /**
   * Recommend and mark a Gig on Cyberpunk 2077 map
   */
  public async markGig(gig: CyberpunkGig): Promise<boolean> {
    return this.sendCommand({
      action: 'mark_gig',
      gig
    })
  }

  /** True when the mod didn't answer in time, so it may still mark a gig later */
  public didLastRecommendationTimeOut(): boolean {
    return this.lastRecommendationTimedOut
  }

  /**
   * Request CET mod to select and mark the next available uncompleted gig from in-game journal
   */
  public async recommendGig(
    district?: string,
    kind: 'gig' | 'mission' | 'main' | 'any' = 'gig',
    quiet = false
  ): Promise<CyberpunkGig | null> {
    return new Promise(async (resolve) => {
      let resolved = false
      this.lastRecommendationTimedOut = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.lastRecommendationTimedOut = true
          this.removeListener('game_event', onGigMarked)
          resolve(null)
        }
      }, 4000)

      const onGigMarked = (ev: GameEvent) => {
        if (ev.type === 'custom' && (ev.payload as any)?.event === 'gig_not_found') {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            this.removeListener('game_event', onGigMarked)
            resolve(null)
          }
          return
        }
        if (ev.type === 'gig_marked' && ev.payload) {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            this.removeListener('game_event', onGigMarked)
            resolve(ev.payload as CyberpunkGig)
          }
        }
      }

      this.on('game_event', onGigMarked)

      const sent = await this.sendCommand({
        action: kind === 'any' ? 'recommend_next' : 'recommend_gig',
        kind,
        district,
        quiet
      })

      if (!sent && !resolved) {
        resolved = true
        clearTimeout(timeout)
        this.removeListener('game_event', onGigMarked)
        resolve(null)
      }
    })
  }

  /**
   * Ask the CET mod to pin the closest known icon of a category and wait for its answer,
   * so Capri only says something is on the map when it really is.
   */
  public async markClosest(target: string): Promise<{ status: 'marked' | 'not_found' | 'no_answer' }> {
    return new Promise(async (resolve) => {
      const finish = (result: { status: 'marked' | 'not_found' | 'no_answer' }) => {
        clearTimeout(timeout)
        this.removeListener('game_event', onAnswer)
        resolve(result)
      }
      const timeout = setTimeout(() => finish({ status: 'no_answer' }), 4000)

      const onAnswer = (ev: GameEvent) => {
        const payload = ev.payload as any
        if (payload?.category !== target) return
        if (ev.type === 'poi_marked') finish({ status: 'marked' })
        else if (ev.type === 'custom' && payload.event === 'poi_not_found') finish({ status: 'not_found' })
      }
      this.on('game_event', onAnswer)

      const sent = await this.sendCommand({ action: 'mark_closest', target, quiet: true })
      if (!sent) finish({ status: 'no_answer' })
    })
  }

  /**
   * Trigger simulated Cyberpunk events for interactive testing and voice commands
   */
  public triggerSimulation(
    type: CyberpunkRawEvent['event'],
    extra: Partial<CyberpunkRawEvent> = {}
  ): void {
    const raw: CyberpunkRawEvent = {
      event: type,
      timestamp: Date.now(),
      ...extra
    }
    this.processRawEvent(raw)
  }

  private startHttpServer(): void {
    if (this.httpServer) return

    this.httpServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      const url = req.url || ''

      if (req.method === 'GET' && (url === '/' || url === '/status' || url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            status: 'online',
            adapter: 'cyberpunk',
            companion: 'Capri Netrunner',
            active: this.isGameRunning,
            timestamp: Date.now()
          })
        )
        return
      }

      if (req.method === 'POST' && (url === '/events' || url === '/telemetry' || url === '/')) {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as CyberpunkRawEvent
            if (parsed && parsed.event) {
              this.processRawEvent(parsed)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, processed: parsed.event }))
              return
            }
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
            return
          }
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing event field in payload' }))
        })
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    this.httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[CyberpunkAdapter] Port ${this.telemetryPort} in use, trying fallback ${this.telemetryPort + 1}`)
        this.telemetryPort++
        this.httpServer?.listen(this.telemetryPort, '127.0.0.1')
      } else {
        console.error('[CyberpunkAdapter] HTTP server error:', err.message)
      }
    })

    this.httpServer.listen(this.telemetryPort, '127.0.0.1', () => {
      console.log(`[CyberpunkAdapter] Telemetry HTTP server listening on http://127.0.0.1:${this.telemetryPort}/events`)
    })
  }

  /**
   * Puts Capri's mod in every copy of the game that has Cyber Engine Tweaks, and keeps it up to date.
   * It runs when she starts, because the game only loads its mods when it opens.
   */
  public installCetMod(): void {
    if (isMac) return
    try {
      const source = assetPath('game_data', 'cyberpunk_mod', 'init.lua')
      if (!fs.existsSync(source)) return
      const content = fs.readFileSync(source, 'utf-8')

      for (const dir of this.getCandidateTelemetryDirs()) {
        if (path.basename(dir) !== 'capri' || path.basename(path.dirname(dir)) !== 'mods') continue
        // No Cyber Engine Tweaks in this copy: creating folders in the game wouldn't do anything
        if (!fs.existsSync(path.dirname(path.dirname(dir)))) continue
        const target = path.join(dir, 'init.lua')
        try {
          if (fs.existsSync(target) && fs.readFileSync(target, 'utf-8') === content) continue
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(target, content, 'utf-8')
          console.log(`[CyberpunkAdapter] Mod installed: ${target}`)
        } catch (e: any) {
          console.warn(`[CyberpunkAdapter] Could not install the mod in ${dir}:`, e.message)
        }
      }
    } catch {}
  }

  private startFileWatcher(): void {
    const candidateDirs = this.getCandidateTelemetryDirs()

    // Check & watch existing directories and bookmark existing file offsets
    for (const dir of candidateDirs) {
      if (fs.existsSync(dir)) {
        const jsonlPath = path.join(dir, 'events.jsonl')
        if (fs.existsSync(jsonlPath)) {
          try {
            const stat = fs.statSync(jsonlPath)
            this.fileOffsets.set(jsonlPath, stat.size)
          } catch {}
        }
        try {
          const watcher = fs.watch(dir, () => {
            this.checkTelemetryFiles()
          })
          this.fileWatchers.push(watcher)
          console.log(`[CyberpunkAdapter] Watching CET mod folder: ${dir}`)
        } catch {}
      }
    }

    // High-frequency poller (every 300ms) to ensure zero lost events
    this.filePollInterval = setInterval(() => {
      this.checkTelemetryFiles()
    }, 300)
  }

  private checkTelemetryFiles(): void {
    const candidateDirs = this.getCandidateTelemetryDirs()

    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue

      // Process events.jsonl queue (reliable line-delimited stream)
      const jsonlPath = path.join(dir, 'events.jsonl')
      if (fs.existsSync(jsonlPath)) {
        try {
          const stat = fs.statSync(jsonlPath)
          let lastOffset = this.fileOffsets.get(jsonlPath) || 0
          if (stat.size < lastOffset) {
            lastOffset = 0
            this.fileOffsets.set(jsonlPath, 0)
          }

          if (stat.size > lastOffset) {
            const fd = fs.openSync(jsonlPath, 'r')
            const lengthToRead = stat.size - lastOffset
            const buffer = Buffer.alloc(lengthToRead)
            fs.readSync(fd, buffer, 0, lengthToRead, lastOffset)
            fs.closeSync(fd)

            this.fileOffsets.set(jsonlPath, stat.size)

            const lines = buffer.toString('utf-8').split('\n')
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              try {
                const parsed = JSON.parse(trimmed) as CyberpunkRawEvent
                if (parsed && parsed.event) {
                  this.processRawEvent(parsed)
                }
              } catch {}
            }
          }
        } catch {}
      }

      // Process telemetry.json snapshot
      const jsonPath = path.join(dir, 'telemetry.json')
      const legacyPath = path.join(dir, 'cyberpunk_telemetry.json')
      const targetJson = fs.existsSync(jsonPath) ? jsonPath : fs.existsSync(legacyPath) ? legacyPath : null

      if (targetJson) {
        try {
          const raw = fs.readFileSync(targetJson, 'utf-8')
          const parsed = JSON.parse(raw) as CyberpunkRawEvent
          if (parsed && parsed.event) {
            const seq = (parsed as any).seq || 0
            const t = parsed.timestamp || 0

            const isNew = seq > this.lastProcessedSeq || t > this.lastProcessedEventTime
            if (isNew) {
              this.lastProcessedSeq = seq
              this.lastProcessedEventTime = t
              this.processRawEvent(parsed)
            }
          }
        } catch {}
      }
    }
  }

  private emitGameEvent(type: GameEventType, priority: GameEventPriority, payload: any = {}): void {
    const gameEvent: GameEvent = {
      id: `cyberpunk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      gameId: 'cyberpunk',
      type,
      priority,
      payload,
      timestamp: Date.now()
    }

    this.emit('game_event', gameEvent)
  }
}

export const cyberpunkAdapter = CyberpunkAdapter.getInstance()
