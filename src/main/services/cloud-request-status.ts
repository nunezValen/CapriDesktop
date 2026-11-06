import { app } from 'electron'
import fs from 'fs'
import path from 'path'
export interface CloudRequestStatus {
  host: string
  model: string
  state: 'sending' | 'responded' | 'failed'
  startedAt: number
  elapsedMs?: number
  httpStatus?: number
}
let last: CloudRequestStatus | null=null
const file=()=>path.join(app.getPath('userData'),'cloud-request-status.json')
function record(status: CloudRequestStatus) {
  last=status
  try {fs.mkdirSync(path.dirname(file()),{recursive:true});fs.writeFileSync(file(),JSON.stringify(status),{mode:0o600})} catch {}
}
export function getCloudRequestStatus(): CloudRequestStatus | null {
  if (last) return last
  try {return JSON.parse(fs.readFileSync(file(),'utf8'))} catch {return null}
}
/** Only routing/timing/status metadata is retained. Headers, keys, prompts and responses are never logged. */
export async function trackedCloudFetch(url: string, init: RequestInit, model: string): Promise<Response> {
  const status: CloudRequestStatus={host:new URL(url).hostname,model,state:'sending',startedAt:Date.now()}
  record(status)
  try {
    const response=await fetch(url,init)
    record({...status,state:response.ok ? 'responded' : 'failed',httpStatus:response.status,elapsedMs:Date.now()-status.startedAt})
    return response
  } catch(error) {
    record({...status,state:'failed',elapsedMs:Date.now()-status.startedAt})
    throw error
  }
}
