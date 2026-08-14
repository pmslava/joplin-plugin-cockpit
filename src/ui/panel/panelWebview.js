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

/** Scroll preservation *********************************************************************************************************************************
 * The whole panel document is replaced on every refresh, which discards the .todos scroll container and drops the list back to the top. The scroll    *
 * position is kept here in module state (which survives setHtml, like the selection above) and painted back on when a fresh .todos node reappears.    *
 * Deliberate view changes (profile, notebook, search, calendar navigation) zero it first, so those still start at the top.                            *
 ***************************************************************************************************************************************************/
var savedTodosScrollTop = 0

// The live .todos scroll container, tracked by node identity: the host replaces it with a brand new
// node on every re-render (setHtml sets innerHTML on the persistent #joplin-plugin-content wrapper),
// so a changed reference is exactly the signal that a real re-render happened. restoringScroll marks
// our own programmatic restore so its scroll event is not saved back as a user scroll.
var currentTodosEl = null
var restoringScroll = false

function restoreTodosScroll(el){
    restoringScroll = true
    requestAnimationFrame(() => {
        // After layout the flex column has its final height, so scrollHeight/clientHeight are real;
        // clamp to the maximum legal scrollTop (scrollHeight - clientHeight) rather than scrollHeight.
        el.scrollTop = Math.min(savedTodosScrollTop, el.scrollHeight - el.clientHeight)
        requestAnimationFrame(() => { restoringScroll = false })
    })
}

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

/** reconcile ***************************************************************************************************************************************
 * Runs once at startup and on every DOM mutation. When a fresh .todos node has replaced the previous one (identity change == a real re-render),    *
 * it re-attaches the per-element scroll saver, restores the scroll position, repaints the selection and puts an in-progress search draft back. A    *
 * mutation that does not swap .todos (an injected context menu, the suggestion list, a tooltip) leaves the scroll and everything else untouched.    *
 ***************************************************************************************************************************************************/
// True when the panel is running in the Joplin mobile app, read from the #cockpitPlatform marker the
// plugin emits into the rendered markup on mobile only. It gates every touch-layer behaviour in this
// file; on desktop the marker is absent so it stays false and all of those behaviours are inert.
var IS_MOBILE = false

// The panel is mobile when the rendered markup carries the #cockpitPlatform marker (emitted by
// refreshPanelData only on mobile). Mirror that onto a JS global and onto the persistent
// #joplin-plugin-content wrapper (and <body>) as a class, so mobile-only CSS/JS can branch off it.
// Add-only and gated on the marker's presence, so on desktop (no marker) IS_MOBILE stays false and no
// element is ever touched. The class is put on <body> as well as the wrapper because the context menu
// and the sync-status toast are appended to <body>, which sits OUTSIDE #joplin-plugin-content, so their
// mobile-gated CSS would not match a class carried only on the wrapper.
function applyPlatformClass(){
    IS_MOBILE = !!document.getElementById('cockpitPlatform')
    if (!IS_MOBILE) return
    var wrapper = document.getElementById('joplin-plugin-content')
    if (wrapper) wrapper.classList.add('cockpit-mobile')
    document.body.classList.add('cockpit-mobile')
}

function reconcile(){
    // Refresh IS_MOBILE and the class on every render (the marker is re-emitted each time); it must run
    // unconditionally, not only when the .todos node identity changes, so the flag is set before the
    // first pointer event even on renders that reuse the scroll container.
    applyPlatformClass()
    var el = document.querySelector('.todos')
    if (el && el !== currentTodosEl){
        currentTodosEl = el
        // Save on genuine user scroll only; ignore the programmatic restore below (and any scroll-to-0
        // fired as the old node is detached), which restoringScroll guards.
        el.addEventListener('scroll', () => { if (!restoringScroll) savedTodosScrollTop = el.scrollTop })
        restoreTodosScroll(el)
        paintTodoSelection()
        // The suggestion menu was in the replaced markup; drop its now-stale state (closing on a
        // re-render is fine - only the typed text must survive, which restoreSearchDraft handles).
        searchSuggestion = null
        restoreSearchDraft()
    }
}

// Joplin injects plugin webview scripts after DOMContentLoaded has already fired, so gating the
// observer on that event left it never registered and every restore above was dead code. Wire it up
// at top-level instead, with a fallback for the reverse ordering just in case.
function startPanelObserver(){
    reconcile()
    // reconcile() has just set IS_MOBILE from the platform marker. Clear any overlay refresh-guard leaked
    // by a previous webview that was torn down mid-overlay (only meaningful on mobile, where overlays and
    // the guard exist); a no-op on a normal fresh load.
    if (IS_MOBILE) void webviewApi.postMessage(['dialogGuardReset']);
    new MutationObserver(reconcile).observe(document.body, { childList: true, subtree: true })
}

// The Android back gesture (when it pops webview history rather than the whole viewer) closes an open
// overlay instead of navigating, so the guard is released down the same closeOverlay path.
window.addEventListener('popstate', function(){ if (overlayOpen) closeOverlay() })

if (document.body){
    startPanelObserver()
} else {
    document.addEventListener('DOMContentLoaded', startPanelObserver)
}

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
        requestAlarm([...selectedTodoIDs])
    } else if (event.target.classList.contains('todo-notebook')){
        // Desktop opens Joplin's native "Move to notebook" dialog; mobile opens the in-panel notebook
        // overlay instead (a native dialog would open behind the panel there).
        if (IS_MOBILE) openNotebookOverlay('moveNotes', { noteIDs: [todoID] })
        else void webviewApi.postMessage(['moveToNotebookClicked', [todoID]]);
    } else {
        showNoteContextMenu(event, todoID, true)
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
        if (IS_MOBILE) openNotebookOverlay('moveNotes', { noteIDs: [noteID] })
        else void webviewApi.postMessage(['moveToNotebookClicked', [noteID]]);
    } else {
        showNoteContextMenu(event, noteID, false)
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

function showNoteContextMenu(event, noteID, isTodo){
    hideNoteContextMenu()
    // On mobile the 18px checkbox circle is a hard touch target, so to-do rows get an explicit
    // "Move to date…" entry that opens the same set-alarm dialog the circle long-press does. On desktop
    // (IS_MOBILE false) the list is exactly noteMenuItems and the setDueDate branch below is unreachable,
    // so the menu and its behaviour are byte-identical to before.
    var items = (IS_MOBILE && isTodo)
        ? [{ action: 'setDueDate', label: 'Move to date…' }].concat(noteMenuItems)
        : noteMenuItems
    var menu = document.createElement('div')
    menu.id = 'noteContextMenu'
    menu.innerHTML = items.map(item => {
        return `<button type="button" class="context-menu-item${item.action == 'delete' ? ' -danger' : ''}" data-action="${item.action}">${item.label}</button>`
    }).join('')
    menu.addEventListener('click', clickEvent => {
        var action = clickEvent.target.dataset ? clickEvent.target.dataset.action : null
        hideNoteContextMenu()
        if (action === 'setDueDate'){ requestAlarm([noteID]); return }
        // On mobile the notebook and tag pickers are in-panel overlays rather than native dialogs (which
        // would open behind the panel). Desktop keeps posting noteMenuAction so its native dialogs run.
        if (IS_MOBILE && action === 'moveToFolder'){ openNotebookOverlay('moveNotes', { noteIDs: [noteID] }); return }
        if (IS_MOBILE && action === 'tags'){ openTagOverlay(noteID); return }
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
    // This capture listener is registered before the long-press adapter's click swallower below, so on
    // the synthetic click that follows a fired long-press it runs first, while longPress.fired is still
    // true. Bail out then, or it would close the very menu the long-press just opened. longPress is
    // hoisted (var) so the reference is safe; on desktop longPress.fired is never true, so this
    // early-return is never taken and the listener stays byte-identical.
    if (longPress && longPress.fired) return
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
    requestAlarm(ids)
}

/** requestAlarm ************************************************************************************************************************************
 * Opens the "Move to date" / set-alarm picker for the given to-dos. Desktop posts setAlarmClicked so the host opens its native alarm dialog; mobile   *
 * opens the in-panel alarm overlay instead (a native dialog would open behind the panel there).                                                      *
 ***************************************************************************************************************************************************/
function requestAlarm(ids){
    if (!ids || !ids.length) return
    if (IS_MOBILE) openAlarmOverlay(ids)
    else void webviewApi.postMessage(['setAlarmClicked', ids]);
}

/** Long-press adapter (mobile) *********************************************************************************************************************
 * The mobile webview never fires oncontextmenu, so touch has no way into the context menus that a desktop right click opens. This synthesises them  *
 * from a Pointer Events long press: a touch that stays put for 500ms on a to-do row, a note row, a group heading or the sync button fires the same   *
 * handler the desktop right click would, passing a minimal event carrying the press point and pressed element. It is fully gated on IS_MOBILE and    *
 * on a non-mouse pointer, so on desktop (and for a desktop mouse) it is inert and the existing click / dblclick / contextmenu paths are untouched.   *
 * A move of more than 10px, a pointer up/cancel, or a scroll of the list aborts the press (a scroll or a drag is not a long press). The click the    *
 * browser synthesises right after the touch is swallowed, so a fired long press does not also open or toggle the item.                               *
 ***************************************************************************************************************************************************/
var longPress = { timer: null, x: 0, y: 0, fired: false, target: null, el: null, kind: null, id: null }

function cancelLongPress(){
    if (longPress.timer){ clearTimeout(longPress.timer); longPress.timer = null }
}

// A minimal stand-in for the DOM event the desktop right-click handlers receive: they read target,
// currentTarget, clientX/clientY, and call preventDefault/stopPropagation, and nothing else.
function synthEvent(target, x, y, currentTarget){
    return { target: target, currentTarget: currentTarget || target, clientX: x, clientY: y,
             preventDefault: function(){}, stopPropagation: function(){} }
}

function onLongPressFire(){
    longPress.timer = null
    longPress.fired = true
    if (navigator.vibrate){ try { navigator.vibrate(10) } catch (error){} }
    var ev = synthEvent(longPress.target, longPress.x, longPress.y, longPress.el)
    if (longPress.kind === 'todo') onTodoContextMenu(ev, longPress.id)
    else if (longPress.kind === 'note') onNoteContextMenu(ev, longPress.id)
    else if (longPress.kind === 'heading') onHeadingContextMenu(ev)
    else if (longPress.kind === 'sync') showToast(longPress.el.title || 'Synchronize')
}

document.addEventListener('pointerdown', function(event){
    if (!IS_MOBILE) return
    if (event.pointerType === 'mouse') return
    // Clear a stale fired flag at the very start of every touch pointerdown, before the zone check can
    // early-return below. If a long press fired but its gesture produced no synthesised click (the finger
    // dragged off, or a pointercancel arrived after the 500ms timer had already fired - cancelLongPress is
    // a no-op then), fired would stay true; the next tap on an unrecognised zone (a menu item, dropdown
    // toggle, search field, calendar day) would hit the `if (!kind) return` and skip a reset there, so the
    // click swallower below would eat that unrelated tap. Resetting here guarantees one fired flag is only
    // ever consumed by its own gesture's click.
    longPress.fired = false
    if (!event.target.closest) return
    // Events inside an in-panel overlay are the overlay's own; never treat them as a long press on the list.
    if (event.target.closest('#cockpitOverlay')) return
    var todoRow = event.target.closest('.todo[data-todo-id]')
    var noteRow = event.target.closest('.todo[data-note-id]')
    var heading = event.target.closest('h2[data-todo-ids]')
    var sync    = event.target.closest('.icon-button.-sync')
    var kind = null, el = null, id = null
    if (todoRow){ kind = 'todo'; el = todoRow; id = todoRow.dataset.todoId }
    else if (noteRow){ kind = 'note'; el = noteRow; id = noteRow.dataset.noteId }
    else if (heading){ kind = 'heading'; el = heading }
    else if (sync){ kind = 'sync'; el = sync }
    if (!kind) return
    longPress.x = event.clientX; longPress.y = event.clientY
    longPress.target = event.target; longPress.el = el; longPress.kind = kind; longPress.id = id
    longPress.timer = setTimeout(onLongPressFire, 500)
}, true)

document.addEventListener('pointermove', function(event){
    if (!longPress.timer) return
    if (Math.abs(event.clientX - longPress.x) > 10 || Math.abs(event.clientY - longPress.y) > 10) cancelLongPress()
}, true)

document.addEventListener('pointerup', cancelLongPress, true)
document.addEventListener('pointercancel', cancelLongPress, true)
// A scroll of the .todos list is not a long press, so it aborts a pending one (capture, so it catches
// the scroll of the inner container too).
document.addEventListener('scroll', cancelLongPress, true)
// The browser synthesises a click right after a fired long press; swallow it so tap-to-open (or the
// sync toggle) does not also run. This capture listener is registered after the context-menu dismiss
// listener above, which is why that one guards on longPress.fired and runs first.
document.addEventListener('click', function(event){
    if (longPress.fired){ longPress.fired = false; event.preventDefault(); event.stopPropagation() }
}, true)

/** showToast (mobile) ******************************************************************************************************************************
 * A transient bottom toast, used to surface the sync button's status text on a long press (touch has no hover, so the desktop title tooltip is       *
 * otherwise unreachable). The toast lives on <body>, which persists across the panel's setHtml re-renders, so it is created once and reused.          *
 ***************************************************************************************************************************************************/
var toastTimer = null

function showToast(text){
    var toast = document.getElementById('cockpitToast')
    if (!toast){ toast = document.createElement('div'); toast.id = 'cockpitToast'; document.body.appendChild(toast) }
    toast.textContent = text
    void toast.offsetWidth        // force a reflow so the opacity transition runs again on each show
    toast.classList.add('-show')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function(){ toast.classList.remove('-show') }, 3000)
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

/** onSortFieldClicked / onSortDirectionClicked ******************************************************************************************************/
async function onSortFieldClicked(){
    await webviewApi.postMessage(['sortFieldClicked']);
}

async function onSortDirectionClicked(){
    // Re-sorting reorders the whole list, so the old pixel offset points at arbitrary rows; start at
    // the top like the other deliberate view changes rather than letting the scroll restore run.
    savedTodosScrollTop = 0
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
    // The search suggestion list carries the .dropdown-menu class too, so the loop above just hid it.
    // Drop its logical state as well, or it would stay "open" while invisible and a following Enter or
    // arrow key would act on the hidden menu instead of committing the search.
    hideSearchSuggestions()
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
    // A deliberate profile or notebook-filter change starts the list at the top, like the other view
    // changes; the scroll position is otherwise restored across the re-render.
    if (messageName === 'profilesDropdownChanged' || messageName === 'notebookFilterChanged' || messageName === 'sortFieldSelected') savedTodosScrollTop = 0
    closeAllDropdowns()
    void webviewApi.postMessage(value === null ? [messageName] : [messageName, value]);
}

function onDropdownActionClicked(event, messageName, value){
    event.stopPropagation()
    closeAllDropdowns()
    // "Move notebook under..." asks for a target notebook. Desktop asks with the native picker dialog;
    // mobile asks with the in-panel notebook overlay (includeRoot offers "(top level)"). Every other row
    // action (rename, delete, edit/delete profile) is unchanged on both platforms.
    if (IS_MOBILE && messageName === 'moveNotebookClicked'){
        openNotebookOverlay('moveNotebookUnder', { sourceFolderId: value, includeRoot: true })
        return
    }
    void webviewApi.postMessage([messageName, value]);
}

document.addEventListener('click', event => {
    if (!event.target.closest || !event.target.closest('.dropdown')) closeAllDropdowns()
}, true)

/** onNewNoteClicked / onNewTodoClicked **************************************************************************************************************/
async function onNewNoteClicked(){
    if (createNeedsNotebookOverlay()){ openNotebookOverlay('createNote', {}); return }
    await webviewApi.postMessage(['newNoteClicked']);
}

async function onNewTodoClicked(){
    if (createNeedsNotebookOverlay()){ openNotebookOverlay('createTodo', {}); return }
    await webviewApi.postMessage(['newTodoClicked']);
}

/** createNeedsNotebookOverlay **********************************************************************************************************************
 * On mobile, with "All notebooks" active (no notebook filter), a new note has no notebook to go into, so the in-panel notebook overlay must ask first  *
 * (a native picker dialog would open behind the panel). With a notebook filtered, or on desktop, the note is created directly / the host asks with the *
 * native dialog, exactly as before.                                                                                                                  *
 ***************************************************************************************************************************************************/
function createNeedsNotebookOverlay(){
    return IS_MOBILE && !currentNotebookFilter()
}

/** onSearchFilterChanged ****************************************************************************************************************************
 * When the search field is committed (Enter, or its clear button), this function sends the search string to the main plugin. It supports the full   *
 * Joplin search syntax: tag:, notebook:, title:, plain words, and so on.                                                                            *
 ***************************************************************************************************************************************************/
async function onSearchFilterChanged(searchString){
    savedTodosScrollTop = 0
    // The search is now committed, so any uncommitted draft and the open suggestion list are done.
    searchDraft = null
    hideSearchSuggestions()
    await webviewApi.postMessage(['searchFilterChanged', searchString]);
}

/** Search autocomplete *********************************************************************************************************************************
 * A tag: / notebook: autocomplete for the search field. As the user types, the token at the caret is parsed; when it is a tag: or notebook: filter   *
 * being written, a dropdown of matching names is shown (reusing the dropdown styling). Picking one inserts it into the field - quoted when it        *
 * contains spaces, notebooks by their title (Joplin's notebook: matches by title, recursively) - without committing the search, which still happens  *
 * on Enter. Because the whole panel is replaced on every refresh, the uncommitted text, caret and focus are kept here and painted back on.           *
 ***************************************************************************************************************************************************/

// The uncommitted search text and caret, kept so a refresh mid-typing does not wipe them
var searchDraft = null
// Whether the search field currently has focus, so a refresh only steals focus back when the user
// was actually in the field (a genuine blur commits the search and clears the draft first)
var searchFocused = false
// The open suggestion list: the parsed token it is for, its items, and which one is highlighted
var searchSuggestion = null

function getSearchInput(){
    return document.getElementById('searchFilter')
}

function readSearchData(){
    var node = document.getElementById('cockpitSearchData')
    if (!node) return { tags: [], notebooks: [] }
    try {
        var data = JSON.parse(node.textContent || '{}')
        return { tags: data.tags || [], notebooks: data.notebooks || [] }
    } catch (error) {
        return { tags: [], notebooks: [] }
    }
}

/** tokenAtCaret ************************************************************************************************************************************
 * The tag: / notebook: / title: filter being typed immediately before the caret, or null. A quoted value may contain spaces; an unquoted one may     *
 * not, so the quoted form is tried first.                                                                                                            *
 ***************************************************************************************************************************************************/
function tokenAtCaret(value, caret){
    var before = value.slice(0, caret)
    var after = value.slice(caret)
    var quoted = /(^|\s)(tag|notebook|title):"([^"]*)$/.exec(before)
    if (quoted){
        // Consume the rest of the quoted value after the caret, up to and including its closing quote,
        // so selecting a suggestion with the caret mid-token replaces the whole token rather than
        // orphaning its tail.
        var quotedTail = /^[^"]*"?/.exec(after)
        return { kind: quoted[2], partial: quoted[3], hasQuote: true, start: quoted.index + quoted[1].length, end: caret + (quotedTail ? quotedTail[0].length : 0) }
    }
    var bare = /(^|\s)(tag|notebook|title):(\S*)$/.exec(before)
    if (bare){
        // Likewise consume the rest of the unquoted token after the caret (up to the next whitespace).
        var bareTail = /^\S*/.exec(after)
        return { kind: bare[2], partial: bare[3], hasQuote: false, start: bare.index + bare[1].length, end: caret + (bareTail ? bareTail[0].length : 0) }
    }
    return null
}

function suggestionsFor(token, data){
    var partial = token.partial.toLowerCase()
    if (token.kind === 'tag'){
        return data.tags
            .filter(title => String(title).toLowerCase().indexOf(partial) >= 0)
            .slice(0, 8)
            .map(title => ({ insert: String(title), label: String(title) }))
    }
    return data.notebooks
        .filter(notebook => (String(notebook.path).toLowerCase().indexOf(partial) >= 0) || (String(notebook.title).toLowerCase().indexOf(partial) >= 0))
        .slice(0, 8)
        .map(notebook => ({ insert: String(notebook.title), label: String(notebook.path) }))
}

// The title: autocomplete cannot use the embedded tag/notebook data - titles are too many to ship on
// every render - so it round-trips to the plugin. Each keystroke is debounced, and a sequence counter
// makes sure only the newest request's response is rendered (async replies can arrive out of order).
var titleSuggestSeq = 0
var titleSuggestTimer = null

function onSearchInput(input){
    updateSearchDraft(input)
    var token = tokenAtCaret(input.value, input.selectionStart)
    if (!token){ hideSearchSuggestions(); return }
    if (token.kind === 'title'){ requestTitleSuggestions(input, token); return }
    var items = suggestionsFor(token, readSearchData())
    if (!items.length){ hideSearchSuggestions(); return }
    searchSuggestion = { token: token, items: items, activeIndex: 0 }
    renderSearchSuggestions(input)
}

/** requestTitleSuggestions ************************************************************************************************************************
 * Debounced round-trip for the title: autocomplete. The webview posts ['searchTitleSuggestions', partial] and awaits the plugin's reply (matching   *
 * note titles). The reply is discarded unless it is still the newest request (sequence counter) and the token under the caret is still the same      *
 * title: partial with the field focused, so a stale or superseded response never overwrites what the user is now typing.                             *
 ***************************************************************************************************************************************************/
function requestTitleSuggestions(input, token){
    // An empty title: token (the bare "title:" state) still round-trips: the plugin answers it with
    // the most recently updated notes/to-dos, so the list appears right after the colon like tag:/notebook:.
    if (titleSuggestTimer) clearTimeout(titleSuggestTimer)
    var seq = ++titleSuggestSeq
    var partial = token.partial
    titleSuggestTimer = setTimeout(async () => {
        var titles
        try {
            titles = await webviewApi.postMessage(['searchTitleSuggestions', partial])
        } catch (error) {
            return
        }
        if (seq !== titleSuggestSeq) return
        if (!searchFocused) return
        var liveInput = getSearchInput()
        if (!liveInput) return
        var current = tokenAtCaret(liveInput.value, liveInput.selectionStart)
        if (!current || current.kind !== 'title' || current.partial !== partial) return
        if (!titles || !titles.length){ hideSearchSuggestions(); return }
        var items = titles.slice(0, 10).map(title => ({ insert: String(title), label: String(title) }))
        searchSuggestion = { token: current, items: items, activeIndex: 0 }
        renderSearchSuggestions(liveInput)
    }, 200)
}

/** renderSearchSuggestions ************************************************************************************************************************
 * Draws the suggestion list under the search row. Items are built with textContent, so a tag or notebook name is never interpreted as markup.        *
 ***************************************************************************************************************************************************/
function renderSearchSuggestions(input){
    // Remove any previous menu directly, so searchSuggestion (just set by the caller) is kept
    var existing = document.getElementById('searchSuggestions')
    if (existing) existing.remove()
    if (!searchSuggestion) return
    var row = document.getElementById('searchRow')
    if (!row) return
    var menu = document.createElement('div')
    menu.className = 'dropdown-menu'
    menu.id = 'searchSuggestions'
    searchSuggestion.items.forEach((suggestion, index) => {
        var item = document.createElement('div')
        item.className = 'dropdown-item' + (index === searchSuggestion.activeIndex ? ' -current' : '')
        var label = document.createElement('span')
        label.className = 'dropdown-label'
        label.textContent = suggestion.label
        item.appendChild(label)
        // mousedown, not click, so the selection happens before the field's blur can commit or the
        // menu can be torn down. On mobile the pointer/mouse/blur ordering in the Android webview is
        // unreliable, so pointerdown is used instead: it fires for touch, is cancelable (so
        // preventDefault keeps the field focused and the soft keyboard up), and precedes the synthesised
        // mousedown and any blur, so the pick commits before the menu can be torn down.
        var pickEvent = IS_MOBILE ? 'pointerdown' : 'mousedown'
        item.addEventListener(pickEvent, event => {
            event.preventDefault()
            applySearchSuggestion(input, suggestion)
        })
        menu.appendChild(item)
    })
    row.appendChild(menu)
}

function paintSearchSuggestionActive(){
    var menu = document.getElementById('searchSuggestions')
    if (!menu || !searchSuggestion) return
    var items = menu.querySelectorAll('.dropdown-item')
    for (var index = 0; index < items.length; index++){
        items[index].classList.toggle('-current', index === searchSuggestion.activeIndex)
    }
}

function hideSearchSuggestions(){
    var menu = document.getElementById('searchSuggestions')
    if (menu) menu.remove()
    searchSuggestion = null
}

/** applySearchSuggestion **************************************************************************************************************************
 * Inserts the chosen value in place of the partial token, quoting it when it contains spaces and adding a trailing space, then keeps focus and the   *
 * caret after the insertion. The search is not committed.                                                                                           *
 ***************************************************************************************************************************************************/
function applySearchSuggestion(input, suggestion){
    if (!input || !searchSuggestion) return
    var token = searchSuggestion.token
    // Strip embedded double-quotes before wrapping: a title (or tag/notebook) can itself contain a
    // quote, and Joplin's phrase syntax has no way to escape one, so a raw quote would break the
    // committed token. This matches how searchTitleSuggestions already sanitizes the query side.
    var insert = String(suggestion.insert).replace(/"/g, '')
    var needsQuote = /\s/.test(insert)
    var replacement = token.kind + ':' + (needsQuote ? '"' + insert + '"' : insert) + ' '
    var value = input.value
    input.value = value.slice(0, token.start) + replacement + value.slice(token.end)
    var caret = token.start + replacement.length
    input.focus()
    input.setSelectionRange(caret, caret)
    updateSearchDraft(input)
    hideSearchSuggestions()
}

function onSearchKeyDown(event){
    if (!searchSuggestion) return
    if (event.key === 'ArrowDown'){
        event.preventDefault()
        searchSuggestion.activeIndex = (searchSuggestion.activeIndex + 1) % searchSuggestion.items.length
        paintSearchSuggestionActive()
    } else if (event.key === 'ArrowUp'){
        event.preventDefault()
        searchSuggestion.activeIndex = (searchSuggestion.activeIndex - 1 + searchSuggestion.items.length) % searchSuggestion.items.length
        paintSearchSuggestionActive()
    } else if (event.key === 'Enter'){
        // Select the highlighted suggestion rather than committing the search on this press
        event.preventDefault()
        applySearchSuggestion(getSearchInput(), searchSuggestion.items[searchSuggestion.activeIndex])
    } else if (event.key === 'Escape'){
        event.preventDefault()
        event.stopPropagation()
        hideSearchSuggestions()
    }
}

function updateSearchDraft(input){
    searchDraft = { value: input.value, caret: input.selectionStart }
}

function onSearchFocus(){
    searchFocused = true
}

function onSearchBlur(event){
    // A refresh removes the focused field mid-typing. Some Chromium builds fire blur on that removal
    // and some do not; either way this is not a genuine blur and the draft must survive so
    // restoreSearchDraft can put it back. The removed field is already disconnected from the document
    // when its removal-blur fires, so ignore a blur whose target is no longer connected.
    if (event && event.target && event.target.isConnected === false) return
    searchFocused = false
    // The user left the field without committing, so the uncommitted draft is abandoned. Drop it, or a
    // later focus + refresh would resurrect this stale text over the freshly rendered field.
    searchDraft = null
    hideSearchSuggestions()
}

/** restoreSearchDraft *****************************************************************************************************************************
 * After a refresh replaced the panel while the user was typing an uncommitted search, this puts the draft text, caret and focus back. onSearchBlur   *
 * ignores the blur fired when the focused field is removed, so searchFocused still reflects that the user was in the field.                          *
 ***************************************************************************************************************************************************/
function restoreSearchDraft(){
    if (!searchDraft || !searchFocused) return
    var input = getSearchInput()
    if (!input) return
    input.value = searchDraft.value
    input.focus()
    var caret = Math.min(searchDraft.caret, input.value.length)
    input.setSelectionRange(caret, caret)
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


/** onSynchronizeClicked ****************************************************************************************************************************
 * Starts a synchronisation (or cancels the one in progress - Joplin's command is a toggle). The button's spinning state and tooltip are driven by     *
 * the plugin, which re-renders the panel on the sync start and complete events.                                                                      *
 ***************************************************************************************************************************************************/
 async function onSynchronizeClicked(){
    await webviewApi.postMessage(['synchronizeClicked']);
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
    savedTodosScrollTop = 0
    await webviewApi.postMessage(['calendarNavigate', delta]);
}

/** onCalendarToday *********************************************************************************************************************************
 * Returns the calendar to the current month or week                                                                                                *
 ***************************************************************************************************************************************************/
async function onCalendarToday(){
    savedTodosScrollTop = 0
    await webviewApi.postMessage(['calendarToday']);
}

/** onCalendarDaySelected ***************************************************************************************************************************
 * Lists the to-dos of the given day under the month grid, or hides them again when that day is already selected                                     *
 ***************************************************************************************************************************************************/
async function onCalendarDaySelected(isoDate){
    await webviewApi.postMessage(['calendarDaySelected', isoDate]);
}

/** In-panel overlays (mobile) **********************************************************************************************************************
 * On mobile every Joplin plugin dialog opens BEHIND the panel (the panel viewer is a native window that always draws above the dialog's in-tree      *
 * overlay - structural, unfixable from a plugin). So the frequent pickers are drawn here instead, as a fixed-position overlay layer anchored on       *
 * document.body (like the context menu and toast, so a stray host re-render cannot destroy them - though re-renders are paused via the guard below    *
 * anyway). While an overlay is open the webview posts ['dialogGuard', true]; it posts ['dialogGuard', false] on EVERY close path (OK, Cancel, Escape, *
 * an outside tap, the Android back gesture), so the host's refresh guard is always balanced and can never leak. On OK the overlay posts a result      *
 * message (notebookPicked / tagsPicked / alarm*) and the host runs the same data-API logic its desktop dialogs use. These are only ever opened on     *
 * mobile; on desktop the native dialogs are kept untouched.                                                                                          *
 ***************************************************************************************************************************************************/

// Whether an overlay is currently open, so the guard is posted exactly once per open/close.
var overlayOpen = false

function readNotebookData(){
    var node = document.getElementById('cockpitSearchData')
    if (!node) return { notebooks: [], notebookFilter: '' }
    try {
        var data = JSON.parse(node.textContent || '{}')
        return { notebooks: data.notebooks || [], notebookFilter: String(data.notebookFilter || '') }
    } catch (error) {
        return { notebooks: [], notebookFilter: '' }
    }
}

function currentNotebookFilter(){
    return readNotebookData().notebookFilter
}

/** closeOverlay ************************************************************************************************************************************
 * Removes the overlay layer and releases the refresh guard, exactly once. Called from every close path (OK, Cancel, Escape, an outside tap, the       *
 * Android back gesture), so the guard cannot leak.                                                                                                  *
 ***************************************************************************************************************************************************/
function closeOverlay(){
    var backdrop = document.getElementById('cockpitOverlay')
    if (backdrop) backdrop.remove()
    if (overlayOpen){
        overlayOpen = false
        document.removeEventListener('keydown', overlayKeydown, true)
        void webviewApi.postMessage(['dialogGuard', false]);
    }
}

function overlayKeydown(event){
    if (event.key === 'Escape'){
        // Swallow the Escape so it does not also reach the context-menu / suggestion Escape handlers.
        event.preventDefault()
        event.stopPropagation()
        closeOverlay()
    }
}

/** buildOverlay ************************************************************************************************************************************
 * Creates the overlay shell (backdrop + panel with a header, a body and a footer of buttons) and opens it. footerButtons is an array of              *
 * { label, kind, onClick }; kind "primary" / "danger" style the button, and onClick runs with the panel element so a handler can read its inputs.     *
 * A tap on the backdrop outside the panel, or Escape, closes without committing. Returns the body element so the caller can fill it.                  *
 ***************************************************************************************************************************************************/
function buildOverlay(titleText, footerButtons){
    // Only one overlay at a time; replacing one balances its guard via closeOverlay first.
    if (overlayOpen) closeOverlay()
    overlayOpen = true
    void webviewApi.postMessage(['dialogGuard', true]);

    var backdrop = document.createElement('div')
    backdrop.id = 'cockpitOverlay'
    var panelEl = document.createElement('div')
    panelEl.className = 'cockpit-overlay-panel'

    var header = document.createElement('div')
    header.className = 'cockpit-overlay-header'
    header.textContent = titleText
    var body = document.createElement('div')
    body.className = 'cockpit-overlay-body'
    var footer = document.createElement('div')
    footer.className = 'cockpit-overlay-footer'
    for (var spec of footerButtons){
        var button = document.createElement('button')
        button.type = 'button'
        button.textContent = spec.label
        if (spec.kind) button.classList.add('-' + spec.kind)
        button.addEventListener('click', (function(handler){ return function(){ handler(panelEl) } })(spec.onClick))
        footer.appendChild(button)
    }

    panelEl.appendChild(header)
    panelEl.appendChild(body)
    panelEl.appendChild(footer)
    backdrop.appendChild(panelEl)
    // A tap on the backdrop itself (not the panel) closes without committing.
    backdrop.addEventListener('pointerdown', function(event){
        if (event.target === backdrop){ event.preventDefault(); closeOverlay() }
    })
    document.body.appendChild(backdrop)
    document.addEventListener('keydown', overlayKeydown, true)
    return body
}

/** openNotebookOverlay *****************************************************************************************************************************
 * The in-panel notebook picker. purpose says which flow opened it (moveNotes, moveNotebookUnder, createNote, createTodo) and is echoed back in the    *
 * notebookPicked result so the host runs the matching data-API logic. opts carries the flow's extra payload: noteIDs (moveNotes), sourceFolderId       *
 * (moveNotebookUnder) and includeRoot (offer a "(top level)" row, sent as an empty id). A row is selected on tap; OK commits the selection.           *
 ***************************************************************************************************************************************************/
var overlayNotebookSelection = null

function openNotebookOverlay(purpose, opts){
    opts = opts || {}
    var titles = {
        moveNotes: 'Move to notebook',
        moveNotebookUnder: 'Move notebook under...',
        createNote: 'Create note in notebook',
        createTodo: 'Create to-do in notebook',
    }
    overlayNotebookSelection = null
    var body = buildOverlay(titles[purpose] || 'Select notebook', [
        { label: 'Cancel', onClick: function(){ closeOverlay() } },
        { label: 'OK', kind: 'primary', onClick: function(){
            if (overlayNotebookSelection === null) return
            var extra = purpose === 'moveNotes' ? (opts.noteIDs || [])
                      : purpose === 'moveNotebookUnder' ? String(opts.sourceFolderId || '')
                      : undefined
            void webviewApi.postMessage(['notebookPicked', purpose, overlayNotebookSelection, extra]);
            closeOverlay()
        } },
    ])

    var list = document.createElement('div')
    list.className = 'cockpit-overlay-list'
    var rows = []
    function makeRow(id, label){
        var row = document.createElement('div')
        row.className = 'cockpit-overlay-item'
        row.textContent = label
        row.addEventListener('click', function(){
            overlayNotebookSelection = id
            for (var other of rows) other.classList.remove('-selected')
            row.classList.add('-selected')
        })
        rows.push(row)
        list.appendChild(row)
    }
    if (opts.includeRoot) makeRow('', '(top level)')
    for (var notebook of readNotebookData().notebooks){
        makeRow(String(notebook.id), String(notebook.path))
    }
    body.appendChild(list)
}

/** openTagOverlay **********************************************************************************************************************************
 * The in-panel tag picker: a single comma-separated input prefilled with the note's current tags, fetched with the getNoteTags round-trip (the host   *
 * knows the tags, the webview does not). On OK it posts tagsPicked with the desired titles; the host keeps the diff/attach/detach logic.              *
 ***************************************************************************************************************************************************/
function openTagOverlay(noteID){
    var input = document.createElement('input')
    input.className = 'cockpit-overlay-input'
    input.type = 'text'
    input.setAttribute('inputmode', 'text')
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('autocorrect', 'off')
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('spellcheck', 'false')

    var body = buildOverlay('Tags (comma separated)', [
        { label: 'Cancel', onClick: function(){ closeOverlay() } },
        { label: 'OK', kind: 'primary', onClick: function(){
            void webviewApi.postMessage(['tagsPicked', noteID, input.value]);
            closeOverlay()
        } },
    ])
    body.appendChild(input)

    // Prefill from the host, then focus. If the round-trip fails the input is simply left empty.
    webviewApi.postMessage(['getNoteTags', noteID]).then(function(csv){
        // Ignore a late reply if the overlay was already closed.
        if (!overlayOpen || !input.isConnected) return
        input.value = String(csv || '')
    }).catch(function(){})
    input.focus()
}

/** Alarm overlay (mobile) **************************************************************************************************************************
 * The "Move to date" / set-alarm picker, drawn in-panel on mobile (the desktop alarm DIALOG is unchanged). The calendar grid and hour/minute columns  *
 * are ported from alarmWebview.js unchanged - they read and write their own #alarm* elements by id, so they work the same inside the overlay body -    *
 * minus that file's dialog-only bootstrap (its MutationObserver / init / platform-class helper): openAlarmOverlay draws them directly instead. The     *
 * fields start at the first to-do's due time (or the day start today), fetched with the getAlarmInitial round-trip. OK posts ['alarmSet', ids, date,  *
 * time], Clear posts ['alarmCleared', ids], and the host keeps parseAlarmFields + setTodoDueTimestamps. The ported names are all alarm*-prefixed and   *
 * collide with nothing else in this file.                                                                                                            *
 ***************************************************************************************************************************************************/

// The first day of the month the calendar is showing. Reset from the date field every time the overlay opens.
var alarmCalendarAnchor = null

function alarmPad(value){ return String(value).padStart(2, '0') }

function alarmDateToISO(date){
    return `${date.getFullYear()}-${alarmPad(date.getMonth() + 1)}-${alarmPad(date.getDate())}`
}

function alarmParseISO(value){
    var match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim())
    if (!match) return null
    var parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (parsed.getFullYear() !== Number(match[1]) || parsed.getMonth() !== Number(match[2]) - 1 || parsed.getDate() !== Number(match[3])) return null
    return parsed
}

function setAlarmDateOffset(days){
    var date = new Date()
    date.setDate(date.getDate() + days)
    document.getElementById('alarmDate').value = alarmDateToISO(date)
    alarmCalendarAnchor = new Date(date.getFullYear(), date.getMonth(), 1)
    renderAlarmCalendar()
}

function setAlarmDateNextMonth(){
    var current = alarmParseISO(document.getElementById('alarmDate').value) || new Date()
    var weekday = current.getDay()
    var ordinal = Math.floor((current.getDate() - 1) / 7)
    var firstOfNext = new Date(current.getFullYear(), current.getMonth() + 1, 1)
    var day = 1 + ((weekday - firstOfNext.getDay() + 7) % 7) + ordinal * 7
    var daysInNext = new Date(firstOfNext.getFullYear(), firstOfNext.getMonth() + 1, 0).getDate()
    while (day > daysInNext) day -= 7
    var target = new Date(firstOfNext.getFullYear(), firstOfNext.getMonth(), day)
    document.getElementById('alarmDate').value = alarmDateToISO(target)
    alarmCalendarAnchor = new Date(target.getFullYear(), target.getMonth(), 1)
    renderAlarmCalendar()
}

function onAlarmCalendarNavigate(delta){
    alarmCalendarAnchor = new Date(alarmCalendarAnchor.getFullYear(), alarmCalendarAnchor.getMonth() + delta, 1)
    renderAlarmCalendar()
}

function pickAlarmDay(isoDate){
    document.getElementById('alarmDate').value = isoDate
    renderAlarmCalendar()
}

function onAlarmDateEdited(){
    var parsed = alarmParseISO(document.getElementById('alarmDate').value)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    renderAlarmCalendar()
}

function renderAlarmCalendar(){
    var container = document.getElementById('alarmCalendar')
    if (!container) return
    var selected = alarmParseISO(document.getElementById('alarmDate').value)
    if (!alarmCalendarAnchor){
        var base = selected || new Date()
        alarmCalendarAnchor = new Date(base.getFullYear(), base.getMonth(), 1)
    }
    var anchor = alarmCalendarAnchor
    var title = anchor.toLocaleDateString('en', { month: 'long', year: 'numeric' })
    var todayISO = alarmDateToISO(new Date())
    var selectedISO = selected ? alarmDateToISO(selected) : null

    var firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    var day = new Date(firstOfMonth)
    day.setDate(firstOfMonth.getDate() - ((firstOfMonth.getDay() + 6) % 7))
    var end = new Date(day)
    end.setDate(day.getDate() + 41)

    var headers = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(label => `<th>${label}</th>`).join('')
    var rows = '', cells = '', column = 0
    while (day <= end){
        var iso = alarmDateToISO(day)
        var classes = ['alarm-cal-day']
        if (day.getMonth() !== anchor.getMonth()) classes.push('-outside')
        if (iso === todayISO) classes.push('-today')
        if (iso === selectedISO) classes.push('-selected')
        cells += `<td><button type="button" class="${classes.join(' ')}" onclick="pickAlarmDay('${iso}')">${day.getDate()}</button></td>`
        if (++column === 7){
            rows += `<tr>${cells}</tr>`
            cells = ''
            column = 0
        }
        day.setDate(day.getDate() + 1)
    }

    container.innerHTML = `
        <div class="alarm-cal-nav">
            <button type="button" title="Previous month" onclick="onAlarmCalendarNavigate(-1)">&#8249;</button>
            <span class="alarm-cal-title">${title}</span>
            <button type="button" title="Next month" onclick="onAlarmCalendarNavigate(1)">&#8250;</button>
        </div>
        <table class="alarm-cal-grid"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
    `
}

function currentAlarmTime(){
    var match = /^(\d{1,2}):(\d{2})$/.exec(String(document.getElementById('alarmTime').value || '').trim())
    if (!match) return { hours: null, minutes: null }
    var hours = Number(match[1]), minutes = Number(match[2])
    return { hours: hours <= 23 ? hours : null, minutes: minutes <= 59 ? minutes : null }
}

function pickAlarmHour(hours){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(hours)}:${alarmPad(time.minutes === null ? 0 : time.minutes)}`
    updateAlarmTimeSelection()
}

function pickAlarmMinute(minutes){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(time.hours === null ? 9 : time.hours)}:${alarmPad(minutes)}`
    updateAlarmTimeSelection()
}

function onAlarmTimeEdited(){ updateAlarmTimeSelection() }

function updateAlarmTimeSelection(){
    var time = currentAlarmTime()
    for (var button of document.querySelectorAll('.alarm-time-item')){
        var isHour = button.dataset.hour !== undefined
        var value = Number(isHour ? button.dataset.hour : button.dataset.minute)
        button.classList.toggle('-selected', value === (isHour ? time.hours : time.minutes))
    }
}

function renderAlarmTimeColumns(){
    var hourColumn = document.getElementById('alarmHourCol')
    var minuteColumn = document.getElementById('alarmMinuteCol')
    if (!hourColumn || !minuteColumn) return
    var hourButtons = '', minuteButtons = ''
    for (var hour = 0; hour < 24; hour++){
        hourButtons += `<button type="button" class="alarm-time-item" data-hour="${hour}" onclick="pickAlarmHour(${hour})">${alarmPad(hour)}</button>`
    }
    for (var minute = 0; minute < 60; minute++){
        minuteButtons += `<button type="button" class="alarm-time-item" data-minute="${minute}" onclick="pickAlarmMinute(${minute})">${alarmPad(minute)}</button>`
    }
    hourColumn.innerHTML = hourButtons
    minuteColumn.innerHTML = minuteButtons
    updateAlarmTimeSelection()
    var time = currentAlarmTime()
    scrollAlarmColumn(hourColumn, time.hours === null ? 9 : time.hours, 24)
    scrollAlarmColumn(minuteColumn, time.minutes === null ? 0 : time.minutes, 60)
}

function scrollAlarmColumn(column, index, total){
    column.scrollTop = Math.max(0, (column.scrollHeight * index / total) - (column.clientHeight / 2))
}

/** openAlarmOverlay ********************************************************************************************************************************
 * Builds the alarm overlay for the given to-dos, prefills its fields from the host, and draws the calendar + time columns. OK / Clear alarm / Cancel  *
 * are the footer buttons.                                                                                                                            *
 ***************************************************************************************************************************************************/
function openAlarmOverlay(ids){
    ids = ids || []
    if (!ids.length) return
    var count = ids.length === 1 ? '1 to-do' : ids.length + ' to-dos'
    var body = buildOverlay('Set alarm for ' + count, [
        { label: 'Cancel', onClick: function(){ closeOverlay() } },
        { label: 'Clear alarm', kind: 'danger', onClick: function(){
            void webviewApi.postMessage(['alarmCleared', ids]);
            closeOverlay()
        } },
        { label: 'OK', kind: 'primary', onClick: function(){
            var date = document.getElementById('alarmDate').value
            var time = document.getElementById('alarmTime').value
            void webviewApi.postMessage(['alarmSet', ids, date, time]);
            closeOverlay()
        } },
    ])
    body.classList.add('cockpit-alarm-overlay')
    body.innerHTML = `
        <div id="alarmFields">
            <input id="alarmDate" placeholder="YYYY-MM-DD" oninput="onAlarmDateEdited()"
                inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            <input id="alarmTime" placeholder="HH:MM" oninput="onAlarmTimeEdited()"
                inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </div>
        <div id="alarmBody">
            <div id="alarmCalendar"></div>
            <div id="alarmTimePanel">
                <div class="alarm-time-col" id="alarmHourCol"></div>
                <div class="alarm-time-col" id="alarmMinuteCol"></div>
            </div>
        </div>
        <div id="alarmQuick">
            <button type="button" onclick="setAlarmDateOffset(0)">Today</button>
            <button type="button" onclick="setAlarmDateOffset(1)">Tomorrow</button>
            <button type="button" onclick="setAlarmDateOffset(7)">+1 week</button>
            <button type="button" title="Same weekday next month: the 2nd Saturday stays the 2nd Saturday" onclick="setAlarmDateNextMonth()">+month</button>
        </div>
    `

    // Prefill the fields from the host, then draw the calendar and time columns from those values.
    webviewApi.postMessage(['getAlarmInitial', ids]).then(function(init){
        if (!overlayOpen) return   // closed while awaiting
        init = init || {}
        var dateEl = document.getElementById('alarmDate')
        var timeEl = document.getElementById('alarmTime')
        if (!dateEl || !timeEl) return
        dateEl.value = String(init.date || '')
        timeEl.value = String(init.time || '')
        alarmCalendarAnchor = null
        renderAlarmCalendar()
        renderAlarmTimeColumns()
    }).catch(function(){})
}
