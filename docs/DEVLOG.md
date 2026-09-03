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

## 2026-09-02 — v2.2.0: next-period horizons and the first-day drop

The interval view named its groups after periods, and on a Saturday that produced a "This Week" holding
nothing: the week ends tomorrow, and Today and Tomorrow have already taken both remaining days. The owner's
rule replaces the period with the SLICE — each group covers only the time the groups above it have not taken
— and when a slice comes out empty its slot goes to the next period instead. So a Saturday shows Next Week
(Mon the 7th through Sun the 13th, once Today and Tomorrow have eaten the 5th and 6th), the 29th of a month
shows This Week running into October and then Next Month for the 5th to the 31st, and every ordinary December
day shows Next Year, because December 31st is both this month's last day and this year's. A Next slice can
never itself be empty — its end always lies past the one above it — so the chain terminates after one step.

The drop rule changed with it, for all six period headings. Dropping onto "This Week" used to schedule the
to-do for Sunday, the end of the period; it now schedules it for the FIRST day of the group's slice, the day
after the previous group's last day. A plan that puts everything on the last day of the week is a plan that is
already too late. Today and Tomorrow are their own day as before, No Due Date still clears, and Overdue and
Future still name no date. The host-side time rule is untouched (the to-do keeps its own time of day, or takes
the profile day-start when it had none). Between-row drops did need a change, which the first pass missed and
the review caught: `betweenBounds` anchors a group's TOP edge on the heading's date — that one simply moved,
and improved, since the first day of a slice sits at or before every row in it — but it anchored the BOTTOM
edge on the same date, and the bottom edge needs the other end of the group. With the drop day now the first
day, `hi` landed before the group's own rows, the interval inverted, and every to-do dropped below the last row
of This/Next Week, Month or Year was pinned to that row's own due instead of spreading. So a heading that spans
a stretch of days now carries its last day too, as `data-drop-end` beside `data-drop`
(`dropEndDateFor` → `getHeadingDropEnd` → `dropTargetAttributes` → the webview's `betweenGroupInfo` → the
`todosDroppedBetween` message → `betweenBounds`'s new fifth argument), and the two edges anchor on their own
end. A one-day group — a Date-view heading, a calendar cell, Today, Tomorrow — sends none and behaves exactly
as before; a dateless group (Overdue/Future) still derives both ends from its neighbour.

The math went into a pure module, `src/core/horizons.js`, in the same UMD shape as `between.js`: every input
explicit, never `Date.now()` inside, all arithmetic on local calendar parts so no boundary moves across a DST
transition. `horizonPlan(nowMs, weekStartsOn)` returns the five ordered sections with their last millisecond
and their first day; `horizonOf`, `kindOf`, `dropDateFor` and `dropEndDateFor` are what the format asks it.
`IntervalFormat` now computes one plan per render (a formatter is built fresh for every render, so a lazily
memoised field IS per-render) and reads its headings, its row labels and its drop targets out of that one
plan, which is what keeps them from disagreeing. Row labels follow the section KIND rather than its name, so
Next Week reads like This Week and Next Month / Next Year like theirs. One deliberate behaviour change rides
along, worth naming because it is a boundary: 2.1.3 bucketed with a strict `due < end`, `horizonOf` uses `due
<= end`, so a to-do due at exactly 23:59:59.999 now stays in its own slice instead of falling into the next.
It is one millisecond, invisible at Joplin's second granularity, it makes the boundary claims in the owner's
acceptance calendars satisfiable at all, and it settles an old self-contradiction: `getCompletedBucket`
already used `<=`, so such a to-do got the "today" completed bucket and the "Tomorrow" heading. The five
`BaseFormat` period helpers the interval view no longer consults (`getStartOfTomorrow`, `getEndOfTomorrow`,
`getEndOfThisWeek`, `getEndOfThisMonth`, `getEndOfThisYear`) were deleted rather than left as a second,
diverging implementation of period ends — nothing in `src/`, `test/` or `e2e/` called them, and their banners
still narrated the 2.1.3 fix as if they were live. `getStartOfToday` and `getEndOfToday` stay:
`getCompletedBucket` uses both. Three now-unused calendar imports went with them (`endOfWeek`, and
`startOfDay` / `startOfWeek`, which had been dead in this file already), and `endOfWeek` itself followed in
the review round: `getEndOfThisWeek` had been its only caller anywhere, so the export left behind in
`calendar.ts` was a helper nothing could reach. Its sibling `startOfWeek` stays — `buildMonthGrid`,
`buildWeek` and `groupTodosByDate` still use it. The other formats are untouched.

Testing is in three layers. All eleven of the owner's confirmed calendars are pinned check by check — the
exact ordered names, every drop day, every slice's last day, and both sides of every boundary. Then an
exhaustive sweep: every day of 2026, 2027 and 2028 — 2028 a leap year, so February 29 is swept too — at
midnight, noon and the last millisecond of the day, for both week starts — 6576 plans — asserting that the
ends strictly increase, that a period is replaced by its Next exactly when its own end is already covered,
that each drop day buckets into its own slice while the day before it does not, that each slice owns its own
last millisecond and the next owns the one after, and that the Overdue and No Due Date ends of the chain hold.
The 2.1.3 heading checks were kept and their allowed sets widened to admit the Next names — and the widening
is not an offline computation the reader has to take on trust, which is exactly what the 2.1.3 entry above was
written to avoid: the four fixture dues and their allowed sets are one `horizonFixtureSets` table, a pure
check sweeps those same dues over 2024-2040 at three times of day and both week starts, and it asserts both
directions — every name the calendar reaches is in the set, and every name in the set is one the calendar
reaches, so neither a missing name nor a padded one survives. That bound is not silent either: the check opens
by asserting that the year the suite is actually running in lies inside the years it sweeps, so a run past
2040 fails THERE, with a message naming the bound to widen, rather than letting a rendered heading check fail
on a name its set was never asked about. Then the rendered panel: one run puts a to-do on the drop day of
every section, so all five headings render, and it pins each heading's text and `data-drop`, each heading's
`data-drop-end` where the slice spans more than a day, and each ROW's label against what the profile's own
formatting produces for that section's kind — the last of these is what pins feature item 3 end-to-end, where
`kindOf` alone could not. `data-drop-end` needed one more turn of the screw, which the second review round
caught: the rendered check compared it against `dropEndDateFor` — the very function that produced it — so any
wrong span agreed with itself and passed. It is now pinned to literals instead, against the owner's own
last-day column in all eleven calendars, against each slice's own end across the whole 2026-2028 sweep, and
against the null a heading that names no span must return. The plan is taken on both sides of every run and a
match against either is accepted; if midnight actually fell DURING a run the fixtures and the render belong to
different days, so those checks stand down for that one run rather than failing.

Nine mutations verified the checks, each run against the full build and then restored byte-identical; the
first three were re-run in the first review round, against the widened suite, so the counts below are the
measured ones. Making the week flip unconditional (`weekAbsorbed = false`) failed the three Next Week pins,
all three sweep checks and the fixture sweep — seven. Reverting every section's drop day to the last day of
its own period (the pre-2.2.0 rule) failed all eleven pinned calendars, the names check and the drop-day sweep
— thirteen. Loosening the absorption test to a strict `<` failed exactly the calendars where a period ends ON
the previous boundary — Saturday 5 September, Saturday 29 August and Thursday 10 December — plus all three
sweeps and the fixture sweep: seven. Then the four of the review round: anchoring the bottom edge on the first
day again (the regression itself) failed the two new `betweenBounds` checks and the new host-glue drop, three;
swapping the week and month branches of `getFormatTodoString` failed the row-label check alone, one — before
that check existed it passed the whole suite; returning null from `getHeadingDropEnd` failed the
heading-attribute check, one; and narrowing one published fixture set by a single name failed the fixture
sweep on a named December day, one. Then the two of the second round, both aimed at `dropEndDateFor` now that
it is pinned to literals: returning the section's own drop day instead of its slice end — the mutation that
reinstates the bottom-edge inversion, and that used to survive the whole suite — failed all eleven pinned
calendars, the names check and the drop-day sweep, thirteen; returning the day before the slice end failed the
same thirteen. Narrowing a fixture set was re-run against the widened 2024-2040 bound and still fails on a
named day. Nothing else failed in any of the nine. Six were re-run a third time once the invariant sweep grew
to 2026-2028, since a widened sweep is a changed check: the unconditional week flip (seven), the strict `<`
(seven), the reverted drop rule (thirteen), `dropEndDateFor` returning the drop day (thirteen) and the day
before the slice end (thirteen), and the narrowed fixture set (one) — the same counts as before, the leap year
adding days a failure can be reported on rather than checks that notice it. The fixture sweep's new real-clock
guard was proved live the same way, by pointing its own upper bound below the current year: the check then
fails with the widen-the-bound message instead of passing on a range it no longer covers.

README: the interval paragraph and the drag paragraph now state the two rules, the horizon list names the Next
three, and the hero shot's spec closes with its own sentence saying the capture has to be midweek, early in
the month and outside December or the headings read Next and the Future group has nothing to show. In e2e only
comments moved: `showcase.spec.ts` explained that a December capture pushes its far-future row into Future,
which is no longer true — in December the year slice runs to the NEXT December 31st, so it holds both the
+30-day and the +120-day row and the capture has no Future heading at all. Every other spec drops onto Today
or Tomorrow headings only, whose drop days did not change, so nothing else needed touching.

Suite: 323 harness checks (twenty-two new), all passing. Playwright unchanged (79 tests, 72 run, 7 opt-in
skipped) — not run in this pass, three of its comments corrected.

## 2026-09-03 — v2.2.1: drag auto-scroll at the list edges

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
events: `update(container, clientX, clientY, onScroll)` aims it at a scroller and a pointer position, `stop()`
ends it, and the callback is handed that same position back so the caller needs no globals of its own.
The edge band is `clamp(15% of the container's client height, 32px, 72px)` — and additionally clamped to half
the height, so the two bands can never overlap in a short container — and the speed rises linearly with how deep
into the band the pointer is, from 2 px/frame at the band's inner edge to 16 px/frame at the container's own
edge, driven by `requestAnimationFrame`. All six numbers are named constants at the top of the section, so the
feel can be tuned without reading the maths. The container is the nearest vertically scrollable ancestor of the
element under the pointer, falling back to the live `.todos`; in practice it is always `.todos`, and the
fallback only covers a pointer resting on something that does not scroll (a heading, the padding).

Nothing outlives a gesture, which is the part worth being strict about — a list that keeps moving after the drop
would be worse than one that never moved. The loop stops when the pointer moves INWARD out of the band or off to
the side of the container, on `drop`, on `dragend`, and at the scroll limit (a frame that does not change
`scrollTop` ends it); `stop()` cancels the pending frame, so there is no rAF and no timer left standing either
way. "Leaves the band" is only half a rule, because leaving it OUTWARD is the overshoot case below, which pins the
speed at maximum rather than stopping — so a pointer carried out through the top or bottom edge is the one exit
none of those four covers, and the review round below is where it got its own stop.

`AUTOSCROLL_IDLE_MS` sits on top of those as a **safety net**, and the first draft had it at 150ms on the
assumption that a native drag keeps `dragover` coming while it is over the document. That assumption was never
measured, and it is at best half true: the HTML drag-and-drop model's own processing loop iterates every 350ms
for a stationary pointer, and an X11 drag is driven by `XdndPosition` messages that follow pointer *motion*. A
150ms watchdog would therefore kill the loop before the next event could possibly arrive, and ship the feature as
"wiggle the mouse continuously to keep it scrolling" — a hair away from the report it exists to answer. Worse for
the reuse plan: a finger holding still emits no `touchmove` at all, ever. So the watchdog is now 800ms, the real
ends of the gesture do the stopping, and the harness pins the constant at ≥ 500ms with the reason written next to
it. A runaway is still bounded by the scroll limit.

The wiring is delegated on the document like the between-rows gesture — one wiring that survives every `setHtml`
— and it is gated on `IS_MOBILE` (there is no HTML5 drag there at all) and on ownership: a drag this panel did
not start must never make the list run away under the cursor. Ownership was a bare `panelDragActive` flag, which
is sticky state whose only clears are `drop` and `dragend` — and the panel re-renders on every sync, so a drag
held for a couple of seconds routinely outlives its own source row, whose `dragend` (if Blink dispatches one at
all) no longer bubbles to the document. A flag left raised would then hand the next foreign drag the scroll loop.
So the drag now carries its ownership itself: `onTodoDragStart` stamps `application/x-cockpit-todos` on the
`dataTransfer`, and `isPanelDragEvent` requires both the flag and that type — `types` is readable in dragover's
protected mode, unlike `getData`. The between-rows dragover is gated the same way, which as a side effect stops
it drawing an insertion line for text dragged in from another window.

One thing did not survive contact with the design. The insertion line between rows is resolved from a pixel band
inside the row under the pointer, and while the list is scrolling the rows move under a pointer that is holding
perfectly still — the browser's next `dragover` can be a few hundred milliseconds away, which at 16 px/frame is
a couple of hundred pixels of lag in a line that is meant to sit in a specific gap. So `betweenTargetFor` was
split into a coordinate form, `betweenTargetAt(element, clientY)`, the indicator painting was factored out into
`paintBetweenIndicator`, and the scroll loop re-asks the question after every frame that moved, from
`document.elementFromPoint` at the last pointer position — the same answer a `dragover` there would have given.
The whole-row targets (headings, calendar days, week columns) were left out of that refresh at first, on the
grounds that they are room-sized rather than pixel-banded. That answered the visual lag and missed the binary
half: **whether the drop is offered at all**. The browser decides whether to fire `drop` from the *last*
`dragover` it delivered, and acceptance is granted per event by whatever sits under the pointer — a heading's
inline `ondragover`, or `onBetweenDragOver` for a gap. Hold the pointer over a row's inert middle, let the list
scroll "This Week" under it, release: the last `dragover` said *not accepted*, so no `drop` event fires and the
to-do silently does not move — the exact complaint, one layer down. And `-drop-over` is only ever removed by that
element's own `dragleave`, which a still pointer never fires, so a heading that scrolled away kept its highlight
until the next re-render. Both are new with the scrolling, because the content now moves while the pointer does
not. So the loop's callback re-resolves *both* affordances (`refreshDropTargetsUnderPointer`, with
`paintDropTargetHighlight` as the single owner of that class), `endPanelDrag` sweeps both paints, and — while a
scroll loop is armed, which is all `edgeAutoscrollRunning()` reports — `onDragAutoscroll` accepts the drop at the
document level. The drop
handlers already re-resolve their target from the release point, so accepting broadly there costs nothing: a
release over an inert spot becomes a no-op instead of a cancelled drag, with the default action still suppressed.
Two smaller corrections came out of the same pass: a pointer that has overshot the container vertically now pins
the speed at maximum instead of dropping to zero (the controls block sits directly above `.todos`, so the
instinctive shove to the very top landed one pixel outside the box and stopped the scroll dead), and the callback
runs after the next frame is booked, inside a `try`, so a throwing callback cannot leave the loop
dead-but-not-stopped.

The programmatic scroll deliberately flows through the existing `.todos` scroll listener, so the position is
saved and posted exactly as a user scroll is — a drag is now a new source of `scrollChanged` traffic, which is
harmless: the host stores it and explicitly never refreshes on it, and the 300ms trailing throttle bounds it.
`restoringScroll` only ever covers the two frames after a re-render
installs a fresh container, and a mid-drag re-render is self-healing anyway — the loop's old node is detached,
its `scrollTop` stops changing, the limit check ends it, and the next `dragover` finds the new `.todos`.

Six harness pins guard the wiring rather than the maths, in the style of the between-drop source pins (the
harness cannot execute the webview, so these read its source): the document `dragover` path feeds the helper and
both `drop` and `dragend` end the drag *and* clear both paints; the watchdog is a named constant of at least
500ms and stopping cancels the frame; the handler is gated on `IS_MOBILE` and on ownership, which the dragstart
stamps on the drag and `isPanelDragEvent` reads off `dataTransfer.types`; the loop stops at the scroll limit and
outside the bands, and hands the pointer position to a callback that re-resolves *both* target kinds after the
next frame is booked; a release while the list moves is accepted, and an unmatched drop still suppresses the
default; and the band and speed constants are declared together and read by the maths rather than inlined, with
the overshoot pinned at full speed. Eight mutations were run and the file restored byte-identical — deleting the
scroll-limit stop, putting the watchdog back to 150ms, dropping the ownership stamp, removing the acceptance,
dropping the whole-row half of the refresh, inlining `AUTOSCROLL_SPEED_MAX`, calling the callback without the
pointer position, and booking the frame after the callback each failed exactly one pin with the message that
names it, and nothing else moved. The band and speed curve were checked separately by lifting the step maths out
of the file and running it against fake containers: a 72px band at a 600px height, −16 px/frame at the very top
edge and above it, −2 just inside the band's inner edge, 0 through the middle and off to either side, and — in a
50px container, where the half-height clamp bites — an exactly inert midpoint with the two bands touching but not
overlapping.

`e2e/drag-autoscroll.spec.ts` is new: seven cases at this point in the story — ten by the end of this entry —
driving the real handlers with the HTML5 sequence a browser
fires, measuring `.todos.scrollTop` around each phase — the bottom band scrolls down, the middle is inert, the
top band scrolls up, a `dragend` stops the scrolling while the pointer stays in the band and the events keep
arriving (so only the drag's end can explain it), and a foreign drag with no `dragstart` moves nothing — which,
as the round below found, proves the FLAG half of ownership and not the type half it was written to claim.
The silent case is there because the first draft of this suite could not have failed for the assumption the
feature rested on: every case drove its own 50ms `dragover` stream, a cadence no real drag produces. That case
sends a SINGLE `dragover` and then goes quiet for 1200ms, and requires the list to have coasted more than 200px
— more than a 150ms watchdog could ever have contributed — before a second, equally silent phase requires it to
have stopped, with no `drop` and no `dragend` anywhere in sight; and it requires the coast to have ended with
list still left to scroll, so the claim in its name is the watchdog and not the bottom of the list. All four
scrolling cases bound the distance from above as well, at the animation frames the phase actually spanned ×
16 px, so a helper with the wrong speed constants can no longer pass a direction-only assertion — an unbounded
floor would have let a helper scrolling at 200 px/frame with no watchdog at all through. Every polled case
retries a run whose `.todos` was replaced mid-probe rather than reporting its numbers. The whole timed sequence
runs inside one `frame.evaluate`, because a dragover dispatched per tick over CDP would put the round-trip into
the very interval being measured.

The seventh case is the only one that finishes the gesture instead of stopping at the scrolling, and so the only
one that speaks to the second half of the report — not "the list would not move" but "the to-do does not reach
the date". A row is grabbed at the bottom of the list, the pointer is placed once in the top band and never moved
again, the auto-scroll carries a DATED heading up to it, and the release happens there, mid-scroll; what must
then be true is not a pixel count but a reschedule, read back from Joplin's own record of the note and then seen
in the panel under that heading. It needed a fixture change to be possible at all: every seeded to-do had been
undated, and the one heading that produced was "No Due Date", whose `data-drop` is `clear` — excluded from
between-drops and not a date to arrive at. A small dated group is now seeded alongside them through the same data
API, and since the default profile moves "No Due Date" to the end of the list, that group is the first one and
its heading is what sits above the fold: the journey runs upwards. What the case cannot prove is the document-
level ACCEPTANCE the release depends on — a dispatched `drop` fires whether or not any `dragover` called
`preventDefault()`, so that half still rests on the source pin and on a manual in-app drag.

To have something to scroll, 90 undated to-dos plus that dated group are seeded through Joplin's data API rather
than the GUI (90 × "New to-do" would not fit in a `beforeAll`), and the suite refuses to start until the panel
itself reports more than 1200px of scroll and a container taller than two bands. The range grew with the
watchdog's own reach: 800ms at 60fps × 16 px/frame is about 770px, and the silent case's "the watchdog stopped
it" is only a distinguishable claim while the list still has somewhere to go. The negative cases are never polled
on their measurement: an `expect.poll` around a negative retries until a run happens to hold still, which is the
failure they exist to catch.

**Merging onto 2.2.0, and the last review round.** The branch was cut from 2.1.3 and 2.2.0 shipped while it was
out, so the two met in the merge — and they met inside the *same four functions*, because next-period horizons
changed the between-rows drop as well. 2.2.0 gave period headings a `data-drop-end` (a heading now names a
STRETCH of days, and its `data-drop` is only the first of them, so the bottom edge of a between-drop needs the
other end), which `betweenGroupInfo` reads, `betweenTargetFor` carries and `onBetweenDrop` posts as a sixth
argument. This branch had split `betweenTargetFor` into `betweenTargetAt(element, clientY)` so the scroll loop
could re-ask the question from `elementFromPoint`. Both landed: the coordinate form takes `clientY` and returns
`groupEndDate` alongside `groupDate`. The rest was text — the README drag paragraph now carries the first-day
drop rule *and* the auto-scroll sentence, and both DEVLOG entries stand as written.

Four findings from the branch's last re-check were fixed here rather than there:

The e2e case named "a foreign drag never scrolls" was not testing what it said. With no `dragstart` of its own,
`panelDragActive` is false, `isPanelDragEvent` returns on that first line, and the drag's types are never read —
so the `text/plain` the fixture carefully carried decided nothing, and the ownership TYPE, the half that exists
because the flag can go stale, had no cover at all. The case still proves the flag half and now says so; an
eighth case reaches the other branch: a real `dragstart` from a row raises the flag, then a `dragover` stream in
the bottom band carries a SECOND `DataTransfer` holding only `text/plain`, and the list must not move. Its second
phase is a control — same band, same pointer, the drag's own payload — which must scroll, or the first phase's
stillness could as easily be a dead panel as a working type check.

Leaving the panel through the top or bottom edge had no end of its own, and the overshoot rule made that the
worst exit rather than the mildest: a pointer outside the container vertically is pinned at `AUTOSCROLL_SPEED_MAX`,
so the list ran on for the whole 800ms watchdog — the better part of a thousand pixels — after the drag had
visibly gone. A document `dragleave` now stops it, on a deliberately strict test: `relatedTarget` null AND
the pointer outside the document's own box. `relatedTarget` alone would not do, and this is the one place where
the auto-scroll bites its own tail — a `dragleave` also fires when the element under a HOLDING-STILL pointer
changes, which is precisely what scrolling the rows under it does, and Blink does not reliably name the element
the drag moved to. Acting on `relatedTarget` alone would have killed the loop the moment its own scrolling
started working. The asymmetry decides the test: missing a real departure costs no more than the old behaviour
(the watchdog still ends it), while stopping a live gesture's scrolling by mistake would cost the feature for as
long as the pointer then held still.

That stop, as first written, was a **one-way door**, and the round after it caught what that cost. It called
`endPanelDrag`, which drops the ownership flag — and `panelDragActive` had exactly one place that raised it, the
panel's own `dragstart`, while the HTML5 drag OPERATION outlives the pointer leaving the iframe. So: shove a dragged
to-do out through the top edge (the very move the overshoot rule exists to encourage, one pixel further than "outside
the container"), bring it back into the list, release it in a gap between two rows, and it would silently not move.
`onBetweenDragOver` bailed on the ownership gate before its own `preventDefault`, no insertion line was drawn, so
Chromium fired no `drop` at all — and the auto-scroll stayed dead for the rest of that drag too. Heading and
calendar-day drops went on working, since `onDropTargetOver` is not gated, which would have made it read in use as
"between-drops are broken" rather than as this. It was a regression against 2.2.0, where nothing gated that handler
and a leave-and-return dropped normally; it was the review item's own blind spot rather than a deviation from it.

The fix is to say what leaving actually is. A departure is not an END of the gesture, it is the end of the gesture's
*effects over us*: the scroll loop and the two transient paints. Those three moved out of `endPanelDrag` into
`clearPanelDragEffects`, which is what the `dragleave` now calls; `endPanelDrag` is that plus the flag, and stays
wired to the drag's own two ends, `drop` and `dragend`. Ownership therefore never changes hands on a departure — the
same drag coming back finds the panel exactly as it left it, and nothing about the stale-flag argument that
introduced the ownership type moves either. The alternative considered first was letting the type RE-RAISE the flag
in `isPanelDragEvent`; it works for the return trip, but it also makes the type sufficient on its own, and the e2e
case that proves a `dragend` stops the scrolling while the pointer stays in the band caught it doing exactly that —
the dragover stream after the `dragend` carries the same `DataTransfer`, so the loop came straight back. The
narrower split has no such reach. With ownership out of it, the guard's remaining assumption — that an in-document
`dragleave` never arrives with a zeroed coordinate — is worth one pixel at the top-left corner, and only until the
drag's next `dragover` restarts the loop.

The two cases that must not be polled failed outright whenever a background refresh replaced `.todos` mid-probe —
numbers read off a detached node, a failure with nothing behind it. They now go through `validProbe`, which
retries up to three times on that one condition and asserts on the FIRST valid run, chosen before its
measurements are read, so nothing about the retry can select for a result. And the entry above claimed the
document-level acceptance holds "while and only while the list is actually moving", which overstates
`edgeAutoscrollRunning()`: it reports that a frame is booked. It now says a scroll loop is armed.

The dragleave had arrived with no runtime cover at all — it rested entirely on source pins and on an unverified
premise about Blink — and its two halves are load-bearing in opposite directions, so it now has two e2e cases of its
own. One carries the drag out through the top edge and requires the list to stop dead inside the watchdog's own
window (without an end of its own it would coast right through, at maximum speed), then streams the SAME drag back
over the panel and requires it to scroll again — the case that says the departure is not a one-way door. The other
dispatches the dragleave the auto-scroll itself provokes, at the very coordinates the pointer is already sitting at,
and requires the loop to survive that. Both go through the same `probe` machinery, which grew one option: a phase can
dispatch a synthetic `dragleave` before it starts, in either form.

Suite: 329 harness checks, all passing (the 2.2.0 and drag auto-scroll blocks both intact through the merge; the
dragleave is pinned to `clearPanelDragEffects` and pinned AGAINST ending the drag, and `endPanelDrag` is pinned as
that sweep plus the flag — each proved by a mutation: pointing the dragleave at `endPanelDrag`, and having it drop
the flag alongside the sweep, each fail exactly one assertion with the message that names it). Playwright:
`e2e/drag-autoscroll.spec.ts` is ten tests now, all ten green (1.4m) — the run that first showed the RE-RAISE
alternative failing, and then the split passing. The merge round before it ran the targeted set —
`drag-autoscroll`, `multi-drag`, `selection-crossing` and `panel-todos`, the four that touch the drag paths the
merge rewired — and this round re-ran `drag-autoscroll` alone, since nothing outside it moved; the full suite is
the verifier's run, not this one's.

## 2026-09-03 — v2.3.0: drag to reschedule on mobile

The one thing the mobile panel could not do that the desktop one could. Rescheduling on touch has been
possible since the mobile phase — a long press opens the to-do menu, "Move to date…" opens the alarm
overlay — but that is the *precise* route, three taps deep, and the desktop's own gesture (pick a to-do
up, put it where it belongs) had no equivalent. MOBILE.md had carried "full touch drag-to-reschedule"
as optional work since the phase began. This makes it real, and the whole feature is an INPUT layer:
everything under it — `betweenGroupInfo`'s eligibility, the neighbour walk, the two indicator painters,
the edge auto-scroll helper from 2.2.1, and both message shapes — is the desktop drag's own machinery,
reused unchanged, so the host cannot tell a finger from a mouse and `panel.ts` gained exactly one line
(the new module's `addScript`).

**Four decisions, and what each one turned down.**

*Targets: the gaps AND every existing `[data-drop]`.* The alternative was gaps only, on the argument
that between-drops are the interesting half. Rejected because the headings are the coarse, forgiving
target a finger actually wants — "sometime tomorrow" is most of what rescheduling means — and because
they already exist in the markup with the highlight already written. So a touch drop reaches everything
a mouse drop reaches: the gaps, the group headings including No Due Date, the calendar days and the
week columns.

*Gesture: the long press already there.* The alternative was a per-row drag handle — a grip column on
every row, unmissable, immune to Android's gesture arbitration. Rejected because it is permanent chrome
on every row of a list whose whole point is density, for a gesture that should be discoverable by
holding, and because the 500 ms press is already the panel's "this row, deliberately" on mobile. It is
kept, explicitly, as the documented fallback: if the device round shows Android taking the gesture, the
handle is what ships instead. The press was made *speculative* — it lifted the row, and a release that
never travelled handed the context menu back exactly as before, so nothing was taken away to add this.
**The first Pixel round then broke that half of it, and the redesign below is the answer**; the other
three decisions are untouched by it.

*Payload: `schedulableSelection()` after collapsing onto the dragged row.* Which is `[thatOneRow]`
today — mobile has no multi-select — but it is the same call the desktop `dragstart` makes, so a mobile
multi-select would inherit dragging for free rather than needing this path rewritten.

*Feedback: the lifted row, one indicator, and a banner. No ghost clone.* A cloned row under the finger
is a second thing to keep in sync with the gesture and says nothing the insertion line does not already
say; the banner says it in words instead — "before X", "after X", "onto Today", "release to cancel" —
and it is never silent: exactly one of the three states is painted at every moment, so a finger over
nothing droppable is *told* so rather than left to guess.

**The hazards, which is where the work actually was.**

*The passive-listener trap.* `preventDefault()` on a `touchmove` is the only thing that stops Android
panning the list under the lifted row — and a document-level `touchmove` listener is passive by default
in Chrome, where `preventDefault()` does nothing at all and merely logs. So the drag's listener is
registered `{ passive: false, capture: true }` and removed with the same options; a mismatch there
would leave a listener cancelling every touchmove for ever, which is the list's scrolling gone for the
life of the webview. What is deliberately NOT used is `touch-action` on `.todo`: it would apply to
every touch on every row, always, and the rows must still flick-scroll. This is also the one thing no
test here can settle — whether Android's compositor honours the cancel rather than starting a fling is
a device fact, and it is the make-or-break step of the Pixel round. The review round added the one thing
worth knowing before that step: the listener goes on MID-GESTURE, 500 ms into the touch, and Chromium
decides a sequence's blocking-handler region on the compositor, so a late handler can be handed
non-cancelable moves — which looks exactly like the failure 18b is watching for. Registering the same
listener once at load with `if (!touchDrag.active) return` as its first line has identical behaviour and
a region that is blocking from `touchstart`; it is not the default because it routes every ordinary
flick through a main-thread handler, so it is written down as the cheap thing to try BEFORE the
drag-handle fallback, with its own cost to be measured on the device rather than assumed away.

*The checkbox ring overhangs its own row.* The mobile tap-target rules grow the 18 px ring to a 40 px
content box and cancel the growth with an equal negative margin, so the box sticks out of a ~26 px row
without moving anything on screen. `elementFromPoint` anywhere in the left column therefore returns the
NEIGHBOUR row about as often as the right one — a gesture that would have rescheduled the wrong to-do
roughly half the time it was aimed near a circle. Rows are found geometrically instead: an index of the
rows' boxes, built at the arm - while the list is certainly still - and shifted by every scroll, searched by y. That search
is the part that would be wrong on a device and invisible in review, so it lives in a pure module
(`src/ui/panel/touchDrag.js`, `window.TouchDrag`, the `between.js` pattern) the harness requires
directly. The big `[data-drop]` targets are still asked of the DOM, and asked FIRST, for a reason that
took a second look to see: a heading is a *sibling* of the rows, so it sits in the very gap the row
index would attribute to the row above it — resolve the gaps first and a drop on "Tomorrow" becomes a
between-drop under the last Overdue row.

Asking `[data-drop]` first turned out to be only half of that, and the review round found the other
half: not every heading HAS a `data-drop`. "Overdue" and "Future" name no date, so `getHeadingDropTarget`
gives them none and `dropTargetAttributes` emits nothing — they missed the `[data-drop]` branch and fell
straight through to the row index, which handed the heading's whole band to the row above it. A finger on
"Future" would have rescheduled the to-do into the group BEFORE it, silently, at a point where the mouse
drag is completely inert (`betweenTargetAt` starts from a `closest('.todo')`, and a heading is not one).
Worse while scrolled: headings are sticky, so a dateless one floats over the rows, and the insertion line
would have been painted behind it on a row nobody aimed at. The resolver now bails on any `h2` under the
finger, after the `[data-drop]` test — the headings that do accept drops have already returned by then.
The row index picked up a second correction in the same round. It was rebuilt from scratch after every
auto-scrolled frame: one `getBoundingClientRect()` plus `betweenGroupInfo`'s walk back to the heading for
every row in the list, at 60 fps, on the device, in the one phase of the gesture where the frame budget
is real — when a scroll moves every row by the same delta and changes nothing else about them. It is
shifted by that delta instead, and shifted from ANY scroll rather than only the drag's own: if Android
pans the list without taking the gesture away (18b's failure mode, in the sub-case where no
`pointercancel` follows), an index measured before the pan would have written neighbours read off rows
that had scrolled away.

*The guard, and where it is taken.* Every in-panel overlay brackets itself with `['dialogGuard', true/
false]`, and a leaked `true` freezes every mobile refresh for the life of the webview. A drag needs
that guard — a mobile refresh is a full webview reload, which would destroy a drag in progress — so
there is exactly ONE end, `endTouchDrag(reason)`, that every exit calls: a drop, a release over
nothing, a second finger, a `pointercancel`, `visibilitychange`, a resize, an orientation change and a
15 s watchdog. It has a single `return`, the not-active guard on its first line, which is what makes
"every exit releases the guard" a property of the shape rather than of a reviewer's attention.

The one deviation from the approved design is *when* the guard is taken: at the LIFT, not when the
press first commits to the gesture. The host answers the last guard coming down by repainting
(`panel.ts`'s `dialogGuard` branch runs `refreshPanelData`), and a mobile repaint is a webview reload —
so on any path that ends with the context menu still open, the release would have reloaded the panel out
from under that menu, breaking a gesture that works today. Taking it at the lift keeps the pair strictly
inside the drag proper: a hold-and-release, and (after the redesign below) a hold-and-swipe, never touch
the guard at all. The price is that a refresh landing in the gap before the lift ends the gesture by
reloading — nothing is held, so that is the harmless direction. The drop message is posted BEFORE the
release, for the same repaint reason in reverse: guard-first would reload once for the release and again
for the write.

*A still finger sends nothing at all.* The edge auto-scroll helper stops itself after 800 ms without an
`update()` — a watchdog sized for the HTML5 drag, which re-fires `dragover` every ~350 ms even for a
stationary pointer, and noted in 2.2.1 as the net for "a gesture that ended without an event reaching
us". A finger holding at the edge — the entire gesture an edge scroll exists for — emits no `touchmove`
at all, so the list would have run for 800 ms and then stopped until the user wiggled. The touch drag
re-aims the loop from its own scroll callback instead; nothing is lost, because every end of a touch
drag calls `endTouchDrag`, which stops the loop, with the 15 s watchdog behind them all.

*The gap that must not be offered.* Both neighbours absent in a dateless group is the one gap
`betweenBounds` returns null for — nothing bounds the interval, no group date anchors it — so the host
would write nothing. It is not painted and not droppable, rather than a line that promises a move that
never happens.

**The trace had to be fixed first**, as its own commit, and the reason is a small lesson: it wrote only
into the search suggestion list's hint line, and every gesture on a to-do row happens with that list
closed. The one diagnostic built for exactly this kind of device question was blind to the gesture it
was needed for. It now falls back to the toast in a sticky mode when there is no hint line, the ring
buffer holds 10 rather than 6 (a drag arms, retargets, scrolls and drops), and the drag speaks in
`menu-open`, `drag-lift`, `drag-released`, `drag-sideways-ignored`,
`drag-target:before|after|drop|none`, `drag-autoscroll:up|down`, `drag-drop:between|date` and
`drag-cancel:<reason>` — target and scroll traced on a CHANGE only, or one move would flood the buffer
it is meant to fill. A whole gesture reads as `menu-open > drag-lift > drag-target:after >
drag-drop:between`, or `menu-open > drag-released`, or `menu-open > drag-sideways-ignored`, so the three
outcomes of the redesigned first-move rule are told apart at a glance.

**Tests.** The pure module is driven directly: the midline (which goes *before*, so the split is total),
a zero-height row, the gap that belongs to the row above, both ends of the list, an empty index, and the
binary search compared against a linear scan at every pixel of a sixty-row list. The gesture is webview
source this harness renders but never executes, so its load-bearing shapes are pinned — and four of them
are proved by mutation rather than asserted: adding a second `return` to `endTouchDrag` before the guard
release fails "endTouchDrag is ONE end that cannot return before releasing the refresh guard"; making the
`touchmove` listener passive fails "the touchmove listener is NON-PASSIVE"; moving the guard release
above the drop message fails "the drop message is posted BEFORE the guard release"; and letting the arm
path accept a `.todo-checkbox` press fails "the arm refuses the tick circle, the notebook pill and the
read-only peek". Each fails exactly one check, with the message that names it.

The review round added seven more, each also failing exactly one check: deleting the `h2` bail fails the
resolver check; rebuilding the index instead of shifting it, and dropping the re-sync on a foreign
scroll, both fail the index check; taking the payload from `longPress.id` instead of
`schedulableSelection()` fails the payload check — the Q3 decision had been the only one with no test at
all, since both e2e payload assertions read the same single id either way; letting `cancelLongPress` tidy
up anything besides its timer fails "a release that never moved tears the arming down and leaves the menu
standing", which pins the orderings that menu quietly rests on; and a `touch-action`
smuggled in under `.todo.-dragging` fails the CSS check, which used to look only for the one selector
spelling the feature happened to use and now scans every rule whose selector mentions a row.

`e2e/mobile-drag.spec.ts` runs the MOBILE panel under the desktop app — `forceMobilePanel` injects the
`#cockpitPlatform` marker onto `<body>` (so it survives every `setHtml`) and re-runs the panel's own
`applyPlatformClass`, which is the whole switch, no code path faked — and drives it with REAL CDP touch
(`Input.dispatchTouchEvent` on a session of its own), never synthetic `PointerEvent`s: only the
browser's own input layer produces the compatibility mouse events, the synthetic click the swallower has
to eat, and a pan the drag has to stop. A third helper wraps `webviewApi.postMessage` and records what
the panel posted, which is what makes the negatives real — "nothing was written" is otherwise
indistinguishable from "the write has not landed yet", and the guard pair is invisible from outside the
webview entirely, since the desktop host consults the guard only when `mobile`. Twelve cases (eleven
before the redesign): a gap drop read back from Joplin's own record, the two halves of ONE row resolving
to two different gaps, a dated heading that keeps the time of day, the No Due Date heading that clears
it, a drop-refusing heading that must write nothing at all (the review round's find, and the only case
whose failure would be a WRONG write rather than no write), the menu that is up WHILE the finger is
still down and survives a release that never moved (with the note not opening behind it and no menu item
firing on the synthetic click), a hold whose first move goes SIDEWAYS and must lift nothing, write
nothing and never take the guard, a 300 ms press that pans the list and writes nothing, a tap that opens
the note, the ring's two gestures, a peek row that never lifts but still gets its menu, and a cancel over
the header whose balanced guard pair is the leak check.

Four of those cases were only apparently passing, which is the useful half of what the round found in
this file. The pan case leaves the list scrolled 220 px and nothing put it back, so every case after it
was aiming at rows that had moved off screen — `settle()` now returns the scroller to the top, and every
point helper asserts its y is inside the `.todos` box and, when it is not, says so with the list's own
metrics instead of failing on the gesture. The cancel case asserted the banner "contains cancel", which
the LIFT banner ("release outside the list to cancel") also does, so it could not fail the way it was
named; it now reads the `-cancel` class the painter actually toggles and asserts the text names no
target. The pan case took a `dragState()` evaluate 300 ms into a 500 ms hold, and an evaluate slow
enough on a loaded machine would have let the row lift and turned the case into its own opposite; the
first move now goes in immediately after the wait, past the slop, which cancels the press outright
before anything is probed. And `armMessageLog` now returns whether its wrap actually took: every
negative in the file rests on that wrap, and a `postMessage` that had become non-writable would have
made "nothing was posted" true of an empty log rather than of the panel — the pan case additionally
asserts the one message that MUST be there, its own `scrollChanged`. Playwright's `globalTimeout` went
from 18 to 25 minutes and the CI job's cap from 20 to 28: this spec is the seventeenth file, each file
launches its own Joplin, and a suite that overruns is hard-cancelled without a report.

The first full e2e run of the file then found what only a real run could: two cases red, both for the
same reason, and neither of them about the gesture. `beforeAll` creates two notebooks — this spec's own
and an outside one the peek case needs — and `createNotebook` leaves the notebook it just made selected
in the app, so Joplin sat on the outside one, whose note list holds a single note. The two cases that
park the editor before judging whether a note opened were clicking for a row in a list that was never
going to contain it, and each spent its whole 240-second budget doing so. The outside notebook is now
created first and this spec's second; the park itself moved off `td-lo` — an early fixture, and
therefore at the bottom of a fifty-six-note list Joplin renders a viewport of at a time — onto a plain
note seeded last, which a fresh profile's newest-first sort puts at the top where no virtualisation can
hide it, and which the panel never lists at all because it is not a to-do. That premise needed one more
thing to be true, and the `parkEditor` assertion is what said so out loud: Joplin GROUPS the list before
it sorts it, and `uncompletedTodosOnTop` — default on, File-storage — ranks every uncompleted to-do above
every plain note, so the very property that made the park note safe also sank it below fifty-five to-dos
and back out of the rendered viewport; the spec now presets that setting off in the settings it launches
Joplin with, the same way it presets the data API. A `parkEditor` helper checks
the row is there before clicking it and checks the editor followed afterwards, so the next fixture that
cannot be reached says which notebook is showing, in seconds, rather than hanging. The peek case's
notebook filter was one open-and-click and flaked on exactly the race that shape invites — a repaint
between the two, leaving `#notebookMenu` hidden with nothing chosen; it is now a bounded poll whose exit
condition is the filter the panel itself reports as `-current`, with both clicks short-timed and
swallowed, since the raised error would otherwise end the poll on the very race it was written to ride
out.

### The first Pixel round, and the menu-first redesign

The device answered before the checklist could be worked through: **the drag did not work**, and what the
owner reported was that it **conflicted with Joplin's own side menu on the long press**. That is the
observation, and it is all of it — the gesture-trace lines from that round never arrived, so nothing below
is measured. The *working diagnosis* is that a lift at the 500 ms fire lands inside the app's own
side-menu gesture (a hold followed by movement is how the drawer opens) and that the two fought over the
same touch sequence with neither winning. It fits the symptom, and it is what the redesign is built on;
it is not proven, and the hazards this section was originally written for are **not** excluded by it —
§7 and 18b keep "Android refuses the non-passive `touchmove`" as a live hypothesis with a cheap fix
attached. What would confirm the diagnosis is 18b-bis (a sideways stroke from a held row opening the
drawer while the panel lifts nothing) and, if the round produces trace lines,
`menu-open > drag-cancel:pointercancel` at the 500 ms mark would point the other way. Either way, the half
of the old design that had felt safest — "the 500 ms press already means this row deliberately, so let it
lift" — is the half that has to go: on this device that press is not exclusively the panel's to interpret.

Slava's call, and the shape it takes: **the gesture becomes menu-first**, and the panel gives the
sideways stroke back.

- The hold does exactly what it did *before* this feature existed: it opens the to-do's context menu,
  with the finger still down. That gesture was never in question — it has worked on the Pixel since the
  mobile phase — so nothing that already worked is being risked to add a drag.
- Behind that menu the drag is **armed** silently, by `armTouchDrag()`: pointer capture, the non-passive
  `touchmove` listener, the row index, the 15 s watchdog. Nothing visible, no payload, no selection
  change, and above all no refresh guard.
- The **first** travel past the 10 px slop decides, once and for good. `|dy| >= |dx|` → `liftTouchDrag()`:
  the menu closes, the guard is taken, the selection collapses, the payload is resolved, the row dims and
  the banner goes up, and everything from there is the drag exactly as it was already built.
  `|dx| > |dy|` → `endTouchDrag('sideways')`: the arming is thrown away, the menu is left standing, and —
  the point of the whole change — **nothing was ever `preventDefault()`ed**, so the stroke reaches
  Android's own arbitration untouched and the side menu can have it.
- A release without travel is now the *cheapest* path rather than the interesting one: `endTouchDrag('released')`
  takes the listener, the capture and the watchdog back off, and the menu the press opened simply stays.

Three consequences worth naming. First, `preventDefault()` moved behind a `touchDrag.lifted` gate: an
armed gesture blocks nothing at all, which is the only way a sideways move can reach the native layer,
and the harness pins that the first `preventDefault` in `onTouchDragMove` is the guarded one and the only
other is after `liftTouchDrag()`. Second, `endTouchDrag` must never touch the context menu — it is now
the end of two gestures whose whole point is that the menu stays open, and closing it is the *lift's* job,
done explicitly in `liftTouchDrag`. Third, the direction rule is a pure function,
`TouchDrag.firstMoveDirection(dx, dy, slop)`, built on `movedBeyond` so the slop gate cannot drift from
the long press's; the tie (a perfect diagonal) goes to vertical, because a refused swipe is one flick from
being re-tried and a refused lift is not.

The synthetic click needed nothing new, which is the quiet evidence that this order is the old one: the
adapter's swallower already eats the click after a fired long press, which is what keeps the note from
opening AND — since it `stopPropagation()`s at the document — what keeps that click from reaching the
menu now sitting under the finger and running one of its items.

The review round that followed left the state machine alone and spent itself on the two things that decide
whether the *next* device round is conclusive. First, 18b's failure list had survived the redesign unchanged
and was now wrong in a way that would have cost the feature: it read "the list scrolls under the finger"
as proof that Android had taken the gesture, and sent the operator to the load-time listener registration.
But the panel now prevents nothing for the whole 0-10 px armed window, on purpose, while Chromium starts
its own pan at roughly 8 - so a twitch before the lift is this design's expected behaviour on any device,
and the load-time registration cannot fix it, because the handler is declining to cancel those moves by
design. The operator would have run the cheap fix, seen the same twitch, and concluded the design was
dead. 18b now separates three failure shapes with three different remedies - the twitch (lower
`TOUCH_DRAG_SLOP`), the pan *after* the lift (the load-time registration), and no lift at all (the
registration, then the drag handle) - and one line of code makes the middle one name itself:
`onTouchDragMove` traces `drag-uncancelable` when the lifting move arrives non-cancelable, which is
Chromium saying it had already decided the sequence's blocking region before the listener existed. Second,
the e2e lifting step was picking its direction on "does the point stay inside the list", which let it park
the finger inside the drag's own edge auto-scroll band (32-72 px deep): the list would then scroll under a
still finger through the whole aim, and the drop would land wherever it had got to - failing like a bad
aim, the one misdiagnosis that file's header exists to prevent. It now steps towards the middle of the
list and refuses, by name, a landing point within 80 px of either edge. The rest was accuracy: the
`cancelLongPress` comment still justified itself by the deleted deferred menu (its real reader is
`longPress.fired`, which both click listeners consult after the cancel has run); the lift reached back into
`longPress.id` at a moment minutes of gesture after the arm had snapshotted everything else, so the arm now
takes `touchDrag.id` too and the lift touches no `longPress` field at all; and §2 of MOBILE.md was still
describing a hold that lifts.

A second review round caught that the band guard, as first written, was stricter than the hazard and
would have failed the very cases it was added to protect. It used a flat 80 px against *both* edges, but
the panel's band is `min(height/2, max(32, min(72, 0.15 x height)))` and, more to the point, a band only
bites where the scroller can still move that way: `edgeAutoscrollTick` stops the loop on the first frame
that does not change `scrollTop`, so at the top of an unscrolled list - which is exactly where `settle()`
parks every case, and where the first rows of the "Overdue" group sit - an upward auto-scroll moves
nothing at all. The flagship gap case would have thrown on a layout error before dragging anything. The
step now computes the band with `edgeAutoscrollStep`'s own arithmetic, treats a band as an obstacle only
when the list can actually scroll into it, and tries the other direction before giving up. The same round
found the new sideways case pressing at 75% of the row width - inside the notebook pill, which
`canLiftRow` refuses and whose own long press opens the notebook overlay - so the case could never have
armed the gesture whose sideways rule it exists to test; it presses mid-row now, clear of both the pill
and the tick circle. Two smaller things went with it: `armTouchDrag` no longer clears `touchDrag.guarded`
in place but ends any live gesture through the single `endTouchDrag('re-arm')` first, so "a taken guard is
always released" is a property of the shape rather than of an argument about which listener runs when;
and the peek case now asserts its menu *before* its unbounded pan, since any scroll dismisses the context
menu through the panel's own `document` listener and the case is not about that. That listener is also
why 18b-bis now names one thing that is **not** a failure: a stroke with any vertical component pans the
list and closes the menu without the drag having touched it, so only "the row lifted" and "the guard was
taken" decide that step.

A third round put the whole spec through Playwright for the first time since the redesign, and one case
came back red - the spec's, not the panel's. `the checkbox ring keeps its own gestures` opens the date
picker with a hold on the tick circle and then makes a vertical move, to prove the ring arms nothing
behind its menu. That move carries the touch past Chromium's tap slop, so the release synthesises no
click at all - and `longPress.fired`, which is cleared by the click the swallower eats, outlives its own
gesture. The case then dismissed the picker with Playwright's `.click()`, a MOUSE click: the adapter's
`pointerdown` returns on `event.pointerType === 'mouse'` before it can reset anything, so the stale flag
was still standing when that click arrived and the swallower ate the Cancel press instead. The overlay
stayed open and the case timed out on it.

The panel was left alone on purpose. On a phone the stale flag costs nothing, because every input that
can reach the swallower is a touch and the adapter clears `fired` at the very top of each touch
`pointerdown` - above the zone check and above the `#cockpitOverlay` return - so whatever the next tap
lands on, it consumes the leftover before it can be eaten. Releasing the flag earlier, on the
`pointerup`, the way the search suggestion list releases its own click arm (1.9.10), would buy nothing
there and would stake the make-or-break gesture on it: 18a needs `fired` STILL set when the release's
synthesised click arrives, or the menu the press had just opened would vanish under the finger. A mouse
click landing in the panel after a touch gesture is a desktop-host artefact and nothing a Pixel can
produce, so the fix is in the spec - the ring case dismisses the picker with a finger now, which is what
the device does anyway - and a new pin holds that reset above every early return in the `pointerdown`,
since the case rests on the ordering rather than merely benefiting from it.

### The second Pixel round: Android's own `contextmenu`, and the handler nobody was watching

The device answered again, and this time with a much sharper report. 18a passed — the hold opens the menu with
the finger still down. Then: keep holding and move up or down, and **the row lifts (it dims), but the menu does
not close** (it stays, or sometimes vanishes), **and the row is not moved between rows on release**. So the
redesign's own half worked: the gesture is being read, the lift happens, Android is not stealing the sequence.
Something else was putting the menu back.

It was the rows themselves. Every to-do row is rendered with an inline
`oncontextmenu="onTodoContextMenu(event, id)"` and every note row with `onNoteContextMenu` (`src/core/formats.ts`,
the list rows and the week cards) — markup that predates the mobile phase entirely and exists for the desktop
right click. Android's native long press fires a **real `contextmenu`** on whatever is under the finger, and the
panel's only suppression of it was scoped to `#searchSuggestions`: the belt added in 1.9.8 for the search
dropdown's own native-callout problem. So on a row the event went straight through to the inline handler, which
called `showNoteContextMenu` behind the long-press adapter's back.

The nasty part is the timing, because it is **the device's, not ours**: Android's long press is governed by the
"Touch & hold delay" accessibility setting *and* by Chrome's own ~500 ms, both independent of our adapter's
500 ms timer. So the platform's `contextmenu` can arrive **before** the fire (a second menu opening over the
first — which is very plausibly what the FIRST round felt as "a conflict with the side menu on the long press",
and would mean that diagnosis was half right about the symptom and wrong about the cause), or **after** the lift
has already run `hideNoteContextMenu()` — which re-opens a menu over a lifted row, exactly the reported "the menu
does not close". And a menu re-opened under the finger is also what stops the drop: `#noteContextMenu` is a
`position: fixed` element on `<body>`, so the release lands on IT rather than on a row or a gap, the resolver
finds no target, and the to-do is not moved. One cause, both halves of the report.

None of it appeared in the gesture trace, and that is the second lesson of the round after the trace's own
blindness in the first: a row's inline handler is on no traced path, so the panel was doing something visible on
screen with nothing whatsoever to say about it.

The fix is one line of scope and one word of API. The mobile `contextmenu` listener now refuses the event for
**every** target — rows, headings, the list, the body alike — and calls `stopImmediatePropagation()` as well as
`preventDefault()`. That second call is the whole point: `preventDefault()` cancels the *native* menu and the
selection callout, but an inline `oncontextmenu` is a listener like any other and runs anyway. Stopping the event
dead in the capture phase, at the document, is what makes the long-press adapter the only way a touch can open a
context menu. Desktop returns on the listener's first line, so a right click there is byte-identical.

The review round that followed found the one thing "panel-wide" swept up that it should not have: **text fields**.
The panel has real ones on mobile — the search box, the notebook filter, the alarm overlay's date and time — and
Android raises the text-selection handles and the **Paste / Select-all bar** through this same `contextmenu`
event, which in a field on a phone is the only way to paste. Cancelling it there would have been a regression on
exactly the target platform, invisible to the harness and to 18a/18b (the drag would have passed while the search
box quietly lost its paste). So the listener exempts a *kind of element* rather than a zone of the panel's, and
past the desktop line that exemption is now the listener's ONLY early return, with the pin asserting that count
rather than a spelling: the version it replaced forbade an `if`-shaped gate, which a ternary early-return would
have walked straight through while re-introducing exactly the scoping the pin exists to forbid. Step 18 gained a
device check of its own (18j-bis: hold inside the search box, the Paste bar must appear).

**The third review round found what "a kind of element" had let back in**, on the tick circle of every to-do row.
The exemption was first written as `input, textarea, select, [contenteditable]`, justified by "none of those
carries an inline `oncontextmenu`, none is a drag source, and none is a zone the adapter recognises" — and two of
those three claims are false for the one element that selector unavoidably catches. `input.todo-checkbox` is the
FIRST CHILD of the `<div class="todo" … oncontextmenu="onTodoContextMenu(…)">` it belongs to (`formats.ts`, list
rows and week cards alike), the exemption returned *before* `stopImmediatePropagation()`, and the event bubbles
from the circle to the row's own handler — whose first branch IS the circle: selection rewritten, then
`requestAlarm` → `openAlarmOverlay`. On mobile that circle is deliberately grown to a 40 px tap target, so it is
one of the panel's primary long-press zones rather than a sliver, and it is the zone step 18j exercises. Neither
belt covers it: the checkbox branch never reaches `showNoteContextMenu`, so the `touchDrag.active` guard is not
on that path, and `canLiftRow` refuses the circle so nothing arms. The failure is this round's own bug narrowed
to one circle — hold the ring, our adapter opens the picker, and Android's own `contextmenu` opens it a second
time at a moment the device's "Touch & hold delay" picks; `openAlarmOverlay` has no re-entry guard, so the second
call rebuilds the overlay and discards a date or time already typed. The exemption now has two teeth, and each is
load-bearing rather than defensive: the input branch excludes `[type="checkbox"]` and `[type="radio"]` (neither
takes text, so neither raises the Paste bar the exemption exists for), and no exemption may reach INSIDE an
element carrying an inline handler (`.todo, h2[data-todo-ids]`) — whatever control a row grows next. Both
selectors are named once, as `CONTEXTMENU_TEXT_FIELD` and `CONTEXTMENU_HANDLER_ZONE`, and the harness pins what
they MEAN (it reads `formats.ts` to prove the circle really is an `<input>` nested inside the handler, then
decomposes each selector) rather than one spelling of them. The e2e case that dispatched a synthetic `contextmenu`
on a row and on the search box now dispatches a third on the row's circle — a target that is a *child* of the
handler-carrying element, which is the whole shape of the hole — and asserts both that it is cancelled and that
no `#cockpitOverlay` opened. The same round tightened the trace's zone words to the adapter's own vocabulary:
`row` is `.todo[data-todo-id]`, `note` is `.todo[data-note-id]` (a note row opens a different menu and is no drag
source), `heading` is `h2[data-todo-ids]` — a bare `h2` carries no handler — and everything else is `other`. A
strip meant to be read literally on a device is worth only as much as the words on it.

The inline-handler inventory was one short as well: `src/core/html.ts` renders group headings with
`oncontextmenu="onHeadingContextMenu(event)"`, a fourth handler outside `formats.ts`. The capture listener always
covered it (zone `heading`), but the pin counted three and the docs named two kinds; both now count four. The
*belt* stays asymmetric on purpose — `onHeadingContextMenu` never reaches `showNoteContextMenu`, so a heading has
the capture listener only, which is right for something that is not a drag source and opens the alarm picker
rather than a menu.

A belt went on those braces at the other end, in `showNoteContextMenu`: while a touch gesture owns the finger —
armed behind the menu, or lifted into the drag — any other caller is turned away (`menu-blocked`) **before** the
function's own `hideNoteContextMenu()` can run, which is the other half of the report (the menu that "sometimes
vanishes" is a blocked opener tidying up on its way in). What makes `touchDrag.active` a sufficient test is the
fire's ORDER, which the redesign had already fixed for its own reasons: `onLongPressFire` opens the menu *before*
`armTouchDrag()`, so the adapter's own call is the one call in the panel that finds the flag false. That order is
now load-bearing rather than merely tidy, and it is pinned from both sides.

The drop path got the trace it should have had from the start. `drag-drop:between` and `drag-drop:date` said only
that a release had resolved *something*; they now carry **what is about to be written** — four characters of each
neighbour id (`-` for the end of a group), or the `[data-drop]` date verbatim — and are followed by
`drag-drop:posted` once the `postMessage` call has been made (it is asynchronous and `void`-prefixed, so that
code says the post was issued without throwing, not that the host has written anything — the docs say so in as
many words, since a device reader must not read a landed write out of it). A drop into the wrong gap, a correct drop that was never posted,
and a release that reached no target at all were three states with one code between them; they are three codes
now, the last being `drag-release:no-target`, which is deliberately NOT one of the `drag-cancel:` family: that end
is the user's own doing (the banner said "release to cancel" and they did), while every remaining cancel is the
platform taking the gesture away. Every end of the drag still speaks exactly once.

### The third Pixel round: Android's own drag underneath everything else

Four findings came back, and for a day they read as four bugs: *"the context menu doesn't appear at all on the
long press"*; *"broken: the mobile multi-selection - long-hold selects one note, then taps on other notes select
them all too"*; *"moving one note doesn't land between other notes, only on headings, as before"*; and *"some
tolerance for hold and move is needed: I hold the note and it is moving a little straight away, so it is probably
always considered as moving"*. The gesture trace was on, and the strip for a failed drag read
`contextmenu-suppressed:row` and then **nothing** - no `menu-open`, ever. The screenshot showed why: a
**translucent copy of the pressed row floating below the finger**. That is not anything this panel draws. It is
Android's own HTML5 **drag image**.

So the belief this feature was built on was simply wrong, and it was written into the source: "Android's WebView
fires no HTML5 drag at all". It does. A long press on a `draggable` element starts a native drag - `dragstart`
fires (the desktop `onTodoDragStart` ran, selecting the row and dimming the payload), the platform floats its drag
image under the finger, and the touch sequence is **cancelled**, which takes the panel's own 500 ms timer with it.
Every one of the four reports follows from that single fact: no menu opens and nothing arms (finding 1); the row
"moves a little straight away" because the drag image is following the finger (finding 4); a drop onto a heading
still works because the NATIVE drag finds the heading's inline `ondrop` - the desktop path - while a gap needs the
touch path that never started (finding 3); and the pressed row is left selected by `onTodoDragStart`, so later taps
look like they are adding to a selection (finding 2). The panel had been fighting a phantom for two rounds: the
gesture was never being read at all on those presses.

The fix is a subtraction in the markup. `renderTodoRowHtml` takes a new `nativeDrag: false` for a mobile row and
`renderWeekCard` applies the same rule to a card: no `draggable` attribute, no `ondragstart`, no `ondragend`, **and
nothing else changed** - the selection `onmousedown` stays, which is the whole difference between this and the
peek's `draggable: false`. The harness proves that difference rather than describing it: a mobile row is asserted
to be the desktop row **minus exactly those three things, byte for byte**, so a future "no drag on mobile" edit
cannot quietly take the row's selection, its `oncontextmenu` or its `onclick` with it and disable half the phone's
panel. Two belts behind the subtraction, because this failure is silent: `-webkit-user-drag: none` on
`.cockpit-mobile .todo`, which is what the WebView reads before it decides an element can be picked up, and a
**capturing document `dragstart` listener** that cancels every drag on mobile and traces `native-dragstart`, so the
next strip says whether Android is still trying. `onTodoDragStart` returns on `IS_MOBILE` before it touches the
selection.

**The tolerance** (finding 4, and half of finding 1) was a real second bug underneath the first, and it is
arithmetic. The press survives a hold only within 10 px of the **press point**, and the lift fired at 10 px
measured from that **same origin** - so at the instant the menu opened the finger could already be sitting one
pixel from its own lift threshold, and any drift lifted the row and closed the menu in the frame after it appeared.
Both halves are fixed rather than one. The travel is now measured from the **fire point** - where the finger was
when the menu opened, kept in `longPress.lastX/lastY` because the fire has no event of its own - and it has to pass
`TOUCH_DRAG_LIFT_PX`, a threshold of its own. The pure rule the first round introduced as
`firstMoveDirection(dx, dy, slop)` is `liftDecision(dx, dy, threshold)` now: the same arithmetic under a name that
says which of the two thresholds it is being asked about. It was set at 24 px while the native drag was still in the picture
(part of what looked like drift was the platform pulling its drag image around) and is **20** now that it is gone:
twice the press's own gate, about twice Android's ~8 dp touch slop, and still under half a 40 px mobile row, so a
deliberate stroke crosses it at once. There is deliberately no settle window - nothing shows the fire itself jitters
the coordinates, and a window in which travel is ignored is also a window in which a drag cannot be started. The
armed phase now also `preventDefault()`s **every** touchmove, where it used to prevent nothing until the lift: an
un-prevented pan drags every row out from under the just-opened menu and fires the document `scroll` listener that
closes it, which is a second, lift-independent route to "no menu". The sideways rule survives that because Joplin's
side-menu responder is on the **native** side of the WebView - this document's `preventDefault()` cancels this
document's own default and nothing beyond it. That is a claim about the platform, so it is written down as one and
18b-bis is what checks it. And a third route to a missing menu, unrelated to either: a gesture whose `pointerup`
never arrived sits there `active`, and `showNoteContextMenu` turns every opener away for up to the 15 s watchdog.
The adapter's own pointerdown now ends that gesture through the single end (`drag-cancel:stale-pointer`) - and the
review round below is why that reset is written on `event.isPrimary` rather than on a pointer id.

**The selection** (finding 2) had no feature to repair: there is no mobile multi-select of rows, on this branch or
on main. A row carries `onmousedown` and `onclick` and no touch handler at all, Shift and Ctrl are unreachable from
a finger, and the shared `RowSelection` rules therefore answer either "the pressed row alone" or "the multi-set you
already had", while a click always collapses. What the branch had broken was the other direction: `liftTouchDrag`
cleared `selectedRowIDs` and put the pressed row in it on **every** lift, and with the lift firing on nearly every
hold (see the tolerance above) a hold left a row painted `-selected` that the user had not selected and nothing took
back - sitting there while the editor-tracking highlight moved with each tap, which is what a selection that grows
looks like. The rule now is `onTodoDragStart`'s, verbatim: a drag from a row **outside** the selection makes that row
the selection; a drag from a row **inside** it sweeps the whole set and changes nothing. The payload is
`schedulableSelection()` either way, every payload row dims rather than only the row under the finger, the banner
says "Moving 3 to-dos" rather than picking one title out of three, and the one end undims them all. The arm touches
the selection not at all, and neither do the ends that took nothing. Whether a phone even delivers the compatibility
mouse events those rules run on is a platform question this repo cannot answer from its own source, so `onRowPressed`
and `onRowClicked` now trace on mobile with the resulting size (`row-press:<id> n=2`), and the next round's strip can
settle it.

**The gap** (finding 3) was already half-explained by the native drag, but the resolution was tightened to the rule
it was always meant to have, because the previous strip could not have told us which of five refusals it was hitting.
The geometry is **authoritative for rows**: `elementFromPoint` is asked exactly two questions - is there a
`[data-drop]` here, is there an `h2` here - and its answer to anything else vetoes nothing, since on a phone the
banner, the trace strip, a menu and the dragged row itself all float over the rows. (Both floating elements were
already `pointer-events: none`; that is now pinned rather than assumed.) Each refusal is named where it is decided -
`outside`, `refused-heading`, `no-row`, `no-info`, `both-null` - the resolver has no bare `return null` left, a change
of refusal re-traces (two refusals for different reasons are not the same answer), and the release carries the
standing one out with it: `drag-release:no-target:no-row y=612 rows=23`. The index is verified before it is read as
well: `syncRowIndex` shifts the boxes, which is exact for a scroll and for nothing else, so the CANDIDATE row's live
box is checked against the indexed one - one `getBoundingClientRect()` per lookup - and more than
`ROW_INDEX_TOLERANCE_PX` apart rebuilds and re-searches; with no candidate the cheap question asked instead is
whether the list still holds the number of rows it was measured with. The trace ring holds 12 to fit the reasons.

A successful 18b now reads `menu-open > drag-lift n=1 > drag-target:after > drag-drop:between a1b2|c3d4 >
drag-drop:posted`, and a refused gap says which refusal it was rather than leaving the next round to guess.

**The review round after it caught a fix that could not fire.** The stale-gesture reset above was written as
`event.pointerId === touchDrag.pointerId`, on a stated belief that one finger pressing twice is handed the same id.
Blink hands every touch point a **fresh** id and does not reuse the last one, so on the device that comparison is
never true: the reset was dead code, and the route to "the context menu doesn't appear at all" it was added to
close stayed open. It is written on **`event.isPrimary`** now - a press that begins with no other finger on the
glass, which a gesture still holding one cannot be joined by - so it needs no claim about ids at all, and the one
claim it does rest on is checked on the phone (new step 18f-ter) instead of asserted in a comment. The press itself
is deliberately not cancelled: it is the user's next hold, and what keeps it alive is the registration order - the
adapter's pointerdown runs before the drag's second-pointer listener, which then returns at its own guard rather
than cancelling the press it was just rescued for. That order is pinned. In the same round the lift stopped writing
`lastClickedRowID` and `lastSelectionInteractionID`: they are a **click**'s Shift-range anchors, `onTodoDragStart`
writes neither, and "verbatim" has to be a claim about what is not written as much as about what is - so the pin
now asserts their absence, against `onTodoDragStart`'s own body so it retires honestly if that ever changes. Two of
the round's own tests were also proving less than they read as. The e2e check that the drag banner and trace strip
are `pointer-events: none` ran **after** the release, and `hideDragBanner()` removes the banner at every end, so it
was comparing `'none'` with `'none'` for two elements that were not on the page - deleting the CSS rule would have
left it green; it is read while the row is still lifted now, and asserts the element is there before it reads its
style. The tolerance case drifted 12 px from a fire point 8 px below the press point, which is exactly the
threshold from the press point and `movedBeyond` is strictly greater, so a build that regressed only the **origin**
would have passed it: 13 px makes that travel 21 and the case proves both halves. And the multi-selection case had
seeded three new dated rows, which push the "No Due Date" heading - which another case needs on screen at scrollTop
0 - three rows further down; it reuses three rows already in the fixture now, by the file's own aliasing rule, so
this round's e2e geometry is exactly the one the file was last proven green on.

**The Pixel round** is step 18 of MOBILE.md's checklist, with the trace ON. 18a is now "the menu opens
with the finger still down"; **18b** is the one that decides the design — keep holding and move up or
down: the menu must close, the row must lift, and the list must not scroll; and **18b-bis** is its other
half — move sideways instead, and nothing may lift while the menu stays and the side menu gets its
stroke. If 18b still fails, the cheap fix (registering the `touchmove` listener once at load) comes
first, and only then the drag-handle fallback.

Suite: 359 harness checks, all passing - the closing round below rewrote one more in place (the gesture-trace
pin, which now pins `public: false` as well) and added none - and Playwright's `globalTimeout` went 25 → 30
minutes with the CI job's cap 28 → 40, because `e2e/mobile-drag.spec.ts` has since grown to twenty cases whose
`beforeAll` seeds ~100 to-dos while main alone already ran 82 tests in ~12 minutes: the same relationship as
before, the suite's own cap ending a stuck run gracefully with its report written, the job's cap only the
backstop behind it. (The review round above rewrote three checks in place and added no new
ones - the stale reset pinned on `isPrimary` and refused on the pointer id, the registration order the rescued
press depends on, the two selection anchors the lift must not write, and a table row in the `liftDecision` pin that
had reduced to `X === X` and now asserts what it meant). Two further mutations were run for those: restoring the
pointer-id comparison fails "a stale gesture is cleared by the next press that begins alone", and writing
`lastClickedRowID` at the lift again fails "the lift respects the selection instead of collapsing it". 351 before
the THIRD PIXEL ROUND above, plus 8: three at the MARKUP,
which is where that round's fix lives - a mobile list row and a mobile week card carry no draggable attribute and
no drag handlers, nothing anywhere in a mobile panel does, and the mobile row is the desktop row minus exactly
those and nothing else - one for the two belts behind it (the capturing dragstart listener with its trace code,
the `-webkit-user-drag` rule, and `onTodoDragStart` refusing before it writes the selection), and four inside the
three pins the earlier partial commits added for the tolerance, the selection and the geometric gap, which were
rewritten in place rather than duplicated: the lift measured from `longPress.lastX/lastY` past a threshold of its
own with `TOUCH_DRAG_SLOP` absent from the decision, the single unguarded `preventDefault()` before the two-finger
bail, the lift's selection rule compared against `onTodoDragStart`'s rather than described twice, and
`resolveDragTarget`'s five named refusals with no `return null` left. Both thresholds are now read off the panel
source by the pure checks, so a change to either cannot leave them proving things about a number the gesture no
longer uses. Five mutations were run against the round's own pins, each failing exactly what names it: restoring
`draggable="true"` on mobile rows fails all three markup pins - the list row, the week card, and the byte-for-byte
difference - each by its own message, which is what says the three are independent rather than one assertion
written out three times; measuring the lift from the press point again fails "the
lift is measured from the FIRE point, past a threshold of its own"; dropping the armed `preventDefault()` fails
"the touchmove listener is NON-PASSIVE, and prevents the pan from the ARM"; collapsing the selection at the lift
again fails "the lift respects the selection instead of collapsing it"; and letting a non-list element under the
finger veto the gap fails "the GEOMETRY is authoritative for a gap". The e2e file grew six cases and two travel
constants - the lifting step is sized against the new threshold rather than the old slop, and a drift constant
that must decide nothing. One thing that file deliberately does NOT claim is the markup: the row HTML is rendered
by the host from its own `isMobile`, and the host under that spec is a desktop Joplin, so its native-drag case
takes the harder half instead - a row that really is draggable, in a webview that believes it is mobile, where a
dragstart must still be cancelled, lift nothing, and never reach the selection rewrite.)

The 351 it grew from: 350 before the SECOND PIXEL ROUND above, plus 1: the panel-wide contextmenu
suppression and the menu guard, pinned together with the fire order that makes the guard sufficient, the
editable-field exemption and the fields it exists for, and the four inline handlers (`formats.ts` and
`html.ts`) that are the hazard — the pin asserts those exist, so it retires itself honestly
if the markup ever stops emitting them. Two existing pins were rewritten in place rather than added to: the
suggestion list's contextmenu pin now asserts the ABSENCE of its own old `#searchSuggestions` scope, and the
trace pin carries the four new codes and the drop path's before/after pair. Four more mutations were run against
the round's own pins, each failing exactly the pin that names it: restoring the `#searchSuggestions`-only
condition fails "the suppression must NOT be scoped to the suggestion list any more" (and the rewritten
suggestion-list pin, which now names the same regression from the other side); dropping
`stopImmediatePropagation()` fails "the event must be stopped dead, or preventDefault alone leaves the inline
oncontextmenu handlers to run"; removing the `showNoteContextMenu` guard fails "a live touch gesture must block
any other opener of the context menu"; and swapping the fire's order so the arm runs before the menu fails "the
fire must open the menu BEFORE it arms the drag" twice over — in the new pin and in the redesign's own. That
last one is the interesting mutation: with the arm first, `touchDrag.active` would be true on the adapter's own
call and the guard would block the menu the hold exists to open, so the two changes hold each other up. A fifth
was run for the review round's fix — deleting the text-field exemption fails "that one return is the
text-field exemption", and re-scoping it as a ternary instead fails the early-return count, which is the
mutation the pin it replaced would have missed. Four more for the third round's, three of them
restoring the hole it closed and each caught by a DIFFERENT pin, which is what says the two teeth are pinned
independently rather than by one string: widening `CONTEXTMENU_TEXT_FIELD` back to a bare `input` fails "a
checkbox takes no text, raises no Paste bar and (for the checkbox) IS a row's tick circle"; dropping `.todo` from
`CONTEXTMENU_HANDLER_ZONE` fails "every to-do row, week card and note row is a .todo and every one of them
carries an inline oncontextmenu"; dropping the `!el.closest(CONTEXTMENU_HANDLER_ZONE)` conjunct altogether fails
"that one return is the text-field exemption"; and loosening the trace's zone words back to `.todo` / `h2` fails
"the zone word must be told apart by .todo[data-todo-id]". The harness count is unchanged at 351 across both
review rounds: every one of these assertions went inside the round's existing pin rather than into a new check.)

How the 350 it grew from was reached, and what was already proved by mutation, is unchanged below. 350 (347
before the redesign, plus 3: one driving the new pure
`firstMoveDirection` — including a grid sweep proving its slop gate cannot disagree with `movedBeyond` —
and two pinning the new order, the menu-before-arm fire with an arm that takes nothing, and the
first-move rule with the lift that closes the menu and takes the guard; the pins that encoded the old
order were rewritten in place, so the rest of the count is unchanged; the review rounds added
assertions inside those blocks rather than blocks of their own, so 350 has held since). Ten mutations
were run against it - six kinds in the first pass (seven edits: the sideways one was tried in two
places), three more for the pins the second round changed, and one for the third's - and each failed the
pins that name it:
taking the guard at the arm instead of at the lift ("the hold opens the MENU first...", "the FIRST move
decides...", "the drop message is posted BEFORE the guard release"), calling `preventDefault()` while merely armed ("the touchmove listener is NON-PASSIVE..."),
treating a sideways-first move as vertical both in the module ("touchDrag.firstMoveDirection...") and by
deleting the panel's bail ("the FIRST move decides...", "EVERY exit routes through that one end"), letting
a release-without-travel skip `endTouchDrag` so the `touchmove` listener outlives the gesture ("EVERY exit
routes through that one end", "a release that never moved tears the arming down..."), dropping the
`drag-uncancelable` trace on the lifting move ("the touchmove listener is NON-PASSIVE...", "the trace falls
back to the sticky toast...") and having the lift read `longPress.id` instead of the arm's snapshot ("the
hold opens the MENU first..."), and moving the `pointerdown`'s `fired` reset below its `#cockpitOverlay`
return ("a release that never moved tears the arming down..."). The second round's three: moving `armTouchDrag()` out of the fire's
`todo` branch into the else-if chain, which the old ordering-only pin let through and the containment
slice now catches ("the arm refuses the tick circle..."); deleting the arm's `endTouchDrag('re-arm')`
("the hold opens the MENU first..."); and giving `.todo.-dragging` a `padding-left`, which would move
every row under the index the arm had already measured ("panel.css touch drag..."). Playwright:
`e2e/mobile-drag.spec.ts` was fourteen tests at the end of THIS round (twelve before it, plus two for Android's `contextmenu`:
one dispatching the event on a mobile-mode row and asserting it is `defaultPrevented` and opens NO
`#noteContextMenu` while the row still carries the inline handler that would have opened one, and one firing it
in the middle of a LIFTED drag — by the event and again by calling the row's own handler outright, which is what
an inline handler that survived would do — and then completing the drop, which must still land the to-do
strictly between its new neighbours as read back from Joplin. The event is synthetic in both, deliberately: what
is under test is the event PATH, which a dispatched `MouseEvent` exercises exactly, while the gesture that
produces it on the device is Android's and no harness of ours can make Chromium under Xvfb emit it. The gesture
halves are real CDP touch as everywhere else in the file.) Of the twelve that came before, the verifier ran the
file for the first time since the redesign and got eleven green, the ring case red for the spec reason above and
fixed there; the file is not re-run here — that is the verifier's, and the two new cases have never been run.
(The rounds after this one took the file to its shipped twenty, which is the number the `globalTimeout` note
above is sized for; fourteen is this round's count, not v2.3.0's.)

**The fourth Pixel round passed, and the trace goes quiet.** 18a: the hold opens the to-do's context menu
with the finger still down. 18b, the step the whole design rested on: keep holding and move, and the row
lifts — Android's compositor honours the cancelled `touchmove`, the list does not pan under the finger, and
neither the cheap fix (registering the listener once at load) nor the drag-handle fallback is needed. And a
gap drop landed: the to-do came back from Joplin due strictly between its new neighbours. That is the
gesture end to end on a real device, which is what four rounds were for.

So the diagnostic that got us there leaves the Settings screen at the owner's request. `gestureTrace` is now
registered `public: false` in `src/core/settings.ts`: Joplin keeps the setting, it still defaults to OFF,
`panel.ts` still reads it into the search-data island and every trace point in `panelWebview.js` is still
compiled in — it is simply never offered to a user, who has no reason to be shown a strip of `drag-target:`
codes. **Nothing was deleted.** The next device round turns the public flag back on in a dev build, rebuilds
and sideloads, and the trace is exactly what it was for these four rounds; MOBILE.md §7 and every checklist
step that said "Settings → Cockpit" now say that instead. The harness pin for the setting was rewritten in
place rather than dropped — it asserts the hidden shape (`public: false`, and no enabled spelling left in the
block to contradict it) on top of everything it already asserted about the default, the type, the island and
the reader — so the count stays at 359, and README's settings list, which describes the Settings screen,
loses the bullet that is no longer on it.

**The merge review, and the numbers it caught.** The independent read of the merge found one real defect: the
"Where the trace is now" paragraph had been spliced into the MIDDLE of a sentence in MOBILE.md §7 — the line
ending "...told apart at a glance, which is the whole" was cut off from "job of the trace on the device", and
with no blank line between them the rendered Markdown ran the broken half into the new bold paragraph. The
block now sits after the ring-of-12 paragraph that used to be interrupted, and the sentence reads as one line
again. That is the one doc the next device round reads end to end, so it is the one that had to be right.
Three counts were wrong with it. `playwright.config.ts` justified the 25 → 30 minute cap with "sixteen cases"
while `e2e/mobile-drag.spec.ts` holds twenty (`test()` calls, none skipped) — ironic in a comment whose other
half was fixing stale numbers, and now twenty, matching the `globalTimeout` note in this entry. The v2.3.0
entry also said the spec "is fourteen tests now"; that was true of the round it describes and stale by the
time the entry shipped, so it now says *was*, at the end of THAT round, with a clause pointing at the shipped
twenty. And the hidden setting's label had grown a "(diagnostic, hidden - see src/core/settings.ts)" suffix —
text no user can ever reach, pointing a developer at the file they would already be reading, and actively
wrong in the dev build where the flip makes it visible again; it is back to the shipped "(diagnostic)". Two
things the review raised were documented rather than coded. A user who turned the trace ON in a shipped build
(public from 1.9.10 through 2.2.1) keeps their stored `true` with no switch left to turn it off: a forced
`setValue(false)` on upgrade would have to be gated or it would stamp out the dev flip the next device round
depends on, and the population is mobile users who deliberately enabled a diagnostic on a sideload, so §7
names the case instead of fixing it. And the dev-build recipe now says why it stops at `npm run dist`: with
`public: true` in place the harness pin that holds the setting off the Settings screen fails BY DESIGN, which
is a confused minute saved for whoever runs the next round.

## 2026-09-03 — v2.4.0: commands for Whereabouts

Cockpit gains two commands it never calls itself. The Whereabouts plugin puts a notebook chip under the note
title; its left click runs core's `openNote` and then fires `joplin.commands.execute('cockpit.filterByNotebook',
folderId)`, its double click reveals the note in Joplin's own list and then fires
`joplin.commands.execute('cockpit.revealNote', noteId)`. Both are fire-and-forget over there and every failure is
swallowed — `CommandService` throws on an unknown name, and Whereabouts must work identically with and without
Cockpit — so **the two names ARE the contract**. Renaming one here does not break a build anywhere; it silently
stops the integration working, which is why the harness pins the two strings verbatim with a comment saying who
calls them, and pins the whole registration set beside them so a command added or dropped is a deliberate edit of
one line. They are namespaced (`cockpit.`, unlike the three plain names this plugin has carried since Agenda),
labelled so the command palette can reach them, and given no menu or toolbar item: neither is useful without an
argument.

**`cockpit.filterByNotebook` is the dropdown, without the dropdown.** The panel's own `notebookFilterChanged`
branch used to write the three lines of state itself; it and the command now share one exported
`setNotebookFilter`, so the two routes cannot drift apart — a source pin asserts the branch calls it and assigns
nothing. `""` or a missing argument clears the filter, exactly as the dropdown's own "All notebooks" row does. An
id the notebook map does not hold is a **no-op, not a clear**: a caller that has lost track of a notebook (a
deleted one, a stale chip) must not silently blank the filter the user is working in, and the panel is not
repainted for it either. The saved profile is untouched — the filter is where the user has navigated to, not a
setting — and since the whole thing is state plus one refresh, with no panel show or hide anywhere in it, it
behaves identically on the mobile panel tab.

**`cockpit.revealNote` is a cascade, and the last step is the interesting one.** Desktop only, for exactly the
reason `togglePanelVisibility` is: on mobile the panel is a tab inside Joplin's own plugin-panel dialog, which
the user opens and closes, so a plugin that shows or hides it there is fighting the app — a mobile reveal
therefore does nothing at all rather than half of it. On desktop the note is read first (five fields), so an id
that resolves to nothing leaves everything exactly as it was; a hidden panel is then shown, because
`refreshPanelData` does no work while the panel is hidden and every render below would otherwise paint nothing.
Then: (a) the note already renders — nothing about the view changes; (b) it does not, so the filter switches to
the note's OWN notebook and the typed search is cleared (the two live states the panel's own controls write; no
profile is switched and none is written); (c) it *still* cannot be listed, and this is the case the owner had to
call.

A plain note under a to-dos-only profile, a completed to-do the completed switches hide, an item the profile's
own `searchCriteria` excludes, a note inside an excluded notebook: no filter can put any of those on screen. The
two obvious answers were **do nothing** — which leaves the user staring at a panel that did not answer a request
they made deliberately from another plugin — and **a toast**, which tells them about a note instead of showing
it. The owner chose neither: the note is **pinned below the list as the same read-only peek row the "results
outside current filters" section already draws**, under its own heading, taking the muted `-excluded` heading
variant when it lives in an excluded notebook — the one case where the panel is showing something the user
deliberately hid, and should say so. It is not draggable, not selectable, and openable, exactly like every other
peek row, because it is literally `renderPeekRows`.

**"Would render" is never re-implemented.** The membership question — profile search criteria, typed search text,
notebook filter with its descendants, the exclusion boundary, `showNotes`, the four completed switches — already
has one answer in this codebase, and a second copy of it in the reveal would rot within a release. So each step
of the cascade simply *renders* and then asks the produced markup whether the row is in it
(`renderedRowIsListed`, a substring test on `lastRenderedHtml`, which holds the current markup whether the paint
happened or the equality guard suppressed it). The cost is up to three renders for the worst case and exactly one
for the common one; the benefit is that the reveal cannot disagree with the panel about what the panel shows.

**The flash rides in the markup, not in a message.** The revealed row is scrolled to centre and flashed for ~1.5s
with `.todo.-revealed` — distinct from `.-selected` on purpose, since the revealed note is usually *also* the
note the editor just opened and therefore already wears that highlight (Whereabouts' left click opens it, which
reaches the panel through `trackEditorNoteSelection` as it always has). The obvious implementation — post a
message after the render — races the render it is about: the row may only exist in a paint that has not landed
yet, and on mobile a `setHtml` is a full webview reload that eats the message. So the host embeds
`data-reveal-id` (a sequence number) and `data-reveal-note` on the `.todos` container, and `reconcile()` consumes
a marker **once, and only on a render that actually holds the row** — the earlier paints of the cascade carry the
same marker without the row and deliberately leave it unclaimed. The marker is part of the equality-compared
content, so a new reveal gets past the guard even when the view is otherwise byte-identical, while an unchanged
marker leaves the guard exactly as strict as it was. The scroll waits two frames, because `restoreTodosScroll`
puts the list back where the user had it on the next frame and would otherwise undo it, and then records itself
as the remembered position so the following background refresh does not take the revealed row straight back off
screen.

**The pin's lifecycle is the user's, not the timer's.** It is host-held state re-emitted by every render, so a
sync landing, a tick or the 60-second backstop leave it alone; it goes when the user moves on — a profile switch,
a notebook change (from either route), a search commit, the next reveal, and opening the pinned row itself, which
is the one clear that needs a repaint of its own since opening a note mutates nothing.

**e2e turned out to be feasible, which was not the expectation.** A plugin command that takes an ARGUMENT has no
in-app trigger a spec can click: Joplin's command palette runs a registered command but passes it nothing, and
the renderer is a webpack bundle whose own services `window.require` cannot reach — it resolves real node modules
(`electron`, `@electron/remote`, which is how `activateJoplinMenuItem` already works) but any `@joplin` module
would come back as a second, unconnected copy whose singletons know nothing of the running app. Reading the
packaged AppImage settled it: Joplin publishes the running instances itself — `window.joplin = { commandService,
pluginService, bridge, ... }` — in an app-startup step gated on `Setting.value('env') === 'dev'`, and `--env dev`
is a flag its own parser accepts. So `launchJoplin` grew an `envDev` option used by this one spec, and one helper
executes a command through the very `CommandService` entry point a plugin's `joplin.commands.execute` lands in.
`e2e/whereabouts-commands.spec.ts` holds three cases: `filterByNotebook` filters the panel and `""` clears it;
`revealNote` on a note outside the filter switches the filter to its notebook and its row is seen carrying the
flash class (watched with a `MutationObserver` installed before the call, since ~1.5s is too short to poll for);
and `revealNote` on a plain note under a to-dos-only profile pins the peek row. **None of it has been run here** —
e2e is the verifier's, and this spec is the first in the suite to start Joplin with a Joplin flag, so it is also
the first thing to look at if the file misbehaves; the owner has Whereabouts installed and checks the pair by
hand besides.

Suite: 375 harness checks (sixteen new), all passing. Sixteen because the reveal is mostly *behaviour*: the two
command names and the full registration set; four for `filterByNotebook` (filter and mark, `""` and no argument,
the unknown-id no-op, and the shared write plus "no setting or profile written"); eight for `revealNote` (already
in view, the notebook switch with the search cleared, the pinned peek row, the `-excluded` heading, survival
across a sync refresh, all five clears, the hidden panel, the unresolvable id) plus the mobile case; and two
source pins for what the Node harness cannot execute — that `reconcile()` claims the marker after the
row-not-found return and never twice, and that the flash class is distinct from `-selected` and changes no row
box. `panels.visible`/`show` became stateful in `test/harness.js` (an unknown handle is still visible, as it
always answered), which is what made the hidden-panel case writable. Five mutations were run against the pins and
each was caught: renaming a command (the contract pin, plus every case that executes it), making
`filterByNotebook` write `profile.notebook` (the "neither touches the profile" pin), making `revealNote` clear
the filter instead of switching it to the note's notebook, dropping the pin on a background refresh, and letting
`revealNote` act on mobile — the last three each by exactly the one pin written for them. Playwright: 112 tests in
18 files now (105 run, 7 opt-in showcase captures), three of them new here and none of them run in this pass.
