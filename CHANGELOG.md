# Changelog

## Unreleased (branch fix/per-caller-context)

### Fixed
- **Calls from several callers landed in whichever browser was launched last.** A chat and its agents share one server and one "active context"; agent A's actions went into agent B's browser while both reported success (proof: Clawtomods spike S5, 2026-10-06). Every tool except `pool_launch`/`pool_list` now takes an optional `context` (a context id); the call runs against that context. A call without one behaves as before.

### Added
- `pool_launch` reports `Debug port: <n>`, so a viewer can link a context to its browser.
- `POOL_HEADLESS=1` launches browsers hidden, for tests and proofs.
- `tests/context-routing.test.js`: two browsers, calls by context, checked against each browser's own debug port.
- **Leftover sweep (`lib/sweep.js`).** Each server writes `<session>.owner.json` (its pid) into `POOL_DIR` at start and removes it on exit. At start it removes the folders of sessions whose owner file names a process that is gone. Folders with no owner file (made by servers before this change) are kept and counted in the log; removing those is a person's decision (on 2026-10-06: 808 folders, 174 sessions, 33.6 GB, all copies of signed-in profiles).

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
