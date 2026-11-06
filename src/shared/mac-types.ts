export type MacPermission = 'microphone' | 'screen' | 'accessibility' | 'automation'
export interface PlatformStatus {
  platform: string
  permissions: Record<MacPermission, string>
  capabilities: {
    desktopAwareness: boolean
    screenCapture: boolean
    paint: boolean
    clipping: boolean
    gameIntegrations: boolean
    commandMacros: boolean
  }
}

export interface DesktopPreferences {openAtLogin:boolean;loginSupported:boolean;positionPinned:boolean;screenCommentMinutes:number;gameCommentMinutes:number;speechModel:'base'|'small';speechReady:boolean}
