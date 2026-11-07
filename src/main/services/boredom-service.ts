import { shell } from 'electron'
import { localizeLine } from '../../shared/lines'
import { agentManager } from '../agents/agent-manager'
import { scannerService } from './scanner-service'
import { musicPlatformName } from './music-platform'
import { consciousnessService } from './consciousness-service'
import { ToolExecutor } from '../agents/tools/tool-executor'
import { windowManager } from '../windows/window-manager'
import { cyberpunkAdapter, lolLiveAdapter } from './game'

interface BoredomActionConfig {
  category: 'spotify' | 'youtube' | 'web_search'
  target: string
  phrasesEs: string[]
  phrasesEn: string[]
}

const SPOTIFY_SONGS = [
  'The Rebel Path Cyberpunk 2077',
  'Resist and Disorder Cyberpunk',
  'I Really Want to Stay at Your House',
  'Hyper - Spoiler Cyberpunk',
  'Daft Punk - Harder Better Faster Stronger',
  'Gorillaz - Feel Good Inc',
  'Charly Garcia - Demoliendo Hoteles',
  'Duki - She Don\'t Give a FO',
  'Skrillex - Bangarang',
  'Kavinsky - Nightcall',
  'Carpenter Brut - Turbo Killer',
  'Synthwave Cyberpunk Radio',
  'Anime Openings Playlist',
  'Soda Stereo - De Musica Ligera'
]

const YOUTUBE_SEARCHES = [
  'Cyberpunk 2077 Edgerunners best scenes',
  'Cool robotics and cyberware tech',
  'Insane tech hacks that look like magic',
  'Crazy anime fight scenes 4k',
  'Synthwave visualizer neon animation',
  'Hilarious computer glitches speedruns',
  'Boston Dynamics robots parkour',
  'Night City ambiance 4k'
]

const WEB_SEARCHES = [
  'the strangest scientific discoveries in the world',
  'cyberpunk aesthetics wallpaper 4k',
  'quantum computing breakthroughs',
  'unsolved internet mysteries',
  'crazy programmer projects on github',
  'funniest technology conspiracy theories'
]

export class BoredomService {
  private static instance: BoredomService
  private timer: NodeJS.Timeout | null = null
  private isRunning = false
  private lastTriggeredTime = 0
  private minCooldownMs = 8 * 60 * 1000 // At least 8 minutes between autonomous boredom actions
  private gamingModeUnsub: (() => void) | null = null

  public static getInstance(): BoredomService {
    if (!BoredomService.instance) {
      BoredomService.instance = new BoredomService()
    }
    return BoredomService.instance
  }

  public start(): void {
    if (this.isRunning) return

    // Never start if already in Gaming Mode or in an active game
    if (windowManager.isGamingModeActive() || cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      console.log('[BoredomService] Game or Gaming Mode currently active -> Boredom engine remains frozen.')
      this.lastTriggeredTime = Date.now()
      return
    }

    this.isRunning = true
    this.lastTriggeredTime = Date.now()

    if (!this.gamingModeUnsub) {
      this.gamingModeUnsub = windowManager.onGamingModeChanged((isGaming) => {
        if (isGaming) {
          console.log('[BoredomService] Gaming Mode engaged -> Freezing boredom engine completely.')
          this.stop()
        } else {
          console.log('[BoredomService] Gaming Mode disengaged -> Restarting boredom cooldown.')
          this.lastTriggeredTime = Date.now()
          this.start()
        }
      })
    }

    // Initial wait of 4 to 8 minutes after app boot before first boredom check
    const initialDelay = (4 + Math.random() * 4) * 60 * 1000
    this.scheduleNextTick(initialDelay)
    console.log(`[BoredomService] Started. First boredom check in ${Math.round(initialDelay / 60000)} minutes.`)
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.isRunning = false
    this.lastTriggeredTime = Date.now() // Freeze boredom level so it never accumulates during pause!
  }

  private scheduleNextTick(delayMs?: number): void {
    if (!this.isRunning) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    // Interval between 12 and 22 minutes (randomized)
    const nextInterval = delayMs ?? ((12 + Math.random() * 10) * 60 * 1000)
    this.timer = setTimeout(() => {
      this.tick()
    }, nextInterval)
  }

  private async tick(): Promise<void> {
    if (!this.isRunning) return

    // If gaming mode or active games are detected, DO not trigger and keep boredom AT zero
    if (windowManager.isGamingModeActive() || cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      this.lastTriggeredTime = Date.now()
      this.scheduleNextTick(15 * 60 * 1000)
      return
    }

    try {
      if (this.canTriggerAutonomous()) {
        await this.triggerBoredomAction()
      }
    } catch (err) {
      console.warn('[BoredomService] Tick warning:', err)
    } finally {
      this.scheduleNextTick()
    }
  }

  public canTriggerAutonomous(): boolean {
    if (!this.isRunning || !consciousnessService.isBoredomEnabled()) return false

    // Never interrupt active chat or executing tool tasks
    if (agentManager.getStatus().isRunning) {
      return false
    }

    // Never interrupt scanner mode
    if (scannerService.getStatus().isOpen) {
      return false
    }

    // Never interrupt sleep state
    if (agentManager.getCompanionState() === 'sleep') {
      return false
    }

    // Strictly forbidden in Gaming Mode (playing Cyberpunk or League or gaming mode active)
    if (windowManager.isGamingModeActive()) {
      return false
    }

    if (cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      return false
    }

    // Cooldown check
    const now = Date.now()
    if (now - this.lastTriggeredTime < this.minCooldownMs) {
      return false
    }

    return true
  }

  /**
   * Triggers an autonomous boredom action:
   * Capri complains that she is bored, announces what she is doing,
   * and opens a tab / plays a song / searches the web!
   */
  public async triggerBoredomAction(forcedCategory?: 'spotify' | 'youtube' | 'web_search'): Promise<boolean> {
    if (windowManager.isGamingModeActive()) {
      return false
    }

    if (cyberpunkAdapter?.isCyberpunkActive() || lolLiveAdapter?.isRunning()) {
      return false
    }

    const isEs = consciousnessService.getPreferredLanguage() === 'es'

    // Pick category: 35% Spotify, 35% YouTube, 30% Web Search
    const category: 'spotify' | 'youtube' | 'web_search' = forcedCategory ?? (() => {
      const r = Math.random()
      if (r < 0.35) return 'spotify'
      if (r < 0.70) return 'youtube'
      return 'web_search'
    })()

    this.lastTriggeredTime = Date.now()

    if (category === 'spotify') {
      const platform = consciousnessService.getMusicPlatform()
      const platformName = musicPlatformName(platform)
      const song = SPOTIFY_SONGS[Math.floor(Math.random() * SPOTIFY_SONGS.length)]
      const phrasesEs = [
        `¡Uff, qué embole, {name}! Estoy re aburrida de estar acá quieta... Pará que pongo "${song}" en ${platformName} para levantar la onda.`,
        `Me aburrí de este silencio mortal, choomba... Hackeando ${platformName} ya mismo, te pongo "${song}" bien arriba.`,
        `¡Qué embole mal! No me aguanto las ganas de escuchar música, mandando "${song}" a ${platformName} ahora mismo.`
      ]
      const phrasesEn = [
        `Uff, so bored, {name}! I'm completely bored just standing around... Hold up, throwing "${song}" on ${platformName} to hype up the vibe!`,
        `Silence is killing me, choomba... Jacking into ${platformName} right now, putting on "${song}"!`
      ]
      const speech = isEs ? phrasesEs[Math.floor(Math.random() * phrasesEs.length)] : phrasesEn[Math.floor(Math.random() * phrasesEn.length)]

      agentManager.setCompanionState('talking')
      agentManager.setCompanionSpeech(speech, 5000, true, `{name} was quiet and you got bored, so you put "${song}" on ${platformName}. Nobody asked: you picked it yourself because you like it`)

      setTimeout(async () => {
        try {
          await ToolExecutor.execute(
            'open_application',
            { appOrUrl: platform, query: song, isChange: true },
            ''
          )
        } catch (e) {
          console.warn('[BoredomService] Spotify execution error:', e)
        }
        agentManager.setCompanionState('happy')
      }, 1800)

      return true
    }

    if (category === 'youtube') {
      const query = YOUTUBE_SEARCHES[Math.floor(Math.random() * YOUTUBE_SEARCHES.length)]
      const phrasesEs = [
        `¡Che, {name}, me pudrí del aburrimiento! Voy a abrir YouTube a buscar "${query}" para mirar un toque.`,
        `Estoy recontra aburrida... A ver qué hay de copado en YouTube, abriendo una pestaña ya mismo, mirá esto.`,
        `Uff, qué embole... Dejame que te busque un video piola en la Red sobre "${query}", ¡no te quedes dormido, choomba!`
      ]
      const phrasesEn = [
        `Hey {name}, I'm dying of boredom! Opening up YouTube to look up "${query}" for a sec!`,
        `So bored just waiting around... Let's see what's on YouTube, opening up a tab for "${query}" right now!`
      ]
      const speech = isEs ? phrasesEs[Math.floor(Math.random() * phrasesEs.length)] : phrasesEn[Math.floor(Math.random() * phrasesEn.length)]

      agentManager.setCompanionState('talking')
      agentManager.setCompanionSpeech(speech, 5000, true, `{name} was quiet and you got bored, so you opened YouTube and searched "${query}". Nobody asked: it caught your curiosity`)

      setTimeout(async () => {
        try {
          const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
          await shell.openExternal(url)
        } catch (e) {
          console.warn('[BoredomService] YouTube open error:', e)
        }
        agentManager.setCompanionState('curious')
      }, 1800)

      return true
    }

    // Web Search
    const webQuery = localizeLine(WEB_SEARCHES[Math.floor(Math.random() * WEB_SEARCHES.length)], consciousnessService.getPreferredLanguage())
    const phrasesEs = [
      `¡Uff, qué embole! Me puse a escanear la Red de puro aburrimiento y encontré algo que tenés que ver, abriendo pestaña...`,
      `Estoy re aburrida, {name}... Mirá lo que me puse a googlear en la Red, no me juzgues que una netrunner siempre tiene curiosidad.`,
      `Me aburrí de mirar las paredes del escritorio... Hackeando el navegador para buscar "${webQuery}", ¡mirá esto!`
    ]
    const phrasesEn = [
      `Uff, total boredom! I started scanning the Net out of sheer boredom and found something curious, opening a tab...`,
      `I'm super bored, {name}... Look at what I just searched on the Net, don't judge a curious netrunner!`
    ]
    const speech = isEs ? phrasesEs[Math.floor(Math.random() * phrasesEs.length)] : phrasesEn[Math.floor(Math.random() * phrasesEn.length)]

    agentManager.setCompanionState('talking')
    agentManager.setCompanionSpeech(speech, 5000, true, `{name} was quiet and you got bored, so you searched "${webQuery}" on the Net. Nobody asked: it caught your curiosity`)

    setTimeout(async () => {
      try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(webQuery)}`
        await shell.openExternal(url)
      } catch (e) {
        console.warn('[BoredomService] Web search error:', e)
      }
      agentManager.setCompanionState('working')
    }, 1800)

    return true
  }
}

export const boredomService = BoredomService.getInstance()
