/** README *****************************************************************************************************************************************
 * This file handles misc calls to the joplin plugin api                                                                                           *
 **************************************************************************************************************************************************/

/* Imports *****************************************************************************************************************************************/
import joplin from 'api';

/** getTodos ****************************************************************************************************************************************
 * Returns the list of todos, sorted by due date. If show completed is true, it will include completed todos. If show no due is true, it will       *
 * include todos without due dates.                                                                                                                 *
 ***************************************************************************************************************************************************/
 export async function getTodos(showCompleted, showNoDue, searchCritera){
    const completed = showCompleted ? "" : "iscompleted:0"
    const noDue = showNoDue ? "" : "due:19700201"
    var allTodos = [];
    let pageNum = 1;
    do {
        var response = await joplin.data.get(['search'], {
            query: `type:todo ${completed} ${noDue} ${searchCritera}`,
            fields: ['id', 'title', 'todo_completed', 'todo_due', 'parent_id', 'user_updated_time', 'user_created_time'],
            type: 'note',
            order_by: 'todo_due',
            page: pageNum++,
        })
        allTodos = allTodos.concat(response.items)
    } while (response.has_more)
    await attachCheckboxCounts(allTodos)
    // The search only orders by due date, which leaves to-dos sharing a due date - and the whole
    // "No Due Date" group - in arbitrary order. Ties are broken by title, so that a naming scheme
    // gives a deliberate order. The comparison is case insensitive and number aware ("2" < "10").
    allTodos.sort((first, second) => {
        return (first.todo_due - second.todo_due)
            || String(first.title).localeCompare(String(second.title), undefined, { numeric: true, sensitivity: "base" })
    })
    return allTodos
}

/** searchTitleSuggestions **************************************************************************************************************************
 * Returns up to ten distinct note titles for the search field's title: autocomplete. Joplin's search wildcard is suffix only and quoting a phrase   *
 * with a trailing * is unreliable, so the query matches the LAST typed word with a suffix wildcard (title:word*) and the results are then filtered   *
 * case-insensitively against the whole typed partial. An empty partial (the bare "title:" state) has nothing to match on, so it returns the ten most  *
 * recently updated notes/to-dos instead, mirroring how tag:/notebook: list their whole set immediately after the colon.                             *
 ***************************************************************************************************************************************************/
export async function searchTitleSuggestions(partial){
    var typed = String(partial || "").trim()
    if (!typed) {
        // Bare "title:" with nothing typed yet: offer the most recently updated notes/to-dos so the
        // list appears immediately after the colon, the same way tag:/notebook: do. A single ['notes']
        // fetch ordered by updated_time covers both regular notes and to-dos.
        var recent = await joplin.data.get(['notes'], {
            fields: ['id', 'title'],
            order_by: 'updated_time',
            order_dir: 'DESC',
            limit: 10,
        })
        var recentTitles = []
        var recentSeen = new Set()
        for (var r of (recent.items || [])) {
            var recentTitle = String(r.title || "").trim()
            if (!recentTitle) continue                  // skip untitled notes (empty-title to-dos exist and would render as blank rows)
            var recentKey = recentTitle.toLowerCase()
            if (recentSeen.has(recentKey)) continue
            recentSeen.add(recentKey)
            recentTitles.push(recentTitle)
            if (recentTitles.length >= 10) break
        }
        return recentTitles
    }
    var words = typed.split(/\s+/)
    var lastWord = words[words.length - 1]
    // Escape the wildcard characters Joplin's search treats specially so a stray * or " in the typed
    // text cannot break the query; the field-scoped title: filter matches the last word as a prefix.
    var safeLastWord = lastWord.replace(/["*]/g, "")
    if (!safeLastWord) return []
    var response = await joplin.data.get(['search'], {
        // No type: filter, so both regular notes and to-dos are matched - the panel's primary content
        // is to-dos, which type:note would exclude (type:note and type:todo are mutually exclusive).
        query: `title:${safeLastWord}*`,
        fields: ['title'],
        type: 'note',
        limit: 10,
    })
    var needle = typed.toLowerCase()
    var seen = new Set()
    var titles = []
    for (var item of (response.items || [])){
        var title = String(item.title || "")
        if (title.toLowerCase().indexOf(needle) < 0) continue
        var key = title.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        titles.push(title)
        if (titles.length >= 10) break
    }
    return titles
}

/** getNotes ****************************************************************************************************************************************
 * Returns the regular (non to-do) notes matching the given search criteria, sorted by title, each with its checkbox counts. Used when a profile     *
 * shows notes alongside the to-dos.                                                                                                                *
 ***************************************************************************************************************************************************/
export async function getNotes(searchCriteria){
    var allNotes = [];
    let pageNum = 1;
    do {
        var response = await joplin.data.get(['search'], {
            query: `type:note ${searchCriteria}`,
            fields: ['id', 'title', 'parent_id', 'user_updated_time', 'user_created_time'],
            type: 'note',
            page: pageNum++,
        })
        allNotes = allNotes.concat(response.items)
    } while (response.has_more)
    await attachCheckboxCounts(allNotes)
    return allNotes.sort((first, second) => String(first.title).localeCompare(String(second.title), undefined, { numeric: true, sensitivity: "base" }))
}

/** attachCheckboxCounts ****************************************************************************************************************************
 * Fills in checkboxDone/checkboxTotal for each item. The counts need the note bodies, which are by far the heaviest thing to transfer, so they are  *
 * cached per note and a body is only re-fetched when the note's updated time has changed. A refresh therefore usually fetches no bodies at all.     *
 * On a cold start over a large set, at most maxBodyFetchesPerRefresh bodies are fetched per refresh and the rest fill in on following refreshes,    *
 * so the panel appears quickly instead of stalling.                                                                                                 *
 ***************************************************************************************************************************************************/
var checkboxCounts = new Map()
const bodyFetchChunk = 20
const maxBodyFetchesPerRefresh = 300

async function attachCheckboxCounts(items){
    var stale = items.filter(item => {
        var cached = checkboxCounts.get(item.id)
        return !cached || cached.stamp !== item.user_updated_time
    }).slice(0, maxBodyFetchesPerRefresh)
    for (var index = 0; index < stale.length; index += bodyFetchChunk){
        await Promise.all(stale.slice(index, index + bodyFetchChunk).map(async item => {
            try {
                var note = await joplin.data.get(['notes', item.id], { fields: ['body'] })
                var counts = countCheckboxes(note.body)
                checkboxCounts.set(item.id, { stamp: item.user_updated_time, done: counts.done, total: counts.total })
            } catch (error) {
                checkboxCounts.set(item.id, { stamp: item.user_updated_time, done: 0, total: 0 })
            }
        }))
    }
    for (var item of items){
        var counts = checkboxCounts.get(item.id)
        item.checkboxDone = counts ? counts.done : 0
        item.checkboxTotal = counts ? counts.total : 0
    }
}

/** countCheckboxes *********************************************************************************************************************************
 * Counts the markdown checkboxes ("- [ ]" and "- [x]") in the given note body. The patterns are the same ones Joplin's own note list uses for its   *
 * checkbox completion chart, so the two always agree.                                                                                              *
 ***************************************************************************************************************************************************/
function countCheckboxes(body){
    var text = String(body || "")
    var unchecked = (text.match(/(^|\n)[ \t>]*- \[ \]/g) || []).length
    var checked = (text.match(/(^|\n)[ \t>]*- \[[xX]\]/g) || []).length
    return { done: checked, total: checked + unchecked }
}

/** getNotebookMap ***********************************************************************************************************************************
 * Returns a Map of notebook ID to { id, title, path }, where path is the notebook's full "Parent / Child" breadcrumb. Used to show which notebook    *
 * a to-do lives in and to build the notebook filter.                                                                                                *
 ***************************************************************************************************************************************************/
var notebookMapCache = { stamp: 0, map: null }
const notebookMapTTL = 20000

/** invalidateNotebookMap ***************************************************************************************************************************
 * Drops the cached notebook map. Called after the panel itself creates, renames, moves or deletes a notebook, so the change shows immediately       *
 * rather than when the cache expires.                                                                                                              *
 ***************************************************************************************************************************************************/
export function invalidateNotebookMap(){
    notebookMapCache = { stamp: 0, map: null }
}

export async function getNotebookMap(){
    if (notebookMapCache.map && Date.now() - notebookMapCache.stamp < notebookMapTTL) return notebookMapCache.map
    var folders = new Map()
    let pageNum = 1;
    do {
        var response = await joplin.data.get(['folders'], {
            fields: ['id', 'title', 'parent_id'],
            page: pageNum++,
        })
        for (var folder of response.items) folders.set(folder.id, folder)
    } while (response.has_more)
    var notebooks = new Map()
    for (var [id, folder] of folders){
        var titles = [folder.title]
        var parent = folders.get(folder.parent_id)
        // The guard stops a corrupted parent chain from looping forever
        var guard = 0
        while (parent && guard++ < 32){
            titles.unshift(parent.title)
            parent = folders.get(parent.parent_id)
        }
        notebooks.set(id, { id: id, title: folder.title, path: titles.join(" / "), parentID: folder.parent_id || "" })
    }
    notebookMapCache = { stamp: Date.now(), map: notebooks }
    return notebooks
}

/** getAllTags **************************************************************************************************************************************
 * Returns every tag as { id, title }, for the search field's tag: autocomplete. Paginated and TTL-cached the same way as the notebook map, so the    *
 * whole list is fetched at most once every few seconds no matter how often the panel re-renders. Joplin stores tag titles lowercased.               *
 ***************************************************************************************************************************************************/
var tagsCache = { stamp: 0, list: null }
const tagsTTL = 20000

export async function getAllTags(){
    if (tagsCache.list && Date.now() - tagsCache.stamp < tagsTTL) return tagsCache.list
    var tags = []
    let pageNum = 1;
    do {
        var response = await joplin.data.get(['tags'], {
            fields: ['id', 'title'],
            page: pageNum++,
        })
        tags = tags.concat(response.items)
    } while (response.has_more)
    tagsCache = { stamp: Date.now(), list: tags }
    return tags
}

/** notebookWithDescendants *************************************************************************************************************************
 * The IDs of the given notebook and every notebook nested under it, so that filtering to a notebook includes its sub-notebooks                     *
 ***************************************************************************************************************************************************/
export function notebookWithDescendants(notebooks, folderID){
    var ids = new Set([folderID])
    // Notebooks point at their parents, so sweep until no new descendants turn up
    var addedNew = true
    while (addedNew){
        addedNew = false
        for (var notebook of notebooks.values()){
            if (!ids.has(notebook.id) && ids.has(notebook.parentID)){
                ids.add(notebook.id)
                addedNew = true
            }
        }
    }
    return ids
}

/** setTodoDueTimestamps ****************************************************************************************************************************
 * Sets the due date of each given to-do to the given timestamp, or removes it when the timestamp is 0. Used by the set alarm dialog, where the      *
 * user picks the exact moment.                                                                                                                     *
 ***************************************************************************************************************************************************/
export async function setTodoDueTimestamps(todoIDs, timestamp){
    for (var todoID of todoIDs){
        await joplin.data.put(['notes', todoID], null, { todo_due: timestamp })
    }
}

/** setTodoDueDates *********************************************************************************************************************************
 * Sets the due date of each given to-do to the given local YYYY-MM-DD date, or removes the due date when the date is null. A to-do that already     *
 * had a due time keeps its time of day on the new date; one that had none becomes due at the given day start time.                                  *
 ***************************************************************************************************************************************************/
export async function setTodoDueDates(todoIDs, dateISO, dayStart){
    var parts = dateISO ? String(dateISO).split("-").map(Number) : null
    for (var todoID of todoIDs){
        var dueTimestamp = 0
        if (parts && parts.length === 3 && parts.every(part => Number.isFinite(part))){
            var target = new Date(parts[0], parts[1] - 1, parts[2])
            var note = await joplin.data.get(['notes', todoID], { fields: ['todo_due'] })
            if (note.todo_due && note.todo_due > 0){
                var previous = new Date(note.todo_due)
                target.setHours(previous.getHours(), previous.getMinutes(), 0, 0)
            } else {
                target.setHours(dayStart.hours, dayStart.minutes, 0, 0)
            }
            dueTimestamp = target.getTime()
        }
        await joplin.data.put(['notes', todoID], null, { todo_due: dueTimestamp })
    }
}

/** openTodo ****************************************************************************************************************************************
 * Opens the todo with the given todo ID                                                                                                            *
 ***************************************************************************************************************************************************/
export async function openTodo(todoID){
    await joplin.commands.execute('openNote', todoID);
}

/** getNoteContent **********************************************************************************************************************************
 * Gets the body of the note with the given noteID                                                                                                  *
 ***************************************************************************************************************************************************/
export async function getNoteContent(noteID){
    return await joplin.data.get(['notes', noteID], { fields: ['id', 'title', 'body']})
}

/** setNoteContent **********************************************************************************************************************************
 * Sets the body of the note with the given noteID to the given note body                                                                           *
 ***************************************************************************************************************************************************/
export async function setNoteContent(noteID, noteBody){
    await joplin.data.put(['notes', noteID], null, { body: noteBody})
}

/** toggleTodoCompletion ****************************************************************************************************************************
 * Toggles between done and undone, the todo with the given ID                                                                                      *
 ***************************************************************************************************************************************************/
export async function toggleTodoCompletion(todoID){
    var note = await joplin.data.get(['notes', todoID], {fields: ['todo_completed']});
    await joplin.data.put(['notes', todoID], null, { todo_completed: !note.todo_completed});
}
