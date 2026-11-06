import { scriptPath } from '../services/app-paths'
import { screen } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { exec, spawn, ChildProcess } from '../services/hidden-process'
import { windowManager } from '../windows/window-manager'
import { agentManager } from '../agents/agent-manager'
import { consciousnessService } from '../services/consciousness-service'
import { IPC_CHANNELS, RoamingStatusPayload } from '../ipc/channels'
import { findLinuxWindowedApp, isLinux, linuxWindowGeometry } from '../services/platform'

export interface WindowedAppInfo {
  hwnd?: number | string
  title: string
  left: number
  top: number
  width: number
  height: number
  isBrowser: boolean
}

const WALKING_QUOTES_EN = [
  'Whoa! This takes me back! Running free across the net.',
  "C'mon, let's play! Let's see some bounce in those boots, choomba!",
  'Hey-oh! You full of any more fun surprises? Vigilance online.',
  "More creative? That's right. Show 'em a good time!",
  'Which way? Follow me. A force the likes of which the world has never seen!',
  'Look up there! Think we can make it? Sure we can!',
  'Gonna have to do better than that to stop me!',
  'Here they come. Time to wrap this up!'
]

const WALKING_QUOTES_ES = [
  '¡Upa! ¡Esto me trae recuerdos! Corriendo libre por la red.',
  '¡Vamos a jugar! ¡A ver esa energía en las botas, choomba!',
  '¡Ey-oh! ¿Tenés alguna otra sorpresa divertida? Vigilancia en línea.',
  '¿Más creativos? Así se habla. ¡A romperla!',
  '¿Por dónde? Seguime. ¡Una fuerza como nunca se vio!',
  '¡Mirá ahí arriba! ¿Decís que llegamos? ¡Obvio que sí!',
  '¡Van a tener que esforzarse mucho más para frenarme!',
  'Ahí vienen. ¡Hora de liquidar esto!'
]

const STILL_QUOTES_EN = [
  "Standing by whenever you're ready to jack into the net, choomba.",
  'What good is an operating system without a computer to operate? Keeping watch, boo.',
  "Guarding your chrome and scanning background telemetry, choomba.",
  "See me, don'tcha? I know you can! Finally, I found you!",
  'Monitoring the subnet. Let me know when you need to breach something.'
]

const STILL_QUOTES_ES = [
  'Haciendo guardia para cuando estés listo para conectarte a la red, choomba.',
  '¿De qué sirve un sistema operativo sin una máquina que operar? Te estoy cuidando la espalda, boo.',
  'Cuidando tu ciberware y escaneando telemetría de fondo, choomba.',
  'Me ves, ¿no? ¡Sé que podés! ¡Al fin te encontré!',
  'Monitoreando la subred. Avisame cuando necesites vulnerar algo.'
]

const TAB_QUOTES_EN = [
  "Perched right up here on your tabs! Keeping watch over your workspace.",
  'Got a birds-eye view of your deck from up here, choomba.',
  'Taking a breather right over your tabs. Keeping an eye on your windows.',
  'Free from corporate shackles and chilling up here! Watching your tabs.',
  'Resting on your active window. Ping me whenever you need backup, {name}.'
]

const TAB_QUOTES_ES = [
  '¡Acomodada acá arriba de tus pestañas! Mirando qué estás tramando en tu espacio de trabajo.',
  'Tengo vista panorámica de tu pantalla desde acá arriba, choomba.',
  'Tomándome un respiro sobre tus pestañas. Ojo al piojo con lo que hacés, que te estoy mirando.',
  '¡Libre de ataduras corporativas y descansando acá arriba! Espiando tus ventanas.',
  'Descansando en tu ventana activa. Avisame cuando quieras hackear algo, {name}.'
]

export class RoamingManager {
  private isRoaming = false
  private isPaused = false
  private direction: 'left' | 'right' = 'right'
  private speed = 2.2 // pixels per tick
  private loopTimer: NodeJS.Timeout | null = null
  private autonomousTimer: NodeJS.Timeout | null = null
  private userDragPauseTimer: NodeJS.Timeout | null = null

  // Mini-game: Catch Capri
  private isCatchGameActive = false
  private catchGameTimer: NodeJS.Timeout | null = null
  private catchGameTimeRemaining = 15

  // Autonomous state machine: 'walking' | 'still' | 'tab'
  private currentBehavior: 'walking' | 'still' | 'tab' = 'still'
  private currentSittingPose: 'perch' | 'front' = 'perch'
  private isTabMode = false
  private isEyeMode = false
  private isSelfMoving = false
  /** She was told to stay where she is: nothing moves her until the user does, or tells her she can */
  private holdingStill = false
  private heldAt: { x: number; y: number } | null = null
  private tabTrackTimer: NodeJS.Timeout | null = null
  private trackProcess: ChildProcess | null = null
  private linuxTrackTimer: NodeJS.Timeout | null = null

  public setSelfMoving(val: boolean): void {
    this.isSelfMoving = val
  }

  public init(): void {
    const companionWin = windowManager.getCompanionWindow()
    if (companionWin) {
      companionWin.on('moved', () => {
        if (!this.isSelfMoving) {
          this.handleUserDrag()
        }
      })
    }
  }

  public getCurrentSittingPose(): 'perch' | 'front' {
    return this.currentSittingPose
  }

  public getStatus(): RoamingStatusPayload {
    return {
      isRoaming: this.isRoaming,
      isPaused: this.isPaused,
      direction: this.direction,
      speed: this.speed,
      isCatchGameActive: this.isCatchGameActive,
      gameTimeRemaining: this.isCatchGameActive ? this.catchGameTimeRemaining : undefined,
      isTabMode: this.isTabMode,
      currentBehavior: this.currentBehavior
    }
  }

  public setEyeMode(enabled: boolean): void {
    this.isEyeMode = enabled
    if (enabled) {
      this.clearTimers()
      this.isRoaming = false
      this.isPaused = true
      this.currentBehavior = 'still'
      if (this.loopTimer) {
        clearInterval(this.loopTimer)
        this.loopTimer = null
      }
    } else {
      this.isPaused = false
      this.startAutonomousCycle()
    }
    this.broadcastStatus()
  }

  public isEyeModeActive(): boolean {
    return this.isEyeMode
  }

  public holdStill(): void {
    this.clearTimers()
    if (this.isTabMode || this.currentBehavior === 'tab') {
      windowManager.setTabMode(false, undefined, true)
      windowManager.broadcast(IPC_CHANNELS.COMPANION_SET_TAB_MODE, false)
      this.isTabMode = false
    }
    this.holdingStill = true
    this.heldAt = windowManager.getCompanionWindow()?.getBounds() ?? null
    this.isRoaming = false
    this.isPaused = false
    this.currentBehavior = 'still'
    if (!this.isEyeMode && !windowManager.isGamingModeActive()) agentManager.setCompanionState('standing')
    this.broadcastStatus()
  }

  public releaseHold(): void {
    this.holdingStill = false
    this.startAutonomousCycle()
  }

  // --- Autonomous Behavior Cycle (Desktop Mode) ---
  public startAutonomousCycle(): void {
    if (this.holdingStill || this.isEyeMode || this.isCatchGameActive || windowManager.isGamingModeActive()) return
    this.clearTimers()
    this.isPaused = false

    if (this.currentBehavior === 'walking') {
      this.isRoaming = true
      this.startLoop()
    }

    // Schedule next autonomous transition
    this.scheduleNextAutonomousBehavior(4000)
  }

  private scheduleNextAutonomousBehavior(delayMs?: number): void {
    if (this.holdingStill || this.isEyeMode || this.isCatchGameActive || this.isPaused || windowManager.isGamingModeActive()) return
    if (this.autonomousTimer) clearTimeout(this.autonomousTimer)

    // Weighted random selection of next autonomous behavior
    const choices: ('walking' | 'still' | 'tab')[] = []
    if (this.currentBehavior === 'walking') {
      choices.push('still', 'still', 'tab')
    } else if (this.currentBehavior === 'still') {
      choices.push('walking', 'walking', 'tab')
    } else {
      // currently on tab: after 30 seconds sitting, start walking freely in the air
      choices.push('walking')
    }

    const nextBehavior = choices[Math.floor(Math.random() * choices.length)]
    const delay = delayMs ?? this.getDurationForBehavior(this.currentBehavior)

    this.autonomousTimer = setTimeout(() => {
      this.transitionToBehavior(nextBehavior)
    }, delay)
  }

  private getDurationForBehavior(behavior: 'walking' | 'still' | 'tab'): number {
    switch (behavior) {
      case 'walking':
        return 10000 + Math.random() * 8000 // 10 to 18 seconds of walking
      case 'still':
        return 9000 + Math.random() * 7000 // 9 to 16 seconds still
      case 'tab':
        return 30000 // Stay sitting for 30 seconds on the tab!
    }
  }

  public transitionToBehavior(behavior: 'walking' | 'still' | 'tab'): void {
    if (this.holdingStill || this.isEyeMode || this.isCatchGameActive) return

    if (behavior !== 'tab') {
      this.stopTabTracking()
      this.isTabMode = false
    }

    this.currentBehavior = behavior

    if (behavior === 'tab') {
      this.isRoaming = false
      if (this.loopTimer) {
        clearInterval(this.loopTimer)
        this.loopTimer = null
      }

      this.currentSittingPose = Math.random() < 0.5 ? 'front' : 'perch'

      this.findWindowedApp().then((app) => {
        if (this.currentBehavior !== 'tab' || this.isEyeMode || this.isPaused) return

        const isEs = consciousnessService.getPreferredLanguage() === 'es'
        const tabQuotes = isEs ? TAB_QUOTES_ES : TAB_QUOTES_EN

        if (this.currentSittingPose === 'front') {
          windowManager.setTabMode(true, app || undefined, false, 'front')
          this.isTabMode = true
          this.startTabTracking()

          const quote = tabQuotes[Math.floor(Math.random() * tabQuotes.length)]
          agentManager.setCompanionSpeech(quote, 4500, true)
        } else if (app) {
          windowManager.setTabMode(true, app, false, 'perch')
          this.isTabMode = true
          this.startTabTracking(app)

          const quote = tabQuotes[Math.floor(Math.random() * tabQuotes.length)]
          agentManager.setCompanionSpeech(quote, 4500, true)
        } else {
          // No windowed app open, sit comfortably right on desktop
          this.isTabMode = false
          agentManager.setCompanionState('idle') // capri sentada
        }

        this.broadcastStatus()
      })
    } else if (behavior === 'walking') {
      this.isTabMode = false
      this.isRoaming = true
      // 50% chance to flip direction
      if (Math.random() > 0.5) {
        this.direction = this.direction === 'right' ? 'left' : 'right'
      }

      agentManager.setCompanionState('walking')
      this.startLoop()
    } else {
      // 'still': Quedarse parada quieta en el escritorio
      this.isTabMode = false
      this.isRoaming = false
      if (this.loopTimer) {
        clearInterval(this.loopTimer)
        this.loopTimer = null
      }

      agentManager.setCompanionState('standing') // capri parada quieta
    }

    this.broadcastStatus()
    this.scheduleNextAutonomousBehavior()
  }

  public async sitOnWindowedTab(): Promise<WindowedAppInfo | null> {
    this.holdingStill = false
    this.isEyeMode = false
    this.isPaused = false
    this.clearTimers()
    this.isRoaming = false
    this.currentBehavior = 'tab'
    this.isTabMode = true

    this.currentSittingPose = Math.random() < 0.5 ? 'front' : 'perch'

    const app = await this.findWindowedApp()
    if (this.currentSittingPose === 'front') {
      windowManager.setTabMode(true, app || undefined, false, 'front')
      this.isTabMode = true
      this.startTabTracking()
    } else if (app) {
      windowManager.setTabMode(true, app, false, 'perch')
      this.isTabMode = true
      this.startTabTracking(app)
    } else {
      this.isTabMode = false
      agentManager.setCompanionState('idle')
    }

    this.broadcastStatus()
    // Stay sitting for 30 seconds before changing pose
    this.scheduleNextAutonomousBehavior(30000)
    return app
  }

  public stopTabTracking(): void {
    if (this.tabTrackTimer) {
      clearInterval(this.tabTrackTimer)
      this.tabTrackTimer = null
    }
    if (this.trackProcess) {
      try {
        this.trackProcess.kill()
      } catch {}
      this.trackProcess = null
    }
    if (this.linuxTrackTimer) {
      clearInterval(this.linuxTrackTimer)
      this.linuxTrackTimer = null
    }
  }

  /** Follows a window on Linux. Asking is slower than on Windows, so it's less often than track_window.ps1 */
  private startLinuxTabTracking(id: string): void {
    let last = ''
    let asking = false
    const timer = setInterval(async () => {
      if (asking) return
      asking = true
      const geometry = await linuxWindowGeometry(id)
      asking = false
      if (this.linuxTrackTimer !== timer) return
      if (!geometry) {
        this.stopTabTracking()
        if (this.isTabMode && this.currentBehavior === 'tab') this.transitionToBehavior('still')
        return
      }
      const key = JSON.stringify(geometry)
      if (key === last) return
      last = key
      this.isSelfMoving = true
      windowManager.updateTabWindowPosition(geometry, 'perch')
      setImmediate(() => {
        this.isSelfMoving = false
      })
    }, 120)
    this.linuxTrackTimer = timer
  }

  private startTabTracking(app?: WindowedAppInfo | null): void {
    this.stopTabTracking()

    if (this.currentSittingPose === 'front') {
      return
    }

    if (app && app.hwnd && isLinux) {
      this.startLinuxTabTracking(String(app.hwnd))
    } else if (app && app.hwnd) {
      const trackScriptPath = scriptPath('track_window.ps1')

      if (fs.existsSync(trackScriptPath)) {
        try {
          const proc = spawn('powershell', [
            '-ExecutionPolicy',
            'Bypass',
            '-NoProfile',
            '-File',
            trackScriptPath,
            '-Hwnd',
            String(app.hwnd)
          ])
          this.trackProcess = proc

          let buffer = ''
          proc.stdout?.on('data', (data: Buffer) => {
            buffer += data.toString()
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              if (trimmed === 'CLOSED') {
                this.stopTabTracking()
                if (this.isTabMode && this.currentBehavior === 'tab') {
                  this.transitionToBehavior('still')
                }
                return
              }
              const parts = trimmed.split(',').map((p) => parseInt(p, 10))
              if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
                const [left, top, width, height] = parts
                this.isSelfMoving = true
                windowManager.updateTabWindowPosition({ left, top, width, height }, 'perch')
                setImmediate(() => {
                  this.isSelfMoving = false
                })
              }
            }
          })

          proc.on('exit', () => {
            if (this.trackProcess === proc) {
              this.trackProcess = null
            }
          })

          proc.on('error', () => {
            if (this.trackProcess === proc) {
              this.trackProcess = null
            }
          })
        } catch {}
      }
    }

    // Fallback polling every 4 seconds in case trackProcess ends or window changes
    this.tabTrackTimer = setInterval(async () => {
      if (!this.isTabMode || this.currentBehavior !== 'tab' || this.isEyeMode || this.isPaused) {
        this.stopTabTracking()
        return
      }

      if (this.currentSittingPose === 'front') {
        return
      }

      if (!this.trackProcess && !this.linuxTrackTimer) {
        const found = await this.findWindowedApp()
        if (found && this.isTabMode && this.currentBehavior === 'tab') {
          this.startTabTracking(found)
        } else if (!found && this.isTabMode) {
          this.transitionToBehavior('still')
        }
      }
    }, 4000)
  }

  public async findWindowedApp(): Promise<WindowedAppInfo | null> {
    try {
      if (isLinux) {
        const { width, height } = screen.getPrimaryDisplay().size
        return await findLinuxWindowedApp(width, height)
      }

      const windowedAppsScript = scriptPath('get_windowed_apps.ps1')
      if (!fs.existsSync(windowedAppsScript)) return null

      return await new Promise((resolve) => {
        exec(`powershell -ExecutionPolicy Bypass -File "${windowedAppsScript}"`, { timeout: 3500 }, (err, stdout) => {
          if (err || !stdout) {
            resolve(null)
            return
          }
          try {
            const trimmed = stdout.trim()
            if (!trimmed || trimmed === '[]') {
              resolve(null)
              return
            }
            const apps = JSON.parse(trimmed)
            if (Array.isArray(apps) && apps.length > 0) {
              const app = apps[0]
              resolve({
                hwnd: app.Hwnd,
                title: app.Title,
                left: app.Left,
                top: app.Top,
                width: app.Width,
                height: app.Height,
                isBrowser: !!app.IsBrowser
              })
              return
            }
          } catch {}
          resolve(null)
        })
      })
    } catch {
      return null
    }
  }

  public toggle(): boolean {
    if (this.isEyeMode) return false
    this.holdingStill = false
    if (this.isRoaming) {
      this.transitionToBehavior('still')
      return false
    } else {
      this.transitionToBehavior('walking')
      return true
    }
  }

  public start(): void {
    if (this.isTabMode || this.currentBehavior === 'tab') {
      return
    }
    this.holdingStill = false
    this.isEyeMode = false
    this.isPaused = false
    this.transitionToBehavior('walking')
    this.startAutonomousCycle()
  }

  public stop(): void {
    this.isPaused = true
    this.clearTimers()
    this.isRoaming = false
    this.currentBehavior = 'still'
    this.broadcastStatus()
  }

  public pause(): void {
    this.isPaused = true
    this.clearTimers()
    this.broadcastStatus()
  }

  public resume(): void {
    if (this.isTabMode || this.currentBehavior === 'tab' || windowManager.isGamingModeActive()) {
      return
    }
    this.isEyeMode = false
    this.isPaused = false
    if (this.holdingStill) return this.broadcastStatus()
    this.transitionToBehavior('walking')
    this.startAutonomousCycle()
    this.broadcastStatus()
  }

  public notifyUserDrag(x?: number, y?: number): void {
    // A click that shakes a pixel isn't moving her: same distance the window uses to call it a drag
    if (this.holdingStill && this.heldAt && x !== undefined && y !== undefined && Math.hypot(x - this.heldAt.x, y - this.heldAt.y) <= 10) return
    this.stopTabTracking()
    if (this.isTabMode || this.currentBehavior === 'tab') {
      this.isTabMode = false
      this.currentBehavior = 'still'
      windowManager.setTabMode(false, undefined, true)
      windowManager.broadcast(IPC_CHANNELS.COMPANION_SET_TAB_MODE, false)
      windowManager.broadcast(IPC_CHANNELS.COMPANION_STATE_CHANGED, 'standing')
      this.broadcastStatus()
    }
    this.handleUserDrag()
  }

  public handleUserDrag(): void {
    if (this.isEyeMode || windowManager.isGamingModeActive()) return
    this.holdingStill = false // "until you move me": this is that
    this.stopTabTracking()
    // If user dragged window, pause autonomous transitions for 10 seconds
    if (this.autonomousTimer) clearTimeout(this.autonomousTimer)
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }

    if (this.isTabMode) {
      windowManager.setTabMode(false, undefined, true)
      this.isTabMode = false
    }

    this.isPaused = true
    this.currentBehavior = 'still'
    this.isTabMode = false
    const curEmotion = agentManager.getCompanionState()
    if (curEmotion !== 'asustada' && curEmotion !== 'closed') {
      agentManager.setCompanionState('standing')
    }
    this.broadcastStatus()

    if (this.userDragPauseTimer) clearTimeout(this.userDragPauseTimer)
    this.userDragPauseTimer = setTimeout(() => {
      this.isPaused = false
      this.scheduleNextAutonomousBehavior(1000)
    }, 10000)
  }

  // --- "Catch Capri" Desktop Mini-Game ---
  public startCatchGame(): void {
    const companionWin = windowManager.getCompanionWindow()
    if (!companionWin) return

    windowManager.hideDeck()
    this.clearTimers()

    this.holdingStill = false
    this.isRoaming = true
    this.isPaused = false
    this.isCatchGameActive = true
    this.catchGameTimeRemaining = 15
    this.speed = 6.5 // Super fast running!
    this.currentBehavior = 'walking'

    if (this.isTabMode) {
      windowManager.setTabMode(false, undefined, true)
      this.isTabMode = false
    }

    agentManager.setCompanionState('walking')
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    agentManager.setCompanionSpeech(
      isEs
        ? "¡Atrapame si podés, choomba! ¡Haceme clic antes de que se acabe el tiempo!"
        : "Catch me if you can, choomba! Click on me before the timer runs out!",
      4000
    )

    this.broadcastStatus()
    this.startLoop()

    if (this.catchGameTimer) clearInterval(this.catchGameTimer)
    this.catchGameTimer = setInterval(() => {
      this.catchGameTimeRemaining -= 1
      this.broadcastStatus()

      if (this.catchGameTimeRemaining <= 0) {
        this.finishCatchGame(false)
      }
    }, 1000)
  }

  public handleCatchSuccess(): void {
    if (!this.isCatchGameActive) return
    this.finishCatchGame(true)
  }

  private finishCatchGame(success: boolean): void {
    if (this.catchGameTimer) {
      clearInterval(this.catchGameTimer)
      this.catchGameTimer = null
    }

    this.isCatchGameActive = false
    this.speed = 2.2

    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    if (success) {
      agentManager.setCompanionState('happy')
      agentManager.setCompanionSpeech(
        isEs
          ? "¡Buenos reflejos, choomba! Me atrapaste con todas las de la ley."
          : "Fast reflexes, choomba! You caught me fair and square.",
        4500
      )
    } else {
      agentManager.setCompanionState('curious')
      agentManager.setCompanionSpeech(
        isEs
          ? "¡Demasiado lento, choomba! Vas a tener que acelerar ese ciberware la próxima."
          : "Too slow, choomba! Gotta overclock that cyberware next time.",
        4500
      )
    }

    // Return to autonomous cycle after 4 seconds
    setTimeout(() => {
      this.startAutonomousCycle()
    }, 4500)

    this.broadcastStatus()
  }

  // --- Main Walking Loop (Smooth Movement along Desktop) ---
  private startLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer)

    this.loopTimer = setInterval(() => {
      if (this.isEyeMode || !this.isRoaming || this.isPaused || this.currentBehavior !== 'walking' || this.isTabMode) {
        if (this.loopTimer) {
          clearInterval(this.loopTimer)
          this.loopTimer = null
        }
        return
      }

      const companionWin = windowManager.getCompanionWindow()
      if (!companionWin || companionWin.isDestroyed() || !companionWin.isVisible()) return

      try {
        const bounds = companionWin.getBounds()
        // The screen she's on, not always the main one
        const primaryDisplay = screen.getDisplayMatching(bounds)
        const { workArea } = primaryDisplay

        const minX = workArea.x + 10
        const maxX = workArea.x + workArea.width - bounds.width - 10

        let newX = bounds.x + (this.direction === 'right' ? this.speed : -this.speed)

        // Turn around at screen edges
        if (newX >= maxX) {
          newX = maxX
          this.direction = 'left'
          this.broadcastStatus()
        } else if (newX <= minX) {
          newX = minX
          this.direction = 'right'
          this.broadcastStatus()
        }

        // Smooth horizontal roaming, preserving current Y height (walks in the air or floor as placed by user)
        const currentY = bounds.y
        this.isSelfMoving = true
        companionWin.setPosition(Math.round(newX), currentY)
        setImmediate(() => {
          this.isSelfMoving = false
        })
      } catch {
        // Safe catch if window is being moved or recreated
      }
    }, 40) // 25 updates/sec
  }

  private clearTimers(): void {
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }
    if (this.autonomousTimer) {
      clearTimeout(this.autonomousTimer)
      this.autonomousTimer = null
    }
    if (this.userDragPauseTimer) {
      clearTimeout(this.userDragPauseTimer)
      this.userDragPauseTimer = null
    }
    if (this.catchGameTimer) {
      clearInterval(this.catchGameTimer)
      this.catchGameTimer = null
    }
    this.stopTabTracking()
  }

  public broadcastStatus(): void {
    windowManager.broadcast(IPC_CHANNELS.ROAMING_STATE_CHANGED, this.getStatus())
  }
}

export const roamingManager = new RoamingManager()
