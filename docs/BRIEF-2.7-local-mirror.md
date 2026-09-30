# Cockpit 2.7: the local note mirror (orchestration brief)

Written 2026-09-29, at the end of the session that shipped v2.6.3. It is for the managing session that plans and runs the 2.7 build. The file is not committed; decide whether to keep it in `docs/`.

Read these first: this brief, `docs/DEVLOG.md` (the last entry, "2026-09-29 — large collections"), and the project's main Joplin note (`164d64772c624ef99baeb751d4ef8e36`, the runbook and gotchas).

---

## 1. Where things stand

**v2.6.3 is released.** It fixed a forum report (plutoBase, discourse topics 50655 #13 and 51104): on a large collection, Cockpit's first run froze Joplin for minutes, the user could not disable the plugin, and called Cockpit "effectively malware". Slava replied in both threads and promised a post when the fix was out.

**Root cause, verified in the Joplin 3.6.14 bundle.** The data API's `search` route answers every page by running the *whole* search again (`notesForQuery`), projecting and sorting all matches, and then slicing one page of at most 100. Paging M matches therefore costs about M²/100 row loads, all in Joplin's main-window renderer. The default profile ("All todo and notes") paged every note through that route on every refresh and drew a row for each. The 60 s timer then started it again.

**What 2.6.3 does** (commits 76ca2fd, 58fa141):
- **Unfiltered notes** (no profile criteria, nothing typed, not `any:1` — see `isUnfilteredQuery` in `src/core/joplin.ts`): the Notes section reads the live `GET /notes` listing, newest first, and stops at `NOTES_BATCH = 1000` (in `src/ui/panel/panel.ts`). A "show more" footer adds 1,000 per click.
- **Filtered notes:** still go through the search, newest first, under the same cap.
- **To-dos:** stay on the search. An *unfiltered* to-do search that runs past 10 pages switches to a full listing walk for the rest of the session (`preferTodoListing`). A filtered to-do search is never cut short.

**Measured on 20,000 notes + 1,000 to-dos** (`e2e/perf-large-vault.spec.ts`; the heartbeat measures main-window lag):

| | first paint after UI up | main-window lag | stalls > 1 s | process-tree RSS |
|---|---|---|---|---|
| no plugin | — | 0 | 0 | 1.3 GB |
| 2.6.2 | never (> 3 min) | 62 s in ~80 s | 27 | 2.1 GB |
| 2.6.3, cap 1,000 | 8.5 s | 1.8 s / 150 s | 0 (max 0.55 s) | 1.9 GB |
| no cap, listing only | 21.7 s | 55 s / 150 s | 9 (max 3.9 s) | 3.2–3.5 GB |

The last row matters most for 2.7: **with the data fetch already cheap, drawing 21,000 rows is by itself enough to hang Joplin.** A mirror fixes fetching, not drawing.

Per-call costs at 21k (`PERF_API=1`):

| call | cost |
|---|---|
| `type:note` search page | ~1,000 ms |
| `type:todo` page (1k matches) | 28 ms (whole walk 333 ms) |
| `GET /notes` page | 10–32 ms (all 211 pages 5.5 s, non-blocking) |

---

## 2. Why 2.7

Slava asked whether the Inline Tag Navigator model would do better, for small and huge collections alike. It would. That plugin (alondmnt/joplin-plugin-tag-navigator, `src/db.ts` `processAllNotes`):
- walks `GET /notes` 50 at a time with `id, updated_time, parent_id`;
- keeps its own in-memory database;
- re-reads a body only when `updated_time` moved;
- has its periodic full rescan off by default (`itags.periodicDBUpdate = 0`), updating per note on change events instead.

2.6.3 borrowed the *source* (the listing), not the *model*: Cockpit still re-reads from Joplin on every refresh (every 60 s, after every change, on every profile switch). 2.7 adopts the model.

---

## 3. Goal

A local mirror of every note's metadata, built once and kept exact by Joplin's change feed. Every view that needs no Joplin search syntax is computed from the mirror with zero data calls.

Expected wins:
- **Refresh cost:** about 12 calls per refresh on Slava's collection and about 22 on a 21k one become 0–1 calls (one empty `events` poll). The large-to-do weak spot (a full 5.5 s walk on every refresh past 1,000 to-dos) disappears.
- **No search-index lag** in unfiltered views. Today a note edited or synced in shows up only after Joplin's 10 s index timer. Much of `src/core/optimistic.ts` and the reconcile lane (`src/core/timer.ts`, offsets 1/3/7/15/30 s) exists only to paper over that lag.
- **Local and instant:** profile switches, notebook-filter changes, the completed/undated switches, and the day rollover.

**Non-goals for 2.7:**
- A virtualised row list, which is what would allow the 1,000 cap to go. Propose it as 2.8.
- Changing the search syntax.
- Changing any user-visible behaviour except "faster" and "no index lag".

---

## 4. Verified facts to build on

Joplin 3.6.14, read from `.e2e-cache/squashfs-root/resources/app.asar`. Extract it with `npx @electron/asar extract … app` into a scratch dir, never under `~/Lab`.

- **Change feed.** `joplin.data.get(['events'], { cursor })`:
  - Without a cursor it returns `{ items: [], has_more: false, cursor: <lastChangeId> }`.
  - With one it returns `item_changes` rows after that id. The fields are `id, item_type, item_id, type, created_time`, where `type` is 1 create, 2 update, 3 delete, and `item_type` 1 means note.
  - It is SQL-paged (`WHERE id > ? ORDER BY id LIMIT 100`) and returns the next `cursor`.
  - Rows are pruned after **90 days** *and* only once Joplin's resource, search and revision services have processed them (`ItemChangeUtils.deleteProcessedChanges`). A cursor older than that must fall back to a full walk.
  - **Verified by the phase 1 run** (details below):
    - plugins reach the route through `joplin.data`: yes;
    - sync-applied changes appear in it: yes, a synced-in create as type 1, a synced edit as 2, a synced trash as 2 with `deleted_time` set, a synced permanent delete as 3;
    - mobile: not reachable by the harness, so unproven; the design guards it (section 5, question 3).
- **Listing.** `GET /notes` is SQL-paged:
  - `limit` must be ≤ 100, or it throws "Limit out of bond".
  - `order_by: 'id'` and `'user_updated_time'` both work.
  - It excludes trashed notes and conflicts, but 2.6.3 also asks for `deleted_time` and filters, as a belt-and-braces check.
  - It returns the *live* `is_todo`, with no index lag.
- **Search.** The route re-runs everything per page (above). Use it only for queries the mirror cannot answer, and never page an unbounded one.
- **`onNoteChange`** (`api/JoplinWorkspace.d.ts`) is documented as "the content of the current note". Cockpit's `timer.ts` treats it as firing for any note, sync included. Treat it as a hint only; the `events` cursor is the authority.
- **The folder map** is already polled every 3 s (id/title/parent_id signature, `pollFoldersOnce`). Notebooks can stay as they are.
- **Memory.** Every Joplin plugin runs in its own renderer, at about 32–57 MB PSS each on Slava's machine (20 plugins, Joplin 1.77 GB PSS in total). The panel iframe lives in the main renderer. Cockpit's own main-window share at 21k with 2,000 rows is about +180 MB RSS (+26 MB JS heap). A metadata mirror of 21k notes should cost a few MB; measure it.

### Verified 2026-09-30 in phase 0, read from `main-html.bundle.js` (the renderer bundle that serves `joplin.data`)

- **The feed is note-only.** `ItemChange.add` has exactly two call sites: `Note.save` (type 1 on create, 2 on update, for every `changeSource`, sync and decryption included) and `Note.batchDelete` (type 2 with `toTrash`, type 3 for a permanent delete). Tag attach/detach (`Tag.addNote` → `NoteTag.save`) writes no row and does not bump the note. Folders write no row either.
- **One row per item.** `addMulti` runs `DELETE FROM item_changes WHERE item_id = ?` before its `INSERT`, so the table holds only the latest change of each note, at the latest id. A note created and then edited since the cursor shows as one *update*; a note created and then permanently deleted shows as one *delete* of an id the store never had. Treat create and update as one upsert, and a delete of an unknown id as a no-op.
- **The row is written after the save returns.** `Note.save` calls `ItemChange.add` without awaiting it (a mutex-serialised batch). A poll fired the instant a save returns can miss its row; the next poll sees it. Cockpit's own PUTs must update the store in the same code path, and a triggered poll should be followed by one more short one.
- **Route semantics** (`routes/events`): `limit` is fixed at 100 and not taken from the query; `fields` may be narrowed; `has_more` is `items.length >= 100`; the returned `cursor` is a **string** (`String(lastRow.id)`, or the input cursor echoed when nothing changed, or `String(lastChangeId)` without a cursor); the request does `Number(cursor)` and throws `Invalid cursor` only for NaN. **A stale cursor is never rejected:** `changesSinceId` is `WHERE id > ? ORDER BY id LIMIT 100`, so pruned rows are silently absent, and a cursor from another database (a restored backup, a different profile) whose ids run lower returns nothing forever.
- **Pruning** (`deleteOldChanges`): `DELETE FROM item_changes WHERE id <= min(resource, search, revision lastProcessedChangeId) AND created_time <= now - 90 days`. A row created while Cockpit runs cannot be pruned in that session.
- **Trash** is a raw `UPDATE notes SET deleted_time = ?, updated_time = ?` (no `user_updated_time` change) followed by a type-2 row; restore is a `Note.save` with `deleted_time: 0`, also type 2. `GET /notes/:id` returns conflict notes, which the listing excludes, so a per-id fetch must ask for `is_conflict` and drop it.

### Verified 2026-09-30 in phase 1, by running it (`e2e/events-probe.spec.ts`, Joplin 3.6.14)

A throwaway probe plugin, loaded without Cockpit, read the feed from inside the sandbox while the spec changed notes from outside over REST. 6 of 6 passed in 1.8 min. The raw observations are in `e2e/.profiles/events-probe-findings.json` (gitignored; rerun to regenerate).

- **Plugins reach it.**
  - Without a cursor: `{ items: [], has_more: false, cursor: "3" }`.
  - The cursor is a string in every answer. A numeric cursor is accepted, reads the same rows, and is answered with a string.
  - `fields: ['id', 'item_id', 'type']` returns exactly those keys; the default is `id, item_type, item_id, type, created_time`.
  - **`limit` is ignored:** `limit: 5` with seven pending rows returned all seven.
  - `'abc'` fails with `Invalid cursor: abc`. A cursor 1,000,000 past the end returns an empty page, `has_more: false`, with the same cursor echoed.
- **Paging.** 150 creates, polled from the cursor before them: page 1 held 100 rows, `has_more: true`, cursor `"119"` (the last row's id); page 2 held the other 50, `has_more: false`. That is 150 distinct item ids, in ascending row-id order, all type 1.
- **One note's life over REST.**
  - Create: type 1.
  - Title, move to another notebook, `is_todo` flip, trash (`DELETE`, 200), restore (`PUT { deleted_time: 0 }`, which the route accepts, 200): each type 2.
  - Permanent delete (`?permanent=1`): type 3. Afterwards the plugin's GET fails with `Not Found` and REST answers 404.
  - The trashed note stays readable by id from the sandbox, with `deleted_time > 0`; after the restore it reads 0.
  - Each time, the first poll after the REST call answered already held the row (8–28 ms).
- **Coalescing, seen.**
  - Three title updates since cursor `"11"` came back as ONE row, whose id moved from 12 to 14; the table itself held one row for the note.
  - The shared instance's own helper note (created, then written twice) is one type-2 row at id 3.
  - At the end of the run the table held 160 rows for a max id of 210; the 50 ids in between are rows replaced by later changes.
  - `item_changes.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so an id is never reused, and a replaced row always lands above any earlier cursor.
- **Tags and folders write nothing.** Attaching a tag wrote no row, and the note's `updated_time` and `user_updated_time` did not move. Creating and renaming a folder wrote no rows at all.
- **The row lands after the save, measured.**
  - 20 REST PUTs, each followed by a plugin poll that came back 7–23 ms after the PUT answered: 20 of 20 held the row.
  - 20 of the plugin's **own** `joplin.data.put` calls, each followed at once by a poll in the same call (0–3 ms): **only 12 of 20 held it.**
  - All 40 rows were there 500 ms later.
  - The miss is about the gap, not the route: the REST poll only reached the route after an HTTP answer and two IPC hops. Cockpit's own writes are exactly the case where the next poll comes that soon.
- **Sync-applied changes, with their types.** Two profiles shared a filesystem sync target, with the probe in B:
  - three synced-in creates arrived as three type-1 rows;
  - the synced edit arrived as 2;
  - the synced trash arrived as 2, with the same `deleted_time` A wrote;
  - the synced permanent delete arrived as 3, and the note was gone from B.

  Each sync of the three notes took about 0.4 s, with no errors in the sync report.
- **`onSyncComplete` came after the rows.**
  - A poll armed on `onSyncComplete` ran the moment the handler did (answered in 5 and 7 ms), and in both rounds it already held all three rows.
  - The last row had been written 55 ms and 25 ms before the handler ran.
  - That is two observations, not a guarantee, since the row is still written un-awaited; the follow-up poll (section 5) covers this trigger too.
- **Pruning, a snapshot about 50 s into the session.**
  - The processed-change markers stood at resource 207, search 210, revision 16, so `minProcessed` was 16.
  - The 8 rows at or below it were still there, because they were seconds old, not 90 days.
  - The revision service's marker trails far behind the other two, which holds pruning back further still.
  - The run cannot show a 90-day prune; the source rule above is what keeps a row made in this session from being pruned in it.
- **The result channel.** A plugin command's return value reaches whoever executed it: 149 of 149 probe answers arrived that way.

---

## 5. Proposed design (for Slava's review before any code)

**A `NoteStore` module** (new, `src/core/noteStore.ts`):
- **Holds:** `Map<id, { id, title, is_todo, todo_completed, todo_due, parent_id, user_updated_time, user_created_time }>`, plus the `events` cursor.
- **Build:** a listing walk with `order_by: 'id'`, 100 per page, deduplicated by id. Take the `events` cursor *before* the walk, so anything changed during the walk is replayed afterwards.
- **Update:** poll `events` from the cursor on each trigger:
  - the existing `onNoteChange`, debounced;
  - `onSyncComplete`;
  - the 60 s tick.
  
  For each note id: on create or update, GET that one note's fields (or batch them); on delete, remove it. A note moved to the trash arrives as an *update* with `deleted_time` set, so remove it then too.

  Two rules the phase 1 run made firm (section 4):
  - **Cockpit's own writes update the store in the same code path.** Don't wait for the feed: an immediate poll after the plugin's own put missed the row 8 times in 20. The row that arrives later is applied as an ordinary upsert.
  - **Every triggered poll is followed by one more short poll.** All 40 rows the run measured, including the 8 an immediate poll missed, were there 500 ms later.
- **Recovery:** if the cursor is rejected or missing, rebuild with a full walk.
- **Optional persistence** across restarts (plugin data dir, keyed by profile). Decide with Slava: it makes startup instant on huge collections, but adds invalidation risk.

**Read paths:**
- `getTodos` / `getNotes` for unfiltered queries read the store (narrowing via `applyTodoNarrowing` / `applyNoteNarrowing`, exclusions, the notebook filter).
- Filtered queries keep the search, and could *intersect* with the store to drop stale-typed rows.
- The overview notes (`src/core/markdown.ts`) and the calendar formats go through `getTodos`, so they follow for free.

**The 60 s tick:**
- recomputes from the store (day rollover) with no data calls beyond one `events` poll;
- the equality guard (`lastRenderedHtml`) still prevents a repaint when nothing changed.

**Optimistic layer:**
- For store-served views the store *is* the truth right after Cockpit's own PUT (update the store in the same code path). The overlay then matters only for search-served views.
- Shrink the overlay only after the store is proven. Do not rip it out in the same phase.

**Checkbox rings:** keep today's body cache (stamp = `user_updated_time`) and feed it from the store's stamps.

**Open questions** (bring them to Slava as concrete examples, the check-in pattern that worked on the 2.5 drop rule):
1. Persist the store across restarts, or rebuild each launch? Recommendation: rebuild in 2.7 (simpler); persist in a follow-up if the startup walk shows on huge collections.
2. Mirror tags (`note_tags`) so `tag:` filters are local too? Recommendation: not in 2.7. The search stays the engine for anything typed.
3. Mobile: does `events` exist and behave there? If not, mobile keeps 2.6.3's paths. Guard it, don't fork it.
4. Keep the Notes cap at 1,000 until a virtualised list exists (2.8)? Recommendation: yes.

---

## 6. Phases and gates

Each phase ends with: harness green, a reviewer pass (plain-text report; a verdict of ISSUES *only* for a MUST-FIX item), and a local commit. Push only after Slava tests and approves.

0. **Design check-in with Slava** (section 5 questions, with examples). No code before this.
1. **Probe spike** (e2e only, no product code). **Done 2026-09-30:** 6 of 6 passed in 1.8 min. The findings are in section 4 and the DEVLOG. It proved:
   - `joplin.data.get(['events'])` works from a plugin;
   - cursor semantics;
   - sync-applied changes appear (two profiles and a file-system sync target);
   - trash and restore look like updates;
   - the 90-day/processed pruning cannot drop unseen rows while Cockpit runs (by the source rule, with a snapshot of the live markers);
   - behaviour on mobile: not reachable by the harness, so it is guarded, not proven.

   The spec is `e2e/events-probe.spec.ts`; the probe plugin is `e2e/fixtures/events-probe/` (plain JS, loaded through `plugins.devPluginPaths`, without Cockpit). It is opt-in with `COCKPIT_PROBE=1`:

   ```bash
   COCKPIT_PROBE=1 xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test e2e/events-probe.spec.ts --retries=0 --global-timeout=2700000
   ```

   It writes its raw observations to `e2e/.profiles/events-probe-findings.json`.
2. **`NoteStore` + harness mocks.** Add `['events']` to `test/harness.js`, driven by a fixture change log. Unit checks: build, create/update/delete/trash replay, cursor loss triggering a rebuild, dedupe across pages. **Done 2026-09-30** (commit 065fa38, 538 harness checks): `src/core/noteStore.ts` (driver) and `src/core/noteStoreModel.js` (pure model), built after the first paint, read by nothing yet.
   - **The lost-note rule:** a build whose replay removes a note the walk had read is not trusted (the listing is paged by offset, so the walk may have stepped over the note at the next page boundary); it ends not ready and the next trigger walks again.
   - **The tick arms no follow-up:** the follow-up poll exists for saves, whose feed row lands after the save returns; a tick is tied to none, so an idle tick costs exactly one `events` call.
3. **Read paths on the store** for unfiltered views, with search paths unchanged. Re-run the perf spec (targets below) and the full e2e. **Done 2026-09-30** (harness 564 checks; the eight-spec e2e subset 41 of 41; the perf spec at 20,000 notes: first paint 9.1 s against the record's 8.5 s with a sampler step of about 2.3 s, main-window lag 2.12 s over a 180 s window against 1.8 s over 150 s, the same 12 ms per second, no stall over 1 s with a maximum of 0.60 s, per idle tick exactly one `events` call and one notebook-map page with no search, listing or read by id, and the build walk invisible in the probes, so `walkPagePauseMs` stays 0; the store's memory is still the Node estimate of about 7 MB, not an in-app reading. The release gate reruns the perf spec with `PERF_WINDOW_MS=150000` for a like-for-like lag figure and adds the plugin renderer's heap before and after the build to the instrument handle):
   - **Reads** (`src/core/joplin.ts`, `readStoreTodos` / `readStoreNotes`): once the store is ready, a view with no profile criteria, nothing typed and no `any:1` is computed from the mirror with no search, no listing and no read by id. The notebook filter counts as local: `formats.ts` passes the view's criteria *before* its `notebook:"…"` clause and the notebook's id set (`opts.storeView`). Narrowing, exclusions and the notebook set all apply before the Notes cap counts. Before the store is ready, or when it is off, every read takes its 2.6.3 path unchanged.
   - **Order:** to-dos by `todo_due`, then id (the search's own `todo_due` order is unreliable in 3.6.14, and `getTodos` re-sorts by due and title anyway); notes by `user_updated_time` DESC, then id DESC, which is the listing's own SQL order, so the cap keeps what 2.6.3 kept.
   - **Caches:** store answers go into the same result caches under a key naming the store's revision; entries of an older revision are dropped. An optimistic repaint that misses (every own write moves the revision) takes its rings from the cache and reads no body. When readiness drops, every cached result is dropped, so a 2.6.3 entry from before the takeover is never served again.
   - **Renders** (`src/core/timer.ts`): the store notifies once per burst of runs that changed it, and that schedules ONE fast render; an unchanged drain renders nothing. The reconcile lane drains the store before each of its renders (one `events` call; it starts no build, though a ready store's drain past the rebuild threshold rebuilds inside it), because app commands such as `moveToFolder` write after their dialog closes and Joplin's `onNoteChange` fires only for the selected note. So do the truth renders (the profile switch's truth refresh, a notebook-filter change), for outside writers such as REST and MCP. Such a drain drops the store render its own notification armed, so a fast render cannot paint cached rings over the full one.
   - **Own writes** (`src/ui/panel/panel.ts`): moves, type flips, creates and trashes made through `joplin.data` update the store at once and arm the follow-up. A trash applied while a build runs leaves that build untrusted. The desktop Delete (`deleteNote`) reads the note back and removes it only when it is trashed or Not Found; a notebook trash and `duplicateNote` poll a ready store before their repaint, and the follow-up repaints a row that lands late.
   - **Measuring:** `instrument.ts` keeps a per-tick record of data calls (also counting the notebook map's folder pages), published as `CockpitInstrument` in the plugin's window; the perf spec reads it into `dataCallsPerTick`. `walkPagePauseMs` in `noteStore.ts` is the one place to space out the build's walk, and is 0.
4. **Refresh triggers:** make the tick and `onSyncComplete`/`onNoteChange` go through `events`. Remove the listing walks from the refresh path. **Done 2026-09-30** (harness 580 checks, 16 new in "note store triggers", 2 phase 3 checks retargeted; the verifier's e2e runs, 41 of 41 including `e2e/store-freshness.spec.ts`, before the review fixes below: the open to-do's REST flip in its new section after 309 ms, a REST rename 967 ms, trash 943 ms, create 993 ms with the tick at 1 s):
   - **One predicate** (`allConsumersStoreServed` in `src/core/timer.ts`, published as `CockpitTriggers`): the store serves every view Cockpit draws - the panel's current one (profile criteria plus the committed search text, whatever the format; the calendar formats build their criteria the same way) and each overview note's profile. It asks `storeServes` in `joplin.ts`, now exported, on the string `viewCriteria` builds, which `formats.ts` now uses too, so a trigger and a read cannot disagree. The notebook filter plays no part. Store not ready or off: false, with no setting read.
   - **All store-served, a note change** is the store's debounced poll (250 ms) and its follow-up, plus the overview debounce: no `reconcileExternalNoteChange`, no reconcile ladder. The settings-note and overview-note early returns are unchanged. **Not during a sync:** the store's poll and the tick's both wait for the sync's end, so a note change mid-sync takes phase 3's path, whose ladder rungs drain the store (`catchUpNoteStore`) and show the change at the 1 s rung.
   - **All store-served, a sync** is the fast render for the button, the settings note's read, the overview debounce and one poll: no ladder.
   - **The store render** (the drain's notification) is the fast render, as in phase 3, while any view is search-served; when all are store-served a drain's render is followed by a ring fill, because no ladder comes after it to read the rings of the notes that changed (a checkbox ticked inside a note shows on its ring within the second, as before). That fill reads the changed rings only (`ringsChangedOnly`): a ring read before whose note changed, and the ring of every note the burst's drains fetched by id, which covers a note new to the mirror (created in the editor, by another plugin, over REST, or synced in) whose ring was never read. Any other never-read ring counts as deferred and is the tick's, as in phase 3. The store tells its listeners `{ built, rebuilt, fetched }`: only the build that makes the store ready (runOnce's) is `built`, and its news gets no fill at all, so the startup backlog is the ticks'; a ready store's rebuild (a drain of more than 200 notes) is `rebuilt` and takes the plain fill, at most 300 rings per list, as phase 3's first rung read.
   - **The predicate** treats a throwing setting read as "not all served", so every trigger falls back to its 2.6.3 path instead of rejecting.
   - **The tick** polls FIRST when all are store-served. If its drain changed the store, it takes back the store render the drain armed and runs ONE `refreshInterfaces` (the change reaches the overview notes in the same tick). Otherwise it redraws only when a **redraw stamp** no longer holds. Two stamps, the panel's (recorded by `refreshPanelData` for a complete render only: not fast, not optimistic, not a fill the 300-body cap cut short) and the overview notes' (a pass over all of them). A stamp holds the store's revision, the local date and time zone, for the month calendar the count of past-due to-dos, the notebook map's and the tag list's generations (`joplin.ts`: neither writes a feed row), the profiles, and whether the optimistic layer was empty both when the stamp was taken and when the drawing finished (an entry merged into a render may run out before it ends). Only a render that can finish complete takes a stamp at all. An idle minute is one `events` call, the notebook map's and the tag list's pages once their 20 s caches lapse, and no render.
   - **Decisions.** (1) The brief's "revision or day rollover" alone would be an approximation, so it was not shipped: the month calendar's dots turn overdue at each due time, a notebook renamed or deleted off the folder poll's 20-row page and a new tag (the search field's autocomplete) reached the panel only through the tick, a held optimistic entry expires on its own clock, and rings beyond the 300-body cap fill in "on following refreshes"; each is in the stamp or forces a draw. (2) The day is local midnight, not the day-start setting: `horizons.js`, the completed buckets and the calendars' today all use midnight; the day-start time only places a dropped to-do. (3) The idle tick still reads the tag list (one page, now counted as `tags` in the instrument), which every tick already did through the render. (4) The panel's own actions (tick, create, move, flip, trash, drop) and `onNoteAlarmTrigger` still arm the reconcile ladder, whose rungs drain the store before rendering; that is phase 5's overlay and reconcile work.
   - **Listing walks:** `listAllNotes`, `listRecentNotes` and `preferTodoListing` stay as the fallback; a check drives a whole store-served session (build, ticks, a note change, a sync, a day rollover) and finds no search and no listing page but the build's walk.
   - **Instrument:** `countRender`/`countPaint`, and each tick record now carries `tags`, `renders` (markup computed) and `paints` (setHtml). The handle's shape is unchanged apart from the added fields.
   - **Retargeted checks:** the phase 3 "drain arms ONE fast render" check (its render now also reads the changed note's body, and the tick after it none); "is_todo flips ... next render" (the tick draws its drain, no store render is left armed). The first pass had also moved "a checkbox tick's optimistic repaint reads no body" to 650 + 650 rows; with the build's render filling nothing it is back to its phase 3 form.
   - **Review pass (2026-09-30):** one must-fix (the mid-sync note change above) and five should-fixes, all applied: the build's render skips the fill and a drain's fill reads only changed warm rings; the freshness spec asserts `CockpitTriggers.allConsumersStoreServed()` next to its readiness wait; pins for a fast render leaving the tick owing a draw, for an optimistic entry running out mid-render, and for a throwing predicate. Perf before the fill fix: first paint 8.67 s, main-window lag 2.40 s over 150 s against the 1.8 s target (phase 3: 2.12 s over 180 s), no stall over 1 s, maximum gap 0.71 s; the one new spike was the post-build fill (600 never-read rings at once, a 644 ms probe at t = 18 s), which this pass removes.
   - **Second review pass (2026-09-30):** two regressions of the changed-only fill fixed. A note new to the mirror got no ring until the next tick (its ring had never been read), and after a sync of more than 200 notes the changed rings waited for the tick (the rebuild inside a ready store's poll was reported as the build). Both are pinned: a to-do created mid-session with `- [x] a`, `- [ ] b`, `- [ ] c` shows 1/3 on its drain's render, and a drain that rebuilds shows note 1's changed first box as 1/2. Measured after the first pass's fill fix, before these two: first paint 8.78 s, main-window lag 1.795 s over 150 s (target 1.8 s), no stall over 1 s (maximum gap 0.555 s), process-tree RSS peak 2,061 MB, main-window heap 190 MB, the post-build spike gone; the freshness spec 4 of 4 (flip 363 ms, rename 1,016 ms, trash 959 ms, create 965 ms).
5. **Optimistic/reconcile simplification** for store-served views only, and only where the tests prove equivalence. This is the riskiest phase: the overlay has absorbed many edge cases (type flips, trash, cross-view keys; see the "type flip" and "reconcile" sections of `test/run.js`).
   - **Entry item, from phase 4:** completion overrides are no longer cleared on an external trash or type flip when every view is store-served (Joplin's `changeNoteType` resets `todo_completed` and `todo_due` on every flip). A to-do ticked in Cockpit, hidden by the view, then flipped away and back in the editor within 60 s draws ticked until the override's TTL. Write store-served twins of the two 2.6.x override checks in `test/run.js` ("type flip (external, ticked to-do)" and "trash (external, ticked to-do)", around lines 4946 and 4986). Interim fallback: `clearTodoCompletionOverride` for each id a drain removed or fetched with `is_todo` 0.

   **Done 2026-09-30** (Fable review OK, no must-fix, at 604 checks; the eleven-spec e2e subset 69 of 69; then one review pass, harness 606 checks, 26 new in "note store actions", 2 phase 4 checks retargeted):
   - **The gate** (`storeServesAction` in `src/core/timer.ts`, published on `CockpitTriggers` with `optimisticHeld` for the harness): `allConsumersStoreServed()` and no sync running - the phase 4 predicate with its mid-sync rule, and the note-change trigger now asks the same function. It costs one host read (`currentProfileID`; the profiles are in memory). An action asks it at its start (`startOwnWrite`, which on the store path also drops any override or overlay entry of the ids the action is about to write, a leftover from a searched view that would otherwise be merged over the store's truth). The `afterOwnWrite` actions ask it twice (start, after the repaint); the `showOwnWrite` actions four times (start, before the render, between its fast pass and its fill, after the fill). Off the gate, every action runs exactly its 2.6.3/phase 4 code.
   - **The store path:** the write goes to Joplin as before and into the store in the same code path (already there for every write); no overlay entry, no completion override, no `scheduleReconcile`. The actions that fed the overlay (tick, type flip single and batch, create and create-in-folder) render through `showOwnWrite` in `panel.ts`: a fast render from the store (no body read, as quick as the optimistic repaint it replaces) and a fill of the written notes' rings. The rest keep their `refreshInterfaces` and lose only the ladder (`afterOwnWrite` in `timer.ts`, which first waits for the settle queue, since a duplicate, a trashed notebook and the native move drain the store before it): the data-API moves (the batch picker, the mobile overlay, the mobile single fallback), trashes (batch, mobile data API, desktop `deleteNote` with its read-back), duplicate, drag to a day, drop between rows, drop on a period heading, the alarm set and cleared (dialog, title bar, mobile overlay), tags, and the notebook actions (create, rename, move, trash, move under). A flip whose own read says the note is trashed (a stale row nothing has drained yet) takes it out of the store (`forgetTrashedRow`). The store's follow-up poll brings Joplin's own row, and a fetched record replaces the local write whole, so a flip's reset `todo_due`/`todo_completed` is what is drawn once it arrives.
   - **Own writes against a drain in flight** (`noteStore.ts`): a per-note write count, moved by `applyLocalWrite`, `applyLocalCreate` and `applyLocalRemoval`. A drain notes the count before each fetch by id and drops the answer when it moved meanwhile, so a fetch answered before the panel's own trash cannot put the note back; the note goes on a refetch list the next drain (the follow-up the write armed) fetches whatever its rows say, since the write's own feed row may already be in the page the dropped fetch came from. No clock is involved.
   - **The fallback:** when the gate is gone before the render (a poll that failed while the write was out, a sync that started), the action takes its old path from there - the tick sets its override, the flip and the create write their entry, the optimistic repaint follows and the ladder is armed - with no render from the stale store in between; gone during the fast pass, the fill is skipped and the same follows; gone during the fill, the same follows it.
   - **Joplin's own `moveToFolder`** (desktop: the notebook pill's right click and the single context-menu move, `runMoveCommand`) is the one panel action that keeps the ladder on the store path. Cockpit never learns the target notebook, so there is nothing to write locally, and a read-back cannot tell a moved note from an open dialog. In 3.6.14 the command awaits its folder prompt (`showFolderPicker` → the window's `showPrompt`, resolved on close) and every `Note.moveToFolder` before `execute` answers, so phase 3's "writes after its dialog closes, after the command returned" does not hold there; the store drains once after the command (`pollStoreAfterAppWrite`, as for `duplicateNote`) and the move shows in the action's own render. The reviewer read 2.9.17 and 3.0.15: both ran the moves from the prompt's `onClose`, after `execute` had returned, so the ladder stays for the older apps Cockpit supports (2.9+).
   - **External changes (the entry item):** a drain lets go of the override and the overlay entry of every note it fetched by id or removed on a delete row (`settleDrained`; the store's news now carries `removed` beside `fetched`), and a build or a rebuild, which re-read every note, lets go of the whole layer (`clearAllOptimistic`) - only while the gate holds; while a view still reads the search, the layer is what covers it. Every render a drain leads to (the store render, the catch-up before a truth render or a rung, the tick's own, an own write's repaint after its drain) waits for that settle first. Nothing held costs no setting read.
   - **Behaviour note:** in a view that hides completed to-dos, a ticked row now leaves at once; on 2.6.3's search path it lingered, ticked, until the index caught up. Phase 4 already did this on store-served views.
   - **`optimistic.ts`:** one function added, `clearAllOptimistic` (for the build/rebuild settle); nothing else there changed or deleted. Unreachable on the store path now: `setTodoCompletionOverride`, `upsertOptimisticItem`, `removeOptimisticItem`, and `revalidateOptimisticInserts` while nothing is held; in `panel.ts`, `insertCreatedItemOptimistically`, `applyTypeFlipOptimistically`, `reconcileExternalNoteChange` (phase 4 already) and `noteMatchesView`/`completedBucketOf` behind them - each runs only on the fallback, which is off the store path by definition. Still called but inert when nothing is held: `applyTodoCompletionOverrides`, `mergeOptimisticTodos`/`mergeOptimisticNotes`, `finalizeOverlay`, `hasPendingItemOverlay`. Still live: `viewKeyFor` (every render's key), `hasPendingOptimistic` (the stamps, the settle, the ladder), `clearTodoCompletionOverride`, `clearOptimisticItem` and `clearAllOptimistic` (the settles). The ladder itself is reached on the store path only by the native move and `onNoteAlarmTrigger`.
   - **Retargeted:** "the tick still draws for what moves without a feed row - ... a held optimistic entry ..." and "an optimistic entry merged into a render that runs out before the render ends ..." now make their tick (and, in the second, the other device's untick) while a sync runs, since a store-path tick holds nothing and a store-path drain settles it.
   - **Proof:** each action runs three times on the same notes - store-served, today's path over the same store (a sync running), and the 2.6.3 search path with a live index - and compares every heading and row with its tick and its ring text: the first two must match exactly, and the search path too except the rings of the rows its overlay inserts, which it leaves empty until its next full render where the store draws them at once. The store run must hold nothing (watched at every settings read after its write), arm no rung and search nothing. Twenty-four mutations of the new code (the gate and each of its asks, each settle and each wait, the write count and the refetch list, the fallbacks, the move exception) each fail at least one check.
   - **Next pass:** a write-through cache for `currentProfileID`, so the gate costs no host read; a version gate for the native move's ladder, once the release that made `moveToFolder` await its prompt is known.
6. **Release gate:**
   - full harness;
   - full local e2e (on main);
   - CI green on the release SHA;
   - perf spec at 20k;
   - a Pixel round if mobile paths changed.

**Acceptance targets at 20k notes + 1k to-dos** (perf spec, 150 s window):
- first paint no worse than 2.6.3 (8.5 s after the UI is up);
- main-window lag ≤ 2.6.3 (1.8 s);
- no stall > 1 s;
- steady-state data calls per tick ≤ 1, stated as note-data calls (search, listing, get, bodies) plus the feed's one `events` poll; the notebook map's and the tag list's pages are 2.6.3 behaviour and counted separately;
- the store's memory reported.

On Slava's own collection (881 notes, 169 to-dos): no visible change except faster profile switches and immediate appearance of edited or synced items.

---

## 7. How to run the perf check

```bash
COCKPIT_PERF=1 PERF_NOTES=20000 xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test e2e/perf-large-vault.spec.ts --retries=0 --global-timeout=1800000
```

- **Seeding:** the first run seeds `e2e/.profiles/perf-template-20000` (115 MB, gitignored and MEGA-ignored). Seeding takes about 3.5 min, then about 8.5 min for Joplin's index. Later runs reuse the template, and each measured launch gets a fresh copy, so every plugin run is a first run.
- **`PERF_SKIP_BARE=1`:** skips the no-plugin baseline (already on record above).
- **`PERF_API=1`:** runs only the per-route timing test.
- **`PERF_WINDOW_MS`:** sets the measurement window.
- **`PERF_OUT=…`:** where the JSON report goes. It includes per-process RSS, the pages open and the main-window JS heap.
- **Caveat:** Cockpit is loaded as a *dev* plugin, which makes Joplin open a DevTools window. That inflates RSS, so compare runs with each other, not with a user's machine.
- **To try another cap:** edit `NOTES_BATCH` in a scratch build and `git checkout` afterwards.

---

## 8. Standing rules (from memory; they apply to every worker prompt)

- **Who codes:**
  - An Opus-class session does the coding and testing itself, without worker agents (Slava, 2026-09-29).
  - A Fable manager session delegates coding to Opus-class workers with self-contained prompts, and reviews their results.
  - Workers may build and copy the `.jpl` into `~/.config/joplin-desktop/plugins/`. The Joplin restart and the live check are Slava's.
- **Publishing needs Slava's explicit approval, per release.** Green tests, CI, or a task notification authorize nothing. The end state of a release-shaped task is: built, installed, stop and report.
- **Release procedure:**
  - version in four places (package.json, src/manifest.json, both package-lock fields), plus the harness pin in `test/run.js`;
  - `npm test` → local e2e → push → CI Tests green on that SHA → `npm run dist`;
  - `gh release create vX.Y.Z publish/io.github.pmslava.cockpit.jpl --repo pmslava/joplin-plugin-cockpit --target main`;
  - never run `npm publish` by hand (OIDC via `publish.yml`);
  - verify with `npm view joplin-plugin-cockpit version`;
  - **always** pass `--repo`, because an upstream Agenda remote exists.
- **e2e discipline:**
  - one run machine-wide, across sibling repos too: `pgrep -fa e2e-cache | grep -v pgrep` must be empty;
  - `free -g` must show ≥ 4 GB available;
  - `E2E_LOCK_WAIT_MS=1800000`;
  - implementers never run e2e; the verifier runs a targeted subset, and the full suite runs on main as the gate;
  - a background wrapper's exit code is not Playwright's, so write `$?` into the log and read it.
- **Sandbox proxy:** every `joplin.*` chain must be one uninterrupted read-and-call. A structural audit in `test/run.js` enforces this, and `joplin.data.get(['events'], …)` is fine.
- **MEGA sync:** it two-way syncs `~/Lab`. Do heavy npm or extraction work outside `~/Lab`, and check that `node_modules` is intact before trusting it.
- **Commit subjects** never contain `#word`. Reviewer and verifier agents report in plain text, never through structured-output schemas. Use one warm worktree per work-arc, with `node_modules` and `.e2e-cache` symlinked to the main checkout.
- **Announcements:** only for things users should *try*. 2.7 is a speed release, so GitHub notes may be enough. Ask Slava.

---

## 9. Loose ends from 2.6.3

- **Forum:** plutoBase is waiting. Slava promised a post in both threads when the fix is out. Follow-up texts for both threads were printed in the 2.6.3 session for Slava to post himself; ask whether he posted them.
- **Remaining freeze risks** (from the DEVLOG): a *typed* search matching tens of thousands of to-dos still pages the search to the end, and a profile showing thousands of to-dos still draws them all. The store fixes the first for unfiltered views only; the drawing is 2.8.
- **Memory:** Slava's Joplin was 1.77 GB PSS with 20 plugins. Two renderers of about 420 MB and 310 MB have not been attributed. Attaching Joplin's DevTools, or measuring with plugins disabled one at a time, would show which is which, if anyone cares.
