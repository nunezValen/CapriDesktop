/**
 * First-run setup: Python voice environment, FFmpeg, Ollama and the local models.
 * Downloads go through winget / pip and stream their output to the onboarding window.
 * When winget is missing or fails (fresh or stripped-down Windows), the official installers
 * are downloaded directly and run silently, so a PC with nothing installed still works.
 * On Linux, FFmpeg and Ollama are unpacked into the app's own folder with no password; only what
 * has to be a system package (Python) goes through the package manager and its password prompt.
 */

import { app, dialog } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, execFile } from 'child_process'
import { localFfmpegPath, pythonEnvDir, scriptPath, toolsDir, venvPython } from './app-paths'
import { findOnPath, isWindows, linuxInstallCommand, linuxPackageManager } from './platform'
import { ollamaService } from './ollama-service'
import { consciousnessService } from './consciousness-service'
import { isRemoteMode } from './llm-gateway'
import { windowManager } from '../windows/window-manager'
import { localizeLine } from '../../shared/lines'
import { getUserName } from './user-profile'

export type SetupStep = 'python' | 'ffmpeg' | 'ollama' | 'model' | 'persona'

export interface SetupStatus {
  python: { systemPython: string | null; envReady: boolean }
  ffmpeg: boolean
  ollama: { installed: boolean; running: boolean; models: string[] }
  model: boolean
  persona: boolean
}

export const DEFAULT_MODEL = 'qwen2.5-coder:7b'

// Linux distros move to new versions quickly: the voice packages were checked on 3.14 there
const SUPPORTED_PYTHON = isWindows ? /Python 3\.(1[0-3])/ : /Python 3\.(1[0-4])/

/** Direct-download fallbacks used when winget is not available */
const PYTHON_INSTALLER_URL = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe'
const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe'
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

const LINUX_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64'
const LINUX_OLLAMA_URL = `https://ollama.com/download/ollama-linux-${LINUX_ARCH}.tar.zst`
const LINUX_OLLAMA_SCRIPT = 'curl -fsSL https://ollama.com/install.sh | sh'
const LINUX_FFMPEG_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux${process.arch === 'arm64' ? 'arm64' : '64'}-gpl.tar.xz`

type Logger = (step: SetupStep, line: string) => void

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
    if (!isRemoteMode()) {
      if (!s.ollama.installed) missing.push('ollama')
      else if (s.ollama.running && s.ollama.models.length === 0) missing.push('model')
    }
    return missing
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
      persona: tags.models.some((m) => m.toLowerCase().startsWith('capri'))
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
      ['install', '-e', '--id', id, '--silent', '--accept-package-agreements', '--accept-source-agreements'],
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
    const exe = path.join(os.tmpdir(), 'capri-python-3.11.9-amd64.exe')
    if (!(await this.download(PYTHON_INSTALLER_URL, exe, 'python', log))) return
    log('python', 'Installing Python 3.11 (per user, no admin needed)...')
    await run(exe, ['/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1', 'Include_test=0'], (l) => log('python', l))
    fs.rmSync(exe, { force: true })
  }

  private async installOllamaDirect(log: Logger): Promise<void> {
    const exe = path.join(os.tmpdir(), 'OllamaSetup.exe')
    if (!(await this.download(OLLAMA_INSTALLER_URL, exe, 'ollama', log))) return
    log('ollama', 'Installing Ollama...')
    await run(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], (l) => log('ollama', l))
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
        case 'python':
          return await this.installVoiceEnv(log)
        case 'ffmpeg':
          if (!isWindows) {
            if (!(await this.hasFfmpeg())) await this.installFfmpegLinux(log)
            return this.hasFfmpeg()
          }
          await this.winget('Gyan.FFmpeg', 'ffmpeg', log)
          if (!(await this.hasFfmpeg())) await this.installFfmpegDirect(log)
          return this.hasFfmpeg()
        case 'ollama': {
          if (!isWindows) {
            if (!ollamaService.findOllamaBinary()) await this.installOllamaLinux(log)
          } else {
            if (!ollamaService.findOllamaBinary()) await this.winget('Ollama.Ollama', 'ollama', log)
            if (!ollamaService.findOllamaBinary()) await this.installOllamaDirect(log)
          }
          const st = await ollamaService.ensureRunning()
          return st.running
        }
        case 'model':
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
      if (!created && !isWindows && mayAskForPassword) {
        log('python', 'This Python has no venv module, installing it...')
        if (await this.installLinuxPackages('python', 'python', log)) created = await createEnv()
      }
      if (!created) return false
    }

    log('python', 'Installing voice packages (edge-tts, faster-whisper). This can take a few minutes...')
    await run(envPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], (l) => log('python', l))
    // On its own first: pip installs a list all or nothing, and speaking shouldn't depend on hearing
    await run(envPython, ['-m', 'pip', 'install', 'edge-tts>=6.1'], (l) => log('python', l))
    const code = await run(envPython, ['-m', 'pip', 'install', '-r', scriptPath('requirements.txt')], (l) => log('python', l))
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
    log('model', `ollama pull ${model} (about 4.7 GB)`)
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
    fs.writeFileSync(modelfile, template.replace(/\{name\}/g, getUserName()), 'utf-8')
    log('persona', `ollama create capri (persona for ${getUserName()})`)
    const code = await run(cli, ['create', 'capri', '-f', modelfile], (l) => log('persona', l))
    return code === 0
  }
}

export const setupService = SetupService.getInstance()
