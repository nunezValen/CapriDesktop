// Update the existing app bundle. Run only after quitting Capri; user data is never replaced.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const sign = require('./sign-mac-local.cjs')
async function update() {
  if (process.platform !== 'darwin') throw new Error('Run this update on macOS')
  const source = path.resolve('release/mac-arm64/Capri Desktop.app')
  const target = '/Applications/Capri Desktop.app'
  const executable=path.join(target,'Contents/MacOS/Capri Desktop')
  const running=execFileSync('/bin/ps',['-axo','comm='],{encoding:'utf8'}).split('\n').some(line=>line.trim()===executable)
  if (running) throw new Error('Quit Capri Desktop before applying the update.')
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',source])
  const backup=path.resolve('work/installed-app-backup/Capri Desktop.app')
  fs.mkdirSync(path.dirname(backup),{recursive:true})
  execFileSync('/usr/bin/ditto',[target,backup])
  for (const relative of ['Contents/Resources/app.asar','Contents/Info.plist']) {
    fs.copyFileSync(path.join(source,relative),path.join(target,relative))
  }
  for(const relative of ['Contents/Resources/scripts','Contents/Resources/scripts-capri']) {
    fs.cpSync(path.join(source,relative),path.join(target,relative),{recursive:true,force:true})
  }
  await sign({electronPlatformName:'darwin',appOutDir:path.dirname(target),packager:{appInfo:{productFilename:'Capri Desktop'}}})
  console.log('Existing app updated. Executable, application path and user data preserved. Backup:',backup)
}
update().catch(error=>{console.error(error.message);process.exitCode=1})
