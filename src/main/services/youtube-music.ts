import { execFile } from './hidden-process'
import { scriptPath } from './app-paths'
import { isWindows } from './platform'

export function youtubeMusicTitle(rawTitle: string): string | null {
  const match = rawTitle.match(/^(.*?)\s+[-\u2013\u2014]\s+YouTube Music(?:\s+[-\u2013\u2014].*)?$/i)
  const title = match?.[1].replace(/^\(\d+\)\s*/, '').replace(/^[\u25b6\u25ba\s]+/, '').trim()
  return title && !/^(?:YouTube Music|Home|Inicio|Search|Buscar)$/i.test(title) ? title : null
}

export interface MusicResult {
  videoId: string
  title: string
  artist?: string
}

export function findMusicResult(data: unknown, query: string): MusicResult | null {
  const results: MusicResult[] = []
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return
    const item = value.musicResponsiveListItemRenderer
    if (item) {
      const videoId = item.playlistItemData?.videoId
      const columns = item.flexColumns || []
      const runs = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
      const title = runs.map((r: any) => r.text || '').join('').trim()
      const artistRuns = columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
      const artist = artistRuns.find((r: any) => r.navigationEndpoint?.browseEndpoint)?.text
      if (/^[a-zA-Z0-9_-]{11}$/.test(videoId || '') && title) results.push({ videoId, title, artist })
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(data)
  const words = (text: string): string[] => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) || []
  const tokens = words(query)
  const score = (result: MusicResult): number => {
    const text = words(`${result.title} ${result.artist || ''}`)
    return tokens.filter((token) => text.includes(token)).length / Math.max(tokens.length, 1)
  }
  results.sort((a, b) => score(b) - score(a))
  return results[0] && score(results[0]) >= 0.5 ? results[0] : null
}

export async function searchYoutubeMusic(query: string): Promise<MusicResult | null> {
  try {
    const response = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20261104.01.00', hl: 'en' } },
        query,
        params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'
      }),
      signal: AbortSignal.timeout(8000)
    })
    return response.ok ? findMusicResult(await response.json(), query) : null
  } catch {
    return null
  }
}

export function windowsYoutubeMusic(action: 'status' | 'play', expectedTitle = ''): Promise<unknown> {
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('youtube_music.ps1'),
      '-Action', action, '-ExpectedTitle', expectedTitle
    ], { timeout: action === 'play' ? 10000 : 4500, encoding: 'utf8' }, (err, stdout) => {
      try {
        resolve(err ? null : JSON.parse(stdout.trim()))
      } catch {
        resolve(null)
      }
    })
  })
}

export async function startYoutubeMusic(title: string): Promise<void> {
  if (isWindows) await windowsYoutubeMusic('play', title)
}
