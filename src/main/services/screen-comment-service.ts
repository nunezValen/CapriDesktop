import { macGameContext } from './mac-game-context'
import { consciousnessService } from './consciousness-service'
import { FRIEND_SCREEN_COMMENT, friendScreenComment } from '../../shared/screen-comment-style'
import { powerMonitor, systemPreferences } from 'electron'
import { featureSettings, saveFeatures } from './mac-feature-settings'
import { isCloudMode, describeCloudImage } from './llm-gateway'
import { scannerService } from './scanner-service'
import { agentManager } from '../agents/agent-manager'
import { isMac } from './platform'
let timer:NodeJS.Timeout|null=null
let generation=0
let busy=false
let locked=false
let lastAttemptAt=0
let lastComment=''
export function startScreenComments() {
  if(!isMac) return
  powerMonitor.on('lock-screen',()=>{locked=true;generation++})
  powerMonitor.on('unlock-screen',()=>{locked=false})
  powerMonitor.on('suspend',()=>{locked=true;generation++})
  powerMonitor.on('resume',()=>{locked=false})
  scheduleScreenComments()
}
export function scheduleScreenComments() {
  generation++
  if(timer) clearInterval(timer)
  timer=null
  const prefs=featureSettings()
  if(!isMac || (!prefs.screenCommentMinutes && !prefs.gameCommentMinutes)) return
  lastAttemptAt=Date.now()
  timer=setInterval(()=>{void tickScreenComment()},15000)
}
async function tickScreenComment() {
  const blocked=()=>locked || ['thinking','talking','curious','asustada'].includes(agentManager.getCompanionState()) || scannerService.getStatus().isScanning
  const prefs=featureSettings()
  const game=macGameContext.current()
  const minutes=game?.foreground && prefs.gameCommentMinutes ? prefs.gameCommentMinutes : prefs.screenCommentMinutes
  if(busy || blocked() || !minutes) return
  if(Date.now()-lastAttemptAt<minutes*60000) return
  if(!isCloudMode() || systemPreferences.getMediaAccessStatus('screen')!=='granted') return
  busy=true
  const current=generation
  try {
    const bounds=game?.foreground ? game.bounds : undefined
    const point=bounds && Object.values(bounds).every(Number.isFinite) && bounds.width>0 && bounds.height>0 ? {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2} : undefined
    const capture=await scannerService.captureRegionBase64(true,point)
    if(!capture || generation!==current || blocked()) return
    const context=macGameContext.prompt()
    const gameStyle=game?.foreground ? 'You are watching your friend play together. Ordinary gameplay is worth a remark: react to a visible movement, weapon, character or arena, or ask one playful question. You do not need to wait for a spectacular event. Do not make up a kill, victory, score or unseen event; stay quiet on private/settings screens and when the game is not visible.' : ''
    const text=friendScreenComment(await describeCloudImage(capture.base64,`${FRIEND_SCREEN_COMMENT} ${context} ${gameStyle} Speak in ${consciousnessService.getPreferredLanguage()}. ${lastComment ? `Do not repeat your previous remark: ${JSON.stringify(lastComment)}` : ''}`))
    if(text && text.toLowerCase()!==lastComment.toLowerCase() && generation===current && !blocked()) {
      lastComment=text
      consciousnessService.setLastScannedContext({summary:game?.name || 'Screen',tags:game ? ['GAME',game.name] : ['SCREEN'],response:text,visualDescription:text,timestamp:Date.now()})
      agentManager.setCompanionSpeech(text,Math.max(4500,Math.min(12000,text.length*65)),true)
    }
  } catch {
    if(generation===current) {
      saveFeatures({screenCommentMinutes:0,gameCommentMinutes:0});scheduleScreenComments()
      agentManager.setCompanionSpeech('Automatic screen comments paused after an error. Check vision settings before enabling them again.',5000,false)
    }
  } finally {busy=false;lastAttemptAt=Date.now()}
}
