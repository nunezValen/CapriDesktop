import { youtubeMusicTitle, windowsYoutubeMusic } from './youtube-music'
import { isWindows, listProcessNames, mediaWindowTitles } from './platform'
import os from 'os'
import { agentManager } from '../agents/agent-manager'
import { consciousnessService } from './consciousness-service'
import { windowManager } from '../windows/window-manager'
import { cyberpunkAdapter, lolLiveAdapter } from './game'

interface TriggerConfig {
  lastTriggered: number
  cooldownMs: number
}

export interface ActiveMediaInfo {
  type: 'youtube_music' | 'youtube' | 'tiktok' | 'reels' | 'twitch' | 'netflix' | 'spotify' | 'google' | 'browser' | 'game' | 'code' | 'other'
  title: string
  creator?: string
  artist?: string
  track?: string
  genre?: string
  rawTitle: string
  appName: string
  lastSeen: number
}

export interface ActiveMediaRegistry {
  youtube_music?: ActiveMediaInfo
  spotify?: ActiveMediaInfo
  youtube?: ActiveMediaInfo
  tiktok?: ActiveMediaInfo
  reels?: ActiveMediaInfo
  twitch?: ActiveMediaInfo
  netflix?: ActiveMediaInfo
  browser?: ActiveMediaInfo
}

export class SystemObserver {
  private timer: NodeJS.Timeout | null = null
  private isRunning = false
  private previousProcesses: Set<string> = new Set()
  private initialScanDone = false
  private globalLastTriggered = 0
  private globalCooldownMs = 60 * 1000 // At least 60s between any proactive lines

  private latestActiveMedia: ActiveMediaInfo | null = null
  private mediaRegistry: ActiveMediaRegistry = {}
  private lastCommentedMediaTitle = ''

  private triggers: Record<string, TriggerConfig> = {
    lol: { lastTriggered: 0, cooldownMs: 15 * 60 * 1000 }, // 15 mins
    ram: { lastTriggered: 0, cooldownMs: 15 * 60 * 1000 },
    cyberpunk: { lastTriggered: 0, cooldownMs: 20 * 60 * 1000 },
    valorant: { lastTriggered: 0, cooldownMs: 20 * 60 * 1000 },
    steam: { lastTriggered: 0, cooldownMs: 30 * 60 * 1000 },
    spotify: { lastTriggered: 0, cooldownMs: 30 * 60 * 1000 },
    discord: { lastTriggered: 0, cooldownMs: 30 * 60 * 1000 },
    vscode: { lastTriggered: 0, cooldownMs: 30 * 60 * 1000 },
    browser_search: { lastTriggered: 0, cooldownMs: 15 * 60 * 1000 },
    media_watching: { lastTriggered: 0, cooldownMs: 3.5 * 60 * 1000 } // Every 3.5 mins for comments on what user is watching
  }

  public start(): void {
    if (this.isRunning) return
    this.isRunning = true
    // Initial delay so app finishes loading before scanning
    setTimeout(() => {
      this.tick()
      this.timer = setInterval(() => this.tick(), 10000)
    }, 4000)
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.isRunning = false
  }

  private async tick(): Promise<void> {
    try {
      await this.checkRam()
      await this.checkProcesses()
    } catch {
      // Quiet fail on telemetry glitches
    }
  }

  private canTrigger(key: string): boolean {
    // rule: "Tampoco que interrumpa una oracion para acotar otra cosa"
    if (agentManager.getStatus().isRunning) {
      return false
    }
    const now = Date.now()
    if (now - this.globalLastTriggered < this.globalCooldownMs) {
      return false
    }
    const trigger = this.triggers[key]
    if (!trigger) return false
    return now - trigger.lastTriggered >= trigger.cooldownMs
  }

  private markTriggered(key: string): void {
    const now = Date.now()
    this.globalLastTriggered = now
    if (this.triggers[key]) {
      this.triggers[key].lastTriggered = now
    }
  }

  private triggerCapriReaction(text: string, state: 'curious' | 'ojos' | 'talking' = 'curious'): void {
    try {
      if (agentManager.getStatus().isRunning) return
      agentManager.setCompanionSpeech(text, 6500, true)
      agentManager.setCompanionState(state)
      setTimeout(() => {
        // Return to standing if companion isn't running an agent task
        const config = agentManager.getConfig()
        if (config) {
          agentManager.setCompanionState('standing')
        }
      }, 7000)
    } catch {
      // Ignore
    }
  }

  private async checkRam(): Promise<void> {
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const usedBytes = totalBytes - freeBytes
    const percent = Math.round((usedBytes / totalBytes) * 100)

    if (percent >= 85 && this.canTrigger('ram')) {
      this.markTriggered('ram')
      const usedGB = (usedBytes / (1024 * 1024 * 1024)).toFixed(1)
      const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(1)

      const isEs = consciousnessService.getPreferredLanguage() === 'es'
      const lines = isEs
        ? [
            `¡Epa, choomba! La RAM está que arde al ${percent}% (${usedGB} GB de ${totalGB} GB). ¡Cerrá un par de pestañas antes de que hierva la máquina!`,
            `¡Saturación pesada de memoria detectada! ¡Estamos llevando al límite la máquina con el ${percent}% de RAM!`,
            `¡Uff, pops! ¡${percent}% de memoria en uso! Hora de congelar algunas tareas en segundo plano.`
          ]
        : [
            `Woah, choomba! Your RAM is cooking at ${percent}% (${usedGB} GB of ${totalGB} GB)! Who's hogging all the chrome? Close some tabs before your rig overheats!`,
            `Heavy memory saturation detected—we're redlining this rig at ${percent}% RAM!`,
            `Yikes, pops! ${percent}% RAM in use! Time to ice some background tasks!`
          ]
      const chosen = lines[Math.floor(Math.random() * lines.length)]
      this.triggerCapriReaction(chosen, 'curious')
    }
  }

  private async checkProcesses(): Promise<void> {
    const detectedMedia = await this.detectActiveMedia()

    return new Promise((resolve) => {
      // Fast process list for background game and app tracking
      void listProcessNames().then((currentProcesses) => {
        if (!currentProcesses) return resolve()

        if (!this.initialScanDone) {
          this.previousProcesses = currentProcesses
          this.initialScanDone = true
          if (currentProcesses.has('cyberpunk2077.exe')) {
            console.log('[SystemObserver] Cyberpunk 2077 already active on startup. Engaging Gaming Mode.')
            try {
              windowManager.setGamingMode(true)
            } catch {}
            try {
              if (!cyberpunkAdapter.isRunning()) {
                cyberpunkAdapter.start().catch(() => {})
              }
            } catch {}
          }
          return resolve()
        }

        const isEs = consciousnessService.getPreferredLanguage() === 'es'

        // Check for proactive media comment (YouTube, TikTok, Reels, Twitch, Netflix, Spotify)
        if (
          detectedMedia &&
          (detectedMedia.title !== this.lastCommentedMediaTitle || Date.now() - this.triggers.media_watching.lastTriggered > 4 * 60 * 1000) &&
          this.canTrigger('media_watching')
        ) {
          this.markTriggered('media_watching')
          this.lastCommentedMediaTitle = detectedMedia.title

          if (detectedMedia.type === 'youtube') {
            const lines = isEs
              ? detectedMedia.creator
                ? [
                    `¡Ooh, mirando a ${detectedMedia.creator}? ¡Me encanta ese youtuber! "${detectedMedia.title}" es buenísimo, choomba.`,
                    `¿Mirando "${detectedMedia.title}" de ${detectedMedia.creator} en YouTube? ¡Eso sí que es entretenimiento de la Red, choomba!`,
                    `¡Te veo mirando a ${detectedMedia.creator} en YouTube! "${detectedMedia.title}" está genial, ¡subile el volumen, choomba!`
                  ]
                : [
                    `¡Ooh, mirando "${detectedMedia.title}" en YouTube! Me copa este video, choomba. A ver qué pasa.`,
                    `¿Mirando "${detectedMedia.title}" en YouTube? ¡Eso sí que es entretenimiento del bueno, choomba!`,
                    `¡Te veo prendido a YouTube con "${detectedMedia.title}"! Se ve genial, choomba.`
                  ]
              : detectedMedia.creator
              ? [
                  `Ooh, watching ${detectedMedia.creator}? I love that youtuber! "${detectedMedia.title}" is pure gold, choomba!`,
                  `Watching "${detectedMedia.title}" by ${detectedMedia.creator} on YouTube? Now that's some quality Net entertainment, choomba!`,
                  `I see you watching ${detectedMedia.creator} on YouTube! "${detectedMedia.title}" is awesome, turn it up, choomba!`
                ]
              : [
                  `Ooh, watching "${detectedMedia.title}" on YouTube? Love this video, choomba! Turn up the volume and let's see what happens.`,
                  `Watching "${detectedMedia.title}" on YouTube? Now that's some quality Net entertainment, choomba!`,
                  `I see you jacking into YouTube with "${detectedMedia.title}"! Looking good, choomba.`
                ]
            this.triggerCapriReaction(lines[Math.floor(Math.random() * lines.length)], 'talking')
          } else if (detectedMedia.type === 'tiktok') {
            const lines = isEs
              ? [
                  "¡Ooh, scrolleando en TikTok! Que los algoritmos corpo no te quemen el ciberware, choomba.",
                  "¡Veo ese TikTok que estás mirando! Puro caos en la Red hoy, ¿eh?"
                ]
              : [
                  "Ooh, scrolling through TikTok? Don't let the corporate algorithms fry your cyberware, choomba!",
                  "I see that TikTok you're watching! Pure chaos on the Net today, huh?"
                ]
            this.triggerCapriReaction(lines[Math.floor(Math.random() * lines.length)], 'talking')
          } else if (detectedMedia.type === 'reels') {
            const lines = isEs
              ? [
                  "¿Mirando Reels en Instagram? Es bastante adictivo todo ese contenido corto, ¿no, choomba?",
                  "¡Ooh, ese reel se ve divertido! Los netrunners en Night City matarían por un feed tan viral."
                ]
              : [
                  "Checking out Instagram Reels? That short-form static is pretty addictive, huh choomba?",
                  "Ooh, that reel looks fun! Netrunners in Night City would kill for this kind of viral feed."
                ]
            this.triggerCapriReaction(lines[Math.floor(Math.random() * lines.length)], 'talking')
          } else if (detectedMedia.type === 'twitch') {
            const lines = isEs
              ? [
                  `¿Prendido a "${detectedMedia.title}" en Twitch? ¡Espero que los netrunners de Arasaka no le caigan encima!`,
                  `¿Mirando streams en Twitch? Buen ruido de fondo mientras vigilo tu ciberware, choomba.`
                ]
              : [
                  `Tuned into "${detectedMedia.title}" on Twitch? Hope they don't get stream-sniped by Arasaka netrunners!`,
                  `Watching Twitch streams? Perfect background noise while I monitor your cyberware, choomba.`
                ]
            this.triggerCapriReaction(lines[Math.floor(Math.random() * lines.length)], 'talking')
          } else if (detectedMedia.type === 'netflix') {
            const lines = isEs
              ? [
                  `¿Mirando "${detectedMedia.title}"? ¡Modo pochoclos y netrunner activado, choomba! No te maratonees todo sin mí.`,
                  `¿Transmitiendo "${detectedMedia.title}"? Parece noche de cine en Night City, choomba.`
                ]
              : [
                  `Watching "${detectedMedia.title}"? Popcorn and netrun mode engaged, choomba! Don't binge without me.`,
                  `Streaming "${detectedMedia.title}"? Looks like movie night in Night City, choomba!`
                ]
            this.triggerCapriReaction(lines[Math.floor(Math.random() * lines.length)], 'talking')
          } else if (detectedMedia.type === 'youtube_music') {
            const artist = detectedMedia.artist ? ` (${detectedMedia.artist})` : ''
            this.triggerCapriReaction(
              isEs
                ? `¿Escuchando "${detectedMedia.title}"${artist} en YouTube Music? ¡Temazo, choomba! Que siga sonando.`
                : `Spinning "${detectedMedia.title}"${artist} on YouTube Music, choomba! Keep the music pumping.`,
              'talking'
            )
          } else if (detectedMedia.type === 'spotify') {
            const lines = isEs
              ? [
                  `¿Escuchando "${detectedMedia.title}" en Spotify? ¡Temazo total, choomba! Que siga sonando la música.`,
                  `¡Qué temazo! "${detectedMedia.title}" mantiene mis rutinas de tecnópata vibrando.`
                ]
              : [
                  `Spinning "${detectedMedia.title}" on Spotify? Total banger, choomba! Keep the music pumping.`,
                  `Now that's a killer track! "${detectedMedia.title}" keeps my technopath subroutines humming.`
                ]
            this.triggerCapriReaction(lines[Math.floor(Math.random() * lines.length)], 'talking')
          }

          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Check for browser search activity
        if (this.mediaRegistry.browser && this.canTrigger('browser_search')) {
          this.markTriggered('browser_search')
          this.triggerCapriReaction(
            isEs
              ? "¿Buscando data en la Red, choomba? Avisame si querés que descifre o vulnere algo."
              : "Browsing the Net for intel, choomba? Let me know if you want me to breach or decode anything!",
            'talking'
          )
          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Universal Gaming Mode and Adapter Management for any Game (LoL, Cyberpunk, Valorant, CS2, Palworld, Roblox, etc.)
        const isLolProcess = (p: Set<string>) => p.has('league of legends.exe')
        const isCyberpunkProcess = (p: Set<string>) => p.has('cyberpunk2077.exe')
        const isValorantProcess = (p: Set<string>) => p.has('valorant.exe') || p.has('valorant-win64-shipping.exe')
        const isOtherGameProcess = (p: Set<string>) =>
          p.has('cs2.exe') ||
          p.has('csgo.exe') ||
          p.has('dota2.exe') ||
          p.has('palworld.exe') ||
          p.has('palworld-win64-shipping.exe') ||
          p.has('robloxplayerbeta.exe') ||
          p.has('fortniteclient-win64-shipping.exe') ||
          p.has('gta5.exe') ||
          p.has('overwatch.exe') ||
          p.has('r5apex.exe') ||
          p.has('apex.exe') ||
          p.has('rocketleague.exe') ||
          p.has('eldenring.exe') ||
          p.has('witcher3.exe')

        const hasLolNow = isLolProcess(currentProcesses)
        const hadLolBefore = isLolProcess(this.previousProcesses)

        const hasCyberpunkNow = isCyberpunkProcess(currentProcesses)
        const hadCyberpunkBefore = isCyberpunkProcess(this.previousProcesses)

        const isAnyGameNow =
          hasCyberpunkNow ||
          hasLolNow ||
          isValorantProcess(currentProcesses) ||
          isOtherGameProcess(currentProcesses)

        const wasAnyGameBefore =
          hadCyberpunkBefore ||
          hadLolBefore ||
          isValorantProcess(this.previousProcesses) ||
          isOtherGameProcess(this.previousProcesses)

        // If any game starts, engage Gaming Mode and relevant adapters
        if (isAnyGameNow && !wasAnyGameBefore) {
          console.log('[SystemObserver] Game detected. Engaging Gaming Mode.')
          try {
            windowManager.setGamingMode(true)
          } catch {}
        }

        // If all games closed, disengage Gaming Mode (with active adapter safeguard)
        if (!isAnyGameNow && wasAnyGameBefore) {
          let hasActiveTelemetry = false
          try {
            if (cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
              hasActiveTelemetry = true
            }
          } catch {}

          if (!hasActiveTelemetry) {
            console.log('[SystemObserver] All game processes closed. Exiting Gaming Mode.')
            try {
              windowManager.setGamingMode(false)
            } catch {}
          }
        }

        // Specific LoL adapter lifecycle
        if (hasLolNow && !hadLolBefore) {
          try {
            if (!lolLiveAdapter.isRunning()) {
              lolLiveAdapter.start().catch(() => {})
            }
          } catch {}
        } else if (!hasLolNow && hadLolBefore) {
          try {
            if (lolLiveAdapter.isRunning()) {
              lolLiveAdapter.stop().catch(() => {})
            }
          } catch {}
        }

        // Specific Cyberpunk adapter lifecycle
        if (hasCyberpunkNow && !hadCyberpunkBefore) {
          try {
            if (!cyberpunkAdapter.isRunning()) {
              cyberpunkAdapter.start().catch(() => {})
            }
          } catch {}
        } else if (!hasCyberpunkNow && hadCyberpunkBefore) {
          try {
            if (cyberpunkAdapter.isRunning()) {
              cyberpunkAdapter.stop().catch(() => {})
            }
          } catch {}
        }

        // Reactions to specific game starts:
        if (hasLolNow && !hadLolBefore && this.canTrigger('lol')) {
          this.markTriggered('lol')
          const lolLines = isEs
            ? [
                "¿Un LoLcito? ¿Otra simulación cibernética de humanos? ¡Cuidado con los ganks, choomba, o Arasaka te baneará la cuenta!",
                "¡League of Legends detectado! ¿Vas a jugar ranked, choomba? No te tiltees ni le eches la culpa al jungla, ¡a ganar esta!",
                "¿En la Grieta del Invocador? ¡Lockeate un asesino y hagamos saltar chispas, choomba!",
                "¿Entrando a partida? Solo no te vayas por mid a feedear o te hackeo el ping a 999 ms."
              ]
            : [
                "Wait, what's League of Legends? Another meatbag cyber-simulation? Watch out for ganks, choomba, or Arasaka's gonna ban your account!",
                "League of Legends detected! You queueing up for ranked, cupcake? Don't tilt and blame your jungler, let's win this!",
                "Locked into Summoner's Rift? Lock in an assassin and make some sparks fly, choomba!",
                "Locked in? Just don't run it down mid or I'll hack your ping to 999 ms!"
              ]
          const chosen = lolLines[Math.floor(Math.random() * lolLines.length)]
          this.triggerCapriReaction(chosen, 'curious')
          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Check for Cyberpunk 2077 start reaction
        if (hasCyberpunkNow && !hadCyberpunkBefore && this.canTrigger('cyberpunk')) {
          this.markTriggered('cyberpunk')
          this.triggerCapriReaction(
            isEs
              ? "¡Cyberpunk 2077 activo! ¿De paseo por Night City? Mandale un saludo a Judy y mantené el fierro caliente, choomba."
              : "Cyberpunk 2077 active! Taking a tour through Night City? Say hi to Judy and keep your iron hot, choomba!",
            'curious'
          )
          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Check for Valorant
        if (
          (currentProcesses.has('valorant.exe') || currentProcesses.has('valorant-win64-shipping.exe')) &&
          !this.previousProcesses.has('valorant.exe') &&
          this.canTrigger('valorant')
        ) {
          this.markTriggered('valorant')
          this.triggerCapriReaction(
            isEs
              ? "¡Valorant iniciado! Meté mocha y plantá la spike, choomba. ¡No dejes que los duelistas te ganen!"
              : "Valorant booted up! Click heads and plant that spike, choomba! Don't let their duelists diff you!",
            'curious'
          )
          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Check for Spotify
        if (
          currentProcesses.has('spotify.exe') &&
          !this.previousProcesses.has('spotify.exe') &&
          this.canTrigger('spotify')
        ) {
          this.markTriggered('spotify')
          this.triggerCapriReaction(
            isEs
              ? "¿Metiéndole música a tus implantes de audio? ¡Mandale algo de Samurai o Ponpon Shit, choomba!"
              : "Pumping tunes into your audio cyberware? Put on some Samurai or Ponpon Shit, choomba!",
            'talking'
          )
          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Check for Discord
        if (
          currentProcesses.has('discord.exe') &&
          !this.previousProcesses.has('discord.exe') &&
          this.canTrigger('discord')
        ) {
          this.markTriggered('discord')
          this.triggerCapriReaction(
            isEs
              ? "¡Discord abierto! Decile a tu grupo de netrunners que Capri les manda un saludo."
              : "Discord open! Tell your netrunner crew that Capri says hey-oh!",
            'talking'
          )
          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Check for VS Code
        if (
          currentProcesses.has('code.exe') &&
          !this.previousProcesses.has('code.exe') &&
          this.canTrigger('vscode')
        ) {
          this.markTriggered('vscode')
          this.triggerCapriReaction(
            isEs
              ? "¡VS Code activo! Hora de reventar bugs y tirar código letal juntos. ¡A prender fuego todo!"
              : "VS Code active! Time to breach some bugs and write lethal scripts together. Let's make some sparks!",
            'talking'
          )
          this.previousProcesses = currentProcesses
          return resolve()
        }

        // Check for Steam
        if (
          currentProcesses.has('steam.exe') &&
          !this.previousProcesses.has('steam.exe') &&
          this.canTrigger('steam')
        ) {
          this.markTriggered('steam')
          this.triggerCapriReaction(
            isEs
              ? "¿Abriendo Steam? ¿Un descansito de tanto picar código, pops? ¡Te va a gustar este juego!"
              : "Booting up Steam? Taking a break from shipping code, pops? You'll like this game!",
            'curious'
          )
          this.previousProcesses = currentProcesses
          return resolve()
        }

        this.previousProcesses = currentProcesses
        resolve()
      })
    })
  }

  public getActiveMedia(
    filter?: 'youtube_music' | 'spotify' | 'youtube' | 'tiktok' | 'reels' | 'video' | 'audio' | 'browser'
  ): ActiveMediaInfo | null {
    if (filter === 'audio' || filter === 'youtube_music') {
      const music = this.mediaRegistry.youtube_music
      if (music && Date.now() - music.lastSeen < 3 * 60 * 1000) return music
      if (filter === 'youtube_music') return null
    }
    if (filter === 'spotify' || filter === 'audio') {
      return this.mediaRegistry.spotify && Date.now() - this.mediaRegistry.spotify.lastSeen < 3 * 60 * 1000
        ? this.mediaRegistry.spotify
        : null
    }
    if (filter === 'youtube') {
      return this.mediaRegistry.youtube && Date.now() - this.mediaRegistry.youtube.lastSeen < 3 * 60 * 1000
        ? this.mediaRegistry.youtube
        : null
    }
    if (filter === 'tiktok') {
      return this.mediaRegistry.tiktok && Date.now() - this.mediaRegistry.tiktok.lastSeen < 3 * 60 * 1000
        ? this.mediaRegistry.tiktok
        : null
    }
    if (filter === 'reels') {
      return this.mediaRegistry.reels && Date.now() - this.mediaRegistry.reels.lastSeen < 3 * 60 * 1000
        ? this.mediaRegistry.reels
        : null
    }
    if (filter === 'browser') {
      return this.mediaRegistry.browser && Date.now() - this.mediaRegistry.browser.lastSeen < 3 * 60 * 1000
        ? this.mediaRegistry.browser
        : null
    }
    if (filter === 'video') {
      const v =
        this.mediaRegistry.youtube ||
        this.mediaRegistry.tiktok ||
        this.mediaRegistry.reels ||
        this.mediaRegistry.twitch ||
        this.mediaRegistry.netflix
      return v && Date.now() - v.lastSeen < 3 * 60 * 1000 ? v : null
    }
    if (this.latestActiveMedia && Date.now() - this.latestActiveMedia.lastSeen < 3 * 60 * 1000) {
      return this.latestActiveMedia
    }
    return null
  }

  public async detectActiveMedia(
    filter?: 'youtube_music' | 'spotify' | 'youtube' | 'tiktok' | 'reels' | 'video' | 'audio' | 'browser'
  ): Promise<ActiveMediaInfo | null> {
    return new Promise((resolve) => {
      void mediaWindowTitles().then(async (rows) => {
        const hasYoutubeMusic = rows?.some((row) => /youtube music/i.test(row.title))
        const sessions = isWindows && hasYoutubeMusic ? await windowsYoutubeMusic('status') : null
        if (!rows && !Array.isArray(sessions)) return resolve(this.getActiveMedia(filter))

        const freshRegistry: ActiveMediaRegistry = {}

        for (const row of rows || []) {
          {
            const proc = row.proc
            const rawTitle = row.title

            if (!rawTitle || rawTitle === 'N/D' || rawTitle === 'OleMainThreadWndName') continue
            if (proc.includes('nombre de imagen') || proc.includes('image name')) continue
            if (/^(?:Nueva pesta[ñn]a|New Tab|Sin t[ií]tulo)$/i.test(rawTitle)) continue

            const lowerTitle = rawTitle.toLowerCase()

            const musicTitle = youtubeMusicTitle(rawTitle)
            if (musicTitle && /chrome|msedge|brave|firefox|opera|youtube/i.test(proc)) {
              freshRegistry.youtube_music = {
                type: 'youtube_music',
                title: musicTitle,
                track: musicTitle,
                rawTitle,
                appName: 'YouTube Music',
                lastSeen: Date.now()
              }
              continue
            }
            if (lowerTitle.includes('youtube music')) continue

            // YouTube Video
            if (lowerTitle.includes('youtube') && !lowerTitle.includes('youtube music') && !freshRegistry.youtube) {
              let cleanTitle = rawTitle
                .replace(/\s*-\s*YouTube.*$/i, '')
                .replace(/\s*-\s*(?:Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Opera(?:\s+GX)?).*$/i, '')
                .replace(/^\(\d+\)\s*/, '')
                .replace(/^[▶►\s]+/, '')
                .trim()

              if (cleanTitle && cleanTitle.toLowerCase() !== 'youtube') {
                const parts = cleanTitle.split(/\s*[-–—:]\s*/)
                let creator: string | undefined
                if (parts.length > 1) {
                  if (
                    parts[0].length <= 30 &&
                    !/^(?:how|why|what|when|where|top|the|un|una|el|la|los|las|como|por\s+que|de)\b/i.test(
                      parts[0]
                    )
                  ) {
                    creator = parts[0].trim()
                  } else if (
                    parts[parts.length - 1].length <= 30 &&
                    !/^(?:part|parte|video|ep|episode|season)\b/i.test(parts[parts.length - 1])
                  ) {
                    creator = parts[parts.length - 1].trim()
                  } else {
                    creator = parts[0].trim()
                  }
                }

                freshRegistry.youtube = {
                  type: 'youtube',
                  title: cleanTitle,
                  creator,
                  rawTitle,
                  appName: proc,
                  lastSeen: Date.now()
                }
              }
            }

            // TikTok
            else if (lowerTitle.includes('tiktok') && !freshRegistry.tiktok) {
              const cleanTitle = rawTitle
                .replace(/\s*\|\s*TikTok.*$/i, '')
                .replace(/\s*-\s*(?:Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Opera(?:\s+GX)?).*$/i, '')
                .trim()

              freshRegistry.tiktok = {
                type: 'tiktok',
                title: cleanTitle || 'TikTok Feed',
                rawTitle,
                appName: proc,
                lastSeen: Date.now()
              }
            }

            // Instagram Reels
            else if (
              (lowerTitle.includes('instagram') || lowerTitle.includes('reel')) &&
              !freshRegistry.reels
            ) {
              const cleanTitle = rawTitle
                .replace(/\s*•\s*Instagram.*$/i, '')
                .replace(/\s*-\s*(?:Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Opera(?:\s+GX)?).*$/i, '')
                .trim()

              freshRegistry.reels = {
                type: 'reels',
                title: cleanTitle || 'Instagram Reel',
                rawTitle,
                appName: proc,
                lastSeen: Date.now()
              }
            }

            // Twitch Stream
            else if (lowerTitle.includes('twitch') && !freshRegistry.twitch) {
              const cleanTitle = rawTitle
                .replace(/\s*-\s*Twitch.*$/i, '')
                .replace(/\s*-\s*(?:Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Opera(?:\s+GX)?).*$/i, '')
                .trim()

              freshRegistry.twitch = {
                type: 'twitch',
                title: cleanTitle || 'Twitch Stream',
                rawTitle,
                appName: proc,
                lastSeen: Date.now()
              }
            }

            // Netflix / Crunchyroll
            else if (
              (lowerTitle.includes('netflix') ||
                lowerTitle.includes('crunchyroll') ||
                lowerTitle.includes('anime')) &&
              !freshRegistry.netflix
            ) {
              const cleanTitle = rawTitle
                .replace(/\s*\|\s*Netflix.*$/i, '')
                .replace(/\s*-\s*(?:Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Opera(?:\s+GX)?).*$/i, '')
                .trim()

              freshRegistry.netflix = {
                type: 'netflix',
                title: cleanTitle || 'Anime / Stream',
                rawTitle,
                appName: proc,
                lastSeen: Date.now()
              }
            }

            // Spotify Desktop App
            else if (proc.includes('spotify')) {
              const isSpecific =
                rawTitle !== 'Spotify' &&
                rawTitle !== 'Spotify Free' &&
                rawTitle !== 'Spotify Premium'
              const songTitle = isSpecific
                ? rawTitle.replace(/^Spotify(?: Free| Premium)?\s*[-–—:]\s*/i, '').trim()
                : 'Spotify'

              let artist: string | undefined
              let track = songTitle
              if (isSpecific) {
                const parts = songTitle.split(/\s*[-–—]\s*/)
                if (parts.length >= 2) {
                  artist = parts[0].trim()
                  track = parts.slice(1).join(' - ').trim()
                }
              }

              // Always prefer a specific song title over generic 'Spotify'
              if (!freshRegistry.spotify || isSpecific) {
                freshRegistry.spotify = {
                  type: 'spotify',
                  title: track,
                  creator: artist,
                  artist,
                  track,
                  rawTitle,
                  appName: proc,
                  lastSeen: Date.now()
                }
              }
            }

            // Spotify Web Player in browsers (Opera, Chrome, Edge, Brave, Firefox)
            else if (
              (proc.includes('opera') ||
                proc.includes('chrome') ||
                proc.includes('msedge') ||
                proc.includes('brave') ||
                proc.includes('firefox')) &&
              lowerTitle.includes('spotify') &&
              !freshRegistry.spotify
            ) {
              const cleanTitle = rawTitle
                .replace(/\s*[-–—|•]\s*Spotify.*$/i, '')
                .replace(/\s*-\s*(?:Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Opera(?:\s+GX)?).*$/i, '')
                .replace(/^Spotify\s*[-–—|•]\s*/i, '')
                .trim()
              const isSpecific =
                cleanTitle &&
                !/^(?:web player|spotify|home|inicio|search|buscar)$/i.test(cleanTitle)
              freshRegistry.spotify = {
                type: 'spotify',
                title: isSpecific ? cleanTitle : 'Spotify Web',
                rawTitle,
                appName: proc,
                lastSeen: Date.now()
              }
            }

            // General Web Browsing / Google Searches
            else if (
              (proc.includes('opera') ||
                proc.includes('chrome') ||
                proc.includes('msedge') ||
                proc.includes('brave') ||
                proc.includes('firefox')) &&
              !freshRegistry.browser
            ) {
              const cleanTitle = rawTitle
                .replace(/\s*-\s*(?:Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Opera(?:\s+GX)?).*$/i, '')
                .trim()

              if (cleanTitle && cleanTitle.length > 1) {
                const isGoogleSearch = /(?:Google Search|Buscar con Google|\bGoogle\b)/i.test(cleanTitle)
                const searchQ = cleanTitle.replace(/\s*-\s*(?:Google Search|Buscar con Google|Google)\s*$/i, '').trim()
                freshRegistry.browser = {
                  type: isGoogleSearch ? 'google' : 'browser',
                  title: isGoogleSearch ? searchQ : cleanTitle,
                  rawTitle,
                  appName: proc,
                  lastSeen: Date.now()
                }
              }
            }
          }
        }

        if (Array.isArray(sessions)) {
          const session = sessions.find((item) => item.status === 'Playing' && item.title)
          if (session) {
            freshRegistry.youtube_music = {
              type: 'youtube_music',
              title: session.title,
              track: session.title,
              artist: session.artist || undefined,
              creator: session.artist || undefined,
              rawTitle: session.title,
              appName: 'YouTube Music',
              lastSeen: Date.now()
            }
          } else if (sessions.length) {
            delete freshRegistry.youtube_music
          }
        }
        this.mediaRegistry = freshRegistry

        if (filter === 'youtube_music') return resolve(this.mediaRegistry.youtube_music || null)
        if (filter === 'audio' && this.mediaRegistry.youtube_music) return resolve(this.mediaRegistry.youtube_music)
        if (filter === 'spotify' || filter === 'audio') {
          return resolve(this.mediaRegistry.spotify || null)
        }
        if (filter === 'youtube') {
          return resolve(this.mediaRegistry.youtube || null)
        }
        if (filter === 'tiktok') {
          return resolve(this.mediaRegistry.tiktok || null)
        }
        if (filter === 'reels') {
          return resolve(this.mediaRegistry.reels || null)
        }
        if (filter === 'browser') {
          return resolve(this.mediaRegistry.browser || null)
        }
        if (filter === 'video') {
          const v =
            this.mediaRegistry.youtube ||
            this.mediaRegistry.tiktok ||
            this.mediaRegistry.reels ||
            this.mediaRegistry.twitch ||
            this.mediaRegistry.netflix ||
            null
          return resolve(v)
        }

        this.latestActiveMedia =
          this.mediaRegistry.youtube_music ||
          this.mediaRegistry.youtube ||
          this.mediaRegistry.tiktok ||
          this.mediaRegistry.reels ||
          this.mediaRegistry.twitch ||
          this.mediaRegistry.netflix ||
          this.mediaRegistry.browser ||
          this.mediaRegistry.spotify ||
          null

        resolve(this.latestActiveMedia)
      })
    })
  }

  public async getActiveMediaAsync(
    filter?: 'youtube_music' | 'spotify' | 'youtube' | 'tiktok' | 'reels' | 'video' | 'audio' | 'browser'
  ): Promise<ActiveMediaInfo | null> {
    const fresh = await this.detectActiveMedia(filter)
    return fresh || this.getActiveMedia(filter)
  }
}

export const systemObserver = new SystemObserver()
