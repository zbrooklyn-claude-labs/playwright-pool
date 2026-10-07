// tests/sweep.test.js — the leftover sweep removes only what it can prove is abandoned: a server's
// folders when that server wrote an owner file and its process is gone. Folders of servers from
// before owner files (every chat running before this change) are kept and only counted.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { isAlive, planSweep, sweepLeftovers, writeOwner, ownerFile } from '../lib/sweep.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pool-sweep-'));
const mk = (dir, name, bytes = 10) => {
  fs.mkdirSync(path.join(dir, name, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'Default', 'Cookies'), 'x'.repeat(bytes));
};
// A process that has already exited: its pid is a dead one. Never a guess at a real pid.
const deadPid = () => new Promise(resolve => {
  const p = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  p.on('exit', () => resolve(p.pid));
});

test('isAlive: this process is alive, an exited one is not, junk is not', async () => {
  assert.strictEqual(isAlive(process.pid), true);
  const pid = await deadPid();
  assert.strictEqual(isAlive(pid), false);
  // asking about it did not affect this process or anything else
  assert.strictEqual(isAlive(process.pid), true);
  assert.strictEqual(isAlive(0), false);
  assert.strictEqual(isAlive(-5), false);
  assert.strictEqual(isAlive('12'), false);
});

test('planSweep: dead owner removed, live owner kept, no owner file kept and counted, own session untouched', async () => {
  const dir = tmpDir();
  try {
    const dead = await deadPid();
    mk(dir, 'deadbeef-1'); mk(dir, 'deadbeef-default-template');
    fs.writeFileSync(ownerFile(dir, 'deadbeef'), JSON.stringify({ pid: dead, startedAt: 1 }));
    mk(dir, 'a1b2c3d4-1');
    fs.writeFileSync(ownerFile(dir, 'a1b2c3d4'), JSON.stringify({ pid: process.pid, startedAt: 1 }));
    mk(dir, 'ffff0000-1', 100); mk(dir, 'ffff0000-tabs', 50);
    mk(dir, '12345678-1'); // this server's own
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a pool folder');
    mk(dir, 'not-a-session');

    const plan = planSweep(dir, '12345678');
    assert.deepStrictEqual(plan.remove.sort(), ['deadbeef-1', 'deadbeef-default-template', 'deadbeef.owner.json'].sort());
    assert.deepStrictEqual(plan.legacy.sort(), ['ffff0000-1', 'ffff0000-tabs']);
    assert.ok(plan.legacyBytes >= 150);

    const done = sweepLeftovers(dir, '12345678');
    assert.strictEqual(done.removed, 3);
    const left = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(left, ['12345678-1', 'a1b2c3d4-1', 'a1b2c3d4.owner.json', 'ffff0000-1', 'ffff0000-tabs', 'not-a-session', 'notes.txt'].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable owner file counts as unknown: kept', () => {
  const dir = tmpDir();
  try {
    mk(dir, 'abcdef01-1');
    fs.writeFileSync(ownerFile(dir, 'abcdef01'), '{not json');
    const plan = planSweep(dir, '12345678');
    assert.deepStrictEqual(plan.remove, []);
    assert.deepStrictEqual(plan.legacy, ['abcdef01-1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOwner records this process; a missing folder is not an error', () => {
  const dir = tmpDir();
  try {
    writeOwner(dir, '0badc0de', 42);
    const o = JSON.parse(fs.readFileSync(ownerFile(dir, '0badc0de'), 'utf8'));
    assert.strictEqual(o.pid, process.pid);
    assert.strictEqual(o.startedAt, 42);
    assert.deepStrictEqual(planSweep(path.join(dir, 'missing'), 'x'), { remove: [], legacy: [], legacyBytes: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the server writes its owner file at start, sweeps a dead server\'s folders, and keeps older ones', { timeout: 60_000 }, async () => {
  const dir = tmpDir();
  const golden = tmpDir();
  fs.mkdirSync(path.join(golden, 'Default'));
  try {
    const dead = await deadPid();
    mk(dir, 'deadbeef-1');
    fs.writeFileSync(ownerFile(dir, 'deadbeef'), JSON.stringify({ pid: dead, startedAt: 1 }));
    mk(dir, 'ffff0000-1');
    const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], {
      env: { ...process.env, POOL_HEADLESS: '1', POOL_DIR: dir, GOLDEN_PROFILE: golden, PROFILES_DIR: path.join(golden, 'p') },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let log = '';
    server.stderr.on('data', d => (log += d));
    const until = Date.now() + 20_000;
    while (!/Sweep:/.test(log) && Date.now() < until) await new Promise(r => setTimeout(r, 200));
    const own = fs.readdirSync(dir).filter(n => n.endsWith('.owner.json') && !n.startsWith('deadbeef'));
    assert.strictEqual(own.length, 1, log);
    assert.ok(!fs.existsSync(path.join(dir, 'deadbeef-1')), log);
    assert.ok(fs.existsSync(path.join(dir, 'ffff0000-1')));
    assert.match(log, /removed 2 abandoned/);
    await new Promise(r => { server.on('exit', r); server.stdin.end(); setTimeout(() => server.kill(), 10_000).unref(); });
    // its own owner file goes with it
    assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.owner.json')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(golden, { recursive: true, force: true });
  }
});
