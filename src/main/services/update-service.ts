import { updateDelivery } from '../../shared/platform-policy'
/**
 * Self-update and patch scripts.
 *
 * - "Capri, actualizate": checks the latest GitHub Release; if it's newer, downloads the
 *   installer, runs it silently and the app restarts on the new version. On Linux she does the same
 *   with the package she was installed from (see linux-update.ts), and the release page is the fallback.
 * - First run of a new version: Capri reads the patch scripts in scripts-capri/ for every
 *   version she skipped (one file per version and language, e.g. 0.2.0.es.txt).
 */

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from './hidden-process'
import { app, shell } from 'electron'
import { resourceRoot } from './app-paths'
import { isMac, isLinux } from './platform'
import { installDeb, linuxInstallKind, restartAfterUpdate, unpackNextToApp } from './linux-update'
import { startIndependently, windowsUpdateScript } from './windows-update'
import { localizeLine } from '../../shared/lines'
import { consciousnessService } from './consciousness-service'
import { personalize } from './user-profile'
import { windowManager } from '../windows/window-manager'
import { IPC_CHANNELS } from '../ipc/channels'

const REPO = 'nunezValen/CapriDesktop'
const SCRIPT_FILE = /^(\d+\.\d+\.\d+)(?:\.(es|en))?\.txt$/i

type Lang = string

/** -1 / 0 / 1, comparing "1.2.3" style versions (a leading "v" is ignored) */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

function scriptsDir(): string {
  return path.join(resourceRoot(), 'scripts-capri')
}

/** Versions that have a patch script, oldest first */
function scriptVersions(): string[] {
  try {
    const versions = new Set<string>()
    for (const f of fs.readdirSync(scriptsDir())) {
      const m = f.match(SCRIPT_FILE)
      if (m) versions.add(m[1])
    }
    return Array.from(versions).sort(compareVersions)
  } catch {
    return []
  }
}

/** The script for one version in the user's language (falls back to the other language) */
export function readPatchScript(version: string, lang: Lang): string | null {
  for (const name of [`${version}.${lang}.txt`, `${version}.txt`, `${version}.en.txt`, `${version}.es.txt`]) {
    const p = path.join(scriptsDir(), name)
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf-8').replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  }
  return null
}

export function speechLang(): Lang {
  const s = consciousnessService.getLanguageSettings()
  return s.speechLang && s.speechLang !== 'auto' ? s.speechLang : consciousnessService.getPreferredLanguage()
}

/** Speaks a line through the companion (bubble + voice) */
export function speak(text: string): void {
  const durationMs = Math.min(60000, Math.max(5000, text.length * 75))
  windowManager.broadcast(IPC_CHANNELS.COMPANION_SPEECH_CHANGED, { text: personalize(localizeLine(text, speechLang())), durationMs, speakVoice: true })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Rough time a spoken line takes, so the next one doesn't cut it off */
const speakTime = (text: string) => Math.max(5000, text.length * 70 + 2000)

class UpdateService {
  private busy = false

  /** On the first run of a newer version, read the scripts of every version that was skipped */
  public async announcePatchNotesIfUpdated(): Promise<void> {
    const current = app.getVersion()
    const last = consciousnessService.getLastRunVersion()
    // Fresh install (or the setup wizard is still pending): nothing to compare against
    if (!last || !consciousnessService.isOnboardingDone() || compareVersions(current, last) <= 0) {
      consciousnessService.setLastRunVersion(current)
      return
    }

    const lang = speechLang()
    const skipped = scriptVersions().filter((v) => compareVersions(v, last) > 0 && compareVersions(v, current) <= 0)
    console.log(`[UpdateService] updated ${last} -> ${current}, patch scripts: ${skipped.join(', ') || 'none'}`)
    for (const v of skipped) {
      const script = readPatchScript(v, lang)
      if (!script) continue
      speak(script)
      await wait(speakTime(script))
    }
    // Only now: closing her in the middle shouldn't lose the notes for good
    consciousnessService.setLastRunVersion(current)
  }

  /** "¿En qué versión estás?" */
  public versionLine(lang: Lang): string {
    const current = app.getVersion()
    return lang === 'es' ? `[happy] Estoy en la versión ${current}, choomba.` : `[happy] I'm on version ${current}, choomba.`
  }

  /** "¿Qué hay de nuevo?": the script of the version that's running */
  public whatsNew(lang: Lang): string {
    const current = app.getVersion()
    const script = readPatchScript(current, lang)
    if (script) return script
    return lang === 'es'
      ? `[curious] Estoy en la versión ${current}, pero no tengo notas de este parche, choomba.`
      : `[curious] I'm on version ${current}, but there are no notes for this patch, choomba.`
  }

  /** Checks GitHub Releases; if there's a newer version, downloads it, installs it and restarts */
  public async checkAndInstall(lang: Lang): Promise<void> {
    const es = lang === 'es'
    if (this.busy) return
    this.busy = true
    // Let the first "let me check" line play before speaking again
    const started = Date.now()
    const sayAfterIntro = async (text: string) => {
      const left = 4500 - (Date.now() - started)
      if (left > 0) await wait(left)
      speak(text)
    }
    let tempDir: string | null = null

    try {
      const current = app.getVersion()
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CapriDesktop-Updater' }
      })
      if (res.status === 404) {
        await sayAfterIntro(
          es
            ? `[curious] Todavía no hay ninguna versión publicada, choomba. Estoy en la ${current}.`
            : `[curious] No version has been published yet, choomba. I'm on ${current}.`
        )
        return
      }
      if (!res.ok) throw new Error(`GitHub respondió ${res.status}`)
      const release = (await res.json()) as {
        tag_name?: string
        html_url?: string
        assets?: { name: string; size: number; browser_download_url: string; digest?: string | null }[]
      }
      const latest = String(release.tag_name || '').replace(/^v/i, '')

      if (!latest || compareVersions(latest, current) <= 0) {
        await sayAfterIntro(
          es
            ? `[happy] Ya estoy en la última versión, la ${current}. [playful] Más actualizada imposible, choomba.`
            : `[happy] I'm already on the latest version, ${current}. [playful] Can't get any fresher, choomba.`
        )
        return
      }

      if (updateDelivery(process.platform, app.isPackaged, !!process.env.APPIMAGE) === 'source') {
        await sayAfterIntro(
          es
            ? `[excited] Hay una versión nueva, la ${latest}. [curious] Pero estoy corriendo desde el código: hacé git pull y reiniciame.`
            : `[excited] There's a new version, ${latest}. [curious] But I'm running from source: git pull and restart me.`
        )
        return
      }

      if (isMac && updateDelivery(process.platform, app.isPackaged, !!process.env.APPIMAGE) === 'release-page') {
        await sayAfterIntro(`Version ${latest} is available. Opening the release page for a manual Mac update.`)
        await shell.openExternal('https://github.com/nunezValen/CapriDesktop/releases/latest')
        return
      }
      const assets = release.assets || []
      const appImage = isLinux && !!process.env.APPIMAGE
      const linuxInstall = isLinux && !appImage ? await linuxInstallKind(process.execPath) : null
      const linuxAsset = (pattern: RegExp) => assets.find((a) => pattern.test(a.name))
      const asset = !isLinux
        ? assets.find((a) => /setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name))
        : appImage
          ? linuxAsset(/\.AppImage$/i)
          : linuxInstall === 'deb'
            ? linuxAsset(/\.deb$/i)
            : linuxInstall === 'folder'
              ? linuxAsset(/\.tar\.gz$/i)
              : undefined
      // She can't replace this install by herself: the release page is what's left
      if (isLinux && !appImage && !asset) {
        await sayAfterIntro(
          es
            ? `[excited] ¡Salió la versión ${latest}! [curious] No puedo instalarla sola en este sistema, así que te abro la página para que bajes el paquete.`
            : `[excited] Version ${latest} is out! [curious] I can't install it by myself on this system, so I'm opening the page for you to grab the package.`
        )
        if (release.html_url) await shell.openExternal(release.html_url)
        return
      }
      if (!asset) {
        await sayAfterIntro(
          es
            ? `[worried] Salió la ${latest}, pero el release no tiene instalador para ${isLinux ? 'Linux' : 'Windows'}.`
            : `[worried] Version ${latest} is out, but the release has no ${isLinux ? 'Linux' : 'Windows'} installer.`
        )
        return
      }

      await sayAfterIntro(
        es
          ? `[excited] ¡Salió la versión ${latest}! Me la bajo, dame un toque.`
          : `[excited] Version ${latest} is out! Downloading it, give me a sec.`
      )

      // Next to the running AppImage: a rename only replaces it in place within the same disk
      // A private folder for the Linux packages: the .deb gets installed as root
      if (linuxInstall) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-update-'))
      const exe = appImage ? `${process.env.APPIMAGE}.new` : path.join(tempDir ?? os.tmpdir(), asset.name)
      await download(asset.browser_download_url, exe)
      const size = fs.statSync(exe).size
      if (asset.size && size !== asset.size) throw new Error(`descarga incompleta (${size} de ${asset.size} bytes)`)
      const digest = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase()
      if (digest && (await sha256File(exe)) !== digest) throw new Error('la descarga no coincide con la publicada')

      if (linuxInstall === 'deb') {
        const ask = es
          ? `[happy] ¡Ya la tengo! [curious] Tu sistema te va a pedir la contraseña para instalarla. [playful] La ponés y vuelvo en un toque.`
          : `[happy] Got it! [curious] Your system will ask for your password to install it. [playful] Type it in and I'll be right back.`
        speak(ask)
        await wait(speakTime(ask))
        const result = await installDeb(exe)
        if (result.status === 'cancelled') {
          speak(
            es
              ? `[curious] Sin contraseña no la puedo instalar, así que sigo en la ${current}. Pedímelo de nuevo cuando quieras.`
              : `[curious] I can't install it without the password, so I'm staying on ${current}. Ask me again whenever you want.`
          )
          return
        }
        if (result.status === 'failed') {
          speak(
            es
              ? `[worried] No pude instalarla: ${result.reason}. Te abro la página para que lo hagas a mano.`
              : `[worried] I couldn't install it: ${result.reason}. I'm opening the page so you can do it by hand.`
          )
          if (release.html_url) await shell.openExternal(release.html_url)
          return
        }
        // Nothing more to say: the files her voice needs were just replaced
        restartAfterUpdate(process.execPath)
        setTimeout(() => app.quit(), 500)
        return
      }

      const newFolder = linuxInstall === 'folder' ? await unpackNextToApp(exe, process.execPath) : ''

      const bye = es
        ? `[happy] ¡Listo, ya la tengo! [playful] Me reinicio y vuelvo en un toque. [giggles] No me extrañes.`
        : `[happy] Got it! [playful] Restarting, I'll be right back. [giggles] Don't miss me.`
      speak(bye)
      await wait(speakTime(bye))

      if (linuxInstall === 'folder') {
        restartAfterUpdate(process.execPath, newFolder)
      } else if (appImage) {
        const current = process.env.APPIMAGE as string
        fs.chmodSync(exe, 0o755)
        fs.renameSync(exe, current)
        spawn(current, ['--updated'], { detached: true, stdio: 'ignore' }).unref()
      } else {
        await startWindowsUpdate(exe)
      }
      setTimeout(() => app.quit(), 1500)
    } catch (err: any) {
      console.warn('[UpdateService] update failed:', err)
      await sayAfterIntro(
        es
          ? `[worried] No pude actualizarme: ${err?.message || err}. Probá de nuevo en un rato.`
          : `[worried] I couldn't update: ${err?.message || err}. Try again in a bit.`
      )
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
      this.busy = false
    }
  }
}

/** Silent NSIS install over the current one. She only closes once something is really installing. */
async function startWindowsUpdate(installer: string): Promise<void> {
  const script = path.join(os.tmpdir(), 'capri-update.ps1')
  const marker = path.join(os.tmpdir(), 'capri-update-started.txt')
  fs.rmSync(marker, { force: true })
  // With a BOM, or Windows PowerShell misreads any path that isn't plain ASCII
  fs.writeFileSync(script, `\uFEFF${windowsUpdateScript(installer, process.execPath, marker)}`, 'utf-8')

  const launch = (command: string) => {
    const { file, args } = startIndependently(command)
    spawn(file, args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
  }
  launch(`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`)

  for (let waited = 0; waited < 8000 && !fs.existsSync(marker); waited += 250) await wait(250)
  if (fs.existsSync(marker)) return
  // No script running: the installer directly, which loses the retries but still updates her
  console.warn('[UpdateService] The update script did not start, running the installer directly')
  launch(`"" "${installer}" /S --updated --force-run`)
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'CapriDesktop-Updater' } })
  if (!res.ok || !res.body) throw new Error(`la descarga respondió ${res.status}`)
  const out = fs.createWriteStream(dest)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()))
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
}

export const updateService = new UpdateService()
