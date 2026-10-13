// Acceptance tests for the proposed pool patch (breach-check launch flag, wait limits, opt-in headless).
// Non-destructive: new file only, existing tests untouched. Local fixture only; no real accounts; headless unless ACCEPT_HEADED=1.
//   node --test tests/acceptance/pool-patch.acceptance.test.js
//   ACCEPT_HEADED=1 node --test tests/acceptance/pool-patch.acceptance.test.js   (also runs the headed breach-check click test; a window appears briefly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const SRC = fs.readFileSync(SERVER, 'utf8');
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- local fixture ----------
const fixture = http.createServer((q, r) => {
  const u = new URL(q.url, BASE); const ms = +u.searchParams.get('ms') || 0;
  const ck = Object.fromEntries((q.headers.cookie || '').split(/;\s*/).filter(Boolean).map(x => x.split('=')));
  r.setHeader('content-type', 'text/html');
  if (u.pathname === '/doc') return void setTimeout(() => r.end('<title>Slow doc</title><h1>Slow doc loaded</h1>'), ms);
  if (u.pathname === '/login') { r.setHeader('set-cookie', `sess=${u.searchParams.get('user')}; Max-Age=3600; Path=/`); return void r.end('<title>login</title><p>logged in</p>'); }
  if (u.pathname === '/secret') return void r.end(`<title>secret</title><p>${ck.sess ? 'Welcome ' + ck.sess : 'Please log in'}</p>`);
  // a login form whose password is on public breach lists, then a page whose button changes the title
  if (u.pathname === '/form') return void r.end('<title>form</title><form method=post action=/after><input id=u name=u value=standard_user><input id=p type=password name=p value=secret_sauce><button id=go type=submit>Login</button></form>');
  if (u.pathname === '/after') return void r.end('<title>after</title><button id=b onclick="document.title=\'clicked\'">Add</button>');
  r.end('ok');
});
test.before(() => new Promise(res => fixture.listen(PORT, '127.0.0.1', res)));
test.after(() => fixture.close());

// ---------- minimal MCP stdio client for the pool server ----------
function startPool(env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-accept-'));
  fs.mkdirSync(path.join(tmp, 'golden', 'Default'), { recursive: true });
  const p = spawn('node', [SERVER], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, GOLDEN_PROFILE: path.join(tmp, 'golden'), POOL_DIR: path.join(tmp, 'ctx'), PROFILES_DIR: path.join(tmp, 'profiles'), ...env } });
  let buf = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {} } });
  const rpc = (method, params) => new Promise((res, rej) => { const myId = ++id; const t = setTimeout(() => rej(new Error('rpc timeout ' + method)), 90000); waiting.set(myId, m => { clearTimeout(t); res(m); }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const t = performance.now(); const m = await rpc('tools/call', { name, arguments: args }); return { ms: performance.now() - t, text: (m.result?.content || []).map(c => c.text || '').join('\n'), isError: !!m.result?.isError }; };
  const ready = (async () => { await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'accept', version: '1' } }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); })();
  const close = () => { try { p.kill(); } catch {} setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1500); };
  return { call, ready, close, tmp };
}

// ---------- static checks (fast; fail on an unpatched file) ----------
test('P1: both browser launches carry the breach-check launch argument, with an opt-out', () => {
  assert.ok(/LEAK_CHECK_ARGS\s*=\s*process\.env\.POOL_KEEP_LEAK_CHECK === '1'/.test(SRC), 'opt-out env missing');
  assert.ok(SRC.includes('passwordsleakcheck-pa.googleapis.com'), 'lookup host not blocked');
  assert.equal((SRC.match(/\.\.\.LEAK_CHECK_ARGS/g) || []).length, 2, 'expected the flag in the window launch and the tab launch');
});
test('P1: no profile setting is written (nothing can reach a saved profile)', () => {
  assert.ok(!/password_manager_leak_detection/.test(SRC), 'a Preferences write for the breach check is present');
});
test('P2: wait limits are set (navigation 30 s, action 5 s)', () => {
  assert.ok(/timeouts:\s*\{\s*action:\s*5000,\s*navigation:\s*30000\s*\}/.test(SRC), 'timeouts block missing or different');
});
test('P3: headless is opt-in and the default stays headed', () => {
  assert.ok(/POOL_HEADLESS === '1'/.test(SRC) && /\{ headless: true, channel: 'chromium' \}/.test(SRC) && /\{ headless: false \}/.test(SRC), 'headless option shape changed');
});

// ---------- behaviour, headless via the opt-in mode ----------
test('P2 behaviour: a page that answers in 12 s still loads; a wrong wait fails near the 30 s limit', { timeout: 120000 }, async () => {
  const pool = startPool({ POOL_HEADLESS: '1' }); await pool.ready;
  try {
    await pool.call('pool_launch', { mode: 'window', label: 'tmo' });
    const ok = await pool.call('browser_navigate', { url: `${BASE}/doc?ms=12000` });
    assert.ok(/Slow doc loaded/.test(ok.text), 'a 12 s page should load');
    const bad = await pool.call('browser_run_code', { code: "async (page) => { await page.waitForURL('**/never.html'); return 'ok'; }" });
    assert.ok(/Timeout 30000ms/.test(bad.text), 'wrong wait should report the 30 s limit: ' + bad.text.slice(0, 160));
    assert.ok(bad.ms > 29000 && bad.ms < 36000, `wrong wait took ${Math.round(bad.ms)} ms`);
  } finally { pool.close(); }
});
test('sessions: two windows keep separate logins; a saved profile is reused; a fresh launch is logged out', { timeout: 150000 }, async () => {
  const pool = startPool({ POOL_HEADLESS: '1' }); await pool.ready;
  try {
    const idOf = t => (t.match(/Created window "([^"]+)"/) || [])[1];
    const w1 = idOf((await pool.call('pool_launch', { mode: 'window', label: 'w1' })).text); await pool.call('browser_navigate', { url: `${BASE}/login?user=alice` });
    const w2 = idOf((await pool.call('pool_launch', { mode: 'window', label: 'w2' })).text); await pool.call('browser_navigate', { url: `${BASE}/login?user=bob` });
    await pool.call('pool_switch', { id: w1 }); const a = (await pool.call('browser_navigate', { url: `${BASE}/secret` })).text;
    await pool.call('pool_switch', { id: w2 }); const b = (await pool.call('browser_navigate', { url: `${BASE}/secret` })).text;
    assert.ok(a.includes('Welcome alice') && b.includes('Welcome bob'), 'logins crossed between windows');
    await pool.call('pool_switch', { id: w1 }); await pool.call('pool_save_profile', { profileName: 'acc' });
    await pool.call('pool_launch', { mode: 'window', label: 'reuse', profileName: 'acc' });
    assert.ok((await pool.call('browser_navigate', { url: `${BASE}/secret` })).text.includes('Welcome alice'), 'saved login was not reused');
    await pool.call('pool_launch', { mode: 'window', label: 'fresh' });
    assert.ok((await pool.call('browser_navigate', { url: `${BASE}/secret` })).text.includes('Please log in'), 'a launch without the profile leaked a login');
  } finally { pool.close(); }
});

// ---------- headed behaviour (opt-in: a temporary window appears) ----------
test('P1 behaviour (headed, ACCEPT_HEADED=1): after a login with a flagged password the next click lands; with the opt-out it does not', { timeout: 240000, skip: process.env.ACCEPT_HEADED !== '1' }, async () => {
  const run = async (env) => {
    const pool = startPool(env); await pool.ready;
    try {
      await pool.call('pool_launch', { mode: 'window', label: 'leak' });
      const nav = await pool.call('browser_navigate', { url: `${BASE}/form` });
      const ref = (nav.text.match(/button "Login" \[ref=(e\d+)\]/) || [])[1];
      await pool.call('browser_click', { ref, element: 'Login' });
      await new Promise(r => setTimeout(r, 6000));
      const snap = await pool.call('browser_snapshot'); const add = (snap.text.match(/button "Add" \[ref=(e\d+)\]/) || [])[1];
      await pool.call('browser_click', { ref: add, element: 'Add' });
      const t = await pool.call('browser_evaluate', { function: '() => document.title' });
      return /clicked/.test(t.text);
    } finally { pool.close(); }
  };
  assert.equal(await run({}), true, 'with the patch the click must land');
  // negative control: the opt-out restores the old behaviour; if it ALSO lands, the test setup (not the patch) is what is passing
  const without = await run({ POOL_KEEP_LEAK_CHECK: '1' });
  assert.equal(without, false, 'negative control did not reproduce the problem: this environment cannot prove the fix (check that Google is reachable)');
});

// ---------- window default, and scope of the breach-check flag (headed: a temporary window appears) ----------

const windowState = async (pool) => {
  const r = await pool.call('browser_run_code', { code: "async (page) => { const c = await page.context().newCDPSession(page); const { windowId } = await c.send('Browser.getWindowForTarget'); const { bounds } = await c.send('Browser.getWindowBounds', { windowId }); return bounds.windowState; }" });
  return (r.text.match(/"(normal|minimized|maximized|fullscreen)"/) || [])[1] || r.text.slice(0, 120);
};
test('window default: a new pool window opens fully visible; POOL_START_MINIMIZED=1 starts it minimized', { timeout: 180000, skip: process.env.ACCEPT_HEADED !== '1' }, async () => {
  const a = startPool(); await a.ready;
  try { await a.call('pool_launch', { mode: 'window', label: 'vis' }); assert.equal(await windowState(a), 'normal', 'default window is not visible'); } finally { a.close(); }
  const b = startPool({ POOL_START_MINIMIZED: '1' }); await b.ready;
  try { await b.call('pool_launch', { mode: 'window', label: 'min' }); assert.equal(await windowState(b), 'minimized', 'opt-in minimized start did not minimize'); } finally { b.close(); }
});
test('scope: the breach-check flag is on browsers the pool launched, and on no other Chrome/Edge process', { timeout: 120000 }, async () => {
  const pool = startPool({ POOL_HEADLESS: '1' }); await pool.ready;
  try {
    await pool.call('pool_launch', { mode: 'window', label: 'scope' });
    const rows = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|chromium)[.]exe$' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 }) || '[]');
    const all = (Array.isArray(rows) ? rows : [rows]).filter(r => r && r.CommandLine);
    const flag = 'passwordsleakcheck-pa.googleapis.com';
    const mine = all.filter(r => r.CommandLine.includes(pool.tmp));
    assert.ok(mine.length > 0, 'found no browser process belonging to this pool run');
    assert.ok(mine.some(r => r.CommandLine.includes(flag) && r.CommandLine.includes('--remote-debugging-port')), 'pool browser lacks the flag');
    const others = all.filter(r => !mine.includes(r) && r.CommandLine.includes(flag));
    assert.equal(others.length, 0, 'the flag reached processes that are not this pool run: ' + others.map(r => r.ProcessId).join(','));
  } finally { pool.close(); }
});
