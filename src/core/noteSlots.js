/** README ******************************************************************************************************************************************
 * Pure rules for NOTES ON DATES (2.11): the days a regular note is drawn on when its profile shows notes on the day they were created and/or       *
 * on the day they were last updated, and how a format's groups take those notes in among their to-dos.                                             *
 *                                                                                                                                                  *
 * THE SLOT. A note's timestamp is its PSEUDO-DUE: a format puts a note where it would put a to-do due at that very instant - the interval view     *
 * under horizonOf, the date view under that day's heading, the calendars on that local day. So a slot is shaped like the to-do every format        *
 * already knows how to place and label ({ id, title, todo_due }), and carries the note itself beside it for the row. Each switch gives the note    *
 * one slot; with both on, a note created and last updated on the same local day keeps ONE (the created one - the update adds no day), and a note   *
 * whose two days differ keeps both, so it is drawn twice, once on each day. A timestamp that is not a positive number gives no slot; Joplin        *
 * never writes one, and the optimistic records stamp both.                                                                                         *
 *                                                                                                                                                  *
 * THE MERGE. A list format's to-do groups arrive in drawing order: chronological, with the undated group first, or last when the profile moves     *
 * it to the end. The notes' groups (the slots grouped by the same heading rule) are folded in: a group the to-dos also have takes the notes, and   *
 * a group only notes have goes where its time puts it, before the first dated to-do group that starts later. The groups are slices of time         *
 * that never overlap (a horizon, a day), so any instant inside a group orders it against the others.                                               *
 *                                                                                                                                                  *
 * API                                                                                                                                              *
 *   noteSlots(notes, onCreated, onUpdated)           - the slots, ascending by todo_due; slots at the same instant keep the notes' own order.      *
 *   dayKeyOf(ms)                                     - the local 'YYYY-MM-DD' of an instant (the calendars' day key).                              *
 *   slotsByDay(slots)                                - a Map from dayKeyOf to that day's slots, each day in slot order.                            *
 *   mergeGroups(todoGroups, noteGroups, undatedLast) - [{ key, heading, todos, notes }] in drawing order. todoGroups are { key, heading, todos },  *
 *                                                      noteGroups { key, heading, slots }, both in their own order; a to-do group with no dated    *
 *                                                      to-do is the undated one, and undatedLast says where it stands.                             *
 *   placeRows(todoRows, noteRows, position)          - one group's rows: the notes' first for 'before', after the to-dos' otherwise.               *
 *                                                                                                                                                  *
 * The very same file is require()d by the Node test harness (module.exports below) and bundled into the host by webpack (require("./noteSlots")    *
 * in formats.ts), so the rules are unit-tested AND drive the real panel.                                                                           *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.CockpitNoteSlots = api                  // harmless webview export (unused there)
    else if (root) root.CockpitNoteSlots = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    /** dayKeyOf ************************************************************************************************************************************
     * The local calendar day of an instant as 'YYYY-MM-DD'. toISOString would convert to UTC first and so can name the wrong day.                  *
     ***********************************************************************************************************************************************/
    function dayKeyOf(ms){
        var date = new Date(ms)
        var pad = function(value){ return String(value).padStart(2, '0') }
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    // A timestamp a slot can stand on: a positive, finite number of milliseconds, else null.
    function stamp(value){
        var ms = Number(value)
        return Number.isFinite(ms) && ms > 0 ? ms : null
    }

    function slotOf(note, at){
        return { id: note.id, title: note.title, todo_due: at, note: note }
    }

    /** noteSlots ***********************************************************************************************************************************
     * The slots of the given notes under the profile's two switches, earliest first. The sort is stable, so two slots at the same millisecond      *
     * keep the order the notes came in (the Notes section's own order), and a note's two slots can never swap.                                     *
     ***********************************************************************************************************************************************/
    function noteSlots(notes, onCreated, onUpdated){
        var slots = []
        if (!notes || (!onCreated && !onUpdated)) return slots
        for (var index = 0; index < notes.length; index++){
            var note = notes[index]
            if (!note) continue
            var created = onCreated ? stamp(note.user_created_time) : null
            var updated = onUpdated ? stamp(note.user_updated_time) : null
            if (created !== null) slots.push(slotOf(note, created))
            // The update adds a slot only when it adds a day: the same day as the created slot is already drawn.
            if (updated !== null && (created === null || dayKeyOf(updated) !== dayKeyOf(created))) slots.push(slotOf(note, updated))
        }
        return slots
            .map(function(slot, at){ return { slot: slot, at: at } })
            .sort(function(first, second){ return (first.slot.todo_due - second.slot.todo_due) || (first.at - second.at) })
            .map(function(entry){ return entry.slot })
    }

    /** slotsByDay **********************************************************************************************************************************
     * The calendars' view of the slots: each local day's slots, in slot order (so a day's notes read earliest first).                              *
     ***********************************************************************************************************************************************/
    function slotsByDay(slots){
        var byDay = new Map()
        for (var index = 0; index < (slots || []).length; index++){
            var key = dayKeyOf(slots[index].todo_due)
            if (!byDay.has(key)) byDay.set(key, [])
            byDay.get(key).push(slots[index])
        }
        return byDay
    }

    // The earliest due of a group's dated to-dos, or null for the undated group (every due 0).
    function startOfTodos(todos){
        var start = null
        for (var index = 0; index < (todos || []).length; index++){
            var due = stamp(todos[index].todo_due)
            if (due !== null && (start === null || due < start)) start = due
        }
        return start
    }

    /** mergeGroups *********************************************************************************************************************************
     * The list's groups with the notes folded in (see THE MERGE above). A note-only group that starts after every dated to-do group goes           *
     * after the last of them: before the undated group when that one is drawn last, at the very end otherwise.                                     *
     ***********************************************************************************************************************************************/
    function mergeGroups(todoGroups, noteGroups, undatedLast){
        var notesByKey = new Map()
        for (var noteGroup of noteGroups || []) notesByKey.set(noteGroup.key, noteGroup)
        var todoKeys = new Set((todoGroups || []).map(function(group){ return group.key }))
        var noteOnly = (noteGroups || [])
            .filter(function(group){ return !todoKeys.has(group.key) })
            .map(function(group){
                return { key: group.key, heading: group.heading, todos: [], notes: group.slots, start: group.slots.length ? group.slots[0].todo_due : 0 }
            })
            .sort(function(first, second){ return first.start - second.start })
        var merged = []
        var next = 0
        var undated = null
        for (var group of todoGroups || []){
            var start = startOfTodos(group.todos)
            var notes = notesByKey.has(group.key) ? notesByKey.get(group.key).slots : []
            var entry = { key: group.key, heading: group.heading, todos: group.todos, notes: notes }
            if (start === null){
                // The undated group: drawn first, it stays first; drawn last, it waits until every dated group has been placed.
                if (undatedLast){ undated = entry; continue }
            } else {
                while (next < noteOnly.length && noteOnly[next].start < start) merged.push(withoutStart(noteOnly[next++]))
            }
            merged.push(entry)
        }
        while (next < noteOnly.length) merged.push(withoutStart(noteOnly[next++]))
        if (undated) merged.push(undated)
        return merged
    }

    function withoutStart(group){
        return { key: group.key, heading: group.heading, todos: group.todos, notes: group.notes }
    }

    /** placeRows ***********************************************************************************************************************************
     * Where a group's note rows go against its to-do rows: the profile's "Show notes [Before/After todos]", applied inside each group.             *
     ***********************************************************************************************************************************************/
    function placeRows(todoRows, noteRows, position){
        return position === 'before' ? noteRows + todoRows : todoRows + noteRows
    }

    return {
        noteSlots: noteSlots,
        dayKeyOf: dayKeyOf,
        slotsByDay: slotsByDay,
        mergeGroups: mergeGroups,
        placeRows: placeRows,
    }
})
