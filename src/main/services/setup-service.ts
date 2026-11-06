import { recommendedLocalModel } from '../../shared/platform-policy'
/**
 * First-run setup: Python voice environment, FFmpeg, Ollama and the local models.
 * Downloads go through winget / pip and stream their output to the onboarding window.
 * When winget is missing or fails (fresh or stripped-down Windows), the official installers
 * are downloaded directly and run silently, so a PC with nothing installed still works.
 * On Linux, FFmpeg and Ollama are unpacked into the app's own folder with no password; only what
 * has to be a system package (Python) goes through the package manager and its password prompt.
 */

import { getStorageRoot, ollamaModelsDir, programDirs, setStorageRoot, storageDir } from './storage-location'
import { copyTree, isInside, MovePlan, planMove, samePath } from './storage-move'
import { app, dialog } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, execFile } from 'child_process'
import { speechModelsDir, voiceDataDir, localFfmpegPath, pythonEnvDir, scriptPath, toolsDir, venvPython } from './app-paths'
import { findOnPath, isMac, isWindows, killProcesses, linuxInstallCommand, linuxPackageManager } from './platform'
import { ollamaService } from './ollama-service'
import { voiceService } from './voice-service'
import { createHash } from 'crypto'
import { consciousnessService } from './consciousness-service'
import { isCloudMode } from './llm-gateway'
import { windowManager } from '../windows/window-manager'
import { localizeLine } from '../../shared/lines'
import { getUserName } from './user-profile'

export type SetupStep = 'python' | 'ffmpeg' | 'ollama' | 'model' | 'persona' | 'whisper'

export interface SetupStatus {
  python: { systemPython: string | null; envReady: boolean }
  ffmpeg: boolean
  ollama: { installed: boolean; running: boolean; models: string[] }
  model: boolean
  persona: boolean
  recommendedModel: string
}

export const DEFAULT_MODEL = recommendedLocalModel(process.platform, os.totalmem())

// Linux distros move to new versions quickly: the voice packages were checked on 3.14 there
const SUPPORTED_PYTHON = isMac ? /Python 3\.11\./ : isWindows ? /Python 3\.(1[0-3])/ : /Python 3\.(1[0-4])/

/** Direct-download fallbacks used when winget is not available */
const PYTHON_INSTALLER_URL = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe'
const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe'
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

const LINUX_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64'
const LINUX_OLLAMA_URL = `https://ollama.com/download/ollama-linux-${LINUX_ARCH}.tar.zst`
const LINUX_OLLAMA_SCRIPT = 'curl -fsSL https://ollama.com/install.sh | sh'
const LINUX_FFMPEG_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux${process.arch === 'arm64' ? 'arm64' : '64'}-gpl.tar.xz`

type Logger = (step: SetupStep | 'storage', line: string) => void

function run(cmd: string, args: string[], onLine: (l: string) => void, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true, cwd: opts.cwd, env: opts.env || process.env })
    const feed = (buf: Buffer) =>
      buf
        .toString()
        .split(/\r?\n|\r/)
        .map((l) => l.trim())
        .filter(Boolean)
        .forEach(onLine)
    proc.stdout.on('data', feed)
    proc.stderr.on('data', feed)
    proc.on('error', (err) => {
      onLine(`error: ${err.message}`)
      resolve(1)
    })
    proc.on('close', (code) => resolve(code ?? 1))
  })
}

function quick(cmd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() })
    })
  })
}

export class SetupService {
  private static instance: SetupService
  private busy = false

  public static getInstance(): SetupService {
    if (!SetupService.instance) SetupService.instance = new SetupService()
    return SetupService.instance
  }

  // Detection

  /** A real Python 3.10-3.13 (the Microsoft Store "python" alias doesn't count) */
  private async findSystemPython(): Promise<string | null> {
    if (isMac) {
      for (const py of [findOnPath('python3.11'), '/opt/homebrew/opt/python@3.11/bin/python3.11', '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11'].filter((p): p is string => !!p)) {
        const result = await quick(py, ['--version'])
        if (result.ok && SUPPORTED_PYTHON.test(result.out)) return py
      }
      return null
    }
    if (!isWindows) {
      for (const cmd of ['python3.12', 'python3.11', 'python3.13', 'python3.10', 'python3.14', 'python3', 'python']) {
        const r = await quick(cmd, ['--version'])
        if (r.ok && SUPPORTED_PYTHON.test(r.out)) return cmd
      }
      return null
    }
    const candidates: [string, string[]][] = [
      ['py', ['-3.11', '--version']],
      ['py', ['-3.12', '--version']],
      ['py', ['-3.10', '--version']],
      ['py', ['-3.13', '--version']],
      ['python', ['--version']]
    ]
    for (const [cmd, args] of candidates) {
      const r = await quick(cmd, args)
      if (r.ok && SUPPORTED_PYTHON.test(r.out)) return cmd === 'py' ? `py ${args[0]}` : cmd
    }
    // Fresh install not yet on PATH (per-user or all-users location)
    for (const v of ['Python311', 'Python312', 'Python313', 'Python310']) {
      const places = [
        ...programDirs('Python').map((dir) => path.join(dir, 'python.exe')),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', v, 'python.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', v, 'python.exe')
      ]
      for (const p of places) if (fs.existsSync(p)) return p
    }
    return null
  }

  /**
   * Her voice lives in an environment made by the first-run setup, which can be skipped or fail
   * halfway. If it's missing she rebuilds it by herself in the background. She doesn't install
   * Python without asking: that stays in the setup.
   */
  public async repairVoiceEnv(): Promise<void> {
    if (!app.isPackaged || this.busy || (await this.voiceEnvReady())) return
    if (!(await this.findSystemPython())) {
      console.warn('[Setup] The voice environment is missing and this PC has no Python: run the setup again.')
      return
    }
    this.busy = true
    console.log('[Setup] The voice environment is missing or incomplete, rebuilding it...')
    try {
      // No password prompts out of nowhere: on Linux a missing system package waits for the setup
      const ok = await this.installVoiceEnv((_step, line) => console.log(`[Setup] ${line}`), false)
      console.log(ok ? '[Setup] Voice environment ready.' : '[Setup] The voice environment is still incomplete.')
      if (ok) voiceService.restartWorker()
    } finally {
      this.busy = false
    }
  }

  /**
   * What's still missing for her to work. With Ollama closed its models can't be read, and that
   * doesn't mean they're gone, so only a missing Ollama counts then. Any local model is enough: the
   * user may have chosen another one.
   */
  public async missingSetup(): Promise<SetupStep[]> {
    const s = await this.getStatus()
    const missing: SetupStep[] = []
    if (!s.python.envReady) missing.push('python')
    if (!s.ffmpeg) missing.push('ffmpeg')
    if (!isCloudMode()) {
      if (!s.ollama.installed) missing.push('ollama')
      else if (s.ollama.running && s.ollama.models.length === 0) missing.push('model')
    }
    return missing
  }

  /**
   * New location for what's installed from now on. What's already somewhere else stays there and
   * keeps working. Ollama is told too: the copy that starts with Windows would otherwise keep
   * filling the old disk.
   */
  public async changeStorage(root: string | null): Promise<void> {
    const previous = getStorageRoot()
    setStorageRoot(root)
    if (root) fs.mkdirSync(root, { recursive: true })
    if (!root) await this.forgetOllamaFolder(previous)
    await this.pointOllamaAtStorage()
    console.log(`[Setup] Requirements will go to ${root || 'the default folders'}`)
  }

  /** Back to the default folders: Ollama stops being told to use the folder she gave it */
  private async forgetOllamaFolder(previousRoot: string | null): Promise<void> {
    const current = process.env.OLLAMA_MODELS
    if (!isWindows || !previousRoot || !current || !isInside(current, previousRoot)) return
    delete process.env.OLLAMA_MODELS
    await quick('reg', ['delete', 'HKCU\\Environment', '/v', 'OLLAMA_MODELS', '/f'])
  }

  /**
   * The Ollama program, when it can go somewhere else. Not one in Program Files: that one needs
   * administrator rights and isn't hers.
   */
  private movableOllamaProgram(root: string | null): { from: string; to: string } | null {
    if (!isWindows) return null
    const binary = ollamaService.findOllamaBinary()
    if (!binary) return null
    const from = path.dirname(binary)
    if (path.basename(from).toLowerCase() !== 'ollama') return null
    for (const protectedDir of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (protectedDir && isInside(from, protectedDir)) return null
    }
    return { from, to: root ? path.join(root, 'Ollama') : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama') }
  }

  /** What moving there would take, for the user to confirm */
  public planStorageMove(root: string | null): Promise<MovePlan> {
    return planMove(root, this.movableOllamaProgram(root))
  }

  /**
   * Takes what's already installed to a new location. Nothing old is deleted until the copies are
   * complete and the location has changed: if a copy fails, she stays exactly as she was.
   */
  public async moveStorage(root: string | null, log: Logger): Promise<boolean> {
    if (this.busy) {
      log('storage', 'Another setup step is still running...')
      return false
    }
    this.busy = true
    const say = (line: string) => log('storage', line)
    let stopped = false
    const resume = async () => {
      if (!stopped) return
      voiceService.restartWorker()
      if (!isCloudMode()) await ollamaService.ensureRunning()
    }
    try {
      const plan = await this.planStorageMove(root)
      if (plan.invalid || !plan.enoughSpace) {
        say(plan.invalid ? "That folder is inside what's being moved." : 'There is not enough free space there.')
        return false
      }
      if (!plan.items.length && !plan.ollamaProgram) {
        await this.changeStorage(root)
        return true
      }

      if(isMac && plan.items.some(item=>item.kind==='models') && !ollamaService.servingModelsDir()) {
        const external=await fetch('http://127.0.0.1:11434/',{signal:AbortSignal.timeout(1200)}).then(r=>r.ok).catch(()=>false)
        if(external) {say('Quit standalone Ollama before moving its Capri-managed model folder. No files were changed.');return false}
      }
      // Their files stay open while they run, and Windows wouldn't let them be deleted
      say('Closing Ollama and her hearing while everything moves...')
      stopped = true
      voiceService.stopServer()
      if (isWindows) {
        await quick('taskkill', ['/IM', 'ollama app.exe', '/F'])
        await quick('taskkill', ['/IM', 'ollama.exe', '/F'])
      } else if(isMac) {
        await ollamaService.stop() // only a server Capri owns; do not kill unrelated Mac processes
      } else {
        killProcesses(['ollama'])
      }
      await new Promise((r) => setTimeout(r, 1500))

      const toCopy = plan.items.reduce((sum, i) => sum + i.bytes, 0)
      let copied = 0
      let lastPct = -10
      const created: string[] = []
      try {
        for (const item of plan.items) {
          say(`Copying ${item.from} to ${item.to}`)
          if (!fs.existsSync(item.to)) created.push(item.to)
          await copyTree(item.from, item.to, (n) => {
            copied += n
            const pct = toCopy ? Math.floor((copied / toCopy) * 100) : 100
            if (pct >= lastPct + 10) {
              lastPct = pct
              say(`${pct}% (${(copied / 1048576).toFixed(0)} / ${(toCopy / 1048576).toFixed(0)} MB)`)
            }
          })
        }
      } catch (err: any) {
        say(`The copy failed, nothing was moved: ${err?.message || err}`)
        for (const dir of created) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
        await resume()
        return false
      }

      // A voice environment doesn't always survive being moved. Better to know before relying on it
      const movedEnv = plan.items.find((i) => i.kind === 'voiceEnv')
      let rebuildEnv = false
      if (movedEnv) {
        const py = isWindows ? path.join(movedEnv.to, 'Scripts', 'python.exe') : path.join(movedEnv.to, 'bin', 'python')
        if (!(await quick(py, ['-c', 'import edge_tts, faster_whisper'], 60000)).ok) {
          say('The voice environment needs rebuilding in the new location.')
          await fs.promises.rm(movedEnv.to, { recursive: true, force: true }).catch(() => {})
          rebuildEnv = true
        }
      }

      const previous = getStorageRoot()
      setStorageRoot(root)
      if (root) fs.mkdirSync(root, { recursive: true })
      if (!root) await this.forgetOllamaFolder(previous)

      if (plan.ollamaProgram) {
        // By its installer: Windows has it registered, and it updates itself from that folder
        const { from, to } = plan.ollamaProgram
        say(`Reinstalling the Ollama program in ${to}`)
        await this.installOllamaDirect(log, to)
        if (fs.existsSync(path.join(to, 'ollama.exe'))) {
          await quick('taskkill', ['/IM', 'ollama app.exe', '/F'])
          await quick('taskkill', ['/IM', 'ollama.exe', '/F'])
          await fs.promises.rm(from, { recursive: true, force: true }).catch(() => say(`Couldn't delete ${from}, you can do it by hand.`))
        } else {
          say(`The Ollama program couldn't be moved, it stays in ${from} and keeps working.`)
        }
      }
      await this.pointOllamaAtStorage()

      if (rebuildEnv && !(await this.installVoiceEnv(log, false))) {
        // Never delete the usable old environment if rebuilding at the destination failed.
        setStorageRoot(previous)
        await this.pointOllamaAtStorage()
        say('Voice setup failed at the new location. The previous location and files have been retained.')
        await resume()
        return false
      }

      for (const item of plan.items) {
        await fs.promises.rm(item.from, { recursive: true, force: true }).catch(() => say(`Couldn't delete ${item.from}, you can do it by hand.`))
      }
      if (previous && !samePath(previous, root || '')) {
        await fs.promises.rm(path.join(previous, 'pip-cache'), { recursive: true, force: true }).catch(() => {})
        // Only if nothing's left: Python and any other program stay in it
        await fs.promises.rmdir(previous).catch(() => {})
      }

      await resume()
      say('Done.')
      return true
    } catch (err: any) {
      say(`error: ${err?.message || err}`)
      await resume()
      return false
    } finally {
      this.busy = false
    }
  }

  /** Ollama starts with Windows on its own, so it has to be told too or it fills the old disk */
  private async pointOllamaAtStorage(): Promise<void> {
    const models = ollamaModelsDir()
    // Her own environment says nothing about the Ollama that's running: its installer starts one by
    // itself. Only one she started knows for sure where it's keeping models
    if (!isWindows || !models || ollamaService.servingModelsDir() === models) return
    fs.mkdirSync(models, { recursive: true })
    process.env.OLLAMA_MODELS = models
    await quick('setx', ['OLLAMA_MODELS', models])
    await quick('taskkill', ['/IM', 'ollama app.exe', '/F'])
    await quick('taskkill', ['/IM', 'ollama.exe', '/F'])
  }

  /** An update can change her persona: an installed model keeps the old one until it's rebuilt */
  public async refreshPersona(): Promise<void> {
    if (!app.isPackaged || this.busy || isCloudMode()) return
    const version = createHash('sha256').update(fs.readFileSync(scriptPath('Modelfile.capri'))).digest('hex')
    if (consciousnessService.getPersonaVersion() === version) return
    const tags = await ollamaService.queryTags()
    // With Ollama closed there's no way to know: it waits for the next start
    if (!tags.running) return
    if (tags.models.some((m) => m.toLowerCase().startsWith('capri'))) {
      this.busy = true
      try {
        if (!(await this.createPersona((_step, line) => console.log(`[Setup] ${line}`)))) return
      } finally {
        this.busy = false
      }
    }
    consciousnessService.setPersonaVersion(version)
  }

  /** Offers the setup when it was left incomplete. Never in the middle of a game. */
  public async warnIfIncomplete(): Promise<void> {
    if (!app.isPackaged || consciousnessService.isSetupNoticeDismissed() || windowManager.isGamingModeActive()) return
    const missing = await this.missingSetup()
    if (!missing.length) return
    console.log(`[Setup] Incomplete: ${missing.join(', ')}`)
    const lang = consciousnessService.getPreferredLanguage()
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Capri Desktop',
      message: localizeLine("Part of my setup is missing, so some things might not work. Want to open it and finish?", lang),
      buttons: [localizeLine('Open setup', lang), localizeLine('Not now', lang)],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: localizeLine("Don't ask me again", lang)
    })
    if (checkboxChecked) consciousnessService.dismissSetupNotice()
    if (response === 0) windowManager.openOnboarding()
  }

  private async voiceEnvReady(): Promise<boolean> {
    const py = venvPython()
    if (!fs.existsSync(py)) return false
    const r = await quick(py, ['-c', 'import edge_tts, faster_whisper'], 20000)
    return r.ok
  }

  private async hasFfmpeg(): Promise<boolean> {
    if (localFfmpegPath()) return true
    if (findOnPath('ffmpeg')) return true
    if (!isWindows) return false
    const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')
    try {
      return fs.readdirSync(winget).some((d) => d.startsWith('Gyan.FFmpeg'))
    } catch {
      return false
    }
  }

  public async getStatus(): Promise<SetupStatus> {
    const [systemPython, envReady, ffmpeg, tags] = await Promise.all([
      this.findSystemPython(),
      this.voiceEnvReady(),
      this.hasFfmpeg(),
      ollamaService.queryTags()
    ])
    const installed = !!ollamaService.findOllamaBinary() || tags.running
    return {
      python: { systemPython, envReady },
      ffmpeg,
      ollama: { installed, running: tags.running, models: tags.models },
      model: tags.models.some((m) => m.startsWith(DEFAULT_MODEL)),
      persona: tags.models.some((m) => m.toLowerCase().startsWith('capri')),
      recommendedModel: DEFAULT_MODEL
    }
  }

  // Installation steps

  private async hasWinget(): Promise<boolean> {
    return (await quick('winget', ['--version'])).ok
  }

  private async winget(id: string, step: SetupStep, log: Logger): Promise<boolean> {
    if (!(await this.hasWinget())) {
      log(step, 'winget is not available on this PC, using the direct download instead.')
      return false
    }
    log(step, `winget install ${id}`)
    const code = await run(
      'winget',
      ['install', '-e', '--id', id, '--silent', '--accept-package-agreements', '--accept-source-agreements', ...(id === 'Ollama.Ollama' && storageDir('Ollama') ? ['--location', storageDir('Ollama') as string] : []),
        ...(id.startsWith('Python.') && storageDir('Python') ? ['--location', storageDir('Python') as string] : [])],
      (l) => log(step, l)
    )
    // winget returns non-zero when the package is already installed; detection decides afterwards
    return code === 0
  }

  /** Downloads a file with progress lines every 10% */
  private async download(url: string, dest: string, step: SetupStep, log: Logger): Promise<boolean> {
    log(step, `Downloading ${url}`)
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) {
        log(step, `Download failed: HTTP ${res.status}`)
        return false
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const total = Number(res.headers.get('content-length')) || 0
      const out = fs.createWriteStream(dest)
      const reader = res.body.getReader()
      let received = 0
      let lastPct = -10
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()))
        if (total) {
          const pct = Math.floor((received / total) * 100)
          if (pct >= lastPct + 10) {
            lastPct = pct
            log(step, `${pct}% (${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB)`)
          }
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      return true
    } catch (err: any) {
      log(step, `Download failed: ${err?.message || err}`)
      return false
    }
  }

  private async installPythonDirect(log: Logger): Promise<void> {
    const exe = path.join(storageDir('downloads') || os.tmpdir(), 'capri-python-3.11.9-amd64.exe')
    if (!(await this.download(PYTHON_INSTALLER_URL, exe, 'python', log))) return
    log('python', 'Installing Python 3.11 (per user, no admin needed)...')
    await run(exe, ['/quiet', ...(storageDir('Python') ? [`TargetDir=${storageDir('Python')}`] : []), 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1', 'Include_test=0'], (l) => log('python', l))
    fs.rmSync(exe, { force: true })
  }

  private async installOllamaDirect(log: Logger, dir = storageDir('Ollama')): Promise<void> {
    // The installer weighs over a GB: the system disk may be full, which is why she's elsewhere
    const exe = path.join(storageDir('downloads') || os.tmpdir(), 'OllamaSetup.exe')
    if (!(await this.download(OLLAMA_INSTALLER_URL, exe, 'ollama', log))) return
    log('ollama', 'Installing Ollama...')
    await run(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', ...(dir ? [`/DIR=${dir}`] : [])], (l) => log('ollama', l))
    fs.rmSync(exe, { force: true })
  }

  /** Portable FFmpeg extracted into the app's own tools folder (no PATH changes) */
  private async installFfmpegDirect(log: Logger): Promise<void> {
    const zip = path.join(os.tmpdir(), 'capri-ffmpeg.zip')
    if (!(await this.download(FFMPEG_ZIP_URL, zip, 'ffmpeg', log))) return
    const dest = path.join(toolsDir(), 'ffmpeg')
    log('ffmpeg', `Extracting to ${dest}`)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    const ps = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], (l) => log('ffmpeg', l))
    fs.rmSync(zip, { force: true })
  }

  /** Installs system packages. The desktop asks for the password; cancelling just fails the step */
  private async installLinuxPackages(what: 'python' | 'ffmpeg', step: SetupStep, log: Logger): Promise<boolean> {
    const pm = linuxPackageManager()
    if (!pm || !findOnPath('pkexec')) {
      const hint = pm ? `: sudo ${linuxInstallCommand(pm, what).slice(1).join(' ')}` : ' with your package manager'
      log(step, `Can't install ${what} from here. Install it${hint}, then run this step again.`)
      return false
    }
    const [cmd, ...args] = linuxInstallCommand(pm, what)
    log(step, `${cmd} ${args.join(' ')} (your system will ask for your password)`)
    return (await run(cmd, args, (l) => log(step, l))) === 0
  }

  /** Static FFmpeg build in the app's own tools folder: no password, nothing on the system changes */
  private async installFfmpegLinux(log: Logger): Promise<void> {
    const archive = path.join(os.tmpdir(), 'capri-ffmpeg.tar.xz')
    if (await this.download(LINUX_FFMPEG_URL, archive, 'ffmpeg', log)) {
      const dest = path.join(toolsDir(), 'ffmpeg')
      log('ffmpeg', `Extracting to ${dest}`)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(dest, { recursive: true })
      // Only the program: the archive also carries 300 MB of docs and tools Capri doesn't use
      await run('tar', ['-xJf', archive, '-C', dest, '--no-same-owner', '--wildcards', '*/bin/ffmpeg'], (l) => log('ffmpeg', l))
      fs.rmSync(archive, { force: true })
    }
    if (!(await this.hasFfmpeg())) await this.installLinuxPackages('ffmpeg', 'ffmpeg', log)
  }

  /** The official archive, unpacked in the tools folder. Without zstd, the official script (asks for the password) */
  private async installOllamaLinux(log: Logger): Promise<void> {
    if (findOnPath('zstd')) {
      const archive = path.join(os.tmpdir(), 'capri-ollama.tar.zst')
      if (await this.download(LINUX_OLLAMA_URL, archive, 'ollama', log)) {
        const dest = path.join(toolsDir(), 'ollama')
        log('ollama', `Extracting to ${dest}`)
        fs.mkdirSync(dest, { recursive: true })
        await run('tar', ['--zstd', '-xf', archive, '-C', dest, '--no-same-owner'], (l) => log('ollama', l))
        fs.rmSync(archive, { force: true })
      }
    }
    if (ollamaService.findOllamaBinary()) return
    if (!findOnPath('pkexec')) {
      log('ollama', `Install Ollama with: ${LINUX_OLLAMA_SCRIPT}`)
      return
    }
    log('ollama', 'Running the official Ollama installer (your system will ask for your password)')
    await run('pkexec', ['sh', '-c', LINUX_OLLAMA_SCRIPT], (l) => log('ollama', l))
  }

  public async run(step: SetupStep, log: Logger): Promise<boolean> {
    if (this.busy) {
      log(step, 'Another setup step is still running...')
      return false
    }
    this.busy = true
    try {
      switch (step) {
        case 'whisper': {
          if (!isMac) return false
          if (!(await this.voiceEnvReady())) {log(step, 'Install the Python voice environment first.'); return false}
          log(step, 'Downloading the selected speech model (base about 150 MB; small about 500 MB). Future recognition runs offline on CPU.')
          const ok = (await run(venvPython(), [scriptPath('capri_voice.py'), 'prepare-whisper'], l => log(step, l), {env: {...process.env, CAPRI_VOICE_DIR: voiceDataDir(), CAPRI_WHISPER_DIR: speechModelsDir()}})) === 0
          if(ok) voiceService.restartWorker()
          return ok
        }
        case 'python': {
          const ok = await this.installVoiceEnv(log)
          // It may have started before Whisper was here, and it wouldn't notice on its own
          if (ok) voiceService.restartWorker()
          return ok
        }
        case 'ffmpeg':
          if (isMac) {
            if (!(await this.hasFfmpeg())) log(step, 'Install FFmpeg yourself: brew install ffmpeg. Then refresh setup.')
            return this.hasFfmpeg()
          }
          if (!isWindows) {
            if (!(await this.hasFfmpeg())) await this.installFfmpegLinux(log)
            return this.hasFfmpeg()
          }
          // winget always puts it on the system disk; the direct download goes to the chosen folder
          if (!storageDir('tools')) await this.winget('Gyan.FFmpeg', 'ffmpeg', log)
          if (!(await this.hasFfmpeg())) await this.installFfmpegDirect(log)
          return this.hasFfmpeg()
        case 'ollama': {
          if (isMac) {
            if (!ollamaService.findOllamaBinary()) { log(step, 'Install Ollama from https://ollama.com/download/mac, then run this step again.'); return false }
            return (await ollamaService.ensureRunning()).running
          }
          if (!isWindows) {
            if (!ollamaService.findOllamaBinary()) await this.installOllamaLinux(log)
          } else {
            if (!ollamaService.findOllamaBinary()) await this.winget('Ollama.Ollama', 'ollama', log)
            if (!ollamaService.findOllamaBinary()) await this.installOllamaDirect(log)
          }
          await this.pointOllamaAtStorage()
          const st = await ollamaService.ensureRunning()
          return st.running
        }
        case 'model':
          await this.pointOllamaAtStorage()
          return await this.pullModel(DEFAULT_MODEL, log)
        case 'persona':
          return await this.createPersona(log)
      }
    } catch (err: any) {
      log(step, `error: ${err?.message || err}`)
      return false
    } finally {
      this.busy = false
    }
  }

  private async installVoiceEnv(log: Logger, mayAskForPassword = true): Promise<boolean> {
    let sys = await this.findSystemPython()
    if (!sys && isMac) { log('python', 'Install Python yourself: brew install python@3.11. Then run this step again.'); return false }
    if (!sys) {
      log('python', 'Python 3.11 not found, installing it...')
      if (isWindows) {
        await this.winget('Python.Python.3.11', 'python', log)
        sys = await this.findSystemPython()
        if (!sys) {
          await this.installPythonDirect(log)
          sys = await this.findSystemPython()
        }
      } else {
        await this.installLinuxPackages('python', 'python', log)
        sys = await this.findSystemPython()
      }
      if (!sys) {
        log('python', 'Python was installed but is not visible yet. Restart Capri and run this step again.')
        return false
      }
    }

    const envDir = pythonEnvDir()
    const envPython = venvPython()
    // Debian and Ubuntu leave a half-built environment with no pip when python3-venv is missing
    const envUsable = async () => fs.existsSync(envPython) && (isWindows || (await quick(envPython, ['-m', 'pip', '--version'], 20000)).ok)
    const createEnv = async () => {
      log('python', `Creating the voice environment in ${envDir}`)
      if (!isWindows) fs.rmSync(envDir, { recursive: true, force: true })
      const [cmd, ...pre] = (sys as string).split(' ')
      const code = await run(cmd, [...pre, '-m', 'venv', envDir], (l) => log('python', l))
      return code === 0 && (await envUsable())
    }
    if (!(await envUsable())) {
      let created = await createEnv()
      if (!created && !isWindows && !isMac && mayAskForPassword) {
        log('python', 'This Python has no venv module, installing it...')
        if (await this.installLinuxPackages('python', 'python', log)) created = await createEnv()
      }
      if (!created) return false
    }

    log('python', 'Installing voice packages (edge-tts, faster-whisper). This can take a few minutes...')
    // pip's downloads weigh hundreds of MB: they stay on the chosen disk too
    const pipCache = storageDir('pip-cache')
    const pipOptions = pipCache ? { env: { ...process.env, PIP_CACHE_DIR: pipCache } } : {}
    await run(envPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], (l) => log('python', l), pipOptions)
    // On its own first: pip installs a list all or nothing, and speaking shouldn't depend on hearing
    await run(envPython, ['-m', 'pip', 'install', 'edge-tts>=6.1'], (l) => log('python', l), pipOptions)
    const code = await run(envPython, ['-m', 'pip', 'install', '-r', scriptPath('requirements.txt')], (l) => log('python', l), pipOptions)
    return code === 0 && (await this.voiceEnvReady())
  }

  private async ollamaCli(): Promise<string | null> {
    const bin = ollamaService.findOllamaBinary()
    if (bin) return bin
    return findOnPath('ollama') ? 'ollama' : null
  }

  private async pullModel(model: string, log: Logger): Promise<boolean> {
    const cli = await this.ollamaCli()
    if (!cli) {
      log('model', 'Ollama is not installed yet.')
      return false
    }
    await ollamaService.ensureRunning()
    log('model', `ollama pull ${model} (${model === 'qwen3:1.7b' ? 'about 1.4 GB' : 'about 4.7 GB'})`)
    const code = await run(cli, ['pull', model], (l) => log('model', l))
    return code === 0
  }

  /** Builds the "capri" model from scripts/Modelfile.capri with the user's name baked in */
  private async createPersona(log: Logger): Promise<boolean> {
    const cli = await this.ollamaCli()
    if (!cli) {
      log('persona', 'Ollama is not installed yet.')
      return false
    }
    const template = fs.readFileSync(scriptPath('Modelfile.capri'), 'utf-8')
    const modelfile = path.join(os.tmpdir(), 'capri.Modelfile')
    const content = isMac ? template.replace(/^FROM\s+.+$/m, `FROM ${DEFAULT_MODEL}`) : template
    fs.writeFileSync(modelfile, content.replace(/\{name\}/g, getUserName()), 'utf-8')
    log('persona', `ollama create capri (persona for ${getUserName()})`)
    const code = await run(cli, ['create', 'capri', '-f', modelfile], (l) => log('persona', l))
    return code === 0
  }
}

export const setupService = SetupService.getInstance()
