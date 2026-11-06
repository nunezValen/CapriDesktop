import { featureSettings } from './mac-feature-settings'
import { app } from 'electron'
import { isMac } from './platform'
import { roamingManager } from '../roaming/roaming-manager'
import type { DesktopPreferences } from '../../shared/mac-types'
export function desktopPreferences(): DesktopPreferences {
  return {...featureSettings(),openAtLogin: isMac && app.isPackaged ? app.getLoginItemSettings().openAtLogin : false, loginSupported:isMac && app.isPackaged, positionPinned:roamingManager.isPositionPinned()}
}
export function setOpenAtLogin(enabled: boolean): DesktopPreferences {
  if (!isMac || !app.isPackaged || typeof enabled!=='boolean') throw new Error('Open at Login is available in the installed Mac app.')
  app.setLoginItemSettings({openAtLogin:enabled})
  return desktopPreferences()
}
