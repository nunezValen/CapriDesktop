import { launchMacApp, macAppName } from './mac-desktop'
/**
 * Finds and starts any installed app by name: a location the user already showed her, the Start menu
 * (Microsoft Store apps included), shortcuts, and on Windows what's registered as installed even with
 * no shortcut; on Linux, .desktop entries. If she can't find it, she asks the user where it is.
 */

import { app, dialog, shell } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { localizeLine } from '../../shared/lines'
import { appKey, bestAppMatch, looksLikeAppName } from './app-finder'
import { consciousnessService } from './consciousness-service'
import { exec, spawn } from './hidden-process'
import { findOnPath, isMac, isWindows, launchDesktopEntry, listDesktopEntries, type DesktopEntry } from './platform'
import { speak, speechLang } from './update-service'

interface InstalledApp {
  name: string
  /** Start menu id, opened through shell:AppsFolder */
  appId?: string
  file?: string
}

/** Start menu first: those are the entries made for people to click */
const LIST_WINDOWS_APPS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$apps = New-Object System.Collections.ArrayList
Get-StartApps | Where-Object { $_.AppID -notmatch '^https?:' } | ForEach-Object { [void]$apps.Add(@{ name = $_.Name; appId = $_.AppID }) }
$uninstall = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
Get-ItemProperty $uninstall -ErrorAction SilentlyContinue | ForEach-Object {
  $file = if ($_.DisplayIcon) { ($_.DisplayIcon -split ',')[0].Trim('"') } else { '' }
  if ($_.DisplayName -and $file -match '\\.exe$' -and $file -notmatch 'unins|setup|install' -and (Test-Path -LiteralPath $file)) {
    [void]$apps.Add(@{ name = $_.DisplayName; file = $file })
  }
}
Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*' -ErrorAction SilentlyContinue | ForEach-Object {
  $file = [string]$_.'(default)'
  if ($file) {
    $file = $file.Trim('"')
    $name = $_.PSChildName -replace '\\.exe$', ''
    if (Test-Path -LiteralPath $file) { [void]$apps.Add(@{ name = $name; file = $file }) }
  }
}
ConvertTo-Json -InputObject $apps -Compress
`

function listWindowsApps(): Promise<InstalledApp[]> {
  const encoded = Buffer.from(LIST_WINDOWS_APPS, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      try {
        const parsed = JSON.parse(String(stdout || '[]'))
        resolve(Array.isArray(parsed) ? parsed : [parsed])
      } catch {
        resolve([])
      }
    })
  })
}

function windowsShortcuts(): InstalledApp[] {
  const found: InstalledApp[] = []
  const scan = (dir: string, depth: number) => {
    if (depth > 3) return
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) scan(full, depth + 1)
      else if (/\.(?:lnk|url)$/i.test(item.name)) found.push({ name: item.name.replace(/\.(?:lnk|url)$/i, '').replace(/ - acceso directo/i, ''), file: full })
    }
  }
  for (const dir of [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'OneDrive', 'Desktop'), 'C:\\Users\\Public\\Desktop']) scan(dir, 2)
  return found
}

let cachedApps: { at: number; apps: InstalledApp[] } | null = null

/** Kept for a while because PowerShell takes seconds, but an app installed a minute ago still shows up */
async function windowsApps(): Promise<InstalledApp[]> {
  if (cachedApps && Date.now() - cachedApps.at < 60000) return cachedApps.apps
  const apps = [...(await listWindowsApps()), ...windowsShortcuts()]
  if (apps.length) cachedApps = { at: Date.now(), apps }
  return apps
}

function openWindowsAppId(appId: string): void {
  exec(`explorer.exe "shell:AppsFolder\\${appId.replace(/"/g, '')}"`)
}

/** Starts a file: an executable, or whatever the system opens that kind of file with */
async function startFile(file: string): Promise<boolean> {
  if (!fs.existsSync(file)) return false
  if (isMac) return (await shell.openPath(file)) === ''
  if (!isWindows && !file.endsWith('.desktop')) {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) {
        const child = spawn(file, [], { detached: true, stdio: 'ignore', cwd: path.dirname(file) })
        child.on('error', () => {})
        child.unref()
        return true
      }
    } catch {
      // not executable: the system decides
    }
  }
  // ShellExecute on Windows: runs from the program's own folder and handles .lnk and admin prompts
  return (await shell.openPath(file)) === ''
}

/** Opens an installed app by name. Returns the name it found, or null if it isn't anywhere */
export async function openInstalledApp(request: string): Promise<string | null> {
  const key = appKey(request)
  if (!key) return null

  const remembered = consciousnessService.getAppPath(key)
  if (remembered) {
    if (await startFile(remembered)) return path.parse(remembered).name
    consciousnessService.forgetAppPath(key) // it was moved or uninstalled
  }

  if (isWindows) {
    const found = bestAppMatch(request, await windowsApps())
    if (!found) return null
    if (found.appId) {
      openWindowsAppId(found.appId)
      return found.name
    }
    return found.file && (await startFile(found.file)) ? found.name : null
  }

  if(isMac) {
    const bundles:InstalledApp[]=[]
    const scan=(dir:string,depth=0)=>{
      if(depth>2) return
      try {for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
        if(!item.isDirectory()) continue
        const full=path.join(dir,item.name)
        if(item.name.endsWith('.app')) bundles.push({name:item.name.slice(0,-4),file:full})
        else scan(full,depth+1)
      }} catch {}
    }
    for(const dir of ['/Applications','/System/Applications',path.join(os.homedir(),'Applications')]) scan(dir)
    const match=bestAppMatch(macAppName(request),bundles)
    return match?.file && await launchMacApp(match.file) ? match.name : null
  }
  const entry = bestAppMatch<DesktopEntry>(request, listDesktopEntries())
  if (entry) return launchDesktopEntry(entry) ? entry.name : null
  const onPath = /^[\w.+-]+$/.test(request) ? findOnPath(request.toLowerCase()) || findOnPath(request) : null
  return onPath && (await startFile(onPath)) ? path.basename(onPath) : null
}

/**
 * She says she can't find it and lets the user pick the file, remembering it for next time.
 * Returns the app's name, or null if it isn't worth asking or the user closed the window.
 */
export async function askWhereAppIs(request: string): Promise<string | null> {
  if (!looksLikeAppName(request)) return null
  const lang = speechLang()
  speak(
    lang === 'es'
      ? `[curious] No encuentro ${request} por ningún lado, choomba. Mostrame dónde está y me lo acuerdo.`
      : `[curious] I can't find ${request} anywhere, choomba. Show me where it is and I'll remember it.`
  )
  const picked = await dialog.showOpenDialog({
    title: localizeLine(lang === 'es' ? `¿Dónde está ${request}?` : `Where is ${request}?`, lang),
    defaultPath: isMac ? '/Applications' : isWindows ? process.env.ProgramFiles || 'C:\\' : os.homedir(),
    properties: ['openFile'],
    filters: isWindows ? [{ name: 'Apps', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }] : []
  })
  const file = picked.filePaths[0]
  if (picked.canceled || !file || !(await startFile(file))) return null
  consciousnessService.setAppPath(appKey(request), file)
  return path.parse(file).name
}

/** Whether something on this PC answers a link like steam:// . Starting one that doesn't shows an error window */
export function protocolIsRegistered(protocol: string): Promise<boolean> {
  if(isMac) {try {return Promise.resolve(!!app.getApplicationNameForProtocol(`${protocol}:`))} catch {return Promise.resolve(false)}}
  return new Promise((resolve) => {
    const command = isWindows ? `reg query "HKCR\\${protocol}" /ve` : `xdg-mime query default x-scheme-handler/${protocol}`
    exec(command, { timeout: 5000 }, (err, stdout) => resolve(!err && (isWindows || !!String(stdout).trim())))
  })
}
