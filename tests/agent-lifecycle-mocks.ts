import { EventEmitter } from 'node:events'
export const lifecycle={fail:false,defer:false,resolve:null as (()=>void)|null}
export class CapriLocalAgent extends EventEmitter {
  async runPrompt() {
    if(lifecycle.fail) throw new Error('Test prompt failed')
    if(lifecycle.defer) {lifecycle.defer=false;await new Promise<void>(resolve=>{lifecycle.resolve=resolve})}
  }
}
export const scriptPlayer={isPlaying:()=>false}
export const getLlmSettings=()=>({model:'test'})
export const isCloudMode=()=>false
export const personalize=(text:string)=>text
export const localizeLine=(text:string)=>text
export const consciousnessService={getPreferredLanguage:()=> 'en'}
export const windowManager={broadcast:()=>{},isGamingModeActive:()=>false}
export const ollamaService={}
export const roamingManager={}
export const activeWindowService={}
export const hasPendingResult=()=>false
export const openPendingResult=()=>{}

let localModel = 'test'
export const getLocalModel = () => localModel
export const setLocalModel = (model: string) => { localModel = model }
