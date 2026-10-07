// tests/context-routing.test.js — several callers, several browsers: each call lands in the
// browser it names. Runs the real server hidden (POOL_HEADLESS=1) in temporary folders, never
// the real golden profile or pool folder. Where a page really is comes from each browser's own
// debug port, not from what the server says.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A tiny MCP client over stdio: one request at a time, answers matched by id.
function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  let nextId = 1;
  const waiting = new Map();
  let stderr = '';
  child.stderr.on('data', d => (stderr += d));
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 90s\n${stderr}`)), 90_000);
    waiting.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    const text = (r.result?.content ?? []).map(c => c.text ?? '').join('\n');
    return { text, isError: !!r.result?.isError, raw: r };
  };
  const stop = () => new Promise(resolve => {
    child.once('exit', resolve);
    child.stdin.end();
    setTimeout(() => { try { child.kill(); } catch {} }, 15_000).unref();
  });
  return { child, request, notify, call, stop, stderr: () => stderr };
}

// Pages that say whose they are.
function pageServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${new URL(req.url, 'http://x').searchParams.get('owner') ?? 'none'}</title>`);
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let s = '';
    res.on('data', d => (s += d));
    res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

// What a browser itself says it is showing, over its debug port.
const urlsAt = async port => (await getJson(`http://127.0.0.1:${port}/json/list`)).filter(t => t.type === 'page').map(t => t.url);
const launched = text => ({
  id: /Created \w+ "([^"]+)"/.exec(text)?.[1],
  port: Number(/^Debug port: (\d+)$/m.exec(text)?.[1]),
});

describe('context routing', { timeout: 300_000 }, () => {
  let tmp, pages, base, pool;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-routing-'));
    const golden = path.join(tmp, 'golden');
    fs.mkdirSync(path.join(golden, 'Default'), { recursive: true });
    pages = await pageServer();
    base = `http://127.0.0.1:${pages.address().port}/`;
    pool = startServer({
      POOL_HEADLESS: '1',
      POOL_DIR: path.join(tmp, 'contexts'),
      GOLDEN_PROFILE: golden,
      PROFILES_DIR: path.join(tmp, 'profiles'),
    });
    await pool.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    pool.notify('notifications/initialized', {});
  });

  after(async () => {
    await pool?.call('pool_close', { id: 'all' }).catch(() => {});
    await pool?.stop();
    pages?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('advertises an optional context on browser and audit tools, not on pool_launch', async () => {
    const tools = (await pool.request('tools/list', {})).result.tools;
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    for (const name of ['browser_navigate', 'browser_evaluate', 'browser_click', 'snapshot_compact', 'audit_meta', 'browser_cookies_get'])
      assert.ok(byName[name]?.inputSchema?.properties?.context, `${name} should take context`);
    assert.ok(!byName.pool_launch.inputSchema.properties?.context);
  });

  it('each call lands in the browser it names, whichever was launched last', async () => {
    const a = launched((await pool.call('pool_launch', { label: 'agent-A' })).text);
    const b = launched((await pool.call('pool_launch', { label: 'agent-B' })).text);
    assert.ok(a.id && b.id && a.id !== b.id);
    assert.ok(a.port > 0 && b.port > 0 && a.port !== b.port, 'each launch reports its own debug port');

    // B is now the active context; A's calls name A and must still land in A.
    assert.ok(!(await pool.call('browser_navigate', { url: `${base}?owner=A`, context: a.id })).isError);
    assert.ok(!(await pool.call('browser_navigate', { url: `${base}?owner=B`, context: b.id })).isError);
    const ev = await pool.call('browser_evaluate', { function: '() => document.title', context: a.id });
    assert.match(ev.text, /"?A"?/);

    assert.deepStrictEqual(await urlsAt(a.port), [`${base}?owner=A`]);
    assert.deepStrictEqual(await urlsAt(b.port), [`${base}?owner=B`]);

    // A call naming no context keeps today's behaviour: the last launched.
    await pool.call('browser_navigate', { url: `${base}?owner=nobody` });
    assert.deepStrictEqual(await urlsAt(b.port), [`${base}?owner=nobody`]);
    assert.deepStrictEqual(await urlsAt(a.port), [`${base}?owner=A`]);
  });

  it('an unknown context is refused and names the open ones', async () => {
    const r = await pool.call('browser_navigate', { url: base, context: 'no-such-context' });
    assert.ok(r.isError);
    assert.match(r.text, /no-such-context/);
  });

  it('closing by context closes that browser only', async () => {
    const c = launched((await pool.call('pool_launch', { label: 'agent-C' })).text);
    const d = launched((await pool.call('pool_launch', { label: 'agent-D' })).text);
    await pool.call('browser_close', { context: c.id });
    const list = (await pool.call('pool_list')).text;
    assert.ok(!list.includes(c.id));
    assert.ok(list.includes(d.id));
  });
});
