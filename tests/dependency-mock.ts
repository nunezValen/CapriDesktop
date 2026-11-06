export const toolCalls: unknown[] = []
export const ToolExecutor = {
  execute: async (...args: unknown[]) => {
    toolCalls.push(args)
    return { success: true, output: 'ok' }
  },
}
export const windowManager = { setGamingMode: () => toolCalls.push('game-mode') }
export const llmFetch = async () => {
  throw new Error('No model installed (test)')
}
export const llmBody = (value: unknown) => value

export const personalize = (text: string) => text

export const screenCalls={captures:0,uploads:0,speech:[] as string[]}
export const isCloudMode=()=>true
export const describeCloudImage=async()=>{screenCalls.uploads++;return 'Test screen comment'}
export const scannerService={getStatus:()=>({isScanning:false}),captureRegionBase64:async()=>{screenCalls.captures++;return {base64:'synthetic-test-image'}}}
export const agentManager={getCompanionState:()=> 'standing',setCompanionSpeech:(text:string)=>screenCalls.speech.push(text)}
