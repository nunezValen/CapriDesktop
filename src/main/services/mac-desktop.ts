import { app } from 'electron'
import { execFile } from 'child_process'
import path from 'path'
import type { ForegroundWindow, WindowedApp } from './platform'

export function macHelper<T>(command: string, args: string[] = []): Promise<T> {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const binary = path.join(root, 'scripts/macos/bin/capri-desktop')
  return new Promise((resolve, reject) =>
    execFile(binary, [command, ...args], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(new Error(`Mac desktop helper unavailable: ${err.message}`))
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error('Invalid Mac desktop helper response'))
      }
    }),
  )
}
export type MacWindow = WindowedApp & { pid: number; process: string; path: string; frontmost: boolean }
let foregroundRequest: Promise<ForegroundWindow> | null = null
let foregroundAt = 0
export function macForegroundWindow(): Promise<ForegroundWindow> {
  if (!foregroundRequest || Date.now()-foregroundAt > 1000) {
    foregroundAt=Date.now()
    foregroundRequest=macHelper<ForegroundWindow>('foreground').then(value=>({bounds:value.bounds,title:value.title || '',process:value.process || '',path:value.path || '',pid:Number(value.pid) || 0})).catch(error=>{foregroundRequest=null;throw error})
  }
  return foregroundRequest
}
export const macWindows = (): Promise<MacWindow[]> => macHelper('windows')
export async function macWindowGeometry(id: string): Promise<MacWindow | null> {
  return (await macWindows().catch(() => [])).find((w) => w.hwnd === id) || null
}
export async function findMacWindowedApp(): Promise<MacWindow | null> {
  return (await macWindows().catch(() => [])).find((w) => w.width >= 320 && w.height >= 220 && w.title) || null
}
export function appleScript(source: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      '/usr/bin/osascript',
      ['-e', source, ...args],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, out, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()))
        else resolve(out.trim())
      },
    ),
  )
}
const aliases: Record<string, string> = {
  chrome: 'Google Chrome',
  firefox: 'Firefox',
  safari: 'Safari',
  edge: 'Microsoft Edge',
  msedge: 'Microsoft Edge',
  brave: 'Brave Browser',
  explorer: 'Finder',
  'file explorer': 'Finder',
  'windows explorer': 'Finder',
  'task manager': 'Activity Monitor',
  taskmgr: 'Activity Monitor',
  'activity monitor': 'Activity Monitor',
  terminal: 'Terminal',
  settings: 'System Settings',
  'control panel': 'System Settings',
  'system settings': 'System Settings',
  calculatorapp: 'Calculator',
  'apple music': 'Music',
  obs: 'OBS',
  obs64: 'OBS',
  notepad: 'TextEdit',
  calc: 'Calculator',
  calculator: 'Calculator',
  browser: 'Safari',
  spotify: 'Spotify',
  discord: 'Discord',
  steam: 'Steam',
  code: 'Visual Studio Code',
}
export function macAppName(name: string): string {
  const clean = name.trim().replace(/\.exe$/i, '')
  return aliases[clean.toLowerCase()] || clean
}
export async function launchMacApp(name: string, url?: string): Promise<boolean> {
  if (!name.trim() || name.startsWith('-') || (url && !/^https?:\/\//i.test(url))) return false
  return new Promise((resolve) =>
    execFile('/usr/bin/open', ['-a', macAppName(name), ...(url ? [url] : [])], { timeout: 5000 }, (err) => resolve(!err)),
  )
}
export async function quitMacApp(name: string): Promise<boolean> {
  return (await macHelper<{ requested: number }>('quit', [macAppName(name)])).requested > 0
}
