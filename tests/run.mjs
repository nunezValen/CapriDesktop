import { build } from 'esbuild'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const mock = (file) => path.resolve('tests', file)
await build({
  entryPoints: ['tests/mac.test.ts'],
  outfile: 'work/tests.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'test-only-mocks',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: mock('electron-mock.ts') }))
        b.onResolve({ filter: /mac-desktop$/ }, () => ({ path: mock('native-mock.ts') }))
        b.onResolve(
          { filter: /script\/script-player$|agent-manager$|scanner-service$|llm-gateway$|user-profile$|agents\/tools\/tool-executor$|windows\/window-manager$/ },
          () => ({ path: mock('dependency-mock.ts') }),
        )
      },
    },
  ],
})
execFileSync(process.execPath, ['--test', 'work/tests.cjs'], { stdio: 'inherit' })

await build({
  entryPoints:['tests/scanner.test.ts'],outfile:'work/scanner-tests.cjs',bundle:true,platform:'node',format:'cjs',
  plugins:[{name:'scanner-test-mocks',setup(b){
    b.onResolve({filter:/^electron$|(?:local-ai-policy|local-vision|llm-gateway|user-profile|platform|consciousness-service|ollama-service|mac-game-context|agent-manager|window-manager)$/},()=>({path:mock('scanner-mocks.ts')}))
  }}]
})
execFileSync(process.execPath,['--test','work/scanner-tests.cjs'],{stdio:'inherit'})

await build({
  entryPoints:['tests/agent-lifecycle.test.ts'],outfile:'work/agent-lifecycle-tests.cjs',bundle:true,platform:'node',format:'cjs',
  plugins:[{name:'agent-lifecycle-mocks',setup(b){
    b.onResolve({filter:/^electron$/},()=>({path:mock('electron-mock.ts')}))
    b.onResolve({filter:/capri-local-agent$|script-player$|llm-gateway$|user-profile$|consciousness-service$|shared\/lines$|window-manager$|ollama-service$|roaming-manager$|active-window-service$|pending-result$/},()=>({path:mock('agent-lifecycle-mocks.ts')}))
  }}]
})
execFileSync(process.execPath,['--test','work/agent-lifecycle-tests.cjs'],{stdio:'inherit'})

await build({
  entryPoints:['tests/mac-desktop-cache.test.ts'],outfile:'work/mac-desktop-cache-tests.cjs',bundle:true,platform:'node',format:'cjs',
  plugins:[{name:'desktop-cache-mocks',setup(b){
    b.onResolve({filter:/^electron$|^child_process$/},()=>({path:mock('mac-desktop-cache-mocks.ts')}))
  }}]
})
execFileSync(process.execPath,['--test','work/mac-desktop-cache-tests.cjs'],{stdio:'inherit'})
