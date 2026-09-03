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
  Since 2.3.0 one of those four presses is answered differently: a hold on a to-do row's BODY lifts the
  row into the touch drag (§7), and the menu is handed back by a release that never travelled.
- **Reschedule on touch**: a mobile-only "Move to date…" to-do menu entry (and a checkbox long-press)
  opens the in-panel alarm overlay (§1a) as the date picker — still the precise route, and now
  alongside the drag (§7).
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
- **The in-progress search survives a host-initiated reload** (2.1.0; the accepted gap this replaces is
  described below). The open dropdown was *already* safe from Cockpit's own renders — the mobile
  search-focus hold (`searchFocusChanged`) blocks every `setHtml` while the field has focus, and the
  list cannot outlive that focus — but not from an Android renderer-process kill, which reloads the
  webview and destroys module state. Neither was the uncommitted query text: a reloaded document renders
  the last *committed* `searchFilter`, so a half-typed query was simply gone (a pre-existing gap that
  predates the dropdown entirely). The host now holds a **`searchState`** descriptor of its own —
  `{ draft, caret, marks, filter, filterCaret, focus }` — on the same pattern as the overlay descriptor
  one layer up:
  - the webview posts it **throttled** (300 ms, mirroring `queueOverlayState` / `queueScrollPost`) from
    `updateSearchDraft`, from the mark toggles and from the dropdown's filter box, and posts **null** on
    every commit and on a genuine departure, so it only ever describes an uncommitted interaction;
  - `refreshPanelData` embeds it as a `<script id="cockpitSearchState">` island next to
    `#cockpitOverlayState`; `startPanelObserver` reports whether the loaded document carries it as
    `message[2]` of `dialogGuardReset`, and a host holding a state the document lacks re-renders **once**
    with it embedded. Same non-looping handshake as the overlay's; one render serves both islands;
  - `reconcile` on a fresh webview (mobile, and only when no live search state survived) calls
    `restoreSearchFromEmbeddedState`: the draft goes back into the field, the field is **refocused**
    (which re-arms the host's hold — without it the next refresh would wipe the restore), and
    `onSearchInput` is re-run so the dropdown and its marks come back with it.
  - **Empty-draft trap**: `onSearchInput` runs `maybeAutoResetSearch` first, and that reads "still
    filtered" off `input.defaultValue`, which the restore does not touch. Restoring an *empty* draft over
    a document rendered with a committed filter would therefore look exactly like the user having just
    emptied the field and would commit a reset nobody asked for. The restore arms `searchResetPosted` in
    that case; the first character typed clears it again, so a later genuine emptying still resets.
  - **Explicitly NO `dialogGuard`**, and that is the point of a separate channel: the dropdown opens and
    closes on *every keystroke*, whereas an overlay has exactly two call sites, so bracketing it with the
    guard would be a leak hazard whose failure mode is refreshes frozen forever — and the guard would be
    redundant anyway, since the focus hold already pauses them.
  - **Accepted, and shared with the overlay descriptor**: a webview torn down *without* a blur (the panel
    tab closed mid-typing) leaves the state held, so the next open restores that draft once and refocuses
    the field. It is the user's own text, and one commit or blur clears it.
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

### 7. Drag to reschedule on touch (`panelWebview.js`, `touchDrag.js`, `panel.css`)

Shipped in 2.3.0, and the one mobile feature whose make-or-break question is a **device** question
(step 18b below). A 500 ms press on a to-do row's BODY lifts the row; moving resolves a drop target on
every move; releasing drops it. Everything below the input layer is the desktop drag's own machinery —
`betweenGroupInfo`'s eligibility, the neighbour walk, `paintBetweenIndicator` /
`paintDropTargetHighlight`, the edge auto-scroll helper, and both message shapes
(`['todosDroppedBetween', ids, prevId, nextId, groupDate, groupEndDate]` and
`['todosDropped', ids, target]`) — so the host cannot tell a finger from a mouse and there are **no host
changes** beyond loading the new module.

**The state machine**, all of it in `panelWebview.js`:

| from | on | to | what happens |
| --- | --- | --- | --- |
| armed (the existing long press) | 500 ms elapsed on a row body | **lifted** | vibrate, `.-dragging`, the selection collapses onto the row, the payload is `schedulableSelection()`, the row index is built, the banner names the row, a 15 s watchdog starts, the non-passive `touchmove` listener goes on, `trace: drag-arm` |
| lifted | the finger travels past 10 px on either axis | **moving** | `['dialogGuard', true]`, then a target resolved and painted on every move |
| lifted | release, no travel | **menu** | `onTodoContextMenu(synthEvent(...))` — the gesture the press has always been, `trace: menu-on-release` |
| moving | release over a gap / a `[data-drop]` | **dropped** | the drop message, THEN the guard release, `trace: drag-drop:between` / `drag-drop:date` |
| moving / lifted | release over nothing, a second finger, `pointercancel`, `visibilitychange`, resize, orientation change, the watchdog | **cancelled** | `trace: drag-cancel:<reason>` |

Every one of those ends calls the single `endTouchDrag(reason)`, which takes down the `touchmove`
listener, the scroll loop, both indicator paints, the row's dimming, the pointer capture, the banner
and its own watchdog — and releases the refresh guard **last**. It has exactly one `return` (the
not-active guard on its first line), which is what makes "every exit releases the guard" a property of
the shape rather than of a reviewer's attention; the harness pins that, and a mutation adding a second
`return` fails it.

Four hazards this was designed around, each of which cost something to get right:

- **The non-passive `touchmove` is the whole gesture.** `preventDefault()` on a touchmove is the only
  thing that stops Android panning the list under the lifted row, and a document-level touchmove
  listener is **passive by default** in Chrome — where `preventDefault()` does nothing at all. So the
  listener is registered `{ passive: false, capture: true }` and removed with the same options (a
  mismatch would leave a listener that cancels every touchmove for ever, killing the list's scrolling).
  It is attached only for the duration of a lift, which is why there is deliberately **no
  `touch-action` on `.todo`**: that would apply to every touch on every row, always, and the list must
  keep scrolling by flick.
  The listener is registered **mid-gesture**, 500 ms into the touch, and that is the part the device
  round tests: Chromium decides a touch sequence's blocking-handler region on the compositor and a
  handler added late may arrive after that decision, in which case the moves are delivered
  *non-cancelable* and `preventDefault()` is a silent no-op — which looks exactly like 18b's failure.
  **The cheaper thing to try before falling back to a drag handle** is to register the same listener
  once at load (mobile only) with `if (!touchDrag.active) return` as its first line: identical behaviour,
  but the region is blocking from `touchstart` onward. It is not the default because it routes every
  ordinary flick through a main-thread handler, so its cost has to be measured on the device (18j), not
  assumed away.
- **The checkbox ring overhangs its row.** The mobile tap-target rules grow the 18 px ring to a 40 px
  content box and cancel the growth with an equal negative margin, so the box sticks out of a ~26 px
  row without moving anything. `document.elementFromPoint` in the left column therefore returns the
  **neighbour** row about as often as the right one. Rows are found geometrically instead: an index of
  `{ el, top, bottom, info }` built at the lift and **shifted** by every later scroll — the drag's own
  auto-scroll and any other, since a scroll moves every row by the same delta and changes nothing else
  about them — searched by the pure `window.TouchDrag.rowAtY`. (Shifted rather than re-measured because a
  rebuild is a `getBoundingClientRect()` plus `betweenGroupInfo`'s walk back to the heading *per row*, and
  it would run on every auto-scrolled frame, on the device, in the one phase where the frame budget is
  real. Re-syncing on a scroll the drag did **not** ask for is the insurance against Android panning the
  list without taking the gesture away — see 18b: an unsynced index would write neighbours read off rows
  that had scrolled off.) The big `[data-drop]` targets are still resolved from the DOM, and **first**,
  because a heading is a *sibling* of the rows — it sits in the very gap the row index would attribute to
  the row above it — and because a sticky heading floating over the list (z-index 2, above any
  overhanging ring) genuinely is what the finger is on.
- **A heading that accepts no drop is not the gap above it either.** "Overdue" and "Future" name no date,
  so `getHeadingDropTarget` gives them none and they carry no `data-drop` at all. They miss the
  `[data-drop]` branch — and, being siblings of the rows, they would then fall through to the row index,
  which by design gives everything between one row's top and the next row's to the row **above**. A finger
  on the "Future" heading would have written the to-do into the group before it, and a *sticky* one
  floating over a scrolled list would have written a row the user could not even see the line on. So the
  resolver bails on any `h2` under the finger, **after** the `[data-drop]` test (the headings that do
  accept drops have already returned by then). The desktop drag is inert on exactly this point:
  `betweenTargetAt` starts from a `closest('.todo')`, which a heading is not.
- **A leaked `dialogGuard` freezes mobile refreshes for the life of the webview.** Hence the single end
  above, the 15 s watchdog, and the flag that keeps taking and releasing paired. The guard is taken on
  the **first move**, not at the lift, and that is a deliberate departure from the first design: the
  host answers the last guard coming down by repainting (`panel.ts`, the `dialogGuard` branch), and a
  mobile repaint is a full webview reload — which on the no-travel path would reload the panel out from
  under the very context menu the release had just opened. A hold-and-release therefore never touches
  the guard at all. The cost is that a refresh landing between the lift and the first move ends the drag
  by reloading; nothing is held, so that is the harmless direction.
- **A still finger sends nothing at all.** The shared edge auto-scroll stops itself after
  `AUTOSCROLL_IDLE_MS` (800 ms) without an `update()` — a watchdog sized for the HTML5 drag, which
  re-fires `dragover` every ~350 ms even for a stationary pointer. A finger holding at the edge, which is
  the entire gesture an edge scroll exists for, emits no `touchmove` whatsoever, so the touch drag
  re-aims the loop from its own scroll callback (`onTouchDragScrolled`) after re-syncing the index.
  Nothing is lost: a touch drag has real ends of its own and every one of them calls `endTouchDrag`,
  which stops the loop, with the 15 s watchdog behind them all.
- **The gap that is not a target.** A gap with *both* neighbours absent in a *dateless* group
  (Overdue/Future) is not painted and not droppable: `betweenBounds` can form no interval for it and the
  host would write nothing, so an insertion line there would promise a move that never happens.

Feedback is a lifted (dimmed) row, one insertion line **or** one whole-row highlight — never nothing
silently — and a banner (`#cockpitDragBanner`) that names the resolved target: "before X", "after X",
"onto Today", or "release to cancel". There is deliberately **no ghost clone** of the row: it costs a
second thing to keep in sync with the finger and adds nothing the line does not already say.

The **gesture trace** was fixed first, as its own commit, because it was blind to this gesture: it wrote
only into the search suggestion list's hint line, which is closed during a row drag. It now falls back
to the toast in a sticky mode, and the ring buffer holds 10 entries. Codes: `drag-arm`,
`drag-target:before|after|drop|none` (on a **change** only), `drag-autoscroll:up|down` (on a direction
change only), `drag-drop:between|date`, `drag-cancel:<reason>`, `menu-on-release`.

**Rejected, and why** — gaps-only targets (the headings are the coarse, forgiving target a finger wants
and they already exist); a per-row drag handle (a permanent column of chrome on every row for a gesture
that should be discoverable by holding — **kept as the documented fallback** if step 18b shows Android
taking the gesture); a cloned ghost row.

## Remaining / optional mobile work

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
     - Success: the link / id pastes, and no dialog appears at all.
     - Failure: the panel's own toast at the bottom reads "Cockpit: could not copy to the clipboard."
       → clipboard is unimplemented on this runtime (expected-possible; not a regression). A message
       box instead of that toast IS a regression — these actions must never raise a dialog.

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

10f. **Reload while marking — now SURVIVED (2.1.0; this step used to document the loss).** Type a partial
    query, open a `tag:` list, mark two rows, type something into the list's filter box, then provoke a
    panel reload (background the app during a sync).
    - Success: the panel comes back with the **typed query still in the field**, the dropdown open, the
      **same rows still marked**, the filter box still holding its text, and the keyboard up. Committing
      from there applies exactly what you had built.
    - Failure: the dropdown is gone and only the last committed search shows (the state never reached the
      host, or the island was not embedded); the field comes back EMPTY and the panel resets itself to the
      unfiltered list (the empty-draft trap — a spurious auto-reset); the panel keeps re-rendering in a
      loop (the handshake is not reporting the island); or refreshes stay paused afterwards (a guard leak
      — which should be impossible, this channel posts no `dialogGuard` at all).
    - Also confirm the state does NOT outstay its welcome: commit the search (or tap elsewhere to blur),
      then provoke another reload — the panel must come back plain, with no dropdown and no draft.

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

18. **TOUCH DRAG TO RESCHEDULE (the 2.3.0 round).** Turn the **Gesture trace** setting ON first
    (Settings → Cockpit); every step below can be read back from the strip at the bottom of the panel.
    Work through them in order — 18b is the one that decides whether the feature ships as designed.

    a. **The lift.** Press and hold a to-do row's title (not the circle) for about half a second.
       - Success: a short vibration, the row dims, a banner appears at the top naming it, and there is
         **no text-selection handle and no Copy / Select-all bar**. The trace reads `drag-arm`.
       - Failure: nothing happens (the hold never fires), or the native selection bar appears (Android's
         long press won — the CSS suppression is not reaching this row).

    b. **MAKE OR BREAK: move without lifting the finger.** From that hold, slide the finger up and down
       over other rows.
       - Success: an insertion line follows the finger between rows, the banner reads "before …" /
         "after …", and the **list itself does not scroll**.
       - Failure: the list scrolls under the finger, or the trace shows `drag-cancel:pointercancel`.
         Either means Android's compositor took the gesture rather than honouring the non-passive
         `touchmove`. Report it before anything else. **Try the cheap fix first** (§7, the non-passive
         bullet): register the `touchmove` listener once at load instead of mid-gesture, so the touch
         sequence is blocking from its `touchstart`, then repeat 18b and 18j. Only if that changes
         nothing is this **the signal to fall back to a per-row drag handle** (documented above as the
         rejected-but-kept alternative).

    c. **Aim.** Drop a to-do into the gap two rows away from where it started. Repeat the same aim five
       times.
       - Success: at least 4 of 5 land in the gap you aimed at, and the to-do's time is between its two
         new neighbours' times.
       - Failure: it lands one row off more than once — the row index or the 0.5 band needs a look
         (report which direction it is consistently off by).

    d. **Auto-scroll.** Grab a to-do near the bottom of a long list, hold the finger in the strip at the
       **top** edge of the list and keep it still.
       - Success: the list scrolls up under the finger, the trace shows `drag-autoscroll:up`, and
         releasing over a group above actually reschedules it there. **What is under the finger decides
         what is painted**, and near the very top of the list that is usually the *pinned* group heading
         (it is sticky, and the scroll band starts at the list's top edge): a highlighted heading rather
         than an insertion line is correct there, and the desktop drag does the same. Slide down a few
         millimetres, still inside the band, and the line follows the rows arriving.
       - Failure: the list does not move, or it moves but the drop lands nowhere, or the line/highlight
         lags the arriving rows by more than a moment (that would be the row index not re-syncing).

    d-bis. **Watch each drop land.** On any successful drop, look at the list the moment it repaints.
       - Success: the to-do appears in its new place, once.
       - Report it (not a failure, a measurement): if the list first flashes the to-do back where it
         started and only then shows it moved, that is the two mobile renders the fire-and-forget guard
         release allows — the drop message and `['dialogGuard', false]` are both posted without waiting,
         so the host can repaint once before the write has landed. Awaiting the drop would collapse it to
         one render at the price of a guard that leaks if that promise never settles, which is why it is
         not done blind. This step is the evidence that would justify changing it.

    e. **A heading drop keeps the time of day.** Note a to-do's due time, then drop it on the "Tomorrow"
       heading (or a calendar day).
       - Success: it moves to that day at the **same clock time**; a to-do with no due date gets the day
         start time (09:00 by default). Dropping on "No Due Date" clears the alarm.
       - Failure: the time is reset, or the drop does nothing.

    f. **The menu is not lost.** Hold a row and release **without** moving.
       - Success: the context menu opens exactly as it did before 2.3.0, the note does **not** open
         behind it, and "Move to date…" still works from there. The trace reads `menu-on-release`.
       - Failure: no menu, or the menu opens and vanishes a moment later (that would mean the refresh
         guard was taken on the no-travel path — report it, it is the one thing this design is careful
         about).

    g. **The guard does not leak.** Cancel a drag by releasing over the panel's header, then **wait two
       minutes** doing nothing.
       - Success: the panel still refreshes (tick a to-do elsewhere, or let a sync land, and watch the
         list update).
       - Failure: the panel freezes for good — a leaked `dialogGuard`. Capture the trace's last line.

    h. **Rotate mid-drag.** Start a drag and rotate the phone while the finger is down.
       - Success: the drag ends cleanly — no stuck banner, no dimmed row, no frozen panel. Trace:
         `drag-cancel:orientation` (or `:resize`).

    i. **Week view.** Switch to the week planner and drag a card onto another day's column.
       - Success: the column highlights while the finger is over it and the to-do moves to that day.

    j. **No regressions in the ordinary gestures.** Flick-scroll a long list; tap a title; tap a
       checkbox ring; hold a checkbox ring.
       - Success: the list scrolls freely, a tap opens the note, a tap on the ring ticks it, a hold on
         the ring opens the date picker. None of these lifts a row.
       - Failure: any of them behaves differently from before 2.3.0.

    k. **Trace off.** Turn the Gesture trace setting back off and repeat 18a.
       - Success: **no strip appears at all** at the bottom of the panel, and the drag still works.
