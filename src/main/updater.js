'use strict';

/*
 * Keeps Crooli Flash up to date without a signing certificate. It asks GitHub for the latest release,
 * and when that is newer than the running app it offers an Update button. The download is checked
 * against the SHA-256 GitHub publishes for the file, then swapped in after the app quits and the new
 * version is opened. Files the app downloads itself carry no "from the internet" flag, so macOS and
 * Windows have nothing to stop, which is the same reason the install command works.
 */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const RELEASE_URL = 'https://api.github.com/repos/xandertaylorx/crooli-flash/releases/latest';
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const fake = process.env.CROOLI_FLASH_FAKE_UPDATE;

let send = () => {};
let latest = null;
let busy = false;
let canInstall = () => true;

const parts = (version) => String(version).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

const assetName = () => (isMac ? `Crooli-Flash-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip` : 'Crooli-Flash-Setup.exe');

async function check() {
  if (busy || (!app.isPackaged && !fake)) return latest;
  try {
    const response = await fetch(RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return latest;
    const release = await response.json();
    const asset = (release.assets || []).find((item) => item.name === assetName());
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (asset && newer(version, app.getVersion())) {
      latest = { version, url: asset.browser_download_url, size: asset.size, digest: (asset.digest || '').replace(/^sha256:/, '') };
      send({ state: 'available', version });
    }
  } catch {
    /* offline, or GitHub is busy; try again at the next check */
  }
  return latest;
}

async function download(target) {
  const response = await fetch(latest.url);
  if (!response.ok || !response.body) throw new Error('The update could not be downloaded.');
  const total = Number(response.headers.get('content-length')) || latest.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(target);
  let done = 0;
  let last = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    done += chunk.length;
    if (Date.now() - last > 120) {
      last = Date.now();
      send({ state: 'downloading', version: latest.version, fraction: total ? done / total : 0 });
    }
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  if (latest.digest && hash.digest('hex') !== latest.digest) throw new Error('The download did not match its checksum, so it was not installed.');
}

function swapOnMac(zip, folder) {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  if (!bundle.endsWith('.app')) throw new Error('Update is only available in the installed app.');
  const staged = path.join(folder, 'out');
  const unpack = spawnSync('ditto', ['-x', '-k', zip, staged]);
  const fresh = path.join(staged, path.basename(bundle));
  if (unpack.status !== 0 || !fs.existsSync(fresh)) throw new Error('The update could not be unpacked.');
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    throw new Error('Crooli Flash cannot replace itself here. Run the install command again instead.');
  }
  const script = path.join(folder, 'swap.sh');
  fs.writeFileSync(
    script,
    `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
rm -rf "$1" && mv "$2" "$1" && xattr -dr com.apple.quarantine "$1" 2>/dev/null
open "$1"
rm -rf "${folder}"
`,
  );
  spawn('/bin/sh', [script, bundle, fresh], { detached: true, stdio: 'ignore' }).unref();
}

function swapOnWindows(setup, folder) {
  const exe = process.execPath;
  const command = `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '${setup.replace(/'/g, "''")}' -ArgumentList '/S' -Wait; Start-Process -FilePath '${exe.replace(/'/g, "''")}'; Remove-Item -Recurse -Force '${folder.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`;
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function install() {
  if (!latest || busy) return;
  if (!canInstall()) return send({ state: 'error', message: 'Finish the current job first, then update.' });
  busy = true;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'crooli-flash-update-'));
  try {
    send({ state: 'downloading', version: latest.version, fraction: 0 });
    const file = path.join(folder, assetName());
    await download(file);
    send({ state: 'installing', version: latest.version });
    if (fake && !app.isPackaged) return send({ state: 'error', message: 'Update check works. Installing is only done in the installed app.' });
    if (isMac) swapOnMac(file, folder);
    else if (isWin) swapOnWindows(file, folder);
    else throw new Error('Updates are available on Mac and Windows.');
    setTimeout(() => app.quit(), 400);
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    send({ state: 'error', message: error.message });
  } finally {
    busy = false;
  }
}

function start({ notify, allowed }) {
  send = notify;
  canInstall = allowed;
  setTimeout(check, 6000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

module.exports = { start, check, install, current: () => latest && { state: 'available', version: latest.version } };
