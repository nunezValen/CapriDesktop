import {
  isLinux,
  isWindows,
  killProcesses,
  launchFirstLinuxApp,
  launchLinuxApp,
  linuxClickSpotifyTopResult,
  linuxMediaControl,
  linuxMediaStatus,
  linuxOpenSpotifyUri,
  linuxSpotifyTitle,
  linuxSteamAppsDirs,
  LINUX_CALCULATORS,
  LINUX_EDITORS,
  listDesktopEntries,
  listProcessNames,
  matchDesktopEntry,
  startCommand
} from '../../services/platform'
import { searchYoutubeMusic, startYoutubeMusic } from '../../services/youtube-music'
import { scriptPath } from '../../services/app-paths'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { exec } from '../../services/hidden-process'
import { app, shell } from 'electron'
import { consciousnessService } from '../../services/consciousness-service'
import { resolveMusicPlatform, musicPlatformName, type PlaybackPlatform } from '../../services/music-platform'
import { clipService } from '../../services/clip-service'
import { askWhereAppIs, openInstalledApp, protocolIsRegistered } from '../../services/app-launcher'
import { cleanAppRequest } from '../../services/app-finder'

/** Containers and binary formats: handling them as text destroys them for good */
const NON_TEXT_EXTENSIONS = /\.(?:docx?|docm|dotx|xlsx?|xlsm|pptx?|pptm|odt|ods|odp|pdf|epub|zip|rar|7z|png|jpe?g|gif|webp|bmp|ico|mp3|wav|ogg|mp4|mkv|avi|exe|dll)$/i

/** The exact bytes survive a decode + encode: anything else (binary, UTF-16, legacy encodings) would get corrupted */
function isSafeText(raw: Buffer): boolean {
  return !raw.includes(0) && Buffer.from(raw.toString('utf-8'), 'utf-8').equals(raw)
}

function unsupportedFile(targetPath: string): { success: boolean; output: string } {
  return {
    success: false,
    output: `Unsupported file, left untouched: ${targetPath} is not a plain-text file (Word, Excel, PDF, image or other binary). Tell the user you cannot read or edit this format.`
  }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
}

export const CAPRI_TOOLS: ToolDefinition[] = [
  {
    name: 'run_command',
    description: 'Execute a command in PowerShell / bash shell. Use for builds, tests, git, npm, or system inspection.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Exact command line string to execute (e.g. "git status", "npm test", "dir")'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read the text content of a workspace file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative or absolute path of the file to read.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative or absolute path of the file to create.'
        },
        content: {
          type: 'string',
          description: 'Full text content of the file to write.'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Replace an exact target text segment in an existing file with replacement text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file to modify.'
        },
        target: {
          type: 'string',
          description: 'Exact existing substring to replace.'
        },
        replacement: {
          type: 'string',
          description: 'New replacement text.'
        }
      },
      required: ['path', 'target', 'replacement']
    }
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories in a directory path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of directory to inspect (or "." for current).'
        }
      },
      required: []
    }
  },
  {
    name: 'open_application',
    description: 'Launch an application, game, or song on this PC (e.g. League of Legends / lol, Cyberpunk 2077, Palworld, Slay the Spire, Roblox, Valorant, OBS Studio, Spotify, Chrome, Steam, Discord, Calculator, Notepad).',
    parameters: {
      type: 'object',
      properties: {
        appOrUrl: {
          type: 'string',
          description: 'Name of the app or game (e.g. "lol", "cyberpunk", "palworld", "spotify", "youtube", "obs", "chrome", "steam", "discord", "notepad", "calc") or website URL. Use "music" for music on the preferred platform unless the user explicitly requests Spotify, YouTube Music, or YouTube.'
        },
        query: {
          type: 'string',
          description: 'Optional song title, artist, or search query when playing music or searching (e.g. "I Really Want to Stay at Your House", "Lose Yourself", "Cyberpunk theme").'
        },
        url: {
          type: 'string',
          description: 'Optional website URL if launching a browser (e.g. "https://www.youtube.com").'
        }
      },
      required: ['appOrUrl']
    }
  },
  {
    name: 'close_application',
    description: 'Close, terminate, or kill a running game, application, or process on this PC (e.g. League of Legends / lol, Cyberpunk 2077, Palworld, OBS Studio, Chrome, Steam, Spotify, Discord, Calculator, Notepad).',
    parameters: {
      type: 'object',
      properties: {
        appName: {
          type: 'string',
          description: 'Name of the application, game, or executable to close (e.g. "lol", "cyberpunk", "palworld", "obs", "chrome", "steam", "spotify", "discord", "calc", "notepad").'
        }
      },
      required: ['appName']
    }
  },
  {
    name: 'delete_path',
    description: 'Delete, erase, or remove a file, document, or directory from disk.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute or relative path to the file or directory to delete.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'media_control',
    description: 'Control music playback without changing to a specific title (e.g. skip to next song, previous song, play, pause). If the user asks for a specific song name (e.g. "change song to X", "play X"), use open_application with appOrUrl: "music" (the preferred platform), or an explicitly requested "spotify", "youtube music", or "youtube", and query: "<song>" instead.',
    parameters: {
      type: 'object',
      properties: {
        appOrUrl: {
          type: 'string',
          description: 'Optional explicitly requested platform: spotify, youtube music, or youtube. Omit to use the preferred music platform.'
        },
        action: {
          type: 'string',
          enum: ['next', 'prev', 'play', 'pause', 'play_pause'],
          description: 'The media action to perform: "next" (change/skip song), "prev" (previous song), "play" (resume playback), "pause" (pause playback).'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'web_search',
    description: 'Search the Web / Internet for live information, documentation, news, facts, homework solutions, or research.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search terms or query string.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_web_page',
    description: 'Fetch and extract the readable text and content of a web page URL on the Internet.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'HTTP or HTTPS URL to fetch.'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'find_files',
    description: 'Search and find files across the project workspace, desktop, or user profile by name or pattern.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Filename or search pattern (e.g. "tarea", "tarea.txt", "notes.md").'
        },
        searchPath: {
          type: 'string',
          description: 'Optional starting directory path. Defaults to workspace and desktop.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'trigger_clip',
    description: 'Trigger NVIDIA ShadowPlay to record and save an instant replay clip of the gameplay (presses F8 hotkey). Use whenever the user asks to clip or save gameplay.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional highlight note or description of the clip.'
        }
      },
      required: []
    }
  }
]

export class ToolExecutor {
  public static async execute(
    name: string,
    args: Record<string, unknown>,
    cwd: string
  ): Promise<{ success: boolean; output: string }> {
    try {
      switch (name) {
        case 'media_control': {
          const action = String(args.action || 'next') as 'next' | 'prev' | 'play' | 'pause' | 'play_pause'
          return await ToolExecutor.mediaControl(action, resolveMusicPlatform(String(args.appOrUrl || '')))
        }
        case 'trigger_clip': {
          const res = await clipService.triggerClip()
          return {
            success: res.success,
            output: res.success
              ? 'NVIDIA ShadowPlay instant replay clip triggered successfully (F8 hotkey sent).'
              : `Failed to trigger clip: ${res.message}`
          }
        }
        case 'run_command': {
          const command = String(args.command || '')
          if (!command) return { success: false, output: 'Error: No command specified.' }
          return await ToolExecutor.runCommand(command, cwd)
        }

        case 'read_file': {
          const targetPath = ToolExecutor.resolvePath(String(args.path || ''), cwd)
          if (!fs.existsSync(targetPath)) {
            return { success: false, output: `Error: File does not exist: ${targetPath}` }
          }
          const raw = fs.readFileSync(targetPath)
          if (NON_TEXT_EXTENSIONS.test(targetPath) || raw.includes(0)) return unsupportedFile(targetPath)
          const content = raw.toString('utf-8')
          const maxLen = 8000
          const truncated =
            content.length > maxLen
              ? content.slice(0, maxLen) + `\n... [Truncated to ${maxLen} characters]`
              : content
          return { success: true, output: truncated }
        }

        case 'write_file': {
          const targetPath = ToolExecutor.resolvePath(String(args.path || ''), cwd)
          const content = String(args.content || '')
          if (NON_TEXT_EXTENSIONS.test(targetPath)) return unsupportedFile(targetPath)
          if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile() && !isSafeText(fs.readFileSync(targetPath))) {
            return unsupportedFile(targetPath)
          }
          const dir = path.dirname(targetPath)
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }
          fs.writeFileSync(targetPath, content, 'utf-8')
          return { success: true, output: `File written successfully: ${targetPath} (${content.length} bytes)` }
        }

        case 'edit_file': {
          const targetPath = ToolExecutor.resolvePath(String(args.path || ''), cwd)
          if (!fs.existsSync(targetPath)) {
            return { success: false, output: `Error: File does not exist: ${targetPath}` }
          }
          if (NON_TEXT_EXTENSIONS.test(targetPath)) return unsupportedFile(targetPath)
          const raw = fs.readFileSync(targetPath)
          if (!isSafeText(raw)) return unsupportedFile(targetPath)
          const original = raw.toString('utf-8')
          const target = String(args.target || '')
          const replacement = String(args.replacement || '')

          if (!target) {
            return { success: false, output: `Error: edit_file needs the exact text to replace; nothing was changed in ${targetPath}.` }
          }
          if (!original.includes(target)) {
            return { success: false, output: `Error: Target text was not found exactly in file.` }
          }
          if (target === replacement) {
            return { success: false, output: `Error: The edit would not change anything in ${targetPath}.` }
          }

          const updated = original.replace(target, () => replacement)
          fs.writeFileSync(targetPath, updated, 'utf-8')
          return { success: true, output: `File edited successfully: ${targetPath}` }
        }

        case 'list_directory': {
          const targetDir = ToolExecutor.resolvePath(String(args.path || '.'), cwd)
          if (!fs.existsSync(targetDir)) {
            return { success: false, output: `Error: Directory not found: ${targetDir}` }
          }
          const items = fs.readdirSync(targetDir, { withFileTypes: true })
          const lines = items.map((it) => {
            const type = it.isDirectory() ? '[DIR]' : '[FILE]'
            return `${type.padEnd(7)} ${it.name}`
          })
          return { success: true, output: lines.join('\n') || '(empty directory)' }
        }

        case 'open_application': {
          return await ToolExecutor.openApplication(args)
        }

        case 'close_application': {
          return await ToolExecutor.closeApplication(args)
        }

        case 'delete_path': {
          return await ToolExecutor.deletePath(args, cwd)
        }

        case 'web_search': {
          const query = String(args.query || args.q || args.search || '')
          if (!query) return { success: false, output: 'Error: No search query provided.' }
          return await ToolExecutor.webSearch(query)
        }

        case 'fetch_web_page': {
          const url = String(args.url || args.link || '')
          if (!url) return { success: false, output: 'Error: No URL provided.' }
          return await ToolExecutor.fetchWebPage(url)
        }

        case 'find_files': {
          const query = String(args.query || args.name || args.file || '')
          if (!query) return { success: false, output: 'Error: No search query or filename provided.' }
          const searchPath = args.searchPath ? String(args.searchPath) : cwd
          return await ToolExecutor.findFiles(query, searchPath)
        }

        default:
          return { success: false, output: `Unknown tool: ${name}` }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: `Error executing tool ${name}: ${msg}` }
    }
  }

  private static runCommand(
    command: string,
    cwd: string
  ): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout: 25000,
          maxBuffer: 1024 * 1024,
          shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
        },
        (error, stdout, stderr) => {
          let out = stdout ? stdout.trim() : ''
          if (stderr) {
            out += (out ? '\n' : '') + `[STDERR] ${stderr.trim()}`
          }
          if (error && !out) {
            out = `Error: ${error.message}`
          }
          const maxLen = 6000
          if (out.length > maxLen) {
            out = out.slice(0, maxLen) + `\n... [Output truncated]`
          }
          resolve({
            success: !error,
            output: out || '(command executed with no output)'
          })
        }
      )
    })
  }

  private static resolvePath(p: string, cwd: string): string {
    const userProfile = process.env.USERPROFILE || os.homedir()
    let resolved = p.trim().replace(/\\\\/g, '\\')

    // If local model hallucinated 'choomba', '<Your_Username>', '<username>', etc. as the Windows username
    if (/[a-zA-Z]:[\\/]+Users[\\/]+(?:choomba|<[^>]+>|user|username)/i.test(resolved)) {
      resolved = resolved.replace(/[a-zA-Z]:[\\/]+Users[\\/]+(?:choomba|<[^>]+>|user|username)/i, userProfile)
    }

    // Expand ~
    if (resolved.startsWith('~')) {
      resolved = path.join(userProfile, resolved.slice(1))
    }

    // Local models think in Windows paths: "C:\\Users\\me\\Desktop\\a.txt" is ~/Desktop/a.txt here
    if (!isWindows) {
      resolved = resolved.replace(/^[a-zA-Z]:[\\/]+Users[\\/]+[^\\/]+/i, userProfile).replace(/\\/g, '/')
    }

    // Expand environment variables like %userprofile%
    if (resolved.includes('%USERPROFILE%')) {
      resolved = resolved.replace(/%USERPROFILE%/gi, userProfile)
    }

    if (path.isAbsolute(resolved)) return resolved
    return path.join(cwd, resolved)
  }

  public static async webSearch(query: string): Promise<{ success: boolean; output: string }> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const resp = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(10000)
      })

      if (!resp.ok) {
        return { success: false, output: `Search request failed with HTTP ${resp.status}` }
      }

      const html = await resp.text()
      const blocks = html.split('<div class="result results_links results_links_deep web-result ">')
      const results: { title: string; snippet: string; url: string }[] = []

      for (const b of blocks.slice(1, 7)) {
        const titleMatch = b.match(/<a[^>]+class="result__snippet[^>]*>([\s\S]*?)<\/a>/i)
        const linkMatch = b.match(/<a[^>]+class="result__url[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        const snippet = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : ''
        const title = linkMatch ? linkMatch[2].replace(/<[^>]+>/g, '').trim() : ''
        let link = linkMatch ? linkMatch[1].trim() : ''

        if (link.includes('uddg=')) {
          try {
            const raw = link.split('uddg=')[1].split('&')[0]
            link = decodeURIComponent(raw)
          } catch {}
        }

        if (title || snippet) {
          results.push({ title: title || 'Result', snippet, url: link })
        }
      }

      if (results.length === 0) {
        return { success: true, output: `No web results found for "${query}".` }
      }

      const formatted = results
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nSummary: ${r.snippet}`)
        .join('\n\n')

      return { success: true, output: `Web search results for "${query}":\n\n${formatted}` }
    } catch (err: any) {
      return { success: false, output: `Web search error: ${err?.message || err}` }
    }
  }

  public static async fetchWebPage(url: string): Promise<{ success: boolean; output: string }> {
    try {
      const targetUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`
      const resp = await fetch(targetUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(12000)
      })

      if (!resp.ok) {
        return { success: false, output: `Fetch failed with HTTP status ${resp.status} for ${targetUrl}` }
      }

      const html = await resp.text()
      const clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()

      const maxLen = 6000
      const content = clean.length > maxLen ? clean.slice(0, maxLen) + '... [Truncated]' : clean
      return { success: true, output: `Content from ${targetUrl}:\n\n${content}` }
    } catch (err: any) {
      return { success: false, output: `Failed to fetch web page ${url}: ${err?.message || err}` }
    }
  }

  public static async findFiles(query: string, startCwd: string): Promise<{ success: boolean; output: string }> {
    try {
      const qLower = query.toLowerCase().trim()
      const results: string[] = []
      const desktop = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop')
      const downloads = path.join(process.env.USERPROFILE || os.homedir(), 'Downloads')
      const documents = path.join(process.env.USERPROFILE || os.homedir(), 'Documents')

      const searchDirs = [startCwd, desktop, downloads, documents]
      const seen = new Set<string>()

      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const nameLower = entry.name.toLowerCase()
            const fullPath = path.join(dir, entry.name)
            if (seen.has(fullPath)) continue
            seen.add(fullPath)

            const nameWithoutExt = path.parse(entry.name).name.toLowerCase()
            const qWithoutExt = path.parse(query).name.toLowerCase()

            if (
              nameLower === qLower ||
              nameWithoutExt === qWithoutExt ||
              nameLower.includes(qLower) ||
              (qLower.includes('tarea') && (nameLower.includes('tarea') || nameLower.includes('tp') || nameLower.includes('homework')))
            ) {
              const stat = fs.statSync(fullPath)
              results.push(`${fullPath} (${entry.isDirectory() ? 'DIR' : `${stat.size} bytes`})`)
            }
          }
        } catch {}
      }

      if (results.length === 0) {
        return { success: false, output: `No files found matching query "${query}" across workspace, desktop, or user profile.` }
      }

      return { success: true, output: `Found matching files:\n${results.join('\n')}` }
    } catch (err: any) {
      return { success: false, output: `Search files error: ${err?.message || err}` }
    }
  }

  private static async openApplication(args: Record<string, unknown>): Promise<{ success: boolean; output: string }> {
    const rawTarget = String(args.appOrUrl || args.target || args.app || args.name || '').trim()
    const rawUrl = String(args.url || '').trim()
    let rawQuery = String(args.query || args.song || args.track || args.search || '').trim()

    if (!rawTarget && !rawUrl && !rawQuery) {
      return { success: false, output: 'Error: No application, URL, or song query provided to open.' }
    }

    let target = (rawTarget || (rawQuery ? 'music' : '')).toLowerCase().trim()

    // Conversational Context Repair: Fix inputs like "play on spotify <song>" where target became "on" or "on spotify"
    if (/^(?:on|in|en)\s+spotify$/i.test(target) || (target === 'on' && (/spotify/i.test(rawQuery) || /spotify/i.test(rawTarget)))) {
      target = 'spotify'
    } else if (target === 'on' || target === 'en' || target === 'in') {
      if (rawQuery.toLowerCase().includes('spotify') || /musica|music|song|cancion/i.test(rawQuery)) {
        target = resolveMusicPlatform(rawQuery)
        rawQuery = rawQuery.replace(/^(?:on\s+spotify|en\s+spotify|spotify)\s*/i, '').trim()
      } else {
        target = resolveMusicPlatform(rawQuery)
      }
    } else if (target.startsWith('on ') || target.startsWith('en ') || target.startsWith('in ')) {
      const stripped = target.replace(/^(?:on|en|in)\s+/i, '').trim()
      if (stripped.includes('spotify')) {
        target = 'spotify'
      } else if (stripped.includes('youtube')) {
        target = resolveMusicPlatform(stripped)
      } else {
        target = stripped
      }
    }

    if (/^(?:music|musica|música|cancion|canción|song)(?:\s|$)/i.test(target)) {
      target = resolveMusicPlatform(`${rawTarget} ${rawQuery}`)
    }

    try {
      // Direct Web URLs
      if (/^https?:\/\//i.test(rawTarget)) {
        await shell.openExternal(rawTarget)
        return { success: true, output: `Opened website: ${rawTarget}` }
      }
      if (/^https?:\/\//i.test(rawUrl)) {
        await shell.openExternal(rawUrl)
        return { success: true, output: `Opened website: ${rawUrl}` }
      }

      // An installed app by its name comes before the shortcuts below, which go by a word inside the
      // name: without this "google earth" opens the browser. These names are what those shortcuts are for
      const handledBelow = /^(?:youtube|youtube[ _]music|spotify|musica|música|music|cancion|canción|navegador|browser|browser_search|internet|google|notas|bloc de notas)$/i
      if (!rawUrl && !rawQuery && !handledBelow.test(cleanAppRequest(target))) {
        const opened = await openInstalledApp(rawTarget)
        if (opened) return { success: true, output: `Launched ${opened} successfully!` }
      }

      // YouTube and YouTube Music (with direct song / video search)
      if (target.includes('youtube')) {
        const platform = resolveMusicPlatform(target)
        const isMusic = platform === 'youtube_music'
        const name = musicPlatformName(platform)
        const query = (rawQuery || target.replace(/^(?:(?:abre|open)\s+)?youtube(?:[ _]+music)?\s*/i, '')).trim()
        const homeUrl = isMusic ? 'https://music.youtube.com' : 'https://www.youtube.com'
        let finalUrl = query
          ? (isMusic ? `${homeUrl}/search?q=${encodeURIComponent(query)}` : `${homeUrl}/results?search_query=${encodeURIComponent(query)}`)
          : homeUrl
        let songTitle: string | undefined
        if (query && isMusic) {
          const song = await searchYoutubeMusic(query)
          if (song) {
            songTitle = song.title
            finalUrl = `${homeUrl}/watch?v=${song.videoId}&autoplay=1`
          }
        }
        if (query && !isMusic) {
          try {
            const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
              signal: AbortSignal.timeout(8000)
            })
            if (res.ok) {
              const html = await res.text()
              const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/) || html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/)
              if (match) finalUrl = `${homeUrl}/watch?v=${match[1]}${isMusic ? '' : '&autoplay=1'}`
            }
          } catch {}
        }
        await shell.openExternal(finalUrl).catch(() => { exec(startCommand(finalUrl)) })
        if (songTitle) await startYoutubeMusic(songTitle)
        return { success: true, output: query ? `Playing "${query}" on ${name}: ${finalUrl}` : `Launched ${name} in your browser.` }
      }

      // OBS Studio
      if (/\bobs\b/.test(target)) {
        if (isLinux) {
          return launchLinuxApp('obs') ? { success: true, output: 'Launched OBS Studio.' } : await ToolExecutor.appNotFound('OBS Studio', args)
        }
        const obsCandidates = [
          'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
          'C:\\Program Files (x86)\\obs-studio\\bin\\32bit\\obs32.exe'
        ]
        const foundObs = obsCandidates.find((p) => fs.existsSync(p))
        if (foundObs) {
          const obsDir = path.dirname(foundObs)
          exec(`powershell -Command "Start-Process -FilePath '${foundObs}' -WorkingDirectory '${obsDir}'"`)
          return { success: true, output: `Launched OBS Studio from ${foundObs}` }
        }
        return await ToolExecutor.appNotFound('OBS Studio', args)
      }

      // Browser Searches & Web Navigation
      if (
        target === 'browser_search' ||
        target.includes('chrome') ||
        target.includes('opera') ||
        target.includes('navegador') ||
        target.includes('browser') ||
        target.includes('google')
      ) {
        let searchQuery = rawQuery
        if (!searchQuery && (target.includes('google') || target.includes('search') || target.includes('busca'))) {
          searchQuery = target.replace(/^(?:browser_search|google|search|busca|buscar)\s+/i, '').trim()
        }

        if (searchQuery) {
          const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`
          try {
            await shell.openExternal(searchUrl)
          } catch {
            exec(startCommand(searchUrl))
          }
          return {
            success: true,
            output: `Searched Google for "${searchQuery}" in your browser.`
          }
        }

        const dest = rawUrl || (target.includes('youtube') ? 'https://www.youtube.com' : 'https://google.com')
        try {
          await shell.openExternal(dest)
        } catch {
          exec(startCommand(dest))
        }
        return { success: true, output: `Opened ${dest} in your browser.` }
      }

      // Steam
      if (target.includes('steam')) {
        if (isLinux) {
          return launchLinuxApp('steam') ? { success: true, output: 'Launched Steam client.' } : await ToolExecutor.appNotFound('Steam', args)
        }
        if (!(await protocolIsRegistered('steam'))) return await ToolExecutor.appNotFound('Steam', args)
        exec('cmd.exe /c start steam://', (_err) => {
          if (_err) exec('cmd.exe /c start steam')
        })
        return { success: true, output: 'Launched Steam client.' }
      }

      // Spotify (with song search, playback, and skip/change controls)
      if (target.includes('spotify')) {
        let query = rawQuery || (target.includes('spotify') ? target.replace(/^(?:spotify|abre\s+spotify|open\s+spotify)\s*/i, '').trim() : '')
        // Clean out filler phrases (e.g. "and start playing", "play", "pon", "listen to", "on spotify")
        query = query
          .replace(/^(?:now\s+)?(?:change|switch|cambia|cambiar|pasa|pasar)\s+(?:the\s+|la\s+|el\s+|de\s+)?(?:song|track|cancion|canción|tema|musica|música)?\s*(?:to|a|por)\s+/i, '')
          .replace(/^(?:and\s+start\s+playing|start\s+playing|play\s+song|play\s+track|play|pon|pone|reproduce|escuchar|listen\s+to|poneme|busca|search\s+for)\s+/i, '')
          .replace(/\s+(?:on\s+spotify|en\s+spotify|on\s+youtube|en\s+youtube)$/i, '')
          .trim()

        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        const spotifyExe = path.join(appData, 'Spotify', 'Spotify.exe')
        const spotifyDir = path.dirname(spotifyExe)
        const mediaScriptPath = scriptPath('media_controller.ps1')

        // If user intent was purely to change song / next track without a target song:
        if (query === '__NEXT_TRACK__' || /^(?:cambia\s+(?:de\s+|la\s+)?cancion|skip\s+(?:song|track)|next\s+(?:song|track)|skip|next|otra\s+cancion|siguiente\s+cancion|siguiente|otra)$/i.test(query)) {
          return await ToolExecutor.mediaControl('next', 'spotify')
        }

        if (isLinux) return await ToolExecutor.linuxSpotify(query)

        const isChangeRequested =
          args.isChange === true ||
          args.forceChange === true ||
          /^(?:now\s+)?(?:change|switch|cambia|cambiar|pasa|pasar)\s+/i.test(rawTarget) ||
          /^(?:now\s+)?(?:change|switch|cambia|cambiar|pasa|pasar)\s+/i.test(rawQuery)

        if (query) {
          const spotifyUri = `spotify:search:${encodeURIComponent(query)}`
          const webUrl = `https://open.spotify.com/search/${encodeURIComponent(query)}`

          // Trigger keyboard navigation & play command on Spotify to start playback on top result
          // If changing song: use 'change_top' which forces track change
          // If opening/regular play: use 'play_top' which verifies playback and avoids double toggling
          const triggerPlayback = () => {
            const escapedQuery = query.replace(/"/g, '`"').replace(/'/g, "''")
            const action = isChangeRequested ? 'change_top' : 'play_top'
            exec(
              `powershell -ExecutionPolicy Bypass -File "${mediaScriptPath}" -Action ${action} -Query "${escapedQuery}"`
            )
          }

          // Cold start: Spotify's window shows up before its UI accepts the search keys, so a
          // fixed delay lost the song and only a second request played it. Wait for the real
          // window, give the UI a moment, play, and retry once if nothing is playing.
          const playAfterColdStart = async () => {
            await ToolExecutor.waitForSpotifyWindow(30000)
            await new Promise((r) => setTimeout(r, 3000))
            triggerPlayback()
            await new Promise((r) => setTimeout(r, 7000))
            if (!(await ToolExecutor.isSpotifyPlaying())) {
              console.log('[ToolExecutor] Spotify is not playing after cold start, retrying the search')
              triggerPlayback()
            }
          }

          exec('tasklist /FI "IMAGENAME eq Spotify.exe"', (_err, stdout) => {
            const isAlreadyRunning = stdout && stdout.includes('Spotify.exe')
            if (isAlreadyRunning) {
              triggerPlayback()
            } else {
              if (fs.existsSync(spotifyExe)) {
                exec(`powershell -Command "Start-Process -FilePath '${spotifyExe}' -WorkingDirectory '${spotifyDir}'"`, () => {
                  void playAfterColdStart()
                })
              } else {
                exec(`cmd.exe /c start "" "${spotifyUri}"`, (err) => {
                  if (err) shell.openExternal(webUrl)
                  void playAfterColdStart()
                })
              }
            }
          })

          return {
            success: true,
            output: isChangeRequested
              ? `Switched track to "${query}" on Spotify!`
              : `Launched Spotify, searched for "${query}", and queued playback for the top result!`
          }
        } else {
          if (fs.existsSync(spotifyExe)) {
            exec(`powershell -Command "Start-Process -FilePath '${spotifyExe}' -WorkingDirectory '${spotifyDir}'"`)
          } else {
            exec('cmd.exe /c start spotify:', (_err) => {
              if (_err) shell.openExternal('https://open.spotify.com')
            })
          }

          // Trigger play resume
          setTimeout(() => {
            exec(`powershell -ExecutionPolicy Bypass -File "${mediaScriptPath}" -Action play`)
          }, 1000)

          return { success: true, output: 'Launched Spotify and resumed playback.' }
        }
      }

      // Discord
      if (target.includes('discord')) {
        if (isLinux) {
          if (!launchLinuxApp('discord')) await shell.openExternal('https://discord.com/app')
          return { success: true, output: 'Launched Discord.' }
        }
        exec('cmd.exe /c start discord:', (_err) => {
          if (_err) shell.openExternal('https://discord.com/app')
        })
        return { success: true, output: 'Launched Discord.' }
      }

      // Calculator
      if (/\bcalc/.test(target)) {
        if (isLinux) {
          return launchFirstLinuxApp(LINUX_CALCULATORS)
            ? { success: true, output: 'Opened the calculator.' }
            : { success: false, output: 'No calculator app is installed on this PC.' }
        }
        exec('cmd.exe /c start calc')
        return { success: true, output: 'Opened Windows Calculator.' }
      }

      // Notepad
      if (/\b(?:notepad|notas)\b/.test(target)) {
        if (isLinux) {
          return launchFirstLinuxApp(LINUX_EDITORS)
            ? { success: true, output: 'Opened the text editor.' }
            : { success: false, output: 'No text editor app is installed on this PC.' }
        }
        exec('cmd.exe /c start notepad')
        return { success: true, output: 'Opened Notepad.' }
      }

      // Games & Universal App Discovery (LoL, Cyberpunk, Palworld, Steam, Riot, Shortcuts)
      const gameLaunch = this.resolveGameLaunch(rawTarget)
      if (gameLaunch && (!gameLaunch.protocol || (await protocolIsRegistered(gameLaunch.protocol)))) {
        exec(gameLaunch.command)
        return {
          success: true,
          output: `Launched ${gameLaunch.name} successfully!`
        }
      }

      // Generic Windows Command Fallback (Never execute single preposition words as executables)
      if (/^(?:on|in|en|at|to|for|the|a|an)$/i.test(target)) {
        return { success: false, output: `Ignored invalid preposition target "${rawTarget}". Did you mean to search or play something on Spotify?` }
      }

      if (isLinux) {
        if (launchLinuxApp(rawTarget)) return { success: true, output: `Launched application: ${rawTarget}` }
        if (/^[\w-]+(?:\.[\w-]+)+$/.test(rawTarget)) {
          await shell.openExternal(`https://${rawTarget}`)
          return { success: true, output: `Opened website: ${rawTarget}` }
        }
        return await ToolExecutor.appNotFound(rawTarget, args)
      }

      // Store apps have no shortcut on disk, and "start" would open an error window for a name that doesn't exist
      if (!rawUrl) {
        const storeApp = await ToolExecutor.findStoreApp(rawTarget)
        if (storeApp) {
          exec(`explorer.exe "shell:AppsFolder\\${storeApp.id}"`)
          return { success: true, output: `Launched ${storeApp.name} successfully!` }
        }
        if (!/[\\/.:]/.test(rawTarget) && !(await ToolExecutor.isOnPath(rawTarget))) {
          return await ToolExecutor.appNotFound(rawTarget, args)
        }
      }

      const fullCmd = rawUrl ? `cmd.exe /c start "" "${rawTarget}" "${rawUrl}"` : `cmd.exe /c start "" "${rawTarget}"`
      exec(fullCmd, (_err) => {
        if (_err && rawTarget.includes('.')) {
          shell.openExternal(`https://${rawTarget}`)
        }
      })
      return { success: true, output: `Launched application or command: ${rawTarget}` }
    } catch (e: any) {
      return { success: false, output: `Failed to launch ${rawTarget}: ${e.message}` }
    }
  }

  /** She looked everywhere: asks the user where it is, unless nobody asked her to open it (askIfMissing: false) */
  private static async appNotFound(name: string, args: Record<string, unknown>): Promise<{ success: boolean; output: string }> {
    const picked = args.askIfMissing === false ? null : await askWhereAppIs(name)
    return picked
      ? { success: true, output: `Launched ${picked} from the location the user chose.` }
      : { success: false, output: `"${name}" isn't installed where I can find it, and the user didn't show me where it is.` }
  }

  private static async closeApplication(args: Record<string, unknown>): Promise<{ success: boolean; output: string }> {
    const rawTarget = String(args.appName || args.app || args.target || args.name || '').trim()
    if (!rawTarget) {
      return { success: false, output: 'Error: No application name specified to close.' }
    }

    const target = rawTarget.toLowerCase()

    try {
      // Check known game process list first (e.g. LoL, Cyberpunk, Palworld, Roblox, Valorant)
      const gameProcesses = this.resolveGameProcesses(target)
      if (gameProcesses.length > 0 && gameProcesses[0] !== target) {
        for (const proc of gameProcesses) {
          if (isWindows) {
            exec(`taskkill /IM "${proc}.exe" /F || powershell -Command "Stop-Process -Name '${proc}' -Force -ErrorAction SilentlyContinue"`)
          } else {
            killProcesses([proc])
          }
        }
        return { success: true, output: `Closed ${rawTarget} (terminated ${gameProcesses.join(', ')}).` }
      }

      if (target.includes('obs')) {
        killProcesses(['obs64', 'obs32', 'obs'])
        return { success: true, output: 'Closed OBS Studio.' }
      }

      if (
        target.includes('chrome') ||
        target.includes('navegador') ||
        target.includes('browser') ||
        target.includes('opera') ||
        target.includes('edge') ||
        target.includes('firefox') ||
        target.includes('brave') ||
        target.includes('internet')
      ) {
        if (target === 'chrome') {
          killProcesses(['chrome'])
          return { success: true, output: 'Closed Google Chrome.' }
        } else if (target === 'opera') {
          killProcesses(['opera', 'opera_gx'])
          return { success: true, output: 'Closed Opera browser.' }
        } else if (target === 'edge') {
          killProcesses(['msedge'])
          return { success: true, output: 'Closed Microsoft Edge.' }
        } else if (target === 'firefox') {
          killProcesses(['firefox'])
          return { success: true, output: 'Closed Mozilla Firefox.' }
        } else if (target === 'brave') {
          killProcesses(['brave'])
          return { success: true, output: 'Closed Brave browser.' }
        } else {
          // Universal browser close: kill whichever browser is currently running (Opera, Opera GX, Chrome, Edge, Brave, Firefox)
          killProcesses(['opera', 'opera_gx', 'chrome', 'msedge', 'brave', 'firefox'])
          return { success: true, output: 'Closed your browser.' }
        }
      }

      // Close generic active app: "cierra la app", "cierra alguna app", "close the app", "close an app"
      if (
        target === 'app' ||
        target === 'la app' ||
        target === 'the app' ||
        target === 'alguna app' ||
        target === 'an app' ||
        target === 'active_app' ||
        target.includes('aplicacion') ||
        target.includes('programa')
      ) {
        // Kill active browser, game, or spotify process without closing Capri
        killProcesses(['opera', 'opera_gx', 'chrome', 'msedge', 'brave', 'firefox', 'Spotify'])
        return { success: true, output: 'Closed active application.' }
      }

      if (target.includes('steam')) {
        killProcesses(['steam', 'steamwebhelper'])
        return { success: true, output: 'Closed Steam.' }
      }

      if (target.includes('spotify') || target.includes('musica') || target.includes('music')) {
        killProcesses(['Spotify'])
        return { success: true, output: 'Closed Spotify.' }
      }

      if (target.includes('discord')) {
        killProcesses(['Discord', 'DiscordPTB', 'DiscordCanary'])
        return { success: true, output: 'Closed Discord.' }
      }

      if (target.includes('calc') || target.includes('calculadora')) {
        killProcesses(['CalculatorApp', 'calc'])
        return { success: true, output: 'Closed the calculator.' }
      }

      if (target.includes('notepad') || target.includes('bloc de notas') || target.includes('notas')) {
        killProcesses(['notepad'])
        return { success: true, output: isWindows ? 'Closed Notepad.' : 'Closed the text editor.' }
      }

      if (target.includes('ollama')) {
        killProcesses(['ollama', 'ollama app'])
        return { success: true, output: 'Closed Ollama service.' }
      }

      // Generic application kill: strip .exe if provided
      const cleanName = rawTarget.replace(/\.exe$/i, '').trim()
      if (isWindows) {
        exec(`taskkill /IM "${cleanName}.exe" /F || powershell -Command "Stop-Process -Name '${cleanName}' -Force -ErrorAction SilentlyContinue"`)
      } else {
        killProcesses([cleanName])
      }
      return { success: true, output: `Closed application: ${cleanName}` }
    } catch (e: any) {
      return { success: false, output: `Failed to close ${rawTarget}: ${e.message}` }
    }
  }

  private static async deletePath(
    args: Record<string, unknown>,
    cwd: string
  ): Promise<{ success: boolean; output: string }> {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
    if (!rawPath) {
      return { success: false, output: 'Error: path parameter is required for delete_path' }
    }
    try {
      let resolved = rawPath
      if (!path.isAbsolute(resolved)) {
        resolved = path.join(cwd || process.cwd(), rawPath)
      }
      if (!fs.existsSync(resolved)) {
        return { success: false, output: `Target "${rawPath}" does not exist at "${resolved}".` }
      }
      // Never delete permanently: everything goes to the Recycle Bin / Trash so it can be restored
      const isDir = fs.statSync(resolved).isDirectory()
      await shell.trashItem(resolved)
      return { success: true, output: `Moved ${isDir ? 'folder' : 'file'} to the ${isWindows ? 'Recycle Bin' : 'Trash'}: ${resolved}` }
    } catch (e: any) {
      return { success: false, output: `Failed to delete ${rawPath}: ${e?.message || e}` }
    }
  }

  /** Title of Spotify's main window ('' while it's still loading or closed) */
  private static spotifyWindowTitle(): Promise<string> {
    if (isLinux) return linuxSpotifyTitle()
    return new Promise((resolve) => {
      exec(
        `powershell -NoProfile -Command "(Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle"`,
        { windowsHide: true, timeout: 5000 },
        (_err, stdout) => resolve(String(stdout || '').trim())
      )
    })
  }

  /** Waits until Spotify has a titled main window (its UI is up), up to timeoutMs */
  public static async waitForSpotifyWindow(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (await ToolExecutor.spotifyWindowTitle()) return true
      await new Promise((r) => setTimeout(r, 700))
    }
    return false
  }

  /** While a song plays, Spotify's window title is "Artist - Song" instead of just "Spotify ..." */
  public static async isSpotifyPlaying(): Promise<boolean> {
    const title = await ToolExecutor.spotifyWindowTitle()
    return !!title && !/^spotify(?:\s+(?:free|premium))?$/i.test(title)
  }

  public static async mediaControl(
    action: 'next' | 'prev' | 'play' | 'pause' | 'play_pause' = 'next',
    platform: PlaybackPlatform = consciousnessService.getMusicPlatform()
  ): Promise<{ success: boolean; output: string }> {
    const name = musicPlatformName(platform)
    if (isLinux) {
      return (await linuxMediaControl(action, platform !== 'spotify'))
        ? { success: true, output: `${name}: ${action} done.` }
        : { success: false, output: `No active ${name} media player is available.` }
    }
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    const spotifyExe = path.join(appData, 'Spotify', 'Spotify.exe')
    const spotifyDir = path.dirname(spotifyExe)
    const mediaScript = scriptPath('media_controller.ps1')

    if (platform === 'spotify' && fs.existsSync(spotifyExe)) {
      exec(`powershell -Command "if (-not (Get-Process Spotify -ErrorAction SilentlyContinue)) { Start-Process -FilePath '${spotifyExe}' -WorkingDirectory '${spotifyDir}' }"`)
    }

    return new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${mediaScript}" -Action "${action}"${platform !== 'spotify' ? ' -SystemMedia' : ''}`, (err) => {
        if (err) {
          resolve({ success: false, output: `Media control error: ${err.message}` })
        } else {
          const desc =
            action === 'next'
              ? `Skipped to the next song on ${name}`
              : action === 'prev'
              ? `Returned to the previous song on ${name}`
              : action === 'pause'
              ? `Paused ${name} playback`
              : action === 'play'
              ? `Resumed ${name} playback`
              : `Toggled playback on ${name}`
          resolve({ success: true, output: `${desc} successfully!` })
        }
      })
    })
  }

  public static async getMediaStatus(): Promise<{ isPlaying: boolean; title: string }> {
    if (isLinux) return linuxMediaStatus()
    const mediaScript = scriptPath('media_controller.ps1')

    return new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${mediaScript}" -Action "status"`, (err, stdout) => {
        if (err || !stdout) {
          resolve({ isPlaying: false, title: '' })
          return
        }
        try {
          const json = JSON.parse(stdout.trim())
          resolve({ isPlaying: !!json.isPlaying, title: String(json.title || '') })
        } catch {
          resolve({ isPlaying: false, title: '' })
        }
      })
    })
  }

  /** Opens Spotify if needed and plays a search, or resumes when there's no query */
  private static async linuxSpotify(query: string): Promise<{ success: boolean; output: string }> {
    const running = (await listProcessNames())?.has('spotify.exe')
    if (!running && !launchLinuxApp('spotify')) {
      await shell.openExternal(query ? `https://open.spotify.com/search/${encodeURIComponent(query)}` : 'https://open.spotify.com')
      return { success: true, output: 'The Spotify app is not installed here, so I opened the web player in the browser.' }
    }

    const play = async () => {
      await linuxOpenSpotifyUri(`spotify:search:${encodeURIComponent(query)}`)
      await new Promise((r) => setTimeout(r, 1500))
      await linuxClickSpotifyTopResult()
    }
    void (async () => {
      if (!running) {
        await ToolExecutor.waitForSpotifyWindow(30000)
        await new Promise((r) => setTimeout(r, 3000))
      }
      if (!query) return void (await linuxMediaControl('play'))
      await play()
      await new Promise((r) => setTimeout(r, 7000))
      if (!(await ToolExecutor.isSpotifyPlaying())) await play()
    })()

    return {
      success: true,
      output: query ? `Searched for "${query}" on Spotify and queued the top result.` : 'Launched Spotify and resumed playback.'
    }
  }

  // --- game & app resolver helpers ---
  private static resolveGameLaunch(rawQuery: string): { name: string; command: string; protocol?: string } | null {
    const q = rawQuery
      .toLowerCase()
      .replace(/^(?:el|la|los|las|the|a|an)\s+/i, '')
      // Only as a word of its own at the start: "epic games store" keeps its name
      .replace(/^(?:juego|game|app|aplicacion|programa)\s+/i, '')
      .trim()

    // League of Legends / LoL
    if (q === 'lol' || q.includes('league of legends') || q.includes('league') || q.includes('legends')) {
      const leagueClient = 'C:\\Riot Games\\League of Legends\\LeagueClient.exe'
      const riotClient = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe'
      if (fs.existsSync(leagueClient)) {
        return {
          name: 'League of Legends',
          command: `powershell -Command "Start-Process -FilePath '${leagueClient}'"`
        }
      }
      if (fs.existsSync(riotClient)) {
        return {
          name: 'League of Legends',
          command: `powershell -Command "Start-Process -FilePath '${riotClient}' -ArgumentList '--launch-product=league_of_legends --launch-patchline=live'"`
        }
      }
    }

    // Teamfight Tactics / TFT
    if (q === 'tft' || q.includes('teamfight tactics')) {
      const tftClient = 'C:\\Riot Games\\Teamfight Tactics\\Live\\TFTClient.exe'
      if (fs.existsSync(tftClient)) {
        return {
          name: 'Teamfight Tactics',
          command: `powershell -Command "Start-Process -FilePath '${tftClient}'"`
        }
      }
    }

    // Valorant
    if (q === 'valorant' || q === 'val') {
      const valClient = 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe'
      const riotClient = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe'
      if (fs.existsSync(valClient)) {
        return {
          name: 'VALORANT',
          command: `powershell -Command "Start-Process -FilePath '${valClient}'"`
        }
      }
      if (fs.existsSync(riotClient)) {
        return {
          name: 'VALORANT',
          command: `powershell -Command "Start-Process -FilePath '${riotClient}' -ArgumentList '--launch-product=valorant --launch-patchline=live'"`
        }
      }
    }

    // Steam Installed Games Discovery (reads all appmanifest_*.acf in real-time)
    const steamGames = this.getSteamGames()
    // Exact match first
    const exactSteam = steamGames.find((g) => g.name.toLowerCase() === q)
    if (exactSteam) {
      return {
        name: exactSteam.name,
        command: startCommand(`steam://rungameid/${exactSteam.id}`)
      }
    }
    // Partial match
    const partialSteam = steamGames.find(
      (g) => g.name.toLowerCase().includes(q) || (q.length >= 4 && q.includes(g.name.toLowerCase()))
    )
    if (partialSteam) {
      return {
        name: partialSteam.name,
        command: startCommand(`steam://rungameid/${partialSteam.id}`)
      }
    }

    // Installed apps and desktop launchers (.desktop)
    if (isLinux) {
      const entry = matchDesktopEntry(listDesktopEntries(), q)
      if (entry) return { name: entry.name, command: entry.exec }
    }

    // Desktop & Start Menu Shortcuts (.url / .lnk)
    const shortcut = this.findShortcut(q)
    if (shortcut) {
      return {
        name: shortcut.name.replace(/\.(url|lnk)$/i, '').replace(/ - acceso directo/i, ''),
        command: startCommand(shortcut.path)
      }
    }

    // Generic Protocol Handlers for popular games
    if (q.includes('roblox')) {
      return { name: 'Roblox', command: startCommand('roblox://'), protocol: 'roblox' }
    }
    if (q.includes('minecraft')) {
      return { name: 'Minecraft', command: startCommand('minecraft:'), protocol: 'minecraft' }
    }
    if (q.includes('fortnite')) {
      return { name: 'Fortnite', command: startCommand('com.epicgames.launcher://apps/Fortnite?action=launch'), protocol: 'com.epicgames.launcher' }
    }
    if (q.includes('epic')) {
      return { name: 'Epic Games', command: startCommand('com.epicgames.launcher:'), protocol: 'com.epicgames.launcher' }
    }

    return null
  }

  private static getSteamGames(): { id: string; name: string }[] {
    const steamAppsDirs = isLinux
      ? linuxSteamAppsDirs()
      : ['C:\\Program Files (x86)\\Steam\\steamapps', 'D:\\SteamLibrary\\steamapps', 'D:\\Steam\\steamapps']
    const games: { id: string; name: string }[] = []
    for (const dir of steamAppsDirs) {
      if (!fs.existsSync(dir)) continue
      try {
        const files = fs.readdirSync(dir)
        for (const f of files) {
          if (f.startsWith('appmanifest_') && f.endsWith('.acf')) {
            const content = fs.readFileSync(path.join(dir, f), 'utf8')
            const idMatch = content.match(/"appid"\s+"(\d+)"/i)
            const nameMatch = content.match(/"name"\s+"([^"]+)"/i)
            if (idMatch && nameMatch) {
              games.push({ id: idMatch[1], name: nameMatch[1] })
            }
          }
        }
      } catch {}
    }
    return games
  }

  private static storeApps: { name: string; id: string }[] | null = null

  /** Everything in the Start menu, Microsoft Store apps included */
  private static async findStoreApp(query: string): Promise<{ name: string; id: string } | null> {
    if (!isWindows) return null
    const q = query.toLowerCase().trim()
    if (q.length < 3) return null
    if (!ToolExecutor.storeApps) {
      ToolExecutor.storeApps = await new Promise((resolve) => {
        exec('powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"', { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          try {
            const parsed = JSON.parse(String(stdout || '[]'))
            resolve((Array.isArray(parsed) ? parsed : [parsed]).map((a: { Name: string; AppID: string }) => ({ name: a.Name, id: a.AppID })))
          } catch {
            resolve(err ? null : [])
          }
        })
      })
    }
    const apps = ToolExecutor.storeApps || []
    return apps.find((a) => a.name.toLowerCase() === q) || apps.find((a) => a.name.toLowerCase().startsWith(q)) || apps.find((a) => a.name.toLowerCase().includes(q)) || null
  }

  private static isOnPath(name: string): Promise<boolean> {
    return new Promise((resolve) => exec(`where "${name.replace(/"/g, '')}"`, { timeout: 4000 }, (err) => resolve(!err)))
  }

  private static findShortcut(cleanQuery: string): { name: string; path: string } | null {
    if (!isWindows) return null
    const user = process.env.USERNAME || os.userInfo().username
    const candidateDirs = [
      // The real one: OneDrive and folder moves change it
      app.getPath('desktop'),
      `C:\\Users\\${user}\\Desktop`,
      'C:\\Users\\Public\\Desktop',
      `C:\\Users\\${user}\\Desktop\\programas`,
      path.join(process.env.APPDATA || `C:\\Users\\${user}\\AppData\\Roaming`, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'
    ]

    const shortcuts: { name: string; path: string }[] = []
    function scan(dir: string, depth = 0): void {
      if (depth > 3 || !fs.existsSync(dir)) return
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true })
        for (const item of items) {
          const full = path.join(dir, item.name)
          if (item.isDirectory()) {
            scan(full, depth + 1)
          } else if (item.name.endsWith('.lnk') || item.name.endsWith('.url')) {
            shortcuts.push({ name: item.name, path: full })
          }
        }
      } catch {}
    }

    for (const dir of candidateDirs) scan(dir)

    return (
      shortcuts.find((s) => {
        const baseName = s.name.toLowerCase().replace(/\.(lnk|url)$/i, '').replace(/ - acceso directo/i, '')
        if (baseName === cleanQuery) return true
        if (cleanQuery.length >= 3 && baseName.includes(cleanQuery)) return true
        if (baseName.length >= 4 && cleanQuery.includes(baseName)) return true
        return false
      }) || null
    )
  }

  private static resolveGameProcesses(targetStr: string): string[] {
    const q = targetStr
      .toLowerCase()
      .replace(/^(?:el|la|los|las|the)\s+/i, '')
      .replace(/(?:juego|game|app|programa)\s*/i, '')
      .replace(/\.exe$/i, '')
      .trim()

    if (q === 'lol' || q.includes('league') || q.includes('legends')) {
      return ['LeagueClientUx', 'LeagueClient', 'League of Legends', 'RiotClientServices']
    }
    if (q === 'cyberpunk' || q.includes('cyberpunk') || q.includes('2077')) {
      return ['Cyberpunk2077']
    }
    if (q === 'valorant' || q === 'val') {
      return ['VALORANT-Win64-Shipping', 'VALORANT', 'RiotClientServices']
    }
    if (q.includes('palworld')) {
      return ['Palworld-WinGDK-Shipping', 'Pal']
    }
    if (q.includes('slay the spire')) {
      return ['SlayTheSpire', 'SlayTheSpire2', 'javaw']
    }
    if (q.includes('roblox')) {
      return ['RobloxPlayerBeta', 'RobloxStudioBeta', 'RobloxStudio']
    }

    return [q]
  }
}
