import { EventEmitter } from 'node:events'
export const powerMonitor=new EventEmitter()
export const state={signal:undefined as AbortSignal|undefined,permission:'granted',cloud:true,visible:true,scans:0,spoken:[] as string[],continuous:false,failure:false,changed:true,resolve:null as null|((text:string)=>void),defer:false}
const image={isEmpty:()=>false,getSize:()=>({width:800,height:600}),crop:()=>image,resize:()=>image,toJPEG:()=>Buffer.alloc(800,state.changed ? 255 : 0),toBitmap:()=>Buffer.alloc(800)}
const win={isDestroyed:()=>false,isVisible:()=>state.visible,getBounds:()=>({x:0,y:0,width:600,height:400}),setOpacity:()=>{},setAlwaysOnTop:()=>{},moveTop:()=>{}}
export const desktopCapturer={getSources:async()=>[{display_id:'1',thumbnail:image}]}
const display={id:1,bounds:{x:0,y:0,width:800,height:600},scaleFactor:1}
export const screen={getPrimaryDisplay:()=>display,getDisplayNearestPoint:()=>display,getCursorScreenPoint:()=>({x:0,y:0}),getAllDisplays:()=>[display]}
export const systemPreferences={getMediaAccessStatus:()=>state.permission}
export const windowManager={getScannerWindow:()=>win,showScanner:()=>{state.visible=true},hideScanner:()=>{state.visible=false},broadcast:()=>{}}
export const agentManager={getStatus:()=>({isRunning:false}),getCompanionState:()=> 'standing',setCompanionState:()=>{},setCompanionSpeech:(text:string)=>state.spoken.push(text)}
export const consciousnessService={getScannerContinuous:()=>state.continuous,setScannerContinuous:(value:boolean)=>{state.continuous=value},getScannerBounds:()=>win.getBounds(),getLearnedConcepts:()=>[],setLastScannedContext:()=>{},setPendingScanLearning:()=>{},getPreferredLanguage:()=> 'en'}
export const isCloudMode=()=>state.cloud
export const cloudVisionModel=()=> 'test-vision'
export const describeCloudImage=async(_image:string,_prompt:string,signal?:AbortSignal)=>{state.signal=signal;state.scans++;if(state.failure)throw new Error('Rate limited');if(state.defer)return new Promise<string>(resolve=>{state.resolve=resolve});return 'Those ricochets look preem, choom.'}
export const llmFetch=async()=>{throw new Error('Local model must not start')}
export const llmBody=JSON.stringify
export const localAIEnabled=()=>false
export const localVisionModels=async()=>[]
export const describeLocalImage=async()=>{throw new Error('Local model must not start')}
export const ollamaService={ensureRunning:async()=>{throw new Error('Local model must not start')}}
export const macGameContext={prompt:()=> 'Your partner is playing ULTRAKILL.'}
export const isMac=true
