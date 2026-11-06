import { EventEmitter } from 'events'
export const app = { getPath: () => process.env.CAPRI_TEST_DATA!, getAppPath: () => process.cwd(), isPackaged: false, getVersion:()=> '1.0.4-mac.13' }
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`test-only:${s}`),
  decryptString: (b: Buffer) => b.toString().replace(/^test-only:/, ''),
}
export const opened: string[] = []
export const shell = {
  openPath: async (file:string)=>{opened.push(file);return ''},
  openExternal: async (url: string) => {
    opened.push(url)
  },
}
export const powerMonitor=new EventEmitter()
let mediaStatus='denied'
export function setTestMediaStatus(status:string){mediaStatus=status}
export const systemPreferences = { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => mediaStatus, askForMediaAccess: async () => false }
export class BrowserWindow extends EventEmitter {
  static getAllWindows() {
    return []
  }
}
