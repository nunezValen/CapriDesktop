import { app, Menu, nativeImage, Tray } from 'electron'
import { assetPath } from '../services/app-paths'
import { consciousnessService } from '../services/consciousness-service'
import { localizeLine } from '../../shared/lines'
import type { WindowManager } from './window-manager'

let tray: Tray | null = null
let unsubscribeLanguage: (() => void) | null = null

function showCompanion(windowManager: WindowManager): void {
  if (windowManager.isDeckVisible()) {
    windowManager.hideDeck()
    return
  }
  const companion = windowManager.getCompanionWindow()
  if (!companion || companion.isDestroyed()) return
  companion.showInactive()
  companion.setAlwaysOnTop(true, 'screen-saver', 1)
  companion.moveTop()
}

function updateMenu(windowManager: WindowManager): void {
  if (!tray || tray.isDestroyed()) return
  const lang = consciousnessService.getUiLanguage()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: localizeLine('Show Capri', lang), click: () => showCompanion(windowManager) },
    { label: localizeLine('Dev Deck', lang), click: () => windowManager.toggleDeck() },
    { label: localizeLine('Quit', lang), click: () => windowManager.quitApp() }
  ]))
}

export function createTray(windowManager: WindowManager): void {
  if (tray && !tray.isDestroyed()) return
  const icon = nativeImage.createFromPath(assetPath('icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Capri Desktop')
  tray.on('click', () => windowManager.toggleDeck())
  updateMenu(windowManager)
  unsubscribeLanguage = consciousnessService.onLanguageChanged(() => updateMenu(windowManager))
  app.once('before-quit', destroyTray)
}

export function destroyTray(): void {
  unsubscribeLanguage?.()
  unsubscribeLanguage = null
  app.removeListener('before-quit', destroyTray)
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
