'use strict';

/*
 * The part of Crooli Flash that touches the disk. It runs as its own process, started with
 * administrator rights (see elevate.js), reads one job file and reports back by appending JSON lines
 * to the progress file named in the job. It never talks to the network and never decides which disk
 * to use: main.js only hands it a disk it listed itself.
 *
 *   node worker.js <job.json>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CHUNK = 4 * 1024 * 1024;
const ALIGN = 4096;

const jobFile = process.argv[2];
if (!jobFile) {
  console.error('usage: worker.js <job.json>');
  process.exit(2);
}
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';

/* ---------------------------------------------------------------- reporting */

let lastEmit = 0;
function send(message) {
  try {
    fs.appendFileSync(job.progress, JSON.stringify(message) + '\n');
  } catch {
    /* the app went away; keep working, the disk operation should still finish cleanly */
  }
}

function phase(name, label) {
  send({ type: 'phase', phase: name, label });
}

class Cancelled extends Error {}

let lastCancelCheck = 0;
function checkCancel() {
  const now = Date.now();
  if (now - lastCancelCheck < 200) return;
  lastCancelCheck = now;
  if (job.cancel && fs.existsSync(job.cancel)) throw new Cancelled('Cancelled');
}

/* Progress for one pass over `total` bytes. Passes are weighted so the ring never jumps backwards. */
function meter(startFraction, spanFraction, total) {
  const began = Date.now();
  return (done, force) => {
    checkCancel();
    const now = Date.now();
    if (!force && now - lastEmit < 90) return;
    lastEmit = now;
    const seconds = Math.max(0.001, (now - began) / 1000);
    const rate = done / seconds;
    send({
      type: 'progress',
      fraction: startFraction + spanFraction * (total ? Math.min(1, done / total) : 1),
      done,
      total,
      rate,
      eta: rate > 0 ? Math.max(0, (total - done) / rate) : null,
    });
  };
}

/* ---------------------------------------------------------------- helpers */

const roundUp = (n, to) => Math.ceil(n / to) * to;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result;
}

function friendly(error) {
  const code = error && error.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'Crooli Flash was not allowed to write to that drive. Close anything that is using it and try again.';
  }
  if (code === 'EBUSY') return 'The drive is busy. Close any windows that are using it, then try again.';
  if (code === 'ENOSPC') return 'The image does not fit on that drive.';
  if (code === 'ENOENT') return 'The drive or image could not be found. Was it unplugged?';
  if (code === 'EIO') return 'The drive stopped responding. It may be damaged or was unplugged.';
  return (error && error.message) || String(error);
}

function diskpart(lines) {
  const script = path.join(os.tmpdir(), `crooli-flash-${process.pid}.txt`);
  fs.writeFileSync(script, lines.join('\r\n') + '\r\n');
  try {
    const result = run('diskpart', ['/s', script]);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 || /has encountered an error|virtual disk service error|access is denied/i.test(output)) {
      const detail = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /error|denied|not|cannot|too/i.test(line))
        .slice(0, 2)
        .join(' ');
      throw new Error(detail || 'Windows could not prepare the drive.');
    }
    return output;
  } finally {
    fs.rmSync(script, { force: true });
  }
}

/* Take every volume on the disk away from the operating system so the raw device can be written. */
function release() {
  if (job.test) return;
  if (mac) {
    const result = run('diskutil', ['unmountDisk', 'force', `/dev/${job.device.id}`]);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Could not unmount the drive.').trim());
  } else if (win) {
    diskpart([`select disk ${job.device.number}`, 'attributes disk clear readonly', 'clean']);
  }
}

function openDevice(flags) {
  return fs.openSync(job.device.raw, flags);
}

function readFully(fd, buffer, position) {
  let got = 0;
  while (got < buffer.length) {
    const n = fs.readSync(fd, buffer, got, buffer.length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

/* ---------------------------------------------------------------- operations */

function hashFile(file, report) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    let done = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, CHUNK, done);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      done += n;
      report(done);
    }
    return { sha256: hash.digest('hex'), size };
  } finally {
    fs.closeSync(fd);
  }
}

function hashDevice(size, report) {
  const fd = openDevice('r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    let done = 0;
    while (done < size) {
      const want = Math.min(CHUNK, roundUp(size - done, ALIGN));
      const slice = want === CHUNK ? buffer : buffer.subarray(0, want);
      const got = readFully(fd, slice, done);
      if (got < Math.min(want, size - done)) throw Object.assign(new Error('read short'), { code: 'EIO' });
      const use = Math.min(want, size - done);
      hash.update(slice.subarray(0, use));
      done += use;
      report(done);
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function write(source, size) {
  const src = fs.openSync(source, 'r');
  const dst = openDevice('r+');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(CHUNK);
    const report = meter(0, job.verify ? 0.5 : 1, size);
    let done = 0;
    while (done < size) {
      const n = fs.readSync(src, buffer, 0, Math.min(CHUNK, size - done), done);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      const padded = roundUp(n, ALIGN);
      if (padded > n) buffer.fill(0, n, padded);
      let wrote = 0;
      while (wrote < padded) wrote += fs.writeSync(dst, buffer, wrote, padded - wrote, done + wrote);
      done += n;
      report(done);
    }
    report(done, true);
    try {
      fs.fsyncSync(dst);
    } catch {
      /* raw devices on some systems refuse fsync; the close below flushes them */
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(src);
    fs.closeSync(dst);
  }
}

function zeroFill(startFraction, spanFraction) {
  const total = job.device.size;
  const dst = openDevice('r+');
  try {
    const buffer = Buffer.alloc(CHUNK);
    const report = meter(startFraction, spanFraction, total);
    let done = 0;
    while (done < total) {
      const length = Math.min(CHUNK, total - done);
      const padded = job.test ? length : roundUp(length, ALIGN);
      let wrote = 0;
      while (wrote < padded) wrote += fs.writeSync(dst, buffer, wrote, padded - wrote, done + wrote);
      done += length;
      report(done);
    }
    report(done, true);
  } finally {
    fs.closeSync(dst);
  }
}

function eject() {
  if (job.test) return;
  if (mac) run('diskutil', ['eject', `/dev/${job.device.id}`]);
}

function flash() {
  const size = fs.statSync(job.image).size;
  if (size > job.device.size) throw Object.assign(new Error('too big'), { code: 'ENOSPC' });

  phase('preparing', 'Getting the drive ready');
  release();

  phase('writing', 'Writing');
  const expected = write(job.image, size);

  if (job.verify) {
    phase('verifying', 'Checking every byte');
    const report = meter(0.5, 0.5, size);
    const actual = hashDevice(size, report);
    report(size, true);
    if (actual !== expected) {
      throw new Error('The drive does not match the image. Try again, or use a different drive.');
    }
  }

  phase('finishing', 'Finishing up');
  eject();
  send({ type: 'done', sha256: expected, verified: !!job.verify, bytes: size });
}

function verify() {
  const size = fs.statSync(job.image).size;
  phase('hashing', 'Reading the image');
  const readImage = meter(0, 0.5, size);
  const image = hashFile(job.image, readImage);
  readImage(size, true);

  // Reading never changes the drive, so nothing is unmounted or cleaned here.
  phase('verifying', 'Checking the drive');
  const readDrive = meter(0.5, 0.5, size);
  const actual = hashDevice(size, readDrive);
  readDrive(size, true);

  const matches = actual === image.sha256;
  send({ type: 'done', sha256: image.sha256, verified: matches, matches, bytes: size, op: 'verify' });
}

function format() {
  const { fs: fsName, label, scheme, erase } = job;
  const zero = erase === 'zero';

  phase('preparing', 'Getting the drive ready');
  release();

  if (zero) {
    phase('erasing', 'Erasing every byte');
    zeroFill(0, 0.9);
  }

  phase('formatting', 'Formatting');
  if (job.test) {
    // nothing to format in a test run
  } else if (mac) {
    const names = { fat32: 'FAT32', exfat: 'ExFAT', hfs: 'JHFS+' };
    const result = run('diskutil', [
      'eraseDisk',
      names[fsName] || 'ExFAT',
      label,
      scheme === 'gpt' ? 'GPT' : 'MBR',
      `/dev/${job.device.id}`,
    ]);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Formatting failed.').trim());
  } else if (win) {
    diskpart([
      `select disk ${job.device.number}`,
      'clean',
      `convert ${scheme === 'gpt' ? 'gpt' : 'mbr'}`,
      'create partition primary',
      `format fs=${fsName} quick label="${label}"`,
      'assign',
    ]);
  }

  phase('finishing', 'Finishing up');
  send({ type: 'done', verified: false, op: 'format', label, fs: fsName });
}

/* ---------------------------------------------------------------- main */

try {
  send({ type: 'start', pid: process.pid });
  if (job.op === 'flash') flash();
  else if (job.op === 'verify') verify();
  else if (job.op === 'format') format();
  else throw new Error(`Unknown operation: ${job.op}`);
  process.exit(0);
} catch (error) {
  if (error instanceof Cancelled) {
    send({ type: 'cancelled' });
    process.exit(0);
  }
  send({ type: 'error', message: friendly(error) });
  process.exit(1);
}
