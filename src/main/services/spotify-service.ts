import { closestSpotifyTrack, spotifySearchQueries, verifySpotifySelection, type SpotifyCandidate } from '../../shared/spotify-match'
import { app, safeStorage, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { createServer, Server } from 'http'
import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { appleScript, launchMacApp, macHelper } from './mac-desktop'

export type SpotifyMethod = 'desktop' | 'web-api'
export type MediaAction = 'next' | 'prev' | 'play' | 'pause' | 'play_pause'
export interface SpotifySettings {
  method: SpotifyMethod
  clientId: string
  connected: boolean
  deviceId: string
  redirectUri: string
}
export interface SpotifyDevice {
  id: string
  name: string
  is_active: boolean
}
type Result = { success: boolean; output: string }
type Tokens = { access_token: string; refresh_token: string; expiresAt: number }
const REDIRECT = 'http://127.0.0.1:43829/callback'
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class SpotifyService {
  private server: Server | null = null
  private pending = false
  private busy = false
  private file() {
    return path.join(app.getPath('userData'), 'spotify-mac.json')
  }
  private read(): { method: SpotifyMethod; clientId: string; deviceId: string; token?: string } {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
      return { ...data, method: data.method === 'web-api' ? 'web-api' : 'desktop' }
    } catch {
      return { method: 'desktop', clientId: '', deviceId: '' }
    }
  }
  private write(data: ReturnType<SpotifyService['read']>) {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true })
    const temp = `${this.file()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(temp, this.file())
  }
  private tokens(): Tokens | null {
    try {
      const value = this.read().token
      return value && safeStorage.isEncryptionAvailable()
        ? JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64')))
        : null
    } catch {
      return null
    }
  }
  private saveTokens(tokens: Tokens) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Encrypted credential storage is unavailable. Unlock your login Keychain and try again.')
    this.write({ ...this.read(), token: safeStorage.encryptString(JSON.stringify(tokens)).toString('base64') })
  }
  settings(): SpotifySettings {
    const data = this.read()
    return {
      method: data.method,
      clientId: data.clientId,
      deviceId: data.deviceId,
      connected: !!this.tokens(),
      redirectUri: REDIRECT,
    }
  }
  configure(update: { method?: SpotifyMethod; clientId?: string; deviceId?: string }): SpotifySettings {
    if (update.method !== undefined && update.method !== 'desktop' && update.method !== 'web-api')
      throw new Error('Invalid Spotify method')
    if (update.clientId !== undefined && update.clientId !== '' && !/^[a-zA-Z0-9]{16,128}$/.test(update.clientId))
      throw new Error('Invalid Spotify client ID')
    if (update.deviceId !== undefined && (typeof update.deviceId !== 'string' || update.deviceId.length > 256))
      throw new Error('Invalid device ID')
    const old = this.read()
    if (this.pending && update.clientId !== undefined && update.clientId !== old.clientId)
      throw new Error('Finish or cancel Spotify authorization first')
    this.write({
      ...old,
      ...(update.method !== undefined ? { method: update.method } : {}),
      ...(update.clientId !== undefined ? { clientId: update.clientId } : {}),
      ...(update.deviceId !== undefined ? { deviceId: update.deviceId } : {}),
      ...(update.clientId !== undefined && update.clientId !== old.clientId ? { token: undefined, deviceId: '' } : {}),
    })
    return this.settings()
  }
  disconnect(): SpotifySettings {
    this.server?.close()
    this.server = null
    this.pending = false
    const data = this.read()
    delete data.token
    data.deviceId = ''
    this.write(data)
    return this.settings()
  }
  async connect(): Promise<Result> {
    if (this.pending) return { success: false, output: 'Spotify authorization is already open.' }
    const clientId = this.read().clientId
    if (!clientId) return { success: false, output: 'Enter your Spotify developer app client ID first.' }
    if (!safeStorage.isEncryptionAvailable())
      return { success: false, output: 'Encrypted credential storage is unavailable.' }
    this.pending = true
    const verifier = randomBytes(48).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    return new Promise((resolve) => {
      let settled = false
      let handling = false
      const finish = (result: Result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        server.close()
        if (this.server === server) {
          this.server = null
          this.pending = false
        }
        resolve(result)
      }
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || '/', REDIRECT)
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const received = Buffer.from(url.searchParams.get('state') || '')
        const expected = Buffer.from(state)
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
          res.writeHead(400).end('Invalid authorization state.')
          return
        }
        if (handling || settled) {
          res.writeHead(409).end('Authorization already handled.')
          return
        }
        handling = true
        try {
          if (url.searchParams.has('error')) throw new Error('Spotify authorization was declined.')
          const code = url.searchParams.get('code')
          if (!code) throw new Error('Spotify did not return an authorization code.')
          const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: REDIRECT,
              client_id: clientId,
              code_verifier: verifier,
            }),
            signal: AbortSignal.timeout(15000),
          })
          const body = (await response.json()) as any
          if (!response.ok || !body.access_token || !body.refresh_token)
            throw new Error(
              `Spotify connection failed (${response.status}). Check the client ID and registered redirect URI.`,
            )
          if (settled || this.server !== server) throw new Error('Authorization cancelled.')
          this.saveTokens({
            access_token: body.access_token,
            refresh_token: body.refresh_token,
            expiresAt: Date.now() + body.expires_in * 1000,
          })
          res
            .writeHead(200, { 'Content-Type': 'text/plain' })
            .end('Spotify connected. You can close this window and return to Capri.')
          finish({ success: true, output: 'Spotify connected.' })
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end(errorText(e))
          finish({ success: false, output: errorText(e) })
        }
      })
      this.server = server
      const timer = setTimeout(
        () => finish({ success: false, output: 'Spotify authorization timed out. Try connecting again.' }),
        120000,
      )
      server.once('error', () =>
        finish({
          success: false,
          output: 'Could not open the Spotify callback port 43829. Close another connection attempt and retry.',
        }),
      )
      server.once('close', () => {
        if (!settled) finish({ success: false, output: 'Spotify authorization cancelled.' })
      })
      server.listen(43829, '127.0.0.1', () => {
        const query = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: REDIRECT,
          code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          state,
          scope: 'user-read-playback-state user-modify-playback-state user-read-currently-playing',
        })
        void shell
          .openExternal(`https://accounts.spotify.com/authorize?${query}`)
          .catch((e) => finish({ success: false, output: errorText(e) }))
      })
    })
  }
  private async accessToken(force = false): Promise<string> {
    const token = this.tokens()
    if (!token) throw new Error('Connect Spotify in Mac settings first.')
    if (!force && token.expiresAt > Date.now() + 30000) return token.access_token
    const clientId = this.read().clientId
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(15000),
    })
    const data = (await response.json()) as any
    if (!response.ok) throw new Error('Spotify session expired. Disconnect and connect again.')
    if (this.tokens()?.refresh_token !== token.refresh_token || this.read().clientId !== clientId)
      throw new Error('Spotify connection changed during token refresh. Try again.')
    this.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token || token.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    })
    return data.access_token
  }
  private async api(route: string, method = 'GET', body?: unknown, retry = true): Promise<any> {
    const response = await fetch(`https://api.spotify.com/v1${route}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 401 && retry) {
      await this.accessToken(true)
      return this.api(route, method, body, false)
    }
    if (!response.ok) {
      if (response.status === 403)
        throw new Error('Spotify denied playback. Check Premium membership and access to your developer app.')
      if (response.status === 404)
        throw new Error('No Spotify playback device is available. Open Spotify, then select a device in Mac settings.')
      if (response.status === 429)
        throw new Error(
          `Spotify rate limit reached. Retry after ${response.headers.get('retry-after') || 'a few'} seconds.`,
        )
      throw new Error(`Spotify request failed (${response.status}).`)
    }
    return response.status === 204 ? null : response.json()
  }
  async devices(): Promise<SpotifyDevice[]> {
    return (await this.api('/me/player/devices')).devices || []
  }
  private async deviceQuery(): Promise<string> {
    const selected = this.read().deviceId
    const devices = await this.devices()
    const device = selected ? devices.find((d) => d.id === selected) : devices.find((d) => d.is_active)
    if (!device)
      throw new Error('Select an available Spotify device in Mac settings, or start playback in Spotify first.')
    return `?device_id=${encodeURIComponent(device.id)}`
  }
  async status(allowPermissionPrompt = false): Promise<{ isPlaying: boolean; title: string; uri?: string; error?: string }> {
    try {
      if (this.read().method === 'web-api') {
        const data = await this.api('/me/player')
        return {
          isPlaying: !!data?.is_playing,
          title: data?.item ? `${data.item.artists.map((a: any) => a.name).join(', ')} - ${data.item.name}` : '',
        }
      }
      if (!allowPermissionPrompt) {
        const permission = await macHelper<{spotifyAutomation:string}>('status')
        if (permission.spotifyAutomation !== 'granted') return {isPlaying:false,title:'',error:'Allow Spotify Automation using a playback command or Mac settings.'}
      }
      const out = await appleScript(
        `if application "Spotify" is not running then return ""\ntell application "Spotify"\nreturn (player state as text) & linefeed & artist of current track & " - " & name of current track & linefeed & id of current track\nend tell`,
      )
      const [state, title = '', uri = ''] = out.split('\n')
      return { isPlaying: state === 'playing', title, uri }
    } catch (e) {
      return { isPlaying: false, title: '', error: errorText(e) }
    }
  }
  async control(action: MediaAction): Promise<Result> {
    try {
      if (!['next', 'prev', 'play', 'pause', 'play_pause'].includes(action)) throw new Error('Invalid media action')
      if (this.read().method === 'web-api') {
        const actual = action === 'play_pause' ? ((await this.status()).isPlaying ? 'pause' : 'play') : action
        await this.api(
          `/me/player/${actual === 'prev' ? 'previous' : actual}${await this.deviceQuery()}`,
          actual === 'next' || actual === 'prev' ? 'POST' : 'PUT',
        )
      } else {
        const commands = {
          next: 'next track',
          prev: 'previous track',
          play: 'play',
          pause: 'pause',
          play_pause: 'playpause',
        }
        await appleScript(
          `if application "Spotify" is not running then error "Open Spotify first."\ntell application "Spotify" to ${commands[action]}`,
        )
      }
      return { success: true, output: `Spotify: ${action} completed.` }
    } catch (e) {
      return { success: false, output: errorText(e) }
    }
  }
  async play(query: string): Promise<Result> {
    if (!query.trim()) return this.control('play')
    if (this.busy) return { success: false, output: 'A Spotify search is already running.' }
    this.busy = true
    try {
      if (this.read().method === 'web-api') {
        let track: any = null
        for (const searchQuery of spotifySearchQueries(query)) {
          const result = await this.api(`/search?type=track&limit=10&q=${encodeURIComponent(searchQuery)}`)
          const tracks = result.tracks?.items || []
          const match = closestSpotifyTrack(query, tracks.map((t:any)=>({uri:t.uri,title:t.name,artist:t.artists.map((a:any)=>a.name).join(', ')})))
          track = tracks.find((t:any)=>t.uri === match?.uri)
          if (track) break
        }
        if (!track) throw new Error(`No Spotify track found for "${query}".`)
        await this.api(`/me/player/play${await this.deviceQuery()}`, 'PUT', { uris: [track.uri] })
        return {
          success: true,
          output: `Playing ${track.name} by ${track.artists.map((a: any) => a.name).join(', ')}.`,
        }
      }
      if (!(await launchMacApp('Spotify'))) throw new Error('Spotify is not installed in Applications.')
      // Open the exact search, then use only accessible track-result elements inside Spotify.
      // Never click a screen coordinate or issue a global playback shortcut.
      let selected: Partial<SpotifyCandidate> = {}
      let selectedQuery=query
      for (const searchQuery of spotifySearchQueries(query)) {
        let search: {error?:string;retryable?:boolean} = {}
        for (let attempt=0;attempt<6;attempt++) {
          search = await macHelper<{error?:string;retryable?:boolean}>('spotify-search',[searchQuery])
          if (!search.error || (!search.retryable && !search.error.includes('lost focus'))) break
          await pause(250)
        }
        if (search.error) throw new Error(search.error)
        await pause(350)
        const submitted = await macHelper<{error?:string}>('spotify-submit',[searchQuery])
        if (submitted.error) throw new Error(submitted.error)
        for (let i=0;i<16;i++) {
          await pause(500)
          const result = await macHelper<{candidates?: SpotifyCandidate[];uri?:string;title?:string;error?:string}>('spotify-result',[searchQuery])
          if (result.error) throw new Error(result.error)
          selected = result.candidates ? (closestSpotifyTrack(query,result.candidates) || {}) : result
          if (selected.uri || selected.key || result.candidates?.length) break
        }
        if (selected.uri || selected.key) { selectedQuery=searchQuery; break }
      }
      if ((!selected.uri || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(selected.uri)) && !selected.key)
        throw new Error(
          'No sufficiently close track was found in Spotify search results. Select a track in Spotify, or use Web API mode.',
        )
      if (selected.uri) {
        await appleScript(`on run argv
 tell application "Spotify" to play track (item 1 of argv)
 end run`, [selected.uri])
      } else {
        const played=await macHelper<{pressed?:boolean;error?:string}>('spotify-play-result',[selectedQuery,selected.key!])
        if (!played.pressed) throw new Error(played.error || 'The selected Spotify song row is no longer available.')
      }
      for (let i = 0; i < 6; i++) {
        await pause(500)
        const status = await this.status(true)
        if (
          status.isPlaying && verifySpotifySelection({...selected,title:selected.title || ''},status)
        )
          return { success: true, output: `Playing ${status.title}.` }
      }
      throw new Error('Spotify playback could not be verified. Check the selected track in Spotify.')
    } catch (e) {
      return { success: false, output: errorText(e) }
    } finally {
      this.busy = false
    }
  }
}
export const spotifyService = new SpotifyService()
