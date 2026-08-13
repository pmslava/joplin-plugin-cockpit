/** onTodoClicked ***********************************************************************************************************************************
 * When a todo item is clicked, this function sends a message to the main plugin containing the todo id                                             *
 ***************************************************************************************************************************************************/
async function onTodoClicked(todoID){
    await webviewApi.postMessage(['todoClicked', todoID]);
}

/** Selection ***************************************************************************************************************************************
 * Which to-dos are selected, so that several can be dragged together. Ctrl+click (or Cmd+click) toggles a to-do, Shift+click selects the range from *
 * the previous click, and a plain click on a title opens the to-do as before. The panel markup is replaced on every refresh, so the selection is    *
 * kept here and painted back on whenever the document changes.                                                                                     *
 ***************************************************************************************************************************************************/
var selectedTodoIDs = new Set()
var lastClickedTodoID = null
// A picked regular note is only highlighted; it takes no part in drag or set-alarm operations
var pickedNoteID = null

function allTodoRows(){
    return Array.from(document.querySelectorAll('.todo[data-todo-id]'))
}

function paintTodoSelection(){
    for (var row of allTodoRows()){
        row.classList.toggle('-selected', selectedTodoIDs.has(row.dataset.todoId))
    }
    for (var noteRow of document.querySelectorAll('.todo[data-note-id]')){
        noteRow.classList.toggle('-selected', noteRow.dataset.noteId === pickedNoteID)
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((mutations) => {
        if (mutations.some(mutation => mutation.addedNodes.length)) paintTodoSelection()
    }).observe(document.body, { childList: true, subtree: true })
})

/** onTodoRowMouseDown ******************************************************************************************************************************
 * Selection happens on press, like in a list: a plain press selects the row (replacing the selection), Ctrl+press toggles it, Shift+press selects   *
 * the range from the last plainly- or Ctrl-pressed row (the anchor). The anchor stays put, so a further Shift+press resizes the range rather than   *
 * chaining from its end. Opening happens separately, on click.                                                                                     *
 ***************************************************************************************************************************************************/
function onTodoRowMouseDown(event, todoID){
    if (event.button !== 0) return
    if (event.target.classList.contains('todo-checkbox')) return
    pickedNoteID = null
    if (event.shiftKey){
        var ids = allTodoRows().map(row => row.dataset.todoId)
        var anchor = lastClickedTodoID !== null && ids.indexOf(lastClickedTodoID) >= 0 ? lastClickedTodoID : todoID
        var from = ids.indexOf(anchor)
        var to = ids.indexOf(todoID)
        selectedTodoIDs.clear()
        for (var index = Math.min(from, to); index <= Math.max(from, to); index++){
            selectedTodoIDs.add(ids[index])
        }
    } else if (event.ctrlKey || event.metaKey){
        selectedTodoIDs.has(todoID) ? selectedTodoIDs.delete(todoID) : selectedTodoIDs.add(todoID)
        lastClickedTodoID = todoID
    } else {
        selectedTodoIDs.clear()
        selectedTodoIDs.add(todoID)
        lastClickedTodoID = todoID
    }
    paintTodoSelection()
}

function onTodoRowClicked(event, todoID){
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.target.classList.contains('todo-checkbox')) return
    if (event.target.classList.contains('todo-title')){
        void onTodoClicked(todoID)
    }
}

/** onTodoContextMenu ********************************************************************************************************************************
 * Right click (or long press) on a to-do, dispatched by which part of the row was pressed: the circle opens the due date picker for the selection,  *
 * the notebook label opens Joplin's "Move to notebook" dialog, and anywhere else opens the context menu.                                            *
 ***************************************************************************************************************************************************/
function onTodoContextMenu(event, todoID){
    event.preventDefault()
    if (event.target.classList.contains('todo-checkbox')){
        if (!selectedTodoIDs.has(todoID)){
            selectedTodoIDs.clear()
            selectedTodoIDs.add(todoID)
            lastClickedTodoID = todoID
            paintTodoSelection()
        }
        void webviewApi.postMessage(['setAlarmClicked', [...selectedTodoIDs]]);
    } else if (event.target.classList.contains('todo-notebook')){
        void webviewApi.postMessage(['moveToNotebookClicked', [todoID]]);
    } else {
        showNoteContextMenu(event, todoID)
    }
}

/** Note rows ***************************************************************************************************************************************
 * Regular notes have no checkbox or due date: a click on the title opens them, and the right click zones are the notebook label ("Move to           *
 * notebook") and everything else (context menu).                                                                                                   *
 ***************************************************************************************************************************************************/
function onNoteRowMouseDown(event, noteID){
    if (event.button !== 0) return
    selectedTodoIDs.clear()
    pickedNoteID = noteID
    paintTodoSelection()
}

function onNoteRowClicked(event, noteID){
    if (event.target.classList.contains('todo-title')){
        void onTodoClicked(noteID)
    }
}

/** onRowDoubleClicked ******************************************************************************************************************************
 * Double clicking a title opens the note in its own window, like in Joplin's note list                                                             *
 ***************************************************************************************************************************************************/
function onRowDoubleClicked(event, noteID){
    if (event.target.classList.contains('todo-title')){
        void webviewApi.postMessage(['openInNewWindow', noteID]);
    }
}

function onNoteContextMenu(event, noteID){
    event.preventDefault()
    if (event.target.classList.contains('todo-notebook')){
        void webviewApi.postMessage(['moveToNotebookClicked', [noteID]]);
    } else {
        showNoteContextMenu(event, noteID)
    }
}

/** Context menu ************************************************************************************************************************************
 * A small menu of note actions, drawn by the panel itself because Joplin's own note context menu cannot be opened from a plugin webview             *
 ***************************************************************************************************************************************************/
var noteMenuItems = [
    { action: 'open', label: 'Open' },
    { action: 'toggleType', label: 'Switch between note and to-do type' },
    { action: 'tags', label: 'Tags...' },
    { action: 'moveToFolder', label: 'Move to notebook...' },
    { action: 'duplicate', label: 'Duplicate' },
    { action: 'copyMarkdownLink', label: 'Copy Markdown link' },
    { action: 'copyNoteID', label: 'Copy note ID' },
    { action: 'delete', label: 'Delete note' },
]

function showNoteContextMenu(event, noteID){
    hideNoteContextMenu()
    var menu = document.createElement('div')
    menu.id = 'noteContextMenu'
    menu.innerHTML = noteMenuItems.map(item => {
        return `<button type="button" class="context-menu-item${item.action == 'delete' ? ' -danger' : ''}" data-action="${item.action}">${item.label}</button>`
    }).join('')
    menu.addEventListener('click', clickEvent => {
        var action = clickEvent.target.dataset ? clickEvent.target.dataset.action : null
        hideNoteContextMenu()
        if (action) void webviewApi.postMessage(['noteMenuAction', action, noteID]);
    })
    document.body.appendChild(menu)
    menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`
}

function hideNoteContextMenu(){
    var menu = document.getElementById('noteContextMenu')
    if (menu) menu.remove()
}

document.addEventListener('click', event => {
    if (!event.target.closest || !event.target.closest('#noteContextMenu')) hideNoteContextMenu()
}, true)
document.addEventListener('scroll', hideNoteContextMenu, true)
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideNoteContextMenu()
})

/** onHeadingContextMenu ****************************************************************************************************************************
 * Right click on a group heading ("Today", "No Due Date", a week planner day...) opens the set alarm dialog for every to-do in that group.          *
 ***************************************************************************************************************************************************/
function onHeadingContextMenu(event){
    event.preventDefault()
    var ids = (event.currentTarget.dataset.todoIds || '').split(',').filter(Boolean)
    if (!ids.length) return
    selectedTodoIDs.clear()
    for (var id of ids) selectedTodoIDs.add(id)
    paintTodoSelection()
    void webviewApi.postMessage(['setAlarmClicked', ids]);
}

/** Drag and drop ***********************************************************************************************************************************
 * Dragging a selected to-do takes the whole selection with it; dragging an unselected one drags just that one. The drop targets - group headings,   *
 * calendar days, week planner columns - carry a data-drop attribute with the date the to-dos become due, or "clear".                                *
 ***************************************************************************************************************************************************/
function onTodoDragStart(event, todoID){
    if (!selectedTodoIDs.has(todoID)){
        selectedTodoIDs.clear()
        selectedTodoIDs.add(todoID)
        paintTodoSelection()
    }
    var ids = [...selectedTodoIDs]
    event.dataTransfer.setData('text/plain', ids.join(','))
    event.dataTransfer.effectAllowed = 'move'
    for (var row of allTodoRows()){
        if (selectedTodoIDs.has(row.dataset.todoId)) row.classList.add('-dragging')
    }
}

function onTodoDragEnd(event){
    for (var row of allTodoRows()) row.classList.remove('-dragging')
}

function onDropTargetOver(event){
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    event.currentTarget.classList.add('-drop-over')
}

function onDropTargetLeave(event){
    event.currentTarget.classList.remove('-drop-over')
}

async function onTodoDropped(event){
    event.preventDefault()
    event.currentTarget.classList.remove('-drop-over')
    var target = event.currentTarget.dataset.drop
    var ids = (event.dataTransfer.getData('text/plain') || '').split(',').filter(Boolean)
    if (!target || !ids.length) return
    selectedTodoIDs.clear()
    await webviewApi.postMessage(['todosDropped', ids, target]);
}

/** onTodoChecked ***********************************************************************************************************************************
 * When a todo item is checked as complete/incomplete, this function sends a message to the main plugin containing the todo id                      *
 ***************************************************************************************************************************************************/ 
async function onTodoChecked(todoID){
    await webviewApi.postMessage(['todoChecked', todoID]);
}

/** onProfilesDropdownChanged ************************************************************************************************************************
 * When the profiles dropdown is changed, this function sends a message to the main plugin to load the new profile                                   *
 ***************************************************************************************************************************************************/ 
async function onProfilesDropdownChanged(profileID){
    await webviewApi.postMessage(['profilesDropdownChanged', profileID]);
}

/** onNotebookFilterChanged **************************************************************************************************************************
 * When the notebook filter dropdown is changed, this function sends a message to the main plugin containing the notebook id, or an empty string     *
 * for all notebooks                                                                                                                                 *
 ***************************************************************************************************************************************************/
async function onNotebookFilterChanged(notebookID){
    await webviewApi.postMessage(['notebookFilterChanged', notebookID]);
}

/** onSortFieldClicked / onSortDirectionClicked ******************************************************************************************************/
async function onSortFieldClicked(){
    await webviewApi.postMessage(['sortFieldClicked']);
}

async function onSortDirectionClicked(){
    await webviewApi.postMessage(['sortDirectionClicked']);
}

/** Custom dropdowns ********************************************************************************************************************************
 * The profile and notebook pickers are drawn by the panel so that every row can carry its own action buttons. The buttons are always visible -      *
 * hover only emphasises them - so they work the same by tap on mobile.                                                                             *
 ***************************************************************************************************************************************************/
function closeAllDropdowns(){
    for (var menu of document.querySelectorAll('.dropdown-menu')){
        menu.setAttribute('hidden', '')
    }
}

function onDropdownToggle(event, menuID){
    event.stopPropagation()
    var menu = document.getElementById(menuID)
    if (!menu) return
    var wasHidden = menu.hasAttribute('hidden')
    closeAllDropdowns()
    hideNoteContextMenu()
    if (wasHidden) menu.removeAttribute('hidden')
}

function onDropdownItemClicked(event, messageName, value){
    closeAllDropdowns()
    void webviewApi.postMessage(value === null ? [messageName] : [messageName, value]);
}

function onDropdownActionClicked(event, messageName, value){
    event.stopPropagation()
    closeAllDropdowns()
    void webviewApi.postMessage([messageName, value]);
}

document.addEventListener('click', event => {
    if (!event.target.closest || !event.target.closest('.dropdown')) closeAllDropdowns()
}, true)

/** onNewNoteClicked / onNewTodoClicked **************************************************************************************************************/
async function onNewNoteClicked(){
    await webviewApi.postMessage(['newNoteClicked']);
}

async function onNewTodoClicked(){
    await webviewApi.postMessage(['newTodoClicked']);
}

/** onSearchFilterChanged ****************************************************************************************************************************
 * When the search field is committed (Enter, or its clear button), this function sends the search string to the main plugin. It supports the full   *
 * Joplin search syntax: tag:, notebook:, plain words, and so on.                                                                                    *
 ***************************************************************************************************************************************************/
async function onSearchFilterChanged(searchString){
    await webviewApi.postMessage(['searchFilterChanged', searchString]);
}

/** onCreateProfileClicked **************************************************************************************************************************
 * When the edit profile button for a profile is clicked, this function sends a message to the main plugin containing the profile id                *
 ***************************************************************************************************************************************************/ 
 async function onCreateProfileClicked(){
    await webviewApi.postMessage(['createProfileClicked']);
}

/** onEditProfileClicked ****************************************************************************************************************************
 * When the edit profile button for a profile is clicked, this function sends a message to the main plugin containing the profile id                *
 ***************************************************************************************************************************************************/ 
 async function onEditProfileClicked(profileID){
    await webviewApi.postMessage(['editProfileClicked']);
}

/** onDeleteProfileClicked **************************************************************************************************************************
 * When the delete profile button for a profile is clicked, this function sends a message to the main plugin containing the profile id              *
 ***************************************************************************************************************************************************/
 async function onDeleteProfileClicked(profileID){
    await webviewApi.postMessage(['deleteProfileClicked']);
}


/** onUpdateInterfacesClicked **************************************************************************************************************************
 * When the user requests an interface update, this function sends a message to the main plugin              *
 ***************************************************************************************************************************************************/
 async function onUpdateInterfacesClicked(){
    await webviewApi.postMessage(['updateInterfacesClicked']);
}

/** onToggleProfileControlsClicked ******************************************************************************************************************
 * Shows or hides the profile create, edit and delete buttons. This is only shown on mobile, where there is no Tools menu to run the command from    *
 ***************************************************************************************************************************************************/
async function onToggleProfileControlsClicked(){
    await webviewApi.postMessage(['toggleProfileControlsClicked']);
}

/** onStylerClicked *********************************************************************************************************************************
 * Opens the panel styler dialog. This is only shown on mobile, where there is no Tools menu to run the command from                                *
 ***************************************************************************************************************************************************/
async function onStylerClicked(){
    await webviewApi.postMessage(['stylerClicked']);
}

/** onCalendarNavigate ******************************************************************************************************************************
 * Moves the calendar a month or a week backwards or forwards. The plugin holds the position, because the panel markup is replaced on every refresh  *
 ***************************************************************************************************************************************************/
async function onCalendarNavigate(delta){
    await webviewApi.postMessage(['calendarNavigate', delta]);
}

/** onCalendarToday *********************************************************************************************************************************
 * Returns the calendar to the current month or week                                                                                                *
 ***************************************************************************************************************************************************/
async function onCalendarToday(){
    await webviewApi.postMessage(['calendarToday']);
}

/** onCalendarDaySelected ***************************************************************************************************************************
 * Lists the to-dos of the given day under the month grid, or hides them again when that day is already selected                                     *
 ***************************************************************************************************************************************************/
async function onCalendarDaySelected(isoDate){
    await webviewApi.postMessage(['calendarDaySelected', isoDate]);
}
