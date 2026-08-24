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

## 2026-08-24 — v1.9.8: multi-select in the search token dropdowns

The `tag:` / `notebook:` / `title:` autocomplete became an Evernote-style multi-select.

- **The list**: ~15 visible rows then scroll (capped by the panel height, the `#notebookMenu` `min(66vh, calc(...))` precedent with a larger offset — it hangs off the third control row), an embedded filter box pinned at the top and a muted hint line pinned at the bottom, with only the rows scrolling between them. Candidate caps raised 8 → 200 (tag/notebook, from the embedded island) and 10 → 50 (`title:`, `titleSuggestionLimit` — a bigger page, still one `data.get`). The narrowing is now shared with the notebook menu's filter (`applyMenuFilter`), whose match rule is the pure `SearchTokens.matchesFilter`.
- **Marking**: Ctrl/Cmd+click on desktop; on touch a 500 ms long press marks the first row and enters selection mode, after which a plain tap toggles. Marks are held **by value**, not by row index, so they survive re-filtering and the list being rebuilt on every keystroke. An apply button (enter arrow) appears beside the filter box whenever ≥1 mark exists and doubles as the selection-mode indicator. Escape unwinds one step at a time — marks, then filter text, then the list — swallowed at every step, so the dropdown still wins Escape ahead of the 1.9.7 bare-Escape selection collapse.
- **Insertion is a pure text helper** (`src/ui/panel/searchTokens.js`, `window.SearchTokens`, UMD like `editorNote.js`/`noteMenu.js`). `buildTokenInsertion(query, token, values)` replaces ONLY the incomplete token span and returns everything either side byte-identical: other tokens, free text, `any:1` and negations all survive. Quoting, the duplicate skip (whole-term, case-insensitive, quoted/unquoted normalised, **quote-aware** — the query is split the way Joplin reads it, so `tag:work` sitting inside the phrase `"foo tag:work"` is not a term and cannot silently suppress the insertion; an unterminated quote is read conservatively, never suppressing — and `-tag:x` is deliberately *not* the same term as `tag:x`) and the spacing live there, exercised by behavioural tests rather than pattern-matched. Single pick and multi apply share the one path, and the single-value output is pinned byte-for-byte against the pre-multi-select result — including the double space a mid-query apply leaves, which is what "never rewrite the text after the fragment" actually means — with **two deliberate divergences**, both found by fuzzing and both pinned as tests: a value that is empty once its quotes are stripped now leaves nothing instead of the old litter `tag: `, and a value already in the query is skipped instead of duplicated.
- **Three blocking bugs the design walked into**, all only observable in a real browser and all covered by the extended `search-commit.spec.ts`: (1) the capturing click-closer counted the list as "outside" any `.dropdown` and shut it on the click following a marking Ctrl+mousedown; (2) the field's blur handler tore the list down the moment focus moved into its own filter box (and on mobile would have released the host refresh hold — a full webview reload); (3) **the browser's own `change` event committed the search** when focus left the field for the filter box — the field commits on `change`, so merely reaching for the box ran the user's half-typed query and its re-render landed mid-interaction. Fixed by naming `#searchSuggestions` in the click-closer's selector, by treating the field plus the open list as ONE focus region, and by routing `change`/`search` through `onSearchFieldChanged`, which drops exactly the blur that moves focus into the list (the clear button, which fires `search` while the field still holds focus, still commits). Bugs 1 and 3 were both found by the E2E run, not by review — the list only gained focusable controls with multi-select, so neither could exist before.
- **Adversarial review then found three more in the same focus machinery**, all now fixed. (a) The bug-3 fix worked for the mouse only: `change` fires BEFORE the browser assigns focus, so an inline `activeElement` test is dead code and **Tab** — the filter box is literally the field's next tab stop — still committed. The commit is now **deferred one tick** and decided on where focus actually landed, which makes mouse, Tab and programmatic `focus()` behave alike. (b) That suppression must not be a drop: the field blurs exactly once, so a suppressed commit would strand the typed query uncommitted *and* `leaveSearchField` would null the draft and wipe it. A suppressed commit is therefore held **pending** and flushed by `leaveSearchField` when focus finally leaves the region — deferred, never lost, and superseded by any explicit commit so it can never fire twice. (c) Clicking back into the search field ran the capture click-closer and destroyed the marks; Escape already hands the caret back with the list open, so the mouse now gets the same move (`closeAllDropdowns({ keepSuggestions: true })` for a click in `#searchRow` while the list is open — the other menus still close).
- **Marks survive the no-matches state**: typing one character past the last match used to null them irreversibly, since the marked values are no longer on screen to re-mark. They are now kept across that empty state while the token kind is unchanged, so a backspace brings them back; every other close (blur, commit, Escape, a re-render, the token going away) still drops them.
- **Mobile**: the pick moved from `pointerdown` to `pointerup` — a long press *begins* with a pointerdown, and `preventDefault`ing a touch pointerdown also stops the now-scrolling list from scrolling. Nothing is prevented, so the tap drops focus to `<body>` with a null blur `relatedTarget`; a short-lived press-inside flag tells that apart from the user leaving and hands the caret straight back. Device-check only (MOBILE.md steps 10, 10a–10f).
- **Deliberately NOT routed through `dialogGuard`/the overlay descriptor** (the plan's Option A, Slava's call): the mobile search-focus hold already blocks every Cockpit `setHtml` while the field is focused, so the guard would be redundant — and the list opens and closes on every keystroke, so bracketing it is a leak hazard an overlay's two call sites do not have. A host-initiated renderer kill therefore loses the marks, exactly as it already loses the uncommitted query text; documented as an accepted gap, with a `{ draft, caret, marks }` descriptor on its own channel sketched as the follow-up.
- **Reconcile mitigation**: a background re-render used to close the list outright. An in-progress multi-select now rides across the render and the list re-opens from the restored draft, so a sync landing cannot silently destroy a half-built ten-tag selection.
- **Icon**: the "New to-do" glyph changed from the note icon's document sheet with a checkmark (which read as "note") to a ring with a checkmark inside, matching the panel's own glyph language where circles mean to-dos. The note icon is untouched; the harness pin flipped from "the pair shares one sheet" to "only the note carries the sheet".

Measured: rebuilding the list plus a forced layout costs ~5.2 ms at 200 rows (~0.6 ms at the old 8, ~26 µs/row, linear), so a keystroke stays well inside a frame even on a vault with 200 matching tags; the filter pass over 200 rows is ~0.17 ms. The build loop is two elements and one dataset write per row with ONE delegated listener for the whole list — no per-row listener, no layout read.

Suite: 250 harness checks + 56 Playwright tests (55 run, 1 opt-in showcase skipped).

Process note: an E2E run killed by a foreground timeout leaks the Joplin process tree exactly as documented — reaped by hand (`.e2e-cache` tree, profiles, lock) and re-run in the background instead. Run E2E backgrounded and poll; do not wrap it in `timeout`.

## 2026-08-24 — v1.9.9: two Pixel bugs — the mobile long press, and clearing the search

Slava's Pixel found the one thing the desktop suite and the synthetic-mobile probes could not: a short
tap on a suggestion row picked correctly, but a **tap-and-hold closed the whole list**, leaving only the
typed `tag:` fragment in the field — no mark, no selection mode.

**The diagnosis is a diff, and it was in the CSS, not the JS.** The suggestion-row press tracker was
already a faithful copy of the shipped to-do-row long-press adapter. What it had not copied was that
adapter's *stylesheet*: `.cockpit-mobile .todo` carries `-webkit-touch-callout: none` +
`user-select: none` precisely "so a long press synthesises the context menu instead of selecting text or
raising the system callout". The suggestion rows carried neither, so on Android the native long press won
— it began a text selection on the row's label, which takes the pointer (the resulting `pointercancel`
abandoned the 500 ms hold, so no mark could ever be made) and blurred the search field. The blur then ran
`leaveSearchField`, hiding the list and posting `searchFocusChanged(false)`, which released the host's
refresh hold — exactly the reported "the window closes and only `tag:` is left".

A second, independent defect made the blur fatal rather than survivable: the press-inside flag that tells
a press-caused blur from a real departure was cleared **one tick after the press began**. That is enough
for a tap, whose blur lands immediately, but a hold keeps the finger down for half a second, so every
blur Android raised during the hold read as the user leaving.

Fixes, all mirroring the proven adapter rather than inventing new mechanics:

- The same three-property suppression on `#searchSuggestions .dropdown-item` / `.dropdown-label`,
  mobile-gated exactly like the to-do rule, plus `touch-action: pan-y` — which keeps the list scrolling
  vertically (it is 15 rows and more) while giving up every other native gesture. Deliberately *not* a
  blanket `preventDefault` on the touch pointerdown, which would suppress the gesture and the scroll.
- The press listeners moved from the list element to **document-level capture**, like the to-do adapter:
  capture cannot be stopped on the way up, and one registration survives the list being rebuilt on every
  keystroke.
- `contextmenu` inside the list suppressed on mobile (belt to the CSS braces); desktop right-click
  untouched.
- The press-inside flag now covers the **whole press**, released a tick after `pointerup`/`pointercancel`
  instead of a tick after `pointerdown`. Still tied strictly to the press, so an unrelated blur with no
  finger down is still read as a genuine departure.

Nothing outside `.cockpit-mobile` / `IS_MOBILE` changed, so desktop is byte-identical; the desktop
`search-commit` spec was re-run as sanity rather than the full suite.

### Second Pixel report: clearing the search did not reset the panel

Emptying the field left the panel filtered until the user pressed Enter on an empty field — non-obvious on
desktop, impossible on mobile. Diagnosed empirically against the harness before touching anything, and the
host turned out to be innocent: an empty committed query already restores the unfiltered view on both
platforms. Two other layers were broken.

- **The webview never committed.** `input` is the only event a backspace or a cut fires; `change` waits for a
  blur and `search` for the ×. So the input path updated the draft and nothing else. Fixed with an explicit
  programmatic commit when the value is observed empty — not another event dependency. "Still filtered?" is
  read from `input.defaultValue`, the server-rendered value *attribute*, which the user's editing never
  touches, so the check needs no new state mirroring the host. It routes through `onSearchFilterChanged`,
  which clears any commit held pending by the deferred-commit machinery, so a later blur cannot commit the
  same reset twice.
- **Mobile swallowed the render.** `refreshPanelData` returns early while `mobile && searchFocused`, so even a
  correct empty commit produced *no* render until blur (measured: `renders=0`, the rendered value still the
  old query). The reset now carries `renderNow` as `message[2]`, which the host turns into a one-render
  exemption from that hold — the hold itself stays armed, so ordinary commits while typing are still held
  (measured: still 0). A mobile render is a full webview reload, so the keyboard closes as a consequence;
  Cockpit neither blurs the field nor dismisses it.

On Android the × (`::-webkit-search-cancel-button`) is not rendered at all, so backspace-to-empty was the only
clear path on that platform — and it did nothing. The desktop × already worked and still does; its e2e test
now asserts the full list returns rather than merely that a commit fired.

Suite: 255 harness checks + 57 Playwright tests (56 run, 1 opt-in showcase skipped).

Process note: the device is the only oracle for touch. Two rounds of desktop E2E, a fuzzed pure module and
an adversarial review all passed over a bug that a single hold on a real Pixel exposed in seconds — and
the fix was a stylesheet the JS review had no reason to look at. When porting an interaction, diff the CSS
of the proven path too, not just its code.

## 2026-08-24 — v1.9.10: any:1 restored, and the third go at the mobile long press

### any:1 showed everything (desktop and mobile)

`tag:a tag:b tag:c any:1` listed notes with none of those tags. Diagnosed by logging the query Cockpit
actually sends before blaming anyone: `type:todo    tag:showcase tag:blog tag:main any:1`. Cockpit builds
its searches by concatenating its OWN narrowing onto the user's criteria — `type:todo`, `iscompleted:0`,
`due:19700201`, the excluded-notebook clauses — and Joplin's `any:1` ORs every term in the string. So each
of Cockpit's constraints became an alternative, and `type:todo` alone matches every to-do: the filter
collapsed entirely. Layer (b) of the three hypotheses; the search API and any client-side parser were
innocent.

Fixed where it broke: when the criteria carry a whole-token `any:1`, the user's string is sent **verbatim**
and Cockpit's narrowing is applied to the results instead (`applyTodoNarrowing` / `applyNoteNarrowing`), so
it stays a constraint whatever the user's terms do. Without `any:1` the query is byte-identical to before,
so the common path is untouched. `notebook:` is deliberately left in the query — Joplin keeps notebook scope
as AND even under any:1 — and the excluded-notebook ids were always the client-side authority, so dropping
their clauses costs only a wider first page. Detection errs towards the client-side path, which returns the
same rows: the safe direction to be wrong in.

The harness stub had to learn the shape too: an any:1 search is type-less, which the stub previously read as
the outside-results peek. E2E proof has teeth — with the fix disabled the third to-do reappears.

### The mobile long press, round three

Two device rounds had already failed. The decisive local check this time was what the PROVEN to-do-row
adapter does, and it falsified the working hypothesis: it does **not** `preventDefault()` on pointerdown —
but it **does** swallow the synthetic click the browser fires after a touch gesture, and this list never
did. That click lands wherever the gesture ended; a click outside the list runs `closeAllDropdowns`, which
removes the list while leaving the typed text in the field — precisely the reported "the window closes and
bare `tag:` remains". Both halves are now fixed: the click is swallowed (mobile, capture phase), and the
touch `pointerdown` on a row cancels its default action, which stops the focus change and the native
selection at source rather than suppressing and restoring them. The earlier round had left that default in
place on the belief that cancelling it blocks panning; that is wrong — panning is governed by `touch-action`
(still `pan-y`) and by `touchstart`/`touchmove`.

And because guessing has now cost two device sessions, 1.9.10 ships a diagnostic: a default-off, mobile-only
"Gesture trace" setting that replaces the suggestion list's hint line with the last few gesture events —
including WHY the list closed (`list-closed:field-left`, `:menus-closed`, `:commit`, `:escape`, …). If the
next device round fails, the trace can be read back instead of theorised about.

Review round on the delta found both mobile deltas carried a one-line defect that defeated its own purpose,
each measured with real touch emulation (CDP `Input.dispatchTouchEvent`) rather than reasoned about:

- **The click-swallower arm leaked.** It was set on pointerdown and cleared *only* by the swallower consuming
  a click — but a press cancelled by a scroll produces no synthetic click at all, so the arm survived and the
  next click *anywhere* (the listener is on the document) was eaten. Repro: long-press to mark, scroll, tap
  Apply, nothing happens until a second tap. Now released a tick after the gesture ends, however it ends —
  and the swallow is scoped to clicks landing OUTSIDE the list, which makes it deterministic instead of a race
  with that release: a click inside the list is already safe, and is usually a control the user meant to press.
- **The gesture trace was dead code.** The flag reached the data island but `readSearchData()` never returned
  it, so `gestureTraceEnabled()` read `undefined` and the diagnostic never ran. Surfaced, and now read once per
  render into a cached boolean rather than JSON-parsing the island on every traced pointer event, which is what
  makes "costs nothing when off" true. The harness now drives the real reader against a real island, so a
  missing property fails here instead of on a device.

Also: the any-mode cache key is self-describing (it carries the narrowing state it applied, since an any:1
query no longer encodes it), and the e2e union test asserts the exact row count, not just membership.

Suite: 262 harness checks + 58 Playwright tests (57 run, 1 opt-in showcase skipped).

Process note: two multi-edit scripts aborted midway on a bad assertion and silently discarded *all* their
edits — including one I had reported as applied. That is how the dead-code trace shipped. Write edits
per-item, and verify the file afterwards rather than trusting the script exited.

Process note: three of the four assertion failures this round were my own test premises, not product bugs —
twice a regex matched the word `preventDefault` inside the comment explaining its absence. Pin behaviour by
matching the CALL, never the word.
