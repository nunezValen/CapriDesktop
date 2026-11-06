import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
const run = promisify(execFile)
export function isUsageQuestion(text: string): boolean {
  return /\b(?:ram|memory|memore?y|memoria|cpu|processor)\b/i.test(text) && /\b(?:us(?:e|es|ing|age)|consum\w*|much|most|check|show|what|which|heavy|lot|cuanto|que)\b/i.test(text) && !/\b(?:write|implement|code|remember|forget)\b/i.test(text)
}
export function parseProcessUsage(output: string) {
  const groups = new Map<string, { name: string; bytes: number; cpu: number }>()
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*\d+\s+(\d+)\s+([\d.]+)\s+(.+)$/)
    if (!match) continue
    const executable = match[3].trim()
    const bundle = executable.match(/\/([^/]+)\.app\//)?.[1]
    const name = bundle || path.basename(executable)
    const group = groups.get(name) || { name, bytes: 0, cpu: 0 }
    group.bytes += Number(match[1]) * 1024
    group.cpu += Number(match[2])
    groups.set(name, group)
  }
  return [...groups.values()].sort((a,b)=>b.bytes-a.bytes)
}
export async function macMemoryPressure(): Promise<number | null> {
  return run('/usr/sbin/sysctl', ['-n','kern.memorystatus_vm_pressure_level'], {timeout:2000}).then(r=>Number(r.stdout.trim()) || null).catch(()=>null)
}
async function collectMacUsage(): Promise<string> {
  const [{ stdout }, swap] = await Promise.all([
    run('/bin/ps', ['-axo', 'pid=,rss=,%cpu=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }),
    run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 3000 }).then(r=>r.stdout.match(/used =\s*([\d.]+[MG])/i)?.[1] || 'unknown').catch(()=>'unknown'),
  ])
  const processes = parseProcessUsage(stdout)
  const size = (bytes:number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
  const top = processes.slice(0,5).map(p=>`${p.name}: ${size(p.bytes)}`).join('; ')
  const cpu = processes.reduce<(typeof processes)[number] | undefined>((best,item)=>!best || item.cpu>best.cpu ? item : best,undefined)
  return `Your Mac has ${size(os.totalmem())} RAM. Biggest memory users right now: ${top}. Swap used: ${swap}. ${cpu ? `Highest CPU: ${cpu.name} (${cpu.cpu.toFixed(1)}%, process average). ` : ''}These are resident-memory estimates grouped by app; shared memory can overlap. Quit unused apps to free memory; I haven't closed anything.`
}

let usageCache: {until:number;text:string} | null=null
let pendingUsage: Promise<string> | null=null
export async function macUsageSummary(): Promise<string> {
  if (usageCache && Date.now()<usageCache.until) return usageCache.text
  if (pendingUsage) return pendingUsage
  pendingUsage=collectMacUsage().then(text=>{usageCache={until:Date.now()+2000,text};return text}).finally(()=>{pendingUsage=null})
  return pendingUsage
}
