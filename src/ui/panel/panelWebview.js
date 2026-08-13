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
function reconcile(){
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
    new MutationObserver(reconcile).observe(document.body, { childList: true, subtree: true })
}

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
        // menu can be torn down
        item.addEventListener('mousedown', event => {
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
