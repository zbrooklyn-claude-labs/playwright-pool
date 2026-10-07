// lib/sweep.js — clears pool folders left behind by servers that died without cleaning up.
//
// Every context is a copy of a signed-in profile under POOL_DIR, named `<session>-...` where
// <session> is the 8-hex id of the server that made it. A server removes its own folders on exit,
// but one that is killed cannot. To know which folders are abandoned, each server writes
// `<session>.owner.json` with its pid at start. The sweep removes a session's folders only when its
// owner file names a process that is gone. Folders with no owner file (servers from before owner
// files existed, possibly still running) are never removed here: they are counted for a person to
// decide on.
import fs from 'fs';
import path from 'path';

const SESSION = /^([0-9a-f]{8})(?:-|\.owner\.json$)/;

export const ownerFile = (dir, session) => path.join(dir, `${session}.owner.json`);

// Whether a process exists. Node's signal 0 only checks (on Windows: open the process and read its
// exit code); it never stops anything. EPERM means it exists but belongs to someone else.
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function writeOwner(dir, session, startedAt = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerFile(dir, session), JSON.stringify({ pid: process.pid, startedAt }));
}

function readOwner(dir, session) {
  try {
    const o = JSON.parse(fs.readFileSync(ownerFile(dir, session), 'utf8'));
    return Number.isInteger(o?.pid) ? o : null;
  } catch {
    return null;
  }
}

function sizeOf(p) {
  let total = 0;
  const walk = q => {
    let st;
    try { st = fs.lstatSync(q); } catch { return; }
    if (st.isDirectory()) for (const e of fs.readdirSync(q)) walk(path.join(q, e));
    else total += st.size;
  };
  walk(p);
  return total;
}

// What a sweep would do, without doing it. `remove`: names under dir; `legacy`: folders kept
// because nothing proves their owner gone; `legacyBytes`: their size.
export function planSweep(dir, ownSession, { measure = true } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { remove: [], legacy: [], legacyBytes: 0 }; }
  const bySession = new Map();
  for (const name of names) {
    const m = SESSION.exec(name);
    if (!m || m[1] === ownSession) continue;
    if (!bySession.has(m[1])) bySession.set(m[1], []);
    bySession.get(m[1]).push(name);
  }
  const remove = [];
  const legacy = [];
  for (const [session, list] of bySession) {
    const owner = readOwner(dir, session);
    if (owner && !isAlive(owner.pid)) remove.push(...list);
    else if (!owner) legacy.push(...list.filter(n => !n.endsWith('.owner.json')));
  }
  const legacyBytes = measure ? legacy.reduce((n, name) => n + sizeOf(path.join(dir, name)), 0) : 0;
  return { remove, legacy, legacyBytes };
}

// Removes what planSweep proves abandoned. Never throws; folders still in use cannot be removed and
// are skipped. Owner files go last, so a sweep cut short is finished by the next one.
export function sweepLeftovers(dir, ownSession) {
  const { remove } = planSweep(dir, ownSession, { measure: false });
  let removed = 0;
  const failed = [];
  const rm = name => {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed++;
    } catch {
      failed.push(name);
    }
  };
  for (const name of remove.filter(n => !n.endsWith('.owner.json'))) rm(name);
  // an owner file stays while any of its folders could not go, so the next sweep finishes the job
  for (const name of remove.filter(n => n.endsWith('.owner.json')))
    if (!failed.some(f => f.startsWith(name.slice(0, 8)))) rm(name);
  return { removed, failed };
}
