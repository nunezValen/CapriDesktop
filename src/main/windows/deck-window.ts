import { assetPath } from '../services/app-paths'
import { isMac } from '../services/platform'
import { BrowserWindow, app, screen } from 'electron'
import { join } from 'path'
import { windowManager } from './window-manager'

export function createDeckWindow(): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/index.mjs')
  const iconPath = assetPath('icon.png')

  const deckWindow = new BrowserWindow({
    title: 'Capricorn // Dev Deck',
    icon: iconPath,
    width: isMac ? Math.min(1280, screen.getPrimaryDisplay().workArea.width - 40) : 1040,
    height: isMac ? Math.min(820, screen.getPrimaryDisplay().workArea.height - 80) : 720,
    minWidth: 840,
    minHeight: 580,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {trafficLightPosition:{x:14,y:13}} : {}),
    backgroundColor: '#07080e',
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (isMac) deckWindow.on('minimize',()=>windowManager.hideDeck())

  // Hash route for dev deck view
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    deckWindow.loadURL(`${devUrl}#/deck`)
  } else {
    deckWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'deck'
    })
  }

  // Intercept close: hide deck and restore desktop companion
  deckWindow.on('close', (event) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault()
      windowManager.hideDeck()
    }
  })

  return deckWindow
}
