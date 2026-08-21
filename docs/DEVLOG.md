# Development log

Dated release narratives and process notes, moved out of the main Joplin note (which keeps only durable rules). Newest last. User-facing changelogs live in GitHub Releases.

## 2026-08-15 — v1.7.5: first publication

CI ("Tests": stubbed harness + real-app Playwright E2E, inherited from the Agenda fork) went green for the first time — both suites were stale Agenda-era code. E2E runs a real Joplin AppImage under Xvfb (~5 min), traces upload on failure. First npm publish was done locally with web auth (`npm login --auth-type=web` → `npm publish`); the Joplin registry crawler ingests `joplin-plugin-*` packages automatically — no PR needed. Trusted publishing (OIDC) was configured afterwards and replaced local publishing entirely from 1.7.6 on.

## 2026-08-15..16 — v1.7.6–1.7.8: theme fixes (Codex)

Light-theme contrast (scheme-1 text on scheme-2 background, ~1.01:1) fixed by pairing `--cockpit-color2` with the sidebar background across all presets; 1.7.7/1.7.8 restored the muted Dark styling for explicit-preset and Match-Joplin paths (webview-side dark-appearance probe on raw `--joplin-*` variables — `--joplin-appearance` is filtered out of plugin webviews). npm OIDC trusted publishing configured (owner pmslava / repo joplin-plugin-cockpit / workflow publish.yml / environment npm) and proven. Local xvfb E2E became possible (`xorg-server-xvfb` installed).

## 2026-08-19 — v1.8.0: speed rework + outside-filters peek

Merged three lines (Codex theme work + speed rework + peek), commit c1e4d9f:

- Performance: optimistic layer (`src/core/optimistic.ts` — completion overrides global by id; item overlay scoped by viewKey = profileID+notebookFilter, never applied cross-view or to overview markdown), desktop fast no-body first paint + background viewport-first ring fill, generation token against stale renders, refresh lanes (profile switch = no cascade; note change = one bounded reconcile with early cancel; overview regen debounced ~10s; sync = fast renders only), ~3s folder poll (id/title/parent_id signature), single idempotent toggle PUT with a ms timestamp (fixed a boolean-write bug).
- "Results outside current filters" peek: committed search + zero rendered rows → one unfiltered search, 15 rows, non-draggable/non-selectable, notes-as-notes, respects excluded notebooks.
- "Excluded notebooks" setting: visible names field + hidden id-list (public:false) as source of truth — rename-safe; server-side `-notebook:"Title"` clauses (title-matched; omitted on collision with a kept notebook) + client-side recursive id filter as authority.
- Search commits on Enter and on suggestion pick (Electron never fires `search`/`change` on Enter in the panel webview — explicit keydown commit).
- Suite: 82 harness checks + 34 Playwright tests.

Process: verification checks stay; token-heavy audit/test phases can be routed to Codex via a self-contained brief, with claims cheaply verified after. Reviewer/verifier agents report plain text, never structured-output schemas.

## 2026-08-20 — v1.9.2: the first batched release

Eight items shipped as one release (intermediate 1.8.1–1.9.1 existed only locally):

- Row-click dead zones fixed (any click on a row opens the note).
- Optimistic-insert re-validation (a profile edit can no longer briefly show now-hidden items).
- Alarm picker rework: two quick-button rows (Today/Tomorrow/Weekends/Next Monday + accumulating +hour/+day/+week/+month(day)/+month(date)); multi-select PLAN+MODE model (respect-own-schedules default vs same-for-all), explanation line, per-todo application with dues re-read fresh at OK. Never `String()`-coerce a postMessage payload that may be an object — "[object Object]" silently became the anchor plan on mobile.
- Alarm dialog layout: buttons above calendar, time columns flush with the calendar bottom (grid height fully pinned: nav 30+4 + weekday 22 + 6×28 = 224 = min-height, equation pinned by an algebraic harness check), explanation row above the footer.
- Plain to-do discs: dark rim via `--cockpit-plain-disc-rim`; the ring renders only when checkboxes exist (`.-plain` strips it deliberately).
- Drag: between-row drops schedule in between (`src/core/between.js` — free-day midpoint at day-start / nearest-:00 / minute midpoint; multi drops divide the interval into equal shares; works in Overdue via null-groupDate bounds); heading drops keep each to-do's own time; "Day start time" setting (default 09:00). Multi-drag lesson: mousedown on an already-selected row must preserve the selection (collapse belongs to click).
- Search: last-resort "Results in excluded notebooks" tier (only when the regular peek is empty; short-circuits when nothing is excluded); "no matches anywhere" now truthful.
- Selection crossing: text selection from the note editor keeps extending over the panel (panel iframe made pointer-transparent during foreign drags, with always-restore paths).

Suite: 194 harness checks + 45 Playwright tests. Process notes: parallel branches in separate worktrees merged cleanly (versions assigned only at merge); subagents repeatedly stalled after yielding to a background E2E run — the manager finishes gate-and-commit itself (`pgrep e2e-cache` + `git status`, re-run the gate, commit); a few subagent launches returned system-prompt junk with 0 tool calls (~30k tokens, worst near usage-cap boundaries) — a fail-fast gate requiring a NEW commit hash in the report makes these cost seconds.

## 2026-08-21 — v1.9.3: optional toolbar button

- `showToolbarButton` Bool setting (default on) gates the note-toolbar "Toggle Cockpit Panel" button in `setupToolbar()`; a Tools › Cockpit command flips it with a restart warning. The plugin API cannot add/remove/re-icon a toolbar button at runtime (`toolbarButtons` exposes only `create()`; `iconName` is fixed at registration) — startup-gated, restart to apply.
- Settings-section icon: `fas fa-tachometer-alt`.

Process notes: the session initially went off-procedure (manual `npm version`, hand-pushed tag, `workflow_dispatch`) because the release-procedure memory wasn't loaded — re-confirmed: the four-field bump must include the harness version-pin test (CI failed the publish until fixed); every `gh` call needs `--repo pmslava/joplin-plugin-cockpit` (it defaults to the upstream Agenda remote); no manual tags — `gh release create --target main` makes the tag. Infra: GitHub runners warn Node 20 actions are deprecated; publish.yml pins Node 20 for the sqlite3 build — a runtime bump will eventually be needed.

## 2026-08-21 — two desktop collapses under E2E load: resource discipline

The laptop's XFCE desktop collapsed twice during heavy Claude work. #1 (20:41): /tmp (a 7.7G tmpfs, shared with the live desktop) hit 100% — stale Claude session scratchpads plus the real desktop Joplin running in AppImage extract-and-run fallback — so glycin's sandboxed PNG decode failed and a libwnck `g_assert` killed all five XFCE wnck processes at once. #2 (22:55): available RAM fell below earlyoom's 10% floor (the real desktop Joplin GPU-process respawn storm + librewolf + two Claude sessions + Claude Desktop on 16GB), earlyoom SIGKILLed the user dbus-broker, and the session collapsed. Neither was caused by the E2E harness.

Verified ground truth about the plugin E2E harness: it is already headless (`test:e2e` wraps Playwright in `xvfb-run -a`, an auto-numbered virtual display — never `:0`), serial within a run (`workers:1`), extracts the AppImage to in-repo `.e2e-cache/squashfs-root`, and keeps profiles in `e2e/.profiles` — it writes nothing to /tmp. The `/tmp/appimage_extracted_*` Joplin seen during incident #1 was the **real desktop app** in extract-and-run fallback, not a test instance. The harness's real gaps: teardown only runs in `afterAll`, so a SIGKILLed run leaks the Joplin process tree, the Xvfb server, `/tmp/.X*-lock` files, and profile dirs (leaked Xvfb `:99`/`:101`/`:102` were found); and there is no cross-run lock (cockpit + ridgeline + worktrees can each start their own run).

New E2E resource discipline (condensed): ONE run machine-wide — `pgrep -f e2e-cache` must be empty before starting (covers cockpit + ridgeline + all worktrees); RAM gate — check `free -h`, don't launch Joplin instances under ~4G available; /tmp hygiene — point bulk scratch (`TMPDIR`) at disk, clean session scratch, never approach 100%; reap orphans after any killed/crashed run (stray `.e2e-cache` Joplin procs, leftover `Xvfb`, stale `/tmp/.X*-lock`, `e2e/.profiles/profile-*`); always launch via `npm run test:e2e` (a bare `npx playwright test` inherits the live `:0`). Code-hardening TODO (both repos, lockstep — ridgeline forked cockpit's harness): pre-run orphan sweep + cross-run lockfile in `setup-e2e.sh`, signal-handler teardown in `e2e/launch.ts`.
