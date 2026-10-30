// Runs the disk worker against ordinary files, so the write, verify, format and cancel paths can be
// checked on any machine without touching a real drive.  npm test
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const worker = resolve('src/main/worker.js');
const dir = mkdtempSync(join(tmpdir(), 'crooli-flash-test-'));
const image = join(dir, 'image.iso');
const target = join(dir, 'target.img');
const body = Buffer.concat([randomBytes(5 * 1024 * 1024), randomBytes(1234)]); // not sector aligned, on purpose
writeFileSync(image, body);
const sha = createHash('sha256').update(body).digest('hex');

function run(op, extra = {}) {
  const progress = join(dir, `${op}.ndjson`);
  const cancel = join(dir, 'cancel');
  writeFileSync(progress, '');
  const job = { op, image, verify: true, test: true, device: { id: 'test', raw: target, size: 16 * 1024 * 1024 }, progress, cancel, ...extra };
  const file = join(dir, `${op}.json`);
  writeFileSync(file, JSON.stringify(job));
  const result = spawnSync(process.execPath, [worker, file], { encoding: 'utf8' });
  const events = readFileSync(progress, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { code: result.status, events, last: events.at(-1) };
}

writeFileSync(target, Buffer.alloc(16 * 1024 * 1024));

let r = run('flash');
assert.equal(r.code, 0);
assert.equal(r.last.type, 'done');
assert.equal(r.last.sha256, sha);
assert.equal(r.last.verified, true);
assert.deepEqual(readFileSync(target).subarray(0, body.length), body);
console.log('ok  flash writes the image and verifies it');

r = run('verify');
assert.equal(r.last.matches, true);
console.log('ok  verify matches an untouched drive');

const damaged = readFileSync(target);
damaged[3 * 1024 * 1024] ^= 0xff;
writeFileSync(target, damaged);
r = run('verify');
assert.equal(r.last.matches, false);
console.log('ok  verify catches a single flipped byte');

r = run('flash', { device: { id: 'test', raw: target, size: 1024 } });
assert.equal(r.code, 1);
assert.equal(r.last.type, 'error');
console.log('ok  an image larger than the drive is refused');

writeFileSync(join(dir, 'cancel'), '1');
r = run('flash');
assert.equal(r.last.type, 'cancelled');
console.log('ok  cancelling stops a write');

rmSync(join(dir, 'cancel'));
writeFileSync(target, Buffer.alloc(8 * 1024 * 1024, 0xab));
r = run('format', { fs: 'exfat', label: 'CROOLI', scheme: 'mbr', erase: 'zero' });
assert.equal(r.last.type, 'done');
assert.ok(readFileSync(target).subarray(0, 8 * 1024 * 1024).every((byte) => byte === 0));
console.log('ok  full erase zeroes every byte');

console.log('\nall worker checks passed');
