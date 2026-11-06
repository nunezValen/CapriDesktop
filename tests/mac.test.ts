import { gameCompanionState } from '../src/shared/companion-appearance'
import { MacGameContext, macGameContext } from '../src/main/services/mac-game-context'
import { detectGameName } from '../src/main/services/game/game-commentary'
import { consciousnessService } from '../src/main/services/consciousness-service'
import { setStorageRoot, getStorageRoot } from '../src/main/services/storage-location'
import { speechModelsDir } from '../src/main/services/app-paths'
import { planMove } from '../src/main/services/storage-move'
import { parseMacSystemCommand, isMacSystemRequest } from '../src/shared/mac-system-commands'
import { runMacSystemCommand } from '../src/main/services/mac-system-service'
import { mockSystemVolume } from './native-mock'
import { defaultHotkeys, normalizeHotkeys, clampGamingOpacity } from '../src/shared/hotkeys'
import { isVersionRequest, isHoldStillRequest } from '../src/main/agents/spoken-commands'
import { macAppName } from '../src/main/services/mac-desktop.ts'
import { deviceClockAnswer, deviceClockContext } from '../src/shared/device-clock'
import { friendScreenComment } from '../src/shared/screen-comment-style'
import { startScreenComments, scheduleScreenComments } from '../src/main/services/screen-comment-service'
import { powerMonitor, setTestMediaStatus } from './electron-mock'
import { screenCalls } from './dependency-mock'
import { commentMinutes, ShakeDetector } from '../src/shared/mac-feature-policy'
import { featureSettings, saveFeatures } from '../src/main/services/mac-feature-settings'
import { wakeListeningPrompt } from '../src/shared/voice-policy'
import { checkAddressed } from '../src/main/services/wake-word'
import { AlwaysListener } from '../src/renderer/src/utils/alwaysListening'
import { describeCloudImage, getLlmSettings, setLlmSettings, NVIDIA_VISION_MODEL } from '../src/main/services/llm-gateway.ts'
import { scannerVisionMode } from '../src/shared/platform-policy'
import { trackedCloudFetch, getCloudRequestStatus } from '../src/main/services/cloud-request-status'
import { localAIEnabled, setLocalAIEnabled } from '../src/main/services/local-ai-policy'
import { closestSpotifyTrack, spotifySearchQueries, verifySpotifySelection } from '../src/shared/spotify-match'
import { localVisionModels, describeLocalImage, isScreenQuestion } from '../src/main/services/local-vision'
import { isUsageQuestion, parseProcessUsage } from '../src/main/services/mac-usage'
import { parsePlacementCommand, anchorBounds } from '../src/shared/placement'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { platformCapabilities, updateDelivery, captureCrop, recommendedLocalModel, offerDesktopTools } from '../src/shared/platform-policy'
import { startCommand, listProcessNames, findOnPath } from '../src/main/services/platform'
import { SpotifyService } from '../src/main/services/spotify-service'
import { platformStatus, requestPermission, openPermission } from '../src/main/services/mac-permissions'
import { MacroService } from '../src/main/services/macro-service'
import { opened } from './electron-mock'
import { calls, setDesktopMode } from './native-mock'
import { toolCalls } from './dependency-mock'

const temp = mkdtempSync(path.join(tmpdir(), 'capri-tests-'))
process.env.CAPRI_TEST_DATA = temp
after(() => {
  rmSync(temp, { recursive: true, force: true })
})
const spotify = new SpotifyService()

test('Mac capabilities degrade when access is denied; Windows/Linux keep their features', () => {
  assert.deepEqual(platformCapabilities('darwin', false, false), {
    desktopAwareness: false,
    screenCapture: false,
    paint: false,
    clipping: false,
    gameIntegrations: false,
    commandMacros: false,
  })
  assert.equal(platformCapabilities('win32', true, true).paint, true)
  assert.equal(platformCapabilities('linux', true, true).paint, false)
  assert.equal(platformCapabilities('linux', true, true).commandMacros, true)
})
test('Mac packaged updates always use a release page, even with APPIMAGE accidentally set', () => {
  assert.equal(updateDelivery('darwin', true, false), 'release-page')
  assert.equal(updateDelivery('darwin', true, true), 'release-page')
  assert.equal(updateDelivery('darwin', false, false), 'source')
  assert.equal(updateDelivery('win32', true, false), 'windows-installer')
  assert.equal(updateDelivery('linux', true, false), 'release-page')
  assert.equal(updateDelivery('linux', true, true), 'appimage')
})
test('Retina crop uses actual capture dimensions and negative display origins', () => {
  assert.deepEqual(
    captureCrop(
      { x: -1920, y: -200, width: 1920, height: 1080 },
      { x: -1820, y: -100, width: 400, height: 200 },
      { width: 3840, height: 2160 },
    ),
    { x: 200, y: 200, width: 800, height: 400 },
  )
  assert.deepEqual(
    captureCrop(
      { x: 0, y: 0, width: 1000, height: 500 },
      { x: 900, y: 450, width: 200, height: 100 },
      { width: 1000, height: 500 },
    ),
    { x: 900, y: 450, width: 100, height: 50 },
  )
  assert.equal(
    captureCrop(
      { x: 0, y: 0, width: 1000, height: 500 },
      { x: 1100, y: 20, width: 100, height: 100 },
      { width: 1000, height: 500 },
    ),
    null,
  )
})
test('Mac route uses open, safely quotes targets, and queries native processes', async () => {
  assert.equal(startCommand("https://example.com/a'b"), "/usr/bin/open 'https://example.com/a'\\''b'")
  assert.equal((await listProcessNames())?.has('safari.exe'), true)
  assert.ok(findOnPath('sh'))
})
test('Permission status is read-only, denies desktop capabilities and rejects unknown panes', async () => {
  const s = await platformStatus()
  assert.equal(s.capabilities.desktopAwareness, false)
  assert.equal(s.capabilities.screenCapture, false)
  await assert.rejects(openPermission('bogus' as any), /Invalid/)
  const before = calls.filter((c) => c === 'applescript').length
  await platformStatus()
  assert.equal(calls.filter((c) => c === 'applescript').length, before)
  assert.equal((await requestPermission('microphone')).permissions.microphone, 'denied')
})
test('Spotify defaults, validation and selected provider survive a new service instance', async () => {
  assert.equal(spotify.settings().method, 'desktop')
  assert.throws(() => spotify.configure({ method: 'invalid' as any }), /Invalid/)
  assert.throws(() => spotify.configure({ clientId: 'bad' }), /Invalid/)
  spotify.configure({ method: 'web-api', clientId: 'a'.repeat(32) })
  assert.equal(new SpotifyService().settings().method, 'web-api')
  assert.equal((await spotify.play('a song')).success, false)
  assert.match((await spotify.play('a song')).output, /Connect Spotify/)
  // API failure must not launch Spotify or invoke AppleScript as a fallback.
  assert.equal(
    calls.some((c) => c.startsWith('launch:')),
    false,
  )
})
test('Desktop provider returns permission errors instead of reporting success', async () => {
  spotify.configure({ method: 'desktop' })
  assert.equal((await spotify.control('pause')).success, false)
  const count = calls.filter((c) => c === 'applescript').length
  const status = await spotify.status()
  assert.equal(status.isPlaying, false)
  assert.match(status.error!, /Automation/)
  assert.equal(calls.filter((c) => c === 'applescript').length, count)
})
test('Spotify API search/play, token refresh, no track, no device and Premium errors', async () => {
  spotify.configure({ method: 'web-api', deviceId: '' })
  ;(spotify as any).saveTokens({ access_token: 'test-token', refresh_token: 'test-refresh', expiresAt: Date.now() - 1 })
  assert.ok(!readFileSync(path.join(temp, 'spotify-mac.json'), 'utf8').includes('test-refresh'))
  let mode = 'success'
  const requests: { url: string; method?: string; body?: string }[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), method: init?.method, body: init?.body?.toString() })
    if (String(url).includes('/api/token')) return Response.json({ access_token: 'new-token', expires_in: 3600 })
    if (String(url).includes('/search'))
      return Response.json({
        tracks: {
          items:
            mode === 'no-track' ? [] : [{ uri: 'spotify:track:1234567890123456789012', name: 'Example', artists: [{ name: 'Artist' }] }],
        },
      })
    if (String(url).includes('/devices'))
      return Response.json({ devices: mode === 'no-device' ? [] : [{ id: 'device1', name: 'Mac', is_active: true }] })
    if (mode === 'premium') return new Response('{}', { status: 403 })
    if (mode === 'rate-limit') return new Response('{}', { status: 429, headers: { 'retry-after': '2' } })
    return new Response(null, { status: 204 })
  }) as any
  try {
    assert.equal((await spotify.play('Example')).success, true)
    assert.ok(requests.some((r) => r.url.includes('/api/token')))
    assert.ok(
      requests.some(
        (r) => r.url.endsWith('/play?device_id=device1') && r.method === 'PUT' && r.body?.includes('spotify:track:123'),
      ),
    )
    mode = 'no-track'
    assert.match((await spotify.play('missing')).output, /No Spotify track/)
    mode = 'no-device'
    assert.match((await spotify.play('Example')).output, /device/)
    mode = 'premium'
    assert.match((await spotify.play('Example')).output, /Premium/)
    mode = 'rate-limit'
    assert.match((await spotify.control('next')).output, /2 seconds/)
  } finally {
    globalThis.fetch = oldFetch
    spotify.disconnect()
  }
  assert.equal(spotify.settings().connected, false)
})
test('Existing command macros are rejected before any partial execution', async () => {
  const macro = new MacroService()
  const before = toolCalls.length
  const result = await macro.run(
    {
      id: 'old',
      trigger: 'test',
      createdAt: 1,
      actions: [
        { type: 'open_app', app: 'Safari' },
        { type: 'command', command: 'echo test' },
      ],
    },
    { say: () => {} },
  )
  assert.match(result.join(' '), /No actions were run/)
  assert.equal(toolCalls.length, before)
})
test('New command macros rejected; supported multi-action macros still execute', async () => {
  const service = new MacroService()
  ;(service as any).parseWithLlm = async () => ({
    trigger: 'do it',
    actions: [{ type: 'command', command: 'echo test' }],
  })
  await assert.rejects(service.createFromSentence('create it', 'http://localhost'), /not supported/)
  const said: string[] = []
  const result = await service.run(
    {
      id: 'supported',
      trigger: 'go',
      createdAt: 1,
      actions: [
        { type: 'open_app', app: 'Safari' },
        { type: 'media', action: 'pause' },
        { type: 'gaming_mode', on: true },
        { type: 'say', text: 'Ready' },
      ],
    },
    { say: (text) => said.push(text) },
  )
  assert.equal(result.length, 3)
  assert.deepEqual(said, ['Ready'])
})

test('Desktop search selects an exact track URI, verifies playback and rejects overlapping searches', async () => {
  setDesktopMode('success')
  spotify.configure({ method: 'desktop' })
  const pending = spotify.play('Example')
  assert.equal((await spotify.play('Another song')).success, false)
  const result = await pending
  assert.equal(result.success, true)
  assert.match(result.output, /Artist - Example/)
  assert.ok(calls.includes('spotify-search'))
  assert.ok(!opened.some((url) => url.startsWith('spotify:search:')))
  assert.ok(calls.includes('spotify-result'))
  setDesktopMode('denied')
})
test('PKCE OAuth validates state, stores tokens, and cancels cleanly', async () => {
  spotify.configure({ method: 'web-api', clientId: 'b'.repeat(32) })
  const oldFetch = globalThis.fetch
  let tokenRequest = ''
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).startsWith('https://accounts.spotify.com/')) {
      tokenRequest = init.body.toString()
      return Response.json({ access_token: 'oauth-test-token', refresh_token: 'oauth-refresh', expires_in: 3600 })
    }
    return oldFetch(url, init)
  }) as any
  try {
    const before = opened.length
    const connected = spotify.connect()
    for (let i = 0; i < 50 && opened.length === before; i++) await new Promise((r) => setTimeout(r, 10))
    const auth = new URL(opened.at(-1)!)
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(auth.searchParams.get('code_challenge')?.length, 43)
    assert.equal((await spotify.connect()).success, false)
    const invalid = await oldFetch('http://127.0.0.1:43829/callback?state=invalid&code=test')
    assert.equal(invalid.status, 400)
    const callback = await oldFetch(
      `http://127.0.0.1:43829/callback?state=${auth.searchParams.get('state')}&code=test-code`,
    )
    assert.equal(callback.status, 200)
    assert.equal((await connected).success, true)
    assert.ok(tokenRequest.includes('code_verifier='))
    assert.ok(!tokenRequest.includes('client_secret'))
    assert.equal(spotify.settings().connected, true)
    spotify.disconnect()
    assert.equal(spotify.settings().connected, false)
    const cancelled = spotify.connect()
    spotify.disconnect()
    assert.equal((await cancelled).success, false)
  } finally {
    globalThis.fetch = oldFetch
    spotify.disconnect()
  }
})

test('Small-memory Macs get a suitable default without changing Windows/Linux model defaults', () => {
  assert.equal(recommendedLocalModel('darwin', 8 * 1024 ** 3), 'qwen3:1.7b')
  assert.equal(recommendedLocalModel('darwin', 16 * 1024 ** 3), 'qwen2.5-coder:7b')
  assert.equal(recommendedLocalModel('win32', 8 * 1024 ** 3), 'qwen2.5-coder:7b')
  assert.equal(recommendedLocalModel('linux', 8 * 1024 ** 3), 'qwen2.5-coder:7b')
})

test('Ordinary Mac chat cannot accidentally invoke desktop tools', () => {
  assert.equal(offerDesktopTools('darwin','qwen3:1.7b','Reply with exactly MAC_OK.'),false)
  assert.equal(offerDesktopTools('darwin','qwen3:1.7b','What is 2 + 2?'),false)
  assert.equal(offerDesktopTools('darwin','qwen3:1.7b','Open Spotify and play a song'),true)
  assert.equal(offerDesktopTools('darwin','qwen3:1.7b','List files in the project'),true)
  assert.equal(offerDesktopTools('win32','qwen3:1.7b','hello'),true)
})

test('Placement commands distinguish screen positioning, locking and ordinary conversation',()=>{
  assert.equal(parsePlacementCommand('Sit at the bottom on my screen only'),'bottom')
  assert.equal(parsePlacementCommand('Can you sit at the bottom right of my screen?'),'bottom-right')
  assert.equal(parsePlacementCommand('Stay right here'),'here')
  assert.equal(parsePlacementCommand('Roam again'),'roam')
  assert.equal(parsePlacementCommand('Sit on my browser tabs'),null)
  assert.equal(parsePlacementCommand('Explain the bottom of this picture'),null)
})
test('Screen anchors respect negative origins, Dock work areas and small displays',()=>{
  assert.deepEqual(anchorBounds({x:-1920,y:20,width:1920,height:1020},{width:360,height:360},'bottom-left'),{x:-1908,y:668,width:360,height:360})
  assert.deepEqual(anchorBounds({x:0,y:24,width:1000,height:700},{width:360,height:360},'bottom'),{x:320,y:352,width:360,height:360})
  const tiny=anchorBounds({x:0,y:0,width:200,height:200},{width:360,height:360},'bottom-right')
  assert.equal(tiny.x,0);assert.equal(tiny.y,0)
})

test('Memory questions use local telemetry while ordinary memory conversations do not', () => {
  for (const text of ['what is using memory a lot', 'check RAM usage', 'which app is using CPU', 'what is using memorey']) assert.equal(isUsageQuestion(text), true, text)
  for (const text of ['remember my name', 'write a memory allocator', 'how does RAM work']) assert.equal(isUsageQuestion(text), false, text)
})
test('Process memory aggregates app helpers and sorts resident bytes', () => {
  const rows = parseProcessUsage(' 1 1024 2.5 /Applications/Capri Desktop.app/Contents/MacOS/Capri Desktop\n 2 2048 4.0 /Applications/Capri Desktop.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n 3 2000 1.0 /usr/bin/other')
  assert.equal(rows[0].name, 'Capri Desktop')
  assert.equal(rows[0].bytes, 3072 * 1024)
  assert.equal(rows[0].cpu, 6.5)
  assert.equal(rows.length, 2)
})

test('Vision uses the real local model list and image endpoint, releasing memory after a Mac scan', async () => {
  const oldFetch = globalThis.fetch
  const requests: {url:string;body:any}[] = []
  globalThis.fetch = (async (url:any,init:any) => {
    requests.push({url:String(url),body:init?.body ? JSON.parse(init.body) : null})
    return Response.json(String(url).endsWith('/api/tags') ? {models:[{name:'gemma3:4b'}]} : {response:'A red square is visible.'})
  }) as any
  try {
    assert.deepEqual(await localVisionModels(), ['gemma3:4b'])
    assert.equal(await describeLocalImage('gemma3:4b','image-bytes','Describe the square',true), 'A red square is visible.')
    assert.ok(requests.every(r=>r.url.startsWith('http://127.0.0.1:11434/')))
    assert.equal(requests[1].body.model,'gemma3:4b')
    assert.equal(requests[1].body.keep_alive,0)
    assert.deepEqual(requests[1].body.images,['image-bytes'])
    globalThis.fetch = (async()=>Response.json({response:''})) as any
    await assert.rejects(describeLocalImage('gemma3:4b','img','Describe',true), /empty response/)
  } finally { globalThis.fetch = oldFetch }
})

test('Screen questions request a real capture, not an invented window-title description', () => {
  for (const text of ["what is on my screen?", "check my screen", "what can you see", "what do you see right now?", "describe the screen"]) assert.equal(isScreenQuestion(text),true,text)
  for (const text of ["what is screen recording", "change my screen resolution", "play a song"]) assert.equal(isScreenQuestion(text),false,text)
})

test('Spotify chooses the closest real track across spelling, accents and versions', () => {
  const original={uri:'spotify:track:1234567890123456789012',title:'Bohemian Rhapsody',artist:'Queen'}
  const cover={uri:'spotify:track:2234567890123456789012',title:'Bohemian Rhapsody - Karaoke',artist:'Tribute Band'}
  assert.equal(closestSpotifyTrack('boheman rapsody quen',[cover,original])?.uri,original.uri)
  assert.equal(closestSpotifyTrack('play bohemian rhapsody by queen please',[cover,original])?.uri,original.uri)
  assert.equal(closestSpotifyTrack('bohemian rhapsody karaoke',[original,cover])?.uri,cover.uri)
  assert.equal(closestSpotifyTrack('Charli Garcia Demoliendo Hoteles',[{...original,title:'Demoliendo hoteles',artist:'Charly García'}])?.uri,original.uri)
  assert.equal(closestSpotifyTrack('nothing remotely related',[original,cover]),null)
  assert.equal(closestSpotifyTrack('queen',[{...original,uri:'spotify:playlist:1234567890123456789012'}]),null)
})

test('Spotify broadens misspelled searches using the named artist or title keywords', () => {
  assert.deepEqual(spotifySearchQueries('who is ready for tommrow by rat boy'), ['who is ready for tommrow by rat boy','rat boy'])
  assert.deepEqual(spotifySearchQueries('who is ready for tommrow'), ['who is ready for tommrow','ready tommrow','ready'])
  assert.ok(spotifySearchQueries('please play a song').length <= 3)
})

test('Scoped song rows can be ranked and playback must match their title and artist', () => {
  const row={key:"Play Who's Ready for Tomorrow by RAT BOY, IBDY",title:"Who's Ready for Tomorrow",artist:'RAT BOY, IBDY'}
  assert.equal(closestSpotifyTrack('who is ready for tommrow by rat boy',[row])?.key,row.key)
  assert.equal(verifySpotifySelection(row,{uri:'spotify:track:1234567890123456789012',title:"RAT BOY - Who's Ready for Tomorrow"}),true)
  assert.equal(verifySpotifySelection(row,{uri:'spotify:track:1234567890123456789012',title:'RAT BOY - OH NO'}),false)
  assert.equal(verifySpotifySelection(row,{uri:'spotify:track:1234567890123456789012',title:"Someone Else - Who's Ready for Tomorrow"}),false)
})

test('Local AI remains disabled until explicitly reenabled', () => {
  assert.equal(setLocalAIEnabled(false),false)
  assert.equal(localAIEnabled(),false)
  assert.throws(()=>setLocalAIEnabled('yes' as any),/Invalid/)
  assert.equal(setLocalAIEnabled(true),true)
  assert.equal(localAIEnabled(),true)
})

test('Spotify retries while its search control opens instead of requiring manual navigation', async () => {
  setDesktopMode('opening')
  spotify.configure({method:'desktop'})
  const before=calls.filter(c=>c==='spotify-search').length
  const result=await spotify.play('Example')
  assert.equal(result.success,true)
  assert.equal(calls.filter(c=>c==='spotify-search').length-before,2)
  setDesktopMode('denied')
})

test('Cloud and local Mac models answer ordinary questions without desktop/search tools', () => {
  for (const model of ['nvidia/nemotron-3.5-bolt-e4b','qwen3:1.7b','capri']) {
    for (const question of ['when was playstaion released','Who invented the web?','What happens when I open Firefox?','Can you tell me how search engines work?','Explain how to write a file','What is 2 + 2?']) assert.equal(offerDesktopTools('darwin',model,question),false,question)
    for (const command of ['Search for PlayStation release dates','Can you open Firefox?','Please list files','Look up the PlayStation launch date']) assert.equal(offerDesktopTools('darwin',model,command),true,command)
  }
})

test('Cloud request status tracks an actual fetch without retaining credentials or message data', async () => {
  const original=globalThis.fetch
  let complete!: (value:Response)=>void
  globalThis.fetch=(()=>new Promise<Response>(resolve=>{complete=resolve})) as any
  try {
    const request=trackedCloudFetch('https://example.test/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer secret-token'},body:'private-message'},'test-model')
    assert.equal(getCloudRequestStatus()?.state,'sending')
    complete(Response.json({choices:[]}))
    await request
    assert.equal(getCloudRequestStatus()?.httpStatus,200)
    assert.equal(getCloudRequestStatus()?.state,'responded')
    const saved=readFileSync(path.join(temp,'cloud-request-status.json'),'utf8')
    assert.ok(!saved.includes('secret-token') && !saved.includes('private-message'))
    globalThis.fetch=(async()=>{throw Error('network')}) as any
    await assert.rejects(trackedCloudFetch('https://example.test/v1/chat/completions',{},'test-model'))
    assert.equal(getCloudRequestStatus()?.state,'failed')
  } finally {globalThis.fetch=original}
})

test('Cloud vision bypasses disabled local AI and preserves other platform routing', () => {
  assert.equal(scannerVisionMode('darwin',true,false),'cloud')
  assert.equal(scannerVisionMode('darwin',false,false),'disabled')
  assert.equal(scannerVisionMode('win32',true,false),'local')
})
test('Explicit cloud images use the separate vision model and never silently discard the image', async () => {
  const saved=setLlmSettings({provider:'cloud',baseUrl:'https://integrate.api.nvidia.com/v1',model:'text-model',apiKey:'test-key'})
  assert.equal(saved.success,true)
  assert.equal(getLlmSettings().visionModel,NVIDIA_VISION_MODEL)
  const old=globalThis.fetch
  let body:any
  globalThis.fetch=(async(url:any,init:any)=>{
    assert.equal(String(url),'https://integrate.api.nvidia.com/v1/chat/completions')
    body=JSON.parse(init.body)
    return Response.json({choices:[{message:{content:'A red shape.'}}]})
  }) as any
  try {
    assert.equal(await describeCloudImage('/9j/image','Describe this'),'A red shape.')
    assert.equal(body.model,NVIDIA_VISION_MODEL)
    assert.equal(body.messages[1].content[1].type,'image_url')
    assert.equal(body.messages[1].content[1].image_url.url,'data:image/jpeg;base64,/9j/image')
    assert.equal(getLlmSettings().model,'text-model')
    globalThis.fetch=(async()=>new Response('{}',{status:410})) as any
    await assert.rejects(describeCloudImage('img','Describe'),/unavailable/)
    globalThis.fetch=(async()=>Response.json({choices:[{message:{content:''}}]})) as any
    await assert.rejects(describeCloudImage('img','Describe'),/no answer/)
  } finally {globalThis.fetch=old}
})


test('wake name accepts a request and ignores unrelated speech and silence hallucinations', () => {
  assert.deepEqual(checkAddressed('Hey Capri, when was PlayStation released?'), {
    addressed:true, text:'when was PlayStation released?', reason:'wake_word'
  })
  assert.equal(checkAddressed('Hey Kapri! pause music').text, 'pause music')
  assert.equal(checkAddressed('thanks for watching!').addressed, false)
  assert.equal(checkAddressed('When was PlayStation released?').addressed, false)
  assert.equal(checkAddressed('Capri?').addressed, true)
})

test('listener releases microphone when audio initialization fails', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const win = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let stopped = false
  const track = {stop:() => {stopped=true}, onended:null}
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{platform:'MacIntel',mediaDevices:{getUserMedia:async(constraints:any)=>{assert.equal(constraints.audio.deviceId,'default'); assert.equal(constraints.video,false); return {getTracks:()=>[track]}}}}})
  Object.defineProperty(globalThis,'window',{configurable:true,value:{AudioContext:class {constructor(){throw new Error('audio device unavailable')}}}})
  try {
    const listener = new AlwaysListener({isPaused:()=>false,onUtterance:()=>{}})
    await assert.rejects(listener.start(), /audio device unavailable/)
    assert.equal(stopped,true)
    assert.equal(listener.active,false)
  } finally {
    if(nav) Object.defineProperty(globalThis,'navigator',nav); else Reflect.deleteProperty(globalThis,'navigator')
    if(win) Object.defineProperty(globalThis,'window',win); else Reflect.deleteProperty(globalThis,'window')
  }
})

test('paused listener discards audio rather than replaying it after speech output', () => {
  let calls=0
  const listener=new AlwaysListener({isPaused:()=>true,onUtterance:()=>{calls++}})
  const state=listener as any
  state.speaking=true
  state.current=[new Float32Array(2048).fill(.2)]
  state.preRoll=[new Float32Array(2048).fill(.2)]
  state.onFrame(new Float32Array(2048).fill(.2))
  assert.equal(state.speaking,false)
  assert.equal(state.current.length,0)
  assert.equal(state.preRoll.length,0)
  assert.equal(calls,0)
})


test('Mac wake listening rejects video speech and macros without a fresh wake name', () => {
  const none={addressed:false,text:'',reason:'none'}
  assert.equal(wakeListeningPrompt(true,'your Windows VM has a virus',none,true),null)
  assert.equal(wakeListeningPrompt(true,'pause music',{addressed:true,text:'pause music',reason:'macro'},true),null)
  assert.equal(wakeListeningPrompt(true,'Hey Capri, pause music',{addressed:true,text:'pause music',reason:'wake_word'},false),'pause music')
  assert.equal(wakeListeningPrompt(false,'tell me more',none,true),'tell me more')
})


test('screen comments are opt-in, bounded and persist with independent voice settings', () => {
  assert.equal(featureSettings().screenCommentMinutes,0)
  assert.equal(saveFeatures({screenCommentMinutes:7}).screenCommentMinutes,7)
  assert.equal(featureSettings().screenCommentMinutes,7)
  assert.equal(saveFeatures({speechModel:'base'}).screenCommentMinutes,7)
  assert.equal(featureSettings().speechModel,'base')
  assert.equal(saveFeatures({screenCommentMinutes:0}).screenCommentMinutes,0)
  for(const bad of [-1,121,1.5,NaN,'5',null]) assert.throws(()=>commentMinutes(bad))
})

test('glitch reaction needs a deliberate shake, not dragging or a slow wiggle', () => {
  const drag=new ShakeDetector()
  for(let i=0;i<6;i++) assert.equal(drag.update(i*60,i*150),false)
  const shake=new ShakeDetector()
  assert.equal(shake.update(0,0),false)
  assert.equal(shake.update(60,100),false)
  assert.equal(shake.update(0,200),false)
  assert.equal(shake.update(60,300),false)
  assert.equal(shake.update(0,400),true)
  const slow=new ShakeDetector()
  for(let i=0;i<8;i++) assert.equal(slow.update(i%2 ? 60:0,i*1500),false)
})


test('automatic screen comments never capture while off, denied or locked', async t => {
  t.mock.timers.enable({apis:['setInterval','Date'],now:Date.now()})
  const flush=()=>new Promise(resolve=>setImmediate(resolve))
  try {
    saveFeatures({screenCommentMinutes:0})
    startScreenComments()
    t.mock.timers.tick(120000);await flush()
    assert.equal(screenCalls.captures,0)
    saveFeatures({screenCommentMinutes:1});scheduleScreenComments()
    t.mock.timers.tick(60000);await flush()
    assert.equal(screenCalls.captures,0) // Screen Recording denied
    setTestMediaStatus('granted')
    t.mock.timers.tick(60000);await flush()
    assert.equal(screenCalls.captures,1)
    assert.equal(screenCalls.uploads,1)
    powerMonitor.emit('lock-screen')
    t.mock.timers.tick(60000);await flush()
    assert.equal(screenCalls.captures,1)
    powerMonitor.emit('unlock-screen')
    saveFeatures({screenCommentMinutes:0});scheduleScreenComments()
    t.mock.timers.tick(120000);await flush()
    assert.equal(screenCalls.captures,1)
  } finally {
    saveFeatures({screenCommentMinutes:0});scheduleScreenComments()
    setTestMediaStatus('denied')
    powerMonitor.removeAllListeners()
    t.mock.timers.reset()
  }
})


test('friend comments skip private-screen silence and observer narration; never repeat a reply',()=>{
  assert.equal(friendScreenComment('NO_COMMENT'),null)
  assert.equal(friendScreenComment('The user is typing in a chat window.'),null)
  assert.equal(friendScreenComment('The screenshot shows a settings page.'),null)
  assert.equal(friendScreenComment('That build looks preem, choom. That build looks preem, choom.'),'That build looks preem, choom.')
  assert.equal(friendScreenComment('Nova, that soundtrack hits.'),'Nova, that soundtrack hits.')
})


test('device clock answers present-time questions without hijacking history or actions',()=>{
 const now=new Date('2026-11-06T12:34:00Z')
 for(const text of ['what time is it?','Can you tell me the time?','what is the date today?','what day is today?']) assert.ok(deviceClockAnswer(text,now),text)
 for(const text of ['when was PlayStation released?','open Date and Time settings','what time is it in Tokyo?','set a timer for five minutes','play Time by Pink Floyd']) assert.equal(deviceClockAnswer(text,now),null,text)
 assert.match(deviceClockContext(now),/2026-11-06T12:34:00.000Z/)
 assert.match(deviceClockAnswer('what time is it?',now)!,new RegExp(Intl.DateTimeFormat().resolvedOptions().timeZone))
})


test('Windows app names resolve to native Mac equivalents',()=>{
 assert.equal(macAppName('explorer.exe'),'Finder')
 assert.equal(macAppName('File Explorer'),'Finder')
 assert.equal(macAppName('taskmgr.exe'),'Activity Monitor')
 assert.equal(macAppName('Control Panel'),'System Settings')
 assert.equal(macAppName('chrome.exe'),'Google Chrome')
 assert.equal(macAppName('msedge.exe'),'Microsoft Edge')
 assert.equal(macAppName('notepad.exe'),'TextEdit')
 assert.equal(macAppName('calc.exe'),'Calculator')
 assert.equal(macAppName('Some Other App'),'Some Other App')
 assert.ok(deviceClockAnswer('¿Qué hora es?'))
})


test('native Mac commands require explicit actions and leave general conversation alone',()=>{
 assert.deepEqual(parseMacSystemCommand('set volume to 35 percent'),{action:'set-volume',value:35})
 assert.deepEqual(parseMacSystemCommand('can you show my battery status?'),{action:'battery'})
 assert.deepEqual(parseMacSystemCommand('open Wi-Fi settings'),{action:'settings',name:'wi-fi'})
 assert.deepEqual(parseMacSystemCommand('show my downloads folder'),{action:'folder',name:'downloads'})
 assert.deepEqual(parseMacSystemCommand('mute the speakers'),{action:'mute'})
 for(const text of ['explain how volume works','write code to set volume to 30','delete my downloads','empty trash','turn off Wi-Fi','mute yourself','what is battery health']) assert.equal(parseMacSystemCommand(text),null,text)
})

test('native system settings are bounded, verified and never silently run arbitrary commands',async()=>{
 if(process.platform!=='darwin') return
 mockSystemVolume(40)
 try {
   assert.equal((await runMacSystemCommand({action:'set-volume',value:35})).output,'System volume is 35%.')
   assert.equal((await runMacSystemCommand({action:'change-volume',value:-10})).output,'System volume is 25%.')
   assert.equal((await runMacSystemCommand({action:'mute'})).output,'System sound muted.')
   assert.equal((await runMacSystemCommand({action:'unmute'})).output,'System sound unmuted.')
   assert.equal((await runMacSystemCommand({action:'set-volume',value:150})).success,false)
   assert.equal((await runMacSystemCommand({action:'settings',name:'arbitrary;rm -rf'})).success,false)
   assert.equal((await runMacSystemCommand({action:'folder',name:'../../etc'})).success,false)
 } finally {mockSystemVolume(null)}
})

test('upstream configurable hotkeys keep Mac modifiers and preserve other platform defaults',()=>{
 assert.deepEqual(defaultHotkeys('darwin'),{talk:'Alt+Super+V',listen:'Alt+Super+L',chat:'Alt+Super+C'})
 assert.deepEqual(defaultHotkeys('win32'),{talk:'Down',listen:'Right',chat:'Left'})
 assert.deepEqual(defaultHotkeys('linux'),{talk:'Down',listen:'Right',chat:'Left'})
 assert.equal(normalizeHotkeys({listen:'Control+Alt+K'}).listen,'Control+Alt+K')
 assert.equal(clampGamingOpacity(.1),.2)
 assert.equal(clampGamingOpacity(2),1)
})

test('upstream fixed commands recognize multilingual version and hold requests without a model',()=>{
 assert.equal(isVersionRequest('what version are you'),true)
 assert.equal(isHoldStillRequest('reste ici'),true)
 assert.equal(isHoldStillRequest('halt still'),true)
 assert.equal(isHoldStillRequest('stay still'),true)
 assert.equal(isHoldStillRequest('do not move this file'),false)
})


test('Mac storage planning moves only speech cache paths and keeps a usable default',async()=>{
 if(process.platform!=='darwin') return
 const original=speechModelsDir()
 const snapshot=path.join(original,'models--Systran--faster-whisper-base','snapshots','test')
 mkdirSync(snapshot,{recursive:true});writeFileSync(path.join(snapshot,'model.bin'),'test model')
 const destination=path.join(temp,'other-disk','CapriData')
 const oldModels=process.env.OLLAMA_MODELS
 process.env.OLLAMA_MODELS=path.join(temp,'no-real-models')
 try {
  const plan=await planMove(destination,null)
  assert.ok(plan.items.some(item=>item.kind==='whisper' && item.from===original && item.to===path.join(destination,'whisper')))
  assert.equal(readFileSync(path.join(snapshot,'model.bin'),'utf8'),'test model') // planning never moves data
  setStorageRoot(destination)
  assert.equal(speechModelsDir(),path.join(destination,'whisper'))
  setStorageRoot(null)
  assert.equal(speechModelsDir(),original)
 } finally {setStorageRoot(null);if(oldModels===undefined) delete process.env.OLLAMA_MODELS;else process.env.OLLAMA_MODELS=oldModels}
})


test('upstream boredom setting is opt-in on Mac and an explicit choice persists',()=>{
 if(process.platform!=='darwin') return
 assert.equal(consciousnessService.isBoredomEnabled(),false)
 consciousnessService.setBoredomEnabled(true)
 assert.equal(consciousnessService.isBoredomEnabled(),true)
 consciousnessService.setBoredomEnabled(false)
})


test('Mac storage migration does not take ownership of a standalone Ollama library',async()=>{
 if(process.platform!=='darwin') return
 const old=process.env.OLLAMA_MODELS
 const shared=path.join(temp,'standalone-models')
 mkdirSync(path.join(shared,'manifests','library','example'),{recursive:true})
 writeFileSync(path.join(shared,'manifests','library','example','latest'),'not a real model')
 process.env.OLLAMA_MODELS=shared
 try {
   setStorageRoot(null)
   const plan=await planMove(path.join(temp,'new-capri-root'),null)
   assert.equal(plan.items.some(item=>item.kind==='models'),false)
   assert.equal(readFileSync(path.join(shared,'manifests','library','example','latest'),'utf8'),'not a real model')
 } finally {setStorageRoot(null);if(old===undefined) delete process.env.OLLAMA_MODELS;else process.env.OLLAMA_MODELS=old}
})


test('abbreviated and flexible volume requests can reach native controls, not a read-only cloud answer',()=>{
 assert.deepEqual(parseMacSystemCommand('set vol to 70 percent'),{action:'set-volume',value:70})
 assert.deepEqual(parseMacSystemCommand('set. volume to69 percent'),{action:'set-volume',value:69})
 assert.deepEqual(parseMacSystemCommand('turn down the volume'),{action:'change-volume',value:-10})
 assert.equal(isMacSystemRequest('could you adjust my computer volume to 70 please'),true)
 assert.equal(offerDesktopTools('darwin','cloud','could you adjust my computer volume to 70 please'),true)
 assert.equal(isMacSystemRequest('write code to change volume'),false)
 assert.equal(isMacSystemRequest('change your volume'),false)
})


test('Mac game identity recognizes ULTRAKILL and Steam bundles without misidentifying browser pages',()=>{
  assert.equal(detectGameName({title:'ULTRAKILL',process:'ULTRAKILL',path:'/Applications/ULTRAKILL.app',pid:12}),'ULTRAKILL')
  assert.equal(detectGameName({title:'ULTRAKILL',process:'wine64-preloader',path:'/opt/wine/bin/wine',pid:12}),'ULTRAKILL')
  assert.equal(detectGameName({title:'ULTRAKILL review — YouTube',process:'Firefox',path:'/Applications/Firefox.app',pid:13}),null)
  assert.equal(detectGameName({title:'Hades',process:'Hades',path:'/Users/test/Library/Application Support/Steam/steamapps/common/Hades/Hades.app',pid:12}),'Hades')
  const game={title:'Cyberpunk 2077',process:'Cyberpunk2077',path:'/Games/Cyberpunk 2077/game.exe',pid:12}
  assert.equal(detectGameName(game),null,'Windows adapters retain their original routing')
  assert.equal(detectGameName(game,true),'Cyberpunk 2077','Mac can still recognize the game without claiming an adapter')
})
test('game context follows foreground changes, expires and never invents match telemetry',()=>{
  const context=new MacGameContext()
  context.update({title:'ULTRAKILL',process:'ULTRAKILL',path:'/Applications/ULTRAKILL.app',pid:12},100)
  assert.equal(context.current(101)?.foreground,true)
  assert.match(context.prompt(101),/ULTRAKILL/)
  assert.match(context.prompt(101),/not live events/)
  context.update({title:'Home',process:'Firefox',path:'/Applications/Firefox.app',pid:13},102)
  assert.equal(context.current(103)?.foreground,false)
  assert.match(context.prompt(103),/switched away/)
  assert.equal(context.current(30101),null)
  context.clear()
  assert.equal(context.prompt(104),'')
})
test('game interval persists independently and a game-only schedule never captures other apps',async t=>{
  assert.equal(saveFeatures({screenCommentMinutes:0,gameCommentMinutes:1}).gameCommentMinutes,1)
  assert.equal(saveFeatures({speechModel:'base'}).gameCommentMinutes,1)
  t.mock.timers.enable({apis:['Date','setInterval'],now:Date.now()})
  const flush=()=>new Promise(resolve=>setImmediate(resolve))
  const before=screenCalls.captures
  try {
    setTestMediaStatus('granted');macGameContext.clear();scheduleScreenComments()
    t.mock.timers.tick(60000);await flush()
    assert.equal(screenCalls.captures,before)
    for(let i=0;i<4;i++) {
      macGameContext.update({title:'ULTRAKILL',process:'ULTRAKILL',path:'/Applications/ULTRAKILL.app',pid:12})
      t.mock.timers.tick(15000);await flush()
    }
    assert.equal(screenCalls.captures,before+1)
    macGameContext.clear()
    t.mock.timers.tick(120000);await flush()
    assert.equal(screenCalls.captures,before+1)
  } finally {
    saveFeatures({gameCommentMinutes:0});scheduleScreenComments();macGameContext.clear();setTestMediaStatus('denied');t.mock.timers.reset()
  }
})


test('macOS Roblox is recognized without treating Roblox browser pages or Studio as a game',()=>{
  assert.equal(detectGameName({title:'Roblox',process:'Roblox',path:'/Applications/Roblox.app',pid:18287}),'Roblox')
  assert.equal(detectGameName({title:'Roblox',process:'RobloxPlayerBeta',path:'C:\\Roblox\\RobloxPlayerBeta.exe',pid:12}),'Roblox')
  assert.equal(detectGameName({title:'Roblox — Firefox',process:'Firefox',path:'/Applications/Firefox.app',pid:13}),null)
  assert.equal(detectGameName({title:'Roblox Studio',process:'RobloxStudio',path:'/Applications/RobloxStudio.app',pid:13}),null)
})
test('one-minute game comments override an eight-minute startup delay and survive brief focus changes',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:Date.now()})
  const flush=()=>new Promise(resolve=>setImmediate(resolve))
  const before=screenCalls.captures
  const game={title:'Roblox',process:'Roblox',path:'/Applications/Roblox.app',pid:18287}
  try {
    setTestMediaStatus('granted');macGameContext.clear()
    saveFeatures({screenCommentMinutes:8,gameCommentMinutes:1});scheduleScreenComments()
    for(let i=0;i<4;i++) {
      if(i===2) macGameContext.update(null)
      else macGameContext.update(game)
      t.mock.timers.tick(15000);await flush()
    }
    assert.equal(screenCalls.captures,before+1,'First game scan is due after one minute, not eight')
    for(let i=0;i<4;i++) {
      macGameContext.update(i===1 ? null : game)
      t.mock.timers.tick(15000);await flush()
    }
    assert.equal(screenCalls.captures,before+2,'Brief focus changes must not restart the countdown')
  } finally {
    saveFeatures({screenCommentMinutes:0,gameCommentMinutes:0});scheduleScreenComments();macGameContext.clear();setTestMediaStatus('denied');t.mock.timers.reset()
  }
})


test('Mac game appearance stays framed while thinking, speaking or running a script, until explicitly disabled',()=>{
  for(const state of ['thinking','working','talking','asustada','closed','standing','ojos2']) {
    assert.equal(gameCompanionState('MacIntel',true,state),'ojos')
    assert.equal(gameCompanionState('darwin',true,state),'ojos')
    assert.equal(gameCompanionState('MacIntel',false,state),state)
    assert.equal(gameCompanionState('Win32',true,state),state)
    assert.equal(gameCompanionState('Linux',true,state),state)
  }
})
