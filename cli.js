#!/usr/bin/env node

// playwright-pool CLI — thin router dispatching to command modules
//
// Setup (inline):  init, login, config, status, clean
// Browser:         browser launch/navigate/click/type/... → ./cli-commands/browser.js
// Quick:           screenshot, snap, eval, pdf            → ./cli-commands/quick.js
// Workflow:        workflow audit-page/compare/monitor     → ./cli-commands/workflow.js
// Audit:           audit <url>, audit list, audit diff     → ./cli-commands/audit.js
// Inspect:         console, network, run, wait, verify, locator → ./cli-commands/inspect.js
// Mouse:           mouse move/click/drag                  → ./cli-commands/mouse.js
// Trace:           trace start/stop                       → ./cli-commands/trace.js
// Benchmark:       benchmark                              → ./cli-commands/benchmark.js
// Accuracy:        accuracy                               → ./cli-commands/accuracy.js
// Compare:         compare                                → ./scripts/competitor-benchmark.js
// Install:         install (inline — npx playwright install chromium)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { spawn } from 'node:child_process';
import { resolveProfile, listProfiles, profileAccounts } from './lib/profiles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const POOL_BASE = path.join(HOME, '.playwright-pool');
const GOLDEN_PROFILE = path.join(POOL_BASE, 'golden-profile');
const POOL_CONTEXTS = path.join(POOL_BASE, 'pool-contexts');

// ─── Argument Parsing ─────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

// Global flags
if (args.includes('--version') || args.includes('-V')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

switch (command) {
  // ── Setup commands (inline implementations) ─────────────────────
  case 'init':
    await cmdInit();
    break;
  case 'login': {
    const pIdx = args.indexOf('--profile');
    const profileName = pIdx !== -1 ? args[pIdx + 1] : 'default';
    // first positional (not the command, not the --profile value, not a flag)
    const url = args.find((a, i) => i > 0 && !a.startsWith('--') && i !== pIdx + 1);
    await cmdLogin(url, profileName);
    break;
  }
  case 'profiles':
    cmdProfiles();
    break;
  case 'config':
    cmdConfig();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'clean':
    await cmdClean();
    break;

  // ── Browser commands (persistent browser context) ───────────────
  case 'browser': {
    const { handleBrowser } = await import('./cli-commands/browser.js');
    await handleBrowser(args.slice(1));
    break;
  }

  // ── Quick operations (standalone — launch, do, close) ───────────
  case 'screenshot':
  case 'snap':
  case 'eval':
  case 'pdf': {
    const { handleQuick } = await import('./cli-commands/quick.js');
    await handleQuick(command, args.slice(1));
    break;
  }

  // ── Inspect (standalone — interact + analyze in one command) ────
  case 'inspect': {
    const { handleInspectWorkflow } = await import('./cli-commands/workflow.js');
    await handleInspectWorkflow(args.slice(1));
    break;
  }

  // ── Workflow (standalone — batched multi-step operations) ───────
  case 'workflow': {
    const { handleWorkflow } = await import('./cli-commands/workflow.js');
    await handleWorkflow(args.slice(1));
    break;
  }

  // ── Audit (standalone — full audit suite) ───────────────────────
  case 'audit': {
    const { handleAudit } = await import('./cli-commands/audit.js');
    await handleAudit(args.slice(1));
    break;
  }

  // ── Accuracy (standalone — audit accuracy scoring) ────────────
  case 'accuracy': {
    const { handleAccuracy } = await import('./cli-commands/accuracy.js');
    await handleAccuracy(args.slice(1));
    break;
  }

  // ── Inspection commands (persistent browser context) ────────────
  case 'console':
  case 'network':
  case 'run':
  case 'wait':
  case 'verify':
  case 'locator': {
    const { handleInspect } = await import('./cli-commands/inspect.js');
    await handleInspect(command, args.slice(1));
    break;
  }

  // ── Mouse commands (persistent browser context) ─────────────────
  case 'mouse': {
    const { handleMouse } = await import('./cli-commands/mouse.js');
    await handleMouse(args.slice(1));
    break;
  }

  // ── Trace commands (persistent browser context) ─────────────────
  case 'trace': {
    const { handleTrace } = await import('./cli-commands/trace.js');
    await handleTrace(args.slice(1));
    break;
  }

  // ── Benchmark (standalone — performance matrix) ────────────────
  case 'benchmark': {
    const { handleBenchmark } = await import('./cli-commands/benchmark.js');
    await handleBenchmark(args.slice(1));
    break;
  }

  // ── Compare (standalone — competitor benchmark) ────────────────
  case 'compare': {
    const { execSync: execSyncCompare } = await import('child_process');
    const comparePath = path.join(__dirname, 'scripts', 'competitor-benchmark.js');
    try {
      execSyncCompare(`node "${comparePath}"`, { stdio: 'inherit', cwd: __dirname });
    } catch (e) {
      process.exit(e.status || 1);
    }
    break;
  }

  // ── Install Chromium ────────────────────────────────────────────
  case 'install': {
    const { execSync } = await import('child_process');
    console.log('Installing Chromium...');
    execSync('npx playwright install chromium', { stdio: 'inherit' });
    console.log('Chromium installed.');
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

// ─── Help ─────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
playwright-pool CLI

Usage:
  playwright-pool <command> [options]

Global Flags:
  --version, -V     Show version number
  --help, -h        Show this help message

Setup:
  init                          Create ~/.playwright-pool/ directory structure
  login [url] [--profile NAME]  Open a RAW browser (no automation) to create/refresh a
                                profile snapshot (default profile: "default")
  profiles                      List credential profiles and their accounts
  config                        Output .mcp.json snippet for Claude Code
  status                        Show pool directories and profile info
  clean                         Remove orphaned pool-context directories
  install                       Install Chromium for Playwright

Browser (persistent session):
  browser launch    Launch a persistent browser session
  browser navigate  Navigate to a URL
  browser click     Click an element
  browser type      Type text into an element
  browser key       Press a keyboard key
  browser fill      Fill a form field
  browser select    Select a dropdown option
  browser hover     Hover over an element
  browser drag      Drag an element
  browser upload    Upload a file
  browser dialog    Handle a dialog
  browser resize    Resize the viewport
  browser tabs      List open tabs
  browser back      Navigate back
  browser list      List browser sessions
  browser switch    Switch to a browser session
  browser close     Close browser session(s)

Quick Operations (standalone):
  screenshot <url>  Take a screenshot (--full-page, --mobile, --breakpoints)
  snap <url>        Get accessibility snapshot (--interactive)
  eval <url> <expr> Evaluate JavaScript expression
  pdf <url>         Save page as PDF

Workflow (standalone — batched multi-step):
  workflow audit-page <url>       Navigate, screenshot × 3, audit × 6 in one process
  workflow compare <a> <b>        Compare two URLs side-by-side at 3 breakpoints
  workflow monitor <url>          Audit and compare against a baseline

Audit (standalone):
  audit <url>       Run audit suite (--only, --skip, --category, --json)
  audit list        List all available audits
  audit diff <a> <b> Pixel-diff two screenshots

Inspection (persistent session):
  console           Show console messages (--level)
  network           Show network requests (--filter)
  run <code>        Run code against the active page
  wait <condition>  Wait for text, selector, or timeout
  verify <check>    Verify text, element, list, or value
  locator <query>   Generate a Playwright locator

Mouse (persistent session):
  mouse move <x> <y>         Move mouse to coordinates
  mouse click <x> <y>        Click at coordinates
  mouse drag <x1> <y1> <x2> <y2>  Drag between coordinates

Trace (persistent session):
  trace start       Start recording a trace
  trace stop [file] Stop and save trace

Benchmark (standalone):
  benchmark              Run performance benchmark matrix (--quick, --site, --operation, --runs, --warmup)
  benchmark compare <a> <b>  Compare two benchmark JSON files (Welch's t-test regression detection)

Accuracy (standalone):
  accuracy               Score audit accuracy against test fixtures (--page, --verbose, --json)
  accuracy --url <url>   Run audits against a real URL (report only, no scoring)

Competitor Comparison:
  compare                Run competitor benchmark (playwright-pool vs Lighthouse vs Pa11y vs axe-core)

Examples:
  playwright-pool init
  playwright-pool login
  playwright-pool screenshot https://example.com --mobile
  playwright-pool audit https://example.com --only meta,accessibility
  playwright-pool browser launch
  playwright-pool browser navigate https://example.com
`);
}

// ─── init ─────────────────────────────────────────────────────────

async function cmdInit() {
  const dirs = [POOL_BASE, GOLDEN_PROFILE, POOL_CONTEXTS];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`  Created: ${dir}`);
    } else {
      console.log(`  Exists:  ${dir}`);
    }
  }

  console.log();
  console.log('Run `playwright-pool login` to set up your golden profile.');
}

// ─── login ────────────────────────────────────────────────────────

async function cmdLogin(url, profileName = 'default') {
  const targetUrl = url || 'https://accounts.google.com';
  const prof = resolveProfile(profileName);
  fs.mkdirSync(prof.path, { recursive: true });

  // RAW spawn of the browser executable — NO automation, NO CDP, NO Playwright control.
  // This is the durability fix: Google does not flag a human-driven browser the way it
  // flags an automation-controlled one. LOGIN_ENGINE lets Task 6 pin the engine so the
  // pool's read engine can decrypt the snapshot (Local State key compatibility).
  const { chromium } = await import('playwright');
  const exe = process.env.LOGIN_ENGINE || chromium.executablePath();

  console.log(`Raw login (NO automation) — profile "${prof.name}"`);
  console.log(`  Browser: ${exe}`);
  console.log(`  Profile: ${prof.path}`);
  console.log(`  URL:     ${targetUrl}`);
  console.log();
  console.log('Log in — add multiple Google accounts if you want; all are captured.');
  console.log('Close the browser window when done.');
  console.log();

  const child = spawn(exe, [
    `--user-data-dir=${prof.path}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    targetUrl,
  ], { stdio: 'ignore', detached: false });

  await new Promise((resolve) => child.on('exit', resolve));
  writeActivationLog(prof);
  console.log(`Profile "${prof.name}" snapshot saved. Credentials are ready.`);
}

function writeActivationLog(prof) {
  const md =
    `# Profile activation — ${prof.name}\n\n` +
    `- Path: ${prof.path}\n` +
    `- Engine: raw spawn (no automation, no CDP)\n` +
    `- NOT recorded: no passwords, cookies, tokens, or secrets were read or logged.\n`;
  try { fs.writeFileSync(path.join(prof.path, 'activation.md'), md); } catch {}
}

// ─── profiles ─────────────────────────────────────────────────────

function cmdProfiles() {
  const list = listProfiles();
  if (!list.length) {
    console.log('No profiles yet. Run: playwright-pool login --profile default');
    return;
  }
  console.log('Credential profiles:');
  for (const p of list) {
    const accts = p.hasDefault ? profileAccounts(p.path) : [];
    const state = p.hasDefault
      ? (accts.length ? accts.join(', ') : 'ready (no account hint)')
      : 'EMPTY — run login';
    console.log(`  ${p.name.padEnd(16)} ${state}`);
  }
}

// ─── config ───────────────────────────────────────────────────────

function cmdConfig() {
  const serverPath = path.join(__dirname, 'server.js');
  const goldenPath = GOLDEN_PROFILE;

  const profilesPath = path.join(POOL_BASE, 'profiles');

  // Unix-style paths
  const unixServer = serverPath.replace(/\\/g, '/');
  const unixGolden = goldenPath.replace(/\\/g, '/');
  const unixProfiles = profilesPath.replace(/\\/g, '/');

  // Windows-style paths (with escaped backslashes for JSON)
  const winServer = serverPath.replace(/\//g, '\\');
  const winGolden = goldenPath.replace(/\//g, '\\');
  const winProfiles = profilesPath.replace(/\//g, '\\');

  console.log('Add this to your .mcp.json (or Claude Code MCP config):');
  console.log();
  console.log('--- Unix / macOS / Linux ---');
  console.log(JSON.stringify({
    mcpServers: {
      'playwright-pool': {
        command: 'node',
        args: [unixServer],
        env: {
          GOLDEN_PROFILE: unixGolden,
          PROFILES_DIR: unixProfiles,
        },
      },
    },
  }, null, 2));

  console.log();
  console.log('--- Windows ---');
  console.log(JSON.stringify({
    mcpServers: {
      'playwright-pool': {
        command: 'node',
        args: [winServer],
        env: {
          GOLDEN_PROFILE: winGolden,
          PROFILES_DIR: winProfiles,
        },
      },
    },
  }, null, 2));
}

// ─── status ───────────────────────────────────────────────────────

function cmdStatus() {
  console.log('playwright-pool status');
  console.log('='.repeat(40));
  console.log();

  // Credential profiles
  const profs = listProfiles();
  console.log('Credential profiles:');
  if (!profs.length) {
    console.log('  NONE — run `playwright-pool login --profile default`');
  } else {
    for (const p of profs) {
      const accts = p.hasDefault ? profileAccounts(p.path) : [];
      const state = !p.exists
        ? 'NOT FOUND — run login'
        : !p.hasDefault
          ? 'EXISTS but no snapshot — run login'
          : `READY${accts.length ? ` — ${accts.join(', ')}` : ''}`;
      console.log(`  ${p.name.padEnd(16)} ${state}`);
      console.log(`  ${' '.repeat(16)} ${p.path}`);
    }
  }
  console.log();

  // Pool contexts
  console.log(`Pool contexts: ${POOL_CONTEXTS}`);
  if (!fs.existsSync(POOL_CONTEXTS)) {
    console.log('  Status: NOT FOUND — run `playwright-pool init`');
  } else {
    const entries = fs.readdirSync(POOL_CONTEXTS, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    if (entries.length === 0) {
      console.log('  No active sessions.');
    } else {
      console.log(`  ${entries.length} session director${entries.length === 1 ? 'y' : 'ies'}:`);
      for (const entry of entries) {
        const fullPath = path.join(POOL_CONTEXTS, entry.name);
        const stat = fs.statSync(fullPath);
        const age = Date.now() - stat.mtimeMs;
        const ageStr = formatAge(age);
        const isTemplate = entry.name.includes('-template');
        const isTabs = entry.name.includes('-tabs');
        const label = isTemplate ? ' (template)' : isTabs ? ' (tabs)' : '';
        console.log(`    ${entry.name}${label} — last modified ${ageStr} ago`);
      }
    }
  }
}

function formatAge(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ─── clean ────────────────────────────────────────────────────────

async function cmdClean() {
  if (!fs.existsSync(POOL_CONTEXTS)) {
    console.log('No pool-contexts directory found. Nothing to clean.');
    return;
  }

  const entries = fs.readdirSync(POOL_CONTEXTS, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  if (entries.length === 0) {
    console.log('No session directories found. Nothing to clean.');
    return;
  }

  console.log(`Found ${entries.length} session director${entries.length === 1 ? 'y' : 'ies'}:`);
  for (const entry of entries) {
    const fullPath = path.join(POOL_CONTEXTS, entry.name);
    const stat = fs.statSync(fullPath);
    const age = Date.now() - stat.mtimeMs;
    console.log(`  ${entry.name} — last modified ${formatAge(age)} ago`);
  }

  console.log();
  const confirmed = await confirm('Remove all these directories? (y/N) ');

  if (confirmed) {
    for (const entry of entries) {
      const fullPath = path.join(POOL_CONTEXTS, entry.name);
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`  Removed: ${entry.name}`);
    }
    console.log('Done.');
  } else {
    console.log('Cancelled.');
  }
}

function confirm(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

