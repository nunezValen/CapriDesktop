import { isMac } from '../../../platform'
/**
 * League of Legends adapter for Riot's official Live Client Data API (https://127.0.0.1:2999).
 * Read-only: no input automation, memory reading or process manipulation.
 */

import { EventEmitter } from 'events'
import * as https from 'https'
import { GameAdapter, GameEvent, GameEventPriority, GameEventType } from '../../types'
import { LiveClientAllGameData, LiveClientEvent, LiveClientGameStats, LiveClientPlayer } from './types'
import { itemAdvisor } from './item-advisor'
import { normalizeChampionKey } from './champion-reactions'
import { consciousnessService } from '../../../consciousness-service'
import { lolCommentator, LolMatchSnapshot, LolPlayerSnapshot } from './lol-commentator'

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
})

export class LolLiveAdapter extends EventEmitter implements GameAdapter {
  private static instance: LolLiveAdapter

  public readonly id = 'lol'
  public readonly name = 'League of Legends (Live Client)'

  private running = false
  private pollInterval: NodeJS.Timeout | null = null
  private lastEventId = -1
  private consecutiveErrors = 0
  private maxConsecutiveErrors = 4

  // Match state & identification
  private localPlayerAliases: Set<string> = new Set()
  private activePlayerChampion: string | null = null
  private activePlayerTeam: string | null = null
  private enemyChampions: string[] = []
  private matchGameTime = 0

  // Stat baseline tracking (Layer 2 detection: direct scores & isDead state)
  private lastRecordedKills = -1
  private lastRecordedDeaths = -1
  private wasDead = false
  private matchedPlayer: LiveClientPlayer | null = null
  private cachedActivePlayerName: string | null = null
  private lastAllPlayers: LiveClientPlayer[] = []

  // Match-wide KDA Commentary & Feeder/Carrier Tracker
  private lastKdaCommentTime = 0
  private lastOthersCommentTime = 0
  private lastPlayerAlertAt: Map<string, number> = new Map()
  private kdaCommentCooldownMs = 50 * 1000 // 50 seconds cooldown between KDA commentary
  private commentedPlayerMilestones: Map<string, Set<string>> = new Map()

  public static getInstance(): LolLiveAdapter {
    if (!LolLiveAdapter.instance) {
      LolLiveAdapter.instance = new LolLiveAdapter()
    }
    return LolLiveAdapter.instance
  }

  public isRunning(): boolean {
    return this.running
  }

  /**
   * Probes whether League of Legends is running an active match.
   * Hits official Riot Live Client Data API on port 2999.
   */
  public async detect(): Promise<boolean> {
    try {
      const stats = await this.request<LiveClientGameStats>('/liveclientdata/gamestats', 1200)
      return !!stats && typeof stats.gameTime === 'number'
    } catch {
      return false
    }
  }

  private async queryActivePlayerName(): Promise<void> {
    try {
      const raw = await this.request<string>('/liveclientdata/activeplayername', 1200)
      if (raw && typeof raw === 'string') {
        const clean = raw.replace(/^"|"$/g, '').trim()
        if (clean) {
          this.cachedActivePlayerName = clean
          const lower = clean.toLowerCase()
          this.localPlayerAliases.add(lower)
          this.localPlayerAliases.add(lower.split('#')[0].trim())
          console.log(`[LolLiveAdapter] Probed active player name from Riot API: "${clean}"`)
        }
      }
    } catch {}
  }

  /**
   * Starts polling the in-game Live Client Data API
   */
  public async start(): Promise<void> {
    if (isMac) return
    if (this.running) return
    this.running = true
    this.lastEventId = -1
    this.consecutiveErrors = 0
    this.localPlayerAliases.clear()
    this.activePlayerChampion = null
    this.activePlayerTeam = null
    this.enemyChampions = []
    this.matchGameTime = 0
    this.lastRecordedKills = -1
    this.lastRecordedDeaths = -1
    this.wasDead = false
    this.matchedPlayer = null
    this.cachedActivePlayerName = null
    this.lastAllPlayers = []
    this.lastKdaCommentTime = 0
    this.lastOthersCommentTime = 0
    this.lastPlayerAlertAt.clear()
    this.commentedPlayerMilestones.clear()
    itemAdvisor.resetMatchAdvice()

    // Query active player name immediately
    this.queryActivePlayerName().catch(() => {})

    console.log('[LolLiveAdapter] Started League of Legends Live Client adapter (read-only port 2999)')

    // Immediate first poll
    await this.poll()

    // Regular polling loop (1100ms)
    this.pollInterval = setInterval(async () => {
      await this.poll()
    }, 1100)
  }

  /**
   * Stops polling
   */
  public async stop(): Promise<void> {
    if (!this.running) return
    this.running = false

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    console.log('[LolLiveAdapter] Stopped League of Legends Live Client adapter')
  }

  /**
   * Checks whether a name reported in game events belongs to the local player.
   * Compares across summonerName, riotId, gameName, and championName.
   */
  public isLocalPlayer(name: string | undefined | null): boolean {
    if (!name) return false
    const clean = name.toLowerCase().trim()
    const cleanNoTag = clean.split('#')[0].trim()
    const cleanNoBot = cleanNoTag.replace(/\s*\((?:bot|ai)\)$/i, '').replace(/\s+bot$/i, '').trim()
    const normKey = normalizeChampionKey(cleanNoTag)

    return (
      this.localPlayerAliases.has(clean) ||
      this.localPlayerAliases.has(cleanNoTag) ||
      this.localPlayerAliases.has(cleanNoBot) ||
      this.localPlayerAliases.has(normKey)
    )
  }

  /** Compact live match state for the LLM commentator */
  public getSnapshot(): LolMatchSnapshot {
    const toSnap = (p: LiveClientPlayer): LolPlayerSnapshot => {
      const items: any[] = Array.isArray((p as any).items) ? (p as any).items : []
      const itemGold = items.reduce((sum, it) => sum + (Number(it?.price) || 0) * (Number(it?.count) || 1), 0)
      return {
        champion: p.championName,
        summonerName: p.summonerName,
        riotId: (p as any).riotId || (p as any).riotIdGameName,
        team: p.team,
        position: p.position,
        level: p.level ?? 1,
        kills: p.scores?.kills ?? 0,
        deaths: p.scores?.deaths ?? 0,
        assists: p.scores?.assists ?? 0,
        cs: p.scores?.creepScore ?? 0,
        itemGold,
        isDead: !!p.isDead
      }
    }
    const players = this.lastAllPlayers || []
    const meRaw = this.matchedPlayer
      ? players.find((p) => p.championName === this.matchedPlayer!.championName) || this.matchedPlayer
      : null
    return {
      gameTimeSec: this.matchGameTime,
      me: meRaw ? toSnap(meRaw) : null,
      allies: players.filter((p) => p.team === this.activePlayerTeam && p !== meRaw).map(toSnap),
      enemies: this.activePlayerTeam ? players.filter((p) => p.team !== this.activePlayerTeam).map(toSnap) : []
    }
  }

  /**
   * Provides tactical item counter-build advice on demand
   */
  public getTacticalAdvice(lang: 'es' | 'en' = 'es'): string {
    if (!this.running || this.enemyChampions.length === 0) {
      return lang === 'es'
        ? 'No detecto ninguna partida de LoL en curso ahora mismo, choomba. Apenas entres a la Grieta avisame y te paso las contramedidas tácticas.'
        : 'I do not detect an active League match right now, {name}. Ask me again once you load into the Rift!'
    }

    const adviceList = itemAdvisor.analyzeRoster(this.enemyChampions, this.activePlayerChampion || undefined, lang)
    if (adviceList.length > 0) {
      const prefix = lang === 'es'
        ? 'Te paso las contramedidas tácticas contra su escuadrón, choomba: '
        : 'Here are my tactical counter-build recommendations, {name}: '
      return prefix + adviceList.join(' ')
    }

    return lang === 'es'
      ? 'No veo ninguna composición extrema en el equipo enemigo, choomba. Seguí con tu build habitual de daño o aguante.'
      : 'No extreme team composition detected on the enemy squad, {name}. Stick to your core build.'
  }

  /**
   * Main polling tick
   */
  private async poll(): Promise<void> {
    if (!this.running) return

    try {
      const data = await this.request<LiveClientAllGameData>('/liveclientdata/allgamedata', 1500)
      this.consecutiveErrors = 0

      if (!data) return

      this.matchGameTime = data.gameData?.gameTime || 0
      if (Array.isArray(data.allPlayers)) {
        this.lastAllPlayers = data.allPlayers
      }

      // Ensure active player name probed
      if (!this.cachedActivePlayerName) {
        this.queryActivePlayerName().catch(() => {})
      }

      // Resolve Active Player Identity, Aliases & Team Roster
      this.updatePlayerIdentity(data)

      // Early-game Tactical Item Advice (spoken once per match at game start, minute 0)
      if (
        !itemAdvisor.isAdvisedThisMatch() &&
        this.enemyChampions.length > 0 &&
        this.matchGameTime >= 2
      ) {
        this.triggerInitialItemAdvice()
      }

      // Layer 2: Player Stats & Death State Tracker (Instant Fallback & Reliability)
      this.checkPlayerScores(this.matchedPlayer)

      // Layer 1: Process Live Event Stream from EventData
      const events = data.events?.Events
      if (Array.isArray(events) && events.length > 0) {
        this.processEvents(events)
      }

      // Match-wide KDA Commentary & Feeder/Carrier Tracker
      if (Array.isArray(data.allPlayers) && data.allPlayers.length > 0) {
        this.checkMatchKdas(data.allPlayers)
      }
    } catch (err: any) {
      this.consecutiveErrors++
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        console.log(`[LolLiveAdapter] Connection lost to Live Client Data API (${this.consecutiveErrors} errors). Match finished or client closed.`)
        this.emitGameEvent('match_ended', 'normal', { reason: 'client_disconnected' })
        this.stop()
      }
    }
  }

  /**
   * Resolves player identity across activePlayer and allPlayers objects
   */
  private updatePlayerIdentity(data: LiveClientAllGameData): void {
    const active = data.activePlayer
    if (!active || !Array.isArray(data.allPlayers) || data.allPlayers.length === 0) return

    // If already matched, keep matchedPlayer reference fresh with latest scores from this tick
    if (this.matchedPlayer) {
      const refreshed = data.allPlayers.find((p) =>
        (this.activePlayerChampion && p.championName === this.activePlayerChampion) ||
        (this.matchedPlayer?.summonerName && p.summonerName === this.matchedPlayer.summonerName)
      )
      if (refreshed) {
        this.matchedPlayer = refreshed
        this.activePlayerTeam = refreshed.team
        this.activePlayerChampion = refreshed.championName
      }
    }

    // Collect candidate identifiers from activePlayer & cachedActivePlayerName
    const candidates: string[] = []
    if (this.cachedActivePlayerName) candidates.push(this.cachedActivePlayerName)
    if (active.summonerName) candidates.push(active.summonerName)
    if (active.riotId) candidates.push(active.riotId)
    if (active.riotIdGameName) candidates.push(active.riotIdGameName)

    // Add candidates to alias set
    for (const cand of candidates) {
      const lower = cand.toLowerCase().trim()
      this.localPlayerAliases.add(lower)
      this.localPlayerAliases.add(lower.split('#')[0].trim())
    }

    // Match candidate to allPlayers entry
    let found = data.allPlayers.find((p) => {
      const pSummoner = (p.summonerName || '').toLowerCase().trim()
      const pRiotId = (((p as any).riotId || (p as any).riotIdGameName) || '').toLowerCase().trim()

      return candidates.some((cand) => {
        const cLower = cand.toLowerCase().trim()
        const cBase = cLower.split('#')[0].trim()
        return (
          (pSummoner && (pSummoner === cLower || pSummoner.split('#')[0].trim() === cBase)) ||
          (pRiotId && (pRiotId === cLower || pRiotId.split('#')[0].trim() === cBase))
        )
      })
    })

    // Secondary match: Champion spell signatures in active abilities
    // (active.abilities is exclusive to the local player, and abilities keys/descriptions contain champion name)
    if (!found && active.abilities) {
      const abilitiesStr = JSON.stringify(active.abilities).toLowerCase()
      found = data.allPlayers.find((p) => {
        if (!p.championName) return false
        const champKey = normalizeChampionKey(p.championName)
        const rawKey = (p.rawChampionName || '').toLowerCase().replace(/.*displayname_/, '')
        return (
          (champKey.length >= 3 && abilitiesStr.includes(champKey)) ||
          (rawKey.length >= 3 && abilitiesStr.includes(rawKey)) ||
          abilitiesStr.includes(p.championName.toLowerCase())
        )
      })
    }

    // Tertiary match: Keystone rune ID
    if (!found && active.fullRunes?.keystone?.id) {
      found = data.allPlayers.find((p) => p.runes?.keystone?.id === active.fullRunes?.keystone?.id)
    }

    // Single player fallback (custom game / practice tool)
    if (!found && data.allPlayers.length === 1) {
      found = data.allPlayers[0]
    }

    if (found) {
      this.matchedPlayer = found
      this.activePlayerTeam = found.team
      this.activePlayerChampion = found.championName

      // Register champion names into aliases
      if (found.championName) {
        this.localPlayerAliases.add(found.championName.toLowerCase().trim())
        this.localPlayerAliases.add(normalizeChampionKey(found.championName))
      }
      if (found.rawChampionName) {
        this.localPlayerAliases.add(found.rawChampionName.toLowerCase().trim())
      }
      if (found.summonerName) {
        const lower = found.summonerName.toLowerCase().trim()
        this.localPlayerAliases.add(lower)
        this.localPlayerAliases.add(lower.split('#')[0].trim())
      }
      if ((found as any).riotId) {
        const rLower = String((found as any).riotId).toLowerCase().trim()
        this.localPlayerAliases.add(rLower)
        this.localPlayerAliases.add(rLower.split('#')[0].trim())
      }

      // Extract enemy champions
      const enemies = data.allPlayers.filter((p) => p.team !== this.activePlayerTeam)
      this.enemyChampions = enemies.map((p) => p.championName).filter(Boolean)
    }
  }

  /**
   * Tracks kills and deaths directly via player score deltas and isDead flag
   */
  private checkPlayerScores(player: LiveClientPlayer | null): void {
    if (!player || !player.scores) return

    const currentKills = player.scores.kills ?? 0
    const currentDeaths = player.scores.deaths ?? 0
    const isDead = player.isDead ?? false

    // Initialize baseline on first valid read
    if (this.lastRecordedKills === -1) {
      this.lastRecordedKills = currentKills
      this.lastRecordedDeaths = currentDeaths
      this.wasDead = isDead
      console.log(`[LolLiveAdapter] Initialized score tracking: ${currentKills} kills, ${currentDeaths} deaths, isDead=${isDead}`)
      return
    }

    // Detect Kills
    if (currentKills > this.lastRecordedKills) {
      const delta = currentKills - this.lastRecordedKills
      this.lastRecordedKills = currentKills
      console.log(`[LolLiveAdapter] Score Tracker: detected ${delta} new kill(s)! Current total: ${currentKills}`)
      this.emitGameEvent('player_kill', 'high', {
        kills: currentKills,
        deaths: currentDeaths,
        delta
      })
    }

    // Detect Deaths (score increment or isDead becoming true)
    if (currentDeaths > this.lastRecordedDeaths || (isDead && !this.wasDead)) {
      if (currentDeaths > this.lastRecordedDeaths) {
        this.lastRecordedDeaths = currentDeaths
      }
      this.wasDead = isDead
      console.log(`[LolLiveAdapter] Score Tracker: detected player death! Current deaths: ${currentDeaths}, isDead: ${isDead}`)

      const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'
      let deathPhrase: string | undefined = undefined

      if (currentDeaths >= 3 && currentDeaths >= (currentKills * 2)) {
        if (lang === 'es') {
          const roastDeathPhrases = [
            `¡Otra vez al piso, {name}! Vas ${currentKills}/${currentDeaths}... aflojale a la donación de oro choomba jajaja.`,
            `¡Uff, ${currentKills}/${currentDeaths}! Te están haciendo focus mal, choomba... abrazate a la torre y que no te vean ni la sombra.`,
            `¡No te puedo creer, otra muerte! Vas ${currentKills}/${currentDeaths}, choom... concentrate que se nos va la partida.`,
            `¡Al desarmadero de nuevo! ${currentKills}/${currentDeaths}, pará un poco de respawnear para morir directo jajaja.`
          ]
          deathPhrase = roastDeathPhrases[Math.floor(Math.random() * roastDeathPhrases.length)]
        } else {
          const roastDeathPhrases = [
            `Down in the dirt again, {name}! Sitting at ${currentKills}/${currentDeaths}... ease off the gold charity haha!`,
            `Oof, ${currentKills}/${currentDeaths}! They are hard-focusing you, choom... hug that turret and stay safe!`,
            `I can't believe it, down again! ${currentKills}/${currentDeaths}, {name}... lock in before this match slips away.`,
            `Back to the fountain! ${currentKills}/${currentDeaths}, stop respawning just to feed them direct haha!`
          ]
          deathPhrase = roastDeathPhrases[Math.floor(Math.random() * roastDeathPhrases.length)]
        }
      }

      this.emitGameEvent('player_died', 'critical', {
        deaths: currentDeaths,
        kills: currentKills,
        customPhrase: deathPhrase
      })
    } else if (!isDead && this.wasDead) {
      this.wasDead = false
      console.log('[LolLiveAdapter] Local player respawned!')
    }
  }

  private triggerInitialItemAdvice(): void {
    const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'
    const adviceList = itemAdvisor.analyzeRoster(this.enemyChampions, this.activePlayerChampion || undefined, lang)

    itemAdvisor.setAdvisedThisMatch(true)

    {
      const intro = lang === 'es'
        ? 'Escaneé la composición enemiga, choomba. '
        : 'Enemy team composition scanned, {name}. '
      const fallbackTip = lang === 'es'
        ? `Jugá tu build de siempre con ${this.activePlayerChampion || 'tu campeón'} y fijate quién de ellos se fedea primero.`
        : `Stick to your core build on ${this.activePlayerChampion || 'your champion'} and watch who gets fed first on their side.`
      const customPhrase = adviceList.length > 0 ? intro + adviceList.join(' ') : intro + fallbackTip

      console.log(`[LolLiveAdapter] Emitting initial item counter-build advice: "${customPhrase}"`)
      // Give the "match started" line time to finish so the advice is not swallowed by the cooldown
      const enemies = [...this.enemyChampions]
      setTimeout(() => {
        if (!this.running) return
        this.emitGameEvent('enemy_team_known', 'critical', {
          customPhrase,
          enemyChampions: enemies,
          // No extreme comp found: let the LLM give a concrete build tip for {name}'s champion
          buildTip: adviceList.length === 0
        })
      }, 9000)
    }
  }

  /**
   * Evaluates match-wide KDAs across local player, teammates, and enemies.
   * Laughs at your bad KDA, praises your good KDA, and roasts feeding teammates (especially junglers) or opponents.
   */
  private checkMatchKdas(allPlayers: LiveClientPlayer[]): void {
    if (!this.running || this.matchGameTime < 130) return // Skip early laning

    const now = Date.now()
    const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'

    // Evaluate Local Player ({name})
    if (now - this.lastKdaCommentTime >= this.kdaCommentCooldownMs && this.matchedPlayer && this.matchedPlayer.scores) {
      const k = this.matchedPlayer.scores.kills ?? 0
      const d = this.matchedPlayer.scores.deaths ?? 0
      const localKey = 'local_player'
      let localMilestones = this.commentedPlayerMilestones.get(localKey)
      if (!localMilestones) {
        localMilestones = new Set()
        this.commentedPlayerMilestones.set(localKey, localMilestones)
      }

      // Good KDA Milestones (Praise & Hype)
      if (k >= 12 && !localMilestones.has('praise_tier3')) {
        localMilestones.add('praise_tier3')
        localMilestones.add('praise_tier2')
        localMilestones.add('praise_tier1')
        const phrases = lang === 'es'
          ? [
              `¡${k}/${d}! ¿Pero qué comiste hoy, {name}? ¡Sos un raid boss en persona, qué bestia total!`,
              `¡${k} kills ya, choomba! ¡Eso no es habilidad humana, es puro ciberware de élite de Night City!`,
              `¡Partida histórica, {name}! ${k}/${d}, los borraste a los cinco de la Grieta, qué locura.`
            ]
          : [
              `What an absolute beast, {name}! ${k}/${d}, you are a raid boss in the flesh!`,
              `${k} kills already, choomba! That is pure elite Night City chrome!`,
              `Historic match, {name}! ${k}/${d}, wiped all five of them off the Rift!`
            ]
        const customPhrase = phrases[Math.floor(Math.random() * phrases.length)]
        this.lastKdaCommentTime = now
        this.emitGameEvent('kda_praise', 'high', { customPhrase, kills: k, deaths: d })
        return
      } else if (k >= 7 && (k / Math.max(1, d)) >= 2.5 && !localMilestones.has('praise_tier2')) {
        localMilestones.add('praise_tier2')
        localMilestones.add('praise_tier1')
        const phrases = lang === 'es'
          ? [
              `¡Mirá ese KDA choomba! ${k}/${d}, sos una máquina de matar cromada, ni Faker te frena.`,
              `¡Qué bestia, {name}! ${k}/${d}, estás carreando a estos cuatro conos vos solo jajaja.`,
              `¡Imparable choom! ${k}/${d}, andá pidiéndole perdón al rival que lo borraste del mapa.`
            ]
          : [
              `Look at that KDA, choom! ${k}/${d}, you are a lethal chrome machine today, nothing stops you!`,
              `Huge score, {name}! ${k}/${d}, carrying these four bots all on your own haha!`,
              `Unstoppable! ${k}/${d}, apologize to their team because you deleted them from the map!`
            ]
        const customPhrase = phrases[Math.floor(Math.random() * phrases.length)]
        this.lastKdaCommentTime = now
        this.emitGameEvent('kda_praise', 'high', { customPhrase, kills: k, deaths: d })
        return
      } else if (k >= 4 && d <= 1 && !localMilestones.has('praise_tier1')) {
        localMilestones.add('praise_tier1')
        const phrases = lang === 'es'
          ? [
              `¡Qué lindo KDA metiste, {name}! ${k}/${d}, arrancaste la partida prendido fuego choomba.`,
              `¡Hermoso score, choom! ${k}/${d}, los tenés corriendo en círculos a estos giles.`
            ]
          : [
              `Clean KDA, {name}! ${k}/${d}, starting this match completely on fire, choom!`,
              `Great score, choom! ${k}/${d}, they are running in circles around you.`
            ]
        const customPhrase = phrases[Math.floor(Math.random() * phrases.length)]
        this.lastKdaCommentTime = now
        this.emitGameEvent('kda_praise', 'high', { customPhrase, kills: k, deaths: d })
        return
      }

      // Bad KDA Milestones (Roasting & Laughing at your KDA)
      if (d >= 10 && !localMilestones.has('roast_tier3')) {
        localMilestones.add('roast_tier3')
        localMilestones.add('roast_tier2')
        localMilestones.add('roast_tier1')
        const phrases = lang === 'es'
          ? [
              `¡${k}/${d}! Oficialmente desbloqueaste el powerspike de las 10 muertes, {name}. Ahora sí que ganamos... o no jajaja.`,
              `¡10 muertes choomba! Ya te conocen más en la base de ellos que en la nuestra jajaja.`,
              `Uff {name}, ${k}/${d}... estás jugando en modo donación internacional de oro. ¡Apretemos los dientes!`
            ]
          : [
              `${k}/${d}! You officially unlocked the 10-death powerspike, {name}. Now we win for sure... or not haha!`,
              `10 deaths, choomba! They know you better in their fountain than in ours haha!`,
              `Oof {name}, ${k}/${d}... playing in international gold charity mode. Let us lock in!`
            ]
        const customPhrase = phrases[Math.floor(Math.random() * phrases.length)]
        this.lastKdaCommentTime = now
        this.emitGameEvent('kda_roast', 'high', { customPhrase, kills: k, deaths: d })
        return
      } else if (d >= 6 && d >= (k * 2) && !localMilestones.has('roast_tier2')) {
        localMilestones.add('roast_tier2')
        localMilestones.add('roast_tier1')
        const phrases = lang === 'es'
          ? [
              `Uff {name}, ${k}/${d}... ¿le estás donando oro a la caridad de la Grieta o qué? Ponete las pilas choomba jajaja.`,
              `¡${k}/${d}! Che, ¿el rival te paga comisión por cada muerte? Quedate abajo de la torre un rato choomba.`,
              `Che choomba, ${k}/${d}... te están cazando como a un borg en Arasaka Tower jajaja.`
            ]
          : [
              `Oof {name}, ${k}/${d}... are you donating gold to Rift charity or what? Lock in, choom! Haha.`,
              `${k}/${d}! Are they paying you a commission per death? Hug that turret for a bit, choom!`,
              `Hey choomba, ${k}/${d}... they are hunting you down like an Arasaka borg haha!`
            ]
        const customPhrase = phrases[Math.floor(Math.random() * phrases.length)]
        this.lastKdaCommentTime = now
        this.emitGameEvent('kda_roast', 'high', { customPhrase, kills: k, deaths: d })
        return
      } else if (d >= 4 && (k <= 1 || d >= (k * 2)) && !localMilestones.has('roast_tier1')) {
        localMilestones.add('roast_tier1')
        const phrases = lang === 'es'
          ? [
              `Pará un poco de respawnear para morir directo, {name}, que se te van a gastar los cromos jajaja. Vas ${k}/${d}.`,
              `Che choomba, vas ${k}/${d}... se nos complicó la línea parece. A concentrarse antes de que se arme bola de nieve.`,
              `Uff {name}, ${k}/${d}... ¿el rival te paga comisión por cada muerte? Quedate abajo de la torre un rato choomba.`
            ]
          : [
              `Stop respawning just to feed them direct, {name}! You are sitting at ${k}/${d} haha!`,
              `Hey choom, you are ${k}/${d}... rough lane it seems. Let us focus before this snowballs out of hand.`,
              `Oof {name}, ${k}/${d}... are they paying you a commission per death? Hug that turret for a bit, choom!`
            ]
        const customPhrase = phrases[Math.floor(Math.random() * phrases.length)]
        this.lastKdaCommentTime = now
        this.emitGameEvent('kda_roast', 'high', { customPhrase, kills: k, deaths: d })
        return
      }
    }

    // Evaluate Teammates & Enemies (Especially Junglers & Feeders!) — own cooldown
    if (now - this.lastOthersCommentTime < 40 * 1000) return
    for (const p of allPlayers) {
      if (this.isLocalPlayer(p.summonerName) || this.isLocalPlayer(p.championName)) {
        continue // Skip local player
      }

      const pKey = p.summonerName || p.championName || `player_${p.team}_${p.position}`
      if (now - (this.lastPlayerAlertAt.get(pKey) || 0) < 4 * 60 * 1000) continue
      let pMilestones = this.commentedPlayerMilestones.get(pKey)
      if (!pMilestones) {
        pMilestones = new Set()
        this.commentedPlayerMilestones.set(pKey, pMilestones)
      }

      const pk = p.scores?.kills ?? 0
      const pd = p.scores?.deaths ?? 0
      const isAlly = p.team === this.activePlayerTeam

      // Determine Role
      const posUpper = (p.position || '').toUpperCase()
      const spellsStr = JSON.stringify(p.summonerSpells || {}).toLowerCase()
      const isJungler = posUpper === 'JUNGLE' || spellsStr.includes('smite')
      const champ = p.championName || 'campeón'

      let roleLabelEs = isJungler
        ? (isAlly ? 'tu jungla' : 'el jungla enemigo')
        : posUpper === 'UTILITY'
        ? (isAlly ? 'tu soporte' : 'el soporte enemigo')
        : posUpper === 'BOTTOM'
        ? (isAlly ? 'tu adc' : 'el adc enemigo')
        : posUpper === 'MIDDLE'
        ? (isAlly ? 'tu mid' : 'el mid enemigo')
        : posUpper === 'TOP'
        ? (isAlly ? 'tu toplaner' : 'el toplaner enemigo')
        : (isAlly ? `el ${champ} de tu equipo` : `el ${champ} rival`)

      let roleLabelEn = isJungler
        ? (isAlly ? 'your jungler' : 'the enemy jungler')
        : posUpper === 'UTILITY'
        ? (isAlly ? 'your support' : 'the enemy support')
        : posUpper === 'BOTTOM'
        ? (isAlly ? 'your ADC' : 'the enemy ADC')
        : posUpper === 'MIDDLE'
        ? (isAlly ? 'your mid' : 'the enemy mid')
        : posUpper === 'TOP'
        ? (isAlly ? 'your toplaner' : 'the enemy toplaner')
        : (isAlly ? `your ally ${champ}` : `their ${champ}`)

      // Extreme Feeding (Especially Jungler, Support, Top, Mid!)
      if (pd >= 10 && !pMilestones.has('feed_tier10')) {
        pMilestones.add('feed_tier10')
        pMilestones.add('feed_tier7')
        pMilestones.add('feed_tier5')

        let phrase = ''
        if (lang === 'es') {
          if (isJungler && isAlly) {
            phrase = `Mirá ese jungla, ${pk}/${pd} qué malo... no gankeó una sola línea en toda la partida, está de turista en la jungla.`
          } else if (isJungler && !isAlly) {
            phrase = `Mirá el jungla enemigo, ${pk}/${pd}... nos está regalando la partida en bandeja de plata, qué malo por favor jajaja.`
          } else if (posUpper === 'UTILITY' && isAlly) {
            phrase = `Mirá a tu soporte (${champ}), va ${pk}/${pd}... 10 muertes ya, no pega un ward ni de casualidad y se tira a morir solo jajaja.`
          } else if (posUpper === 'TOP' && isAlly) {
            phrase = `Mirá al toplaner (${champ}), va ${pk}/${pd}... en su propia isla muriendo cada dos minutos sin tirar un teleport jajaja.`
          } else if (posUpper === 'MIDDLE' && isAlly) {
            phrase = `Che, mirá al mid (${champ}), va ${pk}/${pd}... carril central abierto de par en par, una autopista para el rival jajaja.`
          } else if (posUpper === 'BOTTOM' && isAlly) {
            phrase = `Mirá a tu ADC (${champ}), va ${pk}/${pd}... cero kiting y se come todos los ganchos con una sonrisa jajaja.`
          } else if (isAlly) {
            phrase = `Mirá a ese ${champ}, va ${pk}/${pd}... ya desbloqueó el powerspike de las 10 muertes, qué malo jajaja.`
          } else {
            phrase = `Mirá al ${champ} enemigo, va ${pk}/${pd}... es prácticamente un cajero automático de oro para nosotros jajaja.`
          }
        } else {
          if (isJungler && isAlly) {
            phrase = `Look at that jungler, ${pk}/${pd} what a bot! Has not ganked a single lane all game, just a jungle tourist.`
          } else if (isJungler && !isAlly) {
            phrase = `Look at the enemy jungler, ${pk}/${pd}... completely gifting us the match on a silver platter, so bad haha!`
          } else if (posUpper === 'UTILITY' && isAlly) {
            phrase = `Check your support (${champ}), ${pk}/${pd}... 10 deaths, zero wards on the map and face-checking bush like a tourist haha!`
          } else if (posUpper === 'TOP' && isAlly) {
            phrase = `Look at your toplaner (${champ}), ${pk}/${pd}... chilling on their own island dying every 2 minutes without TP haha!`
          } else if (posUpper === 'MIDDLE' && isAlly) {
            phrase = `Look at your mid (${champ}), ${pk}/${pd}... mid lane is a wide open highway for them, didn't even ping missing haha!`
          } else if (posUpper === 'BOTTOM' && isAlly) {
            phrase = `Look at your ADC (${champ}), ${pk}/${pd}... zero kiting and eats every hook with a smile haha.`
          } else if (isAlly) {
            phrase = `Check out your ${champ}, ${pk}/${pd}... hitting the 10-death powerspike, absolute comedy haha.`
          } else {
            phrase = `Look at their ${champ}, ${pk}/${pd}... basically a walking gold ATM for us haha!`
          }
        }

        this.lastOthersCommentTime = now
        this.lastPlayerAlertAt.set(pKey, now)
        this.emitGameEvent('player_feeder_alert', 'high', { customPhrase: phrase, player: champ, kills: pk, deaths: pd, isAlly, role: posUpper })
        return
      } else if (pd >= 7 && pd >= pk * 2 && !pMilestones.has('feed_tier7')) {
        pMilestones.add('feed_tier7')
        pMilestones.add('feed_tier5')

        let phrase = ''
        if (lang === 'es') {
          if (isJungler && isAlly) {
            phrase = `Che, mirá a tu jungla, va ${pk}/${pd}... parece un minion con smite de adorno jajaja.`
          } else if (isJungler && !isAlly) {
            phrase = `Ese jungla rival va ${pk}/${pd}, está re perdido en su propia jungla... ¡vamos a invadirlo y farmearlo a él!`
          } else if (posUpper === 'UTILITY' && isAlly) {
            phrase = `Tu soporte (${champ}) va ${pk}/${pd}... ¿está jugando con la pantalla apagada o qué? Cero visión en el mapa choomba.`
          } else if (posUpper === 'TOP' && isAlly) {
            phrase = `Tu top (${champ}) va ${pk}/${pd}... le regaló dos torres al rival y sigue pusheando sin visión, qué porfiado choomba.`
          } else if (posUpper === 'MIDDLE' && isAlly) {
            phrase = `Tu mid (${champ}) va ${pk}/${pd}... lo solokillearon 5 veces seguidas, está tiltiadísimo choom.`
          } else if (posUpper === 'BOTTOM' && isAlly) {
            phrase = `Tu ADC (${champ}) va ${pk}/${pd}... tiene menos posicionamiento que un cono en la vereda choomba.`
          } else if (isAlly) {
            phrase = `${roleLabelEs} va ${pk}/${pd}... menos mal que estás vos en la partida para intentar remarla, choomba.`
          } else {
            phrase = `Mirá a ${roleLabelEs}, va ${pk}/${pd}... ya está tiltiadísimo pidiendo surrend al 15.`
          }
        } else {
          if (isJungler && isAlly) {
            phrase = `Hey, look at your jungler, ${pk}/${pd}... basically a lane minion with smite for decoration haha.`
          } else if (isJungler && !isAlly) {
            phrase = `Their jungler is ${pk}/${pd}, totally lost in their own jungle... let us invade and farm them!`
          } else if (posUpper === 'UTILITY' && isAlly) {
            phrase = `Your support (${champ}) is ${pk}/${pd}... are they playing with monitor off? Zero map vision, choomba.`
          } else if (posUpper === 'TOP' && isAlly) {
            phrase = `Your top (${champ}) is ${pk}/${pd}... gave away two turrets and still pushes with zero vision, pure stubbornness!`
          } else if (posUpper === 'MIDDLE' && isAlly) {
            phrase = `Your mid (${champ}) is ${pk}/${pd}... got solo-killed multiple times in a row, completely tilted choom.`
          } else if (posUpper === 'BOTTOM' && isAlly) {
            phrase = `Your ADC (${champ}) is ${pk}/${pd}... positioning like a training dummy, completely lost choom.`
          } else if (isAlly) {
            phrase = `${roleLabelEn} is ${pk}/${pd}... thank chrome you are here to carry this squad, {name}.`
          } else {
            phrase = `Look at ${roleLabelEn}, ${pk}/${pd}... already tilted out of their mind spamming FF15.`
          }
        }

        this.lastOthersCommentTime = now
        this.lastPlayerAlertAt.set(pKey, now)
        this.emitGameEvent('player_feeder_alert', 'high', { customPhrase: phrase, player: champ, kills: pk, deaths: pd, isAlly, role: posUpper })
        return
      }

      // 2a'. Mid-game feeding (5+ deaths, twice their kills) — allies get roasted, enemies get mocked
      if (pd >= 5 && pd >= pk * 2 && !pMilestones.has('feed_tier5')) {
        pMilestones.add('feed_tier5')
        const phrase = lang === 'es'
          ? (isAlly
              ? `Che, ${roleLabelEs} (${champ}) va ${pk}/${pd}... ya está regalando oro como si fuera Navidad.`
              : `Jajaja ${roleLabelEs} (${champ}) va ${pk}/${pd}, es un cajero automático para nosotros.`)
          : (isAlly
              ? `Hey, ${roleLabelEn} (${champ}) is ${pk}/${pd}... handing out gold like it's Christmas.`
              : `Haha ${roleLabelEn} (${champ}) is ${pk}/${pd}, a walking ATM for us.`)
        this.lastOthersCommentTime = now
        this.lastPlayerAlertAt.set(pKey, now)
        this.emitGameEvent('player_feeder_alert', 'high', { customPhrase: phrase, player: champ, kills: pk, deaths: pd, isAlly, role: posUpper })
        return
      }

      // 2a''. A teammate is carrying
      if (isAlly && pk >= 6 && pk / Math.max(1, pd) >= 2 && !pMilestones.has('ally_carry')) {
        pMilestones.add('ally_carry')
        const phrase = lang === 'es'
          ? `Mirá a ${roleLabelEs} (${champ}), va ${pk}/${pd}... nos está carreando, hay que seguirlo.`
          : `Look at ${roleLabelEn} (${champ}), ${pk}/${pd}... they're carrying, let's follow them.`
        this.lastOthersCommentTime = now
        this.lastPlayerAlertAt.set(pKey, now)
        this.emitGameEvent('player_carrying_alert', 'high', { customPhrase: phrase, player: champ, kills: pk, deaths: pd, isAlly, role: posUpper })
        return
      }

      // Enemy Fed Alerts (Calling out when enemies are fed / "fedeados"!)
      if (!isAlly) {
        // Tier 3: Raid Boss Fed (8+ kills)
        if (pk >= 8 && !pMilestones.has('enemy_fed_tier3')) {
          pMilestones.add('enemy_fed_tier3')
          pMilestones.add('enemy_fed_tier2')
          pMilestones.add('enemy_fed_tier1')
          const phrase = lang === 'es'
            ? `¡Ese ${champ} enemigo es literalmente un raid boss, va ${pk}/${pd}! Está gigafedeado choomba... ¡un paso en falso y nos borra!`
            : `That enemy ${champ} is an absolute raid boss at ${pk}/${pd}! Gigafed out of their mind... 5-man collapse or it is over.`

          this.lastOthersCommentTime = now
          this.lastPlayerAlertAt.set(pKey, now)
          this.emitGameEvent('player_carrying_alert', 'high', { customPhrase: phrase, player: champ, kills: pk, deaths: pd, isAlly, role: posUpper })
          return
        }

        // (Tier 2 removed: three "they are fed" lines per champion was too repetitive)

        // Tier 1: Moderately Fed (3+ kills, pd <= 1)
        if (pk >= 3 && pd <= 1 && !pMilestones.has('enemy_fed_tier1')) {
          pMilestones.add('enemy_fed_tier1')
          let phrase = ''
          if (lang === 'es') {
            if (posUpper === 'TOP') {
              phrase = `Ojo {name}, el toplaner enemigo (${champ}) va ${pk}/${pd} y ya sacó ventaja en línea. Respetale el daño.`
            } else if (posUpper === 'MIDDLE' || posUpper === 'MID') {
              phrase = `Che choomba, el mid enemigo (${champ}) va ${pk}/${pd} y ya está fedeado. Cuidado con sus roams.`
            } else if (posUpper === 'UTILITY') {
              phrase = `Ojo con el soporte rival (${champ}), va ${pk}/${pd} y está ganando toda la visión del mapa.`
            } else {
              phrase = `Ojo {name}, ese ${champ} enemigo va ${pk}/${pd} y ya está fedeado. Cuidado con los intercambios.`
            }
          } else {
            if (posUpper === 'TOP') {
              phrase = `Heads up {name}, the enemy toplaner (${champ}) is ${pk}/${pd} and winning lane. Respect their trades.`
            } else if (posUpper === 'MIDDLE' || posUpper === 'MID') {
              phrase = `Watch out choomba, enemy mid (${champ}) is ${pk}/${pd} and getting fed. Track their roams!`
            } else if (posUpper === 'UTILITY') {
              phrase = `Watch out for their support (${champ}), ${pk}/${pd} and securing deep map vision.`
            } else {
              phrase = `Heads up {name}, that enemy ${champ} is sitting at ${pk}/${pd} and getting fed. Watch out in trades.`
            }
          }

          this.lastOthersCommentTime = now
          this.lastPlayerAlertAt.set(pKey, now)
          this.emitGameEvent('player_carrying_alert', 'high', { customPhrase: phrase, player: champ, kills: pk, deaths: pd, isAlly, role: posUpper })
          return
        }
      }
    }
  }

  private processEvents(events: LiveClientEvent[]): void {
    if (this.lastEventId === -1) {
      if (events.length === 0) {
        return
      }
      // If match is early (< 90s), process all events from beginning
      if (this.matchGameTime < 90) {
        this.lastEventId = -1
        console.log(`[LolLiveAdapter] Early match event stream. Processing all events from EventID 0.`)
      } else {
        // Late match join: start cursor at highest EventID to prevent backlog storm
        const maxId = events.reduce((max, ev) => Math.max(max, ev.EventID ?? -1), -1)
        this.lastEventId = maxId
        console.log(`[LolLiveAdapter] Late match join (gameTime=${this.matchGameTime}s). Initialized cursor at EventID: ${this.lastEventId}`)
        return
      }
    }

    const newEvents = events
      .filter((ev) => ev.EventID > this.lastEventId)
      .sort((a, b) => a.EventID - b.EventID)

    for (const ev of newEvents) {
      this.lastEventId = Math.max(this.lastEventId, ev.EventID)
      this.handleEvent(ev)
    }
  }

  private isKillerAlly(killerName: string | undefined): boolean {
    if (!killerName) return true
    if (this.isLocalPlayer(killerName)) return true
    if (!this.activePlayerTeam || !this.lastAllPlayers || this.lastAllPlayers.length === 0) return true

    const kLower = killerName.toLowerCase().trim()
    const kBase = kLower.split('#')[0].trim()

    const p = this.lastAllPlayers.find((pl) => {
      const s = (pl.summonerName || '').toLowerCase().trim()
      const c = (pl.championName || '').toLowerCase().trim()
      const r = (((pl as any).riotId || (pl as any).riotIdGameName) || '').toLowerCase().trim()
      return (
        (s && (s === kLower || s.split('#')[0].trim() === kBase)) ||
        (c && (c === kLower || normalizeChampionKey(c) === normalizeChampionKey(kLower))) ||
        (r && (r === kLower || r.split('#')[0].trim() === kBase))
      )
    })

    if (p) {
      return p.team === this.activePlayerTeam
    }

    // Fallback: If killer matches any known enemy champion, it is an enemy
    if (this.enemyChampions.some((ec) => ec.toLowerCase() === kLower || normalizeChampionKey(ec) === normalizeChampionKey(kLower))) {
      return false
    }

    return true
  }

  private isLocalPlayerJungler(): boolean {
    if (!this.matchedPlayer) return false
    const pos = (this.matchedPlayer.position || '').toUpperCase()
    if (pos === 'JUNGLE') return true
    const spells = JSON.stringify(this.matchedPlayer.summonerSpells || {}).toLowerCase()
    return spells.includes('smite')
  }

  private getEnemyJungler(): LiveClientPlayer | null {
    if (!this.lastAllPlayers || this.lastAllPlayers.length === 0 || !this.activePlayerTeam) return null
    return this.lastAllPlayers.find((p) => {
      if (p.team === this.activePlayerTeam) return false
      const pos = (p.position || '').toUpperCase()
      if (pos === 'JUNGLE') return true
      const spells = JSON.stringify(p.summonerSpells || {}).toLowerCase()
      return spells.includes('smite')
    }) || null
  }

  private isEnemyJungler(name: string | undefined): boolean {
    if (!name) return false
    const jg = this.getEnemyJungler()
    if (!jg) return false

    const nLower = name.toLowerCase().trim()
    const nBase = nLower.split('#')[0].trim()

    const jgSummoner = (jg.summonerName || '').toLowerCase().trim()
    const jgChamp = (jg.championName || '').toLowerCase().trim()
    const jgRaw = (jg.rawChampionName || '').toLowerCase().trim()
    const jgRiotId = (((jg as any).riotId || (jg as any).riotIdGameName) || '').toLowerCase().trim()

    return (
      (jgSummoner && (jgSummoner === nLower || jgSummoner.split('#')[0].trim() === nBase)) ||
      (jgChamp && (jgChamp === nLower || normalizeChampionKey(jgChamp) === normalizeChampionKey(nLower))) ||
      (jgRaw && jgRaw.includes(nLower)) ||
      (jgRiotId && (jgRiotId === nLower || jgRiotId.split('#')[0].trim() === nBase))
    )
  }

  private handleEvent(ev: LiveClientEvent): void {
    const isMeKiller = this.isLocalPlayer(ev.KillerName)
    const isMeVictim = this.isLocalPlayer(ev.VictimName)

    switch (ev.EventName) {
      case 'GameStart': {
        const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'
        const startLinesEs = [
          '¡Partida en marcha en la Grieta del Invocador! A farmear bien y reventar ese nexo, {name}.',
          '¡Bienvenidos a la Grieta! Conectada a tu HUD, choomba. Vamos a ganar esta partida.',
          '¡Sistemas en línea para la Grieta! A ganar esa línea y stompear el mapa, choom.'
        ]
        const startLinesEn = [
          'Match started on Summoner\'s Rift! Farm clean and shatter that nexus, {name}!',
          'Welcome to the Rift! HUD synchronized, choomba. Let us take this win!',
          'Systems live on Summoner\'s Rift! Win that lane and stomp the map, {name}.'
        ]
        const phrase = lang === 'es'
          ? startLinesEs[Math.floor(Math.random() * startLinesEs.length)]
          : startLinesEn[Math.floor(Math.random() * startLinesEn.length)]

        this.emitGameEvent('match_started', 'high', {
          gameTime: ev.EventTime,
          customPhrase: phrase
        })
        break
      }

      case 'ChampionKill':
        if (isMeKiller) {
          console.log(`[LolLiveAdapter] EventStream: LOCAL PLAYER SCORED A KILL against ${ev.VictimName}!`)
          this.emitGameEvent('player_kill', 'high', {
            victim: ev.VictimName,
            killer: ev.KillerName
          })
        } else if (isMeVictim) {
          console.log(`[LolLiveAdapter] EventStream: LOCAL PLAYER DIED to ${ev.KillerName}!`)
          const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'
          const isKilledByEnemyJg = this.isEnemyJungler(ev.KillerName)
          const isAssistedByEnemyJg = Array.isArray(ev.Assisters) && ev.Assisters.some((a) => this.isEnemyJungler(a))

          let gankDiffPhrase: string | undefined = undefined
          if (isKilledByEnemyJg || isAssistedByEnemyJg) {
            if (lang === 'es') {
              const diffLines = isKilledByEnemyJg
                ? [
                    '¡Te cayó el jungla rival! Qué jungla diff por favor, el nuestro durmiendo la siesta en los lobos.',
                    'Nos mató el jungla enemigo... tremendo jungla diff, gankea todas las líneas y el nuestro no aparece.',
                    '¡Jungla diff total! Te vino a cazar el jungla rival mientras tu jungla está afk farmeando sapitos.'
                  ]
                : [
                    '¡Te gankearon entre dos con el jungla rival! Qué jungla diff, ni un counter-gank nos tiraron.',
                    'Nos cayó el jungla enemigo a la línea... qué jungla diff, no tenemos presencia en el mapa.',
                    'Te cayó el jungla rival de la nada... jungla diff cantado choomba.'
                  ]
              gankDiffPhrase = diffLines[Math.floor(Math.random() * diffLines.length)]
            } else {
              const diffLines = isKilledByEnemyJg
                ? [
                    'Enemy jungler collapsed on you! Absolute jungle diff, where is our smite player?!',
                    'Taken down by their jungler! Huge jungle diff, they are ganking everywhere while ours is sleeping!',
                    'Total jungle diff! Their jungler living in our lane while ours is farming wolves haha!'
                  ]
                : [
                    '2v1 gank with the enemy jungler! Massive jungle diff, zero counter-gank from our squad.',
                    'Enemy jungler showed up to seal the kill... pure jungle diff in full effect, {name}.',
                    'Ganked by their jungler! Complete jungle diff on the Rift today, choom.'
                  ]
              gankDiffPhrase = diffLines[Math.floor(Math.random() * diffLines.length)]
            }
          }

          // Explicit facts for the commentator: who killed {name} and whether the jungler was involved
          const enemyJg = this.getEnemyJungler()
          this.emitGameEvent('player_died', 'critical', {
            killer: ev.KillerName,
            victim: ev.VictimName,
            gank: isKilledByEnemyJg || isAssistedByEnemyJg,
            jungler: enemyJg?.championName,
            customPhrase: gankDiffPhrase
          })
        }
        break

      case 'Multikill':
        if (isMeKiller) {
          const count = ev.KillStreak || 2
          console.log(`[LolLiveAdapter] EventStream: LOCAL PLAYER MULTIKILL (x${count})!`)
          this.emitGameEvent('multikill', 'critical', {
            multikillCount: count,
            killer: ev.KillerName
          })
        }
        break

      case 'DragonKill':
      case 'BaronKill':
      case 'HeraldKill':
      case 'HordeKill':
      case 'AtakhanKill': {
        const lang0 = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'
        const dragonTypes: Record<string, [string, string]> = {
          Fire: ['Dragón Infernal', 'Infernal Drake'],
          Earth: ['Dragón de Montaña', 'Mountain Drake'],
          Water: ['Dragón del Océano', 'Ocean Drake'],
          Air: ['Dragón de Nubes', 'Cloud Drake'],
          Hextech: ['Dragón Hextech', 'Hextech Drake'],
          Chemtech: ['Dragón Quimtech', 'Chemtech Drake'],
          Elder: ['Dragón Ancestral', 'Elder Dragon']
        }
        const pick = (es: string, en: string) => (lang0 === 'es' ? es : en)
        const objName =
          ev.EventName === 'DragonKill'
            ? dragonTypes[ev.DragonType || '']
              ? pick(...dragonTypes[ev.DragonType || ''])
              : pick('Dragón', 'Dragon')
            : ev.EventName === 'BaronKill'
              ? pick('Barón Nashor', 'Baron Nashor')
              : ev.EventName === 'HeraldKill'
                ? pick('Heraldo de la Grieta', 'Rift Herald')
                : ev.EventName === 'HordeKill'
                  ? pick('Larvas del Vacío', 'Voidgrubs')
                  : ev.EventName === 'AtakhanKill'
                    ? 'Atakhan'
                    : ev.MonsterType || pick('objetivo', 'objective')

        // Epic monsters cannot die before they spawn: ignore anything earlier (stale/replayed events)
        const spawnSec: Record<string, number> = { DragonKill: 290, HordeKill: 290, HeraldKill: 830, BaronKill: 1190, AtakhanKill: 1190 }
        const evTime = Number(ev.EventTime ?? this.matchGameTime)
        if (evTime < (spawnSec[ev.EventName] ?? 0) || evTime > this.matchGameTime + 30) {
          console.log(`[LolLiveAdapter] Ignoring implausible ${ev.EventName} at ${evTime}s (game time ${this.matchGameTime}s)`)
          break
        }
        const isAlly = this.isKillerAlly(ev.KillerName)
        const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'

        if (!isAlly) {
          // enemy secured / stole the objective. Call out jungle diff
          const isPlayerJg = this.isLocalPlayerJungler()
          let phrase = ''

          if (lang === 'es') {
            if (isPlayerJg) {
              const lines = [
                `¡Uff {name}, nos robaron el ${objName}! A guardar ese smite con más cariño para la próxima choomba.`,
                `¡Nos ganaron el smite en el ${objName}, choomba! No pasa nada, a defender con todo ahora.`
              ]
              phrase = lines[Math.floor(Math.random() * lines.length)]
            } else {
              const lines = [
                `¡Nos robaron el ${objName}! Qué jungla diff por favor, ni apareció con el smite.`,
                `El rival se llevó el ${objName}... jungla diff total choomba, qué desastre.`,
                `¡Se llevaron el ${objName} los rivales! Tremendo jungla diff, nos están regalando los objetivos.`,
                `Perdimos el ${objName}... qué jungla diff, no metió ni las manos.`
              ]
              phrase = lines[Math.floor(Math.random() * lines.length)]
            }
          } else {
            if (isPlayerJg) {
              const lines = [
                `Oof {name}, they stole the ${objName}! Save that smite timing for next time, choomba.`,
                `Out-smited on the ${objName}! Shake it off {name}, fall back and hold!`
              ]
              phrase = lines[Math.floor(Math.random() * lines.length)]
            } else {
              const lines = [
                `Enemy secured the ${objName}! Absolute jungle diff, didn't even contest with smite!`,
                `They stole the ${objName}... huge jungle diff on display, choomba.`,
                `Lost the ${objName}! Massive jungle diff, completely out-smited.`
              ]
              phrase = lines[Math.floor(Math.random() * lines.length)]
            }
          }

          console.log(`[LolLiveAdapter] Objective LOST to enemy team (${ev.KillerName}): "${phrase}"`)
          this.emitGameEvent('objective_lost', 'high', {
            objective: objName,
            objectiveEvent: ev.EventName,
            stolen: ev.Stolen === 'True' || (ev as any).Stolen === true,
            killer: ev.KillerName,
            customPhrase: phrase
          })
        } else {
          // ally secured the objective. Celebrate
          const phrasesEs = [
            `¡${objName} asegurado para el equipo! Ventaja táctica nuestra, choomba.`,
            `¡Gran objetivo capturado! Se siente el dominio en el mapa, {name}.`,
            `¡${objName} para casa! Impecable control de mapa choom.`
          ]
          const phrasesEn = [
            `${objName} secured! Tactical advantage is ours, choomba.`,
            `Major objective taken! Clean control on the Rift, {name}.`,
            `${objName} secured for our team! Huge play, choom.`
          ]
          const phrase = lang === 'es'
            ? phrasesEs[Math.floor(Math.random() * phrasesEs.length)]
            : phrasesEn[Math.floor(Math.random() * phrasesEn.length)]

          console.log(`[LolLiveAdapter] Objective SECURED by ally team (${ev.KillerName}): "${phrase}"`)
          this.emitGameEvent('objective_taken', 'normal', {
            objective: objName,
            objectiveEvent: ev.EventName,
            killer: ev.KillerName,
            customPhrase: phrase
          })
        }
        break
      }

      case 'TurretKilled':
      case 'InhibKilled': {
        const isAlly = this.isKillerAlly(ev.KillerName)
        const isTurret = ev.EventName === 'TurretKilled'
        const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'

        if (isAlly) {
          const phrase = lang === 'es'
            ? (isTurret ? '¡Torre enemiga destruida! Seguimos abriendo el mapa, choomba.' : '¡Inhibidor enemigo caído! Superminions marchando a su nexo, {name}.')
            : (isTurret ? 'Enemy turret destroyed! Cracking open their base, choomba.' : 'Enemy inhibitor down! Super minions marching into their nexus, {name}.')
          this.emitGameEvent('objective_taken', 'normal', {
            objective: isTurret ? 'Torre' : 'Inhibidor',
            killer: ev.KillerName,
            customPhrase: phrase
          })
        } else {
          const phrase = lang === 'es'
            ? (isTurret ? 'Nos tiraron una torre... a replegarse y limpiar las oleadas, choomba.' : '¡Nos rompieron el inhibidor! A defender el nexo con la vida, {name}.')
            : (isTurret ? 'We lost a turret... fall back and clear the waves, choomba.' : 'Our inhibitor is down! Defend the nexus with everything, {name}.')
          this.emitGameEvent('objective_lost', 'high', {
            objective: isTurret ? 'Torre' : 'Inhibidor',
            killer: ev.KillerName,
            customPhrase: phrase
          })
        }
        break
      }

      case 'GameEnd': {
        const res = (ev.Result || '').toLowerCase()
        const isWin = res.includes('win') || res.includes('vic')
        const lang = consciousnessService.getPreferredLanguage() === 'es' ? 'es' : 'en'

        let phrase = ''
        if (isWin) {
          const winPhrasesEs = [
            '¡Victoria épica, choomba! Destruimos ese nexo y ganamos la partida. ¡Excelente trabajo en equipo, {name}!',
            '¡GG choomba, partida ganada! Explotó el nexo rival, sos una máquina letal {name}.',
            '¡Victoria para nosotros! Partidaza en la Grieta, nos llevamos esos puntos de liga bien merecidos choom.'
          ]
          const winPhrasesEn = [
            'Victory, choomba! Enemy nexus shattered into pieces! Fantastic match, {name}!',
            'GG, victory is ours! We smashed their nexus clean, lethal performance {name}!',
            'We won! Absolute domination on Summoner\'s Rift today, enjoy those league points choom!'
          ]
          phrase = lang === 'es'
            ? winPhrasesEs[Math.floor(Math.random() * winPhrasesEs.length)]
            : winPhrasesEn[Math.floor(Math.random() * winPhrasesEn.length)]
        } else {
          const losePhrasesEs = [
            'Derrota, choomba... Nos rompieron el nexo. No pasa nada, a enfriar el ciberware y remontamos en la próxima.',
            'Partida perdida, choom... Se nos fue de las manos al final. A resetear la cabeza y a ganar la que viene.',
            'Cayó nuestro nexo, {name}... Derrota amarga pero buen intento. ¡La próxima nos cobramos venganza!'
          ]
          const losePhrasesEn = [
            'Defeat, choomba... They shattered our nexus. Shake it off, cool your chrome and we run it back next game!',
            'Tough loss, {name}... Slipped away from us in the late game. Clear your head and let\'s queue up again.',
            'Nexus destroyed, defeat this time... Shake the dust off {name}, revenge is on the menu next match!'
          ]
          phrase = lang === 'es'
            ? losePhrasesEs[Math.floor(Math.random() * losePhrasesEs.length)]
            : losePhrasesEn[Math.floor(Math.random() * losePhrasesEn.length)]
        }

        console.log(`[LolLiveAdapter] Match ended: ${isWin ? 'VICTORY' : 'DEFEAT'} -> "${phrase}"`)
        this.emitGameEvent('match_ended', 'high', {
          result: ev.Result,
          isWin,
          customPhrase: phrase
        })
        setTimeout(() => this.stop(), 3000)
        break
      }

      default:
        break
    }
  }

  private emitGameEvent(type: GameEventType, priority: GameEventPriority, payload: any = {}): void {
    const gameEvent: GameEvent = {
      id: `lol_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      gameId: 'lol',
      type,
      priority,
      payload,
      timestamp: Date.now()
    }

    // Keep streaks / predictions up to date even for events that end up not being spoken
    try {
      lolCommentator.observe(gameEvent)
    } catch (err) {
      console.warn('[LolLiveAdapter] Commentator observe failed:', err)
    }

    this.emit('game_event', gameEvent)
  }

  private async request<T>(endpoint: string, timeoutMs = 1500): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: 2999,
          path: endpoint,
          method: 'GET',
          agent: httpsAgent,
          timeout: timeoutMs,
          headers: {
            Accept: 'application/json'
          }
        },
        (res) => {
          let rawData = ''
          res.on('data', (chunk) => {
            rawData += chunk
          })
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(rawData)
                resolve(parsed as T)
              } catch (parseErr: any) {
                if (typeof rawData === 'string' && rawData.trim().length > 0) {
                  resolve(rawData.trim() as any)
                } else {
                  reject(new Error(`Failed to parse JSON: ${parseErr.message}`))
                }
              }
            } else {
              reject(new Error(`HTTP status ${res.statusCode}`))
            }
          })
        }
      )

      req.on('timeout', () => {
        req.destroy(new Error('Request timed out'))
      })

      req.on('error', (err) => {
        reject(err)
      })

      req.end()
    })
  }
}

export const lolLiveAdapter = LolLiveAdapter.getInstance()
lolCommentator.setSnapshotProvider(() => lolLiveAdapter.getSnapshot())
