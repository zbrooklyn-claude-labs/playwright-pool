#!/usr/bin/env node

// playwright-pool v3 — Pool management layer on top of @playwright/mcp
//
// Uses the official Playwright MCP server's internal modules (BrowserServerBackend,
// tools, config) to expose all 35 official browser tools, while adding pool management
// (pool_launch, pool_close, pool_list) with golden profile auth overlay and
// UUID session isolation.

import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { chromium, devices } from 'playwright';
import { createRequire } from 'module';
import { getSchemas as getAuditBSchemas, handleAuditTool as handleAuditToolB, isAuditToolB } from './audit-tools-b.js';
import { AUDIT_HANDLERS } from './cli-commands/audit.js';
import { resolveProfile, profileAccounts } from './lib/profiles.js';
import { planSweep, sweepLeftovers, writeOwner } from './lib/sweep.js';

// --- Resolve internal Playwright MCP modules ---
// playwright/lib/mcp is not exported in package.json, so we resolve the
// physical path from the playwright package root.
const require_ = createRequire(import.meta.url);
const pwDir = path.dirname(require_.resolve('playwright'));
const mcpDir = path.join(pwDir, 'lib', 'mcp');

const { BrowserServerBackend } = require_(path.join(mcpDir, 'browser', 'browserServerBackend.js'));
const { resolveConfig } = require_(path.join(mcpDir, 'browser', 'config.js'));
const { filteredTools } = require_(path.join(mcpDir, 'browser', 'tools.js'));
const { toMcpTool } = require_(path.join(mcpDir, 'sdk', 'tool.js'));
const { createServer } = require_(path.join(mcpDir, 'sdk', 'server.js'));
const mcpBundle = require_('playwright-core/lib/mcpBundle');

// --- Configuration ---
const HOME = os.homedir();
const GOLDEN_PROFILE = process.env.GOLDEN_PROFILE || path.join(HOME, '.playwright-pool', 'golden-profile');
const POOL_DIR = process.env.POOL_DIR || path.join(HOME, '.playwright-pool', 'pool-contexts');

// Unique session ID — ensures no conflicts between concurrent sessions
const SESSION_ID = crypto.randomUUID().slice(0, 8);

// POOL_HEADLESS=1 launches every browser hidden: for tests and proofs, never for real use
// (Google refuses sign-in to hidden browsers).
const HEADLESS = process.env.POOL_HEADLESS === '1';

// --- Logging ---
function log(msg) {
  process.stderr.write(`[pool:${SESSION_ID}] ${msg}\n`);
}

// --- Pool State ---
const poolEntries = new Map(); // id -> { backend, contextDir, mode, label, browserContext, tabIndex }
let activeId = null;
let tabContext = null; // Shared BrowserContext for tab mode
let tabContextDir = null;
let tabBackend = null; // Single backend for all tab-mode entries
let tabCdpPort = null; // Debug port of the shared tab window
let nextId = 1;

// Several callers share one server (a chat and its agents). A call may name the context it means
// (`context` on any tool but pool_launch/pool_list); the call then runs against that context, carried
// through to every handler by callTarget. A call naming none uses the active context, as before.
const callTarget = new AsyncLocalStorage();
const currentId = () => callTarget.getStore() ?? activeId;
const UNTARGETED = new Set(['pool_launch', 'pool_list']);

// --- Auth overlay constants ---
const AUTH_FILES = [
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Login Data For Account',
  'Default/Login Data For Account-journal',
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/Web Data',
  'Default/Web Data-journal',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Local State',
];

const LOCK_FILES = new Set([
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'LOCK',
]);

// --- Template profiles (one per named profile, created once per session) ---
const templateDirs = new Map(); // profileName -> template dir

function ensurePoolDir() {
  if (!fs.existsSync(POOL_DIR)) {
    fs.mkdirSync(POOL_DIR, { recursive: true });
  }
}

// Build (or reuse) a template profile for the given named profile, overlaying its
// auth snapshot. Returns the resolved { name, path }.
async function ensureTemplate(profileName = 'default') {
  const prof = resolveProfile(profileName);

  if (templateDirs.has(prof.name) && fs.existsSync(templateDirs.get(prof.name))) {
    return prof;
  }

  if (!fs.existsSync(path.join(prof.path, 'Default'))) {
    throw new Error(
      `Profile "${prof.name}" has no snapshot at: ${prof.path}\n` +
      `Run: playwright-pool login --profile ${prof.name}`
    );
  }

  const dir = path.join(POOL_DIR, `${SESSION_ID}-${prof.name}-template`);
  ensurePoolDir();

  // Create a fresh Chromium profile once (the only headless launch per profile)
  log(`Creating template profile for "${prof.name}" (one-time)...`);
  const tempCtx = await chromium.launchPersistentContext(dir, { headless: true });
  await tempCtx.close();

  // Overlay auth files from the resolved profile snapshot
  for (const f of AUTH_FILES) {
    const src = path.join(prof.path, f);
    const dst = path.join(dir, f);
    if (fs.existsSync(src)) {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true, force: true });
      } else {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }
  templateDirs.set(prof.name, dir);
  log(`Template ready for "${prof.name}".`);
  return prof;
}

function createAuthProfile(destDir, profileName = 'default') {
  const templateDir = templateDirs.get(profileName);
  log(`Copying "${profileName}" template to ${path.basename(destDir)}...`);
  fs.cpSync(templateDir, destDir, {
    recursive: true,
    filter: (src) => !LOCK_FILES.has(path.basename(src)),
  });
  log('Profile ready.');
}

// Write-back: the exact inverse of the overlay in ensureTemplate().
//
// Contexts are throwaway copies and cleanupEntry() rmSync's them on close, so any login
// performed inside a context is DESTROYED unless it is saved back to its named profile
// first. This is that save. Call it only after the browser context has been closed —
// Chromium buffers cookies and local storage and only guarantees a flush to disk on close.
//
// Never overwrites blind: whatever is already in the profile is copied to a timestamped
// .bak- directory inside it before being replaced.
function saveAuthProfile(contextDir, prof) {
  const written = [];
  const absent = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(prof.path, `.bak-${stamp}`);
  let backedUp = false;

  fs.mkdirSync(prof.path, { recursive: true });

  for (const f of AUTH_FILES) {
    const src = path.join(contextDir, f);
    const dst = path.join(prof.path, f);

    if (!fs.existsSync(src)) { absent.push(f); continue; }

    if (fs.existsSync(dst)) {
      const bak = path.join(backupDir, f);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      if (fs.statSync(dst).isDirectory()) fs.cpSync(dst, bak, { recursive: true });
      else fs.copyFileSync(dst, bak);
      backedUp = true;
    }

    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dst);
    }
    written.push(f);
  }

  return { written, absent, backupDir: backedUp ? backupDir : null };
}

// --- Find a free port for CDP ---
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// --- Create a BrowserServerBackend for a given BrowserContext ---
// The backend gets its own Context (Playwright MCP's internal Context class),
// which manages tabs, snapshots, etc. We provide a custom context factory
// that returns our pre-created, auth-overlaid BrowserContext.
async function createBackendForContext(browserContext) {
  const config = await resolveConfig({
    browser: {
      browserName: 'chromium',
      launchOptions: {
        headless: false,
      },
      contextOptions: {
        viewport: null,
      },
    },
    capabilities: ['core-install', 'core-tabs', 'internal', 'pdf', 'testing', 'tracing', 'vision'],
    allowUnrestrictedFileAccess: true,
    // Optimize MCP response size for token efficiency:
    // - incremental snapshots show only changes (not full tree every time)
    // - codegen: 'none' removes "Ran Playwright code" section from responses
    snapshot: { mode: 'incremental' },
    codegen: 'none',
  });

  const factory = {
    name: 'pool',
    description: 'Pool-managed browser context',
    async createContext() {
      return {
        browserContext,
        close: async () => {
          // Pool manages lifecycle — don't close on backend disposal
        },
      };
    },
  };

  const backend = new BrowserServerBackend(config, factory);
  return backend;
}

// --- Pool management tool definitions ---
// These follow the same shape as official Playwright MCP tools so the
// composite backend can list them alongside browser tools.

const poolToolSchemas = [
  {
    name: 'pool_launch',
    title: 'Launch browser',
    description:
      'Launch a new authenticated browser context. Mode "window" opens a separate browser window (isolated cookies/sessions). Mode "tab" opens a tab in a shared window (shared cookies). Returns a context ID and automatically makes it the active context for all browser_* tools.',
    inputSchema: mcpBundle.z.object({
      mode: mcpBundle.z.enum(['window', 'tab']).default('window').describe('"window" = separate browser (isolated), "tab" = new tab in shared window'),
      width: mcpBundle.z.number().optional().describe('Viewport width (default: 1280)'),
      height: mcpBundle.z.number().optional().describe('Viewport height (default: 800)'),
      label: mcpBundle.z.string().optional().describe('Optional label (e.g., "stripe", "cloudflare")'),
      device: mcpBundle.z.string().optional().describe('Device preset for emulation (e.g., "iPhone 14", "Pixel 7", "iPad Pro 11"). Sets viewport, userAgent, deviceScaleFactor, isMobile, hasTouch. Overrides width/height. Window mode only.'),
      profileName: mcpBundle.z.string().optional().describe('Named credential profile to load (default: "default"). E.g. "business-A". Each profile is an isolated set of logins.'),
    }),
    type: 'input',
  },
  {
    name: 'pool_close',
    title: 'Close browser',
    description: 'Close a browser context by ID, or pass "all" to close everything in this session.',
    inputSchema: mcpBundle.z.object({
      id: mcpBundle.z.string().describe('Context ID to close, or "all"'),
    }),
    type: 'input',
  },
  {
    name: 'pool_list',
    title: 'List browsers',
    description: 'List all active browser contexts in this session, showing which one is active.',
    inputSchema: mcpBundle.z.object({}),
    type: 'readOnly',
  },
  {
    name: 'pool_switch',
    title: 'Switch browser',
    description: 'Switch the active browser context. All browser_* tools will operate on this context. For switching between tabs in the same window, use browser_tabs instead.',
    inputSchema: mcpBundle.z.object({
      id: mcpBundle.z.string().describe('Context ID to make active'),
    }),
    type: 'input',
  },
  {
    name: 'pool_save_profile',
    title: 'Save login to profile',
    description:
      'Persist the logins in a browser context back to a named profile so they survive this session. ' +
      'Contexts are throwaway copies and are DELETED on close, so a sign-in performed in a context is lost ' +
      'unless saved with this tool. Run it immediately after completing a login, while the context is still open. ' +
      'The context is closed as part of saving — Chromium only guarantees cookies and local storage are flushed ' +
      'to disk on close. The profile\'s previous contents are backed up to a timestamped .bak- folder inside it, ' +
      'never overwritten blind. Window-mode contexts only.',
    inputSchema: mcpBundle.z.object({
      profileName: mcpBundle.z.string().describe('Profile to write the logins into, e.g. "chatgpt". Created if absent.'),
      id: mcpBundle.z.string().optional().describe('Context ID to save (default: the active context)'),
    }),
    type: 'input',
  },
];

// --- Phase 5: UI Audit tool definitions ---
const auditToolSchemas = [
  {
    name: 'audit_accessibility',
    title: 'Accessibility audit',
    description:
      'Run an accessibility audit on the current page. Injects axe-core logic inline (no CDN) and returns WCAG violations grouped by severity.',
    inputSchema: mcpBundle.z.object({
      standard: mcpBundle.z.enum(['WCAG2A', 'WCAG2AA', 'WCAG2AAA']).default('WCAG2AA').describe('WCAG standard level'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_color_contrast',
    title: 'Color contrast audit',
    description:
      'Evaluate color contrast ratios for all visible text elements on the page using the WCAG luminance formula. Flags elements that fail the specified level.',
    inputSchema: mcpBundle.z.object({
      level: mcpBundle.z.enum(['AA', 'AAA']).default('AA').describe('WCAG contrast level (AA: 4.5:1 normal, 3:1 large; AAA: 7:1 normal, 4.5:1 large)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_breakpoints',
    title: 'Breakpoint screenshots',
    description:
      'Resize viewport to multiple breakpoints and take a screenshot at each. Returns screenshots for visual comparison across device sizes.',
    inputSchema: mcpBundle.z.object({
      url: mcpBundle.z.string().optional().describe('URL to navigate to before screenshotting (uses current page if omitted)'),
      breakpoints: mcpBundle.z.array(mcpBundle.z.object({
        label: mcpBundle.z.string(),
        width: mcpBundle.z.number(),
        height: mcpBundle.z.number(),
      })).optional().describe('Custom breakpoints array [{label, width, height}]. Defaults to desktop/tablet/mobile.'),
      savePath: mcpBundle.z.string().optional().describe('Directory to save screenshots to disk (optional)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_tap_targets',
    title: 'Tap target audit',
    description:
      'Find all interactive elements (buttons, links, inputs) and measure their bounding boxes. Flags any element smaller than the minimum touch target size.',
    inputSchema: mcpBundle.z.object({
      minSize: mcpBundle.z.number().default(48).describe('Minimum tap target size in px (default 48, per WCAG 2.5.8)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_core_web_vitals',
    title: 'Core Web Vitals',
    description:
      'Measure Core Web Vitals (LCP, CLS) using the PerformanceObserver API. Optionally navigates to a URL first and waits for metrics to stabilize.',
    inputSchema: mcpBundle.z.object({
      url: mcpBundle.z.string().optional().describe('URL to navigate to and measure (uses current page if omitted)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_image_sizes',
    title: 'Image audit',
    description:
      'Audit all <img> elements on the page: missing alt text, oversized images (naturalWidth >> rendered), broken src, missing lazy loading.',
    inputSchema: mcpBundle.z.object({}),
    type: 'readOnly',
  },
  {
    name: 'audit_fonts',
    title: 'Font audit',
    description:
      'Catalog all unique font-family, font-size, font-weight, and line-height combinations used on the page. Helps detect font inconsistencies.',
    inputSchema: mcpBundle.z.object({}),
    type: 'readOnly',
  },
  {
    name: 'audit_computed_styles',
    title: 'Computed styles',
    description:
      'Get the computed CSS properties for a specific element. Optionally filter to specific properties.',
    inputSchema: mcpBundle.z.object({
      selector: mcpBundle.z.string().describe('CSS selector for the target element'),
      properties: mcpBundle.z.array(mcpBundle.z.string()).optional().describe('List of CSS property names to return (returns all if omitted)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_overflow',
    title: 'Overflow detection',
    description:
      'Detect horizontal overflow at the current viewport or multiple breakpoints. Finds elements wider than the viewport that cause horizontal scrollbars.',
    inputSchema: mcpBundle.z.object({
      breakpoints: mcpBundle.z.array(mcpBundle.z.object({
        label: mcpBundle.z.string(),
        width: mcpBundle.z.number(),
        height: mcpBundle.z.number(),
      })).optional().describe('Breakpoints to test. If omitted, tests current viewport only.'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_dark_mode',
    title: 'Dark mode comparison',
    description:
      'Emulate prefers-color-scheme for both light and dark modes, taking a screenshot of each for visual comparison.',
    inputSchema: mcpBundle.z.object({
      savePath: mcpBundle.z.string().optional().describe('Directory to save screenshots to disk (optional)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'audit_meta',
    title: 'SEO metadata audit',
    description:
      'Extract and validate SEO metadata: title, description, Open Graph tags, heading hierarchy, canonical URL, robots, viewport meta.',
    inputSchema: mcpBundle.z.object({}),
    type: 'readOnly',
  },
  {
    name: 'audit_visual',
    title: 'Comprehensive visual audit',
    description:
      'Run a comprehensive programmatic UI audit in a single pass: layout overflow, element overlaps, spacing consistency, color contrast, typography, tap targets, images, accessibility, SEO meta, focus order, z-index stacking, and dark mode. Returns a structured text report organized by category with severity-rated issues.',
    inputSchema: mcpBundle.z.object({
      url: mcpBundle.z.string().optional().describe('URL to navigate to before auditing (uses current page if omitted)'),
    }),
    type: 'readOnly',
  },
];

// --- Utility tool definitions ---
const utilityToolSchemas = [
  {
    name: 'snapshot_compact',
    title: 'Compact interactive snapshot',
    description:
      'Get a compact snapshot of only interactive elements (buttons, links, inputs, selects). Uses ~90% fewer tokens than browser_snapshot. Best for when you need to click, type, or interact with the page.',
    inputSchema: mcpBundle.z.object({
      selector: mcpBundle.z.string().optional().describe('CSS selector to scope the snapshot (optional, defaults to full page)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'workflow_audit_page',
    title: 'Complete page audit workflow',
    description:
      'Complete page audit workflow in one call: navigate, click through steps, screenshot at 3 breakpoints, run 6 audits. Returns compact summary. Much faster than individual tool calls.',
    inputSchema: mcpBundle.z.object({
      url: mcpBundle.z.string().describe('URL to audit'),
      clicks: mcpBundle.z.array(mcpBundle.z.string()).optional().describe('Sequence of elements to click before auditing (text or CSS selectors)'),
      breakpoints: mcpBundle.z.array(mcpBundle.z.object({
        width: mcpBundle.z.number(),
        height: mcpBundle.z.number(),
        label: mcpBundle.z.string(),
      })).optional().describe('Breakpoints to screenshot at (default: desktop 1280x800, tablet 768x1024, mobile 375x812)'),
      audits: mcpBundle.z.array(mcpBundle.z.string()).optional().describe('Audit types to run (default: meta, accessibility, contrast, overflow, tap_targets, images)'),
      savePath: mcpBundle.z.string().optional().describe('Directory to save screenshots and report'),
    }),
    type: 'readOnly',
  },
  {
    name: 'workflow_inspect',
    title: 'Intent-driven page inspection',
    description:
      'Intent-driven page inspection: screenshots at breakpoints, single-pass DOM collection, runs relevant analyzers based on intent, returns formatted report. Uses the active pool page.',
    inputSchema: mcpBundle.z.object({
      url: mcpBundle.z.string().describe('URL to inspect (navigates the active page)'),
      steps: mcpBundle.z.array(mcpBundle.z.string()).optional().describe('Interaction steps before inspecting (e.g., ["click \'Blog\'", "wait 2"])'),
      intent: mcpBundle.z.string().optional().describe('Natural language intent for analysis (e.g., "does this look right?", "check mobile", "check seo")'),
      detail: mcpBundle.z.enum(['quick', 'standard', 'deep']).optional().describe('Report detail level (default: standard)'),
      breakpoints: mcpBundle.z.array(mcpBundle.z.object({
        width: mcpBundle.z.number(),
        height: mcpBundle.z.number(),
        label: mcpBundle.z.string(),
      })).optional().describe('Breakpoints to screenshot at (default: desktop 1280x800, tablet 768x1024, mobile 375x812)'),
      savePath: mcpBundle.z.string().optional().describe('Directory to save screenshots and report'),
    }),
    type: 'readOnly',
  },
];

// --- Custom browser tool definitions (not in upstream @playwright/mcp) ---
const customToolSchemas = [
  {
    name: 'browser_cookies_get',
    title: 'Get cookies',
    description:
      'Get browser cookies for the current page or a specific URL. Returns name, value, domain, path, expires, httpOnly, secure, sameSite for each cookie.',
    inputSchema: mcpBundle.z.object({
      urls: mcpBundle.z.array(mcpBundle.z.string()).optional().describe('URLs to get cookies for (defaults to current page URL)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'browser_cookies_set',
    title: 'Set cookie',
    description:
      'Set a browser cookie. Requires name and value at minimum. Domain defaults to the current page domain.',
    inputSchema: mcpBundle.z.object({
      name: mcpBundle.z.string().describe('Cookie name'),
      value: mcpBundle.z.string().describe('Cookie value'),
      url: mcpBundle.z.string().optional().describe('URL to associate the cookie with (defaults to current page URL)'),
      domain: mcpBundle.z.string().optional().describe('Cookie domain'),
      path: mcpBundle.z.string().optional().describe('Cookie path (default: /)'),
      expires: mcpBundle.z.number().optional().describe('Unix timestamp for expiration (-1 for session cookie)'),
      httpOnly: mcpBundle.z.boolean().optional().describe('HTTP-only flag'),
      secure: mcpBundle.z.boolean().optional().describe('Secure flag'),
      sameSite: mcpBundle.z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite attribute'),
    }),
    type: 'input',
  },
  {
    name: 'browser_cookies_clear',
    title: 'Clear cookies',
    description:
      'Clear all browser cookies, or only cookies matching a specific domain/name filter.',
    inputSchema: mcpBundle.z.object({
      name: mcpBundle.z.string().optional().describe('Only clear cookies with this name'),
      domain: mcpBundle.z.string().optional().describe('Only clear cookies for this domain'),
    }),
    type: 'input',
  },
  {
    name: 'browser_storage_get',
    title: 'Get storage',
    description:
      'Read localStorage or sessionStorage for the current page. Returns all key-value pairs, or a specific key.',
    inputSchema: mcpBundle.z.object({
      storageType: mcpBundle.z.enum(['localStorage', 'sessionStorage']).default('localStorage').describe('Which storage to read'),
      key: mcpBundle.z.string().optional().describe('Specific key to read (returns all if omitted)'),
    }),
    type: 'readOnly',
  },
  {
    name: 'browser_storage_set',
    title: 'Set storage',
    description:
      'Write a key-value pair to localStorage or sessionStorage for the current page.',
    inputSchema: mcpBundle.z.object({
      storageType: mcpBundle.z.enum(['localStorage', 'sessionStorage']).default('localStorage').describe('Which storage to write to'),
      key: mcpBundle.z.string().describe('Storage key'),
      value: mcpBundle.z.string().describe('Storage value'),
    }),
    type: 'input',
  },
  {
    name: 'browser_mouse_wheel',
    title: 'Mouse wheel scroll',
    description:
      'Dispatch a mouse wheel event to scroll the page or a specific element. Positive deltaY scrolls down, negative scrolls up. Positive deltaX scrolls right, negative scrolls left.',
    inputSchema: mcpBundle.z.object({
      deltaX: mcpBundle.z.number().default(0).describe('Horizontal scroll amount in pixels (positive = right)'),
      deltaY: mcpBundle.z.number().default(0).describe('Vertical scroll amount in pixels (positive = down, e.g., 500 to scroll down)'),
    }),
    type: 'input',
  },
];

// --- Custom tool handlers ---
async function handleCookiesGet(params) {
  const page = getActivePage();
  const context = page.context();
  const urls = params.urls || [page.url()];
  const cookies = await context.cookies(urls);
  if (cookies.length === 0) {
    return { content: [{ type: 'text', text: 'No cookies found.' }] };
  }
  const lines = cookies.map(c =>
    `${c.name}=${c.value} (domain=${c.domain}, path=${c.path}, expires=${c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString()}, httpOnly=${c.httpOnly}, secure=${c.secure}, sameSite=${c.sameSite})`
  );
  return { content: [{ type: 'text', text: `${cookies.length} cookie(s):\n${lines.join('\n')}` }] };
}

async function handleCookiesSet(params) {
  const page = getActivePage();
  const context = page.context();
  const cookie = {
    name: params.name,
    value: params.value,
    url: params.url || page.url(),
  };
  if (params.domain) cookie.domain = params.domain;
  if (params.path) cookie.path = params.path;
  if (params.expires !== undefined) cookie.expires = params.expires;
  if (params.httpOnly !== undefined) cookie.httpOnly = params.httpOnly;
  if (params.secure !== undefined) cookie.secure = params.secure;
  if (params.sameSite) cookie.sameSite = params.sameSite;
  await context.addCookies([cookie]);
  return { content: [{ type: 'text', text: `Cookie "${params.name}" set successfully.` }] };
}

async function handleCookiesClear(params) {
  const page = getActivePage();
  const context = page.context();
  if (!params.name && !params.domain) {
    await context.clearCookies();
    return { content: [{ type: 'text', text: 'All cookies cleared.' }] };
  }
  // Selective clear: get all cookies, filter, then clear and re-add the ones to keep
  const allCookies = await context.cookies();
  const toRemove = allCookies.filter(c => {
    if (params.name && c.name !== params.name) return false;
    if (params.domain && !c.domain.includes(params.domain)) return false;
    return true;
  });
  if (toRemove.length === 0) {
    return { content: [{ type: 'text', text: 'No matching cookies found.' }] };
  }
  const toKeep = allCookies.filter(c => !toRemove.includes(c));
  await context.clearCookies();
  if (toKeep.length > 0) {
    await context.addCookies(toKeep);
  }
  return { content: [{ type: 'text', text: `Cleared ${toRemove.length} cookie(s). ${toKeep.length} remaining.` }] };
}

async function handleStorageGet(params) {
  const page = getActivePage();
  const storageType = params.storageType || 'localStorage';
  if (params.key) {
    const value = await page.evaluate(([type, key]) => window[type].getItem(key), [storageType, params.key]);
    if (value === null) {
      return { content: [{ type: 'text', text: `${storageType}["${params.key}"] = null (not found)` }] };
    }
    return { content: [{ type: 'text', text: `${storageType}["${params.key}"] = ${value}` }] };
  }
  const entries = await page.evaluate((type) => {
    const result = {};
    for (let i = 0; i < window[type].length; i++) {
      const key = window[type].key(i);
      result[key] = window[type].getItem(key);
    }
    return result;
  }, storageType);
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { content: [{ type: 'text', text: `${storageType} is empty.` }] };
  }
  const lines = keys.map(k => `  ${k} = ${entries[k]}`);
  return { content: [{ type: 'text', text: `${storageType} (${keys.length} entries):\n${lines.join('\n')}` }] };
}

async function handleStorageSet(params) {
  const page = getActivePage();
  const storageType = params.storageType || 'localStorage';
  await page.evaluate(([type, key, value]) => window[type].setItem(key, value), [storageType, params.key, params.value]);
  return { content: [{ type: 'text', text: `${storageType}["${params.key}"] set successfully.` }] };
}

async function handleMouseWheel(params) {
  const page = getActivePage();
  const deltaX = params.deltaX || 0;
  const deltaY = params.deltaY || 0;
  await page.mouse.wheel(deltaX, deltaY);
  const direction = [];
  if (deltaY > 0) direction.push('down');
  else if (deltaY < 0) direction.push('up');
  if (deltaX > 0) direction.push('right');
  else if (deltaX < 0) direction.push('left');
  return { content: [{ type: 'text', text: `Scrolled ${direction.join(' and ')} (deltaX=${deltaX}, deltaY=${deltaY}).` }] };
}

// --- Audit tool helper: get active page ---
function getActivePage() {
  const id = currentId();
  if (!id || !poolEntries.has(id)) {
    throw new Error('No active browser context. Use pool_launch to create one first.');
  }
  const entry = poolEntries.get(id);
  const pages = entry.browserContext.pages();
  if (pages.length === 0) {
    throw new Error('No pages open in the active browser context.');
  }
  return pages[pages.length - 1];
}

// --- Delegate to audit.js (single source of truth) ---
async function delegateAudit(auditName, params) {
  const page = getActivePage();
  const result = await AUDIT_HANDLERS[auditName](page, null, params);
  return { content: [{ type: 'text', text: result.text }] };
}

// --- Audit tool handlers (delegated to audit.js) ---

async function handleAuditAccessibility(params) {
  return delegateAudit('accessibility', params);
}

async function handleAuditColorContrast(params) {
  return delegateAudit('color_contrast', params);
}

async function handleAuditBreakpoints(params) {
  return delegateAudit('breakpoints', params);
}

async function handleAuditTapTargets(params) {
  return delegateAudit('tap_targets', params);
}

async function handleAuditCoreWebVitals(params) {
  return delegateAudit('core_web_vitals', params);
}

async function handleAuditImageSizes(params) {
  return delegateAudit('image_sizes', params);
}

async function handleAuditFonts(params) {
  return delegateAudit('fonts', params);
}

async function handleAuditComputedStyles(params) {
  const page = getActivePage();
  const { selector, properties } = params;

  const results = await page.evaluate(({ sel, props }) => {
    const el = document.querySelector(sel);
    if (!el) return { error: `Element not found: ${sel}` };

    const style = window.getComputedStyle(el);
    const result = {};

    if (props && props.length > 0) {
      for (const prop of props) {
        result[prop] = style.getPropertyValue(prop);
      }
    } else {
      // Return all computed properties
      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        result[prop] = style.getPropertyValue(prop);
      }
    }

    return {
      selector: sel,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.className ? String(el.className).split(' ').filter(Boolean) : [],
      boundingBox: (() => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      })(),
      properties: result,
    };
  }, { sel: selector, props: properties || null });

  if (results.error) {
    return { content: [{ type: 'text', text: results.error }], isError: true };
  }

  const lines = [
    `Computed Styles`,
    `URL: ${await page.url()}`,
    `Selector: ${results.selector}`,
    `Element: <${results.tag}>${results.id ? '#' + results.id : ''} ${results.classes.length > 0 ? '.' + results.classes.join('.') : ''}`,
    `Bounding box: ${results.boundingBox.width}x${results.boundingBox.height} at (${results.boundingBox.x}, ${results.boundingBox.y})`,
    '',
    '--- PROPERTIES ---',
  ];

  const propEntries = Object.entries(results.properties);
  for (const [prop, val] of propEntries) {
    if (val) lines.push(`  ${prop}: ${val}`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleAuditOverflow(params) {
  return delegateAudit('overflow', params);
}

async function handleAuditDarkMode(params) {
  return delegateAudit('dark_mode', params);
}

async function handleAuditMeta(params) {
  return delegateAudit('meta', params);
}

async function handleAuditVisual(params) {
  const page = getActivePage();

  if (params.url) {
    await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(200);
  }

  // Import and run the visual audit from the CLI module
  const { runVisualAudit } = await import('./cli-commands/audit.js');
  const result = await runVisualAudit(page, null, {});

  return { content: [{ type: 'text', text: result.text }] };
}

// --- Utility tool handlers ---

async function handleSnapshotCompact(params) {
  const page = getActivePage();
  const scopeSelector = params.selector || 'body';

  const elements = await page.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return { error: `Selector "${scope}" not found` };

    // Interactive element selectors
    const SELECTORS = [
      'a[href]',
      'button', '[role="button"]',
      'input', 'textarea', 'select',
      '[tabindex]:not([tabindex="-1"])',
      '[onclick]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="combobox"]', '[role="listbox"]', '[role="slider"]',
      '[role="searchbox"]', '[role="spinbutton"]',
      '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    ];

    const selector = SELECTORS.join(', ');
    const nodes = root.querySelectorAll(selector);
    const seen = new Set();
    const results = [];

    for (const node of nodes) {
      // Deduplicate (an element can match multiple selectors)
      if (seen.has(node)) continue;
      seen.add(node);

      // Skip invisible elements
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') || '';
      const type = node.getAttribute('type') || '';
      const href = node.getAttribute('href') || '';
      const disabled = node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true';
      const ariaExpanded = node.getAttribute('aria-expanded');
      const ariaCurrent = node.getAttribute('aria-current');

      // Accessible name: aria-label > aria-labelledby > alt > title > placeholder > innerText
      let name = '';
      const ariaLabel = node.getAttribute('aria-label');
      const ariaLabelledBy = node.getAttribute('aria-labelledby');
      if (ariaLabel) {
        name = ariaLabel;
      } else if (ariaLabelledBy) {
        const labelEl = document.getElementById(ariaLabelledBy);
        if (labelEl) name = (labelEl.textContent || '').trim();
      } else if (node.getAttribute('alt')) {
        name = node.getAttribute('alt');
      } else if (node.getAttribute('title')) {
        name = node.getAttribute('title');
      } else if (node.getAttribute('placeholder')) {
        name = node.getAttribute('placeholder');
      } else {
        // For inputs, check associated label
        if (node.id) {
          const label = document.querySelector(`label[for="${node.id}"]`);
          if (label) name = (label.textContent || '').trim();
        }
        if (!name) {
          name = (node.textContent || '').trim().replace(/\s+/g, ' ');
        }
      }
      // Truncate long names
      if (name.length > 60) name = name.slice(0, 57) + '...';

      // Current value for inputs/selects/textareas
      let value = undefined;
      if (tag === 'input' || tag === 'textarea') {
        if (node.value !== undefined && node.value !== '') {
          value = node.value;
          if (value.length > 40) value = value.slice(0, 37) + '...';
        }
      }

      // Select options
      let options = undefined;
      let selectedOption = undefined;
      if (tag === 'select') {
        const opts = Array.from(node.options || []);
        selectedOption = node.options[node.selectedIndex]?.text || '';
        options = opts.slice(0, 5).map(o => o.text);
        if (opts.length > 5) options.push(`+${opts.length - 5} more`);
      }

      // Shortest unique selector (best effort)
      let cssSelector = '';
      if (node.id) {
        cssSelector = `#${node.id}`;
      } else {
        // tag + nth-of-type within parent
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}`));
          const idx = siblings.indexOf(node);
          cssSelector = tag + (siblings.length > 1 ? `:nth-of-type(${idx + 1})` : '');
        } else {
          cssSelector = tag;
        }
      }

      results.push({
        tag,
        role,
        type,
        name,
        href,
        disabled,
        expanded: ariaExpanded,
        active: ariaCurrent === 'page' || ariaCurrent === 'true',
        value,
        selectedOption,
        options,
        cssSelector,
      });
    }

    return { elements: results };
  }, scopeSelector);

  if (elements.error) {
    return { content: [{ type: 'text', text: `Error: ${elements.error}` }], isError: true };
  }

  // Format as compact flat list
  const items = elements.elements;
  const lines = [`Interactive Elements (${items.length} found):`];

  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    const ref = `@${i + 1}`;
    const parts = [ref.padEnd(5)];

    // Determine display type
    const tag = el.tag;
    const role = el.role;

    if (tag === 'a' || role === 'link') {
      // Link
      let shortHref = el.href;
      if (shortHref) {
        try {
          const url = new URL(shortHref, 'http://dummy');
          shortHref = url.pathname + (url.search || '');
          if (shortHref.length > 50) shortHref = shortHref.slice(0, 47) + '...';
        } catch {
          if (shortHref.length > 50) shortHref = shortHref.slice(0, 47) + '...';
        }
      }
      let line = `link "${el.name}"`;
      if (shortHref) line += ` \u2192 ${shortHref}`;
      if (el.active) line += ' [active]';
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (tag === 'button' || role === 'button') {
      // Button
      let line = `button "${el.name}"`;
      if (el.expanded === 'true' || el.expanded === 'false') line += ' \u25BE';
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (tag === 'input') {
      // Input
      const inputType = el.type || 'text';
      let line = `input[${inputType}] "${el.name}"`;
      if (el.value !== undefined) line += ` = "${el.value}"`;
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (tag === 'textarea') {
      let line = `textarea "${el.name}"`;
      if (el.value !== undefined) line += ` = "${el.value}"`;
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (tag === 'select') {
      let line = `select "${el.name}"`;
      if (el.selectedOption) line += ` = "${el.selectedOption}"`;
      if (el.options && el.options.length > 0) line += ` [options: ${el.options.join(', ')}]`;
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (role === 'tab') {
      let line = `tab "${el.name}"`;
      if (el.active) line += ' [active]';
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (role === 'checkbox') {
      let line = `checkbox "${el.name}"`;
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (role === 'radio') {
      let line = `radio "${el.name}"`;
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      let line = `menuitem "${el.name}"`;
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    } else {
      // Fallback — use role if available, else tag
      const label = role || tag;
      let line = `${label} "${el.name}"`;
      if (el.href) line += ` \u2192 ${el.href}`;
      if (el.disabled) line += ' [disabled]';
      parts.push(line);
    }

    lines.push('  ' + parts.join(' '));
  }

  const output = lines.join('\n');
  return { content: [{ type: 'text', text: output }] };
}

// --- Workflow tool handler (workflow_audit_page via MCP) ---

async function handleWorkflowAuditPage(params) {
  const { workflowAuditPage: runWorkflow, AUDIT_MAP, clickAndSettle } = await import('./cli-commands/workflow.js');

  // Use the active pool page if available, otherwise launch standalone
  let page, browser, standalone = false;
  if (currentId() && poolEntries.has(currentId())) {
    const entry = poolEntries.get(currentId());
    const ctx = entry.browserContext;
    if (ctx) {
      const pages = ctx.pages();
      page = pages[pages.length - 1] || await ctx.newPage();
    }
  }

  if (!page) {
    // Launch a standalone browser for the workflow
    const { chromium: pw } = await import('playwright');
    browser = await pw.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    standalone = true;
  }

  const url = params.url;
  const clicks = params.clicks || [];
  const breakpoints = params.breakpoints || [
    { label: 'desktop', width: 1280, height: 800 },
    { label: 'tablet', width: 768, height: 1024 },
    { label: 'mobile', width: 375, height: 812 },
  ];
  const auditNames = params.audits || ['meta', 'accessibility', 'contrast', 'overflow', 'tap_targets', 'images'];
  const saveDir = params.savePath || null;
  const startTime = Date.now();

  try {
    // Navigate
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(500);

    // Click steps
    for (const selector of clicks) {
      await clickAndSettle(page, selector);
    }

    // Screenshots at breakpoints
    const screenshots = [];
    for (const bp of breakpoints) {
      await page.setViewportSize({ width: bp.width, height: bp.height });
      await page.waitForTimeout(300);
      const buffer = await page.screenshot({ fullPage: true });
      if (saveDir) {
        const fs = await import('fs');
        const path = await import('path');
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        const filepath = path.join(saveDir, `${bp.label}-${bp.width}x${bp.height}.png`);
        fs.writeFileSync(filepath, buffer);
        screenshots.push({ label: bp.label, path: filepath });
      } else {
        screenshots.push({ label: bp.label, size: buffer.length });
      }
    }

    // Run audits
    const auditResults = [];
    let totalIssues = 0;
    for (const auditName of auditNames) {
      const auditFn = AUDIT_MAP[auditName];
      if (!auditFn) continue;
      let result;
      if (auditName === 'overflow') {
        result = await auditFn(page, breakpoints);
      } else {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForTimeout(200);
        result = await auditFn(page);
      }
      auditResults.push(result);
      totalIssues += result.total;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Build compact summary
    const lines = [];
    lines.push(`Workflow: audit-page`);
    lines.push(`URL: ${url}`);
    const steps = ['navigate'];
    clicks.forEach(c => steps.push(`click "${c}"`));
    steps.push(`screenshot × ${breakpoints.length}`);
    steps.push(`audit × ${auditNames.length}`);
    lines.push(`Steps: ${steps.join(' → ')}`);
    lines.push('');

    if (saveDir) {
      lines.push('Screenshots saved:');
      for (const s of screenshots) lines.push(`  ${s.path}`);
    } else {
      lines.push('Screenshots captured:');
      for (const s of screenshots) lines.push(`  ${s.label} (${s.size} bytes)`);
    }
    lines.push('');

    lines.push('Audit Summary:');
    for (const result of auditResults) {
      if (result.total === 0) {
        lines.push(`  ${result.name}: PASS`);
      } else {
        const parts = [];
        if (result.critical) parts.push(`${result.critical} critical`);
        if (result.warnings) parts.push(`${result.warnings} warnings`);
        lines.push(`  ${result.name}: ${result.total} issues${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
        for (const issue of result.issues.slice(0, 3)) {
          lines.push(`    • ${issue}`);
        }
        if (result.issues.length > 3) {
          lines.push(`    ... and ${result.issues.length - 3} more`);
        }
      }
    }
    lines.push('');
    lines.push(`Total: ${totalIssues} issues | Time: ${elapsed}s`);

    // Save report if savePath provided
    if (saveDir) {
      const fs = await import('fs');
      const pathMod = await import('path');
      const report = {
        workflow: 'audit-page',
        url,
        timestamp: new Date().toISOString(),
        clicks,
        screenshots: screenshots.map(s => s.path),
        audits: auditResults,
        totalIssues,
        elapsed: `${elapsed}s`,
      };
      const reportPath = pathMod.join(saveDir, 'audit-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      lines.push(`Full report: ${reportPath}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } finally {
    if (standalone && browser) {
      await browser.close().catch(() => {});
    }
  }
}

// --- Workflow inspect tool handler (workflow_inspect via MCP) ---

async function handleWorkflowInspect(params) {
  const { inspect } = await import('./cli-commands/inspect-engine.js');
  const { clickAndSettle } = await import('./cli-commands/workflow.js');
  const { parseSteps } = await import('./cli-commands/interact.js');

  // Use the active pool page if available, otherwise launch standalone
  let page, browser, standalone = false;
  if (currentId() && poolEntries.has(currentId())) {
    const entry = poolEntries.get(currentId());
    const ctx = entry.browserContext;
    if (ctx) {
      const pages = ctx.pages();
      page = pages[pages.length - 1] || await ctx.newPage();
    }
  }

  if (!page) {
    const { chromium: pw } = await import('playwright');
    browser = await pw.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    standalone = true;
  }

  const url = params.url;
  const steps = params.steps || [];
  const intent = params.intent || null;
  const detail = params.detail || 'standard';
  const breakpoints = params.breakpoints || [
    { label: 'desktop', width: 1280, height: 800 },
    { label: 'tablet', width: 768, height: 1024 },
    { label: 'mobile', width: 375, height: 812 },
  ];
  const savePath = params.savePath || null;

  try {
    // Navigate
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(500);

    // Execute interaction steps
    const parsedSteps = parseSteps(steps);
    for (const step of parsedSteps) {
      if (step.action === 'click') {
        await clickAndSettle(page, step.target);
      } else if (step.action === 'wait') {
        await page.waitForTimeout(step.seconds * 1000);
      } else if (step.action === 'scroll') {
        const scrollMap = { down: 500, up: -500, bottom: 99999, top: -99999 };
        await page.evaluate(y => window.scrollBy(0, y), scrollMap[step.direction] || 500);
      }
    }

    // Run inspect engine
    const result = await inspect(page, { intent, detail, breakpoints, savePath });

    // Build response
    const lines = [];
    lines.push(result.report);
    lines.push('');
    lines.push(`Time: ${(result.time / 1000).toFixed(1)}s | Checks: ${result.checksRun.join(', ')}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } finally {
    if (standalone && browser) {
      await browser.close().catch(() => {});
    }
  }
}

// --- Pool tool handlers ---

async function handlePoolLaunch(params) {
  const mode = params.mode || 'window';
  const id = `${SESSION_ID}-${nextId++}`;

  // Resolve device emulation preset
  let deviceOptions = {};
  if (params.device) {
    if (mode === 'tab') {
      return {
        content: [{ type: 'text', text: 'Device emulation is only supported in "window" mode (each window gets its own context). Use mode "window" with a device preset.' }],
        isError: true,
      };
    }
    const preset = devices[params.device];
    if (!preset) {
      const available = Object.keys(devices).filter(d => !d.includes('landscape')).slice(0, 20);
      return {
        content: [{ type: 'text', text: `Unknown device "${params.device}". Examples: ${available.join(', ')}` }],
        isError: true,
      };
    }
    deviceOptions = { ...preset };
  }

  const vw = params.width || deviceOptions.viewport?.width || 1280;
  const vh = params.height || deviceOptions.viewport?.height || 800;

  const profileName = params.profileName || 'default';
  ensurePoolDir();
  const prof = await ensureTemplate(profileName);

  let browserContext;
  let contextDir = null;

  let backend;

  if (mode === 'tab') {
    // Shared context for all tabs — one browser, one backend, many pages
    if (!tabContext) {
      tabContextDir = path.join(POOL_DIR, `${SESSION_ID}-tabs`);
      createAuthProfile(tabContextDir, profileName);
      const cdpPort = await findFreePort();
      tabCdpPort = cdpPort;
      tabContext = await chromium.launchPersistentContext(tabContextDir, {
        headless: HEADLESS,
        viewport: null,
        args: [
          '--disable-blink-features=AutomationControlled',
          `--remote-debugging-port=${cdpPort}`,
        ],
      });
      log('Tab context initialized.');

      // Create a single shared backend for all tab entries
      tabBackend = await createBackendForContext(tabContext);
    }

    // Create a new tab page. For the first tab launch, close the initial
    // about:blank page that Chromium opens automatically with persistent contexts.
    const existingPages = tabContext.pages();
    const page = await tabContext.newPage();
    await page.setViewportSize({ width: vw, height: vh });

    // Close the initial blank page if this is the first tab launch
    if (existingPages.length === 1 && existingPages[0].url() === 'about:blank') {
      await existingPages[0].close().catch(() => {});
    }

    browserContext = tabContext;
    backend = tabBackend;

    // Track which tab index this entry corresponds to
    const tabIndex = tabContext.pages().indexOf(page);

    poolEntries.set(id, {
      backend,
      contextDir: null,
      mode,
      label: params.label || id,
      browserContext,
      tabIndex,
      cdpPort: tabCdpPort,
    });
  } else {
    // Window mode — separate persistent context with its own backend
    contextDir = path.join(POOL_DIR, id);
    createAuthProfile(contextDir, profileName);
    const cdpPort = await findFreePort();

    // Build context options, merging device preset if provided
    const contextLaunchOptions = {
      headless: HEADLESS,
      viewport: { width: vw, height: vh },
      args: [
        '--disable-blink-features=AutomationControlled',
        `--remote-debugging-port=${cdpPort}`,
      ],
    };
    // Apply device emulation options (userAgent, deviceScaleFactor, isMobile, hasTouch, screen)
    if (deviceOptions.userAgent) contextLaunchOptions.userAgent = deviceOptions.userAgent;
    if (deviceOptions.deviceScaleFactor) contextLaunchOptions.deviceScaleFactor = deviceOptions.deviceScaleFactor;
    if (deviceOptions.isMobile !== undefined) contextLaunchOptions.isMobile = deviceOptions.isMobile;
    if (deviceOptions.hasTouch !== undefined) contextLaunchOptions.hasTouch = deviceOptions.hasTouch;
    if (deviceOptions.screen) contextLaunchOptions.screen = deviceOptions.screen;

    browserContext = await chromium.launchPersistentContext(contextDir, contextLaunchOptions);

    backend = await createBackendForContext(browserContext);

    poolEntries.set(id, {
      backend,
      contextDir,
      mode,
      label: params.label || id,
      browserContext,
      cdpPort,
    });
  }

  // Make this the active context
  activeId = id;

  const deviceSuffix = params.device ? ` [device: ${params.device}]` : '';
  log(`${mode === 'tab' ? 'Tab' : 'Window'} "${id}" created (${vw}x${vh}${deviceSuffix})`);
  const accts = profileAccounts(prof.path);
  const idLine = `Profile: ${prof.name}${accts.length ? ` — signed in as ${accts.join(', ')}` : ' (no account hint)'}`;
  return {
    content: [{
      type: 'text',
      text: `${idLine}\nCreated ${mode} "${id}"${params.label ? ` [${params.label}]` : ''}${deviceSuffix} (${vw}x${vh})\nThis is now the active context. All browser_* tools will operate on it, or pass context: "${id}" to any tool to reach it whatever is active.
Debug port: ${poolEntries.get(id).cdpPort}`,
    }],
  };
}

async function handlePoolClose(params) {
  const { id } = params;

  if (id === 'all') {
    const count = poolEntries.size;
    await cleanupAll();
    return { content: [{ type: 'text', text: `Closed ${count} context(s) in session ${SESSION_ID}.` }] };
  }

  const entry = poolEntries.get(id);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Context "${id}" not found. Active: ${[...poolEntries.keys()].join(', ') || 'none'}` }],
      isError: true,
    };
  }

  await cleanupEntry(id);
  return { content: [{ type: 'text', text: `Closed "${id}".` }] };
}

async function handlePoolSaveProfile(params) {
  const id = params.id || currentId();
  if (!id) {
    return { content: [{ type: 'text', text: 'No active browser context to save. Use pool_launch first.' }], isError: true };
  }

  const entry = poolEntries.get(id);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Context "${id}" not found. Active: ${[...poolEntries.keys()].join(', ') || 'none'}` }],
      isError: true,
    };
  }

  if (entry.mode !== 'window') {
    return {
      content: [{ type: 'text', text:
        `Context "${id}" is tab-mode and shares one profile directory with every other tab, so saving it ` +
        `would capture unrelated sessions too. Relaunch with mode:"window" to save a login.` }],
      isError: true,
    };
  }

  const contextDir = entry.contextDir;
  if (!contextDir || !fs.existsSync(contextDir)) {
    return { content: [{ type: 'text', text: `Context "${id}" has no profile directory on disk.` }], isError: true };
  }

  const prof = resolveProfile(params.profileName);

  // Close the browser BEFORE copying. Chromium buffers cookies and local storage in memory and
  // only guarantees a flush to disk on close, so copying a live context captures stale auth.
  log(`Flushing context "${id}" before saving to profile "${prof.name}"...`);
  try { entry.backend.serverClosed?.(); } catch {}
  await entry.browserContext.close().catch(() => {});

  let result;
  try {
    result = saveAuthProfile(contextDir, prof);
  } catch (error) {
    await cleanupEntry(id);
    return { content: [{ type: 'text', text: `Save failed: ${error.message}` }], isError: true };
  }

  // Drop the cached template so the next launch rebuilds from the snapshot just written.
  templateDirs.delete(prof.name);
  await cleanupEntry(id);

  const accounts = profileAccounts(prof.path);
  const lines = [
    `Saved logins from "${id}" to profile "${prof.name}".`,
    `  profile path: ${prof.path}`,
    `  auth items written: ${result.written.length}` +
      (result.absent.length ? ` (${result.absent.length} not present in context)` : ''),
  ];
  if (result.backupDir) lines.push(`  previous snapshot backed up to: ${result.backupDir}`);
  if (accounts.length) lines.push(`  accounts in profile: ${accounts.join(', ')}`);
  lines.push(`  context "${id}" is now closed; pool_launch profileName:"${prof.name}" will start signed in.`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handlePoolList() {
  if (poolEntries.size === 0) {
    return {
      content: [{ type: 'text', text: `Session ${SESSION_ID}: No active contexts. Use pool_launch to create one.` }],
    };
  }

  const lines = [`Session ${SESSION_ID} — ${poolEntries.size} active context(s):`];
  for (const [id, entry] of poolEntries) {
    const marker = id === activeId ? ' <-- active' : '';
    let pageInfo = '';
    try {
      const pages = entry.browserContext.pages();
      if (entry.mode === 'tab' && entry.tabIndex != null) {
        // Show the specific page for this tab entry
        const page = pages[entry.tabIndex];
        pageInfo = page ? ` — ${page.url()}` : ' — (tab closed)';
      } else if (pages.length > 0) {
        // Window mode — show the last page
        const lastPage = pages[pages.length - 1];
        pageInfo = ` — ${lastPage.url()}`;
      }
    } catch {
      pageInfo = ' — (page info unavailable)';
    }
    lines.push(`  ${id} (${entry.mode}) [${entry.label}]${pageInfo}${marker}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handlePoolSwitch(params) {
  const { id } = params;
  if (!poolEntries.has(id)) {
    return {
      content: [{ type: 'text', text: `Context "${id}" not found. Active: ${[...poolEntries.keys()].join(', ') || 'none'}` }],
      isError: true,
    };
  }
  activeId = id;
  const entry = poolEntries.get(id);
  return {
    content: [{ type: 'text', text: `Switched to "${id}" [${entry.label}]. All browser_* tools now target this context.` }],
  };
}

// --- Cleanup ---

async function cleanupEntry(id) {
  const entry = poolEntries.get(id);
  if (!entry) return;

  if (entry.mode === 'window') {
    // Dispose the backend first, then close the browser
    try { entry.backend.serverClosed?.(); } catch {}
    await entry.browserContext.close().catch(() => {});
    if (entry.contextDir && fs.existsSync(entry.contextDir)) {
      try { fs.rmSync(entry.contextDir, { recursive: true, force: true }); } catch {}
    }
  } else if (entry.mode === 'tab') {
    // For tab entries, close the specific page but keep the shared context alive
    // (unless this is the last tab entry)
    const tabEntries = [...poolEntries.entries()].filter(([, e]) => e.mode === 'tab');
    if (tabEntries.length <= 1) {
      // Last tab — tear down the shared context and backend
      try { tabBackend?.serverClosed?.(); } catch {}
      tabBackend = null;
      await tabContext?.close().catch(() => {});
      tabContext = null;
      if (tabContextDir && fs.existsSync(tabContextDir)) {
        try { fs.rmSync(tabContextDir, { recursive: true, force: true }); } catch {}
        tabContextDir = null;
      }
    } else {
      // Close one tab page (the one at tabIndex, or the most recent)
      try {
        const pages = entry.browserContext.pages();
        const idx = entry.tabIndex ?? pages.length - 1;
        if (idx >= 0 && idx < pages.length) {
          await pages[idx].close().catch(() => {});
        }
      } catch {}
    }
  }

  poolEntries.delete(id);

  // If we deleted the active context, pick another
  if (activeId === id) {
    const remaining = [...poolEntries.keys()];
    activeId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
}

async function cleanupAll() {
  log('Cleaning up all contexts...');

  // Collect unique backends to avoid double-disposal
  const disposedBackends = new Set();

  // Close window-mode contexts and their backends
  for (const [, entry] of poolEntries) {
    if (entry.mode === 'window') {
      if (!disposedBackends.has(entry.backend)) {
        try { entry.backend.serverClosed?.(); } catch {}
        disposedBackends.add(entry.backend);
      }
      await entry.browserContext.close().catch(() => {});
      if (entry.contextDir && fs.existsSync(entry.contextDir)) {
        try { fs.rmSync(entry.contextDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  // Close shared tab backend and context
  if (tabBackend && !disposedBackends.has(tabBackend)) {
    try { tabBackend.serverClosed?.(); } catch {}
  }
  tabBackend = null;

  if (tabContext) {
    await tabContext.close().catch(() => {});
    tabContext = null;
  }
  if (tabContextDir && fs.existsSync(tabContextDir)) {
    try { fs.rmSync(tabContextDir, { recursive: true, force: true }); } catch {}
    tabContextDir = null;
  }

  poolEntries.clear();
  activeId = null;

  // Clean up template
  if (templateDir && fs.existsSync(templateDir)) {
    try { fs.rmSync(templateDir, { recursive: true, force: true }); } catch {}
  }

  log('Cleanup complete.');
}

// Every tool but pool_launch/pool_list takes an optional `context`.
function withContextArg(tool) {
  if (UNTARGETED.has(tool.name)) return tool;
  const schema = tool.inputSchema ?? { type: 'object', properties: {} };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        context: {
          type: 'string',
          description: 'Context ID (from pool_launch) this call is for. Default: the active context.',
        },
      },
    },
  };
}

// --- Composite Backend ---
// Implements the same interface as BrowserServerBackend (listTools, callTool,
// initialize, serverClosed) but adds pool tools and delegates browser tools
// to the active pool entry's backend.

class PoolCompositeBackend {
  constructor() {
    this._clientInfo = null;
    this._browserToolList = null;
    this._browserToolListPromise = this._computeToolList();
  }

  async _computeToolList() {
    const config = await resolveConfig({
      browser: { browserName: 'chromium' },
      capabilities: ['core-install', 'core-tabs', 'internal', 'pdf', 'testing', 'tracing', 'vision'],
    });
    const tools = filteredTools(config);
    this._browserToolList = tools.map(t => toMcpTool(t.schema));
    this._browserTools = tools;
  }

  async initialize(clientInfo) {
    this._clientInfo = clientInfo;
    await this._browserToolListPromise;
  }

  async listTools() {
    await this._browserToolListPromise;

    // Pool management tools
    const poolTools = poolToolSchemas.map(schema => toMcpTool(schema));

    // Audit tools (batch A — built into server.js)
    const auditToolsA = auditToolSchemas.map(schema => toMcpTool(schema));

    // Audit tools (batch B — from audit-tools-b.js)
    const auditToolsB = getAuditBSchemas(mcpBundle.z).map(schema => toMcpTool(schema));

    // Utility tools (snapshot_compact, etc.)
    const utilityTools = utilityToolSchemas.map(schema => toMcpTool(schema));

    // Custom browser tools (storage, cookies, mouse wheel — not in upstream @playwright/mcp)
    const customTools = customToolSchemas.map(schema => toMcpTool(schema));

    // Official browser tools (full list)
    const browserTools = this._browserToolList || [];

    return [...poolTools, ...auditToolsA, ...auditToolsB, ...utilityTools, ...customTools, ...browserTools].map(withContextArg);
  }

  // A call naming a context runs against it (see callTarget); the name is taken off the arguments
  // before any handler's own schema reads them.
  async callTool(name, rawArguments, progress) {
    const context = rawArguments?.context;
    if (context === undefined || UNTARGETED.has(name)) return this._callTool(name, rawArguments, progress);
    const { context: _, ...rest } = rawArguments;
    if (typeof context !== 'string' || !poolEntries.has(context)) {
      const open = [...poolEntries.keys()].join(', ') || 'none';
      return { content: [{ type: 'text', text: `Context "${context}" not found. Open: ${open}` }], isError: true };
    }
    return callTarget.run(context, () => this._callTool(name, rest, progress));
  }

  async _callTool(name, rawArguments, progress) {
    // Pool tools
    if (name === 'pool_launch') {
      const parsed = poolToolSchemas[0].inputSchema.parse(rawArguments || {});
      try {
        const result = await handlePoolLaunch(parsed);
        // Initialize the backend with clientInfo so it can create its internal
        // Context object. For tab mode, only initialize once (shared backend).
        const entry = poolEntries.get(activeId);
        if (entry && this._clientInfo && !entry.backend._initialized) {
          await entry.backend.initialize(this._clientInfo);
          entry.backend._initialized = true;
        }
        return result;
      } catch (error) {
        return { content: [{ type: 'text', text: `Error launching: ${error.message}` }], isError: true };
      }
    }

    if (name === 'pool_close') {
      const parsed = poolToolSchemas[1].inputSchema.parse(rawArguments || {});
      try {
        return await handlePoolClose(parsed);
      } catch (error) {
        return { content: [{ type: 'text', text: `Error closing: ${error.message}` }], isError: true };
      }
    }

    if (name === 'pool_list') {
      try {
        return await handlePoolList();
      } catch (error) {
        return { content: [{ type: 'text', text: `Error listing: ${error.message}` }], isError: true };
      }
    }

    if (name === 'pool_switch') {
      const parsed = poolToolSchemas[3].inputSchema.parse(rawArguments || {});
      try {
        return await handlePoolSwitch(parsed);
      } catch (error) {
        return { content: [{ type: 'text', text: `Error switching: ${error.message}` }], isError: true };
      }
    }

    if (name === 'pool_save_profile') {
      const parsed = poolToolSchemas[4].inputSchema.parse(rawArguments || {});
      try {
        return await handlePoolSaveProfile(parsed);
      } catch (error) {
        return { content: [{ type: 'text', text: `Error saving profile: ${error.message}` }], isError: true };
      }
    }

    // Audit tools — find matching schema and route to handler
    const auditSchemaIndex = auditToolSchemas.findIndex(s => s.name === name);
    if (auditSchemaIndex !== -1) {
      const schema = auditToolSchemas[auditSchemaIndex];
      const parsed = schema.inputSchema.parse(rawArguments || {});
      try {
        switch (name) {
          case 'audit_accessibility': return await handleAuditAccessibility(parsed);
          case 'audit_color_contrast': return await handleAuditColorContrast(parsed);
          case 'audit_breakpoints': return await handleAuditBreakpoints(parsed);
          case 'audit_tap_targets': return await handleAuditTapTargets(parsed);
          case 'audit_core_web_vitals': return await handleAuditCoreWebVitals(parsed);
          case 'audit_image_sizes': return await handleAuditImageSizes(parsed);
          case 'audit_fonts': return await handleAuditFonts(parsed);
          case 'audit_computed_styles': return await handleAuditComputedStyles(parsed);
          case 'audit_overflow': return await handleAuditOverflow(parsed);
          case 'audit_dark_mode': return await handleAuditDarkMode(parsed);
          case 'audit_meta': return await handleAuditMeta(parsed);
          case 'audit_visual': return await handleAuditVisual(parsed);
          default: break;
        }
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true };
      }
    }

    // Audit tools batch B (from audit-tools-b.js)
    if (isAuditToolB(name)) {
      if (!currentId() || !poolEntries.has(currentId())) {
        return { content: [{ type: 'text', text: 'No active browser context. Use pool_launch first.' }], isError: true };
      }
      try {
        return await handleAuditToolB(name, rawArguments || {}, poolEntries.get(currentId()));
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true };
      }
    }

    // Utility tools (snapshot_compact, workflow_audit_page, etc.)
    if (name === 'snapshot_compact') {
      const schema = utilityToolSchemas.find(s => s.name === name);
      const parsed = schema.inputSchema.parse(rawArguments || {});
      try {
        return await handleSnapshotCompact(parsed);
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true };
      }
    }

    if (name === 'workflow_audit_page') {
      const schema = utilityToolSchemas.find(s => s.name === name);
      const parsed = schema.inputSchema.parse(rawArguments || {});
      try {
        return await handleWorkflowAuditPage(parsed);
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true };
      }
    }

    if (name === 'workflow_inspect') {
      const schema = utilityToolSchemas.find(s => s.name === name);
      const parsed = schema.inputSchema.parse(rawArguments || {});
      try {
        return await handleWorkflowInspect(parsed);
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true };
      }
    }

    // Custom browser tools (storage, cookies, mouse wheel)
    const customSchema = customToolSchemas.find(s => s.name === name);
    if (customSchema) {
      const parsed = customSchema.inputSchema.parse(rawArguments || {});
      try {
        switch (name) {
          case 'browser_cookies_get': return await handleCookiesGet(parsed);
          case 'browser_cookies_set': return await handleCookiesSet(parsed);
          case 'browser_cookies_clear': return await handleCookiesClear(parsed);
          case 'browser_storage_get': return await handleStorageGet(parsed);
          case 'browser_storage_set': return await handleStorageSet(parsed);
          case 'browser_mouse_wheel': return await handleMouseWheel(parsed);
          default: break;
        }
      } catch (error) {
        return { content: [{ type: 'text', text: `Error in ${name}: ${error.message}` }], isError: true };
      }
    }

    // Intercept browser_close — redirect to pool_close for the active context
    // so the actual browser process is cleaned up properly.
    if (name === 'browser_close') {
      if (!currentId()) {
        return { content: [{ type: 'text', text: 'No active browser context to close.' }], isError: true };
      }
      return handlePoolClose({ id: currentId() });
    }

    // Browser tools — delegate to the called (or active) context's backend
    if (!currentId() || !poolEntries.has(currentId())) {
      return {
        content: [{
          type: 'text',
          text: 'No active browser context. Use pool_launch to create one first.',
        }],
        isError: true,
      };
    }

    const entry = poolEntries.get(currentId());

    // Intercept screenshots: let upstream take it, then save to disk + strip base64
    // Prevents 20MB+ context crashes from accumulated inline image data
    if (name === 'browser_take_screenshot') {
      const result = await entry.backend.callTool(name, rawArguments, progress);
      if (result?.content) {
        const imageBlocks = result.content.filter(c => c.type === 'image');
        if (imageBlocks.length > 0) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const fmt = rawArguments?.type || 'png';
          const dir = path.join(os.tmpdir(), 'playwright-pool-screenshots');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const userFile = rawArguments?.filename;
          const filePath = userFile
            ? (path.isAbsolute(userFile) ? userFile : path.join(dir, userFile))
            : path.join(dir, `screenshot-${ts}.${fmt}`);
          // Save image to disk ourselves
          const imgData = Buffer.from(imageBlocks[0].data, 'base64');
          fs.writeFileSync(filePath, imgData);
          log(`Screenshot saved to ${filePath} (${imgData.length} bytes)`);
          // Strip ALL image blocks from response — return only text + file path
          result.content = result.content.filter(c => c.type !== 'image');
          result.content.push({ type: 'text', text: `Screenshot saved to: ${filePath}` });
        }
      }
      return result;
    }

    return entry.backend.callTool(name, rawArguments, progress);
  }

  serverClosed(server) {
    // Called when the MCP server is shut down
    cleanupAll().catch(() => {});
  }
}

// --- Start the MCP server ---
log(`Starting (session: ${SESSION_ID}, golden: ${GOLDEN_PROFILE})`);

const backend = new PoolCompositeBackend();
const server = createServer('playwright-pool', '1.0.0', backend, false);

const transport = new mcpBundle.StdioServerTransport();
await server.connect(transport);

log('Ready. Use pool_launch to create a browser context, then use any browser_* tool.');

// Say which process owns this session's folders, then clear folders of servers that died without
// cleaning up (only those whose owner file proves it; see lib/sweep.js). Off the start path.
try { writeOwner(POOL_DIR, SESSION_ID); } catch (err) { log(`Owner file not written: ${err.message}`); }
setTimeout(() => {
  try {
    const { removed, failed } = sweepLeftovers(POOL_DIR, SESSION_ID);
    const { legacy } = planSweep(POOL_DIR, SESSION_ID, { measure: false });
    log(`Sweep: removed ${removed} abandoned item(s)${failed.length ? `, ${failed.length} still in use` : ''}; ${legacy.length} older folder(s) without an owner file kept.`);
  } catch (err) {
    log(`Sweep skipped: ${err.message}`);
  }
}, 3000).unref();

// --- Cleanup on exit ---
async function shutdown() {
  log('Shutting down...');
  await cleanupAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  // Sync cleanup for any remaining temp dirs (best effort)
  try {
    const entries = fs.readdirSync(POOL_DIR);
    for (const entry of entries) {
      if (entry.startsWith(SESSION_ID)) {
        fs.rmSync(path.join(POOL_DIR, entry), { recursive: true, force: true });
      }
    }
  } catch {}
});
