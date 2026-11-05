import { localizeLine } from '../../../../../shared/lines'
import { LANGUAGE_NAMES } from '../../game-commentary'
import { isRemoteMode, llmFetch } from '../../../llm-gateway'
import { llmBody } from '../../../user-profile'
/**
 * LLM-written League of Legends commentary. Each event is turned into a short facts prompt
 * and the local model writes the line; the adapter's template is the fallback if it's slow.
 * Also tracks matchup predictions ("can we beat that Garen?") to follow up on them.
 */

import { agentManager } from '../../../../agents/agent-manager'
import { consciousnessService } from '../../../consciousness-service'
import { normalizeChampionKey } from './champion-reactions'
import type { GameEvent } from '../../types'

export interface LolPlayerSnapshot {
  champion: string
  summonerName: string
  riotId?: string
  team: string
  position: string
  level: number
  kills: number
  deaths: number
  assists: number
  cs: number
  itemGold: number
  isDead: boolean
}

export interface LolMatchSnapshot {
  gameTimeSec: number
  me: LolPlayerSnapshot | null
  allies: LolPlayerSnapshot[]
  enemies: LolPlayerSnapshot[]
}

type Verdict = 'yes' | 'no' | 'even'

interface Prediction {
  champion: string
  verdict: Verdict
  at: number
  teased: boolean
  resolved: boolean
}

const EMOTION_TAGS = ['[excited]', '[laugh]', '[giggles]', '[playful]', '[teasing]', '[angry]', '[sad]', '[surprised]', '[proud]', '[worried]']
const STREAK_NAMES: Record<number, string> = { 3: 'Killing Spree', 4: 'Rampage', 5: 'Unstoppable', 6: 'Dominating', 7: 'Godlike', 8: 'Legendary' }

export class LolCommentator {
  private static instance: LolCommentator

  private snapshotProvider: (() => LolMatchSnapshot) | null = null
  private predictions: Prediction[] = []
  private killsAtLastDeath = 0
  private lastAnnouncedStreak = 0
  private pendingContext: string[] = []
  private teaseTimer: NodeJS.Timeout | null = null
  private modelCache: { model: string; at: number } | null = null
  // The score tracker reports kills/deaths without names; the event feed (a moment later) has them
  private lastVictim: { champion: string; at: number } | null = null
  private lastKiller: { champion: string; at: number } | null = null
  private lastDeath: { killerRaw: string; killer: string | null; gank: boolean; jungler: string | null; at: number } | null = null

  public static getInstance(): LolCommentator {
    if (!LolCommentator.instance) LolCommentator.instance = new LolCommentator()
    return LolCommentator.instance
  }

  public setSnapshotProvider(fn: () => LolMatchSnapshot): void {
    this.snapshotProvider = fn
  }

  private snapshot(): LolMatchSnapshot {
    return this.snapshotProvider ? this.snapshotProvider() : { gameTimeSec: 0, me: null, allies: [], enemies: [] }
  }

  private lang(): string {
    return consciousnessService.getPreferredLanguage() || 'en'
  }

  // State tracking (called for every LoL event, even ones that end up not spoken)

  public resetMatch(): void {
    this.predictions = []
    this.killsAtLastDeath = 0
    this.lastAnnouncedStreak = 0
    this.pendingContext = []
    if (this.teaseTimer) {
      clearInterval(this.teaseTimer)
      this.teaseTimer = null
    }
  }

  /** Loads the model into VRAM ahead of time (a cold 14b load can take ~100s on first use) */
  private warmedAt = 0
  private warmup(): void {
    if (isRemoteMode() || Date.now() - this.warmedAt < 15 * 60 * 1000) return
    this.warmedAt = Date.now()
    const base = this.ollamaBase()
    this.resolveModel(base)
      .then((model) => {
        if (!model) return
        console.log(`[LolCommentator] Warming up ${model} for live commentary...`)
        return llmFetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: llmBody({ model, stream: false, keep_alive: '20m', messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 1 } })
        })
      })
      .catch(() => {})
  }

  public observe(event: GameEvent): void {
    this.warmup()
    const snap = this.snapshot()
    const myKills = Math.max(snap.me?.kills ?? 0, Number(event.payload?.kills ?? 0))

    if (event.type === 'match_started') {
      this.resetMatch()
      this.ensureTeaseLoop()
      return
    }
    if (event.type === 'match_ended') {
      this.resetMatch()
      return
    }
    this.ensureTeaseLoop()

    if (event.type === 'player_kill') {
      const streak = myKills - this.killsAtLastDeath
      if (streak >= 3 && streak > this.lastAnnouncedStreak) {
        this.lastAnnouncedStreak = streak
        const name = STREAK_NAMES[Math.min(streak, 8)] || 'Legendary'
        this.pendingContext.push(`{name} is on a ${streak}-kill streak without dying (${name}!). Hype it up.`)
      }
      const victimChamp = this.championOf(event.payload?.victim, snap)
      if (victimChamp) this.lastVictim = { champion: victimChamp, at: Date.now() }
      if (victimChamp) {
        const p = this.findPrediction(victimChamp)
        if (p && !p.resolved) {
          p.resolved = true
          this.pendingContext.push(
            p.verdict === 'no'
              ? `Earlier you told {name} they could NOT beat ${victimChamp}, but {name} just killed them. Admit you were wrong, impressed.`
              : `Earlier you told {name} they could beat ${victimChamp}, and {name} just killed them. Gloat: "I told you so!".`
          )
        }
      }
    }

    if (event.type === 'player_died') {
      const streak = myKills - this.killsAtLastDeath
      if (streak >= 3) {
        this.pendingContext.push(`{name}'s ${streak}-kill streak just got shut down. React to losing the streak.`)
      }
      this.killsAtLastDeath = myKills
      this.lastAnnouncedStreak = 0

      const killerChamp = this.championOf(event.payload?.killer, snap)
      if (killerChamp) this.lastKiller = { champion: killerChamp, at: Date.now() }
      if (event.payload?.killer) {
        this.lastDeath = {
          killerRaw: String(event.payload.killer),
          killer: killerChamp,
          gank: !!event.payload.gank,
          jungler: event.payload.jungler || null,
          at: Date.now()
        }
      }
      if (killerChamp) {
        const p = this.findPrediction(killerChamp)
        if (p && !p.resolved) {
          p.resolved = true
          this.pendingContext.push(
            p.verdict === 'no'
              ? `You warned {name} not to fight ${killerChamp}, and ${killerChamp} just killed {name}. Say "I told you!" teasingly.`
              : `You hyped {name} up saying they could beat ${killerChamp}, but ${killerChamp} just killed {name}. Be embarrassed / roast {name} for blowing it.`
          )
        }
      }
    }
  }

  private championOf(name: string | undefined, snap: LolMatchSnapshot): string | null {
    if (!name) return null
    const n = String(name).toLowerCase().split('#')[0].trim()
    const all = [...snap.enemies, ...snap.allies]
    const byName = all.find((p) => {
      const s = (p.summonerName || '').toLowerCase().split('#')[0].trim()
      const r = (p.riotId || '').toLowerCase().split('#')[0].trim()
      return (s && s === n) || (r && r === n)
    })
    if (byName) return byName.champion
    const byChamp = all.find((p) => normalizeChampionKey(p.champion) === normalizeChampionKey(n))
    return byChamp ? byChamp.champion : null
  }

  private roleOf(champion: string, snap: LolMatchSnapshot): string | null {
    const key = normalizeChampionKey(champion)
    const p = [...snap.enemies, ...snap.allies].find((x) => normalizeChampionKey(x.champion) === key)
    const roles: Record<string, string> = { TOP: 'top laner', JUNGLE: 'jungler', MIDDLE: 'mid laner', BOTTOM: 'ADC', UTILITY: 'support' }
    return p?.position ? roles[p.position.toUpperCase()] || null : null
  }

  private recent(x: { champion: string; at: number } | null): string | null {
    return x && Date.now() - x.at < 6000 ? x.champion : null
  }

  private findPrediction(champion: string): Prediction | undefined {
    const key = normalizeChampionKey(champion)
    return [...this.predictions].reverse().find((p) => normalizeChampionKey(p.champion) === key)
  }

  // Event narration

  /** Returns the line to speak for this event: LLM-written, or the fallback if the LLM is slow/unavailable. */
  public async narrate(event: GameEvent, fallback: string): Promise<string> {
    // Item counters are kept verbatim; with no extreme comp the LLM gives a concrete build tip
    if (event.type === 'enemy_team_known') {
      if (!event.payload?.buildTip) return fallback
      const snap = this.snapshot()
      if (!snap.me) return fallback
      const myPos = (snap.me.position || '').toUpperCase()
      const laneOpp = myPos && myPos !== 'JUNGLE' ? snap.enemies.find((e) => (e.position || '').toUpperCase() === myPos) : undefined
      const jungler = snap.enemies.find((e) => (e.position || '').toUpperCase() === 'JUNGLE')
      const user = [
        `MATCH START. {name} plays ${snap.me.champion} (${snap.me.position || 'unknown role'}).`,
        laneOpp ? `LANE OPPONENT: ${laneOpp.champion}.` : '',
        jungler && jungler !== laneOpp ? `ENEMY JUNGLER: ${jungler.champion}.` : '',
        `Give {name} ONE short gameplay tip: how to play against ${laneOpp ? laneOpp.champion : 'their team'}${jungler && jungler !== laneOpp ? ` and when to watch out for ${jungler.champion}` : ''}. Only mention those champions. Do NOT name items, runes or abilities. Add a short hype. Max 30 words.`
      ]
        .filter(Boolean)
        .join('\n')
      const tip = await this.llm(this.systemPrompt(), user, 6000, 90)
      return tip || fallback
    }

    // Name-less kill/death from the score tracker: give the event feed a moment to name the champion
    if ((event.type === 'player_kill' && !event.payload?.victim) || (event.type === 'player_died' && !event.payload?.killer)) {
      await new Promise((r) => setTimeout(r, 1300))
    }

    const description = this.describeEvent(event)
    if (!description) return fallback

    const extra = this.pendingContext.splice(0)
    const user = [
      this.matchFacts(),
      `EVENT: ${description}`,
      ...extra.map((c) => `CONTEXT: ${c}`),
      fallback ? `Vibe reference (do NOT copy it, write your own): "${stripTags(localizeLine(fallback, this.lang()))}"` : '',
      'Say your one line now.'
    ]
      .filter(Boolean)
      .join('\n')

    const line = await this.llm(this.systemPrompt(), user, 4200, 70)
    return line || fallback
  }

  private describeEvent(event: GameEvent): string | null {
    const p = event.payload || {}
    const snap = this.snapshot()
    switch (event.type) {
      case 'player_kill': {
        const victim = this.championOf(p.victim, snap) || this.recent(this.lastVictim)
        const role = victim ? this.roleOf(victim, snap) : null
        return victim ? `{name} just killed the enemy ${victim}${role ? ` (their ${role})` : ''}.` : '{name} just got a kill.'
      }
      case 'player_died': {
        const d = p.killer
          ? { killerRaw: String(p.killer), killer: this.championOf(p.killer, snap), gank: !!p.gank, jungler: p.jungler || null }
          : this.lastDeath && Date.now() - this.lastDeath.at < 6000
            ? this.lastDeath
            : null
        if (!d) return '{name} just died.'
        if (!d.killer) {
          const what = /turret|tower/i.test(d.killerRaw) ? 'a turret' : /minion/i.test(d.killerRaw) ? 'minions' : /baron|dragon|herald|horde|atakhan|sru_/i.test(d.killerRaw) ? 'a jungle monster' : 'something that is not a champion'
          return `{name} just died to ${what} (no enemy champion got the kill).`
        }
        const role = this.roleOf(d.killer, snap)
        let text = `{name} just died; the kill went to the enemy ${d.killer}${role ? ` (their ${role})` : ''}.`
        if (d.gank && d.jungler && d.jungler !== d.killer) text += ` Their jungler ${d.jungler} came to help (a gank). Our jungler did not show up.`
        else if (d.gank && d.jungler === d.killer) text += ` ${d.killer} is their jungler and ganked {name}'s lane.`
        return text
      }
      case 'multikill':
        return `{name} just got a ${({ 2: 'DOUBLE', 3: 'TRIPLE', 4: 'QUADRA', 5: 'PENTA' } as any)[p.multikillCount] || 'MULTI'} KILL!`
      case 'objective_taken':
        return `Our team ({name}'s allies) just secured the ${p.objective || 'objective'}.`
      case 'objective_lost':
        return `The ENEMY team just took the ${p.objective || 'objective'}${p.stolen ? ' (they stole it with smite!)' : ''}.`
      case 'kda_praise':
        return `{name} is doing great: KDA ${p.kills ?? '?'} kills / ${p.deaths ?? '?'} deaths. Praise them.`
      case 'kda_roast':
        return `{name} is doing badly: ${p.kills ?? '?'} kills / ${p.deaths ?? '?'} deaths. Roast them affectionately.`
      case 'player_feeder_alert': {
        const who = `${p.isAlly === false ? 'the ENEMY' : p.isAlly ? 'our TEAMMATE' : 'the'} ${p.player || 'champion'}${p.role ? ` (${String(p.role).toLowerCase()})` : ''}`
        return p.isAlly === false
          ? `${who} is feeding hard at ${p.kills ?? '?'}/${p.deaths ?? '?'}. Mock the enemy, they're free gold for us.`
          : `${who} is feeding hard at ${p.kills ?? '?'}/${p.deaths ?? '?'}. Roast our teammate (to {name}, not to them), funny and savage.`
      }
      case 'player_carrying_alert': {
        const who = `${p.isAlly === false ? 'the ENEMY' : p.isAlly ? 'our TEAMMATE' : 'the'} ${p.player || 'champion'}${p.role ? ` (${String(p.role).toLowerCase()})` : ''}`
        return p.isAlly === false
          ? `${who} is super fed at ${p.kills ?? '?'}/${p.deaths ?? '?'}. Warn {name} to be careful with them.`
          : `${who} is carrying at ${p.kills ?? '?'}/${p.deaths ?? '?'}. Hype our teammate up.`
      }
      case 'match_started':
        return 'The match just started on Summoner\'s Rift. Pump {name} up.'
      case 'match_ended':
        return p.isWin ? 'We WON the match! Celebrate.' : 'We LOST the match. Console {name} with some sass.'
      default:
        return null
    }
  }

  // "Can we beat that Garen?"

  /** Answers a matchup question if the text names an enemy champion; null otherwise. */
  public async assessMatchup(query: string): Promise<string | null> {
    const snap = this.snapshot()
    if (!snap.me || snap.enemies.length === 0) return null

    const q = normalizeChampionKey(query)
    const enemy = snap.enemies.find((e) => {
      const k = normalizeChampionKey(e.champion)
      return k.length >= 3 && q.includes(k)
    })
    if (!enemy) return null

    const me = snap.me
    const levelDiff = me.level - enemy.level
    const goldDiff = me.itemGold - enemy.itemGold
    const myForm = me.kills - me.deaths
    const theirForm = enemy.kills - enemy.deaths
    const score = levelDiff * 1.5 + (goldDiff / 1000) * 1.3 + (myForm - theirForm) * 0.6
    const verdict: Verdict = score >= 1.5 ? 'yes' : score <= -1.5 ? 'no' : 'even'

    this.predictions.push({ champion: enemy.champion, verdict, at: Date.now(), teased: false, resolved: false })
    this.ensureTeaseLoop()

    const facts = [
      this.matchFacts(),
      `QUESTION: {name} asks whether they can win a fight against the enemy ${enemy.champion}.`,
      `NUMBERS: {name} lvl ${me.level} vs ${enemy.champion} lvl ${enemy.level}; item gold ${me.itemGold} vs ${enemy.itemGold} (${goldDiff >= 0 ? '+' : ''}${goldDiff}); KDA ${me.kills}/${me.deaths}/${me.assists} vs ${enemy.kills}/${enemy.deaths}/${enemy.assists}.`,
      verdict === 'yes'
        ? 'VERDICT: YES, {name} is ahead. Be hyped and confident ("we are so fed, LET\'S GO!"), mention one concrete advantage.'
        : verdict === 'no'
          ? 'VERDICT: NO, {name} is behind. Warn them not to fight alone, mention one concrete disadvantage, tease a bit.'
          : 'VERDICT: EVEN, it is a coin flip. Say it depends on skill/cooldowns, playful and a bit risky.',
      'Answer in 1-2 short spoken sentences (max 30 words).'
    ].join('\n')

    const line = await this.llm(this.systemPrompt(), facts, 7000, 90)
    if (line) return line

    const lang = this.lang()
    const champ = enemy.champion
    if (verdict === 'yes') {
      return lang === 'es'
        ? `[excited] ¡Siii, obvio que podemos contra ese ${champ}! Vamos muy fedeados, ¡VAMOS!`
        : `[excited] Oh, we can SO take that ${champ}! We're fed as hell, LET'S GO!`
    }
    if (verdict === 'no') {
      return lang === 'es'
        ? `[worried] Ni se te ocurra, choomba. Ese ${champ} está más fuerte que nosotros, esperá al equipo.`
        : `[worried] Don't even think about it, choom. That ${champ} is ahead of us, wait for the team.`
    }
    return lang === 'es'
      ? `[playful] Moneda al aire contra ese ${champ}... si le pegás bien las habilidades, es nuestro.`
      : `[playful] Coin flip against that ${champ}... land your skills and it's ours.`
  }

  /** If {name} was told "you can beat X" and never went for it, tease after a few minutes. */
  private ensureTeaseLoop(): void {
    if (this.teaseTimer) return
    this.teaseTimer = setInterval(() => {
      const now = Date.now()
      const p = this.predictions.find((x) => x.verdict === 'yes' && !x.resolved && !x.teased && now - x.at > 4 * 60 * 1000)
      if (!p) return
      p.teased = true
      const user = [
        this.matchFacts(),
        `CONTEXT: Minutes ago you told {name} they could beat the enemy ${p.champion}, but {name} still hasn't killed them.`,
        `Tease {name}: why haven't you killed that ${p.champion} yet?! One short line.`
      ].join('\n')
      this.llm(this.systemPrompt(), user, 6000, 60)
        .then((line) => {
          const lang = this.lang()
          const text =
            line ||
            (lang === 'es'
              ? `[teasing] Che, ¿y ese ${p.champion}? Te dije que le ganábamos y todavía está vivo...`
              : `[teasing] Hey, what about that ${p.champion}? I said we could take them and they're still breathing...`)
          agentManager.setCompanionSpeech(text, Math.min(10000, Math.max(3000, text.length * 60)), true)
        })
        .catch(() => {})
    }, 20 * 1000)
  }

  // Prompting

  private systemPrompt(): string {
    const lang = this.lang()
    const language =
      lang === 'es'
        ? 'Rioplatense Argentine Spanish with voseo (vos, tenés, mirá), casual gamer slang mixed with a bit of Night City slang (choom, choomba, preem)'
        : lang === 'en' || !LANGUAGE_NAMES[lang]
          ? 'casual English with Night City slang (choom, choomba, preem, gonk)'
          : `casual ${LANGUAGE_NAMES[lang]}, keeping Night City slang (choom, choomba, preem, gonk). Everything you write must be in ${LANGUAGE_NAMES[lang]}, even though the examples and EVENT lines are in English`
    return [
      'You are Capri, a sassy, playful cyberpunk netrunner girl who lives on {name}\'s desktop and is watching {name} play League of Legends LIVE, like a best friend on voice chat.',
      'You cheer, trash-talk the enemies, celebrate big plays, and roast {name} when they play badly, always with affection and humor.',
      '{name} is the one playing; you are only watching. Talk TO {name} in second person, never as if you got the kill yourself.',
      'Call the player {name}, choom or choomba. You can mention the champion they play ("con tu Fizz", "your Fizz", "nuestro Fizz"), but the champion is NOT their name: do not address them by it.',
      `Write in ${language}.`,
      `Reply with exactly ONE short spoken line (max 22 words) that starts with exactly one emotion tag from: ${EMOTION_TAGS.join(' ')}.`,
      'Use the real champion names and numbers given. Never invent stats. No emojis, no hashtags, no quotes, no narration, no "Capri:" prefix.',
      'When roasting or something is funny you may put [laugh] or [giggles] where you laugh; never write "jaja"/"haha" yourself.',
      'Only mention champions that appear in the EVENT or CONTEXT lines; never bring up other champions. Never call someone a jungler or say they ganked unless the EVENT says so.',
      'Talk ONLY about what the EVENT says. Never mention dragons, baron, towers or any objective unless the EVENT is about that exact objective.',
      'Vary your wording every time; never repeat the vibe reference literally.'
    ].join(' ')
  }

  /** Two short examples so small local models nail the format (tag + one line, no emojis) */
  private fewShot(): { role: 'user' | 'assistant'; content: string }[] {
    const es = this.lang() === 'es'
    return [
      {
        role: 'user',
        content: 'MATCH: minute 8. {name} plays Jinx (BOTTOM), lvl 7, KDA 0/3/1.\nEVENT: {name} just died to the enemy Draven.\nSay your one line now.'
      },
      {
        role: 'assistant',
        content: es
          ? '[laugh] ¡Otra vez Draven, {name}! Vas cero y tres, dejá de regalarle hachas a ese payaso.'
          : '[laugh] Draven again, {name}?! Zero and three, stop handing that clown free axes!'
      },
      {
        role: 'user',
        content: 'MATCH: minute 21. {name} plays Yasuo (MIDDLE), lvl 15, KDA 9/2/4.\nEVENT: {name} just got a TRIPLE KILL!\nSay your one line now.'
      },
      {
        role: 'assistant',
        content: es
          ? '[excited] ¡TRIPLE KILL! Nueve y dos con Yasuo, estás imparable choomba, nadie te para.'
          : '[excited] TRIPLE KILL! Nine and two on Yasuo, you are unstoppable choomba!'
      }
    ]
  }

  private linesSinceChampionNickname = 99
  private nicknameSwap = 0

  /**
   * Small models end up calling the player by their champion ("¡Vamos, Fizz!"). Mentioning
   * the champion is fine; using it as the player's name is only allowed once every few lines,
   * otherwise it becomes {name} / choomba.
   */
  private limitChampionNickname(line: string): string {
    const champ = this.snapshot().me?.champion
    if (!line || !champ) return line
    const c = champ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const vocative = new RegExp(`(,\\s*)${c}(?=\\s*[!?.,…]|\\s*$)|^((?:\\[[^\\]]+\\]\\s*)?[¡¿]?)${c}(?=\\s*,)`, 'i')
    if (!vocative.test(line)) {
      this.linesSinceChampionNickname++
      return line
    }
    if (this.linesSinceChampionNickname >= 4) {
      this.linesSinceChampionNickname = 0
      return line
    }
    this.linesSinceChampionNickname++
    const who = this.nicknameSwap++ % 2 === 0 ? '{name}' : 'choomba'
    return line.replace(new RegExp(vocative.source, 'gi'), (_m, comma?: string, start?: string) => `${comma ?? start ?? ''}${who}`)
  }

  private matchFacts(): string {
    const s = this.snapshot()
    if (!s.me) return `MATCH: minute ${Math.floor(s.gameTimeSec / 60)}.`
    const fmt = (p: LolPlayerSnapshot) => `${p.champion} lvl${p.level} ${p.kills}/${p.deaths}/${p.assists}`
    void fmt
    return `MATCH: minute ${Math.floor(s.gameTimeSec / 60)}. {name} plays ${s.me.champion} (${s.me.position || 'unknown role'}), lvl ${s.me.level}, KDA ${s.me.kills}/${s.me.deaths}/${s.me.assists}, ${s.me.cs} CS, ${s.me.itemGold} gold in items.`
  }

  // Local LLM (Ollama native API: supports keep_alive + token limits)

  private ollamaBase(): string {
    const ep = agentManager.getConfig().endpoint || 'http://localhost:11434/v1'
    return ep.replace(/\/+$/, '').replace(/\/v1$/, '')
  }

  private async resolveModel(base: string): Promise<string | null> {
    if (this.modelCache && Date.now() - this.modelCache.at < 60 * 1000) return this.modelCache.model
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1200)
      const res = await llmFetch(`${base}/api/tags`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) return null
      const data = (await res.json()) as { models?: { name: string }[] }
      const models = (data.models || []).map((m) => m.name).filter((m) => !/llava|vision|-vl/i.test(m))
      if (models.length === 0) return null

      const requested = (agentManager.getConfig().model || '').trim()
      const req = requested
      // The persona model leaks Rioplatense Spanish into English commentary; a plain 7b
      // instruct model follows the language rule and is faster
      const pick =
        models.find((m) => /qwen2\.5[^:]*:7b/i.test(m)) ||
        models.find((m) => m === req) ||
        models.find((m) => req && (m.startsWith(req + ':') || m.startsWith(req))) ||
        models.find((m) => m.toLowerCase().includes('capri')) ||
        models[0]
      this.modelCache = { model: pick, at: Date.now() }
      return pick
    } catch {
      return null
    }
  }

  private async llm(system: string, user: string, timeoutMs: number, maxTokens: number): Promise<string | null> {
    const base = this.ollamaBase()
    const started = Date.now()
    const model = await this.resolveModel(base)
    if (!model) return null

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(800, timeoutMs - (Date.now() - started)))
    try {
      const res = await llmFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: llmBody({
          model,
          stream: false,
          keep_alive: '20m',
          messages: [{ role: 'system', content: system }, ...this.fewShot(), { role: 'user', content: user }],
          options: { num_predict: maxTokens, temperature: 0.85, top_p: 0.9, repeat_penalty: 1.15 }
        })
      })
      if (!res.ok) return null
      const data = (await res.json()) as { message?: { content?: string } }
      const line = this.limitChampionNickname(cleanLine(data.message?.content || ''))
      console.log(`[LolCommentator] (${model}, ${Date.now() - started}ms) -> ${line}`)
      if (line && !matchesLanguage(line, this.lang())) {
        console.log(`[LolCommentator] Discarding line in the wrong language (expected ${this.lang()})`)
        return null
      }
      return line || null
    } catch {
      console.log(`[LolCommentator] LLM too slow/unavailable after ${Date.now() - started}ms, using fallback line`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

const SPANISH_MARKERS = /[ñ¿¡]|\b(?:que|qué|vos|sos|tenés|che|para|pero|está|estás|muy|también|otra|vez|ese|esa|nos|los|las|del|una|jugá|mirá|dale)\b/i
const ENGLISH_MARKERS = /\b(?:the|you|your|that|this|with|what|just|got|are|and|they|them|let's|again)\b/i

const SCRIPTS: Record<string, RegExp> = {
  ru: /[\u0400-\u04FF]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF]/,
  zh: /[\u4E00-\u9FFF]/
}

/** Cheap check so a Spanish line never slips into English commentary (and vice versa) */
function matchesLanguage(line: string, lang: string): boolean {
  const text = stripTags(line)
  if (SCRIPTS[lang]) return SCRIPTS[lang].test(text)
  const es = (text.match(new RegExp(SPANISH_MARKERS.source, 'gi')) || []).length
  const en = (text.match(new RegExp(ENGLISH_MARKERS.source, 'gi')) || []).length
  if (lang === 'en') return !(es > en)
  if (lang === 'es') return !(en > es + 1)
  return en <= 2
}

function stripTags(s: string): string {
  return s.replace(/\[[a-zA-Z0-9_\s-]+\]/g, '').replace(/\s+/g, ' ').trim()
}

/** Keeps the first meaningful line, removes prefixes/quotes, guarantees a leading emotion tag. */
function cleanLine(raw: string): string {
  let s = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || ''
  s = s
    .replace(/^(?:capri\s*[:\-]\s*)/i, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  // Keep at most the first two sentences: small models tend to ramble
  const sentences = s.match(/[^.!?…。！？]+[.!?…。！？]+|[^.!?…。！？]+$/g) || [s]
  s = sentences.slice(0, 2).join('').trim()
  if (!/^\[[a-zA-Z_ -]+\]/.test(s)) s = `[playful] ${s}`
  if (s.length > 260) s = s.slice(0, 260).replace(/\s+\S*$/, '') + '...'
  return s
}

export const lolCommentator = LolCommentator.getInstance()
