'use strict';

/*
 * Runs worker.js with administrator rights. The operating system shows its own password or UAC
 * prompt, so Crooli Flash never sees or stores the password. Only one prompt is shown per job.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const quoteShell = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const quoteAppleScript = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function workerPath(app) {
  const file = path.join(__dirname, 'worker.js');
  return app.isPackaged ? file.replace('app.asar', 'app.asar.unpacked') : file;
}

/* Starts the job; resolves with { code, stderr } when the elevated process has ended. */
function runElevated({ app, jobFile, elevate = true }) {
  const worker = workerPath(app);
  const node = process.execPath;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  return new Promise((resolve) => {
    let child;
    let cleanup = () => {};

    if (!elevate) {
      child = spawn(node, [worker, jobFile], { env, windowsHide: true });
    } else if (process.platform === 'darwin') {
      const command = `ELECTRON_RUN_AS_NODE=1 ${quoteShell(node)} ${quoteShell(worker)} ${quoteShell(jobFile)}`;
      child = spawn('osascript', ['-e', `do shell script "${quoteAppleScript(command)}" with administrator privileges`]);
    } else if (process.platform === 'win32') {
      const launcher = path.join(os.tmpdir(), `crooli-flash-${process.pid}-${Date.now()}.cmd`);
      fs.writeFileSync(launcher, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "${worker}" "${jobFile}"\r\n`);
      cleanup = () => fs.rmSync(launcher, { force: true });
      const ps = `try { Start-Process -FilePath '${launcher.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop } catch { exit 3 }`;
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    } else {
      child = spawn('pkexec', [node, worker, jobFile], { env });
    }

    let stderr = '';
    child.stderr && child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      cleanup();
      resolve({ code: -1, stderr: error.message });
    });
    child.on('exit', (code) => {
      cleanup();
      resolve({ code, stderr });
    });
  });
}

/* True when the password or UAC prompt was dismissed rather than something failing. */
function wasDeclined({ code, stderr }) {
  if (process.platform === 'darwin') return /User canceled|-128/i.test(stderr);
  if (process.platform === 'win32') return code === 3;
  return code === 126 || code === 127;
}

module.exports = { runElevated, wasDeclined };
