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

## Implemented in the mobile phase

Three commits, all mobile-gated, each verified to leave the desktop paths byte-for-byte unchanged.

### 1. Dialog stacking guard — dialogs stay in front of the panel

On mobile Joplin renders the panel viewer and every custom dialog as separate React Native `<Modal>`
windows and cannot reliably z-order two that are visible at once; the always-mounted panel viewer is
declared last, so a dialog opening in the same commit as a panel re-render (or a mid-dialog refresh
re-asserting the viewer) can land **behind** the panel. A plugin cannot set the native z-order from
inside its webview, so the fix is pure timing (`src/core/dialog.ts`):

- `openPluginDialog()` holds a shared `dialogOpenCount` guard and, on mobile, yields one tick before
  `dialogs.open()` so the dialog's Modal commits in its own React Native commit and attaches last (on
  top). Wired at all four dialog sites (alarm, editor, styler, notebook picker) — and now the tag
  picker (commit 3).
- `refreshPanelData` early-returns while a dialog is open (`isDialogOpen()`, mobile only), so a timer
  tick's `setHtml` cannot re-assert the viewer Modal over an open dialog. The guard clears in
  `openPluginDialog`'s `finally` after the dialog is dismissed, and every dialog site refreshes
  afterwards, so nothing is lost.

### 2. Touch-interaction layer + tap targets + viewport (`panelWebview.js`, `panel.css`)

All gated on the mobile flag (`IS_MOBILE` / `.cockpit-mobile`), so desktop click, dblclick,
`contextmenu` and HTML5 drag are untouched.

- **Long-press context menus**: a Pointer Events adapter (500 ms; cancelled by >10 px move, pointer
  up/cancel, or a list scroll) synthesises the three desktop context-menu handlers (to-do row, note
  row, group heading). The trailing synthetic click is swallowed so tap-to-open does not also fire.
- **Reschedule on touch**: a mobile-only "Move to date…" to-do menu entry (and a checkbox long-press)
  posts the existing `setAlarmClicked`, i.e. opens the alarm dialog as the date picker.
- **Sync status without hover**: long-pressing the sync button shows its tooltip
  (last-sync time / duration / errors) as a transient bottom toast.
- **Tap targets**: ~40 px hit areas via `::after` overlays and stacked-row `min-height`, with the
  18 px checkbox ring and row layout preserved visually.
- **Autocomplete on touch**: the search-suggestion pick commits on `pointerdown` (not `mousedown`) on
  mobile, keeping the field focused and the soft keyboard up.
- **Viewport**: `#joplin-plugin-content` keeps `height: 100vh` as the base, with a mobile-gated
  `@supports (height: 100dvh)` override to `100dvh` on `.cockpit-mobile`. Inside the plugin-dialog
  iframe `dvh == vh`, so this is a harmless, future-proof line; the real fill guarantee is the flex
  column (`.todos { flex:1 1 auto; min-height:0; overflow-y:auto }`).

### 3. Command fallbacks + responsive alarm dialog (this commit)

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

9. **Dialog-behind-panel race (regression watch).** Repeat opening a dialog (alarm, tag picker,
   notebook picker) several times, sometimes right as the list would refresh.
   - Success: the dialog always appears **in front** of the panel.
   - Failure: it occasionally opens behind the panel → the timing guard is not fully holding on this
     device; capture how often and from which trigger.

10. **Autocomplete + soft keyboard.** In the search field type `tag:` or `title:` and tap a
    suggestion.
    - Success: the suggestion commits into the field, the field stays focused, the keyboard stays up.
    - Failure: the tap dismisses the keyboard without committing, or double-commits.

11. **Cold-start feel over a real vault.** Note time-to-first-render and scrolling smoothness on the
    first open over the full vault.
    - Success: the panel paints quickly; checkbox rings fill in over the next refresh or two.
    - Failure: a long stall or janky scroll on first open → candidate for the mobile perf trims
      (lower the body-fetch cap / trim follow-up refreshes); record rough timings.
