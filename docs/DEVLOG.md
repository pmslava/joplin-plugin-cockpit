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

## 2026-08-24 — v1.9.11: committed searches actually filter on mobile

Pixel round 3: long-press multi-select works, desktop is good, but committing a search — `tag:`,
`notebook:`, `title:`, by pick, apply button or Enter — left the list unfiltered. Slava saw the filtered
view flash twice: once on pressing the ×, once on reopening the panel.

**Diagnosed against the harness before changing anything**, and the whole picture came out of three
measured sequences.

- **The primary bug**: a commit with the field focused rendered **0 times**. `refreshPanelData`
  early-returns while `mobile && searchFocused`, and every commit path deliberately keeps the field
  focused so the soft keyboard stays up. The commit landed host-side — `searchFilter` was set — and the
  paint was swallowed. Hence "it behaves like search doesn't implement at all".
- **The × flash, explained**: pressing × blurs the field / closes the keyboard, which posts
  `searchFocusChanged(false)`; the host then runs the refresh it had been *holding*, and that paints the
  filtered view — the flash. The empty-field auto-reset immediately commits `""` (with `renderNow`) and
  paints the unfiltered view over it. Measured as renders 0 → 1 (`value="tag:foo"`) → 1 (`value=""`).
  Nothing was actively reverting: it was the held render finally landing, then the user's own × .
- **The reopen flash**: measured, and **no path commits `""` the user did not ask for**. A fresh webview
  bootstrap (`dialogGuardReset`) renders nothing by itself and leaves the committed filter intact, as does
  a following refresh. The observation is the same hold mechanism — a held render landing on reopen, over
  a document served from before the commit. Proven absent rather than assumed; final confirmation is a
  device check.

**The rule, per manager decision**: every EXPLICIT commit renders. `renderNow` is now the **default** of
`onSearchFilterChanged`, because all four of its call sites are explicit user commits — a picked
suggestion, an applied multi-select, Enter in the field, the clear button / blur-change — plus the
empty-field reset. A future non-commit caller must opt out with `{ renderNow: false }`, so a commit path
cannot silently forget it. The hold keeps doing its real job: typing never reaches this function, and an
unflagged commit is still held (measured: still 0 renders).

Desktop is provably unaffected: the same commit rendered with and without the flag produces the same
render count and **byte-identical markup**.

Suite: 265 harness checks + 58 Playwright tests (57 run, 1 opt-in showcase skipped).

## 2026-08-24 — v2.0.0: multi-select token search, and mobile search parity

The public jump is **1.9.4 → 2.0.0**: 1.9.6–1.9.11 were internal steps, never published, and the entries
above are their development detail. This is the user-facing sum.

**Multi-select in the search field's token dropdowns** — the headline, and the reason for the major bump.
`tag:`, `notebook:` and `title:` all gained it. The list is ~15 rows tall and scrolls, with its own filter
box pinned above the rows and a muted hint below them. Rows are MARKED and inserted together: Ctrl/Cmd+click
on desktop, and on touch a 500 ms long press marks the first row and enters selection mode, after which a
plain tap toggles. An apply button appears beside the filter box whenever anything is marked, doubling as
the selection-mode indicator. Marks are held by value, so filtering the list, clearing the filter and typing
past the last match all leave them intact, and a background re-render carries an in-progress selection
across. Escape unwinds one step at a time — marks, then filter text, then the list.

Insertion is a pure, tested module (`src/ui/panel/searchTokens.js`): it replaces ONLY the incomplete token
being completed and returns everything either side byte-identical, so other tokens, free text, `any:1` and
negations all survive. Quoting, spacing and a quote-aware duplicate skip live there too.

**Search that behaves**, from four bugs found across desktop review and three Pixel sessions:

- `any:1` listed everything. Cockpit concatenates its own narrowing (`type:todo`, `iscompleted:0`, `due:`)
  onto the user's query, and Joplin's `any:1` ORs every term — so `type:todo` alone matched every to-do and
  the filter collapsed. The user's string is now sent verbatim and the narrowing applied to the results.
- Clearing the field returns the panel to "all" by itself, however it was emptied. This was unreachable on
  mobile, where the soft keyboard has no committing Enter and Android renders no clear button.
- On mobile, a committed search never painted: every commit path keeps the field focused so the keyboard
  stays up, and the render hold swallowed the paint. Every explicit commit now renders.
- Reaching into the dropdown no longer breaks the search: clicking its filter box used to commit the
  half-typed query and tear the list down, and clicking back into the field destroyed the marks.

**Mobile long press**, which took three device rounds. The gesture was a faithful copy of the proven to-do
row adapter — except for its CSS, so Android's native long press won and took the pointer. It now carries
the same `-webkit-touch-callout`/`user-select` suppression (plus `touch-action: pan-y`, so the list still
scrolls), cancels the touch pointerdown's default action, and swallows the synthetic click the way the
to-do adapter always has. A default-off "Gesture trace" setting can replace the list's hint line with the
last few touch events, so a touch problem can be reported instead of guessed at.

**Also shipping, from the unpublished 1.9.6–1.9.7 steps**: the panel's menus and dropdowns now dismiss on a
click anywhere outside the panel iframe, not just inside it; the row highlight follows the note the main
editor is showing, wherever it was opened from, without ever joining a drag or batch selection; Escape on a
multi-selection collapses it to the last row selected rather than clearing it; the create buttons measure
themselves and degrade in two stages instead of wrapping; and the "New to-do" glyph is a ring with a
checkmark, matching the panel's own language, instead of the note icon with a tick on it.

Suite: 265 harness checks + 58 Playwright tests (57 run, 1 opt-in showcase skipped).

Process notes from this batch, worth keeping: the device is the only oracle for touch — two desktop E2E
rounds, a fuzzed pure module and an adversarial review all passed over a bug a single hold on a real Pixel
exposed in seconds, and the fix was a stylesheet. Diagnose before fixing: the `any:1` and mobile-render bugs
were both found by logging what was actually sent and counting renders, and in both cases the layer everyone
suspected was innocent. And pin behaviour by matching the CALL, never the word — several review rounds were
spent on assertions that matched `preventDefault` inside the comment explaining its absence.

## 2026-08-24 — v2.1.0: notes join the selection, and the search survives what interrupts it

Five items, triaged by Slava. The headline is a **capability**, not a regression, and that is what set the
minor bump: note rows have never taken part in the panel's multi-selection. Established from the code and
from git history rather than assumed — the very commit that introduced row selection (`71c435a`, 1.0.3)
already had `onNoteRowMouseDown` **clear** `selectedTodoIDs` and set the highlight-only `pickedNoteID`
instead, and every later change (1.8.1 row-wide open, 1.9.1 multi-drag preserve, 1.9.4 batch context menu,
1.9.6 editor highlight, 1.9.7 Escape collapse) left that asymmetry in place. So: a gap since 1.0.3 → 2.1.0.

**A. Note rows select, and a mixed selection is ordinary.** The two row handlers became ONE path. A new pure
module `src/ui/panel/rowSelection.js` (`window.RowSelection`, UMD like `editorNote.js` / `noteMenu.js` /
`searchTokens.js`, `addScript`ed before `panelWebview.js`) holds the three decisions — `pressSelection`
(plain / Ctrl / Shift, both anchors), `clickSelection` (the collapse a drag-less click makes, with a
`changed` flag so a single click never repaints), `schedulableIDs` — and `onTodoRowMouseDown` /
`onNoteRowMouseDown` are now two-line wrappers over `onRowPressed`, `onTodoRowClicked` /
`onNoteRowClicked` over `onRowClicked`. The store is renamed `selectedTodoIDs` → `selectedRowIDs` (and
`lastClickedTodoID` → `lastClickedRowID`): the old name would now actively mislead. Every invariant extends
by construction rather than by copying — mousedown-on-selected preserves, click collapses, Escape collapses
to the last SELECTING press, and the editor-tracking highlight still never joins a batch. A note row also
gained the modifier guard its to-do twin always had: Ctrl-clicking a tenth row into a batch must not also move
the editor.

**The read-only peek stays out, and adversarial review found that it did not.** `allSelectableRows()` excludes
`.outside-results` from the Shift range and the Escape collapse, and `formats.ts` drops the selection
`onmousedown` from every peek row (`renderTodoRowHtml(draggable:false)` / `renderNoteRowHtml(selectable:false)`)
— but those rows still emit `onclick` unconditionally, because click-to-open is what the peek is FOR. So the
new shared `onRowClicked` collapse wrote a peek row straight into `selectedRowIDs`, where it persisted across
renders; and since a selection now drives the batch menu, that made Delete / Move / Tags / Duplicate /
Switch-type reachable on rows the user was deliberately shown read-only, from outside their own filters and
even from excluded notebooks. The to-do half of the hole predated this release; making the selection
batch-capable is what turned it into a data-loss path. `onRowClicked` now refuses a row inside
`.outside-results` — the same selector `allSelectableRows()` uses — and skips only the selection half, so the
peek still opens.

A second, pre-existing writer turned up in the same audit and is closed with it: the **tick circle's right
click** (`onTodoContextMenu`). `draggable:false` suppresses neither `oncontextmenu` nor the `.todo-checkbox`
element, so right-clicking a peek to-do's circle seeded `selectedRowIDs` with the peek row, opened the due-date
picker for it, and left that id sitting in the selection where Ctrl+adding an ordinary row afterwards made the
batch menu act on both. The branch now bails on `.outside-results` before it seeds anything — the peek is not a
drag-reschedule source, so it must not be a right-click-reschedule source either. The row's other right-click
zones are untouched: they open the single-note menu, which is what a peeked note is for.

Three checks pin all of it. The two on the HANDLERS — the click guard sitting before the collapse with the open
still happening, and the tick-circle guard sitting before the seed and before `requestAlarm` — both fail against
the pre-fix source. The third, on the rendered markup (peek rows carry `onclick`, never `onmousedown`), does
**not**: `formats.ts` was never the broken half, so it passes either way. It is kept deliberately, as a
regression pin on the assumption the handler guards rely on — if a peek row ever gains a selection `onmousedown`
the guards above stop being sufficient — but it is not evidence the bug existed, and should not be counted as
such.

The lesson: an exclusion asserted on the ORDER helper is not an exclusion on the SELECTION. `allSelectableRows()`
excluded the peek from day one and its test passed throughout, while two other paths wrote peek ids straight
into the store. Pin the writers, not the reader.

Batch actions needed **no host change at all** — Joplin has one note store, `runNoteMenuActionMulti` already
took an id array, and `toggleType` already flipped each note's own type — which a new mixed-kind host test
now pins so nothing later starts filtering on `is_todo`. The menu labels are deliberately unchanged:
"Delete 3 notes" is true of a mixed set (a to-do IS a note), and "Switch type of 3 items" already read for
both.

**Where the kind does matter is TIME.** Only a to-do carries `todo_due`, so the drag payload, the
between-drop and the set-alarm call now go through `schedulableSelection()` — the to-dos within the
selection, in selection order, notes silently dropped. The empty case is expressed the way the drag code
naturally does: `onTodoDragStart` calls `event.preventDefault()` and starts no drag. It is unreachable in
practice (only a to-do row is `draggable`, and the pressed row is in the selection by then), so this is a
guard rather than a behaviour.

**B. The dropdown's filter box survives a background re-render** ("Sync is a very often thing here"). The
marks already rode across a reconcile; the embedded filter text did not, so a sync landing mid-selection
widened the list back out and threw the caret back to the search field. The box lives in the markup the host
replaces, so by the time `reconcile` runs its node is gone — the text and caret are therefore mirrored into
module state as they are typed (`applySuggestFilter`, which Escape's clear also routes through), alongside a
`searchFocusTarget` of `field` / `filter` / `apply`. `reconcile` now carries an OPEN LIST across (not merely
"marks exist"), and the restore is applied by whichever list is built next — a `pendingSuggestRestore`
consumed once by `renderSearchSuggestions` — which is what makes it work for `title:`, whose list arrives a
debounced round-trip later rather than synchronously.

**C. Mobile renderer-kill survival for the search draft and its marks** (the 1.9.8 "accepted gap", now
closed — Option B). The host holds a `searchState` `{ draft, caret, marks, filter, filterCaret, focus }`,
posted throttled at 300 ms mirroring `queueOverlayState`, embedded as a `<script id="cockpitSearchState">`
island beside `#cockpitOverlayState`, and restored by `reconcile` on a fresh webview: the draft goes back,
the field is refocused (which re-arms the host's hold — without it the next refresh wipes the restore), and
`onSearchInput` is re-run so the list and the marks come back. `dialogGuardReset` grew a third argument, the
same non-looping handshake the overlay uses, and one render serves both islands. **No `dialogGuard`
involvement**, deliberately: the dropdown opens and closes on every keystroke, whereas an overlay has two
call sites, so bracketing it is a leak hazard whose failure mode is refreshes frozen forever — and the focus
hold already pauses them. This also closes the pre-existing "typed query lost on an Android renderer kill",
which predates the dropdown entirely. The trap that had to be designed around: `onSearchInput` runs
`maybeAutoResetSearch`, which reads "still filtered" off `input.defaultValue` — untouched by a restore — so
an empty restored draft would have looked exactly like the user emptying the field and committed a reset
nobody asked for. The restore arms `searchResetPosted`; the first keystroke clears it again.

**D. Post-commit keystrokes.** The mechanism, stated honestly: a commit nulls `searchDraft`, so a render
landing afterwards repaints the freshly rendered field from its *server-rendered* value. Reading the code, a
character typed after the commit fires `input` and re-establishes the draft before any render can land — so
the pure "lost keystrokes" path could not be reproduced from the source. What IS reachable, and is the same
window, is a render built BEFORE the commit reaching the host (a background refresh already in flight):
`searchDraft` is null, the server value lags, and the field is repainted back to the previous query with the
user's text on top of it — the "corrupts the free text" the e2e comments already describe. The fix closes the
window at the only point where ground truth exists: the blur of the OUTGOING field, which this build fires
with the node still connected and still holding what the user typed. That snapshot is the restore's
**fallback**, never its first choice (a live draft always wins), and it is cleared by every commit and by a
genuine departure, so it can never repaint a value the user has superseded — the case that would otherwise
undo an apply. Proved behaviourally in e2e: Enter, then three characters typed with no settle at all.

**E. The × double-post.** Pressing the clear button fires `input` (on which the empty-field auto-reset
commits `""`) and then `change` and `search` (which reach the deferred commit with the same `""`), so the
host absorbed one or two duplicates on its equality guard. That equality *is* the no-op case, so the
deferred commit now drops itself when its value equals what this webview last asked the host to hold. The
"last committed" anchor is re-read from `input.defaultValue` on every render, because the host can move the
filter without the webview committing anything — a profile switch applies the profile's own `panelSearch` —
and comparing against a stale anchor would drop a commit that was not a no-op. The explicit commits (Enter, a
pick, an apply, the auto-reset) are untouched, so re-running the same query from the keyboard still renders.

**F. E2E lock, in lockstep with HARPER** (harper only — ridgeline still runs the older protocol and is being
brought across separately; nothing here should be read as "all three repos agree"). The earlier "harper
doesn't take the lock" note was wrong: harper has had the identical `~/.cache/joplin-plugin-e2e.lock` mkdir
protocol since its `29e31b4`. The real gap was that BOTH repos failed fast when the lock was held, so the
second session had to poll by hand. Ported from harper's `866b825`: `acquireLock()` is now async and queues
behind a live run (2 s poll, progress every 30 s, `E2E_LOCK_WAIT_MS` budget defaulting to 10 minutes, `0`
restores fail-fast), the lock directory gains an advisory `owner` file (repo path + start time) so a waiter can
name WHICH repo holds it, and two protocol races cockpit still carried are fixed — a lock whose `pid` file has
not been written yet is presumed LIVE for 30 s (otherwise a second acquirer breaks a live lock), and a stale
lock is broken by an atomic rename-aside rather than `rm -rf` + `mkdir` (so exactly one racer can win).
`releaseLock()` refuses to remove a lock whose pid is no longer ours, and `globalSetup` releases it when the
sweep or the RAM gate throws — Playwright skips `globalTeardown` on a `globalSetup` throw, so a failed gate
would otherwise leave the lock standing until the exit handler happened to fire, and a lock nobody owns is
exactly what makes the next run wait out its whole budget. `globalTimeout` covers `globalSetup`, so the wait
budget is added on top LOCALLY only — CI keeps its budget exactly where the job's 20-minute cap needs it.

Deferred to a follow-up (reviewed, none of them reachable in this harness's own flow): the pid-write
`try/catch` swallows a failure that would leave a pid-less lock; `readProc` EACCES noise; no SIGHUP handler;
`Number.isFinite` vs `Number.isInteger` on the pid read; `mtimeMs` rather than `birthtimeMs` for the lock age;
and the rename-aside debris (`…lock.stale-*`) is removed immediately but never swept if that removal fails.

Suite: 276 harness checks + 65 Playwright tests (64 run, 1 opt-in showcase skipped).

Process note: three of the new checks failed first on MY OWN premise, not on the product — the sharpest one
being an e2e that seeded a mixed selection with a plain press and inherited the previous test's selection,
because a plain press on a row already inside a multi-selection deliberately PRESERVES the set. The rule
being exercised was the rule that broke the fixture. Seed a selection with press + CLICK (the collapse half
of that same rule), never with a press alone.

## 2026-08-27 — v2.1.1: the type flip paints on the click, not on the index

One user report carrying two symptoms: switching an item between note and to-do type reached the panel only
after ~5 seconds, and for a while the item rendered TWICE — once in a to-do section, once under NOTES. Both
fall out of the same architectural fact: the panel's two areas are two SEPARATE searches (`type:todo` /
`type:note`) against Joplin's FTS index, and that index lags an `is_todo` write — `notes_normalized` is
refreshed by `scheduleSyncTables` on a 10-second `setTimeout`, with no sync inside `search()` itself. The only
correction was the reconcile ladder (1/3/7/15/30s); the index usually settles between the 3s and 7s rungs, so
the corrected placement first painted at 7s. The double rendering was the optimistic overlay's data model: one
`isTodo` boolean per entry can say "insert me here" but not "and remove me THERE", so while the index lagged,
both queries served the id at once. Cockpit's own toggle was the worst producer — it wrote nothing optimistic
and immediately repainted the stale placement with a blind reconcile arm.

The fix, three independent parts. (1) The overlay is now authoritative about an id's TYPE: an entry inserts
into its type's list AND splices the id out of the other; suppresses cover both lists and retire only via
`finalizeOverlay`, which closes each render's per-list verdicts once both merges have run (a single merge only
ever sees half the answer — retiring inside one was exactly the old self-destruct that left stale NOTES rows
unremovable). (2) `toggleType` widens the GET it already made to the full reconcile field list, builds the
post-flip record locally, and captures it through `applyTypeFlipOptimistically` — same questions as the
external reconcile (trash first, then `noteMatchesView`), so the `onNoteChange` our own PUT fires re-derives
an identical entry. Captured flips repaint from the overlay (`optimistic: true`) with an early-stoppable arm.
(3) `getTodos`/`getNotes` drop rows whose own `is_todo` contradicts their list — the payload's fields are read
from the LIVE notes table even when the match set is stale, which is why this works and why the any:1
client-side narrowing always worked. Measured on the real app: 54–283ms to the new section, never both.

Two review rounds earned their keep. Round one upheld seven findings, the sharpest three: flipping the stale
row of a note already TRASHED elsewhere resurrected it for the overlay TTL (the GET lacked `deleted_time`;
search never returns trashed notes, so nothing could retire the insert); the whole suite stayed green with the
widened GET reverted to `['is_todo']` — the harness handed back full fixtures regardless of `query.fields`, so
the load-bearing field list was pinned by nothing (harness now projects fields, like the real API); and on
views only a search can decide (searchCriteria / typed text) the new filter made the flipped row VANISH from
both sections — an explicit user action reading as a delete — hence `keepMistypedRows`: those views keep the
row where the index still files it, exactly the pre-fix behavior, never blanked and never doubled. Round two
caught a regression before it shipped (a flip-to-hidden suppress outliving the very switch the user re-enabled
— view-miss suppresses now carry their record so revalidation can take them back; DROPPED, not promoted to
inserts, or the trash mechanism above returns) and the finalize view-key race (one notebook-filter snapshot
per render, threaded through key, predicate, merges, and finalize — `noteMatchesView` takes the filter as a
parameter now, so no judgement can read the live global mid-await). A follow-up closed the sibling orphan the
review flagged: trashing a TICKED to-do left its completion override pending for the full TTL, blocking the
lane's early stop; the external-reconcile clear now covers `trashed || !is_todo`, and Cockpit's own delete
paths were audited as covered (they write nothing optimistic; our own writes reach the same reconcile).

Joplin facts settled empirically along the way: a data-API change to a note that is NOT selected/open fires NO
`onNoteChange` to plugins at all (the e2e spec selects the note before the API flip); menu accelerators and
the command palette are handled outside the renderer, so a CDP-driven Ctrl+Shift+P does nothing — the data API
is the only GUI-independent path to "Joplin's own" mutations.

Suite: 292 harness checks + 68 Playwright tests (67 run, 1 opt-in showcase skipped). Every fix in both rounds
was mutation-verified — the fix line reverted, the build re-run, exactly its pin failing, the fix restored.

## 2026-08-28 — v2.1.2: "Copy Markdown link" and "Copy note ID" copy again

Both clipboard entries in the panel's row context menu copied nothing and raised a plugin dialog,
"Cockpit: the clipboard is not available here." — single row and multi-selection alike, on a live desktop
Joplin 3.7.10. It looked like a 3.7 regression in `joplin.clipboard`. It was Cockpit's own defensive guard,
it was never version-specific, and `joplin.clipboard` is neither absent nor broken.

**The root cause is that `joplin` is not an object.** `plugin_index.js` ends with
`globalObject.joplin = sandboxProxy(wrappedTarget)`, and `sandboxProxy`'s `handler.get` records the call path
by MUTATING a shared array on the target it creates: the first member read seeds `__joplinNamespace = [prop]`,
every later read `push`es, and ONLY `handler.apply` pops. A member that is read but never called therefore
leaks a permanent segment onto that chain. The old guard read `joplin.clipboard` (path `clipboard`), then read
`clipboard.writeText` for a `typeof` (path `clipboard.writeText`, never called, never popped), then read it
again to call it — so the host received `joplin.clipboard.writeText.writeText`, `executeSandboxCall` walked it
into `undefined`, and threw `Property or method "writeText" does not exist in ...`. The guard could never have
worked in the first place: a Proxy over a function is always truthy and always `typeof 'function'`, so it can
neither detect an absent API nor pass information — it can only corrupt the path it was inspecting. The damage
is scoped to the target that one `joplin.clipboard` read created, which is exactly why only these two menu
items broke while the rest of the plugin was untouched. Same class as laurent22/joplin#4569
(`joplin.views.dialogs.open.setHtml`); no upstream clipboard issue exists, and
`sandboxProxy.js`/`plugin_index.js` are byte-identical between the 3.6.14 e2e fixture and the live 3.7.10 asar.

The fix, three parts. (1) `copyToClipboard` is now **one uninterrupted expression**,
`await (joplin as any).clipboard.writeText(text)` inside the try — a plugin cannot inspect the API, only call
it and catch, which is also the only way to learn that a runtime has no clipboard at all (iOS refuses one by
App Store rule). (2) The failure notice is the panel's **own toast** on both platforms, never a plugin dialog:
on desktop `showMessageBox` is `showMessageBoxSync`, a native modal that blocks the whole app until dismissed
— a hostile price for a failed copy — and on mobile a dialog opens behind the panel overlay. It travels as a
`panelToast` message on the single existing `onMessage` chain (Joplin allows one handler per view), and every
copy branch returns before the post-mutation refresh trio, so no `setHtml` can be in flight when it lands.
(3) The link text is built once by `markdownNoteLink`, byte-identical to Joplin's `Note.markdownTag`: square
brackets in the title are backslash-escaped, or a `]` closes the label early and the link stops parsing.
Parentheses are deliberately left alone — they sit inside the label, and the URL is `:/` plus a 32-character
hex id, so the app's `escapeLinkUrl` would be a no-op. Both branches use it; the batch join stays a newline,
where Joplin joins with a space.

The harness gained a **structural pin against the whole class of bug**: no `joplin.*` member may be read
without being called in the same expression. That is the rule the old guard broke, and grepping for `typeof`
on a proxy member catches the next one before a device does.

Suite: 296 harness checks + 73 Playwright tests (five new in `e2e/clipboard-copy.spec.ts`, reading the real
system clipboard through the main renderer's own `require('electron').clipboard` — never `xclip -i`, which
stays alive to own the X selection and would hang the worker; every probe is bounded, because the failure
being guarded against is precisely a native modal, and with one open `evaluate()` never returns).

## 2026-09-02 — v2.1.3: the last day of a month, and of the year, stays in its own group

Marxsal opened issue #3: "If you have an item that has the date that is the last day of the year, it is put
into 'future' rather than 'this year'." He was right, and the same shape was hiding one horizon down — the
last day of any month skipped "This Month" and showed up under "This Year", a lone row with a date a day
past the group it sat in.

**Both horizons ended at midnight instead of at the end of the day.** `IntervalFormat.getFormatHeadingString`
walks a strict chain — `< getStartOfToday()` is Overdue, then `< getEndOfToday()`, `< getEndOfTomorrow()`,
`< getEndOfThisWeek()`, `< getEndOfThisMonth()`, `< getEndOfThisYear()`, else Future. Every one of those ends
at the last millisecond of its period except two: `getEndOfThisYear()` returned `new Date(y, 11, 31)`, which
is December 31st at 00:00:00.000, and `getEndOfThisMonth()` returned `new Date(y, m + 1, 0)`, the last day of
the month at the same midnight. A to-do due at any ordinary hour on either of those days is therefore NOT
less than its own boundary, and falls through to the next group — into Future off the end of the year, into
This Year off the end of the month. Nothing about the chain or its operators was wrong; the two ends simply
named the wrong instant. The month half had even been met before and worked around rather than fixed: the
showcase capture pins its "This Month" fixture to the second-to-last day, with a comment explaining why the
last day would look broken. That comment now records the fix instead of the bug.

The fix is one line per helper. Both keep building their date from local components — no UTC arithmetic, no
ISO parsing — and then `setHours(23,59,59,999)`, exactly as `getEndOfToday()`, `getEndOfTomorrow()` and
`endOfWeek()` already do, so daylight saving cannot shift them. The drop targets are untouched and unchanged
by construction: `getHeadingDropTarget` passes both values through `toISODate()`, which reads only year,
month and day, and 23:59:59.999 is the same local day as 00:00:00.000.

Five regression checks pin it, and they had to be built carefully, because the harness has no fake clock —
every check runs on the real date. Each seeds a to-do whose due date is computed from that clock with local
`Date` constructors (the last day of this month and December 31st at 22:00, the first day of next month and
January 1st at noon), renders an interval profile, then reads back which `<h2>` group the row landed under by
splitting the panel HTML on its headings in document order. None of them asserts a single heading, because
the right answer genuinely moves with the date: the last day of this month is legitimately Today on the 30th
of September, Tomorrow on the 29th, This Week in the closing days of a month, and This Month otherwise — so
the check asserts membership in that SET, and the bug is that the set excludes This Year and Future. December
31st likewise ranges over Today, Tomorrow, This Week, This Month and This Year and can never be Future on any
day of any year, leap years included. The two counter-checks run the other way: the first day of next month
must never be This Month, and January 1st of next year never This Month or This Year, so a fix that simply
widened every horizon would fail them. The fifth check stops the drop targets from being an argument: it
reads the `data-drop` of the This Month and This Year headings out of the same rendered panel and pins each
to its own last day. Both headings only exist when their group is non-empty, so it looks away in the closing
days of a month and in December — as do the two positive heading checks, which an earlier horizon then
satisfies with or without the fix. That blind spot is now written into the block comment above them, so a
green run at a month edge is not over-trusted.

Each helper was mutation-verified on its own, in both directions — the build re-run each time, exactly one
check failing and nothing else, then restored: each `setHours` line reverted in turn ("December 31st landed
under Future" for the year, "the last day of the month landed under This Year" for the month), and then each
helper widened the wrong way instead — to the first day of the next period at midnight, which the heading
checks cannot see at all — failing only the drop-target check. All four mutations were run on September 2nd,
mid-month, where every check discriminates.

Suite: 301 harness checks (five new), all passing. Playwright untouched by this pass — 79 tests (72 run, 7
opt-in showcase captures skipped without `SHOWCASE=1`; commit f579b42 grew `showcase.spec.ts` from one test
to seven after the v2.1.2 entry recorded 73, which is why that number moved without a test being written
here). The e2e suite was not run in this pass, only its showcase comment edited.

## 2026-09-02 — drag auto-scroll at the list edges (ships with v2.2.0)

Slava, dragging a to-do in a long agenda: "It is impossible to drag items to the required date, because it is
out of the list and I can't move it while dragging." He is right, and it is the whole gesture that is blocked,
not a corner of it: once a native drag has the pointer, the wheel does not follow it, and a heading, a calendar
day or a between-rows gap that is not already on screen can never be reached — the list simply will not move.

**The browser's own drag auto-scroll has nothing to scroll here.** Whatever Chromium does for a dragged pointer
near the edge of a scrolling *document*, this document does not scroll: Joplin's webview skeleton sets
`overflow: hidden` on the html element (panel.css says so where it explains the wrapper), `#joplin-plugin-content`
is pinned to exactly `100vh` with `overflow: hidden` of its own, and every scrollable pixel in a list view lives
inside one inner element — `.todos`, `flex: 1 1 auto; min-height: 0; overflow-y: auto`. So the scrolling that
would have to happen is an inner scroller's, and nothing in the platform was going to do it for us.

The fix is a small helper in `panelWebview.js`, written input-agnostic on purpose. It knows nothing about drag
events: `update(container, clientY, onScroll)` aims it at a scroller and a pointer position, `stop()` ends it.
The edge band is `clamp(15% of the container's client height, 32px, 72px)` — and additionally clamped to half
the height, so the two bands can never overlap in a short container — and the speed rises linearly with how deep
into the band the pointer is, from 2 px/frame at the band's inner edge to 16 px/frame at the container's own
edge, driven by `requestAnimationFrame`. All six numbers are named constants at the top of the section, so the
feel can be tuned without reading the maths. The container is the nearest vertically scrollable ancestor of the
element under the pointer, falling back to the live `.todos`; in practice it is always `.todos`, and the
fallback only covers a pointer resting on something that does not scroll (a heading, the padding).

Nothing outlives a gesture, which is the part worth being strict about — a list that keeps moving after the drop
would be worse than one that never moved. The loop stops when the pointer leaves the band, on `drop`, on
`dragend`, at the scroll limit (a frame that does not change `scrollTop` ends it), and on a watchdog: a native
drag keeps sending `dragover` while it is over the document, so `AUTOSCROLL_IDLE_MS` (150ms) of silence means
the pointer has left the window, or the drag ended without an event reaching us. `stop()` cancels the pending
frame, so there is no rAF and no timer left standing either way. The wiring is delegated on the document like
the between-rows gesture — one wiring that survives every `setHtml` — and it is doubly gated: `IS_MOBILE` (there
is no HTML5 drag there at all) and `panelDragActive`, raised only by this panel's own `onTodoDragStart`, so text
or a file dragged in from another window can never make the list run away under the cursor.

One thing did not survive contact with the design. The insertion line between rows is resolved from a pixel band
inside the row under the pointer, and while the list is scrolling the rows move under a pointer that is holding
perfectly still — the browser's next `dragover` can be a few hundred milliseconds away, which at 16 px/frame is
a couple of hundred pixels of lag in a line that is meant to sit in a specific gap. So `betweenTargetFor` was
split into a coordinate form, `betweenTargetAt(element, clientY)`, the indicator painting was factored out into
`paintBetweenIndicator`, and the scroll loop re-asks the question after every frame that moved, from
`document.elementFromPoint` at the last pointer position — the same answer a `dragover` there would have given.
The whole-row targets (headings, calendar days, week columns) are left to re-highlight on their own next
`dragover`: they are room-sized rather than pixel-banded, and their inline handlers own that class. The
programmatic scroll deliberately flows through the existing `.todos` scroll listener, so the position is saved
and posted exactly as a user scroll is; `restoringScroll` only ever covers the two frames after a re-render
installs a fresh container, and a mid-drag re-render is self-healing anyway — the loop's old node is detached,
its `scrollTop` stops changing, the limit check ends it, and the next `dragover` finds the new `.todos`.

Three harness pins guard the wiring rather than the maths, in the style of the between-drop source pins (the
harness cannot execute the webview, so these read its source): the document `dragover` path feeds the helper and
both `drop` and `dragend` end the drag; the watchdog constant and the check that uses it exist, and stopping
cancels the frame; and the handler is gated on `IS_MOBILE` and on the panel's own drag flag. Both mutations were
run and restored byte-identical — deleting the `dragend` wiring failed exactly "a dragend must end the panel
drag, and with it the scrolling", removing the watchdog line failed exactly "the loop must stop itself when no
update has arrived within the watchdog timeout", and nothing else moved. The band and speed curve were checked
separately by lifting the helper out of the file and running it against a fake container: 72px band at a 600px
height, −16 px/frame at the very top edge, −2 at the band's inner edge, 0 through the middle and outside the box,
and the loop stopping on the watchdog, at the limit, and on `stop()`.

`e2e/drag-autoscroll.spec.ts` is new: five cases driving the real handlers with the HTML5 sequence a browser
fires, measuring `.todos.scrollTop` around each phase — the bottom band scrolls down, the middle is inert, the
top band scrolls up, a `dragend` stops the scrolling while the pointer stays in the band and the events keep
arriving (so only the drag's end can explain it), and a foreign drag with no `dragstart` moves nothing. The
whole timed sequence runs inside one `frame.evaluate`, because a dragover dispatched per tick over CDP would put
the round-trip into the very interval being measured, and the watchdog is measured in exactly those
milliseconds. To have something to scroll, 60 undated to-dos are seeded through Joplin's data API rather than
the GUI (60 × "New to-do" would not fit in a `beforeAll`), and the suite refuses to start until the panel itself
reports `scrollHeight > clientHeight`. The two negative cases are measured ONCE rather than polled: an
`expect.poll` around a negative retries until a run happens to hold still, which is the failure they exist to
catch.

Suite: 304 harness checks (three new), all passing. e2e: 5 new tests, not run in this pass.
