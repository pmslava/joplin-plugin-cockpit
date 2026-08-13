# Cockpit — Mobile Readiness Runbook

Maintainer notes for running Cockpit on Joplin mobile (Android/iOS). Cockpit already did a
real mobile pass in v4.0.0 (platform detection, `isMobile` toolbar/menu guards, inline SVG icons,
settings-based storage, mobile-only styler/profile buttons). This document covers the remaining
seams, what this batch changed, the work still queued for the mobile phase, and the device-test
checklist for the first Pixel sideload session.

## Current status

- **Manifest** (`manifest.json`): `platforms: ["desktop","mobile"]`, `app_min_version_mobile: "3.3"`,
  `app_min_version: "2.9"`. 3.3 is a safe floor (Android plugin support stabilised ~3.1–3.2).
- **App commands** all funnel through `runAppCommand()` (`src/ui/panel/panel.ts:484`), which
  try/catches and shows `"…is not available here"`, so an absent desktop-only command degrades to a
  message box rather than crashing. `deleteNote` additionally falls back to `joplin.data.delete`
  (trash) at `src/ui/panel/panel.ts:519`.
- **Build**: webpack `target:'node'` with node builtins set `false` (`webpack.config.js`); node
  modules (sqlite3, fs-extra) are pulled only via `joplin.require` behind `requireNodeModule` guards
  (`src/core/platform.ts`, `src/core/database.ts`, `src/core/styler.ts`), never hard-bundled, so the
  mobile bundle carries no node-builtin requires. Webview scripts (`panelWebview.js`) are copied
  verbatim. No polyfill work needed. `.jpl` sideloading on mobile is supported (Settings > Plugins >
  install from file).
- **Already responsive**: week-planner grid `auto-fit minmax(160px)` (`panel.css`), calendar-grid
  `table-layout:fixed`, day headers auto-abbreviate on narrow widths (`src/core/formats.ts`).
- **Perf already guarded**: `refreshPanelData` bails when markup is byte-identical
  (`lastRenderedHtml`, `src/ui/panel/panel.ts`); checkbox body fetches capped 300/refresh in chunks of
  20, cached by `user_updated_time` (`src/core/joplin.ts`); notebook map + tags TTL-cached 20s.

## What this batch changed

All five are engine changes safe without a device; each also helps desktop or is pure robustness.

1. **Clipboard guarded** — `src/ui/panel/panel.ts`. `copyMarkdownLink` / `copyNoteID` now route
   through a new `copyToClipboard()` helper (`src/ui/panel/panel.ts:514`) that existence-checks
   `(joplin as any).clipboard.writeText`, try/catches, and falls back to the same message-box pattern
   `runAppCommand` uses. These were the only note-menu actions that could throw an **unhandled
   rejection** on a platform where the Electron-backed clipboard is unimplemented.
2. **`synchronize` defensively wrapped** — `src/ui/panel/panel.ts:187`. The one direct
   `joplin.commands.execute('synchronize')` now goes through `runAppCommand('synchronize')`. Toggle
   semantics and fire-and-forget nature preserved (completion still tracked via `onSyncStart` /
   `onSyncComplete` in `src/core/timer.ts`).
3. **Control rows wrap** — `src/ui/panel/panel.css:197`. Added `flex-wrap: wrap` to `#profileControls`
   and `#filterRow`, and changed `.create-button` from `flex: 0 1 auto` to `flex: 0 0 auto`
   (`panel.css:143`) so the labelled "New note" / "New to-do" buttons wrap instead of crushing the
   profile picker on a narrow phone (also helps a narrow desktop panel).
4. **Alarm dialog tolerates narrow screens** — `src/ui/alarm/alarm.ts:27`. `#joplin-plugin-content`
   width `424px` → `min(424px, 100vw - 16px)`; `#alarmForm` `width: 400px` → `width: 100%;
   max-width: 400px`. Still hands Joplin a concrete measured width (the `min()` keeps desktop at 424px,
   respecting the documented 200px feedback-loop caveat at `alarm.ts:22-25`) but stops 424px
   overflowing a ~360–412px phone. **Verify desktop rendering** — the sizing hack is delicate; the
   `min()` form is specifically chosen to preserve the desktop measurement.
5. **Skip panel build while hidden** — `src/ui/panel/panel.ts:237`. `refreshPanelData` early-returns
   when `await joplin.views.panels.visible(panel) === false`, wrapped in try/catch defaulting to
   visible so any API oddity keeps current behaviour. This saves the full search / notes / body query
   cycle on every 60s timer tick + 5/15/30s follow-ups (`src/core/timer.ts:21,69`) while the panel is
   hidden — benefits desktop too. `refreshNoteData` is unaffected (it runs separately in
   `refreshInterfaces`, `src/core/timer.ts:42`). **Interaction**: `togglePanelVisibility`
   (`src/ui/panel/panel.ts:201`) now forces `refreshPanelData()` when showing the panel, so it renders
   fresh on show rather than displaying stale/empty markup. The `lastRenderedHtml` equality guard still
   holds the last rendered markup across the hidden period, so the re-render is correct.

## LATER — mobile-phase work items

Actual mobile work, most needing a device. One-line plan each.

1. **Touch context menu** — add a long-press adapter (pointerdown + timer, or touchstart) that calls
   the existing `onTodoContextMenu` / `onNoteContextMenu` / `onHeadingContextMenu`
   (`src/ui/panel/panelWebview.js:118,161,217`) with the same target-zone dispatch; the whole note menu
   (open/tags/move/duplicate/copy-link/copy-id/delete), set-alarm on the circle, and move-to-notebook
   ride on `contextmenu`, which touch webviews do not reliably fire. Biggest mobile gap.
2. **Touch drag-to-reschedule** — replace/supplement HTML5 DnD (`formats.ts` `draggable`,
   `panelWebview.js:231-267`) with Pointer Events (pointerdown/move/up + long-press to arm), reusing
   the existing `['todosDropped', ids, target]` message and `data-drop` targets; or, simpler first cut,
   add a "move to date" entry to the touch context menu that opens the alarm/date picker.
3. **Mobile-friendly sync status** — surface what the sync button `title` carries (last-sync
   time/duration/errors, `src/ui/panel/panel.ts:268`) as visible inline text or a tap-to-show line,
   since hover tooltips are unreachable on touch.
4. **Responsive alarm dialog** — rework `src/ui/alarm/alarm.ts` so calendar + time columns stack/reflow
   under a narrow width (media query or flex-wrap on `#alarmBody`), verified against Joplin's mobile
   dialog measurement so it neither collapses to 200px nor clips; confirm the ISO text inputs behave
   with the mobile keyboard.
5. **Mobile-native fallbacks for degrading commands** — where `moveToFolder` / `setTags` /
   `duplicateNote` turn out absent on mobile (see unknowns 2), implement via `joplin.data` (a notebook
   picker like `pickNotebook` for move; a tag dialog; a note copy for duplicate) instead of the
   "not available here" message box.
6. **Verify 100vh sizing** — `panel.css:27` (`#joplin-plugin-content height:100vh; overflow:hidden`).
   Inside the mobile plugin-dialog iframe, 100vh may not equal the visible dialog height; switch to
   `100dvh` or a flex-fill layout if the list clips or leaves dead space.
7. **Autocomplete on touch** — confirm the mousedown-before-blur suggestion pick
   (`panelWebview.js:448`) works in the Android webview; if it double-fires or blur commits first,
   switch to pointerdown/touchstart with `preventDefault`.
8. **Tap-target sizing pass** — audit the 22px row-action buttons (`panel.css:309`) and 18px checkbox
   circle (`panel.css:438`) against the ~44px touch-target guideline; bump on mobile via an
   `isMobile`-gated class.

## UNKNOWNS — first Pixel sideload test checklist

Things only a real Pixel + Joplin mobile can answer. Work through these in the first device session.

1. **Clipboard** — is `joplin.clipboard` implemented on the mobile runtime at all? Test copy-link /
   copy-id from the note menu: do they copy, or hit the new "clipboard is not available here" message?
   (Bundled type is Electron-backed, `api/JoplinClipboard.d.ts:2`.)
2. **App commands** — which of `moveToFolder`, `setTags`, `duplicateNote`, `newFolder`, `renameFolder`
   actually exist as executable commands on mobile? Each that is absent falls back to the message box;
   this decides how many context-menu/notebook actions need native `joplin.data` fallbacks (LATER 5).
3. **contextmenu** — does `contextmenu` ever fire from a long-press in the Android plugin webview, or is
   it fully dead? Decides urgency of the long-press adapter (LATER 1).
4. **100vh** — does `100vh` (`panel.css:27`) map to the visible plugin-dialog height, or does mobile
   viewport/notch/dialog chrome make the list clip or leave a gap? (LATER 6.)
5. **Dialog widths** — measure the actual rendered width of the plugin panel dialog and of custom
   dialogs on a Pixel. Validates the alarm-dialog width fix (batch item 4) and whether
   `notebookPicker`'s 300px (`src/ui/panel/panel.ts`) fits.
6. **panels.visible() on mobile** — does `joplin.views.panels.visible()` return meaningful state for the
   mobile tabbed-dialog panel (open vs closed)? The batch item 5 visibility-skip depends on it. If it
   returns false when the tab is merely inactive, panel content may be up to 60s stale when the tab is
   opened (the try/catch defaults to visible, so an *error* is safe; a *wrong-but-valid* value is the
   risk). If stale, add a refresh trigger on the mobile show path.
7. **Touch mouse synthesis** — do touch taps reliably synthesize the `mousedown` that row selection
   (`panelWebview.js:82`) and autocomplete (`panelWebview.js:448`) rely on, with correct ordering
   relative to input blur? (LATER 7.)
8. **Cold-start cost** — real cost on weaker hardware of the 300-body checkbox fetch cap
   (`src/core/joplin.ts`) + 5/15/30s follow-up refreshes over a large vault; decides whether to lower
   the cap / trim follow-ups on mobile.
9. **app_min_version_mobile** — is `"3.3"` actually the lowest version that runs this plugin (panels +
   `versionInfo.platform` + guarded commands all present), or should it be raised?
