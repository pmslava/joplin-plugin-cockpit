/** onTodoClicked ***********************************************************************************************************************************
 * When a todo item is clicked, this function sends a message to the main plugin containing the todo id                                             *
 ***************************************************************************************************************************************************/
async function onTodoClicked(todoID){
    await webviewApi.postMessage(['todoClicked', todoID]);
}

/** Selection ***************************************************************************************************************************************
 * Which to-dos are selected, so that several can be dragged together. Ctrl+click (or Cmd+click) toggles a to-do, Shift+click selects the range from *
 * the previous click, and a plain click on a row opens the to-do (title too). The panel markup is replaced on every refresh, so the selection is    *
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

/** Scroll position posted to the plugin *****************************************************************************************************************
 * On desktop the scroll position survives in savedTodosScrollTop above (setHtml keeps this module state). On mobile every setHtml is a FULL WEBVIEW    *
 * RELOAD that destroys this module state, so the plugin has to be the source of truth: the .todos scroll handler posts the position (throttled) to the *
 * host, which stores it and embeds it as data-scroll-top into every render. On the next (re)load reconcile reads that attribute back when its own      *
 * module state is 0. The post carries the render nonce embedded in the current markup so the host can drop a late post from an outgoing webview whose   *
 * position has already been deliberately reset (see panel.ts). This is unified: it also runs on desktop, where it merely hardens the same behaviour.   *
 ***************************************************************************************************************************************************/
var scrollPostTimer = null
var lastPostedScrollTop = -1

function queueScrollPost(el, nonce){
    // Trailing-edge throttle: the first scroll arms a 300ms timer; the latest position is read when it
    // fires. A move of 4px or less is treated as noise and not posted.
    if (scrollPostTimer) return
    scrollPostTimer = setTimeout(function(){
        scrollPostTimer = null
        var top = el.scrollTop
        if (Math.abs(top - lastPostedScrollTop) <= 4) return
        lastPostedScrollTop = top
        void webviewApi.postMessage(['scrollChanged', top, nonce])
    }, 300)
}

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

/** Effective Joplin appearance *********************************************************************************************************************
 * Joplin injects its colour variables into plugin webviews, but deliberately omits its `appearance` value. OS `prefers-color-scheme` is not a       *
 * substitute because users can choose a Joplin theme independently of the OS. When Cockpit is in Match Joplin mode, resolve Joplin's effective      *
 * scheme-1 foreground/background pair on a hidden probe and compare their luminance. A dark palette has a lighter foreground than background. The    *
 * resulting class restores the established Dark-theme heading and selection semantics in panel.css; explicit Cockpit presets/custom themes are      *
 * excluded by the --cockpit-match-joplin marker emitted by buildThemeCss().                                                                          *
 ***************************************************************************************************************************************************/
var themeAppearanceProbe = null
var themeAppearanceFrame = null
var themeAppearanceObserverStarted = false

function themeColourLuminance(value){
    var values = String(value || '').match(/[\d.]+/g)
    if (!values || values.length < 3) return null
    var channels = values.slice(0, 3).map(function(value){
        var srgb = Number(value) / 255
        return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4)
    })
    if (channels.some(function(value){ return !Number.isFinite(value) })) return null
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function getThemeAppearanceProbe(){
    if (themeAppearanceProbe && themeAppearanceProbe.isConnected) return themeAppearanceProbe
    themeAppearanceProbe = document.createElement('span')
    themeAppearanceProbe.id = 'cockpitThemeAppearanceProbe'
    themeAppearanceProbe.setAttribute('aria-hidden', 'true')
    themeAppearanceProbe.style.cssText = [
        'position:fixed',
        'width:0',
        'height:0',
        'overflow:hidden',
        'visibility:hidden',
        'pointer-events:none',
        // Classify Joplin itself, not a user override of Cockpit's public colour variables.
        'color:var(--joplin-color, rgb(0, 0, 0))',
        'background-color:var(--joplin-background-color, rgb(255, 255, 255))',
    ].join(';')
    document.body.appendChild(themeAppearanceProbe)
    return themeAppearanceProbe
}

function applyEffectiveThemeClass(){
    var root = document.documentElement
    var followsJoplin = getComputedStyle(root).getPropertyValue('--cockpit-match-joplin').trim() === '1'
    if (!followsJoplin){
        root.classList.remove('cockpit-dark-appearance')
        return
    }

    var probeStyle = getComputedStyle(getThemeAppearanceProbe())
    var foregroundLuminance = themeColourLuminance(probeStyle.color)
    var backgroundLuminance = themeColourLuminance(probeStyle.backgroundColor)
    if (foregroundLuminance == null || backgroundLuminance == null){
        root.classList.remove('cockpit-dark-appearance')
        return
    }
    root.classList.toggle('cockpit-dark-appearance', backgroundLuminance < foregroundLuminance)
}

function scheduleEffectiveThemeClass(){
    if (themeAppearanceFrame != null) return
    themeAppearanceFrame = requestAnimationFrame(function(){
        themeAppearanceFrame = null
        applyEffectiveThemeClass()
    })
}

function startThemeAppearanceObserver(){
    if (themeAppearanceObserverStarted) return
    themeAppearanceObserverStarted = true

    // A capturing load listener fires after a replacement stylesheet has actually loaded. The head
    // observer also covers inline style replacement and href changes; both paths are coalesced into
    // one animation-frame read so a Joplin theme switch updates without waiting for Cockpit's timer.
    document.addEventListener('load', function(event){
        if (event.target && event.target.tagName === 'LINK') scheduleEffectiveThemeClass()
    }, true)
    if (document.head){
        new MutationObserver(scheduleEffectiveThemeClass).observe(document.head, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'media', 'disabled'],
        })
    }
    applyEffectiveThemeClass()
}

function reconcile(){
    // Refresh IS_MOBILE and the class on every render (the marker is re-emitted each time); it must run
    // unconditionally, not only when the .todos node identity changes, so the flag is set before the
    // first pointer event even on renders that reuse the scroll container.
    applyPlatformClass()
    // The inline theme marker can change when Cockpit settings re-render the panel. Host Joplin
    // stylesheet changes are covered separately by startThemeAppearanceObserver().
    scheduleEffectiveThemeClass()
    var el = document.querySelector('.todos')
    if (el && el !== currentTodosEl){
        currentTodosEl = el
        // The render nonce embedded in this markup; posted back with every scrollChanged so the host can
        // drop a stale post from an outgoing webview whose scroll it has already deliberately reset.
        var nonce = Number(el.dataset.renderNonce || 0)
        // Save on genuine user scroll only; ignore the programmatic restore below (and any scroll-to-0
        // fired as the old node is detached), which restoringScroll guards. On a genuine scroll also post
        // the position to the host (throttled), so it survives the mobile reload.
        el.addEventListener('scroll', () => {
            if (restoringScroll) return
            savedTodosScrollTop = el.scrollTop
            queueScrollPost(el, nonce)
        })
        // Mobile only: its module state was zeroed by the reload, so fall through to the embedded
        // data-scroll-top. Desktop keeps its surviving module state untouched - byte-identical to the
        // baseline - and must NOT consult the embed, because there a live savedTodosScrollTop of 0 means
        // "genuinely at top" and the embed can lag it (throttled/nonce-guarded), which would wrongly
        // restore a stale non-zero offset when a content-changing re-render lands at/near the top.
        if (IS_MOBILE) savedTodosScrollTop = savedTodosScrollTop || Number(el.dataset.scrollTop || 0)
        restoreTodosScroll(el)
        paintTodoSelection()
        // The suggestion menu was in the replaced markup; drop its now-stale state (closing on a
        // re-render is fine - only the typed text must survive, which restoreSearchDraft handles).
        searchSuggestion = null
        restoreSearchDraft()
        // Overlay reload-survival: when this render carries the overlay descriptor island (the host's
        // reconstruct render after a mid-overlay reload) and no overlay is open in this webview yet, rebuild
        // it from the descriptor. Mobile only; the island is never emitted on desktop.
        if (IS_MOBILE && !overlayOpen) reopenOverlayFromEmbeddedState()
    }
}

// Joplin injects plugin webview scripts after DOMContentLoaded has already fired, so gating the
// observer on that event left it never registered and every restore above was dead code. Wire it up
// at top-level instead, with a fallback for the reverse ordering just in case.
function startPanelObserver(){
    // Set IS_MOBILE from the platform marker before anything below reads it (reconcile() sets it too, but
    // the dialogGuardReset post has to know the platform first).
    applyPlatformClass()
    startThemeAppearanceObserver()
    if (IS_MOBILE){
        // Clear any overlay refresh-guard leaked by a previous webview torn down mid-overlay, and drive the
        // overlay reload-survival handshake. message[1] tells the host whether THIS freshly loaded document
        // already carries the overlay descriptor island: when it does, reconcile() below rebuilds the
        // overlay itself and the host must not force another render; when it does not (a host reload that
        // re-served the stale pre-overlay snapshot), the host re-renders once with the descriptor embedded.
        // Posted BEFORE reconcile() so the leaked guard is zeroed first and reconcile's rebuild re-arms it
        // cleanly afterwards. A no-op on an ordinary fresh load (no descriptor, no leaked guard).
        var stateText = readEmbeddedOverlayStateText()
        void webviewApi.postMessage(['dialogGuardReset', !!stateText]);
    }
    reconcile()
    new MutationObserver(reconcile).observe(document.body, { childList: true, subtree: true })
}

// The Android back gesture (when it pops webview history rather than the whole viewer) closes an open
// overlay instead of navigating, so the guard is released down the same closeOverlay path.
window.addEventListener('popstate', function(){ if (overlayOpen) closeOverlay() })

// NOTE: startPanelObserver() is invoked at the very BOTTOM of this file, not here. On a mobile
// reload-with-descriptor it reconstructs the open overlay synchronously (reconcile ->
// reopenOverlayFromEmbeddedState -> openNotebookOverlay/openTagOverlay/openAlarmOverlay/openEditorOverlay),
// which sets the overlay module state (overlayOpen, overlayContext, overlayNotebookSelection,
// alarmCalendarAnchor, ...). Those variables are declared with initializers further down the file, so
// invoking the bootstrap here (above them) would let their `var x = <initial>` initializers run AFTER the
// reconstruct and clobber the freshly-set state back to its defaults - leaving overlayOpen=false while the
// overlay is on screen and the guard is armed, so closing it never posts dialogGuard(false) and refreshes
// stay frozen. Deferring the call to the end of the script guarantees every initializer has already run.

/** onTodoRowMouseDown ******************************************************************************************************************************
 * Selection happens on press, like in a list: a plain press selects the row (replacing the selection), Ctrl+press toggles it, Shift+press selects   *
 * the range from the last plainly- or Ctrl-pressed row (the anchor). The anchor stays put, so a further Shift+press resizes the range rather than   *
 * chaining from its end. Opening happens separately, on click.                                                                                     *
 ***************************************************************************************************************************************************/
function onTodoRowMouseDown(event, todoID){
    if (event.button !== 0) return
    if (event.target.classList.contains('todo-checkbox')) return
    // A press on the notebook pill filters by that notebook on the following click; it takes no part in
    // selection, so leave the current selection untouched (like the checkbox above).
    if (event.target.classList.contains('todo-notebook')) return
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

/** applyNotebookFilterFromPill *********************************************************************************************************************
 * A left click (or a mobile tap) on a row's notebook pill applies that notebook as the panel's notebook filter, posting the same message the        *
 * notebook dropdown posts. Like the dropdown path it zeroes the saved scroll first, so the filtered list starts at the top rather than restoring the *
 * old pixel offset (which would point at unrelated rows). The pill carries its notebook id in data-notebook-id (see renderTodoRow /                  *
 * renderNotesSection in formats.ts). On mobile a completed long press on the pill opens "move to notebook" instead; the click the browser then        *
 * synthesises is swallowed by the click listener below (longPress.fired), so this filter never also fires - a tap filters, a long press moves.        *
 ***************************************************************************************************************************************************/
function applyNotebookFilterFromPill(pill){
    var notebookID = pill && pill.dataset ? (pill.dataset.notebookId || '') : ''
    if (!notebookID) return
    savedTodosScrollTop = 0
    void webviewApi.postMessage(['notebookFilterChanged', notebookID]);
}

function onTodoRowClicked(event, todoID){
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.target.classList.contains('todo-checkbox')) return
    if (event.target.classList.contains('todo-notebook')){
        applyNotebookFilterFromPill(event.target)
        return
    }
    // Any plain left click that reaches here opens the to-do: the tick circle and the notebook pill
    // returned above (they do their own thing), and a modifier click returned at the top (selection
    // only), so what is left is the title OR the row's own dead zones - its padding, the gap beside a
    // short title, the strip below it. Opening on all of them makes a click that selects a row also show
    // it in the editor, matching the title. onTodoRowMouseDown has already maintained the selection.
    void onTodoClicked(todoID)
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
    // A press on the notebook pill filters by that notebook on the following click and takes no part in
    // selection, so leave the current pick untouched.
    if (event.target.classList.contains('todo-notebook')) return
    selectedTodoIDs.clear()
    pickedNoteID = noteID
    paintTodoSelection()
}

function onNoteRowClicked(event, noteID){
    if (event.target.classList.contains('todo-notebook')){
        applyNotebookFilterFromPill(event.target)
        return
    }
    // Mirrors onTodoRowClicked: any other left click opens the note - the title, the display-only
    // progress ring, and the row's dead zones alike. The notebook pill returned above; a note row has no
    // tickable checkbox, so there is nothing else to guard. onNoteRowMouseDown has already picked the row.
    void onTodoClicked(noteID)
}

/** onRowDoubleClicked ******************************************************************************************************************************
 * Double clicking a title opens the note in its own window, like in Joplin's note list. Desktop only: mobile has no separate windows, so the        *
 * openNoteInNewWindow command is absent there and a double-tap only reached the "not available here" box. Guarded to a no-op on mobile (where the    *
 * gesture is instead a fast double-tap during scrolling/reading), leaving the desktop double-click path byte-identical.                             *
 ***************************************************************************************************************************************************/
function onRowDoubleClicked(event, noteID){
    if (IS_MOBILE) return
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
 * When a to-do's checkbox is ticked, this sends the id AND the state the tick just set to the plugin. The browser has already flipped the checkbox   *
 * in the DOM, so passing that state lets the host write it with a single idempotent PUT (no read-modify-write) and hold it optimistically, instead of *
 * inferring the intended state from a search that has not caught up yet.                                                                             *
 ***************************************************************************************************************************************************/
async function onTodoChecked(todoID, checked){
    await webviewApi.postMessage(['todoChecked', todoID, checked]);
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
    // The profile editor is an in-panel overlay on mobile (a native dialog would open behind the panel);
    // desktop still posts createProfileClicked and gets the native editor dialog.
    if (IS_MOBILE && messageName === 'createProfileClicked'){ openEditorOverlay(); return }
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
    // Editing a profile opens the in-panel editor overlay on mobile; desktop keeps the native editor dialog.
    if (IS_MOBILE && messageName === 'editProfileClicked'){ openEditorOverlay(value); return }
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
 * Inserts the chosen value in place of the partial token, quoting it when it contains spaces and adding a trailing space, then commits the search    *
 * so picking a suggestion shows its results at once (pick -> see results), which is what the user expects. The field keeps focus for continued        *
 * typing: on desktop restoreSearchDraft refocuses the freshly rendered input (caret at end) after the commit's re-render; on mobile the commit's       *
 * paint is held until blur, exactly as the existing search-focus hold already does.                                                                   *
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
    // Commit the picked value. onSearchFilterChanged clears the (now moot) draft and posts the search; the
    // caret settles at the end of the committed text after the re-render's refocus.
    onSearchFilterChanged(input.value)
}

function onSearchKeyDown(event){
    if (!searchSuggestion){
        // No suggestion menu is open, so Enter commits the search. Joplin's Electron webview does not fire
        // the field's change/search events on Enter (only on blur or the clear button), so the commit is
        // issued explicitly here; onchange/onsearch stay wired as fallbacks and any resulting double-commit
        // is collapsed by the host's equality guard (identical value -> identical markup -> no re-render).
        // The field keeps focus: restoreSearchDraft refocuses the freshly rendered input (caret at end) after
        // the desktop re-render, while on mobile the paint stays held until blur exactly as before.
        if (event.key === 'Enter'){
            event.preventDefault()
            var searchInput = getSearchInput()
            if (searchInput) onSearchFilterChanged(searchInput.value)
        }
        return
    }
    if (event.key === 'ArrowDown'){
        event.preventDefault()
        searchSuggestion.activeIndex = (searchSuggestion.activeIndex + 1) % searchSuggestion.items.length
        paintSearchSuggestionActive()
    } else if (event.key === 'ArrowUp'){
        event.preventDefault()
        searchSuggestion.activeIndex = (searchSuggestion.activeIndex - 1 + searchSuggestion.items.length) % searchSuggestion.items.length
        paintSearchSuggestionActive()
    } else if (event.key === 'Enter'){
        // Pick the highlighted suggestion; applySearchSuggestion inserts it AND commits (pick -> see results).
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
    // Mobile only: hold the host's refreshes while the field is focused, so a setHtml (a full webview
    // reload on mobile) cannot wipe the input, caret, suggestion list or soft keyboard mid-typing. The
    // host releases the hold and runs the held refresh on blur. Desktop keeps its module-state draft
    // restore instead, so it does not post this (and the host guard is mobile-gated anyway).
    if (IS_MOBILE) void webviewApi.postMessage(['searchFocusChanged', true]);
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
    // Release the mobile refresh hold armed on focus, so the host runs any refresh it skipped while the
    // field was focused. A commit (Enter / clear) also posts searchFilterChanged right after, which the
    // host's equality guard collapses to a single render. Mobile only, matching onSearchFocus.
    if (IS_MOBILE) void webviewApi.postMessage(['searchFocusChanged', false]);
}

/** restoreSearchDraft *****************************************************************************************************************************
 * After a refresh replaced the panel while the user was in the search field, this puts focus (and, when present, the uncommitted draft text/caret)   *
 * back. onSearchBlur ignores the blur fired when the focused field is removed, so searchFocused still reflects that the user was in the field, and a  *
 * genuine blur clears searchFocused so no focus is stolen back after the user has left. Two cases:                                                    *
 *  - an uncommitted draft survived the refresh: restore its text and caret;                                                                           *
 *  - the refresh was triggered by a commit-with-focus (Enter, or a picked suggestion, or the clear button): no draft survives a commit, but the user  *
 *    is still in the field, so refocus the freshly rendered input on its server-rendered (committed) value with the caret at the end, so continued    *
 *    typing works. This adds no new webview state - it reuses the existing searchFocused flag - so the mobile reload path is unaffected (there the     *
 *    module state is zeroed by the reload and the host-held search-focus hold drives the refresh instead).                                            *
 ***************************************************************************************************************************************************/
function restoreSearchDraft(){
    if (!searchFocused) return
    var input = getSearchInput()
    if (!input) return
    if (searchDraft){
        input.value = searchDraft.value
        input.focus()
        var caret = Math.min(searchDraft.caret, input.value.length)
        input.setSelectionRange(caret, caret)
        return
    }
    input.focus()
    var end = input.value.length
    input.setSelectionRange(end, end)
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

/** Overlay reload-survival ****************************************************************************************************************************
 * On mobile the panel WebView can be reloaded by the HOST at any moment (an Android renderer-process kill under sync load remounts it and re-serves    *
 * the last document Joplin held - the PRE-overlay snapshot, since the refresh guard blocked any newer setHtml while the overlay was up). That wipes an  *
 * open overlay. To survive it the plugin holds a small, fully-rebuildable descriptor of the open overlay: this webview posts it on open and on          *
 * (throttled) input changes, and on the next reload the host re-renders once with the descriptor embedded as a JSON island so the fresh webview can     *
 * reconstruct the overlay. overlayContext carries the static parts; currentOverlayDescriptor() reads the live field values so the posted descriptor     *
 * always reflects the latest input.                                                                                                                    *
 ***************************************************************************************************************************************************/
var overlayContext = null
var overlayStateTimer = null

function currentOverlayDescriptor(){
    if (!overlayContext) return null
    if (overlayContext.kind === 'notebook'){
        return { kind: 'notebook', purpose: overlayContext.purpose, opts: overlayContext.opts, selection: overlayNotebookSelection }
    }
    if (overlayContext.kind === 'tag'){
        var tagInput = document.querySelector('#cockpitOverlay .cockpit-overlay-input')
        return { kind: 'tag', noteID: overlayContext.noteID, text: tagInput ? tagInput.value : (overlayContext.text || '') }
    }
    if (overlayContext.kind === 'alarm'){
        var dateEl = document.getElementById('alarmDate')
        var timeEl = document.getElementById('alarmTime')
        // hasAlarm/timeUserSet ride along so a mid-overlay reload reconstructs the quick-button preservedTime state
        // (whether the shown time is kept or replaced by ceilHour); multi/mode/plan/dues carry the full plan model so
        // the mode picker, highlighted button and explanation line all come back exactly as they were.
        return { kind: 'alarm', ids: overlayContext.ids, date: dateEl ? dateEl.value : '', time: timeEl ? timeEl.value : '',
            hasAlarm: alarmHadExistingAlarm, timeUserSet: alarmTimeUserSet,
            multi: alarmIsMulti, mode: alarmMode, plan: alarmActivePlan, dues: alarmTodoDues }
    }
    if (overlayContext.kind === 'editor'){
        // The serialized form IS the descriptor's payload, so a reload rebuilds every field (incl. in-progress
        // edits) verbatim. profileID null => create mode; the footer is derived from it on reconstruct.
        return { kind: 'editor', profileID: overlayContext.profileID, values: serializeEditorForm() }
    }
    return null
}

// Post the current descriptor to the host immediately. Used on open and on discrete picks (a notebook row,
// a calendar day, an hour/minute). A null descriptor (no overlay) is a harmless no-op for the host.
function pushOverlayState(){
    void webviewApi.postMessage(['overlayState', currentOverlayDescriptor()])
}

// Trailing-edge throttle for rapid input (typing a tag, editing the date/time text), mirroring
// queueScrollPost so a burst of keystrokes posts at most once every 300ms.
function queueOverlayState(){
    if (overlayStateTimer) return
    overlayStateTimer = setTimeout(function(){ overlayStateTimer = null; pushOverlayState() }, 300)
}

// The raw text of the embedded overlay-state island (empty string when absent/null), read by
// startPanelObserver to tell the host whether this document can reconstruct the overlay itself.
function readEmbeddedOverlayStateText(){
    var node = document.getElementById('cockpitOverlayState')
    if (!node) return ''
    var text = String(node.textContent || '').trim()
    return text && text !== 'null' ? text : ''
}

// Reconstruct the overlay from the descriptor embedded in the host's reconstruct render (see reconcile).
function reopenOverlayFromEmbeddedState(){
    var text = readEmbeddedOverlayStateText()
    if (!text) return
    var state = null
    try { state = JSON.parse(text) } catch (error){ return }
    reopenOverlayFromState(state)
}

function reopenOverlayFromState(state){
    if (!state || overlayOpen) return
    if (state.kind === 'notebook') openNotebookOverlay(state.purpose, state.opts || {}, state)
    else if (state.kind === 'tag') openTagOverlay(state.noteID, state)
    else if (state.kind === 'alarm') openAlarmOverlay(state.ids || [], state)
    else if (state.kind === 'editor') openEditorOverlay(state.profileID, state)
}

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
        // Drop the reload-survival context; the host clears its held descriptor on the dialogGuard false
        // below (no separate overlayState-null message is posted, to avoid a close/refresh ordering race).
        overlayContext = null
        if (overlayStateTimer){ clearTimeout(overlayStateTimer); overlayStateTimer = null }
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

function openNotebookOverlay(purpose, opts, restore){
    opts = opts || {}
    var titles = {
        moveNotes: 'Move to notebook',
        moveNotebookUnder: 'Move notebook under...',
        createNote: 'Create note in notebook',
        createTodo: 'Create to-do in notebook',
    }
    // On a reload-survival reconstruct, start from the previously-picked row.
    overlayNotebookSelection = (restore && restore.selection != null) ? restore.selection : null
    overlayContext = { kind: 'notebook', purpose: purpose, opts: opts }
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
        // Re-mark the restored selection so a reconstructed overlay shows what was picked before the reload.
        if (overlayNotebookSelection !== null && id === overlayNotebookSelection) row.classList.add('-selected')
        row.addEventListener('click', function(){
            overlayNotebookSelection = id
            for (var other of rows) other.classList.remove('-selected')
            row.classList.add('-selected')
            pushOverlayState()
        })
        rows.push(row)
        list.appendChild(row)
    }
    if (opts.includeRoot) makeRow('', '(top level)')
    for (var notebook of readNotebookData().notebooks){
        makeRow(String(notebook.id), String(notebook.path))
    }
    body.appendChild(list)
    pushOverlayState()
}

/** openTagOverlay **********************************************************************************************************************************
 * The in-panel tag picker: a single comma-separated input prefilled with the note's current tags, fetched with the getNoteTags round-trip (the host   *
 * knows the tags, the webview does not). On OK it posts tagsPicked with the desired titles; the host keeps the diff/attach/detach logic.              *
 ***************************************************************************************************************************************************/
function openTagOverlay(noteID, restore){
    overlayContext = { kind: 'tag', noteID: noteID, text: (restore && restore.text) || '' }
    var input = document.createElement('input')
    input.className = 'cockpit-overlay-input'
    input.type = 'text'
    input.setAttribute('inputmode', 'text')
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('autocorrect', 'off')
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('spellcheck', 'false')
    // Re-post the descriptor (throttled) as the user types, so a reload reconstructs the latest text.
    input.addEventListener('input', queueOverlayState)

    var body = buildOverlay('Tags (comma separated)', [
        { label: 'Cancel', onClick: function(){ closeOverlay() } },
        { label: 'OK', kind: 'primary', onClick: function(){
            void webviewApi.postMessage(['tagsPicked', noteID, input.value]);
            closeOverlay()
        } },
    ])
    body.appendChild(input)

    if (restore){
        // Reconstruct: skip the round-trip and restore the text the user had typed before the reload.
        input.value = String(restore.text || '')
        input.focus()
        pushOverlayState()
    } else {
        // Prefill from the host, then focus. If the round-trip fails the input is simply left empty.
        // The descriptor is posted ONLY after the prefill resolves (not before): a reload landing inside
        // the sub-second prefill window would otherwise have made the host hold an EMPTY-text descriptor,
        // so a reconstruct would resurrect an empty tag input whose OK detaches every tag. Not posting until
        // the real tags are in hand means a reload strictly inside that window loses the overlay entirely,
        // which is safe (nothing to commit), while the overlay is reload-survivable for the rest of its life.
        webviewApi.postMessage(['getNoteTags', noteID]).then(function(csv){
            // Ignore a late reply if the overlay was already closed.
            if (!overlayOpen || !input.isConnected) return
            input.value = String(csv || '')
            pushOverlayState()
        }).catch(function(){})
        input.focus()
    }
}

/** Alarm overlay (mobile) **************************************************************************************************************************
 * The "Move to date" / set-alarm picker, drawn in-panel on mobile (the desktop alarm DIALOG is unchanged). The calendar grid and hour/minute columns  *
 * are ported from alarmWebview.js unchanged - they read and write their own #alarm* elements by id, so they work the same inside the overlay body -    *
 * minus that file's dialog-only bootstrap (its MutationObserver / init / platform-class helper): openAlarmOverlay draws them directly instead. The     *
 * fields start at the first to-do's due time (or the day start today), fetched with the getAlarmInitial round-trip. OK posts ['alarmSet', ids, date,  *
 * time, mode, plan], Clear posts ['alarmCleared', ids], and the host applies the plan through the shared applyAlarmPlan. The ported names are all      *
 * alarm*-prefixed and collide with nothing else in this file.                                                                                         *
 ***************************************************************************************************************************************************/

// The first day of the month the calendar is showing. Reset from the date field every time the overlay opens.
var alarmCalendarAnchor = null

// Whether the selected to-do(s) already had an alarm when the overlay opened (from the getAlarmInitial round-trip),
// and whether the user has set the time this session (typed it or picked an hour/minute). Together they drive
// preservedTime: a quick button keeps the shown clock time when EITHER is true, and substitutes ceilHour(now) only
// when BOTH are false. Both reset on open and are carried in the overlay descriptor so a mid-overlay reload restores
// them. Mirrors the desktop dialog's alarmWebview.js state, and calls the same shared window.AlarmQuick math.
var alarmHadExistingAlarm = false
var alarmTimeUserSet = false

// Multi-select plan state, mirroring alarmWebview.js. A single-select overlay leaves these at their defaults and
// shows no plan/mode. alarmMode is 'respect' (each to-do keeps its own schedule; the accumulator shifts from its own
// datetime) by default for a multi selection, or 'same' (one datetime for all, the 1.8.3 behaviour). alarmActivePlan is
// EITHER an absolute string ('today'/'tomorrow'/'weekends'/'nextMonday'/'anchor') or the row-2 accumulator OBJECT
// {hours,days,weeks,monthsDay,monthsDate}; an absolute press or manual pick resets it to a string. alarmTodoDues is
// every selected to-do's { id, due }. All ride along in the overlay descriptor so a reload restores plan + mode + dues.
var alarmIsMulti = false
var alarmMode = 'same'
var alarmActivePlan = 'anchor'
var alarmTodoDues = []

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

// Quick buttons, two rows: row 1 the absolute dates (Today / Tomorrow / Weekends / Next Monday), row 2 the
// accumulating increments (+hour / +day / +week / +month(day) / +month(date)). The date/time math lives in the
// shared, unit-tested window.AlarmQuick module (alarmQuick.js, loaded into the panel before this script); these
// wrappers only read the DOM for the arguments, write the result back, and push the overlay state so a reload
// survives. The desktop dialog wires the identical buttons to the same functions, so the math is never forked.
function alarmBaseDate(){
    return alarmParseISO(document.getElementById('alarmDate').value) || new Date()
}

function alarmPreservedTime(){
    if (!alarmHadExistingAlarm && !alarmTimeUserSet) return null
    var time = currentAlarmTime()
    if (time.hours === null || time.minutes === null) return null
    return { hours: time.hours, minutes: time.minutes }
}

function applyAlarmQuick(result){
    document.getElementById('alarmDate').value = result.date
    document.getElementById('alarmTime').value = result.time
    var parsed = alarmParseISO(result.date)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

// An ABSOLUTE (row-1) button press. It sets the plan to the absolute string, which RESETS any accumulator. In a
// multi-select overlay under RESPECT mode it only chooses the plan (each to-do keeps its own time, landing on the
// absolute date), so the anchor fields are left untouched and the explanation is re-worded; in single-select or SAME
// mode it writes the anchor fields like 1.8.3. The pressed plan is remembered and highlighted, then the overlay state
// is pushed so a reload survives.
function runAlarmQuick(plan, quickResult){
    setAlarmActivePlan(plan)
    if (!(alarmIsMulti && alarmMode === 'respect')) applyAlarmQuick(quickResult)
    updateAlarmPlanDescription()
    pushOverlayState()
}

// The single-increment field result for one row-2 press (single-select / SAME): read the current field date+time and
// apply exactly one increment of `key`, so repeated presses compound naturally through the fields.
function alarmAccumulatorFieldPress(key){
    var now = new Date(), base = alarmBaseDate(), preserved = alarmPreservedTime()
    if (key === 'hours') return AlarmQuick.hour(now, base, preserved)
    if (key === 'days') return AlarmQuick.day(now, base, preserved)
    if (key === 'weeks') return AlarmQuick.week(now, base, preserved)
    if (key === 'monthsDay') return AlarmQuick.monthWeekday(now, base, preserved)
    return AlarmQuick.monthDate(now, base, preserved)
}

// A row-2 ACCUMULATOR press. In a multi-select overlay under RESPECT mode it only accumulates the increment (each
// to-do shifts from its own schedule), leaving the anchor fields untouched; in single-select or SAME mode it also
// writes the anchor fields (one increment per press, compounding). The plan is remembered, its buttons highlighted,
// and the overlay state pushed so a reload survives.
function runAlarmAccumulator(key){
    setAlarmActivePlan(AlarmQuick.accumulate(alarmActivePlan, key))
    if (!(alarmIsMulti && alarmMode === 'respect')){
        applyAlarmQuick(alarmAccumulatorFieldPress(key))
        if (key === 'hours') alarmTimeUserSet = true
    }
    updateAlarmPlanDescription()
    pushOverlayState()
}

function onAlarmQuickToday(){ runAlarmQuick('today', AlarmQuick.today(new Date())) }
function onAlarmQuickTomorrow(){ runAlarmQuick('tomorrow', AlarmQuick.tomorrow(new Date(), alarmPreservedTime())) }
function onAlarmQuickWeekends(){ runAlarmQuick('weekends', AlarmQuick.weekends(new Date(), alarmPreservedTime())) }
function onAlarmQuickNextMonday(){ runAlarmQuick('nextMonday', AlarmQuick.monday(new Date(), alarmPreservedTime())) }

function onAlarmQuickHour(){ runAlarmAccumulator('hours') }
function onAlarmQuickDay(){ runAlarmAccumulator('days') }
function onAlarmQuickWeek(){ runAlarmAccumulator('weeks') }
function onAlarmQuickMonthWeekday(){ runAlarmAccumulator('monthsDay') }
function onAlarmQuickMonthDate(){ runAlarmAccumulator('monthsDate') }

/** Plan + mode (multi-select overlay) *************************************************************************************************************/

// The current anchor the plan is described/applied against: the two field values.
function alarmAnchor(){
    return { date: document.getElementById('alarmDate').value, time: document.getElementById('alarmTime').value }
}

// Record the active plan and move the -active highlight to the matching quick button(s): an absolute plan lights its
// single row-1 button; an accumulator plan lights every row-2 button whose counter is non-zero. The highlight is a
// multi-only affordance (single-select has no plan concept and stays visually as 1.8.3), so it is suppressed when not
// multi. Button order in the DOM: [Today, Tomorrow, Weekends, Next Monday, +hour, +day, +week, +month(day),
// +month(date)].
function setAlarmActivePlan(plan){
    alarmActivePlan = plan
    var absIndex = { today: 0, tomorrow: 1, weekends: 2, nextMonday: 3 }
    var accIndex = { hours: 4, days: 5, weeks: 6, monthsDay: 7, monthsDate: 8 }
    var isAcc = plan && typeof plan === 'object'
    var buttons = document.querySelectorAll('#alarmQuick button')
    for (var i = 0; i < buttons.length; i++){
        var active = false
        if (alarmIsMulti){
            if (isAcc){
                for (var key in accIndex){ if (accIndex[key] === i && plan[key] > 0){ active = true; break } }
            } else {
                active = absIndex[plan] === i
            }
        }
        buttons[i].classList.toggle('-active', active)
    }
}

// Re-word the explanation line (multi only) from the shared, unit-tested describeAlarmPlan. No-op for single-select.
function updateAlarmPlanDescription(){
    var line = document.getElementById('alarmExplain')
    if (!line) return
    line.textContent = AlarmQuick.describeAlarmPlan(alarmTodoDues, alarmActivePlan, alarmAnchor(), alarmMode, new Date())
}

// The mode radio changed: adopt it, re-describe the plan (keeping the pressed button), and push the overlay state.
function onAlarmModeChanged(){
    var checked = document.querySelector('#alarmMode input[name="mode"]:checked')
    alarmMode = checked && checked.value === 'same' ? 'same' : 'respect'
    updateAlarmPlanDescription()
    pushOverlayState()
}

function onAlarmCalendarNavigate(delta){
    alarmCalendarAnchor = new Date(alarmCalendarAnchor.getFullYear(), alarmCalendarAnchor.getMonth() + delta, 1)
    renderAlarmCalendar()
}

// A manual calendar pick sets the anchor date; under a multi RESPECT plan that means "set this date for all, keeping
// each to-do's own time", so the plan reverts to 'anchor'.
function pickAlarmDay(isoDate){
    document.getElementById('alarmDate').value = isoDate
    setAlarmActivePlan('anchor')
    renderAlarmCalendar()
    updateAlarmPlanDescription()
    pushOverlayState()
}

function onAlarmDateEdited(){
    var parsed = alarmParseISO(document.getElementById('alarmDate').value)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    setAlarmActivePlan('anchor')
    renderAlarmCalendar()
    updateAlarmPlanDescription()
    queueOverlayState()
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

// A manual time pick/edit updates the anchor time only (the plan is kept); under a RESPECT plan it affects just the
// no-alarm to-dos, so re-describe without changing the pressed button.
function pickAlarmHour(hours){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(hours)}:${alarmPad(time.minutes === null ? 0 : time.minutes)}`
    alarmTimeUserSet = true
    updateAlarmTimeSelection()
    updateAlarmPlanDescription()
    pushOverlayState()
}

function pickAlarmMinute(minutes){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(time.hours === null ? 9 : time.hours)}:${alarmPad(minutes)}`
    alarmTimeUserSet = true
    updateAlarmTimeSelection()
    updateAlarmPlanDescription()
    pushOverlayState()
}

function onAlarmTimeEdited(){ alarmTimeUserSet = true; updateAlarmTimeSelection(); updateAlarmPlanDescription(); queueOverlayState() }

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
function openAlarmOverlay(ids, restore){
    ids = ids || []
    if (!ids.length) return
    overlayContext = { kind: 'alarm', ids: ids }
    // Multi-vs-single is known synchronously from the selection size; the dues (for the explanation) arrive from the
    // round-trip or the restore descriptor. RESPECT is the default mode for a multi selection, SAME for single.
    var isMulti = restore ? !!restore.multi : ids.length > 1
    alarmIsMulti = isMulti
    alarmMode = isMulti ? 'respect' : 'same'
    alarmActivePlan = 'anchor'
    alarmTodoDues = []
    // Fresh open defaults; the restore branch and the prefill round-trip below set the real values.
    alarmHadExistingAlarm = false
    alarmTimeUserSet = false
    var count = ids.length === 1 ? '1 to-do' : ids.length + ' to-dos'
    // Footer order mirrors the desktop dialog (setButtons [ok, clear, cancel], alarm.ts): OK first
    // (primary emphasis), Clear alarm (destructive) middle, Cancel last. The footer right-aligns them.
    var body = buildOverlay('Set alarm for ' + count, [
        { label: 'OK', kind: 'primary', onClick: function(){
            var date = document.getElementById('alarmDate').value
            var time = document.getElementById('alarmTime').value
            // The host applies the plan through the shared applyAlarmPlan; mode + plan ride along so a multi
            // selection lands per-to-do, a single one lands the one datetime (mode 'same').
            void webviewApi.postMessage(['alarmSet', ids, date, time, alarmMode, alarmActivePlan]);
            closeOverlay()
        } },
        { label: 'Clear alarm', kind: 'danger', onClick: function(){
            void webviewApi.postMessage(['alarmCleared', ids]);
            closeOverlay()
        } },
        { label: 'Cancel', onClick: function(){ closeOverlay() } },
    ])
    body.classList.add('cockpit-alarm-overlay')
    // Layout mirrors the desktop dialog: fields -> quick buttons (above the calendar) -> calendar+columns -> mode
    // picker (multi only) -> explanation (multi only, moved below the mode picker). Single-select omits both rows.
    var explainRow = isMulti ? '<div id="alarmExplain"></div>' : ''
    var modeRow = isMulti ? `
        <div id="alarmMode">
            <label><input type="radio" name="mode" value="respect" checked onchange="onAlarmModeChanged()"> Keep each to-do's own schedule</label>
            <label><input type="radio" name="mode" value="same" onchange="onAlarmModeChanged()"> Same date &amp; time for all</label>
        </div>` : ''
    body.innerHTML = `
        <div id="alarmFields">
            <input id="alarmDate" placeholder="YYYY-MM-DD" oninput="onAlarmDateEdited()"
                inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            <input id="alarmTime" placeholder="HH:MM" oninput="onAlarmTimeEdited()"
                inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </div>
        <div id="alarmQuick">
            <div class="alarm-quick-row">
                <button type="button" onclick="onAlarmQuickToday()">Today</button>
                <button type="button" onclick="onAlarmQuickTomorrow()">Tomorrow</button>
                <button type="button" title="The nearest Saturday (today if today is Saturday)" onclick="onAlarmQuickWeekends()">Weekends</button>
                <button type="button" title="The Monday after today" onclick="onAlarmQuickNextMonday()">Next Monday</button>
            </div>
            <div class="alarm-quick-row">
                <button type="button" title="Add one hour (may cross midnight)" onclick="onAlarmQuickHour()">+hour</button>
                <button type="button" title="Add one day" onclick="onAlarmQuickDay()">+day</button>
                <button type="button" onclick="onAlarmQuickWeek()">+week</button>
                <button type="button" title="Same weekday next month: the 2nd Sunday stays the 2nd Sunday" onclick="onAlarmQuickMonthWeekday()">+month(day)</button>
                <button type="button" title="Same day-of-month next month: Jan 9 stays the 9th (Jan 31 clamps to the last day)" onclick="onAlarmQuickMonthDate()">+month(date)</button>
            </div>
        </div>
        <div id="alarmBody">
            <div id="alarmCalendar"></div>
            <div id="alarmTimePanel">
                <div class="alarm-time-col" id="alarmHourCol"></div>
                <div class="alarm-time-col" id="alarmMinuteCol"></div>
            </div>
        </div>
        ${modeRow}
        ${explainRow}
    `

    if (restore){
        // Reconstruct: restore the date/time the user had before the reload, the preservedTime state (whether the
        // shown time is kept or replaced by ceilHour on the next quick press), and the full plan model (mode, active
        // plan, per-to-do dues) so the explanation and highlighted button come back exactly as they were.
        document.getElementById('alarmDate').value = String(restore.date || '')
        document.getElementById('alarmTime').value = String(restore.time || '')
        alarmHadExistingAlarm = !!restore.hasAlarm
        alarmTimeUserSet = !!restore.timeUserSet
        alarmMode = restore.mode === 'same' ? 'same' : (restore.mode === 'respect' ? 'respect' : alarmMode)
        alarmTodoDues = Array.isArray(restore.dues) ? restore.dues : []
        alarmCalendarAnchor = null
        renderAlarmCalendar()
        renderAlarmTimeColumns()
        setAlarmActivePlan(restore.plan || 'anchor')
        updateAlarmPlanDescription()
        pushOverlayState()
        return
    }

    // Draw the grid immediately from the (empty) fields so the overlay is always usable, even if the
    // prefill round-trip below rejects (e.g. computeInitialAlarm's data.get throws because a selected
    // note was just deleted). renderAlarmCalendar falls back to today when the date field is empty.
    alarmCalendarAnchor = null
    renderAlarmCalendar()
    renderAlarmTimeColumns()
    setAlarmActivePlan('anchor')
    updateAlarmPlanDescription()

    // Post the descriptor ONLY after the prefill resolves (below), not from the empty fields here: a reload
    // landing inside the sub-second prefill window would otherwise leave the host holding an empty-date/time
    // descriptor, and a reconstruct would resurrect an empty picker. A reload strictly inside that window
    // loses the overlay instead (safe), while the overlay stays reload-survivable for the rest of its life.
    // Prefill the fields from the host, then redraw the calendar and time columns from those values.
    webviewApi.postMessage(['getAlarmInitial', ids]).then(function(init){
        if (!overlayOpen) return   // closed while awaiting
        init = init || {}
        var dateEl = document.getElementById('alarmDate')
        var timeEl = document.getElementById('alarmTime')
        if (!dateEl || !timeEl) return
        dateEl.value = String(init.date || '')
        timeEl.value = String(init.time || '')
        // The first selected to-do already had an alarm -> keep its shown time on a quick press (preservedTime).
        alarmHadExistingAlarm = !!init.hasAlarm
        alarmTodoDues = Array.isArray(init.dues) ? init.dues : []
        alarmCalendarAnchor = null
        renderAlarmCalendar()
        renderAlarmTimeColumns()
        updateAlarmPlanDescription()
        pushOverlayState()
    }).catch(function(){})
}

/** Profile editor overlay **************************************************************************************************************************
 * The profile editor ported from the native editor dialog (editorTemplate.ts / editorWebview.js) into an in-panel overlay - only ever shown on       *
 * mobile, where a native dialog opens behind the panel. The full ~25-field form is scrolled inside the overlay body. getEditorInitial prefills it     *
 * (mode + profile object, no base64); Create/Save post ['profileSaved', id, obj], Delete posts ['profileDeleteRequested', id] (the host keeps the     *
 * native delete confirmation), Cancel/Escape/backdrop just close. The descriptor carries the serialized form so a host-initiated reload mid-edit       *
 * reconstructs every field. Desktop keeps the native editor dialog untouched.                                                                          *
 ***************************************************************************************************************************************************/

// The editor form markup, copied verbatim from editorTemplate.ts's fieldset tree minus the dialog-only
// wrapper (#editorScroll), the inline <style> (styled by the scoped .cockpit-editor-overlay CSS instead)
// and the trailing hidden form (the overlay serialises straight to an object). The notebook <select> is
// left empty and populated from the embedded notebook list after the markup is inserted.
var EDITOR_FORM_HTML = `
    <fieldset>
        <legend>Name</legend>
        <input type="text" id="nameInput" name="name" value="New Profile">
    </fieldset>
    <fieldset>
        <legend>Panel View (applied when this profile is selected)</legend>
        <section>
            <label for="notebookSelect">Notebook</label>
            <select id="notebookSelect" name="notebook"></select>
        </section>
        <section>
            <label for="panelSearchInput">Search</label>
            <input type="text" id="panelSearchInput" name="panelSearch">
        </section>
        <section>
            <label for="sortFieldSelect">Sort ties by</label>
            <select id="sortFieldSelect" name="sortField">
                <option value="title">Title</option>
                <option value="updated">Updated date</option>
                <option value="created">Created date</option>
            </select>
        </section>
        <section>
            <label for="sortDirectionSelect">Direction</label>
            <select id="sortDirectionSelect" name="sortDirection">
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
            </select>
        </section>
    </fieldset>
    <fieldset>
        <legend>Sort Order</legend>
        <input type="number" id="sortOrderInput" name="sortOrder" value="0">
    </fieldset>
    <fieldset>
        <legend>Search Criteria</legend>
        <input type="text" id="searchCriteriaInput" name="searchCriteria">
    </fieldset>
    <fieldset>
        <legend>Overview Note ID</legend>
        <input type="text" id="noteIDInput" name="noteID">
    </fieldset>
    <fieldset>
        <legend>Show Completed</legend>
        <section>
            <input type="checkbox" id="showCompletedPastCheckbox" name="showCompletedPast">
            <label for="showCompletedPastCheckbox">Completed todos from the past</label>
        </section>
        <section>
            <input type="checkbox" id="showCompletedTodayCheckbox" name="showCompletedToday">
            <label for="showCompletedTodayCheckbox">Completed todos from today</label>
        </section>
        <section>
            <input type="checkbox" id="showCompletedFutureCheckbox" name="showCompletedFuture">
            <label for="showCompletedFutureCheckbox">Completed todos from the future</label>
        </section>
        <section>
            <input type="checkbox" id="showCompletedNoDueCheckbox" name="showCompletedNoDue">
            <label for="showCompletedNoDueCheckbox">Completed todos with no due date</label>
        </section>
    </fieldset>
    <fieldset>
        <legend>Notes</legend>
        <section>
            <input type="checkbox" id="showNotesCheckbox" name="showNotes">
            <label for="showNotesCheckbox">Show regular notes matching the search criteria</label>
        </section>
        <section>
            <label for="notesPositionSelect">Show notes</label>
            <select id="notesPositionSelect" name="notesPosition">
                <option value="after">After todos</option>
                <option value="before">Before todos</option>
            </select>
        </section>
    </fieldset>
    <fieldset>
        <legend>Show No Due Dates</legend>
        <section>
            <input type="checkbox" id="showNoDueCheckbox" name="showNoDue">
            <label for="showNoDueCheckbox">Show todos with no due date</label>
        </section>
    </fieldset>
    <fieldset>
        <legend>Move No Due Dates To End</legend>
        <section>
            <input type="checkbox" id="noDueDatesAtEndCheckbox" name="noDueDatesAtEnd">
            <label for="noDueDatesAtEndCheckbox">Sort todos with no due dates to the end of list</label>
        </section>
    </fieldset>
    <fieldset>
        <legend>Display Format</legend>
        <select id="displayFormatSelect" name="displayFormat">
            <option value="basic">Basic</option>
            <option value="interval">Interval</option>
            <option value="date">Date</option>
            <option value="month">Month Calendar</option>
            <option value="week">Week Planner</option>
        </select>
    </fieldset>
    <fieldset>
        <legend>Week Starts On</legend>
        <select id="weekStartsOnSelect" name="weekStartsOn">
            <option value="1">Monday</option>
            <option value="0">Sunday</option>
        </select>
    </fieldset>
    <fieldset>
        <legend>Dots Per Day</legend>
        <input type="number" id="maxDotsPerDayInput" name="maxDotsPerDay" min="1" max="10" value="4">
    </fieldset>
    <fieldset>
        <legend>Date Format</legend>
        <table>
            <tr>
                <td>Year</td>
                <td>Month</td>
                <td>Day</td>
            </tr>
            <tr>
                <td>
                    <select id="yearFormatSelect" name="yearFormat">
                        <option value="numeric">2022</option>
                        <option value="2-digit">22</option>
                    </select>
                </td>
                <td>
                    <select id="monthFormatSelect" name="monthFormat">
                        <option value="long">January</option>
                        <option value="short">Jan</option>
                        <option value="narrow">J</option>
                        <option value="2-digit">01</option>
                    </select>
                </td>
                <td>
                    <select id="dayFormatSelect" name="dayFormat">
                        <option value="numeric">9</option>
                        <option value="2-digit">09</option>
                    </select>
                </td>
            </tr>
        </table>
    </fieldset>
    <fieldset>
        <legend>Weekday Format</legend>
        <select id="weekdayFormatSelect" name="weekdayFormat">
            <option value="long">Monday</option>
            <option value="short">Mon</option>
            <option value="narrow">M</option>
        </select>
    </fieldset>
    <fieldset>
        <legend>Time Format</legend>
        <section>
            <input type="checkbox" id="timeIs12HourCheckbox" name="timeIs12Hour">
            <label for="timeIs12HourCheckbox">Use AM/PM Format</label>
        </section>
    </fieldset>
`

// Every editor field id, so the form can be wired and serialized without repeating the list.
var EDITOR_TEXT_IDS = ['nameInput', 'sortOrderInput', 'searchCriteriaInput', 'noteIDInput', 'panelSearchInput', 'maxDotsPerDayInput']
var EDITOR_SELECT_IDS = ['notesPositionSelect', 'notebookSelect', 'sortFieldSelect', 'sortDirectionSelect', 'displayFormatSelect', 'yearFormatSelect', 'monthFormatSelect', 'dayFormatSelect', 'weekdayFormatSelect', 'weekStartsOnSelect']
var EDITOR_CHECK_IDS = ['showCompletedPastCheckbox', 'showCompletedTodayCheckbox', 'showCompletedFutureCheckbox', 'showCompletedNoDueCheckbox', 'showNotesCheckbox', 'showNoDueCheckbox', 'timeIs12HourCheckbox', 'noDueDatesAtEndCheckbox']

function editorField(id){ return document.getElementById(id) }

// Fill the notebook <select> from the embedded notebook island (readNotebookData: id + path), prepended
// with an "All notebooks" empty-value option - mirroring the desktop editor's notebookOptions. Built via
// DOM so notebook names are escaped by textContent rather than string concatenation.
function populateEditorNotebooks(){
    var select = editorField('notebookSelect')
    if (!select) return
    var all = document.createElement('option')
    all.value = ''
    all.textContent = 'All notebooks'
    select.appendChild(all)
    var notebooks = readNotebookData().notebooks.slice().sort(function(first, second){
        return String(first.path || '').localeCompare(String(second.path || ''))
    })
    for (var notebook of notebooks){
        var option = document.createElement('option')
        option.value = String(notebook.id || '')
        option.textContent = String(notebook.path || '')
        select.appendChild(option)
    }
}

// Populate the form from a profile-shaped object (the getEditorInitial round-trip's init.profile, or a
// restored descriptor's values). Mirrors editorWebview.js loadProfileData's mapping, including the same
// "" / "after" / "title" / "asc" fallbacks so an unset field round-trips sanely.
function populateEditorForm(profile){
    if (!profile) return
    editorField('nameInput').value = profile['name']
    editorField('sortOrderInput').value = profile['sortOrder']
    editorField('searchCriteriaInput').value = profile['searchCriteria']
    editorField('noteIDInput').value = profile['noteID']
    editorField('showCompletedPastCheckbox').checked = profile['showCompletedPast']
    editorField('showCompletedTodayCheckbox').checked = profile['showCompletedToday']
    editorField('showCompletedFutureCheckbox').checked = profile['showCompletedFuture']
    editorField('showCompletedNoDueCheckbox').checked = profile['showCompletedNoDue']
    editorField('showNotesCheckbox').checked = profile['showNotes']
    editorField('notesPositionSelect').value = profile['notesPosition'] || 'after'
    editorField('notebookSelect').value = profile['notebook'] || ''
    editorField('panelSearchInput').value = profile['panelSearch'] || ''
    editorField('sortFieldSelect').value = profile['sortField'] || 'title'
    editorField('sortDirectionSelect').value = profile['sortDirection'] || 'asc'
    editorField('showNoDueCheckbox').checked = profile['showNoDue']
    editorField('displayFormatSelect').value = profile['displayFormat']
    editorField('yearFormatSelect').value = profile['yearFormat']
    editorField('monthFormatSelect').value = profile['monthFormat']
    editorField('dayFormatSelect').value = profile['dayFormat']
    editorField('weekdayFormatSelect').value = profile['weekdayFormat']
    editorField('timeIs12HourCheckbox').checked = profile['timeIs12Hour']
    editorField('noDueDatesAtEndCheckbox').checked = profile['noDueDatesAtEnd']
    editorField('weekStartsOnSelect').value = String(profile['weekStartsOn'])
    editorField('maxDotsPerDayInput').value = profile['maxDotsPerDay']
}

// Serialize the form to a plain object with the exact key set editorWebview.js saveProfileData produces,
// so the host CRUD (updateProfile) receives the same shape the desktop editor sends.
function serializeEditorForm(){
    return {
        'name': editorField('nameInput') ? editorField('nameInput').value : '',
        'sortOrder': editorField('sortOrderInput') ? editorField('sortOrderInput').value : '',
        'searchCriteria': editorField('searchCriteriaInput') ? editorField('searchCriteriaInput').value : '',
        'noteID': editorField('noteIDInput') ? editorField('noteIDInput').value : '',
        'showCompletedPast': editorField('showCompletedPastCheckbox') ? editorField('showCompletedPastCheckbox').checked : false,
        'showCompletedToday': editorField('showCompletedTodayCheckbox') ? editorField('showCompletedTodayCheckbox').checked : false,
        'showCompletedFuture': editorField('showCompletedFutureCheckbox') ? editorField('showCompletedFutureCheckbox').checked : false,
        'showCompletedNoDue': editorField('showCompletedNoDueCheckbox') ? editorField('showCompletedNoDueCheckbox').checked : false,
        'showNotes': editorField('showNotesCheckbox') ? editorField('showNotesCheckbox').checked : false,
        'notesPosition': editorField('notesPositionSelect') ? editorField('notesPositionSelect').value : 'after',
        'notebook': editorField('notebookSelect') ? editorField('notebookSelect').value : '',
        'panelSearch': editorField('panelSearchInput') ? editorField('panelSearchInput').value : '',
        'sortField': editorField('sortFieldSelect') ? editorField('sortFieldSelect').value : 'title',
        'sortDirection': editorField('sortDirectionSelect') ? editorField('sortDirectionSelect').value : 'asc',
        'showNoDue': editorField('showNoDueCheckbox') ? editorField('showNoDueCheckbox').checked : false,
        'displayFormat': editorField('displayFormatSelect') ? editorField('displayFormatSelect').value : '',
        'yearFormat': editorField('yearFormatSelect') ? editorField('yearFormatSelect').value : '',
        'monthFormat': editorField('monthFormatSelect') ? editorField('monthFormatSelect').value : '',
        'dayFormat': editorField('dayFormatSelect') ? editorField('dayFormatSelect').value : '',
        'weekdayFormat': editorField('weekdayFormatSelect') ? editorField('weekdayFormatSelect').value : '',
        'timeIs12Hour': editorField('timeIs12HourCheckbox') ? editorField('timeIs12HourCheckbox').checked : false,
        'noDueDatesAtEnd': editorField('noDueDatesAtEndCheckbox') ? editorField('noDueDatesAtEndCheckbox').checked : false,
        'weekStartsOn': editorField('weekStartsOnSelect') ? editorField('weekStartsOnSelect').value : '1',
        'maxDotsPerDay': editorField('maxDotsPerDayInput') ? editorField('maxDotsPerDayInput').value : '4'
    }
}

// Throttle-post the descriptor as the user edits, so a mid-edit reload reconstructs the latest field values.
function wireEditorInputs(){
    var ids = EDITOR_TEXT_IDS.concat(EDITOR_SELECT_IDS, EDITOR_CHECK_IDS)
    for (var id of ids){
        var element = editorField(id)
        if (element) element.addEventListener('input', queueOverlayState)
    }
}

function openEditorOverlay(profileID, restore){
    var isEdit = profileID != null
    overlayContext = { kind: 'editor', profileID: isEdit ? profileID : null }
    var footerButtons = isEdit ? [
        { label: 'Cancel', onClick: function(){ closeOverlay() } },
        { label: 'Delete', kind: 'danger', onClick: function(){
            void webviewApi.postMessage(['profileDeleteRequested', profileID]);
            closeOverlay()
        } },
        { label: 'Save', kind: 'primary', onClick: function(){
            void webviewApi.postMessage(['profileSaved', profileID, serializeEditorForm()]);
            closeOverlay()
        } },
    ] : [
        { label: 'Cancel', onClick: function(){ closeOverlay() } },
        { label: 'Create', kind: 'primary', onClick: function(){
            void webviewApi.postMessage(['profileSaved', null, serializeEditorForm()]);
            closeOverlay()
        } },
    ]
    var body = buildOverlay(isEdit ? 'Edit profile' : 'New profile', footerButtons)
    body.classList.add('cockpit-editor-overlay')
    body.innerHTML = EDITOR_FORM_HTML
    populateEditorNotebooks()
    wireEditorInputs()

    if (restore){
        // Reconstruct: restore the field values the user had before the reload; skip the round-trip.
        populateEditorForm(restore.values)
        pushOverlayState()
        return
    }

    // The form starts at the template defaults (usable immediately). In CREATE mode those defaults ARE the
    // intended values, so post the descriptor now (there is no round-trip). In EDIT mode the defaults are
    // placeholder junk until the profile arrives, so DO NOT post them: a reload inside the sub-second prefill
    // window would otherwise leave the host holding a defaults descriptor with the real profileID and the
    // edit footer, and a reconstruct would resurrect an edit form full of create-defaults whose Save would
    // reset the profile. Posting only after the profile is filled means a reload strictly inside that window
    // loses the overlay (safe) rather than resurrecting a committable wrong one.
    if (!isEdit){ pushOverlayState(); return }
    webviewApi.postMessage(['getEditorInitial', profileID]).then(function(init){
        if (!overlayOpen) return   // closed while awaiting
        init = init || {}
        if (init.profile) populateEditorForm(init.profile)
        pushOverlayState()
    }).catch(function(){})
}

/** Bootstrap **************************************************************************************************************************************
 * Invoked here, at the end of the file, so that every module-level variable initializer above has already run before startPanelObserver() executes.  *
 * This matters on a mobile reload-with-descriptor: the observer's first reconcile() reconstructs the open overlay synchronously and sets the overlay  *
 * module state, which an earlier invocation would then see clobbered by the `var x = <initial>` initializers that run later in source order (see the  *
 * note next to the popstate handler). Joplin injects plugin webview scripts after DOMContentLoaded, so the document.body branch is the live path; the *
 * DOMContentLoaded fallback covers the reverse ordering just in case.                                                                               *
 ***************************************************************************************************************************************************/
if (document.body){
    startPanelObserver()
} else {
    document.addEventListener('DOMContentLoaded', startPanelObserver)
}
