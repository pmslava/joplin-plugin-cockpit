/** README ******************************************************************************************************************************************
 * THE NOTE STORE'S MODEL (2.7) - the pure half of Cockpit's local mirror of every note's metadata. The driver (src/core/noteStore.ts) builds it    *
 * once from the GET /notes listing and keeps it exact from Joplin's change feed; everything that decides WHAT the mirror holds lives here, with no *
 * joplin, no timers and no I/O, so every rule is unit-tested on its own.                                                                           *
 *                                                                                                                                                  *
 * A RECORD holds eight fields: id, title, is_todo, todo_completed, todo_due, parent_id, user_updated_time, user_created_time. Numbers are made     *
 * numbers (is_todo exactly 0 or 1, a missing or junk value 0) and the two strings strings, so a record read from the listing, one fetched by id    *
 * and one merged from a local write compare equal field by field when they describe the same note. That equality is what lets the model tell a     *
 * real change from a repeat - the follow-up poll re-fetching a note Cockpit itself just wrote is the common repeat - and bump the revision only    *
 * for the first.                                                                                                                                   *
 *                                                                                                                                                  *
 * A RECORD NEVER HOLDS A NOTE THAT IS GONE: trashed (deleted_time > 0), a conflict copy (is_conflict), or no longer there at all. The listing      *
 * already leaves the first two out, but the model drops them itself as well (belt and braces, as 2.6.3's listing path does), and a fetch by id -   *
 * which DOES return trashed notes and conflicts - removes the record instead of storing it.                                                        *
 *                                                                                                                                                  *
 * THE FEED'S RULES (phase 0 read them out of the 3.6.14 bundle, phase 1 ran them). The item_changes table keeps ONE row per note, the latest, so a *
 * note created and then edited since the cursor arrives as a single update, and one created and then deleted as a single delete of an id the store *
 * never had. Create and update are therefore one upsert, and a delete of an unknown id is nothing. A drain that spans several pages can still see  *
 * the same note twice (its row was replaced by a later one between two page reads), so the later row wins.                                         *
 *                                                                                                                                                  *
 * THE REVISION rises by one on every change to what the model holds, and on nothing else: a repeat upsert, a merge that writes the values already  *
 * there, a removal of an unknown id and a rebuild that finds exactly what was there leave it alone. Phase 3 caches per revision.                   *
 *                                                                                                                                                  *
 * API (all methods of the object createNoteStoreModel() returns)                                                                                   *
 *   beginBuild() / addListingPage(items) / endBuild() - a full build into a staging map: pages deduplicated by id (the later copy wins), gone rows *
 *                                       dropped. endBuild swaps the staging map in and says whether that changed anything. abandonBuild() drops a  *
 *                                       staging map a failed walk left behind.                                                                     *
 *   applyFetched(note, id)            - applies one note fetched by id: an upsert, or a removal when it is gone or null (the fetch answered Not    *
 *                                       Found). Answers 'added', 'updated', 'removed' or 'unchanged'.                                              *
 *   remove(id)                        - removes a record; true when there was one.                                                                 *
 *   applyLocalWrite(id, fields)       - merges the record fields among `fields` into a record the model already holds (an unknown id is ignored:   *
 *                                       the feed will bring it). A write that trashes the note removes it. True when something changed.            *
 *   planDrain(rows, threshold)        - turns a drained list of feed rows into { fetch, remove, rebuild }: the distinct note ids to fetch (created *
 *                                       or updated), the known ids to remove (deleted), and whether the fetches exceed the threshold.              *
 *   get(id) / snapshot() / size()     - one record, every record, the count. Reads hand out COPIES, so no caller can change the                    *
 *                                       mirror by accident.                                                                                        *
 *   todos() / notes()                 - every record split by is_todo, unfiltered and unsorted (phase 3 narrows them).                             *
 *   revision                          - the read-only change counter.                                                                              *
 *                                                                                                                                                  *
 * Dependency-free on purpose, exactly like horizons.js, between.js and settingsNote.js: the very same file is require()d by the Node test harness  *
 * (module.exports below) and bundled into the host by webpack (require("./noteStoreModel") in noteStore.ts).                                       *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require) and webpack
    if (typeof window !== 'undefined') window.CockpitNoteStoreModel = api             // harmless webview export (unused there)
    else if (root) root.CockpitNoteStoreModel = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    var RECORD_FIELDS = ['id', 'title', 'is_todo', 'todo_completed', 'todo_due', 'parent_id', 'user_updated_time', 'user_created_time']
    // Everything a write can change: every field but the id.
    var WRITABLE_FIELDS = RECORD_FIELDS.slice(1)

    // item_changes.type, and the item_type a note's rows carry. The feed is note-only today (phase 0: Note.save and Note.batchDelete are its only
    // writers), but a row of any other kind is skipped rather than trusted, should that ever change.
    var CHANGE_CREATE = 1
    var CHANGE_UPDATE = 2
    var CHANGE_DELETE = 3
    var ITEM_TYPE_NOTE = 1

    /** Whether a note is one the mirror must not hold: trashed, or a conflict copy. */
    function isGone(note){
        var conflict = note.is_conflict
        return Number(note.deleted_time) > 0 || conflict === true || Number(conflict) > 0
    }

    /** The record for a note, every field normalised (see the README). */
    function toRecord(note, id){
        return {
            id: String(id),
            title: note.title === undefined || note.title === null ? '' : String(note.title),
            is_todo: Number(note.is_todo) ? 1 : 0,
            todo_completed: Number(note.todo_completed) || 0,
            todo_due: Number(note.todo_due) || 0,
            parent_id: note.parent_id ? String(note.parent_id) : '',
            user_updated_time: Number(note.user_updated_time) || 0,
            user_created_time: Number(note.user_created_time) || 0,
        }
    }

    function sameRecord(first, second){
        for (var index = 0; index < RECORD_FIELDS.length; index++){
            if (first[RECORD_FIELDS[index]] !== second[RECORD_FIELDS[index]]) return false
        }
        return true
    }

    function copyRecord(record){
        return Object.assign({}, record)
    }

    /** A record with the writable fields among `fields` laid over it, normalised like any other. */
    function mergeRecord(record, fields){
        var merged = copyRecord(record)
        for (var index = 0; index < WRITABLE_FIELDS.length; index++){
            if (WRITABLE_FIELDS[index] in fields) merged[WRITABLE_FIELDS[index]] = fields[WRITABLE_FIELDS[index]]
        }
        return toRecord(merged, record.id)
    }

    function hasId(value){
        return value !== undefined && value !== null && value !== ''
    }

    /** createNoteStoreModel ****************************************************************************************************************************
     * A fresh, empty model. The driver holds exactly one for the session.                                                                              *
     ***************************************************************************************************************************************************/
    function createNoteStoreModel(){
        var records = new Map()
        // The map a build is filling, or null outside a build. Swapped in whole by endBuild, so a walk that fails half way leaves the previous
        // contents untouched rather than half of a new set.
        var staging = null
        var revision = 0

        function upsert(id, record){
            var existing = records.get(id)
            if (existing && sameRecord(existing, record)) return 'unchanged'
            records.set(id, record)
            revision++
            return existing ? 'updated' : 'added'
        }

        function drop(id){
            if (!records.has(id)) return false
            records.delete(id)
            revision++
            return true
        }

        function pick(predicate){
            var out = []
            records.forEach(function(record){ if (predicate(record)) out.push(copyRecord(record)) })
            return out
        }

        return {
            get revision(){ return revision },

            beginBuild: function(){
                staging = new Map()
            },

            addListingPage: function(items){
                if (!staging) return
                var list = items || []
                for (var index = 0; index < list.length; index++){
                    var item = list[index]
                    if (!item || !hasId(item.id)) continue
                    var id = String(item.id)
                    // A note can come back on two pages when a create shifted the listing between them; the later copy is the fresher read.
                    if (isGone(item)) staging.delete(id)
                    else staging.set(id, toRecord(item, id))
                }
            },

            endBuild: function(){
                if (!staging) return false
                var built = staging
                staging = null
                var changed = built.size !== records.size
                if (!changed){
                    built.forEach(function(record, id){
                        var existing = records.get(id)
                        if (!existing || !sameRecord(existing, record)) changed = true
                    })
                }
                if (changed){
                    records = built
                    revision++
                }
                return changed
            },

            abandonBuild: function(){
                staging = null
            },

            applyFetched: function(note, id){
                var key = String(hasId(id) ? id : note && note.id)
                if (!note || isGone(note)) return drop(key) ? 'removed' : 'unchanged'
                return upsert(key, toRecord(note, key))
            },

            remove: function(id){
                return drop(String(id))
            },

            applyLocalWrite: function(id, fields){
                if (!fields || typeof fields !== 'object') return false
                var key = String(id)
                if (isGone(fields)){
                    if (staging) staging.delete(key)
                    return drop(key)
                }
                // A build in flight gets the write too, so a page read before the write cannot bring the old values back when it is swapped in.
                if (staging && staging.has(key)) staging.set(key, mergeRecord(staging.get(key), fields))
                var existing = records.get(key)
                if (!existing) return false
                return upsert(key, mergeRecord(existing, fields)) !== 'unchanged'
            },

            planDrain: function(rows, threshold){
                // Last type per note id, in the order of each id's LAST row: delete-then-insert keeps a re-appearing id at its later position.
                var latest = new Map()
                var list = rows || []
                for (var index = 0; index < list.length; index++){
                    var row = list[index]
                    if (!row || Number(row.item_type) !== ITEM_TYPE_NOTE || !hasId(row.item_id)) continue
                    var type = Number(row.type)
                    if (type !== CHANGE_CREATE && type !== CHANGE_UPDATE && type !== CHANGE_DELETE) continue
                    var id = String(row.item_id)
                    latest.delete(id)
                    latest.set(id, type)
                }
                var fetch = []
                var remove = []
                latest.forEach(function(type, id){
                    if (type !== CHANGE_DELETE) fetch.push(id)
                    else if (records.has(id)) remove.push(id)
                })
                return { fetch: fetch, remove: remove, rebuild: threshold > 0 && fetch.length > threshold }
            },

            get: function(id){
                var record = records.get(String(id))
                return record ? copyRecord(record) : undefined
            },

            snapshot: function(){
                return pick(function(){ return true })
            },

            size: function(){
                return records.size
            },

            todos: function(){
                return pick(function(record){ return record.is_todo === 1 })
            },

            notes: function(){
                return pick(function(record){ return record.is_todo !== 1 })
            },
        }
    }

    return {
        RECORD_FIELDS: RECORD_FIELDS,
        createNoteStoreModel: createNoteStoreModel,
    }
})
