import { isMac } from '../services/platform'
import { BrowserWindow, app } from 'electron'
import { join } from 'path'
import { assetPath } from '../services/app-paths'

/** First-run window: name, language and dependency setup */
export function createOnboardingWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Capri // Setup',
    icon: assetPath('icon.png'),
    width: 620,
    height: 780,
    resizable: false,
    maximizable: false,
    show: false,
    frame: isMac,
    ...(isMac ? {titleBarStyle: 'hiddenInset' as const, trafficLightPosition:{x:14,y:13}} : {}),
    backgroundColor: '#0b0708',
    center: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    win.loadURL(`${devUrl}#/onboarding`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'onboarding' })
  }
  win.once('ready-to-show', () => win.show())
  return win
}
