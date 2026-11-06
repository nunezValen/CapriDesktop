import { app } from 'electron'
import fs from 'fs'
import path from 'path'
const file=()=>path.join(app.getPath('userData'),'local-ai-disabled')
export function localAIEnabled(): boolean { return !fs.existsSync(file()) }
export function setLocalAIEnabled(enabled: boolean): boolean {
  if (typeof enabled !== 'boolean') throw new Error('Invalid local AI setting')
  if (enabled) fs.rmSync(file(),{force:true})
  else {fs.mkdirSync(path.dirname(file()),{recursive:true});fs.writeFileSync(file(),'disabled\n')}
  return enabled
}
