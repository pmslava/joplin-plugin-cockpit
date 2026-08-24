# Cockpit — Mobile Readiness Runbook

Maintainer notes for running Cockpit on Joplin mobile (Android/iOS). Cockpit did a first mobile
pass in v4.0.0 (platform detection, `isMobile` toolbar/menu guards, inline SVG icons, settings-based
storage, mobile-only styler/profile buttons). A second, larger mobile phase then landed across three
commits (dialog stacking guard, touch-interaction layer, command fallbacks + responsive alarm
dialog). This document records what is implemented, what is still queued, and — most importantly —
the **step-by-step checklist Slava follows on the Pixel for the first sideload session**.

Every mobile behaviour is gated on the platform flag (`isMobile()` / `requireNodeModule`, from
`src/core/platform.ts`) or on the `.cockpit-mobile` body/wrapper class, so **desktop behaviour is
unchanged**. When something below says "mobile only", that guard is why.

## Current status

- **Manifest** (`src/manifest.json`): `platforms: ["desktop","mobile"]`,
  `app_min_version_mobile: "3.3"`, `app_min_version: "2.9"`. 3.3 is a safe floor: the
  `#joplin-plugin-content` styling hook Cockpit's CSS relies on arrived in Android v3.1.6, and
  panels + dialog webviews + `versionInfo().platform` + guarded commands are all present by 3.3.
  One known caveat lives past this floor: Android **v3.4.6** (2025-09-01) fixes "plugin panel buttons
  are off-screen on recent versions of Android", which can make the alarm dialog's OK / Clear /
  Cancel buttons unreachable on 3.3–3.4.5 on newer Android. Kept at "3.3" for reach; revisit only if
  the Pixel reproduces the off-screen-buttons bug (checklist step 8).
- **Build / sideload**: webpack `target:'node'` with node builtins set `false`
  (`webpack.config.js`); node modules (sqlite3, fs-extra) are pulled only via `joplin.require` behind
  `requireNodeModule` guards, never hard-bundled, so the mobile bundle carries no node-builtin
  requires. Webview scripts (`panelWebview.js`) are copied verbatim. The **same platform-agnostic
  `.jpl`** (`publish/io.github.pmslava.cockpit.jpl`) serves both platforms; it self-detects at
  runtime. `.jpl` sideloading on mobile is supported (Settings → Plugins → install from file). No
  polyfill work is needed.
- **Perf already guarded**: `refreshPanelData` bails when markup is byte-identical
  (`lastRenderedHtml`); checkbox body fetches capped 300/refresh in chunks of 20, cached by
  `user_updated_time` (`src/core/joplin.ts`); notebook map + tag list TTL-cached 20s.

## Overlay architecture — why dialogs no longer hide behind the panel

The earlier "timing guard" (a one-tick yield before `dialogs.open()`) was based on a wrong model and
has been **removed**. The real mechanism, confirmed against Joplin mobile source, is *structural*, not
a race:

- The panel **viewer** is a React Native **native** `<Modal>` (a separate Android OS window).
- Every plugin **dialog** is a react-native-paper **in-tree** overlay teleported through a `Portal`.
- A native window *always* draws above an in-tree overlay. So a dialog opened while the viewer is up
  is **unconditionally** behind it — no z-index, elevation, declaration order, or attach-timing trick
  can lift it. This is why the device showed dialogs behind *consistently* and why the yield changed
  nothing.

Two strategies avoid the layering entirely (both gated on `isMobile()` / `.cockpit-mobile`; desktop
keeps native dialogs with unchanged timing). See `src/core/dialog.ts`.

### 1a. In-panel HTML overlays — every picker and the profile editor (notebook, tag, alarm, editor)

Drawn as fixed-position HTML **inside** the panel webview (`panelWebview.js`), so they create no
second Modal and are structurally immune to the bug; the panel is never torn down. As of this round
the profile editor joins the pickers — the dismiss-first native-dialog flow is gone (see §1b).

- **Notebook picker** (move-to-notebook, create-in-notebook, move-notebook-under): a scrollable list
  reusing the notebook rows the panel already embeds. On tap it posts a result; the host runs the same
  `parent_id` PUT / create path as before.
- **Tag picker**: a single comma-separated text input prefilled with the note's current tags; on OK
  the host keeps the exact attach/detach diff (`setTagsFallback`).
- **Alarm ("Move to date")**: the calendar grid + hour/minute columns + Today/Tomorrow/+week/+month
  quick buttons, ported from the desktop alarm dialog into the panel with an OK / Clear / Cancel
  footer. The grid is drawn immediately from the (possibly empty) fields so the picker is usable even
  if the `getAlarmInitial` prefill round-trip rejects (e.g. a selected note was just deleted), then
  redrawn from the prefilled values.
- **Profile editor** (`openEditorOverlay`): the full ~25-field form ported into the overlay body
  (`EDITOR_FORM_HTML`, scoped `.cockpit-editor-overlay` CSS), replacing the old native dialog. Create
  starts at the template defaults; edit prefills via a `getEditorInitial` round-trip (mode + the
  profile as a plain object, no base64). Footer is Cancel / Create, or Cancel / Delete / Save; Save
  posts `['profileSaved', id, obj]`, Delete posts `['profileDeleteRequested', id]` — whose host handler
  **keeps the native "Delete <name>?" confirm message box and the ">1 profile must exist" guard**
  unchanged (a native message box draws correctly above the panel). Desktop still opens the native
  editor dialog untouched.
- **Shared plumbing**: while an overlay is open the webview posts `['dialogGuard', true/false]`, which
  bumps the shared `dialogOpenCount`; `refreshPanelData` (mobile only, `isDialogOpen()`) skips a
  refresh so nothing repaints underneath. Overlays anchor on `document.body` so a stray re-render
  cannot destroy them, and the long-press/scroll listeners ignore events inside an overlay. Each fresh
  webload posts `['dialogGuardReset']` so a guard leaked by a webview torn down mid-overlay cannot
  pause refreshes forever.

### 1a-bis. Overlay reload-survival — reconstructing an overlay after a host-initiated webview reload

An in-panel overlay is immune to Cockpit's own refreshes (the guard above), but **not** to a
*host-initiated* WebView reload: an Android renderer-process kill under sync load remounts the panel
webview with a fresh document, and Joplin re-serves the **last** document it held — the pre-overlay
snapshot (the guard blocked any newer `setHtml` while the overlay was up). That reload wipes the
overlay, and the plugin's guard cannot help (the reload is host-initiated, not a Cockpit `setHtml`).

Fix, mirroring the scroll-persistence pattern: the **host owns** an `openOverlayState` descriptor.

- The webview posts `['overlayState', descriptor]` on open and (throttled, `queueOverlayState`) as the
  user edits. The descriptor is small and fully rebuildable — notebook: purpose/opts/selection; tag:
  noteID + text; alarm: ids + date + time; editor: profileID + serialized field values.
- On the fresh webview's `['dialogGuardReset', hasIsland]`: if an overlay should be open and the loaded
  document does **not** already carry the descriptor island, the host re-renders **once** with the
  descriptor embedded as a `<script id="cockpitOverlayState">` JSON island next to `cockpitSearchData`
  (tagged by `renderNonce`, `</` neutralised). `reconcile()` on the reloaded webview reads it and calls
  `openNotebookOverlay/openTagOverlay/openAlarmOverlay/openEditorOverlay(..., restore)` to rebuild the
  overlay from the saved values, which re-arms the guard. A document that already carries the island
  reports `hasIsland` true and reconstructs itself, so the host skips and the flow cannot loop.
- The host **clears** the descriptor synchronously on the `dialogGuard(false)` close path (the webview
  posts no separate `overlayState:null`, to avoid a close/refresh ordering race), so a post-close
  render can never resurrect a just-dismissed overlay.
- **Prefill-window safety**: the tag / alarm / edit-mode-editor overlays post their descriptor **only
  after** their prefill round-trip resolves, never from the empty/default fields beforehand. A reload
  landing in that sub-second window would otherwise leave the host holding a *defaults* descriptor
  (empty tags, empty alarm, or an edit form full of create-defaults) and a reconstruct would resurrect
  a wrong overlay whose commit resets the profile / clears the note's tags. Not posting until real
  values are in hand means a reload strictly inside the window loses the overlay (safe — nothing to
  commit) while it stays reload-survivable for the rest of its life. (Create mode has no round-trip and
  posts its correct defaults immediately.)
- **Known gap (accepted):** a *second* renderer kill within one overlay session can reconstruct from
  the first served-document snapshot rather than the host's fresher `openOverlayState`, losing edits
  made after the first reconstruct. Requires two kills in one overlay session, is non-looping and
  non-destructive; tightening it would need a version/nonce on the descriptor, disproportionate here.

### 1b. Native dialogs that remain (desktop only)

The dismiss-first machinery (`openDialogDismissingViewer` / `notifyViewerDismissed` /
`dismissPluginPanels`) is **removed** — the profile editor is now an overlay (§1a) and no mobile caller
remained. The CSS **styler** keeps its native dialog, but it is reachable on **desktop only** (from the
Tools menu; the mobile styler button was removed), where `openPluginDialog` opens it directly with no
viewer stacking to work around. The editor's **delete confirmation** stays a native message box on both
platforms (it draws above the panel on mobile).

### 2. Touch-interaction layer + tap targets + viewport (`panelWebview.js`, `panel.css`)

All gated on the mobile flag (`IS_MOBILE` / `.cockpit-mobile`), so desktop click, dblclick,
`contextmenu` and HTML5 drag are untouched.

- **Long-press context menus**: a Pointer Events adapter (500 ms; cancelled by >10 px move, pointer
  up/cancel, or a list scroll) synthesises the three desktop context-menu handlers (to-do row, note
  row, group heading). The trailing synthetic click is swallowed so tap-to-open does not also fire.
- **Reschedule on touch**: a mobile-only "Move to date…" to-do menu entry (and a checkbox long-press)
  opens the in-panel alarm overlay (§1a) as the date picker.
- **Sync status without hover**: long-pressing the sync button shows its tooltip
  (last-sync time / duration / errors) as a transient bottom toast.
- **Tap targets**: ~40 px hit areas via `::after` overlays and stacked-row `min-height`, with the
  18 px checkbox ring and row layout preserved visually.
- **Clearing the search resets the panel (no Enter)**: emptying the field returns the list to the
  unfiltered "all" view by itself, however it was emptied. This matters most on mobile: the soft
  keyboard has no Enter that commits here, and Android's WebView does **not** render the
  `::-webkit-search-cancel-button` ×, so backspacing to empty is the only way to clear a query — and
  before 1.9.9 it did nothing, leaving the panel filtered with no way back. The reset is an explicit
  commit made on the `input` event (the only event a backspace fires), and it is the one commit
  allowed to render **through** the mobile search-focus hold: that hold exists so a `setHtml` cannot
  wipe the field mid-typing, but here the user has emptied the field and there is nothing left to
  type. NOTE: a mobile render is a full webview reload, so the soft keyboard closes as a consequence —
  Cockpit does not blur the field or dismiss the keyboard itself, and the hold stays armed for any
  later typing.
- **Every explicit commit renders, even with the field focused**: picking a suggestion, applying a
  multi-select, Enter in the field or in the list's filter box, and the clear button all ask the host to
  render through the search-focus hold. Without that the commit landed host-side and the render was
  swallowed — these paths deliberately keep the field focused so the soft keyboard stays up — and the
  panel simply never filtered ("it behaves like search doesn't implement at all"). The hold still does
  its real job: it protects the field while the user is TYPING, which never commits. As with the
  empty-field reset, the keyboard closing with the reload is the accepted trade — the user has finished
  searching.
- **Autocomplete on touch**: a suggestion is picked on `pointerup` (not `mousedown`, and no longer on
  `pointerdown`). It moved off `pointerdown` when the dropdowns became **multi-select**: a long press has
  to *begin* with a pointerdown, so committing there would close the list before the hold could ever
  fire, and `preventDefault()`ing a touch pointerdown also stops the (now ~15-row, scrolling) list from
  scrolling. Since nothing is prevented, the tap drops focus to `<body>` with a null blur
  `relatedTarget` — `onSearchBlur` recognises that (the press tracker knows the press landed inside the
  list) and hands the caret straight back, so the field stays focused, the soft keyboard stays up, and
  the host's refresh hold is not released. **Device-check only** — this ordering cannot be reproduced
  off-device (checklist step 10).
- **Multi-select in the token dropdowns (touch)**: `tag:` / `notebook:` / `title:` all support marking
  several entries. Desktop marks with Ctrl+click; touch has no modifier, so a **long press (500 ms)**
  marks the first row and enters selection mode, after which a **plain tap toggles** — the standard
  Android pattern. The row gestures are wired exactly like the proven to-do-row long press: the same
  `-webkit-touch-callout: none` / `user-select: none` suppression in `panel.css` (plus
  `touch-action: pan-y`, so the list still scrolls), the same document-level **capture** listeners rather
  than listeners on the list element, and — added in 1.9.10 — the same **swallowing of the synthetic
  click** the browser fires after a touch gesture. That last one was the difference that kept the bug
  alive: the to-do adapter has always swallowed it, this list did not, so the click landed wherever the
  gesture ended and a click outside the list ran `closeAllDropdowns`, removing the list while leaving the
  typed text behind. 1.9.10 also **cancels the default action of the touch `pointerdown`** on a row: an
  earlier round left it in place on the belief that cancelling it blocks panning, which is wrong —
  panning is governed by `touch-action` and by `touchstart`/`touchmove`, not by `pointerdown` — and
  leaving it was what let Android's native long press take the gesture. Cancelling it stops the focus
  change and the native selection at source, so the field never blurs. Without the CSS half, Android's native long press wins —
  it starts a text selection on the row, takes the pointer (a `pointercancel` abandons the 500 ms hold,
  so no mark is ever made) and blurs the search field, which used to tear the whole list down. That was
  the 1.9.8 device bug; `contextmenu` inside the list is now suppressed on mobile too, and the
  press-inside flag that protects the field's focus covers the **whole hold**, not just a tap. An apply button (enter-arrow) appears at the right of the list's embedded filter box
  whenever ≥1 row is marked, and doubles as the selection-mode indicator (mobile has no Ctrl to hint
  at, and the hint line at the list's bottom edge reads "Press and hold - select several" there). The
  marks are held by value, so filtering the list and clearing the filter never loses them.
- **Accepted gap — marks do not survive a host-initiated reload.** The open dropdown is *already* safe
  from Cockpit's own renders: the mobile search-focus hold (`searchFocusChanged`) blocks every
  `setHtml` while the field has focus, and the list cannot outlive that focus. It is **not** safe from
  an Android renderer-process kill, which reloads the webview and destroys module state. Neither is the
  uncommitted query text — a reloaded document renders the last *committed* `searchFilter` — so
  restoring marks without restoring the text they were meant for would be meaningless. The dropdown is
  therefore deliberately **not** routed through the overlay descriptor / `dialogGuard` machinery: the
  guard would be redundant (the focus hold already pauses refreshes) and would be a leak hazard (the
  list opens and closes on every keystroke, whereas an overlay has exactly two call sites). A follow-up
  could hold a `{ draft, caret, marks }` descriptor on the host in its own channel — no `dialogGuard`
  involved — which would fix the pre-existing "typed query lost on reload" gap at the same time.
- **Viewport**: `#joplin-plugin-content` keeps `height: 100vh` as the base, with a mobile-gated
  `@supports (height: 100dvh)` override to `100dvh` on `.cockpit-mobile`. Inside the plugin-dialog
  iframe `dvh == vh`, so this is a harmless, future-proof line; the real fill guarantee is the flex
  column (`.todos { flex:1 1 auto; min-height:0; overflow-y:auto }`).

### 3. List scroll persistence across refreshes (`panelWebview.js`, `panel.ts`, `panelTemplate`)

Mobile updates the panel by a **full webview reload** (Joplin writes a fresh document to a temp file
and swaps the `<WebView source>` uri), so all top-level webview state — including `savedTodosScrollTop`
— is destroyed every refresh, and the list jumped back to the top. Fix: move the source of truth to
the plugin.

- The webview's `.todos` scroll listener posts `['scrollChanged', scrollTop, renderNonce]` (throttled
  ~300 ms, only when moved >4 px). `panel.ts` holds `lastScrollTop` and a `renderNonce`, accepting a
  post only when its nonce matches the current render (a stale post from an outgoing webview is
  dropped). `refreshPanelData` bumps the nonce each render and embeds both on `<section class="todos"
  data-scroll-top=… data-render-nonce=…>`.
- On restore, `reconcile()` reads the embed **only on mobile**: `if (IS_MOBILE) savedTodosScrollTop =
  savedTodosScrollTop || Number(el.dataset.scrollTop || 0)`. Desktop keeps its surviving module state
  and must **not** consult the embed — there a live `savedTodosScrollTop` of 0 means "genuinely at
  top", and the throttled/nonce-guarded embed can lag it, which would wrongly restore a stale offset.
- Deliberate resets (profile / notebook / search / sort / calendar → top) set `lastScrollTop = 0`
  before their refresh, so both platforms start at the top and the nonce guard discards any in-flight
  post from the outgoing webview.

### 4. Row alignment on the larger mobile font (`panel.css`, mobile-gated)

Mobile renders the panel at a larger base font (`--joplin-font-size` ≈16px vs desktop's ~13px), which
grows `--cockpit-row-line-height`. The desktop row-centering used a fixed `0.75px` optical constant
hand-calibrated at ~13px; it does not scale, so at the mobile size the circle and notebook pill sat
above the title's ink. The `.cockpit-mobile` rules re-centre the circle / note-ring / pill on the
first text **line** using the real line-height plus one line-height-proportional optical term
(`--cockpit-m-optical`), preserving the 40px tap box. Desktop (no `.cockpit-mobile`) is byte-identical.

### 5. Icon-only create buttons; mobile styler button removed

The create-note / create-notebook buttons render as icons only on mobile to save width; the separate
mobile styler button was removed (custom panel CSS stays a desktop-only feature, reached from the
Tools menu).

### 5a. Mobile paint perf — instant profile switch / create (`panel.ts`, `joplin.ts`)

A mobile `setHtml` is a full webview reload, and the old switch/create path ran the **heavy**
`refreshInterfaces` (an all-profiles overview-note search + body GET/PUT for every profile) *inline*
before the user saw anything. Two mobile-gated trims make the switch feel instant; desktop paint is
byte-identical.

- **Defer the overview-note rewrite.** Profile switch (`profilesDropdownChanged`), create
  (`createProfileClicked`) and the overlay Save/Create (`profileSaved`, mobile-only) now call
  `refreshPanelData({ fast: true })` + `scheduleRefresh()` instead of `refreshInterfaces()`. The
  interactive path does **one** search + one reload; the all-profiles overview notes reconcile in the
  background schedule (a switch/create changes no to-do data, so they write nothing new anyway). On
  desktop `fast` resolves to `false`, so the paint is unchanged — only the (no-op) overview write moves
  a beat later, an intentional, invisible timing change.
- **Fast first paint — rings from cache.** `refreshPanelData({ fast: true })` (gated `mobile && fast`)
  threads a `fastCheckboxCounts` flag through `getFormatter → getTodos → attachCheckboxCounts` so the
  first paint renders checkbox rings from **already-cached** counts only, issuing **no** note-body GETs
  (up to 300, serial-chunked). The paired `scheduleRefresh` then fetches the bodies and repaints with
  the real rings. Desktop always renders full counts (skipping them would flash empty rings).

### 6. Command fallbacks + responsive alarm dialog

- **Data-API command fallbacks** (`src/ui/panel/panel.ts`). `moveToFolder`, `setTags` and
  `duplicateNote` are registered only on desktop; on mobile they throw. A new
  `tryAppCommandWithFallback(commandName, args, fallback)` runs the native command first (desktop:
  succeeds → native dialog preserved exactly) and, **only on mobile**, runs a `joplin.data` fallback
  when it throws. If a command is later added to mobile, the native one is used automatically.
  - `moveToFolder` → `moveNotesFallback`: the existing `pickNotebook` dialog (notebooks only, no
    root) + a `parent_id` PUT per note. Wired for both the note context menu and the notebook-row
    "move to notebook" action.
  - `duplicateNote` → `duplicateNoteFallback`: GET the note's copyable fields → POST a fresh copy in
    the same notebook (title not renamed, `todo_completed` reset to 0, id/timestamps left for Joplin;
    `:/resource` links resolve to the same shared resources, matching desktop).
  - `setTags` → `setTagsFallback`: a new comma-separated tag-input dialog (`tagPicker`) prefilled with
    the note's current tags; on OK the desired titles are diffed against the current ones — missing
    tags attached (reusing an existing tag id or creating one), removed tags detached. Titles are
    lowercased to match Joplin's storage; a freshly created tag invalidates the tag cache.
- **Responsive alarm dialog** (`src/ui/alarm/alarm.ts`). All narrow-screen rules live inside the
  existing `@media (max-width: 440px)` block, so the desktop measurement stays an unconditional 424 px
  side-by-side layout (the documented dialog-sizing feedback loop is untouched). Under 440 px the
  wrapper goes fluid (`calc(100vw - 16px)`), `#alarmBody` stacks to a column (calendar on top, time
  columns below), and the hour/minute columns share the width at a compact 132 px height so stacking
  does not make a very tall dialog. The date/time fields stay **text** inputs (a numeric keyboard
  cannot type the `-`/`:` separators) and are hardened with
  `inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"` so
  mobile autocorrect/autocaps cannot mangle the ISO strings; primary input remains the tap pickers.

## Remaining / optional mobile work

- **Full touch drag-to-reschedule** — the "Move to date…" menu entry (above) already covers
  rescheduling on touch. A richer drag (Pointer Events long-press + move onto a `data-drop` target,
  reusing the existing `['todosDropped', ids, target]` message) is a nice-to-have, not a blocker.
- **Tag autocomplete in the mobile tag picker** — the `setTags` fallback is a plain comma input;
  autocomplete against `getAllTags()` could be added later if the plain input proves fiddly.
- **`app_min_version_mobile` bump** — only if checklist step 8 reproduces the pre-3.4.6 off-screen
  dialog-buttons bug.

## FIRST-SIDELOAD TEST CHECKLIST (Pixel)

Work through these in order in the first device session. Each step says what to do and what
success vs failure looks like. The build to install is
`publish/io.github.pmslava.cockpit.jpl` (produced by `npm run dist`).

1. **Install the `.jpl` from file.** Copy `io.github.pmslava.cockpit.jpl` to the Pixel (USB, Drive,
   or email-to-self). In Joplin: **Settings → Plugins → the three-dot / gear menu → Install from
   file**, pick the `.jpl`, then **restart Joplin** if prompted.
   - Success: Cockpit appears in the plugin list as enabled, no load error.
   - Failure: an install/parse error, or the plugin is greyed out → check `app_min_version_mobile`
     against the device's Joplin version (step 8); capture the error text.

2. **Open the panel.** On the note screen tap Joplin's **toolbar plugin-panel button**. Cockpit is a
   tab inside Joplin's shared plugin-panel dialog (if it is the only plugin panel, there is a single
   button; with others, tabs).
   - Success: the panel opens showing the profile row, notebook/sort/search row, and the to-do list;
     it **fills the dialog height** with no large dead gap and no clipped/cut-off bottom.
   - Failure (viewport): the list is cut off, or there is a big empty band below it → the `100dvh`
     path needs the percentage-height fallback in `panel.css` (see the VIEWPORT note); record roughly
     how much is clipped/empty.

3. **Tap-to-open and tap targets.** Tap a to-do title, then tap the checkbox ring, then the small
   row-action / dropdown buttons.
   - Success: tapping a title opens the note; the checkbox toggles; the small buttons are easy to hit
     first-try (≈40 px targets).
   - Failure: taps miss or need multiple tries, or tapping the ring opens the note instead of toggling
     → note which control and how far off.

4. **Long-press context menu.** Long-press (~0.5 s) a to-do row, a plain-note row, and a group
   heading in turn.
   - Success: the context menu appears for each; a short scroll or a quick tap does **not** trigger
     it; dismissing works.
   - Failure: no menu ever appears (long-press dead), or a normal tap/scroll fires it by accident, or
     the menu opens then immediately closes → note which target and which misbehaviour.

5. **Command fallbacks — the core of this commit.** From a to-do's long-press menu, try each:
   - **Move to folder / Move to notebook**: pick a target notebook in the picker, confirm.
     - Success: the note moves; the list updates within a second or two.
     - Failure: a "…is not available here" message box (fallback did not run), the picker shows behind
       the panel, or the note does not move → record which.
   - **Duplicate**: run it, then check the target notebook.
     - Success: an exact copy appears (same title, same body); a duplicated to-do is **open**, not
       completed.
     - Failure: "not available here", no copy, or the copy is marked done.
   - **Tags**: the tag picker opens prefilled with the note's current tags; edit the comma-separated
     list (add one, remove one, add a brand-new tag name), confirm.
     - Success: added tags attach, removed tags detach, a new tag name is created and attached; the
       new tag then appears in the search field's `tag:` autocomplete.
     - Failure: "not available here", tags not applied, or a duplicate tag created for an existing
       name (case mismatch).
   - **Copy Markdown link / Copy note ID**: run each, paste into the note body.
     - Success: the link / id pastes.
     - Failure: the "clipboard is not available here" message → clipboard is unimplemented on this
       runtime (expected-possible; not a regression).

6. **Set-alarm / responsive alarm dialog.** Long-press a to-do's checkbox ring (or use "Move to
   date…"). The alarm dialog opens.
   - Success: on the narrow screen the **calendar sits on top and the hour/minute columns below it**
     (stacked, not crushed side-by-side); tapping a calendar day fills the date field, tapping
     hour/minute fills the time; the quick buttons (Today / Tomorrow / +1 week / +month) work;
     **OK / Clear alarm / Cancel are all visible and tappable**; OK sets the due date/time.
   - Failure: the calendar is squeezed to a sliver next to the time columns (stacking media query not
     applied), the dialog opens behind the panel, or the bottom buttons are off-screen (→ step 8).

7. **Typing in the alarm date/time fields.** Tap into the `YYYY-MM-DD` and `HH:MM` fields and type.
   - Success: a normal text keyboard appears; typed `-` and `:` separators work; no autocorrect/
     autocaps mangling; a valid value is accepted, an invalid one shows the "must be YYYY-MM-DD …"
     message.
   - Failure: a digits-only keyboard with no `-`/`:` (should not happen — fields are `inputmode=text`),
     or autocorrect rewrites the string.

8. **Dialog buttons on-screen (Android version check).** During steps 5–6, confirm every dialog's
   footer buttons are reachable.
   - Success: OK / Cancel (and Clear alarm) are on-screen and tappable.
   - Failure: footer buttons are cut off the bottom → this is the pre-3.4.6 Android bug; note the
     device's Joplin version and consider bumping `app_min_version_mobile` to "3.4".

9. **Overlays render in front (structural, not a race).** Open the notebook, tag and alarm pickers
   several times, sometimes right as the list would refresh.
   - Success: each opens as an **in-panel overlay on top of** the list every time (they are HTML in the
     panel webview, not native dialogs, so they cannot go behind); the list does not repaint
     underneath while the overlay is open; Cancel / outside-tap / Android-back all close it.
   - Failure: an overlay opens behind content, the list flickers/repaints under it, or the overlay
     leaks (a later refresh stays paused) → capture the trigger.

12. **Scroll persists across refreshes.** Scroll the to-do list down, then wait for (or trigger) a
    refresh — e.g. check a to-do, or let a sync land.
    - Success: the list stays at the scrolled position across the refresh. Scroll back to the **top**,
      then trigger another refresh — it stays at the top (does not jump to a stale offset).
    - Failure: the list jumps to the top after a refresh, or jumps to a stale position when at the top.
    - Also confirm deliberate resets **do** go to top: change profile / notebook / sort / search — each
      should start the list at the top.

13. **Row alignment on the device font.** Look at a to-do row and a note row.
    - Success: the checkbox circle, the title text and the notebook pill share one optical line — the
      circle/pill are not floating above the title text.
    - Failure: circle/pill sit noticeably above the title ink → nudge `--cockpit-m-optical` in
      `panel.css` (the single documented magic number) and recheck.

14. **Profile editor overlay (create / edit / delete).** From the profile dropdown open **+ New
    profile…**, then **Edit profile** on an existing one.
    - Success: each opens as an **in-panel overlay on top of** the list (no native dialog, nothing
      behind the panel); create shows the template defaults, edit prefills the profile's real values
      within a moment; Save/Create persists and the list updates; Cancel / outside-tap / Android-back
      discard. On **Delete**, the native "Delete <name>?" confirm still appears, and the last-profile
      guard still blocks deleting the only profile.
    - Failure: a native editor dialog opens (mobile should use the overlay), edit shows create-defaults
      instead of the profile's values, Delete skips the confirmation, or Save on an edit resets fields.

15. **Overlay survives a mid-overlay reload.** With the tag or edit-profile overlay open and edited (a
    few keystrokes), force a panel reload — background the app during a sync, or otherwise provoke the
    Android renderer to reload the panel — then return.
    - Success: the overlay **reappears** reconstructed with the values you had typed (not the empty /
      default form); committing it applies those values. If instead it reappears empty right after
      opening (before prefill finished), it should simply have **closed** rather than come back empty.
    - Failure: the overlay comes back showing empty/default fields whose OK/Save would wipe the note's
      tags or reset the profile, or the list is left with refreshes paused (guard leak).

16. **Instant profile switch / create.** Switch between profiles a few times, then create one.
    - Success: the switched-to list paints after a single reload (near-instant); checkbox rings fill in
      a beat later; the created profile appears without a multi-second stall.
    - Failure: a multi-second freeze on each switch/create → the deferred-overview-note / fast-first-
      paint trims (§5a) are not taking effect; record rough timings.

10. **Autocomplete + soft keyboard.** In the search field type `tag:` or `title:` and tap a
    suggestion.
    - Success: the suggestion commits into the field, the field stays focused, the keyboard stays up.
    - Failure: the tap dismisses the keyboard without committing, or double-commits.
    - **This step is the one that changed in 1.9.8** (the pick moved from `pointerdown` to `pointerup`
      and nothing is `preventDefault()`ed any more), so check it carefully even if it passed before.

9a. **Clearing the search returns to "all" (no Enter).** With "All notebooks" selected, type a query that
    matches nothing and commit it, then **backspace the field empty** and simply stop.
    - Success: the full list comes back on its own within a moment — no Enter, no tapping elsewhere. Try
      it again by holding backspace down to delete the query character by character.
    - Failure: the list stays empty (or stays filtered) until you press something else. Note whether the
      × even appears in the field on Android — it is not expected to, which is exactly why backspace has
      to work.

9b. **A committed search actually filters (no Enter needed on the results).** With "All notebooks",
    type `tag:` and pick a tag — by tapping it, and again via long-press + the apply button, and again by
    typing a full query and pressing Enter.
    - Success: the list filters **immediately** in every case. The soft keyboard closing at that moment is
      expected (a mobile render reloads the webview). Reopening the panel keeps the filter.
    - Failure: the list stays unfiltered, or the filtered view flashes and then reverts to unfiltered.

10a. **Suggestion list: size, scroll and filter.** Type `tag:` (then `notebook:`, then `title:`) with
    nothing after the colon.
    - Success: the list is tall — around 15 rows — with a filter box pinned at its top, a muted
      "Press and hold - select several" line pinned at its bottom, and the **rows scrolling between
      them** while the box and the hint stay put. The list never runs off the bottom of the panel.
      Typing in the filter box narrows the rows, and doing so does **not** close the list or drop the
      keyboard.
    - Failure: the whole list scrolls (filter box or hint scrolling away), the list is clipped by the
      panel edge, or touching the filter box closes the list / triggers a full panel reload.

10b. **Multi-select by long press (the core of this change).** With the `tag:` list open, **press and
    hold** a row for about half a second.
    - Success: a short vibration, the row becomes visibly marked, and an **apply button with an
      enter-arrow appears beside the filter box**. The list stays open. Now **tap** two more rows —
      each toggles its mark (no note opens, nothing commits). Tapping a marked row again unmarks it.
    - Failure: the hold picks the row and closes the list (the old pointerdown behaviour), the hold
      does nothing, a plain tap commits while marks exist, or the list closes on the first tap.
    - **If it fails again, turn on the trace.** Settings → Cockpit → "Show a touch-gesture trace in the
      search suggestions (diagnostic)". With it on, the list's hint line is replaced by the last few
      touch events as they happen — e.g. `down > hold-fired > up > click-swallowed`, or
      `down > press-cancelled > field-left > list-closed:field-left`. Read that line back to us: it says
      what actually fired and, when the list disappears, WHY it closed. Turn it off afterwards.
    - **This is the step that failed on the Pixel in 1.9.8 and 1.9.9** — the hold closed the whole list and left
      only the typed `tag:` fragment in the field. Watch specifically for: a text-selection handle or a
      Copy/Select-all bar appearing over the row (the native gesture winning), and for the list
      vanishing mid-hold. Neither should happen now. Also confirm the list still **scrolls** by flick
      after the change (`touch-action: pan-y`).

10c. **Marks survive filtering.** With two rows marked, type into the filter box so one of them is
    hidden, then clear the filter box.
    - Success: both marks are still there; the apply button is still shown.
    - Failure: a mark is lost when its row is filtered away.

10d. **Applying.** Put some text in the field first (e.g. `any:1 milk `), then complete a `tag:` token,
    mark two or three tags, and tap the apply button.
    - Success: the field becomes `any:1 milk tag:a tag:b tag:c ` — the marked tokens are inserted where
      the half-typed `tag:` fragment was, **`any:1 milk` is untouched**, values with spaces come back
      quoted, and the search commits. Repeat with `notebook:` (whose names have spaces) and `title:`.
    - Failure: anything else in the query is rewritten or lost, a token is unquoted where it needed
      quotes, or a tag already in the query is inserted a second time.

10e. **Scrolling a long list does not mark or pick.** With a long `tag:` or `title:` list open, flick
    the rows up and down.
    - Success: the list scrolls; no row is marked, and no suggestion is picked when the finger lifts.
    - Failure: a scroll marks a row or commits a pick.

10f. **Reload while marking (the accepted gap).** With marks made, provoke a panel reload (background
    the app during a sync).
    - Success: the dropdown is simply **gone** and the field shows the last committed search; the panel
      is alive and refreshes normally. This loss is expected and documented — the uncommitted query
      text is lost the same way, and always has been.
    - Failure: refreshes stay paused afterwards (a guard leak — which should be impossible, the
      dropdown posts no `dialogGuard`), or the panel comes back stuck.

11. **Cold-start feel over a real vault.** Note time-to-first-render and scrolling smoothness on the
    first open over the full vault.
    - Success: the panel paints quickly; checkbox rings fill in over the next refresh or two.
    - Failure: a long stall or janky scroll on first open → candidate for the mobile perf trims
      (lower the body-fetch cap / trim follow-up refreshes); record rough timings.

17. **Completed-todo style — "Grayed strikethrough" (cross-platform).** In settings set the
    completed-to-do style to **Grayed strikethrough** and complete a to-do shown in the list.
    - Success: the completed title is both dimmed (opacity 0.5) **and** struck through, in every theme
      mode; the other three styles (Normal / Grayed out / Strikethrough) still behave as before.
    - Failure: only one of dim/strike applies, or the option is missing.
