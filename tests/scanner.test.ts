import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ScannerService} from '../src/main/services/scanner-service'
import {state,powerMonitor} from './scanner-mocks'
const pause=()=>new Promise(resolve=>setTimeout(resolve,110))
test('cloud Live Scan is opt-in, throttled, stopped on close/lock/error, and suppresses late replies',async()=>{
  const scanner=new ScannerService()
  const originalNow=Date.now
  scanner.init()
  try {
  assert.equal(scanner.getStatus().isContinuous,false)
  assert.equal(scanner.setContinuous(true),true)
  assert.equal(state.continuous,false,'Cloud Live must not persist across restart')
  await (scanner as any).tickContinuous()
  assert.equal(state.scans,1)
  await (scanner as any).tickContinuous()
  assert.equal(state.scans,1,'No second upload within one minute')
  const firstScanTime=Date.now()
  Date.now=()=>firstScanTime+60001
  state.changed=false
  await (scanner as any).tickContinuous()
  assert.equal(state.scans,2,'Changed contents can upload after the one-minute limit')
  Date.now=originalNow
  scanner.close()
  assert.equal(scanner.getStatus().isContinuous,false)
  state.visible=true;state.permission='denied'
  assert.throws(()=>scanner.setContinuous(true),/Screen Recording/)
  state.permission='granted';scanner.setContinuous(true)
  state.failure=true
  await (scanner as any).tickContinuous()
  assert.equal(scanner.getStatus().isContinuous,false,'Provider error stops retries')
  state.failure=false;scanner.setContinuous(true)
  powerMonitor.emit('lock-screen')
  assert.equal(scanner.getStatus().isContinuous,false)
  const before=state.scans
  await (scanner as any).tickContinuous()
  assert.equal(state.scans,before)
  powerMonitor.emit('unlock-screen');scanner.setContinuous(true)
  state.defer=true
  const pending=(scanner as any).tickContinuous()
  for(let i=0;i<10 && !state.resolve;i++) await pause()
  assert.ok(state.resolve)
  const spoken=state.spoken.length
  scanner.setContinuous(false)
  assert.equal(state.signal?.aborted,true,'Turning Live off aborts its provider request')
  state.resolve!('Late reply should not be spoken')
  await pending
  assert.equal(state.spoken.length,spoken)
  } finally {Date.now=originalNow;scanner.close();powerMonitor.removeAllListeners()}
})
