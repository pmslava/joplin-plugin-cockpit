# Brief 2.10 — Quick filters in the header

Answer to [issue 6](https://github.com/pmslava/joplin-plugin-cockpit/issues/6) ("Show only notes with checkboxes inside") and to Slava's own request: the sort block in the header's second row (the "Title" picker and the direction arrow) is never used from the header, so it gives its place to a block of four one-press filters. Sorting stays a profile setting, set in the profile editor.

## The block

`#filterRow` becomes: the notebook dropdown, the quick-filter group, the sync button. The sort dropdown and the direction button leave the header; `getSortDropdownHTML` goes with them. The host still answers the `sortFieldSelected` and `sortDirectionClicked` messages exactly as before (the harness and two e2e specs post them as a benign re-render, and nothing is gained by rewriting eighty call sites), but no control in the header posts them any more.

The group is a segmented control: one bordered pill, four square buttons inside it, divided by hairlines. Markup contract (both implementers build against this; the host draws it, panel.css styles it):

```html
<div id="quickFilters" class="quick-filters" role="group" aria-label="Quick filters">
    <button type="button" class="quick-filter" data-filter="completedTodos" aria-pressed="true"
        aria-label="Completed to-dos" title="Completed to-dos: shown&#10;Click to hide them"
        onclick="onQuickFilterClicked('completedTodos')">${icons["todoCompleted"]}</button>
    <button ... data-filter="openCheckboxes" ...>${icons["checkboxOpen"]}</button>
    <button ... data-filter="doneCheckboxes" ...>${icons["checkboxDone"]}</button>
    <button ... data-filter="noCheckboxes" ...>${icons["checkboxNone"]}</button>
</div>
```

| data-filter | aria-label | Shows, while pressed |
|---|---|---|
| `completedTodos` | Completed to-dos | completed to-dos (the profile's four period switches decide which) |
| `openCheckboxes` | Items with open checkboxes | notes and to-dos with at least one unticked checkbox inside |
| `doneCheckboxes` | Items with all checkboxes done | notes and to-dos with checkboxes inside, all of them ticked |
| `noCheckboxes` | Items without checkboxes | notes and to-dos with no checkbox inside |

The tooltip is two lines in the rows' `&#10;` shape: `<label>: shown` / `Click to hide them`, or `<label>: hidden` / `Click to show them`. `aria-pressed` carries the state; the webview posts `['quickFilterToggled', '<data-filter>']` and resets `savedTodosScrollTop` (it is a change of view, like a sort change was).

Every item belongs to exactly one of the three checkbox categories (open: `total - done > 0`; done: `total > 0 && done === total`; none: `total === 0`), so with all three pressed nothing is filtered and nothing is read. All four start pressed on a fresh profile. All three checkbox buttons may be released at once; the view is then empty and says so with the ordinary empty-state wording. The categories are the ring's own: open is a partly filled ring, done a full ring, none a plain disc.

### Pressed and released

Icons are new entries in `src/ui/icons.ts`, drawn like the existing ones (24-unit grid, one path, `fill: currentColor`, 2-unit strokes matching the `todo` glyph's ring): `todoCompleted` (a filled disc with the tick knocked out of it — the row's own completed look, a circle because the panel's glyph language uses circles for to-dos), `checkboxOpen` (a rounded square outline, empty), `checkboxDone` (the same square with a tick inside), `checkboxNone` (the same square with a diagonal bar through it). Squares for checkboxes inside a note, circles for to-dos: that is how the panel already tells the two apart.

Pressed: the dropdown face colour (`--cockpit-background-color4`) behind a full-strength glyph in `--cockpit-color`. Released: no fill, the glyph in `--cockpit-color-faded` at reduced opacity, so a released filter reads as sunken and dim while the default all-pressed row stays a calm, neutral toolbar. Hover uses `--cockpit-background-color-hover-dim3` in both states; focus the `--cockpit-focus-outline-color` as `.dropdown-toggle:focus` does. The group's border, radius and 26 px height match `.dropdown-toggle`; each button is about 30 px wide, so the group is about the width the sort picker and arrow took. On mobile the buttons grow their tap area vertically only, as `.cockpit-mobile #filterRow .icon-button::after` does. Every theme preset and the Custom colours must keep pressed and released distinguishable; check `theme.ts` for what the variables resolve to in light, dark and Match Joplin.

## State

The header holds four session booleans, `quickFilters = { completedTodos, openCheckboxes, doneCheckboxes, noCheckboxes }`, applied from the profile by `applyProfileHeaderState`, exactly as the notebook and the search are:

- `openCheckboxes`, `doneCheckboxes`, `noCheckboxes` come from three new profile fields `showOpenCheckboxes`, `showDoneCheckboxes`, `showNoCheckboxes` (boolean, default `true` in `profileDefaults`, so every stored profile and every synced profile gets them without a migration).
- `completedTodos` is derived: pressed when any of the profile's four period switches (`showCompletedPast/Today/Future/NoDue`) is on. The effective switches a render uses are: released → all four off; pressed → the profile's four, or all four on when the profile has none on. That is what the completed-to-do narrowing (`showAnyCompleted` in `fetchTodos`, the per-bucket filter in `narrowTodos`, `itemMatchesView` in panel.ts) must read, through one helper, never the raw profile.

`headerBaseline` and `headerDiffersFromProfile` take the four booleans in beside the notebook, the search and the sort, so a released filter marks the profile with the asterisk; the toggle's tooltip says "The notebook, search or filters changed since the profile was selected". "Save view into <name>" writes the three checkbox fields and the effective four completed switches along with what it writes today. `profileSeedFromCurrentView` seeds the same, so "+ New profile…" opens on the filters on screen. The profile editor (desktop `editorTemplate.ts` + `editorWebview.js`, the mobile overlay's `EDITOR_FORM_HTML` + the `EDITOR_*` id lists in `panelWebview.js`) gets a fieldset "Checkboxes inside" right after "Show Completed", with three checkboxes: "Items with open checkboxes", "Items with all checkboxes done", "Items without checkboxes". "Sort ties by" and "Direction" stay where they are; they are now the only place sorting is set.

The overview note (markdown) is not filtered by the checkbox categories: it is drawn from the profile's search criteria and display settings and reads no bodies, and it keeps reading the profile's own completed switches. The "Results outside current filters" and "Results in excluded notebooks" peeks are outside these filters by definition and keep reading no bodies. The revealed-note pin is a read-only row and is not filtered.

## Where the filter is applied

After the counts are attached and before any drawing cap: in `narrowTodos` (every format, the calendars included, since they draw the same list), and in the notes section before `notesLimit` slices it. "Show more", the per-group footers and the "+N" overflow count the filtered list.

A row is judged from the `checkboxCounts` cache (`joplin.ts`): a row counted before is judged by its counts, stale or not (a stale row is re-read in the same pass and judged again on the next paint; it is never hidden in between). A row never counted is **unread**: it is left out of the paint, counted, and read by the scan below. An optimistic insert whose counts are unknown is not evaluated locally (`itemMatchesView` answers false), so the reconcile lane brings it in once its body has been read.

## Cost, and keeping it at zero by default

- With the three checkbox buttons pressed (the default, and every profile that exists today), the code path is byte-for-byte the one that exists: the same body reads for the rings of drawn rows, the same `undrawn` skip, the same 300-per-refresh cap, nothing scheduled.
- With any checkbox button released, a **checkbox filter is active**, and the counts of every candidate row (after the completed, no-due, notebook and search narrowing) are needed before the list can be drawn. The `undrawn` skip is off (the cap cannot be computed before the filter), and the per-refresh body cap gives way to a **time budget per render** (`checkboxScanPassMs`, 2 s, shared by the to-do and Notes sections, started at the render's first chunk; at least one chunk is always read): a pass reads chunks of 20 until the candidates run out, the budget is spent, or the render is no longer current. Time rather than a count, because each pass ends in a full render and paint of the panel - 1.5-2 s at 20k rows, and a webview reload on mobile - so a fixed 1,000-body batch made 20 of them on the 20k template and the renders, not the reads, took the time; a budget also reads fewer bodies per pass on a slow mobile bridge and stays as responsive. The toggle itself paints fast-then-fill, so the pressed state shows at once; while unread rows remain the list shows a status line, `<p class="notes-more-message" id="checkboxScan">Reading the checkboxes inside 1,234 notes…</p>` (the count formatted with `formatCount`), and the host schedules the next pass at once (a continuation render on a zero timer, not the periodic tick, whose interval is 60 s by default). The continuation stops when no unread row remains, and it is dropped when the view changes under it: a profile switch, a notebook or search change, a filter toggle, each of which claims a new `refreshGeneration`, as today. It never runs twice at once, and never beside the render that follows a fast paint (`asOneRender`): a pass owed while a render is in flight is re-armed by the last render out, and a pass already reading stops between chunks once its render is no longer current.
- Bodies are read once per note version: the cache entry is keyed by id and stamped with `user_updated_time`, so a second toggle, a refresh, a tick, a switch to another profile and back all read nothing; only a note edited since is re-read, one body. On a 20k vault the whole scan is about 20k single-note GETs in chunks of 20, a few seconds on desktop; afterwards every toggle is instant. The counts cache is what the rings already keep (id → three numbers); the bodies are not retained. No timer, no listener and no memory is added while no checkbox filter is active.
- Mobile: the fast paint skips bodies as today; the fill pass runs the scan. The mirror is not saved on mobile, so a cold start with a filter active scans once per session, as the rings already do.

Not in this change: persisting the counts with the saved note store (`noteStoreFile.ts`), which would make a filter instant across restarts on desktop. A follow-up if the measured cold scan warrants it.

## Pins (harness, `test/run.js`)

- Header: the group with four `aria-pressed="true"` buttons between `#notebookMenu` and the sync button, the sort dropdown and direction button absent from the header markup, the tooltips in both states; the test that slices the header up to `id="sortMenu"` retargeted to `id="quickFilters"`.
- Profile: the three fields default true and survive `normalizeProfile` from strings, numbers and absence; the editor forms (both) carry the fieldset; the settings note carries the fields (the payload is the whole profile).
- Semantics on a fixture with notes and to-dos of each category: each toggle hides exactly its category; the completed toggle released hides every completed to-do whatever the switches say, pressed on a profile with none on shows all four buckets; the three released together draw an empty view; the overview markdown ignores the checkbox filters; the peek ignores them.
- Asterisk, save and seed: a released filter marks, pressing it again clears; "Save view into" writes the three fields and the effective switches and nothing else new; the seed carries them; a switch away and back restores the profile's own.
- Cost: with all three pressed, the `bodyFetch` count of a render on a 1,000-row fixture equals what the same render costs on main today (pin the number); with one released, every candidate body is read exactly once across the continuation passes and the status line shows until the last pass; a second toggle after the scan reads zero bodies; a tick after the scan reads zero bodies; a note whose `user_updated_time` moved is re-read once; a profile switch mid-scan ends the scan (no `bodyFetch` after the switch's own render beyond the chunk in flight); the mobile fast paint reads none and its fill runs the scan.

## Beyond the host

- `README.md`: the sort-picker paragraph in "Search and filtering" becomes the quick-filters paragraph (and names where sorting now lives); the header description in the hero screenshot's comment; the Profiles bullets gain the three switches; the sentence on "+ New profile…" / the asterisk / "Save view into" names filters. The hero screenshot itself still shows the sort block: a re-shoot is Slava's, through the showcase spec.
- E2E (`e2e/`): `profiles.spec.ts` sets the sort through the header in "+ New profile opens on the current view" — it releases a quick filter instead and expects the editor's new checkbox to follow; `helpers.ts` comments; one new spec seeding a note with open checkboxes, one with all ticked, one plain and one completed to-do, pressing each button and reading the rows.
- Perf: `COCKPIT_PERF=1` on the existing `e2e/.profiles/perf-template-20000` with a profile that has `showNoCheckboxes` off, reporting the scan's duration, the number of bodies, and the first paint next to a run with the filters pressed.
