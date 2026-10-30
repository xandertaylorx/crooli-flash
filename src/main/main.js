'use strict';

const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listDrives } = require('./drives');
const { runElevated, wasDeclined } = require('./elevate');
const updater = require('./updater');

const isMac = process.platform === 'darwin';
const isDev = process.env.CROOLI_FLASH_DEV === '1';
const noElevate = isDev && process.env.CROOLI_FLASH_NOELEVATE === '1';

/* Links the interface may open in the browser. */
const allowedLinks = [/^https:\/\/crooli\.com(\/|$)/, /^https:\/\/os\.crooli\.com(\/|$)/, /^https:\/\/github\.com\/xandertaylorx\//];

let win = null;
let drives = [];
let lastListing = '';
let activeJob = null;

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 860,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    title: 'Crooli Flash',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 20, y: 20 },
    titleBarOverlay: isMac
      ? undefined
      : {
          color: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#ededed' : '#171717',
          height: 44,
        },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.on('close', (event) => {
    if (!activeJob) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep going', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A drive is still being written.',
      detail: 'Quitting now leaves the drive half finished. You can run it again afterwards.',
    });
    if (choice === 0) event.preventDefault();
    else cancelJob();
  });
  win.on('closed', () => (win = null));
}

function openLink(url) {
  if (allowedLinks.some((pattern) => pattern.test(url))) shell.openExternal(url);
}

/* ---------------------------------------------------------------- drives */

async function refreshDrives() {
  drives = await listDrives();
  const snapshot = JSON.stringify(drives);
  if (snapshot !== lastListing) {
    lastListing = snapshot;
    if (win && !win.isDestroyed()) win.webContents.send('drives:changed', drives);
  }
  return drives;
}

/* ---------------------------------------------------------------- images */

function volumeLabel(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2048);
      fs.readSync(fd, head, 0, 2048, 32768);
      if (head.toString('latin1', 1, 6) !== 'CD001') return '';
      return head.toString('latin1', 40, 72).trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const imagePattern = /\.(iso|img|raw|bin)$/i;

function inspectImage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { error: 'Choose an .iso or .img file.' };
  if (!imagePattern.test(file)) return { error: 'That is not a disk image. Choose an .iso or .img file.' };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { error: 'That file could not be read.' };
  }
  if (!stat.isFile() || stat.size === 0) return { error: 'That file could not be read.' };
  return { path: file, name: path.basename(file), size: stat.size, label: volumeLabel(file) };
}

/* ---------------------------------------------------------------- jobs */

const cleanLabel = (value, limit) => (String(value || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, limit) || 'CROOLI');

function send(event) {
  if (win && !win.isDestroyed()) win.webContents.send('job:event', event);
}

function cancelJob() {
  if (activeJob) fs.writeFileSync(activeJob.cancel, '1');
}

async function startJob(request) {
  if (activeJob) return { error: 'Something is already running.' };

  const fresh = await refreshDrives();
  const device = fresh.find((drive) => drive.id === request.driveId);
  if (!device) return { error: 'That drive is no longer plugged in.' };

  const job = { op: request.op, device, verify: request.verify !== false };

  if (request.op === 'flash' || request.op === 'verify') {
    const image = inspectImage(request.image);
    if (image.error) return { error: image.error };
    if (image.size > device.size) return { error: `That image is ${(image.size / 1e9).toFixed(1)} GB and the drive holds ${(device.size / 1e9).toFixed(1)} GB.` };
    job.image = image.path;
  } else if (request.op === 'format') {
    const kinds = process.platform === 'darwin' ? ['fat32', 'exfat', 'hfs'] : ['fat32', 'exfat', 'ntfs'];
    job.fs = kinds.includes(request.fs) ? request.fs : 'exfat';
    job.label = cleanLabel(request.label, job.fs === 'ntfs' ? 32 : 11);
    if (job.fs === 'fat32') job.label = job.label.toUpperCase();
    job.scheme = request.scheme === 'gpt' ? 'gpt' : 'mbr';
    job.erase = request.erase === 'zero' ? 'zero' : 'quick';
    if (process.platform === 'win32' && job.fs === 'fat32' && device.size > 32 * 1024 ** 3) {
      return { error: 'Windows cannot make a FAT32 drive larger than 32 GB. Choose exFAT.' };
    }
  } else {
    return { error: 'Unknown action.' };
  }

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'crooli-flash-'));
  job.progress = path.join(folder, 'progress.ndjson');
  job.cancel = path.join(folder, 'cancel');
  fs.writeFileSync(job.progress, '');
  const jobFile = path.join(folder, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job));

  activeJob = { cancel: job.cancel, folder };
  send({ type: 'phase', phase: 'authorizing', label: 'Waiting for permission' });

  let offset = 0;
  let finished = false;
  const pump = () => {
    let text;
    try {
      text = fs.readFileSync(job.progress, 'utf8');
    } catch {
      return;
    }
    const chunk = text.slice(offset);
    const end = chunk.lastIndexOf('\n');
    if (end < 0) return;
    offset += end + 1;
    for (const line of chunk.slice(0, end).split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') finished = true;
        send(event);
      } catch {
        /* a partial line; it will arrive whole next time */
      }
    }
  };
  const timer = setInterval(pump, 100);

  runElevated({ app, jobFile, elevate: !noElevate }).then((result) => {
    clearInterval(timer);
    pump();
    if (!finished) {
      if (wasDeclined(result)) send({ type: 'declined' });
      else send({ type: 'error', message: (result.stderr || '').trim().split('\n').pop() || 'The drive tool stopped unexpectedly.' });
    }
    fs.rmSync(folder, { recursive: true, force: true });
    activeJob = null;
    refreshDrives();
  });

  return { ok: true };
}

/* ---------------------------------------------------------------- wiring */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  dev: isDev,
}));
ipcMain.handle('app:open', (_event, url) => openLink(String(url)));
ipcMain.handle('drives:list', () => refreshDrives());
ipcMain.handle('image:inspect', (_event, file) => inspectImage(file));
ipcMain.handle('image:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose a disk image',
    properties: ['openFile'],
    filters: [{ name: 'Disk images', extensions: ['iso', 'img', 'raw', 'bin'] }],
  });
  return canceled || !filePaths[0] ? null : inspectImage(filePaths[0]);
});
ipcMain.handle('job:start', (_event, request) => startJob(request || {}));
ipcMain.handle('job:cancel', () => cancelJob());
ipcMain.handle('update:current', () => updater.current());
ipcMain.handle('update:install', () => updater.install());

app.whenReady().then(() => {
  createWindow();
  refreshDrives();
  updater.start({
    notify: (event) => win && !win.isDestroyed() && win.webContents.send('update:event', event),
    allowed: () => !activeJob,
  });
  setInterval(() => {
    if (win && win.isVisible() && !activeJob) refreshDrives();
  }, 2500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
