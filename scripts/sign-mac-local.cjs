const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
module.exports = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'darwin') return
  const bundle = path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  // Prefer the same installed development identity on personal builds. Ad hoc signatures bind privacy grants to each build.
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {encoding:'utf8'})
  const identityFile=path.resolve('work/mac-signing-identity')
  const saved=fs.existsSync(identityFile) ? fs.readFileSync(identityFile,'utf8').trim() : ''
  const identity = process.env.CAPRI_MAC_SIGN_IDENTITY || saved || identities.match(/\b([A-F0-9]{40})\s+"Apple Development:/)?.[1] || '-'
  if (identity !== '-' && !identities.includes(identity)) throw new Error('The saved Mac signing identity is unavailable. Restore its certificate/key before updating to preserve the app identity.')
  if (identity !== '-') { fs.mkdirSync(path.dirname(identityFile),{recursive:true});fs.writeFileSync(identityFile,identity,{mode:0o600}) }
  console.log(identity === '-' ? 'Mac signing: ad hoc (privacy permissions may need approval after updates).' : 'Mac signing: existing Apple Development identity (stable code requirement across updates).')
  execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--identifier', 'dev.cybercompanion.capri.desktop-helper', path.join(bundle, 'Contents/Resources/scripts/macos/bin/capri-desktop')])
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, bundle])
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
}
