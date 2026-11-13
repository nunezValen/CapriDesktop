import { shell, screen, nativeImage } from 'electron'
import { desktopController } from './desktop-controller-service'
import { scannerService } from './scanner-service'
import { windowManager } from '../windows/window-manager'
import { agentManager } from '../agents/agent-manager'
import { consciousnessService } from './consciousness-service'
import { llmFetch, isAiAppMode } from './llm-gateway'
import { llmBody } from './user-profile'
import { VISION_NUM_CTX } from './local-vision'
import { readFeedCards, type FeedCard } from './youtube-feed-reader'
import { IPC_CHANNELS, WatchPartyCursor, WatchPartyMode, WatchPartyStatusPayload } from '../ipc/channels'

interface TiktokState {
  startedAt: number
  /** When the video ends, from the time under the player; 0 while unknown */
  endsAt: number
  /** When her comment on it came, and when she finished saying it */
  commentedAt: number
  commentDoneAt: number
  liked: boolean
  scrolling: boolean
  /** TikTok wasn't in front: the next try waits until then */
  retryAt: number
}

/** Without the time on screen: how long after her comment she moves on, and the least a video is watched */
const TIKTOK_AFTER_COMMENT_MS = 2500
const TIKTOK_MIN_WATCH_MS = 8000
/** A long video is left once she commented, at most this far in */
const TIKTOK_MAX_WATCH_MS = 75000
/** No comment came for this one (the model failed): it moves on anyway */
const TIKTOK_NO_COMMENT_MS = 40000

const TIKTOK_LIKE_RULE =
  'You are watching TikToks together. Only if you genuinely love this one (really funny, impressive or beautiful), end your sentence with the tag [like] and you will like the video; most videos do not get one. This tag is the only exception to the rule about tags.'

export class WatchPartyService {
  private static instance: WatchPartyService

  private mode: WatchPartyMode = 'idle'
  private isBrowsingFeed = false
  private candidateTitle = ''
  /** The phrasing of the last video she offered, so the next offer sounds different */
  private lastProposalIndex = -1
  private awaitingChoice = false
  private choiceTimer: NodeJS.Timeout | null = null
  private autoScrollTimer: NodeJS.Timeout | null = null
  /** The TikTok on screen: when it showed up, when it ends (if read), and what she did with it */
  private tiktok: TiktokState = { startedAt: 0, endsAt: 0, commentedAt: 0, commentDoneAt: 0, liked: false, scrolling: false, retryAt: 0 }
  private lastReaction = ''
  private currentTarget = { x: 500, y: 400 }
  /** The videos read on screen in the last look at the feed, and the next one to propose */
  private feedCards: FeedCard[] = []
  private cardIndex = 0
  /** Titles already proposed, so a short scroll doesn't bring the same ones back */
  private seenTitles = new Set<string>()
  /** Only without OCR: which of the fixed grid slots comes next */
  private fallbackIndex = 0
  /** Every new step in the feed (scroll, proposal, stop) bumps it: a slower step that finishes later is dropped */
  private browseSeq = 0

  private cursor: WatchPartyCursor = {
    x: 600,
    y: 350,
    visible: false,
    isClicking: false,
    isScrolling: false
  }

  public static getInstance(): WatchPartyService {
    if (!WatchPartyService.instance) {
      WatchPartyService.instance = new WatchPartyService()
    }
    return WatchPartyService.instance
  }

  public getStatus(): WatchPartyStatusPayload {
    return {
      mode: this.mode,
      active: this.mode !== 'idle',
      isBrowsingFeed: this.isBrowsingFeed,
      candidateTitle: this.candidateTitle || undefined,
      lastReaction: this.lastReaction || undefined,
      cursor: { ...this.cursor }
    }
  }

  private broadcastStatus(): void {
    windowManager.broadcast(IPC_CHANNELS.WATCH_PARTY_STATE_CHANGED, this.getStatus())
  }

  public moveCursor(x: number, y: number, targetLabel?: string): void {
    this.cursor = {
      x: Math.round(x),
      y: Math.round(y),
      visible: true,
      isClicking: false,
      isScrolling: false,
      targetLabel
    }
    windowManager.ensureScannerTop()
    this.broadcastStatus()
  }

  public animateScroll(direction: 'down' | 'up' = 'down'): void {
    this.cursor.isScrolling = true
    this.broadcastStatus()
    setTimeout(() => {
      if (this.cursor.isScrolling) {
        this.cursor.isScrolling = false
        this.broadcastStatus()
      }
    }, 1200)
  }

  public animateClick(x?: number, y?: number): void {
    if (typeof x === 'number' && typeof y === 'number') {
      this.cursor.x = Math.round(x)
      this.cursor.y = Math.round(y)
    }
    this.cursor.isClicking = true
    this.broadcastStatus()
    setTimeout(() => {
      if (this.cursor.isClicking) {
        this.cursor.isClicking = false
        this.broadcastStatus()
      }
    }, 800)
  }

  public hideCursor(): void {
    this.cursor.visible = false
    this.broadcastStatus()
  }

  private say(text: string, durationMs = 4500, onSay?: (msg: string) => void): void {
    if (onSay) {
      onSay(text)
    }
    agentManager.setCompanionState('talking')
    agentManager.setCompanionSpeech(text, durationMs, true)
    setTimeout(() => {
      if (this.mode !== 'idle') {
        agentManager.setCompanionState('curious')
      }
    }, Math.min(durationMs, 4000))
  }

  // --- Mode 1: TikTok Watch Party ---
  //
  // Each video: she comments on it first, and when it ends (read from the "00:15 / 00:22" under the
  // player, which the screen OCR already reads on every look) she moves on to the next one. When she
  // really loves one she likes it herself. Without the time on screen, she moves on a few seconds
  // after her comment. Keys only ever go to a browser window showing TikTok.

  public async startTiktokParty(onSay?: (msg: string) => void): Promise<boolean> {
    this.stopParty(false)
    this.mode = 'tiktok'
    this.isBrowsingFeed = false
    this.tiktok = this.freshTiktok()

    // 1. TikTok in front: the tab already open if there is one (as it is), a new one only if not
    const openTab = await desktopController.focusTab('TikTok').catch(() => null)
    if (openTab) {
      console.log(`[WatchParty] Reusing the open TikTok tab: "${openTab}"`)
    } else {
      try {
        await shell.openExternal('https://www.tiktok.com')
      } catch (e) {
        console.warn('[WatchParty] Failed to open TikTok URL:', e)
      }
    }

    // Bring browser to foreground in front of background windows
    setTimeout(() => void desktopController.focusBrowser('tiktok'), 500)
    setTimeout(() => void desktopController.focusBrowser('tiktok'), 1200)
    setTimeout(() => void desktopController.focusBrowser('tiktok'), 2400)

    // 2. Her reactions get one more rule: she may like what she loves
    scannerService.setReactionAddon(TIKTOK_LIKE_RULE, (line) => this.takeLikeTag(line))

    // 3. Start full screen vision loop
    await scannerService.startFullscreenWatch()

    // 4. Welcome line
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    const msg = isEs
      ? '¡De una! Jackeando en TikTok. Yo voy comentando cada uno y paso al siguiente cuando termina; si alguno me encanta, le clavo like. Decime "siguiente" para pasar o "dale like" si te gustó.'
      : "Jacked into TikTok! I'll comment on each one and move on when it ends, and if I love one I'll like it. Say 'next' to skip or 'like' to drop a like."
    this.say(msg, 6000, onSay)

    // 5. The loop that decides when to move on
    if (this.autoScrollTimer) clearInterval(this.autoScrollTimer)
    this.autoScrollTimer = setInterval(() => void this.tiktokTick(), 1000)
    this.broadcastStatus()
    return true
  }

  private freshTiktok(): TiktokState {
    return { startedAt: Date.now(), endsAt: 0, commentedAt: 0, commentDoneAt: 0, liked: false, scrolling: false, retryAt: 0 }
  }

  /** Once a second: is this video done (commented on, and over)? */
  private async tiktokTick(): Promise<void> {
    if (this.mode !== 'tiktok') return
    const t = this.tiktok
    const now = Date.now()
    if (t.scrolling || now < t.retryAt) return

    const speaking = scannerService.isSpeaking()
    if (!t.commentedAt && scannerService.getLastReactionCapturedAt() >= t.startedAt) t.commentedAt = now
    if (t.commentedAt && !t.commentDoneAt && !speaking) t.commentDoneAt = now
    if (!t.endsAt) this.readTiktokTime()

    const watched = now - t.startedAt
    const ended = t.endsAt > 0 && now >= t.endsAt - 300
    let reason = ''
    if (t.commentDoneAt && !speaking) {
      if (ended) reason = 'it ended after her comment'
      else if (!t.endsAt && now - t.commentDoneAt >= TIKTOK_AFTER_COMMENT_MS && watched >= TIKTOK_MIN_WATCH_MS) reason = 'commented (no time on screen)'
      else if (watched >= TIKTOK_MAX_WATCH_MS) reason = 'long video, commented on'
    } else if (!t.commentedAt && watched >= TIKTOK_NO_COMMENT_MS && (ended || !t.endsAt)) {
      // The model didn't come up with anything for this one: it doesn't hold the feed forever
      reason = 'no comment came'
    } else if (watched >= TIKTOK_MAX_WATCH_MS + 20000) {
      reason = 'stuck'
    }
    if (reason) await this.scrollTiktok(reason)
  }

  /** The video's time under the player ("00:15 / 00:22"), from the OCR of a look at this video */
  private readTiktokTime(): void {
    const t = this.tiktok
    const ocr = scannerService.getLastScreenOcr()
    // A look taken once this video was on screen (the page takes a moment to swap it)
    if (!ocr || ocr.at < t.startedAt + 700) return
    const { height } = screen.getPrimaryDisplay().bounds
    for (const line of ocr.lines) {
      if (line.y < height * 0.4) continue
      const text = line.text.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[.;]/g, ':')
      const m = text.match(/(\d{1,2})\s*:\s*(\d{2})\s*\/\s*(\d{1,2})\s*:\s*(\d{2})/)
      if (!m) continue
      const position = Number(m[1]) * 60 + Number(m[2])
      const duration = Number(m[3]) * 60 + Number(m[4])
      if (!duration || position > duration) continue
      t.endsAt = ocr.at + (duration - position) * 1000
      console.log(`[WatchParty] TikTok at ${position}s of ${duration}s: ends in ${Math.round((t.endsAt - Date.now()) / 1000)}s`)
      return
    }
  }

  /** On to the next video. What she was still thinking about the old one is dropped */
  private async scrollTiktok(reason: string): Promise<boolean> {
    const t = this.tiktok
    t.scrolling = true
    const sent = await desktopController.tiktokNext()
    if (this.mode !== 'tiktok' || this.tiktok !== t) return sent
    if (!sent) {
      // TikTok isn't the tab in front (the user is elsewhere): she tries again in a bit
      t.scrolling = false
      t.retryAt = Date.now() + 5000
      return false
    }
    console.log(`[WatchParty] Next TikTok (${reason})`)
    this.tiktok = this.freshTiktok()
    // The new video takes a moment to show up: looks before that would be about the old one
    scannerService.screenChanged(1200)
    return true
  }

  /** "[like]" at the end of a reaction: she likes the video (once) and doesn't say the tag */
  private takeLikeTag(line: string): string {
    if (!/\[\s*like\s*\]?/i.test(line)) return line
    const clean = line.replace(/\s*\[\s*like\s*\]?/gi, '').trim()
    if (this.mode === 'tiktok' && !this.tiktok.liked) {
      this.tiktok.liked = true
      void desktopController.tiktokLike().then((ok) => console.log(`[WatchParty] She liked this TikTok${ok ? '' : ' (TikTok was not in front, no like)'}`))
    }
    return clean
  }

  public async nextTiktok(onSay?: (msg: string) => void): Promise<boolean> {
    if (this.mode !== 'tiktok') return false
    const success = await this.scrollTiktok('asked by the user')
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    if (!success) {
      this.say(isEs ? 'No tengo TikTok al frente, choomba. Volvé a la pestaña y le doy.' : "TikTok isn't in front, choomba. Switch back to its tab and I'll do it.", 3500, onSay)
      return false
    }
    const phrases = isEs
      ? ['Pasando...', 'A ver qué sigue...', 'Siguiente video, choomba!', 'Scrolleando!']
      : ['Next up...', 'Skipping...', 'Moving to next video!', 'Scrolling!']
    const pick = phrases[Math.floor(Math.random() * phrases.length)]
    this.say(pick, 2500, onSay)
    return success
  }

  public async prevTiktok(onSay?: (msg: string) => void): Promise<boolean> {
    if (this.mode !== 'tiktok') return false
    const success = await desktopController.tiktokPrev()
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    if (!success) {
      this.say(isEs ? 'No tengo TikTok al frente, choomba.' : "TikTok isn't in front, choomba.", 3000, onSay)
      return false
    }
    this.tiktok = this.freshTiktok()
    scannerService.screenChanged(1200)
    this.say(isEs ? 'Volviendo al anterior...' : 'Going back...', 2500, onSay)
    return success
  }

  public async likeTiktok(onSay?: (msg: string) => void): Promise<boolean> {
    if (this.mode !== 'tiktok') return false
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    // She already liked it: another "L" would take the like away
    if (this.tiktok.liked) {
      this.say(isEs ? '¡Ya tiene nuestro like, choomba!' : 'It already has our like, choomba!', 2500, onSay)
      return true
    }
    const success = await desktopController.tiktokLike()
    if (!success) {
      this.say(isEs ? 'No tengo TikTok al frente para darle like, choomba.' : "TikTok isn't in front to like it, choomba.", 3000, onSay)
      return false
    }
    this.tiktok.liked = true
    const phrases = isEs
      ? ['¡De una, le clavé like!', '¡Likeado, choomba!', '¡Corazoncito enviado!', '¡Quedó guardado en likes!']
      : ['Dropped a like!', 'Liked, choomba!', 'Heart sent!', 'Added to likes!']
    const pick = phrases[Math.floor(Math.random() * phrases.length)]
    this.say(pick, 3000, onSay)
    return success
  }

  public async togglePauseTiktok(): Promise<boolean> {
    return desktopController.tiktokPause()
  }

  // --- Mode 2: YouTube Watch Party & Co-Browsing Feed ---

  private resetFeed(): void {
    this.feedCards = []
    this.cardIndex = 0
    this.seenTitles.clear()
    this.fallbackIndex = 0
  }

  /** Where the pointer goes to scroll: the middle of the feed, so the wheel lands on the browser */
  private feedPoint(): { x: number; y: number } {
    const { x, y, width, height } = screen.getPrimaryDisplay().bounds
    return { x: Math.round(x + width * 0.55), y: Math.round(y + height * 0.55) }
  }

  /** Scrolls the feed a screen down; what was read before is no longer there */
  private async scrollFeed(): Promise<void> {
    const point = this.feedPoint()
    this.moveCursor(point.x, point.y)
    this.animateScroll('down')
    await desktopController.focusBrowser('youtube')
    windowManager.ensureScannerTop()
    await desktopController.scroll('down', 960, point.x, point.y)
    this.feedCards = []
    this.cardIndex = 0
  }

  /**
   * The videos on screen, read with the OCR built into the system (a second or two, no model).
   * Retries while the page is still loading. Empty when there's no OCR here or nothing was found.
   */
  /** An empty spot of the YouTube header: the real pointer waits there while she reads */
  private restPoint(): { x: number; y: number } {
    const { x, y, width, height } = screen.getPrimaryDisplay().bounds
    return { x: Math.round(x + width * 0.8), y: Math.round(y + height * 0.155) }
  }

  /**
   * The videos on screen, read with the OCR built into the system (a second or two, no model).
   * Retries while the page is still loading. Null when there is no OCR on this system.
   */
  private async scanFeed(seq: number, skipSeen = true, attempts = 2): Promise<FeedCard[] | null> {
    const { x, y, width, height } = screen.getPrimaryDisplay().bounds
    // The real pointer over a card makes YouTube play its preview and cover it with a tooltip, and
    // her own cursor with a title next to it would be read as part of the page: both wait on an empty
    // spot of the header while she reads. Her cursor stays visible there (hiding it for the seconds
    // the page takes to load looked like it had vanished)
    const rest = this.restPoint()
    await desktopController.movePointer(rest.x, rest.y)
    if (this.cursor.visible) this.moveCursor(rest.x, rest.y)
    await new Promise((r) => setTimeout(r, 350))
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000))
      if (seq !== this.browseSeq) return []
      const lines = await scannerService.ocrDisplayRegion({ x, y, width, height })
      if (lines === null) {
        console.warn('[WatchParty] No Windows OCR here: falling back to the fixed grid')
        return null
      }
      if (seq !== this.browseSeq) return []
      const all = readFeedCards(lines)
      const cards = all.filter((c) => !c.isShort && (!skipSeen || !this.seenTitles.has(c.title)))
      console.log(`[WatchParty] OCR: ${lines.length} lines, ${all.length} cards, ${cards.length} new videos`, cards.map((c) => c.title))
      if (cards.length) return cards
      // Cards were read but they're Shorts or already proposed: no point waiting, it's not loading
      if (all.length) return []
    }
    return []
  }

  /** The next video to propose: from the ones read on screen, scrolling for more when they run out */
  private async nextFeedVideo(seq: number): Promise<{ x: number; y: number; title: string } | null> {
    if (this.feedCards.length && this.cardIndex >= this.feedCards.length) {
      await this.scrollFeed()
      await new Promise((r) => setTimeout(r, 900))
      if (seq !== this.browseSeq) return null
    }
    let noOcr = false
    if (!this.feedCards.length) {
      // Only Shorts or nothing new on this screen: further down, a few screens at most
      for (let screenful = 0; screenful < 4; screenful++) {
        // Right after opening YouTube the page may still be loading: more tries on the first look
        const cards = await this.scanFeed(seq, true, screenful === 0 && !this.seenTitles.size ? 4 : 2)
        if (seq !== this.browseSeq) return null
        if (cards === null) {
          noOcr = true
          break
        }
        if (cards.length) {
          this.feedCards = cards
          break
        }
        await this.scrollFeed()
        await new Promise((r) => setTimeout(r, 900))
        if (seq !== this.browseSeq) return null
      }
      this.cardIndex = 0
    }
    const card = this.feedCards[this.cardIndex++]
    if (card) {
      this.seenTitles.add(card.title)
      return { x: card.x, y: card.y, title: card.title }
    }
    // OCR works but a few screens down there's still nothing new: she says so in proposeNextYoutubeVideo
    if (!noOcr) return null
    // No OCR on this system: the usual grid slots, named by the vision model when it's quick.
    // After the three of a row she scrolls by herself too.
    if (this.fallbackIndex > 0 && this.fallbackIndex % 3 === 0) {
      await this.scrollFeed()
      await new Promise((r) => setTimeout(r, 900))
      if (seq !== this.browseSeq) return null
    }
    const pos = this.gridSlots()[this.fallbackIndex++ % 3]
    const title = await this.extractCardTitle(pos)
    return seq === this.browseSeq ? { ...pos, title } : null
  }

  /** Row 1 of the YouTube home grid, clear of the Shorts shelf further down */
  private gridSlots(): { x: number; y: number }[] {
    const { width, height } = screen.getPrimaryDisplay().bounds
    const rowY = Math.round(height * 0.35)
    return [0.28, 0.52, 0.76].map((f) => ({ x: Math.round(width * f), y: rowY }))
  }

  /** YouTube's home feed in front: reuses an open YouTube tab, and opens a new one only when there's none */
  private async openYoutubeHome(): Promise<void> {
    const title = await desktopController.focusYoutubeTab().catch(() => null)
    if (!title) {
      try {
        await shell.openExternal('https://www.youtube.com')
      } catch (e) {
        console.warn('[WatchParty] Failed to open YouTube URL:', e)
      }
      return
    }
    // The home page's tab is just "YouTube" (with the notification count, maybe); anything else is a
    // video or a search, and the feed is on the home page
    const page = title.replace(/\s+[-–]\s+(?:Opera|Google Chrome|Microsoft​? Edge|Brave|Mozilla Firefox|Vivaldi)\b.*$/i, '').trim()
    console.log(`[WatchParty] Reusing the open YouTube tab: "${page}"`)
    if (!/^(?:\(\d+\)\s*)?YouTube$/i.test(page)) {
      await new Promise((r) => setTimeout(r, 300))
      await desktopController.openUrlHere('https://www.youtube.com')
    }
  }

  public async startYoutubeParty(onSay?: (msg: string) => void, forceEnglish = false): Promise<boolean> {
    this.stopParty(false)
    this.mode = 'youtube'
    this.isBrowsingFeed = true
    this.candidateTitle = ''
    this.awaitingChoice = false
    this.resetFeed()

    // 1. Enable fullscreen overlay window for cyberpunk borders and cyber cursor
    // while keeping ambient vision loop paused so it doesn't collide with card title extraction
    scannerService.setOverlayOnlyWatch(true)

    // Get display bounds for Capri's mouse
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.bounds
    this.moveCursor(width * 0.5, 220)

    // 2. YouTube in front: the tab already open if there is one, a new one only if not
    await this.openYoutubeHome()

    // 3. Actively bring browser window to the foreground in front of the terminal,
    // and reassert topmost status for Capri's scanner overlay
    setTimeout(() => {
      void desktopController.focusBrowser('youtube')
      windowManager.ensureScannerTop()
    }, 600)
    setTimeout(() => {
      void desktopController.focusBrowser('youtube')
      windowManager.ensureScannerTop()
    }, 1300)
    setTimeout(() => {
      void desktopController.focusBrowser('youtube')
      windowManager.ensureScannerTop()
    }, 2500)

    // 4. Welcome announcement
    const isEs = !forceEnglish && consciousnessService.getPreferredLanguage() === 'es'
    const msg = isEs
      ? '¡De una, choomba! Abriendo YouTube. Dejame ver qué encontramos en tu feed...'
      : "Launching YouTube! Let's check out your feed..."
    this.say(msg, 4000, onSay)

    // Wait 4s for browser and YouTube page to load, then propose the first video
    setTimeout(() => {
      if (this.mode === 'youtube' && this.isBrowsingFeed) {
        windowManager.ensureScannerTop()
        void this.proposeNextYoutubeVideo(onSay)
      }
    }, 4000)

    this.broadcastStatus()
    return true
  }

  /** Fallback only (no OCR): asks the vision model for the title of the card at a point */
  private async extractCardTitle(pos: { x: number; y: number }): Promise<string> {
    // An AI app starts a whole program per question (20-35s): far too slow to wait on here
    if (isAiAppMode()) return ''
    try {
      const display = screen.getPrimaryDisplay()
      const { width, height } = display.bounds

      // YouTube desktop video card bounding box in display virtual coordinates
      // Width 28% and Height 36% centered around pos.x, pos.y (focused on Row 1 regular videos)
      const cardW = Math.round(width * 0.28)
      const cardH = Math.round(height * 0.36)
      const cropX = Math.max(0, Math.min(width - cardW, Math.round(pos.x - cardW / 2)))
      const cropY = Math.max(0, Math.min(height - cardH, Math.round(pos.y - cardH * 0.30)))

      const captured = await scannerService.captureDisplayRegion({
        x: cropX,
        y: cropY,
        width: cardW,
        height: cardH
      })

      if (!captured || !captured.base64) {
        console.warn('[WatchParty] Could not capture card region')
        return ''
      }

      const visionModel = await scannerService.detectVisionModel()
      if (!visionModel) {
        console.warn('[WatchParty] No vision model detected')
        return ''
      }

      const prompt = `You are an OCR assistant. Look at this cropped screenshot of a YouTube video card.
If this card is a YouTube Shorts reel, vertical video, or Shorts shelf, reply "SHORTS".
Find the main regular video title (the bold headline text below or on the thumbnail).
Reply with ONLY the video title in quotation marks, e.g. "Video Title Here".
If there is no text or title visible, reply "NONE".`

      const resp = await llmFetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model: visionModel,
          prompt,
          images: [captured.base64],
          stream: false,
          options: { temperature: 0.1, num_predict: 250, num_ctx: VISION_NUM_CTX }
        }),
        signal: AbortSignal.timeout(25000)
      })

      if (resp.ok) {
        const data = (await resp.json()) as any
        const raw = String(data?.response || '').trim()
        console.log('[WatchParty] extractCardTitle raw response:', raw)

        let title = ''
        const match = raw.match(/"([^"]+)"/) || raw.match(/“([^”]+)”/)
        if (match) {
          title = match[1].trim()
        } else {
          const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || ''
          title = firstLine
            .replace(/^#+\s*/, '')
            .replace(/^(?:the\s+)?(?:video\s+)?title(?:\s+is)?:\s*/i, '')
            .replace(/^["'“”]+|["'“”]+$/g, '')
            .trim()
        }

        // Clean up mojibake, non-standard symbols and emojis that break speech or prompt formatting
        title = title
          .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '')
          .replace(/[≡ƒÆÇ┬íAS├ì]/g, '')
          .replace(/["“”]/g, '')
          .replace(/\s+/g, ' ')
          .trim()

        if (
          title &&
          title.length >= 3 &&
          !/^(none|unknown|untitled|n\/a|no title|screenshot|video\s*title|shorts)[.]?$/i.test(title) &&
          !/#shorts\b/i.test(title) &&
          !/^shorts$/i.test(title)
        ) {
          return title
        }
      } else {
        console.warn('[WatchParty] extractCardTitle LLM response not ok:', resp.status, await resp.text().catch(() => ''))
      }
    } catch (err) {
      console.warn('[WatchParty] Card title extraction error:', err)
    }
    return ''
  }

  // --- Mode 2A: Interactive YouTube Co-Browsing ("Let's watch YouTube together") ---

  public async proposeNextYoutubeVideo(onSay?: (msg: string) => void): Promise<void> {
    if (this.mode !== 'youtube' || !this.isBrowsingFeed) return
    const seq = ++this.browseSeq
    this.awaitingChoice = false
    agentManager.setCompanionState('curious')
    // Without the last title next to the cursor: the OCR would read it as part of the page
    this.moveCursor(this.cursor.x, this.cursor.y)

    const video = await this.nextFeedVideo(seq)
    // A scroll, another request or the end of the party came while she was reading
    if (seq !== this.browseSeq || this.mode !== 'youtube' || !this.isBrowsingFeed) return
    if (!video) {
      const isEs = consciousnessService.getPreferredLanguage() === 'es'
      this.say(
        isEs ? 'No encuentro más videos por acá, choomba. ¿Buscamos algo en particular?' : "I can't find any more videos around here, choomba. Want to search for something?",
        4500,
        onSay
      )
      return
    }

    const pos = { x: video.x, y: video.y }
    const extractedTitle = video.title
    this.currentTarget = pos
    this.candidateTitle = extractedTitle
    this.awaitingChoice = true
    this.moveCursor(pos.x, pos.y, extractedTitle || undefined)

    this.say(this.proposalLine(extractedTitle), 5000, onSay)

    // IMPORTANT: In co-browsing mode ("let's watch together"), NEVER auto-skip on a timer.
    // She waits patiently for the user to say whether they want it, want another, or want her to choose.
    if (this.choiceTimer) {
      clearTimeout(this.choiceTimer)
      this.choiceTimer = null
    }
  }

  /**
   * How she offers a video: a different phrasing each time (never the one she just used), always
   * with the title in quotes so the voice says it as written, in its own language.
   */
  private proposalLine(title: string): string {
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    const t = title
    const lines = t
      ? isEs
        ? [
            `¿Qué tal este video: "${t}"? ¿Lo ponemos?`,
            `Mirá este: "${t}". ¿Le damos play?`,
            `Uh, "${t}" pinta bien. ¿Lo vemos?`,
            `Che, "${t}"... ¿te copa o seguimos buscando?`,
            `Este me llamó la atención: "${t}". ¿Lo ponemos?`,
            `¿Y si vemos "${t}"? Decime si te va.`,
            `Encontré "${t}". ¿Le metemos o pasamos al siguiente?`,
            `"${t}"... mis sensores dicen que esto vale la pena. ¿Dale?`
          ]
        : [
            `How about this video: "${t}"? Want to watch it?`,
            `Check this one out: "${t}". Should we hit play?`,
            `Ooh, "${t}" looks good. Wanna watch it?`,
            `Hey, "${t}"... you into it, or should I keep looking?`,
            `This one caught my eye: "${t}". Put it on?`,
            `What about "${t}"? Tell me if it works for you.`,
            `Found "${t}". Play it or skip to the next one?`,
            `"${t}"... my sensors say this one's worth it. Shall we?`
          ]
      : isEs
        ? [
            '¿Qué tal este video que te estoy señalando? ¿Lo ponemos?',
            'Mirá el que te estoy marcando con el cursor. ¿Le damos play?',
            'Este que señalo pinta bien. ¿Lo vemos?'
          ]
        : [
            "How about this video I'm pointing at? Want to watch it?",
            "Check out the one under my cursor. Should we hit play?",
            "This one I'm pointing at looks good. Wanna watch it?"
          ]
    let index = Math.floor(Math.random() * lines.length)
    if (index === this.lastProposalIndex && lines.length > 1) index = (index + 1 + Math.floor(Math.random() * (lines.length - 1))) % lines.length
    this.lastProposalIndex = index
    return lines[index]
  }

  // --- Mode 2B: Capri Autonomous Video Picker ("Pick a video from YouTube and let's watch") ---

  public async startYoutubeAutoPick(onSay?: (msg: string) => void, forceEnglish = false): Promise<boolean> {
    this.stopParty(false)
    this.mode = 'youtube'
    this.isBrowsingFeed = true
    this.awaitingChoice = false
    this.resetFeed()

    // 1. Enable fullscreen overlay window for cyberpunk borders and cyber cursor
    scannerService.setOverlayOnlyWatch(true)

    const isEs = !forceEnglish && consciousnessService.getPreferredLanguage() === 'es'
    const introMsg = isEs
      ? '¡De una! Dejame chusmear el feed a ver qué joyita encuentro...'
      : 'On it! Let me explore your feed and pick something cool for us...'
    this.say(introMsg, 4000, onSay)

    // 2. YouTube in front: the tab already open if there is one, a new one only if not
    await this.openYoutubeHome()

    // 3. Bring browser to front and ensure scanner overlay stays topmost
    setTimeout(() => {
      void desktopController.focusBrowser('youtube')
      windowManager.ensureScannerTop()
    }, 600)
    setTimeout(() => {
      void desktopController.focusBrowser('youtube')
      windowManager.ensureScannerTop()
    }, 1300)
    setTimeout(() => {
      void desktopController.focusBrowser('youtube')
      windowManager.ensureScannerTop()
    }, 2500)

    const display = screen.getPrimaryDisplay()
    const { width, height } = display.bounds

    // 4. Capri explores the feed like a human: glides mouse, scrolls, inspects
    setTimeout(async () => {
      if (this.mode !== 'youtube') return
      windowManager.ensureScannerTop()
      this.moveCursor(width * 0.45, height * 0.35)

      // First scroll
      setTimeout(async () => {
        if (this.mode !== 'youtube') return
        await this.scrollFeed()

        // Decide if she scrolls a second time to dig deeper into the feed
        const scrollTwice = Math.random() > 0.4
        if (scrollTwice) {
          setTimeout(async () => {
            if (this.mode !== 'youtube') return
            await this.scrollFeed()
            setTimeout(() => {
              void this.pickAndPlayVideo(onSay, forceEnglish)
            }, 1000)
          }, 1200)
        } else {
          setTimeout(() => {
            void this.pickAndPlayVideo(onSay, forceEnglish)
          }, 1000)
        }
      }, 1200)
    }, 2500)

    this.broadcastStatus()
    return true
  }

  public async pickAndPlayVideo(onSay?: (msg: string) => void, forceEnglish = false): Promise<void> {
    if (this.mode !== 'youtube') return
    const seq = ++this.browseSeq
    this.awaitingChoice = false
    agentManager.setCompanionState('curious')
    this.moveCursor(this.cursor.x, this.cursor.y)

    // One of the videos on screen, any of them (not always the first)
    const cards = (await this.scanFeed(seq, false, 3)) || []
    if (seq !== this.browseSeq || this.mode !== 'youtube') return
    let target: { x: number; y: number }
    let title = ''
    if (cards.length) {
      const card = cards[Math.floor(Math.random() * Math.min(cards.length, 6))]
      target = { x: card.x, y: card.y }
      title = card.title
    } else {
      const slots = this.gridSlots()
      target = slots[Math.floor(Math.random() * slots.length)]
      this.moveCursor(target.x, target.y)
      title = await this.extractCardTitle(target)
      if (seq !== this.browseSeq || this.mode !== 'youtube') return
    }
    this.currentTarget = target
    this.moveCursor(target.x, target.y, title || undefined)

    const isEs = !forceEnglish && consciousnessService.getPreferredLanguage() === 'es'
    const announcement = title
      ? (isEs ? `¡Elegí este: "${title}"! ¡Tiene toda la pinta, ahí lo pongo!` : `I picked this one: "${title}"! Looks sick, playing it now!`)
      : (isEs ? '¡Elegí este video que tengo marcado! ¡Tiene toda la pinta, ahí lo pongo!' : "I picked this video I'm pointing at! Looks sick, playing it now!")

    this.say(announcement, 4000, onSay)

    // Click and play after giving announcement a moment
    setTimeout(async () => {
      if (this.mode !== 'youtube' || seq !== this.browseSeq) return
      this.animateClick(target.x, target.y)
      await desktopController.click(target.x, target.y)

      this.isBrowsingFeed = false
      this.awaitingChoice = false
      this.broadcastStatus()

      setTimeout(() => {
        if (this.mode !== 'youtube' || seq !== this.browseSeq) return
        this.hideCursor()
        // Video is now playing! Start full screen watch to react to video content
        void scannerService.startFullscreenWatch()
      }, 1500)
    }, 1800)
  }

  public async scrollFeedDown(onSay?: (msg: string) => void): Promise<void> {
    if (this.mode !== 'youtube' || !this.isBrowsingFeed) return
    if (this.choiceTimer) {
      clearTimeout(this.choiceTimer)
      this.choiceTimer = null
    }
    this.awaitingChoice = false
    // Whatever she was reading or about to propose belongs to the screen that is going away
    const seq = ++this.browseSeq
    this.broadcastStatus()

    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    const msg = isEs
      ? '¡Dale, choomba! Scrolleo para abajo a ver qué más hay...'
      : 'On it, choomba! Scrolling down to see more videos...'
    this.say(msg, 2500, onSay)

    await this.scrollFeed()

    setTimeout(() => {
      if (seq === this.browseSeq && this.mode === 'youtube' && this.isBrowsingFeed) {
        void this.proposeNextYoutubeVideo(onSay)
      }
    }, 900)
  }

  public async handleYoutubeChoice(agree: boolean, onSay?: (msg: string) => void): Promise<void> {
    if (this.choiceTimer) {
      clearTimeout(this.choiceTimer)
      this.choiceTimer = null
    }

    const isEs = consciousnessService.getPreferredLanguage() === 'es'

    if (agree) {
      const seq = this.browseSeq
      // User accepted the video!
      this.awaitingChoice = false
      this.isBrowsingFeed = false
      this.broadcastStatus()

      const acceptMsg = isEs
        ? '¡De una! Vamos a verlo juntos, me quedo acá reaccionando con vos.'
        : "Awesome! Let's watch it together, watching and reacting with you."
      this.say(acceptMsg, 4000, onSay)

      // Animate click on Capri's cursor and physically click the target video card!
      this.animateClick(this.currentTarget.x, this.currentTarget.y)
      await desktopController.click(this.currentTarget.x, this.currentTarget.y)

      setTimeout(() => {
        if (this.mode !== 'youtube' || seq !== this.browseSeq) return
        this.hideCursor()
        // Video is now playing! Start full screen watch to react to video content
        void scannerService.startFullscreenWatch()
      }, 1500)
    } else {
      // User rejected: "otra cosa", "otro", etc.
      this.awaitingChoice = false
      this.broadcastStatus()

      const rejectMsg = isEs
        ? 'Dale, buscando otra cosa en el feed...'
        : 'Alright, looking for another video in your feed...'
      this.say(rejectMsg, 2500, onSay)

      // The next video read on screen; once they're all seen it scrolls for fresh ones by itself
      setTimeout(() => {
        if (this.mode === 'youtube' && this.isBrowsingFeed) {
          void this.proposeNextYoutubeVideo(onSay)
        }
      }, 600)
    }
  }

  // --- Mode 3: Generic Game Watch Party ---

  public async startGamingParty(onSay?: (msg: string) => void): Promise<boolean> {
    this.stopParty(false)
    this.mode = 'gaming'
    this.isBrowsingFeed = false

    await scannerService.startFullscreenWatch()

    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    const msg = isEs
      ? '¡Modo gamer activado! Mirando tu pantalla completa en tiempo real. ¡A romperla, choomba!'
      : "Gamer mode active! Watching your full screen in real time. Let's crush it, choomba!"
    this.say(msg, 5000, onSay)

    this.broadcastStatus()
    return true
  }

  // --- Stop Watch Party ---

  public stopParty(speak = true): boolean {
    if (this.autoScrollTimer) {
      clearInterval(this.autoScrollTimer)
      this.autoScrollTimer = null
    }
    scannerService.setReactionAddon(null, null)
    if (this.choiceTimer) {
      clearTimeout(this.choiceTimer)
      this.choiceTimer = null
    }

    this.hideCursor()
    this.browseSeq++
    this.resetFeed()

    if (this.mode === 'idle') return false

    this.mode = 'idle'
    this.isBrowsingFeed = false
    this.candidateTitle = ''
    this.awaitingChoice = false

    scannerService.stopFullscreenWatch()
    windowManager.setScannerFullscreenWatch(false)
    windowManager.hideScanner()

    if (speak) {
      const isEs = consciousnessService.getPreferredLanguage() === 'es'
      this.say(
        isEs
          ? '¡Listo choomba! Dejé de mirar la pantalla. Volvemos al escritorio.'
          : 'Done choomba! Stopped screen watch. Back to regular desktop.',
        4000
      )
    }

    this.broadcastStatus()
    return true
  }

  // --- Voice Commands Interceptor ---

  public async handleVoiceCommand(rawText: string, onSay?: (msg: string) => void): Promise<{ handled: boolean; reply?: string }> {
    const clean = rawText
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/^(?:hey\s+|hola\s+)?(?:capri|companion)[,:\s]*/i, '')
      .replace(/[,:\s]*(?:por\s+favor|porfa|ya|ahora|please|pls)[!.]*$/i, '')
      .replace(/[,:\s]*(?:capri|companion)[!.]*$/i, '')
      .trim()

    // Exit / Stop: "para" only on its own ("pará", "para de mirar"), never inside "para abajo"
    const isStop =
      /\b(?:basta|cerra(?:r|lo|la)?|stop|terminar?|termina\s+(?:ya|esto)|sali(?:r|te)?|close|quit|deja\s+de\s+mirar)\b/i.test(clean) ||
      /^para(?:\s+de\s+\w+.*)?$/i.test(clean)
    const mentionsOtherParty =
      (this.mode !== 'youtube' && /\b(?:youtube|yt)\b/i.test(clean)) ||
      (this.mode !== 'tiktok' && /\b(?:tiktok|tiktoks|tik\s+tok)\b/i.test(clean))
    if (this.mode !== 'idle' && isStop && !mentionsOtherParty) {
      this.stopParty(true)
      return { handled: true }
    }

    const isMusicRequest = /\b(?:music|musica|song|cancion)\b/i.test(clean) && !/\bvideos?\b/i.test(clean)

    // 1. YouTube Autonomous Video Picker (Mode B) - e.g. "hey pick a video from youtube and lets watch it"
    const isEnglishAutoPick =
      /(?:pick|choose|find|select|surprise\s+me)\s+(?:a\s+|with\s+(?:a\s+)?)?(?:video|something)\s*(?:from\s+youtube|on\s+youtube|to\s+watch|for\s+us|and\s+let'?s\s+watch)?/i.test(clean) ||
      /(?:pick\s+one\s+yourself|you\s+choose|pick\s+for\s+me)/i.test(clean)

    const isSpanishAutoPick =
      /(?:elegi|elige|elegite|busca|buscate|elegir|sorprendeme)\s+(?:vos\s+)?(?:con\s+(?:un\s+)?|un\s+)?(?:video|algo)\s*(?:en\s+youtube|de\s+youtube|para\s+ver|copado)?/i.test(clean) ||
      /(?:elegi\s+vos|elegilo\s+vos|elegi\s+tu|elegilo\s+tu|elegi\s+uno)/i.test(clean)

    if (!isMusicRequest && (isEnglishAutoPick || isSpanishAutoPick)) {
      // Already in the feed together: she picks from what's on screen instead of opening YouTube again
      if (this.mode === 'youtube' && this.isBrowsingFeed) {
        const isEs = consciousnessService.getPreferredLanguage() === 'es'
        this.say(isEs ? '¡De una, elijo yo entonces!' : "Alright, I'll pick one then!", 3000, onSay)
        void this.pickAndPlayVideo(onSay)
        return { handled: true }
      }
      await this.startYoutubeAutoPick(onSay, isEnglishAutoPick)
      return { handled: true }
    }

    // 2. YouTube Co-Browsing (Mode A) - e.g. "lets watch youtube together", "veamos unos videos en youtube"
    const isEnglishYoutube =
      /\b(?:youtube|yt)\b/i.test(clean) &&
      (/(?:watch|watching|see|look|browse|browsing|explore|exploring|check|together|lets?\s*watch|let'?s\s*watch)/i.test(clean) ||
        /^(?:lets?\s+watch\s+youtube(?:\s+together)?|let'?s\s+watch\s+youtube(?:\s+together)?|watch\s+youtube(?:\s+together)?|open\s+youtube|youtube\s+together)$/i.test(clean))

    const isSpanishYoutube =
      /\b(?:youtube|yt)\b/i.test(clean) &&
      (/(?:ver|veamos|miremos|mirar|vamos|abrir?|abri|abre|pone|pon|buscar?|busquemos|explorar?|videos?|algo|feed|play|quiero|tengo\s+ganas|que\s+tal\s+si|podemos|juntos)/i.test(clean) ||
        /^(?:de\s+ver\s+youtube|ver\s+youtube|veamos\s+youtube|miremos\s+youtube|vamos\s+a\s+youtube|abrir\s+youtube|abri\s+youtube|abre\s+youtube|youtube)$/i.test(clean))

    if (!isMusicRequest && (isEnglishYoutube || isSpanishYoutube)) {
      await this.startYoutubeParty(onSay, isEnglishYoutube)
      return { handled: true }
    }

    // 2. Starting TikTok Watch Party
    const isTiktokStart =
      /\b(?:tiktok|tiktoks|tik\s+tok)\b/i.test(clean) &&
      (/(?:ver|veamos|miremos|mirar|vamos|abrir?|abri|abre|pone|pon|scrollea|play|watch|watching|see|lets?\b|let'?s|open|together|browse|scroll|juntos)/i.test(clean) ||
        /^(?:tiktoks?|tik\s+tok|ver\s+tiktok|veamos\s+tiktoks?|miremos\s+tiktoks?)$/i.test(clean))

    if (isTiktokStart) {
      await this.startTiktokParty(onSay)
      return { handled: true }
    }

    // 3. Starting Gaming Watch Party
    const isGamingStart =
      /(?:mira|observa|watch)\s+(?:como\s+juego|mi\s+juego|el\s+juego|pantalla\s+mientras\s+juego|my\s+game)/i.test(clean) ||
      /(?:reacciona)\s+a\s+(?:mi\s+juego|lo\s+que\s+juego)/i.test(clean)

    if (isGamingStart) {
      await this.startGamingParty(onSay)
      return { handled: true }
    }

    // 4. Commands active during Watch Party
    if (this.mode !== 'idle') {
      // Scrolling the YouTube feed goes first: "scrolleá para abajo" has a "para" that isn't "stop"
      const isScrollDown =
        /(?:scroll\s*down|scroll\s*more|scrollea|scrolle|\bbaja\b|scrollear|\bbajar\b|mas\s*abajo|para\s*abajo|ver\s*mas|mostrame\s*mas|show\s*more|see\s*more|show\s*me\s*more|more\s*videos|look\s*further)/i.test(clean)
      if (this.mode === 'youtube' && this.isBrowsingFeed && isScrollDown) {
        await this.scrollFeedDown(onSay)
        return { handled: true }
      }

      if (isStop) {
        this.stopParty(true)
        return { handled: true }
      }

      // TikTok specific controls
      if (this.mode === 'tiktok') {
        if (/(?:siguiente|next|otro|otra|another|scroll|swipe|skip|pasala|pasa|bajale|change\s+it|move\s+on)/i.test(clean)) {
          await this.nextTiktok(onSay)
          return { handled: true }
        }
        if (/(?:dale\s+)?like|me\s*gusta|corazon|ponele\s+like/i.test(clean)) {
          await this.likeTiktok(onSay)
          return { handled: true }
        }
        if (/(?:anterior|prev|atras|el\s+de\s+antes)/i.test(clean)) {
          await this.prevTiktok(onSay)
          return { handled: true }
        }
        if (/(?:pausa|pausar|play|reproduce|frena)/i.test(clean)) {
          await this.togglePauseTiktok()
          return { handled: true }
        }
      }

      // YouTube Feed Co-browsing choice and navigation controls
      if (this.mode === 'youtube' && this.isBrowsingFeed) {
        if (this.awaitingChoice) {
          // 2. Check REJECTION / SEARCH ANOTHER *FIRST* (takes precedence over accept)
          // e.g. "nah, lets watch other video", "lets watch another", "otro", "otra cosa", "siguiente", "skip", "next"
          const isReject =
            /^(?:no|nah|nope|otro|otra|next|skip|pas[ao])$/i.test(clean) ||
            /(?:nah\b|nope\b|not\s+this|don'?t\s+like|no\s+me\s+gusta|ese\s+no|otro\b|otra\b|other\s+video|another\s+video|different\s+video|something\s+else|different\s+one|another\s+one|otra\s+cosa|busca\s+otr|siguiente|saltea|cambia|skip\b|next\b)/i.test(clean)

          if (isReject) {
            await this.handleYoutubeChoice(false, onSay)
            return { handled: true }
          }

          // 3. Delegate choice to Capri: "elegí vos", "you choose", "pick one", "pick for me"
          if (/(?:elegi\s+vos|elegilo\s+vos|elegi\s+tu|elegilo\s+tu|you\s+choose|pick\s+one|pick\s+for\s+me|choose\s+one|decidi\s+vos)/i.test(clean)) {
            const isEs = consciousnessService.getPreferredLanguage() === 'es'
            this.say(isEs ? '¡De una, elijo yo entonces!' : "Alright, I'll pick one then!", 3000, onSay)
            void this.pickAndPlayVideo(onSay)
            return { handled: true }
          }

          // 4. Accept: "dale", "ponelo", "sí", "ese", "abrí ese", "vamos", "ok", "yes", "sure", "play it", "that one"
          const isAccept =
            /(?:^si$|^si\b|dale|ponelo|pone\b|abri\s+ese|abre\s+ese|pone\s+ese|ese\b|vamos|de\s+una|bueno|ok\b|okay|yes\b|sure|play\b|reproducilo|pongamos\s+ese|that\s+one|pick\s+that|let'?s\s+watch\s+(?:this|it|that)|me\s+gusta|yeah\b|yep\b)/i.test(clean)

          if (isAccept) {
            await this.handleYoutubeChoice(true, onSay)
            return { handled: true }
          }
        }
      }
    }

    return { handled: false }
  }
}

export const watchPartyService = WatchPartyService.getInstance()
