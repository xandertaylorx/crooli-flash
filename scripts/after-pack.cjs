// Electron's prebuilt app is signed, and editing it breaks that signature. Apple silicon refuses to
// start an app whose signature is broken, so seal it again with an ad-hoc signature. This is not
// notarization; the install command (crooli.com/flash) is what keeps Gatekeeper out of the way.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
