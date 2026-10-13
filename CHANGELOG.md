# Changelog

## Unreleased

### Changed (2026-10-13, approved by Edward; evidence in Brain artifacts/browser-architecture-2026-10-13/)
- **Windows now open fully visible** (reverses the 2026-10-12 minimized default below). `POOL_START_MINIMIZED=1` restores the minimized start; `POOL_START_VISIBLE` no longer has an effect (visible is the default). The three anti-throttling flags are always passed, so a window that is minimized or covered by hand keeps working.
- **Navigation wait is 30 s** (was Playwright's 60 s); action wait stays 5 s. A wrong `waitForURL` no longer stalls the pool for a minute.
- **Chrome's password-breach lookup is turned off for browsers this server launches** (launch flag `--host-resolver-rules=MAP passwordsleakcheck-pa.googleapis.com ~NOTFOUND`, no profile write; never applied to a personal Chrome/Edge). After a login with a flagged password the breach dialog used to swallow every later page click. `POOL_KEEP_LEAK_CHECK=1` opts out.

### Added
- **Opt-in headless mode:** `POOL_HEADLESS=1` launches new headless `chrome.exe` (so the Browser Agent Monitor still discovers it). Headed stays the default.
- **`tests/acceptance/pool-patch.acceptance.test.js`:** static checks, timeout behaviour, session isolation and saved-login reuse, breach-check click test with a negative control, window default, and flag scope. Headed tests run with `ACCEPT_HEADED=1`.

### Changed
- **Windows open minimized** (Edward, 2026-10-12: "they always start off minimized, so I don't have to keep minimizing them while I'm working"). `--start-minimized` is ignored by Playwright's headed Chromium (measured: windowState stayed `normal`), so `minimizeWindow()` minimizes each new window through `Browser.setWindowBounds` right after launch, and three `--disable-*backgrounding/throttling` flags keep a minimized page rendering (measured: state `minimized`, timers ticking, screenshot OK). `POOL_START_VISIBLE=1` opens windows normally. Takes effect when the MCP host restarts.

## 4.2.2 — 2026-04-22

### Added
- **Regression test for Playwright internal MCP modules.** Checks that `playwright/lib/mcp/browser/browserServerBackend.js` (and 4 other internal paths `server.js` requires) exist in the installed Playwright. Any future Playwright upgrade that drops them now fails in `npm test`, not at fresh-install time.
- **`docs/BRANCHING.md` → Dependency pinning policy** section. Documents why `playwright` uses `~` not `^` and the rule for future deps: `~` for anything where we touch internal APIs.
- **`docs/BRANCHING.md` → Cold install release checklist.** `npm uninstall -g && npm install -g git+url#sha` before every tag.

### Changed
- **Removed unused devDependencies:** `@axe-core/cli`, `lighthouse`, `pa11y`. None were imported anywhere in the codebase; `audit.js` inlines its own logic. Clean install is now 2 packages instead of 3.
- **Updated stale `Zbrooklyn/playwright-pool` URLs to `zbrooklyn-claude-labs/playwright-pool`** across README, CONTRIBUTING, and the benchmark `spa` test URL. GitHub was redirecting, but canonical is better.

## 4.2.1 — 2026-04-22

### Fixed
- **Pin `playwright` to `~1.58.0`** (was `^1.58.0`). Playwright 1.59.0 removed the internal `lib/mcp/browser/` modules that `server.js` requires. Fresh installs of v4.2.0 picked up 1.59.x and crashed at startup. Caught during cold-install verification — added to release checklist.

## 4.2.0 — 2026-04-22

First documented release after internal v4.x iterations. v2.0.0 through v4.1.0 existed only in commit messages and were never tagged or formally released; this is the first release with proper versioning, documentation, and an automated test suite.

### What's in 4.2.0

**Code consolidation**
- Audit logic consolidated into `cli-commands/audit.js` as the single source of truth (`AUDIT_HANDLERS` export). `audit-tools-b.js` and `server.js` now delegate to it. Removed ~2,850 lines of duplicated audit logic across the three files.

**Screenshot handling**
- Screenshots auto-save to `%TEMP%/playwright-pool-screenshots/` and base64 image data is stripped from MCP responses. Prevents context-window crashes when an agent takes many screenshots in one session.
- Honor absolute paths in screenshot `filename` arg; relative paths join with the screenshots dir.

**Stable branch**
- Removed 4 audit stubs (`loading_states`, `print_layout`, `scroll_behavior`, `computed_styles`) from the `stable` branch. They remain on `master` for development.

**Documentation**
- New: `HANDOFF.md`, `PROJECT.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/BENCHMARKS.md`, `docs/BRANCHING.md`.

**Testing**
- 34 automated tests across three tiers: smoke, regression, unit. Run via `npm test`.

### Carried over from earlier internal versions

- 75 MCP tools (pool management, browser automation, 28 audits, utilities)
- 42 CLI commands (parity with MCP tools)
- Golden profile authentication via auth-file overlay (not full profile copy)
- Vision-model audit pipeline with structured prompt
- 143 device presets
- Compact accessibility snapshots (~90% fewer tokens than full snapshot)

### Benchmarks (this release)

- W3C BAD: 74 violations detected across 13 rules
- Accessible University: 21 of 22 known barriers detected (95.5%)
- Package size: ~143 kB, 30 files, 1 production dependency

### Known Limitations

- Google OAuth requires headed mode. Google detects and blocks headless Chromium sessions even with valid cookies; non-Google services work in headless mode.
- Single-file `server.js` (~67 kB). Will be split if/when contributor friction warrants it.

### Distribution

This release is **not published to the npm registry**. Install via git tag:
```
npm install git+https://github.com/zbrooklyn-claude-labs/playwright-pool.git#v4.2.0
```
