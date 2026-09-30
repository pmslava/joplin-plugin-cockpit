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
2. **`NoteStore` + harness mocks.** Add `['events']` to `test/harness.js`, driven by a fixture change log. Unit checks: build, create/update/delete/trash replay, cursor loss triggering a rebuild, dedupe across pages.
3. **Read paths on the store** for unfiltered views, with search paths unchanged. Re-run the perf spec (targets below) and the full e2e.
4. **Refresh triggers:** make the tick and `onSyncComplete`/`onNoteChange` go through `events`. Remove the listing walks from the refresh path.
5. **Optimistic/reconcile simplification** for store-served views only, and only where the tests prove equivalence. This is the riskiest phase: the overlay has absorbed many edge cases (type flips, trash, cross-view keys; see the "type flip" and "reconcile" sections of `test/run.js`).
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
- steady-state data calls per tick ≤ 1;
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
