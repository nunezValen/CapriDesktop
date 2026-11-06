import { pythonPath } from './app-paths'
import { isMac, isLinux, pressKey } from './platform'
import { spawn } from './hidden-process'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface ClipResult {
  success: boolean
  method: 'python' | 'powershell' | 'xdotool' | 'none'
  message?: string
}

export class ClipService {
  private static instance: ClipService
  private lastClipTimestamp = 0
  private readonly cooldownMs = 2000 // Prevent accidental double-triggering

  public static getInstance(): ClipService {
    if (!ClipService.instance) {
      ClipService.instance = new ClipService()
    }
    return ClipService.instance
  }

  private getAppBasePath(): string {
    try {
      if (app && typeof app.getAppPath === 'function') {
        return app.getAppPath()
      }
    } catch {}
    return process.cwd()
  }

  private findPythonPath(): string {
    return pythonPath()
  }

  private findScriptPath(filename: string): string {
    const candidates = [
      path.join(this.getAppBasePath(), 'scripts', filename),
      path.join(this.getAppBasePath(), 'cyber-companion', 'scripts', filename),
      path.join(__dirname, '../../scripts', filename),
      path.join(__dirname, '../scripts', filename),
      path.join(process.cwd(), 'scripts', filename),
      path.join(process.cwd(), 'cyber-companion', 'scripts', filename),
      `D:\\CP\\cyber-companion\\scripts\\${filename}`
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return candidates[0]
  }

  /**
   * Simulates an F8 keypress to trigger NVIDIA ShadowPlay instant replay capture.
   */
  public async triggerClip(): Promise<ClipResult> {
    const now = Date.now()
    if (now - this.lastClipTimestamp < this.cooldownMs) {
      return {
        success: true,
        method: 'none',
        message: 'Clip already triggered recently (cooldown active)'
      }
    }
    this.lastClipTimestamp = now

    if (isMac) return { success: false, method: 'none', message: 'ShadowPlay clipping is not supported on macOS.' }
    if (isLinux) {
      return (await pressKey('F8'))
        ? { success: true, method: 'xdotool', message: 'F8 pressed via xdotool' }
        : { success: false, method: 'none', message: 'Could not press F8: xdotool is not installed or the desktop blocks it' }
    }

    // Try Python with ctypes first (fastest, ~60-100ms)
    const pyScript = this.findScriptPath('press_clip_key.py')
    if (fs.existsSync(pyScript)) {
      try {
        const pyResult = await this.executePython(pyScript)
        if (pyResult.success) {
          return { success: true, method: 'python', message: 'F8 pressed via Python ctypes' }
        }
      } catch (err) {
        console.warn('[ClipService] Python F8 execution failed, falling back to PowerShell:', err)
      }
    }

    // Fallback: PowerShell with Win32 keybd_event
    const psScript = this.findScriptPath('press_clip_key.ps1')
    if (fs.existsSync(psScript)) {
      try {
        const psResult = await this.executePowerShell(psScript)
        if (psResult.success) {
          return { success: true, method: 'powershell', message: 'F8 pressed via PowerShell Win32 API' }
        }
      } catch (err) {
        console.error('[ClipService] PowerShell F8 execution failed:', err)
      }
    }

    return {
      success: false,
      method: 'none',
      message: 'Failed to execute F8 key press on both Python and PowerShell'
    }
  }

  private executePython(scriptPath: string): Promise<{ success: boolean }> {
    return new Promise((resolve) => {
      const pythonExe = this.findPythonPath()
      const proc = spawn(pythonExe, [scriptPath, '0.08'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      proc.stdout.on('data', (d) => {
        stdout += d.toString()
      })

      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        resolve({ success: false })
      }, 3000)

      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({ success: code === 0 && stdout.includes('SUCCESS_F8_EMITTED') })
      })

      proc.on('error', () => {
        clearTimeout(timer)
        resolve({ success: false })
      })
    })
  }

  private executePowerShell(scriptPath: string): Promise<{ success: boolean }> {
    return new Promise((resolve) => {
      const psArgs = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-HoldMs',
        '80'
      ]

      const proc = spawn('powershell.exe', psArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      proc.stdout.on('data', (d) => {
        stdout += d.toString()
      })

      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        resolve({ success: false })
      }, 4000)

      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({ success: code === 0 && stdout.includes('SUCCESS_F8_EMITTED') })
      })

      proc.on('error', () => {
        clearTimeout(timer)
        resolve({ success: false })
      })
    })
  }
}

export const clipService = ClipService.getInstance()
