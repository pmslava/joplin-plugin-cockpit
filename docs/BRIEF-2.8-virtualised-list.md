# Cockpit 2.8: the virtualised row list (orchestration brief)

Shelved 2026-09-30 by Slava's decision: 2.7.1 takes the to-do drawing cap instead; this brief stays as the plan for when a large-collection report asks for uncapped views.

Written 2026-09-30, the day v2.7.0 shipped, from a read-only survey of the rendering paths at commit 5c0233b. It is for the managing session that plans and runs the 2.8 build, in the shape of `docs/BRIEF-2.7-local-mirror.md`: what is measured, what the code does today, the proposed design, the open questions for Slava, the phases with their gates, and the standing rules.

Read these first: this brief, the 2.7 brief (its sections 4 and 8 still hold), `docs/DEVLOG.md` (the v2.7.0 entry and the 2026-09-29 entry), `docs/MOBILE.md`, and the project's main Joplin note (`164d64772c624ef99baeb751d4ef8e36`).

---

## 1. Where things stand

**v2.7.0 is released.** The data side is cheap: every view with no search syntax is drawn from the note store with no data call, and an idle minute costs one feed poll. What is left is drawing. The panel builds one DOM element tree for every row it shows, so the number of rows on screen is the last thing that can hang Joplin on a large collection.

**Measured on 20,000 notes + 1,000 to-dos** (`e2e/perf-large-vault.spec.ts`, from the 2.6.3 work; the numbers are the reason 2.8 exists):

| | rows drawn | DOM elements | first paint after UI up | main-window lag / 150 s | process-tree RSS |
|---|---|---|---|---|---|
| cap 1,000 notes (today) | 2,000 | 8,533 | 8.5 s | 1.3 to 1.8 s | 1.9 to 2.05 GB |
| no cap | 21,000 | 84,000 | 21.7 s | 55 s, stalls to 3.9 s | 3.2 to 3.5 GB |

The cap is only a guard against that drawing cost, and it guards one side: the **to-do side has no cap at all**. `getTodos` returns every to-do, and every format draws every to-do returned (interval, date and basic rows; the undated sections of month and week). A profile showing thousands of to-dos draws them all. That, not the Notes cap, is the stronger argument for 2.8.

**Non-goals for 2.8:** the search syntax and the search route (a typed search matching tens of thousands of to-dos still pages Joplin's search to the end; the route is the only one that understands the query); any change to what a row shows; the overview notes.

---

## 2. What the code does today (facts from the survey, with the places to look)

**The render pipeline.** `refreshPanelData` (`src/ui/panel/panel.ts`) claims a generation token, takes the 2.7 redraw stamp, builds the view state (calendar state, filters, sort, `priorityStart`, `notesLimit`, the ring options) and calls the format's `renderHtml()` (`src/core/formats.ts`), then `renderNotesSection`, the peek section, the revealed section and `getControlsHTML`. Everything is poured into `panelTemplate.ts` (13 lines): style, the platform marker, the controls, `<section class="todos" data-scroll-top data-render-nonce>` with headings and rows as its direct children, then the mobile islands. The equality guard compares the whole string before the scroll-top and nonce placeholders are filled; a paint is `joplin.views.panels.setHtml`. `revealNote` decides whether a note is on screen by searching the last rendered string for its id.

**The string is big and nothing measures it.** From the row templates: a desktop to-do row is about 1,300 bytes (inline `onclick`, `onmousedown`, `ondblclick`, `oncontextmenu`, `draggable`, `ondragstart`, `ondragend`, and hover-hint `title` attributes), a note row about 930, and each group heading carries every to-do id of its group in `data-todo-ids`. 2,000 rows are about 2.2 MB of markup; 21,000 rows about 20 MB. That string crosses the plugin-to-panel boundary on every paint, and on mobile it is the whole document the WebView reloads.

**The webview** (`src/ui/panel/panelWebview.js`, 4,895 lines) runs `reconcile()` on every DOM mutation; a render is "real" when `.todos` is a new node. It then re-attaches the scroll listener, restores the scroll offset in pixels (`savedTodosScrollTop`, or `data-scroll-top` on mobile), repaints the selection by id over every row, applies a pending reveal by finding the row and calling `scrollIntoView`, and restores the search field. Messages the webview posts include `scrollChanged` [scrollTop, nonce] (300 ms trailing throttle, both platforms) and `viewportHeight`; the host turns `scrollChanged` into `estimateFirstVisibleIndex()` = `floor(scrollTop / 40) - 2`, which is the only viewport knowledge the host has and only feeds the ring fill's priority. There is no first-visible index, no visible-range report, no IntersectionObserver.

**Rows are not one height.** `.todo-title` has `overflow-wrap: anywhere` and no `white-space`, `text-overflow` or line clamp: a long title wraps to as many lines as it needs, and the CSS comment on `.todo` says single- and multi-line rows align identically by design. The due text is a prefix inside the title, so it only adds to wrapping. The notebook pill never wraps (ellipsis at 38% width) but narrows the title. Completed, selected, dragging, revealed and drop-target states change colours, opacity, outlines and inset shadows, never the box. A single-line desktop row is about 27.5 px (13 px font, line height 1.5, 4 px padding); mobile rows are taller (about 16 px font). Font and circle sizes are user settings. Headings are sticky `h2`s (`position: sticky; top: 0`) with `data-drop`, `data-drop-end` and `data-todo-ids`; the week planner's are static.

**A row is 4 elements** (the `div.todo` root, the checkbox or progress span, the title anchor, the notebook pill; 3 without a pill; a week card 6), about 11 nodes with text and template whitespace. 84,000 / 21,000 = 4.

**Display formats** (`displayFormat` on the profile: `basic`, `interval` (default), `date`, `month`, `week`): basic is one flat list with no headings; interval and date are flat lists of `h2` and rows as siblings under `.todos`; month draws a bounded grid (dots capped at 4 per day) plus the selected day's rows and an unbounded undated section; week draws a 7-column CSS grid of cards plus the undated section. Every format appends the Notes section (capped by `notesLimit`), the peek (typed search, empty view, up to 15 rows) and the revealed pin. **Unbounded today:** basic, interval, date, the two undated sections, the Notes section up to the cap. **Bounded by days:** the month grid and its selected day, the seven week columns.

**Everything that keys on row DOM** (all in `panelWebview.js`):
- Selection holds ids (`rowSelection.js`), repainted over all rows by id; the Shift range and the Escape collapse read the DOM order of every rendered row; `schedulableSelection()` drops a selected to-do whose row is not in the DOM from drag and alarm payloads.
- The editor highlight is an id painted over all rows; an id with no row paints nothing.
- The context menu is an inline handler per row, dispatching on the clicked zone; the heading menu reads the group from `data-todo-ids`.
- No keyboard navigation on rows.
- The desktop drag reads its payload membership from the DOM (`allTodoRows()` in the payload get `-dragging`); whole-target drops are inline handlers on every `[data-drop]`; between-row drops use the hovered row's `getBoundingClientRect` (40% bands), require `row.parentElement` to be `.todos`, and walk `previousElementSibling` to the nearest `h2` for the group and to the nearest non-dragged row for the neighbours; the edge auto-scroll runs a rAF loop on the scroll container and re-resolves the target with `elementFromPoint` each frame.
- The mobile touch adapter builds a row index (`buildRowIndex`: a rect plus the group walk for every to-do row, quadratic within a group), shifts it by the scroll delta, rebuilds it when a rect is off by more than 2 px or a row is detached, resolves gap targets from the index and neighbours by sibling walks.
- Scroll restore is pixel-based and assumes the same content laid out at the same heights above the offset.
- Reveal needs the node in the DOM; the host decides "listed" from the whole string.
- The search field lives outside `.todos` and does not depend on rows.
- `-dragging` is swept over all to-do rows on drag end.

**Mobile** (`docs/MOBILE.md`): every render is a full WebView reload of the whole document; module state dies; the host embeds the overlay and search state as JSON islands and the scroll offset and nonce as attributes on `.todos`; a fresh webview posts `dialogGuardReset` and the host re-renders once if it holds state the document lacks; `dialogGuard` holds renders during overlays and the touch drag; rows render without `draggable` and a capturing `dragstart` cancels Android's native drag; `contextmenu` is suppressed panel-wide; the default refresh interval is 120 s; there is no multi-select and no reveal on mobile.

**Where the time goes: nothing measures it.** `instrument.ts` counts renders and paints and times a refresh only under a `DEBUG` flag that is off. The perf spec samples the main window (a 100 ms heartbeat, long tasks, a 2 s probe, RSS) and, in the panel frame, the row count and the element count; it seeds `TODOS = round(NOTES * 0.05)`, so 20,000 notes give 1,000 to-dos and a thousands-of-to-dos scenario needs a seed change. The no-cap run was made by editing `NOTES_BATCH` in a scratch build.

**Pins on markup.** In `test/run.js`: about 118 checks read the rendered panel string for row presence, titles and headings; 17 use the ordered readers `readSections` and `drawnRows` (regexes over the string, the latter tied to exact class spelling and attribute order); 8 row-markup pins slice the row's root tag and pin its classes and handlers, and that a mobile row is the desktop row minus the drag attributes byte for byte; heading pins for `data-drop`; the cap pins; about 83 read `panelWebview.js` as source text to pin function bodies (touch drag, between-drop, selection, contextmenu). The harness never runs the webview in a DOM. The e2e helpers read every row in the DOM (`.todo-title`, `.todos h2`, `.todo[data-todo-id]` by text); the row-interaction specs are mobile-drag (20), drag-autoscroll (10), multi-drag (5), selection-crossing (4), mixed-selection (3), multi-context-menu (5), row-click-open (2), clipboard-copy (5), type-flip (4), store-freshness (4), panel-todos (8), whereabouts-commands (4), search-commit (10), calendar (7), profiles (6), themes (2).

**The cap today.** `NOTES_BATCH = 1000` and `notesLimit` in `panel.ts`, passed in the view state to `renderNotesSection`, which calls `getNotes({ limit })` and draws the footer with the "show more" button when more exist; `getNotes` keeps the limit in its cache key, `readStoreNotes` reports `more`, `listRecentNotes` walks newest first up to the limit, and a **filtered search slices to the limit** because the search route re-runs the whole search per page. Other caps that are not row caps: the peek (15 of 50), the month dots (4), the ring bodies (300 per refresh).

---

## 3. Goal

The panel draws only the rows in and around the viewport, whatever the size of the result, on both platforms. A view of any size scrolls smoothly; the Notes cap and its footer go wherever the store serves the view; a profile with thousands of to-dos stops being a hang. On Slava's collection nothing is visible.

**Acceptance at 20,000 notes + 1,000 to-dos with no cap** (the perf spec, 150 s window): first paint no worse than the capped 8.5 s; lag no more than 1.8 s; no stall over 1 s; process-tree RSS no more than the capped run's; DOM elements in the panel bounded (a few hundred, independent of the collection). **A second scenario, new:** 20,000 notes + 10,000 to-dos on an interval profile, same targets. **On Slava's collection:** the full e2e green and no visible change.

---

## 4. Proposed design (for Slava's review before any code)

**The principle.** The host stops sending drawn rows and sends the *sequence* instead; the webview draws a window of it. Everything that today walks the DOM (the group of a row, its neighbours, the selection order, the reveal target) reads the sequence.

**Why not window the HTML the host already builds.** The tempting cheap route is to keep the row HTML and let the webview insert only a slice of it. But on desktop `setHtml` is an innerHTML on the live document, so the browser parses *and lays out* every row before the webview script runs; putting the rows inside an inert `<template>` would avoid the layout but not the parse, and 20 MB of markup at 21,000 rows is a parse of the order of a second on every paint, per action, which is the stall the targets forbid. The sequence as JSON is about 150 bytes a row, 3 MB at 21,000, parsed in tens of milliseconds, and it can also be the mobile island the reload already needs.

**The sequence** (built where the formats build rows today, in `formats.ts`): an ordered array of items for the flat formats: `{ kind: 'heading', text, drop, dropEnd, todoIds }` and `{ kind: 'todo' | 'note', id, title, label (the format's prefix), notebookId, notebookTitle, path, percent, completed, plain, hints }`, plus the section boundaries the panel draws around them (the Notes section, the peek, the revealed pin). Month and week keep their grids as HTML (bounded); their undated sections and the selected day's rows become sequences drawn by the same list. The host still builds the controls, the theme and the islands as HTML.

**Two pure modules in `src/ui/panel/`**, harness-`require()`d like `rowSelection.js` and `touchDrag.js`:
- `rowMarkup.js`: turns one item into exactly the markup `formats.ts` emits today, byte for byte, so the 8 row-markup pins and the mobile-minus-drag rule move with it and lose nothing.
- `virtualList.js`: the arithmetic. Given the sequence, a height per item (measured when known, a per-kind estimate otherwise), the container height and the scroll offset, it answers which item range to draw, the sizes of the two spacers, the index of an id, the scroll offset that puts an id at a chosen place, and the "anchor": the first visible item and the pixel offset into it, which is how scroll position is carried across renders instead of a raw pixel count.

**The window in the webview.** The live `.todos` holds: the sticky heading of the group the first visible row belongs to, a top spacer, the drawn items (the visible range plus about two screens of overscan above and below), a bottom spacer. On scroll and on resize the range is recomputed and rows are added or dropped at the edges; drawn rows are measured on insert (one forced layout per batch) and their heights cached by id and width, so the spacers converge to exact sizes. Chromium's scroll anchoring keeps the viewport still while heights above it are corrected. A render replaces the sequence and redraws the window at the saved anchor; the equality guard compares the sequence JSON as it compares the HTML today.

**What moves from DOM walks to the sequence:**
- between-row drop: the group and the neighbours of the hovered row by index, which also removes the quadratic index build on mobile;
- selection: the Shift range and the Escape collapse in sequence order; `schedulableSelection()` from the sequence, so a selected to-do outside the window is no longer dropped from a drag or alarm payload;
- the editor highlight and the selection are painted on the drawn rows only, from ids, as today;
- reveal: index by id, scroll to it, draw, highlight; the host's "is it listed" question is answered from the sequence, not the string;
- `-dragging` and `-selected` are applied to drawn rows when they enter the window.

**What the host learns.** The webview reports the visible range (first and last drawn index, and the anchor) with the existing `scrollChanged` message. `priorityStart` becomes exact and the 40 px estimate goes; the ring fill can also stop at the drawn range plus overscan instead of 300 bodies by list.

**Mobile.** The sequence rides in the document as a JSON island (as the search data does), the anchor is host-held and re-embedded (as the scroll offset is), and the touch adapter's row index is built from the drawn rows only, which is what it needs. The window is the same code on both platforms; the payload the reload carries shrinks from megabytes of rows to the JSON.

**The cap.** Goes for store-served views. Stays, with its footer, for search-served notes: a filtered notes search pages Joplin's search, and the 1,000 cap is what keeps that paging bounded; the footer says so.

**Row height: the one design decision that is Slava's**, see section 5.

---

## 5. Open questions (bring them as concrete examples, with a recommendation)

1. **Keep wrapping titles, or make rows one line?** Example: a to-do titled "Call the accountant about the VAT return for the Berlin office before the filing deadline" draws today as two or three lines. With one-line rows it draws as "Call the accountant about the VAT return for the Ber…" with the full title on hover, and every row is exactly the same height, which makes the window's arithmetic exact and the scrollbar honest from the first frame. With wrapping kept, the list measures rows as they appear and estimates the ones it has not seen, so the scrollbar's length adjusts slightly as you scroll far, and the code is larger. Recommendation: keep wrapping. 2.7's rule, no user-visible change except faster, applies; the measured-height list is a well-known technique, and the cost is engineering, not the user's.

2. **The same windowed list on mobile, or keep mobile as it is?** Example: the Pixel with 21,000 notes today reloads a 20 MB document on every render; with the window it reloads a 3 MB island and draws fifteen rows. The risk is the touch adapter and the anchor restore across reloads. Recommendation: the same list on both platforms, proven in the Pixel round; a phone is where drawing hurts most.

3. **Remove the Notes cap entirely, or keep it where the search serves?** Example: a profile with the criteria `tag:project` and 30,000 matching notes; without a cap the search route would be paged to the end at about a second a page. Recommendation: the cap and its footer stay for search-served notes only, and go for store-served views; the footer text names the search as the reason.

4. **Rows drawn by the webview from the sequence (the design above), or the host's HTML windowed in the webview?** Example: after a checkbox tick at 21,000 rows, the HTML route re-parses 20 MB in the panel before the script can act, about a second of frozen window; the sequence route parses 3 MB of JSON and redraws fifteen rows. The price of the sequence route is the move of the row templates into a webview module and the retargeting of the checks that read rows out of the host's string. Recommendation: the sequence route; the HTML route cannot meet the stall target at scale.

5. **Where the work stops.** Example: the month grid's dots and the week planner's seven columns stay as they are, bounded by days; only flat lists get the window. Recommendation: yes; and the overview notes and the search field are untouched.

---

## 6. Phases and gates

Each phase ends with: harness green, a reviewer pass (plain-text report; a verdict of ISSUES only for a MUST-FIX item), and a local commit. Push only after Slava tests and approves.

0. **Design check-in with Slava** (section 5). No code before this.

1. **Measurement spike** (e2e and scratch only, no product code). Prove where the 21.7 s goes at 21,000 rows: the host's markup build time, the paint call, and the panel's parse plus layout (a scratch build with `DEBUG` on and a probe around `setHtml`); a static page with 21,000 rows drawn through a prototype window in the perf harness, measuring first paint, lag and elements with wrapping titles and measured heights; a seed option for thousands of to-dos (`PERF_TODOS`). Write the findings into this brief.

2. **The sequence and the two pure modules, drawing everything.** `formats.ts` emits the sequence for the flat formats and the undated sections; `rowMarkup.js` draws an item byte-identically to today; the webview draws the whole sequence (no window yet), so behaviour is unchanged and the full e2e proves it; the equality guard compares the sequence; the markup pins move to `rowMarkup.js`; the checks that read rows out of the host string read the sequence through one helper. Gate: harness green with the same pins in their new home, the full e2e green, the panel's rendered rows byte-identical to before on the showcase fixtures.

3. **The window on desktop.** `virtualList.js`; spacers, measured heights, the anchor; the sticky current heading; the visible-range report and the exact `priorityStart`; reveal by index; the interactions moved to the sequence (between-drop, selection order, payload membership, `-dragging` on entry); the edge auto-scroll proven with the window. Gate: the row-interaction specs green, a new spec that scrolls a 5,000-row list and drags across a window boundary, and the perf spec at 21,000 rows with no cap meeting section 3. This is the riskiest phase; its review is the build's hardest.

4. **Mobile.** The JSON island, the host-held anchor, the touch adapter on the drawn rows, `mobile-drag` green under desktop Joplin with the forced platform marker, then the Pixel round with the gesture trace. Gate: mobile-drag 20 of 20 and Slava's device round.

5. **The cap.** Goes for store-served views, stays with its footer for search-served notes; the 10,000 to-do scenario; the ring fill bounded to the window. Gate: both perf scenarios meeting section 3, the cap pins retargeted to the search path only.

6. **Release gate:** full harness, full e2e on main, both perf scenarios, CI on the pushed SHA, the Pixel round, build and install and stop, then Slava's word for the release.

---

## 7. How to run the perf check

As in the 2.7 brief, section 7, with two additions the spike introduces: `PERF_TODOS=<n>` for the to-do count of the seed (a new template per combination), and `PERF_NO_CAP=1` to run a build with the cap lifted without editing source. Until the spike lands, the no-cap scenario is produced by editing `NOTES_BATCH` in a scratch build.

---

## 8. Standing rules

Section 8 of the 2.7 brief applies unchanged: who codes, publishing needs Slava's explicit approval per release, the release procedure, the e2e discipline (one run machine-wide, 4 GB free, `E2E_LOCK_WAIT_MS`, implementers never run e2e, the launcher keeps the throwaway Joplin out of the OS keyring), the sandbox-proxy rule, MEGA, commit subjects, plain-text reviews, one warm worktree per work-arc, announcements only for things users should try. Two rules from 2.7's build to keep: a reviewer's verdict of ISSUES is reserved for a must-fix, and a verifier writes the wrapper's exit code into the log and reads the run's own summary line.

---

## 9. Loose ends from 2.7

- Next-pass items recorded in the 2.7 brief: a write-through cache for `currentProfileID` so the actions' gate costs no host read; a version gate for the native move's ladder once the Joplin release that made the command await its prompt is known. **Done in 2.7.1:** the cache is in `settings.ts`, and the gate starts at Joplin 3.5.9 (`MOVE_COMMAND_AWAITS_FROM` in `panel.ts`).
- Dead code the survey found in `panelWebview.js`: `sortFieldClicked` and the three profile-button handlers have no callers and, for the first, no host handler. **Done in 2.7.1:** all four removed, after a repo-wide search found no reference.
- The worktree `~/worktrees/cockpit-2.7` is warm with the 20k perf template copied in; reuse it for 2.8 under a new branch.
