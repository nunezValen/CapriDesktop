import { consciousnessService } from './consciousness-service'
import { app } from 'electron'
import fs from 'fs'
import { runMacSystemCommand } from './mac-system-service'
import { deviceClockAnswer } from '../../shared/device-clock'
import { defaultHotkeys } from '../../shared/hotkeys'
export async function runMacSystemCheck(file:string) {
  const results:Record<string,unknown>={version:app.getVersion(),readOnly:true,noScreenshots:true,clock:deviceClockAnswer('what time is it?'),hotkeys:defaultHotkeys('darwin'),boredomDefault:consciousnessService.isBoredomEnabled()}
  let passed=true
  for(const action of ['battery','storage','system-info','get-volume'] as const) {
    const result=await runMacSystemCommand({action})
    results[action]=result
    if(!result.success) passed=false
  }
  results.passed=passed
  fs.writeFileSync(file,JSON.stringify(results,null,2))
  app.exit(passed ? 0:1)
}
