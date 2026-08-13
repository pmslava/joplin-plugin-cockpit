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
            fields: ['id', 'title', 'todo_completed', 'todo_due', 'parent_id', 'body', 'user_updated_time', 'user_created_time'],
            type: 'note',
            order_by: 'todo_due',
            page: pageNum++,
        })
        allTodos = allTodos.concat(response.items)
    } while (response.has_more)
    // Each to-do's progress is how many of the markdown checkboxes inside its note are ticked.
    // The bodies are only needed for that count, so they are dropped right away.
    for (var todo of allTodos){
        var counts = countCheckboxes(todo.body)
        todo.checkboxDone = counts.done
        todo.checkboxTotal = counts.total
        delete todo.body
    }
    // The search only orders by due date, which leaves to-dos sharing a due date - and the whole
    // "No Due Date" group - in arbitrary order. Ties are broken by title, so that a naming scheme
    // gives a deliberate order. The comparison is case insensitive and number aware ("2" < "10").
    allTodos.sort((first, second) => {
        return (first.todo_due - second.todo_due)
            || String(first.title).localeCompare(String(second.title), undefined, { numeric: true, sensitivity: "base" })
    })
    return allTodos
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
            fields: ['id', 'title', 'parent_id', 'body', 'user_updated_time', 'user_created_time'],
            type: 'note',
            page: pageNum++,
        })
        allNotes = allNotes.concat(response.items)
    } while (response.has_more)
    for (var note of allNotes){
        var counts = countCheckboxes(note.body)
        note.checkboxDone = counts.done
        note.checkboxTotal = counts.total
        delete note.body
    }
    return allNotes.sort((first, second) => String(first.title).localeCompare(String(second.title), undefined, { numeric: true, sensitivity: "base" }))
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
export async function getNotebookMap(){
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
    return notebooks
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
