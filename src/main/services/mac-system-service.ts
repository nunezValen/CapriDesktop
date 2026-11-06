import { app, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import fs from 'fs/promises'
import { appleScript } from './mac-desktop'
import { isMac } from './platform'
import { MAC_SETTINGS, type MacSystemAction } from '../../shared/mac-system-commands'
const run=promisify(execFile)
const gib=(n:number)=>(n/1024**3).toFixed(1)+' GB'
export async function runMacSystemCommand(command:MacSystemAction):Promise<{success:boolean;output:string}> {
  if(!isMac) return {success:false,output:'This command is available on macOS only.'}
  try {
    switch(command.action) {
      case 'battery': {
        const {stdout}=await run('/usr/bin/pmset',['-g','batt'],{timeout:4000})
        const charge=stdout.match(/(\d+)%;\s*([^;\n]+)(?:;\s*([^\n]+))?/)
        return {success:true,output:charge ? `Battery: ${charge[1]}%, ${charge[2].trim()}${charge[3] ? `; ${charge[3].replace(/present:.*/, '').trim()}` : ''}.` : 'macOS did not report a battery. This may be a desktop Mac.'}
      }
      case 'storage': {
        const disk=await fs.statfs(app.getPath('home'))
        return {success:true,output:`Your home disk has ${gib(Number(disk.bavail)*Number(disk.bsize))} available of ${gib(Number(disk.blocks)*Number(disk.bsize))}.`}
      }
      case 'system-info': {
        const {stdout}=await run('/usr/bin/sw_vers',['-productVersion'],{timeout:4000})
        return {success:true,output:`macOS ${stdout.trim()}, ${process.arch}, ${gib(os.totalmem())} RAM. This is the OS version; Capri is ${app.getVersion()}.`}
      }
      case 'folder': {
        if(!['downloads','documents','desktop','home'].includes(command.name)) throw new Error('Unknown folder')
        const folder=app.getPath(command.name as 'downloads'|'documents'|'desktop'|'home')
        const error=await shell.openPath(folder)
        return {success:!error,output:error || `Opened your ${command.name} folder in Finder.`}
      }
      case 'settings': {
        const pane=Object.hasOwn(MAC_SETTINGS,command.name) ? MAC_SETTINGS[command.name] : null
        if(!pane) throw new Error('Unknown settings page')
        await shell.openExternal(`x-apple.systempreferences:${pane}`)
        return {success:true,output:`Opened ${command.name} settings.`}
      }
      case 'mute': case 'unmute': {
        const muted=command.action==='mute'
        const result=await appleScript(`set volume ${muted ? 'with' : 'without'} output muted\nreturn output muted of (get volume settings)`)
        if(result.trim()!==String(muted)) throw new Error('macOS could not confirm the mute change')
        return {success:true,output:muted ? 'System sound muted.' : 'System sound unmuted.'}
      }
      case 'get-volume': case 'set-volume': case 'change-volume': {
        let value:number|undefined
        if(command.action==='set-volume') {
          if(!Number.isFinite(command.value) || command.value<0 || command.value>100) throw new Error('Choose a volume from 0 to 100 percent')
          value=Math.round(command.value)
        } else if(command.action==='change-volume') {
          if(!Number.isFinite(command.value) || Math.abs(command.value)>100) throw new Error('Invalid volume change')
          const current=Number((await appleScript('return output volume of (get volume settings)')).trim())
          if(!Number.isFinite(current)) throw new Error('The current audio device does not report its volume')
          value=Math.max(0,Math.min(100,current+command.value))
        }
        const result=await appleScript(`${value===undefined ? '' : `set volume output volume ${value}\n`}set volSettings to get volume settings\nreturn ((output volume of volSettings) as text) & "|" & ((output muted of volSettings) as text)`)
        const [volume,muted]=result.trim().split('|')
        if(!/^\d+$/.test(volume) || (value!==undefined && Number(volume)!==value)) throw new Error('This audio device may not support system volume control; use its hardware controls')
        return {success:true,output:`System volume is ${volume}%${muted==='true' ? ' (muted)' : ''}.`}
      }
      default:return {success:false,output:'That system action is not supported.'}
    }
  } catch(error) {return {success:false,output:`I couldn't complete that Mac command: ${error instanceof Error ? error.message : String(error)}`}}
}
