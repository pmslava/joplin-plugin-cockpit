/** onTodoClicked ***********************************************************************************************************************************
 * When a todo item is clicked, this function sends a message to the main plugin containing the todo id                                             *
 ***************************************************************************************************************************************************/
async function onTodoClicked(todoID){
    await webviewApi.postMessage(['todoClicked', todoID]);
}

/** Selection ***************************************************************************************************************************************
 * Which ROWS are selected - to-do rows and regular note rows alike, in ONE store, so a mixed selection is ordinary. Ctrl+click (or Cmd+click)       *
 * toggles a row, Shift+click selects the range from the previous click, and a plain click on a row opens it. The panel markup is replaced on every  *
 * refresh, so the selection is kept here and painted back on whenever the document changes.                                                        *
 *                                                                                                                                                   *
 * The RULES live in the shared, DOM-free window.RowSelection (rowSelection.js), so the to-do and the note handlers below are ONE path rather than    *
 * two drifting copies, and every case is covered by behavioural tests. Everything a selection drives takes an id array of either kind - delete,      *
 * move, tags, duplicate, switch type, copy - EXCEPT the TIME operations: only a to-do has a due date, so drag-to-date, drop-between and set-alarm    *
 * act on RowSelection.schedulableIDs(...), the to-dos WITHIN the selection, and silently leave the notes out of the payload.                         *
 ***************************************************************************************************************************************************/
var selectedRowIDs = new Set()
var lastClickedRowID = null
// The row of the most recent press that SELECTED something: a plain press, a Ctrl+press that added a row, or
// the far end of a Shift range. It is deliberately NOT the same thing as lastClickedRowID, which is the
// Shift-range anchor and must stay put while a range is resized; this one always follows the last thing the
// user selected, which is the row an Escape collapses a multi-selection onto (see collapseMultiSelection).
var lastSelectionInteractionID = null
// The item that is highlighted WITHOUT being part of the panel's own selection: the note the main editor is
// showing (see applyEditorNoteSelection). It takes no part in drag or set-alarm operations, so an item the
// user has not picked in the panel can never ride along in a batch.
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

// The id a row carries, whichever kind it is.
function rowIDOf(row){
    return (row && row.dataset) ? (row.dataset.todoId || row.dataset.noteId || '') : ''
}

// Every row on screen, of both kinds, in document order. The highlight is painted over all of them - including
// the read-only peek's, which the editor-tracking highlight has always marked - while only the selectable ones
// below can ever be IN the selection.
function allRows(){
    return Array.from(document.querySelectorAll('.todo[data-todo-id], .todo[data-note-id]'))
}

/** allSelectableRows *******************************************************************************************************************************
 * Every row the user may select, of BOTH kinds, in the list's own document order - which is what a Shift range is measured along and what an Escape *
 * collapse falls back to. The read-only "results outside current filters" peek is excluded: its rows are rendered without a selection handler on     *
 * purpose (renderTodoRowHtml draggable:false / renderNoteRowHtml selectable:false), so they can never enter the selection, and a range measured      *
 * along them would span rows that cannot be part of it.                                                                                              *
 ***************************************************************************************************************************************************/
function allSelectableRows(){
    return allRows().filter(row => !(row.closest && row.closest('.outside-results')))
}

// The ids of the to-do rows on screen, i.e. what a time operation may act on (see RowSelection.schedulableIDs).
function listedTodoIDs(){
    return allTodoRows().map(row => row.dataset.todoId)
}

// The to-dos within the current selection, in the selection's own order. Notes carry no due date, so they are
// dropped from every drag-to-date / drop-between / set-alarm payload rather than blocking it for the to-dos.
function schedulableSelection(){
    return window.RowSelection.schedulableIDs([...selectedRowIDs], listedTodoIDs())
}

function paintTodoSelection(){
    for (var row of allRows()){
        // A row is highlighted when it is in the panel's own selection, or when it is the item the editor is
        // showing (pickedNoteID) - which highlights without joining any batch.
        var id = rowIDOf(row)
        row.classList.toggle('-selected', selectedRowIDs.has(id) || id === pickedNoteID)
    }
}

/** Escape collapses a multi-selection **************************************************************************************************************
 * With several rows selected, Escape leaves ONE selected rather than clearing the lot: the LAST row the user selected, the same way for every way of *
 * building a selection - the last Ctrl+press that added a row, or the far end of a Shift range (never the anchor it was measured from). When that row *
 * is no longer in the selection or no longer in the list, the topmost still-listed selected row survives instead. The rule itself is in the shared    *
 * window.EditorNote so it is covered by tests. A selection of one or none is untouched: this collapses, it never deselects, and it never opens the     *
 * kept note or moves the editor-tracking highlight (pickedNoteID).                                                                                    *
 *                                                                                                                                                    *
 * Escape belongs first to whatever transient thing is open - the context menu, a dropdown, the search suggestions, a mobile overlay - and only a BARE *
 * press reaches the selection. This listener is registered ABOVE every other Escape handler in this file, so those are all still open when it runs    *
 * and it can stand aside; each of them then closes on its own handler exactly as before. A press inside the search field is the field's own.          *
 ***************************************************************************************************************************************************/
function collapseMultiSelection(){
    if (selectedRowIDs.size <= 1) return
    var kept = window.EditorNote.collapseSelection([...selectedRowIDs], lastSelectionInteractionID, allSelectableRows().map(rowIDOf))
    selectedRowIDs.clear()
    for (var id of kept) selectedRowIDs.add(id)
    // The surviving row becomes both the range anchor and the last interaction, so a Shift+press after an
    // Escape measures from what is actually still selected.
    lastClickedRowID = kept.length ? kept[0] : null
    lastSelectionInteractionID = lastClickedRowID
    paintTodoSelection()
}

document.addEventListener('keydown', function(event){
    if (event.key !== 'Escape') return
    if (document.getElementById('noteContextMenu')) return
    if (document.querySelector('.dropdown > .dropdown-menu:not([hidden])')) return
    if (document.getElementById('searchSuggestions')) return
    if (overlayOpen) return
    if (document.activeElement === getSearchInput()) return
    collapseMultiSelection()
})

/** Editor note tracking ****************************************************************************************************************************
 * The row highlight follows the note the MAIN editor/viewer is showing, wherever it was opened from: a row in this panel, Joplin's note list, a link *
 * inside another note. The plugin holds the id (panel.ts, from workspace.onNoteSelectionChange) and pushes it here as ['editorNoteChanged', id]; this *
 * webview also READS it back (getEditorNote) on two occasions, so a dropped push can never leave the highlight stale for good:                        *
 *   - once per document load, which is what paints the highlight on a fresh panel and, on mobile, carries it across a render at all (a mobile render  *
 *     is a full webview reload that destroys the module state below);                                                                                 *
 *   - whenever the panel's window regains the focus, because every push arriving while it did NOT have focus was deliberately dropped (below), and    *
 *     anything that moved the selection meanwhile - a note opened from another application, an alarm, a sync retiring the open note - would otherwise  *
 *     never be re-sent (the host suppresses an unchanged id).                                                                                          *
 *                                                                                                                                                     *
 * SECONDARY WINDOWS (desktop, Joplin 3.x): Joplin keeps ONE store whose top-level selection belongs to whichever window is focused, so a note opened   *
 * in a separate window arrives here as an ordinary selection change. It must not move the highlight - this panel belongs to the main window, whose     *
 * editor did not change - so a push is ignored while the panel's own window is not the focused one, and the read-back is filtered the same way. Mobile *
 * has no second window (and an Android webview's focus state is not a reliable proxy for one), so there both are always accepted.                      *
 *                                                                                                                                                     *
 * What each of those does to the panel's own selection is decided by the shared, DOM-free window.EditorNote (editorNote.js): the highlight always      *
 * moves, a multi-selection is never touched, and a lone selected row is kept only when it IS the opened note.                                          *
 ***************************************************************************************************************************************************/
// Let the host settle before a regained-focus read-back: switching from a Joplin secondary window back to
// the main one makes Joplin swap ITS selection to the top of the store a beat later, and reading before
// that swap would briefly paint the other window's note.
var EDITOR_NOTE_RESYNC_DELAY = 150
var editorNoteResyncTimer = null
// The selection generation, bumped by every accepted push AND by every row press: a read-back that was
// already in flight when either happened is dropped instead of painting its older answer over the newer
// state - which for a row press would mean dropping the single-row selection the press just made (the
// searchTitleSuggestions pattern).
var editorNoteSeq = 0

function panelWindowIsFocused(){
    try {
        // The panel is an iframe, so its OWN document only has focus when focus sits inside the panel;
        // the question here is which WINDOW is focused, which is what the top document answers.
        var top = window.top || window
        return !!(top.document && top.document.hasFocus())
    } catch (error){
        return true                    // a cross-origin host cannot be asked: treat every push as the main window's
    }
}

function acceptsEditorNote(){
    return window.EditorNote.acceptsPush({ isMobile: IS_MOBILE, windowFocused: panelWindowIsFocused() })
}

// Move the highlight to the note the editor is showing, and let the shared rules decide what becomes of the
// panel's own selection (see editorNote.js). The id lands in pickedNoteID, the highlight-only store, so a row
// the user never picked in the panel can never ride along in a drag or a batch action; an id the list does not
// hold matches no row, so the highlight simply goes, and a render that later brings that row in picks it up.
function applyEditorNoteSelection(noteID){
    var next = window.EditorNote.nextSelection({
        selected: [...selectedRowIDs],
        picked: pickedNoteID,
        lastClicked: lastClickedRowID,
    }, noteID)
    selectedRowIDs.clear()
    for (var id of next.selected) selectedRowIDs.add(id)
    pickedNoteID = next.picked
    lastClickedRowID = next.lastClicked
    paintTodoSelection()
}

// Read the editor's note back from the host and apply it, unless a push has overtaken this round-trip.
function requestEditorNote(){
    if (!acceptsEditorNote()) return
    var seq = editorNoteSeq
    webviewApi.postMessage(['getEditorNote']).then(function(id){
        if (window.EditorNote.readBackIsStale(seq, editorNoteSeq)) return
        if (!acceptsEditorNote()) return
        applyEditorNoteSelection(id)
    }).catch(function(){})
}

function queueEditorNoteResync(){
    if (editorNoteResyncTimer) clearTimeout(editorNoteResyncTimer)
    editorNoteResyncTimer = setTimeout(function(){
        editorNoteResyncTimer = null
        requestEditorNote()
    }, EDITOR_NOTE_RESYNC_DELAY)
}

/** Create-button width stages (desktop) ************************************************************************************************************
 * The profile row must stay ONE line at every panel width, so the create buttons degrade instead of wrapping: icon + "New note" / "New to-do", then  *
 * icon + "Note" / "To-do", then the icon alone (the title/aria-label keeps naming the action). Which stage fits is MEASURED rather than guessed at a  *
 * pixel breakpoint: the row's content width scales with Joplin's font-size setting (and with whatever font a theme picks), so a fixed @media          *
 * threshold that is clean at the 13px default clips the second button at 16-18px. The row is a full-width block whose size does not depend on its     *
 * contents, so stepping the labels down cannot change what is being measured and the loop cannot oscillate.                                          *
 *                                                                                                                                                     *
 * Runs on every real re-render (reconcile) and on every panel resize. Mobile renders icon-only markup already and is skipped.                          *
 ***************************************************************************************************************************************************/
function applyCreateButtonStage(){
    if (IS_MOBILE) return
    var row = document.getElementById('profileControls')
    if (!row) return
    // Widest first: with both stage classes off the row shows the full wording. Each measurement is a live
    // layout read, so "does it overflow" is the real answer for this width, font-size and theme.
    row.classList.remove('-labels-short', '-labels-none')
    if (row.scrollWidth <= row.clientWidth) return
    row.classList.add('-labels-short')
    if (row.scrollWidth <= row.clientWidth) return
    row.classList.remove('-labels-short')
    row.classList.add('-labels-none')
}

// Coalesced measurement, for the signals that can arrive in bursts: a host stylesheet swap can fire the
// head observer several times for one theme or font-size change. Deliberately NOT wired to the panel's own
// mutation observer - the stage classes are themselves mutations, which would drive it round every frame.
var createStageFrame = null

function scheduleCreateButtonStage(){
    if (createStageFrame != null) return
    createStageFrame = requestAnimationFrame(function(){
        createStageFrame = null
        applyCreateButtonStage()
    })
}

// A panel resize changes the width the stage was chosen for. The class toggles above never change the row's
// own size, so this listener cannot be re-entered by its own effect.
window.addEventListener('resize', applyCreateButtonStage)

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

    // A host stylesheet change is also a font change: Joplin's font-size setting is what the create
    // buttons are measured against, and it can move with no resize and no re-render, which would
    // otherwise leave the stage the previous size chose until the next refresh.
    function onHostStyleChanged(){
        scheduleEffectiveThemeClass()
        scheduleCreateButtonStage()
    }

    // A capturing load listener fires after a replacement stylesheet has actually loaded. The head
    // observer also covers inline style replacement and href changes; both paths are coalesced into
    // one animation-frame read so a Joplin theme switch updates without waiting for Cockpit's timer.
    document.addEventListener('load', function(event){
        if (event.target && event.target.tagName === 'LINK') onHostStyleChanged()
    }, true)
    if (document.head){
        new MutationObserver(onHostStyleChanged).observe(document.head, {
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
    // The gesture-trace setting rides in the same re-emitted markup, so it is re-read here too - once per
    // render, which is what keeps it off the per-event path.
    refreshGestureTraceFlag()
    // The inline theme marker can change when Cockpit settings re-render the panel. Host Joplin
    // stylesheet changes are covered separately by startThemeAppearanceObserver().
    scheduleEffectiveThemeClass()
    // Safety net for the cross-frame selection drag (see beginForeignSelectionDrag): if an earlier
    // passthrough was ever orphaned - our iframe left pointer-events:none while no drag is active - a
    // re-render repairs it, so the panel can never stay dead to input. Guarded on the drag NOT being
    // active, so an in-progress passthrough (whose own end-of-drag restore is pending) is never disturbed.
    if (!foreignSelectionDragActive){
        var reconcileFrame = cockpitPanelIframe()
        if (reconcileFrame && reconcileFrame.style.pointerEvents === 'none') reconcileFrame.style.pointerEvents = ''
    }
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
        // The controls were replaced with this render, so the create buttons are back at their widest;
        // re-measure which stage fits. Done here (a real re-render) rather than on every mutation, so the
        // class it sets - itself a mutation - cannot drive the observer round again.
        applyCreateButtonStage()
        // The suggestion menu was in the replaced markup, so its DOM is gone before this runs. An OPEN list is
        // user-owned state, and a background refresh - a sync landing, a note changing, and sync is a very
        // frequent thing - must not silently destroy what the user is halfway through building. Everything the
        // list held that cannot be recomputed is therefore carried across the render and put back: the marks,
        // the embedded filter box's text and caret, and which control had the focus. The rows themselves are
        // rebuilt from the restored draft (reopenSearchSuggestions -> onSearchInput), so they reflect whatever
        // is now in the field.
        var keptSuggest = (searchFocused && searchSuggestion)
            ? { marks: searchMarks, filter: suggestFilterText, caret: suggestFilterCaret, focus: searchFocusTarget }
            : null
        searchSuggestion = null
        searchMarks = null
        // Re-anchor "what the host is holding" on the value it just RENDERED. input.defaultValue is the
        // server-rendered value attribute, i.e. the committed filter, so this is ground truth - and it must be
        // re-read because the host can change the filter without this webview committing anything (a profile
        // switch applies the profile's own panelSearch). Without it the deferred-commit duplicate guard would
        // eventually compare against a value the host has moved off, and drop a commit that was not a no-op.
        var renderedSearch = getSearchInput()
        if (renderedSearch) lastCommittedSearch = renderedSearch.defaultValue
        restoreSearchDraft()
        if (keptSuggest) reopenSearchSuggestions(keptSuggest)
        // Overlay reload-survival: when this render carries the overlay descriptor island (the host's
        // reconstruct render after a mid-overlay reload) and no overlay is open in this webview yet, rebuild
        // it from the descriptor. Mobile only; the island is never emitted on desktop.
        if (IS_MOBILE && !overlayOpen) reopenOverlayFromEmbeddedState()
        // Search reload-survival (mobile): the same idea one layer down. On a FRESH webview no module state
        // survived, so searchFocused is false and restoreSearchDraft above returned at its first line; the
        // host-held { draft, caret, marks, filter, focus } island is what puts the in-progress search back.
        // Guarded on searchFocused so this only ever runs on a reload, never over a live interaction.
        if (IS_MOBILE && !searchFocused) restoreSearchFromEmbeddedState()
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
        //
        // message[2] is the same handshake for the SEARCH state island: true when this document already carries
        // it (reconcile below restores the search itself), false when the host holds a search state the loaded
        // document does not carry - the classic renderer kill that re-served a stale snapshot - which makes the
        // host re-render once with it embedded. Same non-looping shape as the overlay's, on its own channel.
        var stateText = readEmbeddedOverlayStateText()
        void webviewApi.postMessage(['dialogGuardReset', !!stateText, !!readEmbeddedSearchStateText()]);
    }
    // The host pushes the main editor's note here whenever it changes (see applyEditorNoteSelection).
    // Registered once per document load, because Joplin allows a single onMessage handler per view. It is
    // the panel's only inbound channel and everything below is the panel itself, so a runtime that does not
    // offer one must lose the highlight rather than the bootstrap.
    try {
        webviewApi.onMessage(function(event){
            var message = event && event.message
            if (!Array.isArray(message)) return
            if (message[0] === 'editorNoteChanged'){
                if (!acceptsEditorNote()) return
                editorNoteSeq++
                applyEditorNoteSelection(message[1])
            } else if (message[0] === 'panelToast'){
                // The host has no toast of its own and must not raise a plugin dialog for a failed copy (see
                // copyToClipboard in panel.ts), so it pushes the notice here instead. Nothing answers it. The copy
                // path cannot outrun its own render - both copy branches return before the post-mutation refresh
                // trio - but an UNRELATED background render can still reload the mobile webview out from under the
                // notice and swallow it. A toast lost that way is the accepted price of never blocking the app.
                showToast(String(message[1] || ""))
            }
        })
    } catch (error){}
    reconcile()
    new MutationObserver(reconcile).observe(document.body, { childList: true, subtree: true })
    requestEditorNote()
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

/** onRowPressed ************************************************************************************************************************************
 * Selection happens on press, like in a list: a plain press selects the row (replacing the selection), Ctrl+press toggles it, Shift+press selects   *
 * the range from the last plainly- or Ctrl-pressed row (the anchor). The anchor stays put, so a further Shift+press resizes the range rather than   *
 * chaining from its end. Opening happens separately, on click.                                                                                     *
 *                                                                                                                                                   *
 * ONE handler for BOTH row kinds. A regular note row is selected exactly like a to-do row - the whole point of the mixed selection - so the two      *
 * inline handlers below are thin wrappers over this, and the decisions themselves are made by the shared, DOM-free window.RowSelection. What        *
 * differs between the kinds is not selection but TIME: see schedulableSelection().                                                                   *
 ***************************************************************************************************************************************************/
function onRowPressed(event, rowID){
    if (event.button !== 0) return
    // The tick circle does its own thing (toggle / due-date) and takes no part in selection.
    if (event.target.classList.contains('todo-checkbox')) return
    // A press on the notebook pill filters by that notebook on the following click; it takes no part in
    // selection either, so leave the current selection untouched (like the checkbox above).
    if (event.target.classList.contains('todo-notebook')) return
    // The selection is about to change, so an editor-note read-back still in flight now describes an older
    // state: bump the generation to discard its answer rather than let it drop this press's selection.
    editorNoteSeq++
    pickedNoteID = null
    var next = window.RowSelection.pressSelection(
        { selected: [...selectedRowIDs], lastClicked: lastClickedRowID, lastInteraction: lastSelectionInteractionID },
        rowID,
        { shift: !!event.shiftKey, ctrl: !!(event.ctrlKey || event.metaKey) },
        allSelectableRows().map(rowIDOf)
    )
    selectedRowIDs.clear()
    for (var id of next.selected) selectedRowIDs.add(id)
    lastClickedRowID = next.lastClicked
    lastSelectionInteractionID = next.lastInteraction
    paintTodoSelection()
    // On a phone this handler is reached ONLY through the browser's compatibility mouse events (a row carries
    // onmousedown and onclick, never a touch handler of its own), and whether those arrive at all after a long
    // press - and therefore what a hold does to the selection - is a platform behaviour this repo cannot settle
    // from the source. The third Pixel round reported a selection that grows as the user taps around, and the
    // strip is the only instrument that can say whether these ever run. Two codes, the count included, so a hold
    // followed by two taps reads as three lines with the size after each.
    if (IS_MOBILE) traceGesture('row-press:' + traceId(rowID) + ' n=' + selectedRowIDs.size)
}

function onTodoRowMouseDown(event, todoID){
    onRowPressed(event, todoID)
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

/** onRowClicked ************************************************************************************************************************************
 * The plain-click half of the row interaction, shared by both kinds. A real drag fires no click, so a click reaching here is a press that produced  *
 * NO drag: it collapses the selection onto this row - the single-select half of the file-manager rule whose drag half onRowPressed defers (it       *
 * PRESERVES a multi-selection on the press so a drag can sweep the whole set) - and then opens the item. A no-op collapse when the row is already   *
 * the sole selection, so a plain single click never repaints needlessly.                                                                            *
 *                                                                                                                                                   *
 * Any plain left click that reaches here opens the item: the tick circle and the notebook pill return in the callers (they do their own thing), and *
 * a modifier click returns at the top (selection only), so what is left is the title OR the row's own dead zones - its padding, the gap beside a    *
 * short title, the strip below it. Opening on all of them makes a click that selects a row also show it in the editor, matching the title.          *
 *                                                                                                                                                   *
 * THE READ-ONLY PEEK OPENS BUT NEVER SELECTS. The "results outside current filters" rows are rendered without the selection onmousedown on purpose  *
 * (renderTodoRowHtml draggable:false / renderNoteRowHtml selectable:false), but their ONCLICK is emitted unconditionally - click-to-open is what the *
 * peek is for. So the press path is suppressed at the markup level and the CLICK path has to be suppressed here, or this collapse would write a peek *
 * row into the selection: persisted module state that survives every render, and - since the selection drives the batch context menu - one that      *
 * would let Delete / Move / Tags / Duplicate / Switch-type act on rows the user was deliberately shown read-only, from OUTSIDE their filters and     *
 * even from excluded notebooks. Opening still happens: only the selection half is skipped. The selector is the one allSelectableRows() already uses.  *
 ***************************************************************************************************************************************************/
function onRowClicked(event, rowID){
    if (event && event.target && event.target.closest && event.target.closest('.outside-results')){
        void onTodoClicked(rowID)
        return
    }
    var next = window.RowSelection.clickSelection({ selected: [...selectedRowIDs], lastClicked: lastClickedRowID }, rowID)
    if (next.changed){
        selectedRowIDs.clear()
        for (var id of next.selected) selectedRowIDs.add(id)
        lastClickedRowID = next.lastClicked
        paintTodoSelection()
    }
    if (IS_MOBILE) traceGesture('row-click:' + traceId(rowID) + ' n=' + selectedRowIDs.size)
    void onTodoClicked(rowID)
}

function onTodoRowClicked(event, todoID){
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.target.classList.contains('todo-checkbox')) return
    if (event.target.classList.contains('todo-notebook')){
        applyNotebookFilterFromPill(event.target)
        return
    }
    onRowClicked(event, todoID)
}

/** onTodoContextMenu ********************************************************************************************************************************
 * Right click (or long press) on a to-do, dispatched by which part of the row was pressed: the circle opens the due date picker for the selection,  *
 * the notebook label opens Joplin's "Move to notebook" dialog, and anywhere else opens the context menu.                                            *
 *                                                                                                                                                   *
 * The tick-circle branch is the LAST writer into selectedRowIDs that could still admit a read-only peek row, and it is guarded for two reasons. The *
 * peek's rows are deliberately not drag-reschedule sources (renderTodoRowHtml draggable:false), so this right click - which is the same operation by *
 * another route - must not reschedule them either; and because the selection now drives the BATCH menu, a peek id written here would afterwards be   *
 * reachable by Ctrl+adding an ordinary row and running Delete / Move / Tags / Duplicate / Switch-type on the pair. draggable:false suppresses        *
 * neither oncontextmenu nor the .todo-checkbox element (see formats.ts), so the guard has to live here. The row's OTHER right-click zones are        *
 * untouched: they open the single-note menu for the pressed row, which is what a peeked note is for.                                                 *
 ***************************************************************************************************************************************************/
function onTodoContextMenu(event, todoID){
    event.preventDefault()
    if (event.target.classList.contains('todo-checkbox')){
        if (event.target.closest && event.target.closest('.outside-results')) return
        if (!selectedRowIDs.has(todoID)){
            selectedRowIDs.clear()
            selectedRowIDs.add(todoID)
            lastClickedRowID = todoID
            paintTodoSelection()
        }
        // Only the to-dos in the selection get a due date: a mixed selection sets the alarm on its to-dos and
        // silently leaves its notes out (the pressed row is itself a to-do, so this is never empty).
        requestAlarm(schedulableSelection())
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
 * Regular notes have no checkbox and no due date, so the tick circle and the date pickers do not apply to them - but SELECTION does: a note row is  *
 * pressed, Ctrl-toggled and Shift-ranged exactly like a to-do row, and joins the same selectedRowIDs. Up to 2.0.0 a press on a note row CLEARED the *
 * selection and lit the highlight-only pickedNoteID instead, so a note could never take part in a batch; that asymmetry is what this fixes.          *
 *                                                                                                                                                   *
 * The right-click zones are unchanged: the notebook label ("Move to notebook") and everything else (context menu).                                   *
 ***************************************************************************************************************************************************/
function onNoteRowMouseDown(event, noteID){
    onRowPressed(event, noteID)
}

function onNoteRowClicked(event, noteID){
    // A modifier click is selection only, exactly as on a to-do row: the press has already done the work and
    // the note must NOT also open (Ctrl-clicking a tenth row to add it to a batch cannot move the editor).
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.target.classList.contains('todo-notebook')){
        applyNotebookFilterFromPill(event.target)
        return
    }
    // Mirrors onTodoRowClicked: any other left click collapses the selection onto this row and opens the note -
    // the title, the display-only progress ring, and the row's dead zones alike. A note row has no tickable
    // checkbox, so the pill is the only zone to guard.
    onRowClicked(event, noteID)
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
 * A small menu of note actions, drawn by the panel itself because Joplin's own note context menu cannot be opened from a plugin webview. The item   *
 * list and its markup live in the shared window.NoteMenu module (noteMenu.js, loaded before this script), so the desktop menu and the Node harness  *
 * build byte-identical HTML.                                                                                                                         *
 *                                                                                                                                                    *
 * MULTI-SELECT (desktop): when the right-clicked row is part of a Ctrl/Shift selection of more than one row, every action that CAN apply to many acts *
 * on the WHOLE selection (routed to the host's batch handler) and the single-only actions render greyed out. A right click on a row OUTSIDE the       *
 * selection, or a single selection, keeps today's single-note menu for that one row. Mobile has no multi-select, so IS_MOBILE always takes the        *
 * single path (count 1) and its markup/behaviour are unchanged.                                                                                       *
 *                                                                                                                                                     *
 * MIXED KINDS: every action this menu can batch takes an id array of either kind (Joplin has one note store; a to-do IS a note with is_todo set), so  *
 * a selection of to-dos AND regular notes is routed whole, from a right click on either kind of row. The one kind-specific entry - mobile's "Move to   *
 * date…" - is added only for a to-do row and is single-note anyway.                                                                                    *
 ***************************************************************************************************************************************************/
function showNoteContextMenu(event, noteID, isTodo){
    // Belt to the braces of the panel-wide contextmenu suppression above: while a touch gesture owns the finger -
    // armed silently behind the menu the fire opened, or lifted into the drag proper - NOTHING may open a menu.
    // The adapter's own fire is not caught by this and cannot be: onLongPressFire calls onTodoContextMenu (and so
    // this) BEFORE armTouchDrag(), so `touchDrag.active` is still false on that one call and true on every other
    // route in - a native contextmenu that somehow got past the capture listener, a stray inline handler, a second
    // gesture. That ORDER is therefore load-bearing rather than merely tidy, and the harness pins it.
    // One consequence: a fire landing while a PREVIOUS gesture is still in flight opens no menu at all - this
    // returns, and armTouchDrag ends the old gesture through the single end just after. That is the right way
    // round (a stale gesture's refresh guard is worth more than a menu) and it is not silent: the strip reads
    // `menu-blocked > drag-cancel:re-arm`. It is also, since the third Pixel round, unreachable for the ordinary
    // case that used to reach it: a gesture whose pointerup was lost used to sit here `active` until the 15s
    // watchdog and swallow every menu in between. The adapter's own pointerdown now ends that gesture on the next
    // press that begins alone (drag-cancel:stale-pointer), before the timer is even set, so what is left here is
    // the belt it always was.
    if (touchDrag.active){ traceGesture('menu-blocked'); return }
    hideNoteContextMenu()
    // The ids this menu acts on. Any row - to-do or note - that is itself part of a multi-row selection
    // triggers the batch menu; everything else (a row outside the selection, a selection of one, and mobile,
    // which has no multi-select) is the single-note menu for the pressed row.
    var selectionIDs = (!IS_MOBILE && selectedRowIDs.has(noteID) && selectedRowIDs.size > 1)
        ? [...selectedRowIDs]
        : [noteID]
    var count = selectionIDs.length
    // On mobile the 18px checkbox circle is a hard touch target, so to-do rows get an explicit "Move to date…"
    // entry that opens the same set-alarm dialog the circle long-press does. Mobile never reaches the multi
    // path (count is always 1 there), so the menu and its behaviour stay byte-identical to before.
    var extra = (IS_MOBILE && isTodo) ? [{ action: 'setDueDate', label: 'Move to date…' }] : []
    var menu = document.createElement('div')
    menu.id = 'noteContextMenu'
    menu.innerHTML = window.NoteMenu.menuHtml(count, extra)
    menu.addEventListener('click', clickEvent => {
        var button = clickEvent.target.closest ? clickEvent.target.closest('.context-menu-item') : null
        // A greyed-out (single-only, on a multi-selection) item is inert: it fires no action and leaves the
        // menu open, so a mis-aimed click on it does nothing.
        if (button && button.classList.contains('-disabled')) return
        var action = button ? button.dataset.action : null
        hideNoteContextMenu()
        if (!action) return
        if (action === 'setDueDate'){ requestAlarm([noteID]); return }
        // Multi-selection (desktop): route every capable action to the host's batch handler with all the ids.
        // Single-only actions never get here - they render disabled and returned above.
        if (count > 1){ void webviewApi.postMessage(['noteMenuActionMulti', action, selectionIDs]); return }
        // On mobile the notebook and tag pickers are in-panel overlays rather than native dialogs (which
        // would open behind the panel). Desktop keeps posting noteMenuAction so its native dialogs run.
        if (IS_MOBILE && action === 'moveToFolder'){ openNotebookOverlay('moveNotes', { noteIDs: [noteID] }); return }
        if (IS_MOBILE && action === 'tags'){ openTagOverlay(noteID); return }
        void webviewApi.postMessage(['noteMenuAction', action, noteID]);
    })
    document.body.appendChild(menu)
    menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`
    // Desktop: pull focus into the panel frame, so the outside-dismissal below has a blur to fire on. A
    // right click does not reliably focus an iframe, and with focus left in the editor a click into another
    // Joplin webview (the rendered note viewer is an iframe of its own) reaches neither this document nor
    // the main one, which is exactly how the menu used to survive a click outside the panel. tabindex -1
    // makes the container focusable without putting it in the tab order.
    if (!IS_MOBILE){
        menuReturnFocus = document.activeElement
        menu.tabIndex = -1
        try { menu.focus({ preventScroll: true }) } catch (error){ menu.focus() }
    }
}

// Whatever held focus in the panel when the menu took it, so closing the menu can hand it back.
var menuReturnFocus = null

function hideNoteContextMenu(){
    var menu = document.getElementById('noteContextMenu')
    if (!menu) return
    // Hand focus back only when the menu still holds it AND the panel's window is still the focused one -
    // i.e. the menu was closed by Escape or by running one of its items. A dismissal that came from OUTSIDE
    // the panel is excluded explicitly (dismissingFromOutside): the parent's capturing mousedown runs BEFORE
    // the browser moves focus to whatever was clicked, so both other guards still read "the menu has focus,
    // in the focused window" and the panel would pull focus back out of the click the user just made.
    var returnTo = menuReturnFocus
    var restore = !dismissingFromOutside && menu.contains(document.activeElement) && panelWindowIsFocused()
    menuReturnFocus = null
    menu.remove()
    if (restore && returnTo && returnTo.isConnected && typeof returnTo.focus === 'function'){
        try { returnTo.focus({ preventScroll: true }) } catch (error){ returnTo.focus() }
    }
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
// A scroll closes the menu - EXCEPT under a hold that has armed the touch drag, where the menu is the gesture and
// closing it is the failure being reported. The armed touchmove cancels the pan at source, so a scroll should not
// arrive at all; if the platform pans anyway (a non-cancelable touch sequence - see drag-uncancelable), the menu
// must survive it and let the lift threshold decide, rather than vanishing under a finger that never asked for a
// drag. A LIFTED drag has already closed the menu itself, so this only ever stands aside for the armed phase.
// touchDrag is declared with `var` further down and is therefore hoisted, exactly like longPress just above.
document.addEventListener('scroll', function(){
    if (touchDrag && touchDrag.active && !touchDrag.lifted) return
    hideNoteContextMenu()
}, true)
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideNoteContextMenu()
})

/** Dismissal from outside the panel (desktop) ******************************************************************************************************
 * A native menu closes the moment the user clicks anywhere else, but the panel is an IFRAME: a click in the note editor, the rendered viewer or the  *
 * sidebar never reaches this document, so the in-panel click listener above is blind to it and the menu stayed open over the editor. Two signals     *
 * cover the ground between them:                                                                                                                     *
 *   - this window's own blur, which fires as soon as focus leaves the panel frame for anything at all - the editor, another Joplin webview (the      *
 *     rendered viewer is its own iframe, whose events reach neither this document nor the main one), another window, another application. The menu   *
 *     takes focus when it opens (showNoteContextMenu), so there is always focus here to lose. Element blur does not bubble, so this listener sees    *
 *     only the window's own blur, never a field losing focus inside the panel.                                                                       *
 *   - a capturing mousedown on the PARENT document, which catches a press anywhere in the main window even if the panel never held focus. Events     *
 *     inside this iframe do not propagate to the parent, so it only ever fires for a press OUTSIDE the panel.                                        *
 * Desktop only: on mobile the panel is a fullscreen native modal with no "outside" to click, and an Android webview blurs for its own reasons (the    *
 * soft keyboard, a native message box), which would close the menu under the user's finger. The same-origin parent access is the one Joplin's panel   *
 * iframe already grants (see wireParentSelectionDragRestore); a cross-origin host simply loses that half.                                             *
 ***************************************************************************************************************************************************/
// True for the duration of an outside dismissal, so the menu's focus hand-back knows this close was not the
// panel's own (see hideNoteContextMenu).
var dismissingFromOutside = false

function dismissPanelPopups(){
    if (IS_MOBILE) return
    dismissingFromOutside = true
    try {
        hideNoteContextMenu()
        // The panel's other transient popups - the profile / notebook / sort dropdowns and the search
        // suggestion list they share their machinery with - close on the same signal, for the same reason:
        // they already close on any click INSIDE the panel, so a click outside it was the same blind spot.
        closeAllDropdowns()
    } finally {
        dismissingFromOutside = false
    }
}

;(function wirePanelWindowListeners(){
    window.addEventListener('blur', dismissPanelPopups)
    try {
        var parentWindow = window.parent
        if (!parentWindow || parentWindow === window) return
        parentWindow.addEventListener('mousedown', dismissPanelPopups, true)
        // The window regaining focus is also when the editor's note is re-read: every push that arrived
        // while another window (or another application) held the focus was dropped, and the host does not
        // re-send an unchanged id. Listened for on the PARENT, because this iframe's own window only fires
        // focus when focus lands INSIDE the panel, which a window switch rarely does. NOT capturing, unlike
        // the listeners around it: focus does not bubble, so a capturing listener here would also fire for
        // every element focused anywhere in the main window, and only the window's own event is wanted.
        parentWindow.addEventListener('focus', queueEditorNoteResync)
    } catch (error){}
})()

/** onHeadingContextMenu ****************************************************************************************************************************
 * Right click on a group heading ("Today", "No Due Date", a week planner day...) opens the set alarm dialog for every to-do in that group.          *
 ***************************************************************************************************************************************************/
function onHeadingContextMenu(event){
    event.preventDefault()
    var ids = (event.currentTarget.dataset.todoIds || '').split(',').filter(Boolean)
    if (!ids.length) return
    selectedRowIDs.clear()
    for (var id of ids) selectedRowIDs.add(id)
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
 * Touch has no way OF ITS OWN into the context menus that a desktop right click opens, and the platform's own way in is refused: Android's native    *
 * long press DOES fire a real `contextmenu`, which the panel suppresses panel-wide on mobile (the capture listener further down - it was opening     *
 * the menu behind this adapter's back, and that was the second Pixel round's bug). So the adapter synthesises the menus itself, from a Pointer       *
 * Events long press: a touch that stays put for 500ms on a to-do row, a note row, a group heading or the sync button fires the same handler the      *
 * desktop right click would, passing a minimal event carrying the press point and pressed element. It is fully gated on IS_MOBILE and on a           *
 * non-mouse pointer, so on desktop (and for a desktop mouse) it is inert and the existing click / dblclick / contextmenu paths are untouched.        *
 * A move of more than 10px FROM THE PRESS POINT, a pointer up/cancel, or a scroll of the list aborts the press (a scroll or a drag is not a long      *
 * press) - while the finger's CURRENT position is kept in lastX/lastY throughout, because that is where the menu opens and therefore the only        *
 * honest origin for the drag's own, larger, lift threshold (see liftDecision in touchDrag.js). The click the                                          *
 * browser synthesises right after the touch is swallowed, so a fired long press does not also open or toggle the item.                               *
 *                                                                                                                                                    *
 * EVERY KIND STILL OPENS ITS MENU AT ONCE, on the same 500ms, and ONE OF THEM ALSO DOES SOMETHING ELSE: a hold on the BODY of a to-do row opens the   *
 * menu and, behind it, ARMS the touch drag below with the finger still down, so that a move up or down from there can lift the row. The arming is      *
 * invisible - nothing is lifted, painted or guarded by it - and a release that never moved throws it away and leaves the menu exactly as it opened.    *
 ***************************************************************************************************************************************************/
// x/y is the PRESS point - where the finger landed, which the 10px cancel gate is measured from and must stay
// measured from. lastX/lastY is where the finger actually IS, updated by every move the press survives, so that
// at the 500ms fire it holds the FIRE POINT: where the finger was when the menu opened. The drag arms from THAT,
// never from the press point, or the lift threshold and the press's cancel gate would be two readings of the same
// origin and the arm would be born at the edge of its own threshold (see liftDecision in touchDrag.js).
var longPress = { timer: null, x: 0, y: 0, lastX: 0, lastY: 0, fired: false, target: null, el: null, kind: null, id: null, pointerId: null }

// ONLY the timer, and the one field it must NOT clear is `fired`. This runs on the pointerup of every gesture,
// including one whose press has already fired - and `fired` is read AFTER that by both click listeners on the
// click the browser then synthesises: the menu-dismiss listener stands aside for it, and the swallower eats it.
// Clearing it here would let that click through, and the context menu the press had just opened would vanish the
// instant the finger came up. Nothing else in longPress outlives this: the drag it may have armed snapshotted
// everything it needs (row, pointer, id, press point) at the fire, in armTouchDrag.
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
    if (longPress.kind === 'todo'){
        // The menu FIRST, and with the finger still down: this is exactly the gesture that shipped before the
        // touch drag existed, and the first Pixel round is why it is back (a lift at the 500ms fought Joplin's
        // own side-menu swipe and neither won).
        onTodoContextMenu(ev, longPress.id)
        // ...and then, for a press on the row's BODY only, the drag is ARMED silently behind that menu: a move
        // up or down lifts the row from here (see the touch drag's own block below). Every zone the drag
        // refuses - the tick circle, the notebook pill, a read-only peek row - has opened its menu on the line
        // above and arms nothing at all.
        if (canLiftRow(longPress.target, longPress.el)) armTouchDrag()
    }
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
    // ...and any gesture the LAST press left running. A gesture whose pointerup never arrived is still `active`
    // here, and showNoteContextMenu turns every opener away while a gesture is active: that stale flag opens NO
    // MENU AT ALL on the next hold, for up to the 15s watchdog - the third Pixel round's "the context menu doesn't
    // appear at all", by a route that has nothing to do with the lift.
    // THE TEST IS isPrimary, NOT THE POINTER ID, and the reason is a platform claim this file must not make
    // silently: Blink hands every touch point a fresh id and does not reuse the last one, so "the same finger
    // pressing twice" arrives with a DIFFERENT id and an id comparison here would be dead code on the device.
    // That claim is checked on the phone (step 18f-ter of MOBILE.md), not assumed. What holds without it is what
    // isPrimary MEANS: a press that begins with no other finger on the glass. A gesture that still has its finger
    // down cannot be joined by one, so an active gesture meeting a primary press is a gesture whose end was lost.
    // It is ended here, through the single end, so its refresh guard comes down with it - and the press itself is
    // NOT cancelled: it is the user's next hold and must open its own menu.
    // A NON-primary press is a genuine second finger and is not this line's business: the drag's own second-pointer
    // listener below ends the gesture AND cancels the press that finger just started. This listener is registered
    // first, so on a primary press `active` is already false by the time that one runs, which is exactly what keeps
    // the fresh press alive; on a second finger this line does nothing and that one does all of it.
    if (touchDrag.active && event.isPrimary) endTouchDrag('stale-pointer')
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
    longPress.x = longPress.lastX = event.clientX; longPress.y = longPress.lastY = event.clientY
    longPress.target = event.target; longPress.el = el; longPress.kind = kind; longPress.id = id
    // Which finger this press belongs to, so the drag it may lift can tell its own pointer's move, release and
    // cancel from a second finger arriving mid-gesture.
    longPress.pointerId = event.pointerId
    longPress.timer = setTimeout(onLongPressFire, 500)
}, true)

document.addEventListener('pointermove', function(event){
    if (!longPress.timer) return
    // Where the finger is NOW, so that the fire - which has no event of its own - arms the drag from the point the
    // menu actually opens at rather than from the point the press began at, up to 10px away. The cancel gate below
    // keeps being measured from the PRESS point: it asks how far the whole press has wandered, which is a different
    // question from where the finger has got to.
    longPress.lastX = event.clientX; longPress.lastY = event.clientY
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
 *                                                                                                                                                    *
 * `sticky` is the gesture trace's mode (see traceGesture): the strip stays up instead of fading, because a gesture worth tracing outlives three        *
 * seconds and the point is to still be readable when the finger comes off. It is not a second element and needs no clean-up of its own: the next       *
 * ordinary toast overwrites the text and re-arms the fade, and on mobile the strip dies with the webview reload that turning the setting off causes.   *
 ***************************************************************************************************************************************************/
var toastTimer = null

function showToast(text, sticky){
    var toast = document.getElementById('cockpitToast')
    if (!toast){ toast = document.createElement('div'); toast.id = 'cockpitToast'; document.body.appendChild(toast) }
    toast.textContent = text
    void toast.offsetWidth        // force a reflow so the opacity transition runs again on each show
    toast.classList.add('-show')
    toast.classList.toggle('-trace', !!sticky)
    if (toastTimer){ clearTimeout(toastTimer); toastTimer = null }
    if (sticky) return            // the trace strip stays up until the gesture is over and something replaces it
    toastTimer = setTimeout(function(){ toast.classList.remove('-show') }, 3000)
}

/** Cross-frame selection drag (desktop) ********************************************************************************************************
 * Selecting text in Joplin's note editor with the mouse and dragging PAST the note's edge is how you extend the selection to the end. When that  *
 * drag crosses into this panel it stops extending, because the panel is a separate (same-origin) iframe: it swallows the drag's pointer events, so *
 * the editor - whose CodeMirror selection is driven by listeners on the MAIN-window document - stops receiving them and the selection freezes at   *
 * the panel edge. The cure is to make THIS panel's own <iframe> element pointer-events:none for the duration of such a foreign drag, so the drag    *
 * falls back through to the main document and the selection keeps extending; the iframe is restored the instant the drag ends. It only ever engages *
 * for a primary-button MOUSE drag that did NOT begin inside the panel, so every normal panel interaction is untouched: clicks, an internal row      *
 * selection drag, dragging rows out (native drag-and-drop, which fires no pointermove), context menus and wheel scroll all start with a press       *
 * inside the panel (panelPointerIsDown), and a foreign drag never does. Desktop only - gated on IS_MOBILE and a mouse pointer - and it needs        *
 * same-origin access to window.parent / window.frameElement, which Joplin's panel iframe provides (a cross-origin host disables it harmlessly).     *
 ***************************************************************************************************************************************************/
// True once we have set our iframe pointer-events:none for an in-progress foreign drag; false otherwise.
var foreignSelectionDragActive = false
// True while a press that BEGAN inside the panel is still held. Such a drag is the panel's own (a click, a
// row selection drag, the start of dragging a row out), never a foreign selection drag to pass through.
var panelPointerIsDown = false

// Our own <iframe> element as seen in the parent (main-window) document. Joplin's plugin panels are
// same-origin, so window.frameElement resolves; guarded so a (hypothetical) cross-origin host disables
// the whole affordance rather than throwing.
function cockpitPanelIframe(){
    try {
        var frame = window.frameElement
        if (frame && frame.style) return frame
    } catch (error){}
    return null
}

// Restore the panel iframe to normal. ALWAYS safe to call, and the single restore path every end-of-drag
// route funnels through; it also clears the press flag, so a drag that ended anywhere (including outside
// the panel) leaves a clean slate for the next one.
function endForeignSelectionDrag(){
    panelPointerIsDown = false
    if (!foreignSelectionDragActive) return
    foreignSelectionDragActive = false
    var frame = cockpitPanelIframe()
    if (frame) frame.style.pointerEvents = ''
}

// Make our iframe transparent to pointer events so the foreign drag falls through to the main document.
function beginForeignSelectionDrag(){
    if (foreignSelectionDragActive) return
    var frame = cockpitPanelIframe()
    if (!frame) return
    foreignSelectionDragActive = true
    frame.style.pointerEvents = 'none'
}

// Runs for each mouse pointer event the panel receives. A primary-button drag the panel did not start is a
// selection drag that has crossed in from the editor: hand it back to the main document.
function onPanelSelectionDragProbe(event){
    if (IS_MOBILE) return                          // desktop only (touch selection has no iframe-boundary issue)
    if (event.pointerType !== 'mouse') return      // mouse only
    if (!(event.buttons & 1)){                     // primary button not held: not a drag...
        if (foreignSelectionDragActive) endForeignSelectionDrag()   // ...and a safety restore if we somehow stayed on
        return
    }
    if (panelPointerIsDown) return                 // the drag began inside the panel: it is the panel's own
    beginForeignSelectionDrag()
}

document.addEventListener('pointerdown', function(event){
    if (event.pointerType === 'mouse') panelPointerIsDown = true
}, true)
// Only a genuine button RELEASE (pointerup) clears the "press began inside" flag - not pointercancel.
// Starting to drag a row OUT of the panel makes the browser fire pointercancel while the button is still
// held (a native drag has taken over the pointer); clearing the flag there would make the drag's own later
// moves look foreign and wrongly punch a hole in the panel. The passthrough is only ever restored via the
// paths in endForeignSelectionDrag (pointerup here, the buttons-released probe branch below, and the parent
// window's end-of-drag events), so dropping pointercancel loses no restore path.
document.addEventListener('pointerup', endForeignSelectionDrag, true)
document.addEventListener('pointerover', onPanelSelectionDragProbe, true)
document.addEventListener('pointermove', onPanelSelectionDragProbe, true)

// While the passthrough is engaged the panel iframe gets no more events (they fall through to the main
// window), so the drag's END fires in the PARENT document, not here. Listen there too and ALWAYS restore:
// on the button release (mouseup / pointerup), on a native drag ending (dragend), and on the window losing
// focus mid-drag (blur - e.g. Alt+Tab). Wired once at load; every handler is a no-op unless a passthrough is
// actually active, so leaving them attached is harmless. Guarded so a cross-origin parent just skips it.
;(function wireParentSelectionDragRestore(){
    try {
        var parentWindow = window.parent
        if (!parentWindow || parentWindow === window) return
        parentWindow.addEventListener('mouseup', endForeignSelectionDrag, true)
        parentWindow.addEventListener('pointerup', endForeignSelectionDrag, true)
        parentWindow.addEventListener('dragend', endForeignSelectionDrag, true)
        parentWindow.addEventListener('blur', endForeignSelectionDrag, true)
    } catch (error){}
})()

/** Drag and drop ***********************************************************************************************************************************
 * Dragging a selected to-do takes the whole selection with it; dragging an unselected one drags just that one. The drop targets - group headings,   *
 * calendar days, week planner columns - carry a data-drop attribute with the date the to-dos become due, or "clear".                                *
 ***************************************************************************************************************************************************/
// Whether a to-do drag STARTED IN THIS PANEL is in flight. A foreign drag - text or a file from another window -
// never raises it, which is what keeps the edge auto-scroll below from moving the list under someone else's drag.
// Raised at the end of onTodoDragStart (once the payload is known to be non-empty) and dropped by endPanelDrag,
// which is to say by the drag's own two ends - a drop and a dragend. Leaving the document is deliberately NOT one
// of them: see onPanelDragLeave.
var panelDragActive = false
// The same ownership, carried IN THE DRAG ITSELF as a custom data type. The flag alone is sticky state: its only
// clears are a drop and a dragend, and a drag whose source row is replaced by a mid-drag re-render (the panel
// re-renders on every sync) can end without either reaching us - the detached row's dragend does not bubble to the
// document. That would leave the flag raised for the NEXT drag, foreign or not. The type travels with the drag
// instead, and dataTransfer.types is readable during dragover's protected mode (getData is not), which is exactly
// where the question is asked. Both are required: the flag says a drag of ours is in flight, the type says THIS
// event belongs to it.
var PANEL_DRAG_TYPE = 'application/x-cockpit-todos'

// Whether this drag event belongs to a to-do drag this panel started. Falls back to the flag alone only when there
// is no dataTransfer to ask at all.
function isPanelDragEvent(event){
    if (!panelDragActive) return false
    var types = event && event.dataTransfer && event.dataTransfer.types
    if (!types) return true
    return Array.prototype.indexOf.call(types, PANEL_DRAG_TYPE) !== -1
}

function onTodoDragStart(event, todoID){
    // Mobile rows carry no ondragstart (formats.ts) and the capturing dragstart listener above cancels any drag the
    // platform starts anyway, so this cannot run on a phone - and if it ever does, the markup gate has leaked and
    // the strip must say so. What must NOT happen is the desktop path running there: it would rewrite the selection,
    // dim the payload and hand Android a drag image while the touch gesture is trying to hold the same finger.
    if (IS_MOBILE){ traceGesture('native-dragstart:handler'); return }
    if (!selectedRowIDs.has(todoID)){
        selectedRowIDs.clear()
        selectedRowIDs.add(todoID)
        paintTodoSelection()
    }
    // The payload is the TO-DOS in the selection: a drop assigns a due date, which a regular note cannot carry,
    // so the notes of a mixed selection are silently left out rather than written to. Only a to-do row is
    // draggable (renderNoteRowHtml emits no draggable attribute and no drag handlers), and the dragged row is
    // itself in the selection by the time this runs, so the list is never empty - but if it somehow were, the
    // drag is cancelled outright rather than started with nothing to drop.
    var ids = schedulableSelection()
    if (!ids.length){ event.preventDefault(); return }
    event.dataTransfer.setData('text/plain', ids.join(','))
    event.dataTransfer.setData(PANEL_DRAG_TYPE, '1')               // ownership that travels with the drag (see above)
    event.dataTransfer.effectAllowed = 'move'
    var dragged = new Set(ids)
    for (var row of allTodoRows()){
        if (dragged.has(row.dataset.todoId)) row.classList.add('-dragging')
    }
    panelDragActive = true
}

function onTodoDragEnd(event){
    for (var row of allTodoRows()) row.classList.remove('-dragging')
    endPanelDrag()
}

function onDropTargetOver(event){
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    paintDropTargetHighlight(event.currentTarget)                  // through the one painter, so nothing else stays lit
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
    selectedRowIDs.clear()
    await webviewApi.postMessage(['todosDropped', ids, target]);
}

/** Drop BETWEEN rows (desktop, list views) *************************************************************************************************************
 * A second drop kind, alongside the whole-row date targets above: dropping into the GAP between two stacked to-do rows (or at a group's top/bottom     *
 * edge) assigns due datetimes IN BETWEEN the neighbours. This is desktop-only (a mobile row is not draggable at all - see the dragstart block above)   *
 * and stateless DOM wiring - it reads the                                                                                                              *
 * existing markup (the row's data-todo-id and its group heading's data-drop date) and posts, holding nothing across renders but the transient indicator *
 * class, which is cleared on every dragover, on dragend and on drop. It lives only in the LIST views: an eligible row is a .todo[data-todo-id] that is a *
 * DIRECT child of the .todos container (week cards sit in .week-day, month/notes/peek rows in their own sections, so those are excluded). A DATED group *
 * (heading data-drop = YYYY-MM-DD) anchors its top edge on that date and its bottom edge on data-drop-end, the last day of the group's slice, which is  *
 * a later day whenever the group spans more than one. A DATELESS group (Overdue/Future, no data-drop) is eligible too - an interior drop needs no group *
 * date and its edges are derived host-side from the neighbour's own due. Only the No-Due group (data-drop "clear") is excluded: its rows carry no due,  *
 * so there is nothing to sit between.                                                                                                                  *
 *                                                                                                                                                        *
 * The gap is a thin band at each row boundary: the top BETWEEN_BAND of a row means "insert before it", the bottom band "insert after it", and the middle *
 * keeps today's behaviour (nothing - no indicator, no drop). The insertion line is drawn as an inset box-shadow on the row (.-drop-before/.-drop-after   *
 * in panel.css), so it marks the boundary without adding height (no layout shift). On drop the neighbours are the nearest non-dragged to-do rows on      *
 * either side of the gap within the same group (a heading boundary ends the group -> a null neighbour == a group edge); the host re-reads their dues.    *
 ***************************************************************************************************************************************************/
var BETWEEN_BAND = 0.4                 // top 40% / bottom 40% of a row are the between-zones; the middle 20% is inert
var betweenIndicatorRow = null         // the row currently showing an insertion line, so it can be cleared on the next move

// The nearest preceding <h2> group heading of a row (walking element siblings within .todos).
function betweenGroupHeading(row){
    var el = row.previousElementSibling
    while (el){
        if (el.tagName === 'H2') return el
        el = el.previousElementSibling
    }
    return null
}

// The between-eligibility of a row and, when eligible, the group's date target. Returns { groupDate } for an eligible
// row: groupDate is the group's calendar date ('YYYY-MM-DD') for a DATED group, or null for a DATELESS group
// (Overdue/Future) whose edge day the host derives from the neighbour's own due. Returns null (not eligible) for a row
// outside the .todos list (list views only), a headingless row, or the No-Due group (data-drop 'clear'): its rows carry
// no due, so there is nothing to sit BETWEEN. An INTERIOR drop (both neighbours present) needs no group date at all -
// the neighbours' dues define the interval - which is exactly what lets the dateless groups take between-drops.
function betweenGroupInfo(row){
    if (!row || !row.parentElement || !row.parentElement.classList.contains('todos')) return null
    var heading = betweenGroupHeading(row)
    if (!heading) return null
    var drop = heading.getAttribute('data-drop')
    if (drop === 'clear') return null                             // No-Due: its rows have no due to be between
    if (drop && /^\d{4}-\d{2}-\d{2}$/.test(drop)){
        // A heading that names a STRETCH of days (an interval period section) carries the last day of its slice too;
        // its data-drop is only the FIRST day, which would put the bottom edge's bound before the group's own rows.
        var end = heading.getAttribute('data-drop-end')
        return { groupDate: drop, groupEndDate: (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) ? end : drop }
    }
    return { groupDate: null, groupEndDate: null }                // dateless group (Overdue/Future): edges from neighbours
}

// The eligible between-target under the pointer, or null when the pointer is over a row's inert middle or not over an
// eligible row at all. `before` is true in the top band (insert above the row), false in the bottom band (insert below).
function betweenTargetAt(element, clientY){
    var row = (element && element.closest) ? element.closest('.todo[data-todo-id]') : null
    if (!row) return null
    var info = betweenGroupInfo(row)
    if (!info) return null
    var rect = row.getBoundingClientRect()
    if (!rect.height) return null
    var offset = clientY - rect.top
    if (offset <= rect.height * BETWEEN_BAND) return { row: row, before: true, groupDate: info.groupDate, groupEndDate: info.groupEndDate }
    if (offset >= rect.height * (1 - BETWEEN_BAND)) return { row: row, before: false, groupDate: info.groupDate, groupEndDate: info.groupEndDate }
    return null                                                    // the inert middle: keep today's behaviour (nothing)
}

// The same question asked of a drag event. Split from the form above so the edge auto-scroll can re-ask it from its
// own loop, at the last known pointer position, while the rows move under a pointer that is holding still.
function betweenTargetFor(event){
    return betweenTargetAt(event.target, event.clientY)
}

// Draw (or clear) the insertion line for a resolved between-target. One painter for both callers - the dragover
// handler and the scroll loop's refresh - so the two can never drift into painting it differently.
function paintBetweenIndicator(target){
    if (!target){ clearBetweenIndicator(); return }
    if (betweenIndicatorRow !== target.row) clearBetweenIndicator()
    betweenIndicatorRow = target.row
    target.row.classList.remove('-drop-before', '-drop-after')
    target.row.classList.add(target.before ? '-drop-before' : '-drop-after')
}

function clearBetweenIndicator(){
    if (betweenIndicatorRow){
        betweenIndicatorRow.classList.remove('-drop-before', '-drop-after')
        betweenIndicatorRow = null
    }
}

// The id of the nearest to-do row NOT in the dragged set, walking from `startEl` in `direction` (-1 up, +1 down), or
// null when a group heading (or the group's end) is reached first - a group edge.
function betweenNeighbour(startEl, direction, draggedSet){
    var el = startEl
    while (el){
        if (el.tagName === 'H2') return null                       // crossed the group boundary -> edge
        if (el.classList && el.classList.contains('todo') && el.dataset && el.dataset.todoId && !draggedSet.has(el.dataset.todoId)){
            return el.dataset.todoId
        }
        el = direction < 0 ? el.previousElementSibling : el.nextElementSibling
    }
    return null
}

// The two neighbours of a gap, as ids: the nearest non-dragged to-do rows above and below it within the same group
// (a heading boundary ends the group, so a null neighbour means a group EDGE). `before` says which side of `row` the
// gap is on. One resolution for both gestures - the desktop drop below and the touch drop - so the two can never
// come to different answers about the same gap.
function betweenNeighboursAt(row, before, draggedSet){
    var upperStart = before ? row.previousElementSibling : row
    var lowerStart = before ? row : row.nextElementSibling
    return { prevId: betweenNeighbour(upperStart, -1, draggedSet), nextId: betweenNeighbour(lowerStart, +1, draggedSet) }
}

function onBetweenDragOver(event){
    if (IS_MOBILE || !isPanelDragEvent(event)) return              // never for a drag this panel did not start
    var target = betweenTargetFor(event)
    if (!target){ clearBetweenIndicator(); return }
    event.preventDefault()                                         // enable the drop on the row (rows have no inline handler)
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    paintBetweenIndicator(target)
}

async function onBetweenDrop(event){
    if (IS_MOBILE) return
    var target = betweenTargetFor(event)
    clearBetweenIndicator()
    if (!target){
        // A heading/cell drop bubbles here too; its own handler ran and already prevented the default. So does a
        // release the edge auto-scroll accepted at the document level (see onDragAutoscroll) that landed on a row's
        // inert middle: there is nothing to do, but the default action must still be suppressed rather than let the
        // browser act on the dragged text.
        if (panelDragActive) event.preventDefault()
        return
    }
    event.preventDefault()
    var ids = (event.dataTransfer && event.dataTransfer.getData('text/plain') || '').split(',').filter(Boolean)
    if (!ids.length) return
    var neighbours = betweenNeighboursAt(target.row, target.before, new Set(ids))
    var prevId = neighbours.prevId
    var nextId = neighbours.nextId
    selectedRowIDs.clear()
    await webviewApi.postMessage(['todosDroppedBetween', ids, prevId, nextId, target.groupDate, target.groupEndDate])
}

// Delegated on the document so a single wiring survives every setHtml re-render (the rows are recreated each time). The
// indicator is cleared on dragend too, in case the drag ends off any row (a cancel, or a drop outside .todos).
document.addEventListener('dragover', onBetweenDragOver, false)
document.addEventListener('drop', onBetweenDrop, false)
document.addEventListener('dragend', clearBetweenIndicator, false)

/** Edge auto-scroll ********************************************************************************************************************************
 * A native drag can only reach what is already on screen: the pointer belongs to the drag, the wheel does not follow it, and the panel's list is an *
 * inner scroller (Joplin's webview skeleton sets overflow:hidden on the html element, and .todos is the only thing that scrolls in a list view), so *
 * a heading or a calendar day above or below the viewport is unreachable. While a drag is in flight and the pointer sits inside a band at the top   *
 * or bottom edge of the scrolling container, that container scrolls continuously in that direction, and the target under the pointer changes with   *
 * it.                                                                                                                                               *
 *                                                                                                                                                   *
 * The helper is INPUT-AGNOSTIC on purpose: it knows nothing about drag events, only a container and a pointer's clientY. The HTML5 drag wires it up *
 * below (desktop only); the touch drag being designed for mobile is meant to call the same update()/stop() with its own pointer coordinates rather  *
 * than growing a second copy of the band and speed maths.                                                                                           *
 *                                                                                                                                                   *
 *   update(container, clientX, clientY, onScroll)  aim the loop at a container and a pointer position - it starts the loop inside a band, and stops *
 *                                                  it outside both. onScroll (optional) is called with that same pointer position after every frame *
 *                                                  that actually moved, so a caller can re-resolve what is now under a still pointer.               *
 *   stop()                                         end it at once.                                                                                  *
 *                                                                                                                                                   *
 * Nothing outlives a gesture, and the gesture's own ends are what say so: the pointer leaving the band (a move produces an update()), a drop, a      *
 * dragend, and the scroll limit all stop the loop directly, and stop() cancels the pending frame. The AUTOSCROLL_IDLE_MS watchdog is a SAFETY NET   *
 * on top of those, not the thing that keeps the loop alive: it must sit well above any caller's event cadence, because a pointer HOLDING STILL is   *
 * the gesture this exists for, and a still pointer is exactly when events dry up. The HTML drag-and-drop model iterates every 350ms for a stationary *
 * pointer, and a stationary finger in the coming touch drag emits no move events at all - so the watchdog only catches the case with no other end:  *
 * the pointer leaving the window, or a drag that ended without an event reaching us.                                                                *
 ***************************************************************************************************************************************************/
var AUTOSCROLL_BAND_RATIO = 0.15       // the edge band is this share of the container's client height...
var AUTOSCROLL_BAND_MIN = 32           // ...but never thinner than this (a short list would otherwise have no band worth hitting)...
var AUTOSCROLL_BAND_MAX = 72           // ...and never thicker (a tall list must not turn a sixth of itself into a moving floor)
var AUTOSCROLL_SPEED_MIN = 2           // px per frame at the band's INNER edge - a nudge, for placing a drop precisely
var AUTOSCROLL_SPEED_MAX = 16          // px per frame at the container's very edge - fast enough to cross a long agenda
var AUTOSCROLL_IDLE_MS = 800           // watchdog: no update() for this long and the loop stops itself (a safety net - see the banner)

var autoscrollEl = null                // the container being scrolled, or null when no loop is running
var autoscrollStep = 0                 // signed px per frame: negative scrolls up, positive down
var autoscrollFrame = null             // the pending requestAnimationFrame handle, or null
var autoscrollAt = 0                   // Date.now() of the last update(), which the watchdog measures against
var autoscrollClientX = 0              // the pointer position the last update() reported, handed back to the callback so
var autoscrollClientY = 0              // ...it can re-resolve what is under a pointer the rows are moving beneath
var autoscrollOnScroll = null          // optional callback, run after each frame that moved the container

// The nearest ancestor of `el` (itself included) that actually scrolls vertically, or null when nothing does.
function scrollableAncestor(el){
    var node = el
    while (node && node.nodeType === 1){
        var overflowY = window.getComputedStyle(node).overflowY
        if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
        node = node.parentElement
    }
    return null
}

// The signed px-per-frame step for a pointer at (clientX, clientY) over `el`: zero away from both edges and zero once
// the pointer is off to the SIDE of the container (that is someone else's gesture), and otherwise a speed rising
// linearly with how deep into the band the pointer is, from AUTOSCROLL_SPEED_MIN at the band's inner edge to
// AUTOSCROLL_SPEED_MAX at the container's own edge. A pointer that has OVERSHOT the container vertically is pinned at
// full speed rather than dropped to zero: `.todos` has the controls block above it and the panel's padding below, so
// the instinctive "shove it to the very top to keep scrolling" lands a few pixels outside the box, and stopping dead
// there would recreate the very unreachability this exists to fix.
function edgeAutoscrollStep(el, clientX, clientY){
    var rect = el.getBoundingClientRect()
    if (!rect.height) return 0
    if (clientX < rect.left || clientX > rect.right) return 0
    if (clientY < rect.top) return -AUTOSCROLL_SPEED_MAX
    if (clientY > rect.bottom) return AUTOSCROLL_SPEED_MAX
    // Also clamped to half the height, so the two bands can never overlap in a very short container. The band tests
    // are strict, so in a container that short the exact midpoint belongs to neither band and stays inert.
    var band = Math.min(rect.height / 2, Math.max(AUTOSCROLL_BAND_MIN, Math.min(AUTOSCROLL_BAND_MAX, rect.height * AUTOSCROLL_BAND_RATIO)))
    var speedAt = function(depth){
        var reach = Math.max(0, Math.min(1, depth / band))
        return AUTOSCROLL_SPEED_MIN + (AUTOSCROLL_SPEED_MAX - AUTOSCROLL_SPEED_MIN) * reach
    }
    var fromTop = clientY - rect.top
    if (fromTop < band) return -speedAt(band - fromTop)
    var fromBottom = rect.bottom - clientY
    if (fromBottom < band) return speedAt(band - fromBottom)
    return 0
}

function edgeAutoscrollTick(){
    autoscrollFrame = null
    var el = autoscrollEl
    if (!el || !autoscrollStep) return
    // The watchdog (a safety net well above any caller's cadence - see the banner): no update() for this long means
    // the pointer left the window, or the gesture ended without an event reaching us. Either way the list stops.
    if (Date.now() - autoscrollAt > AUTOSCROLL_IDLE_MS){ edgeAutoscrollStop(); return }
    var before = el.scrollTop
    el.scrollTop = before + autoscrollStep
    if (el.scrollTop === before){ edgeAutoscrollStop(); return }   // at the scroll limit: there is nothing left to give
    // The next frame is booked BEFORE the callback runs, so a callback that throws (elementFromPoint mid-teardown,
    // say) cannot leave the loop dead-but-not-stopped: with autoscrollFrame null and the rest still set, only a
    // later update() would revive it. The throw is swallowed for the same reason.
    autoscrollFrame = requestAnimationFrame(edgeAutoscrollTick)
    if (autoscrollOnScroll){
        try { autoscrollOnScroll(autoscrollClientX, autoscrollClientY) } catch (error){}
    }
}

function edgeAutoscrollUpdate(container, clientX, clientY, onScroll){
    var step = container ? edgeAutoscrollStep(container, clientX, clientY) : 0
    if (!step){ edgeAutoscrollStop(); return }
    autoscrollEl = container
    autoscrollStep = step
    autoscrollClientX = clientX
    autoscrollClientY = clientY
    autoscrollAt = Date.now()
    autoscrollOnScroll = onScroll || null
    if (autoscrollFrame === null) autoscrollFrame = requestAnimationFrame(edgeAutoscrollTick)
}

// Whether a scroll loop is running right now. The HTML5 wiring asks so it can accept the drop while the list moves.
function edgeAutoscrollRunning(){
    return autoscrollFrame !== null
}

function edgeAutoscrollStop(){
    if (autoscrollFrame !== null) cancelAnimationFrame(autoscrollFrame)
    autoscrollFrame = null
    autoscrollEl = null
    autoscrollStep = 0
    autoscrollOnScroll = null
}

/** The HTML5 drag's wiring (desktop) ***************************************************************************************************************
 * Delegated on the document, like the between-rows gesture above, so one wiring survives every setHtml. It runs only for a drag THIS PANEL started  *
 * (isPanelDragEvent: the in-flight flag AND the ownership type the drag itself carries): text dragged in from another window must never make the    *
 * list run away under the cursor. Both ends are covered - a drop and a dragend each end the drag - and neither changes WHAT a drop does; the one    *
 * thing this adds to the drop is WHETHER it is offered at all while the list is moving, which the acceptance note in the handler explains.          *
 ***************************************************************************************************************************************************/
function onDragAutoscroll(event){
    if (IS_MOBILE || !isPanelDragEvent(event)) return
    // The scroller under the pointer - in practice always .todos, the only thing that scrolls in a list view. The
    // fallback keeps a pointer that is over nothing scrollable (a heading, the padding) aimed at the same list.
    var container = scrollableAncestor(event.target) || currentTodosEl || document.querySelector('.todos')
    edgeAutoscrollUpdate(container, event.clientX, event.clientY, refreshDropTargetsUnderPointer)
    if (!edgeAutoscrollRunning()) return
    // While the list is MOVING, the drop is accepted here, at the document level. Acceptance is otherwise granted per
    // dragover by whatever sits under the pointer (a heading's inline ondragover, or onBetweenDragOver for a gap),
    // and the browser decides whether to fire `drop` at all from the LAST dragover it delivered - so a release during
    // a scroll would be REFUSED outright whenever the target that has just slid under the pointer had not been asked
    // yet, and the to-do would silently not move. Both drop handlers re-resolve the target from the release point, so
    // accepting broadly here costs nothing: a release over an inert spot is a no-op instead of a cancelled drag.
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

// Both drop affordances, re-resolved after every scrolled frame from whatever is now at the pointer - the same answer
// a dragover there would have produced. The rows and headings move under a pointer that is HOLDING STILL, which is
// the whole gesture, and the drag's own next dragover can be hundreds of milliseconds away: without this the
// insertion line sits in a gap the rows have left, and a whole-row target keeps its highlight after it has slid away
// (`-drop-over` is otherwise only ever removed by that element's own dragleave, which a still pointer never fires).
function refreshDropTargetsUnderPointer(clientX, clientY){
    var under = document.elementFromPoint(clientX, clientY)
    paintBetweenIndicator(under ? betweenTargetAt(under, clientY) : null)
    paintDropTargetHighlight(under && under.closest ? under.closest('[data-drop]') : null)
}

// Give `target` (or nothing) the whole-row drop highlight, taking it off whatever held it before. One painter, so the
// scroll loop and the inline dragover/dragleave handlers can never leave two elements lit at once.
function paintDropTargetHighlight(target){
    for (var el of document.querySelectorAll('.-drop-over')){
        if (el !== target) el.classList.remove('-drop-over')
    }
    if (target) target.classList.add('-drop-over')
}

// Everything a drag leaves running or lit, taken back down: the scroll loop and both transient paints. Kept apart
// from the ownership flag on purpose - a drag that has merely left the document needs exactly this and NOT that
// (see onPanelDragLeave). The paints are swept rather than left to their own dragleave handlers because a gesture
// can end owing no dragleave at all: a target the list scrolled under a still pointer would otherwise keep its
// highlight until the next re-render.
function clearPanelDragEffects(){
    edgeAutoscrollStop()
    paintDropTargetHighlight(null)
    clearBetweenIndicator()
}

// The drag's own two ends, a drop and a dragend: the effects go, and so does ownership.
function endPanelDrag(){
    panelDragActive = false
    clearPanelDragEffects()
}

// A drag that leaves the panel's document altogether takes its effects down here and now. Without this the loop
// coasts for the whole AUTOSCROLL_IDLE_MS watchdog - and the overshoot rule makes that the WORST case rather than
// the mildest one: a pointer carried out through the top or bottom edge is outside the container vertically, which
// pins the speed at AUTOSCROLL_SPEED_MAX, so the list runs on for ~800ms x 60fps x 16px, most of a thousand pixels,
// after the drag has visibly left.
//
// What it must NOT do is end the OWNERSHIP, and that is the whole reason clearPanelDragEffects is a function of its
// own. Leaving is not an END: the HTML5 drag OPERATION survives the pointer leaving the iframe, and the same drag
// brought back over the list delivers its dragovers again - it has to be able to draw an insertion line, scroll and
// drop exactly as it could before it went. Dropping the flag here would make the departure a one-way door, and a
// half-silent one: onBetweenDragOver bails on the ownership gate before its own preventDefault, so no insertion
// line would be drawn and the browser would fire no drop at all, while heading and calendar-day drops - whose
// handler is not gated - carried on working. The flag stays with its own two ends, a drop and a dragend.
//
// Both conditions are required:
//   - relatedTarget null: the drag moved to no element of THIS document. On its own that is NOT "left the document".
//     A dragleave also fires when the element under a pointer changes, which is exactly what the auto-scroll does to
//     a pointer HOLDING STILL - it moves the rows, not the pointer - and Blink does not reliably name the element
//     the drag moved to. Acting on relatedTarget alone would kill the loop the moment its own scrolling worked.
//   - the pointer outside the document's own box: which is what leaving through an edge actually looks like, and
//     what a still pointer inside the list can never be. The box test is strict on the near edges (a pointer at
//     exactly clientX or clientY 0 counts as departed), which is the one assumption left in it: an in-document
//     dragleave is taken never to arrive with a zeroed coordinate. If that is ever wrong it costs one pixel at the
//     very top-left corner, and only until the drag's next dragover restarts the loop.
// Missing a real departure costs nothing worse than the old behaviour (the watchdog still ends it); stopping a live
// gesture's scrolling by mistake would cost the feature for as long as the pointer then holds still, so the test is
// the strict one.
function onPanelDragLeave(event){
    if (IS_MOBILE || !isPanelDragEvent(event)) return
    if (event.relatedTarget !== null) return
    var x = event.clientX, y = event.clientY
    if (x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight) return
    clearPanelDragEffects()
}

document.addEventListener('dragover', onDragAutoscroll, false)
document.addEventListener('drop', endPanelDrag, false)
document.addEventListener('dragend', endPanelDrag, false)
document.addEventListener('dragleave', onPanelDragLeave, false)

/** No native HTML5 drag on mobile, ever ************************************************************************************************************
 * ANDROID STARTS A NATIVE DRAG FROM A LONG PRESS ON A DRAGGABLE ELEMENT, and the third Pixel round is where this repo found that out. The owner's     *
 * screenshot of a failed drag shows a translucent COPY of the pressed row floating below his finger - the platform's own drag image - and the gesture *
 * strip for that press reads `contextmenu-suppressed:row` and then nothing: no `menu-open`, because the WebView fired dragstart and CANCELLED the     *
 * touch sequence, and a cancelled sequence takes the 500ms long-press timer with it. No menu, no arm, no touch drag. The one drop that still worked   *
 * was onto a heading, because the NATIVE drag found the heading's inline ondrop - the desktop path - while a gap needs the touch path that never       *
 * started. Four device reports, one cause.                                                                                                             *
 *                                                                                                                                                      *
 * The fix is in the markup: a mobile row carries no draggable attribute and no drag handlers (renderTodoRowHtml's nativeDrag and renderWeekCard, in     *
 * src/core/formats.ts), so there is nothing for the platform to pick up. This listener is the belt to that: whatever else in the panel might one day    *
 * be draggable, on mobile no dragstart is allowed to become a drag, and one that is attempted is NAMED on the strip so the next device round can say   *
 * whether Android still tries. Capture at the document, so it runs before any inline ondragstart and before anything can stop it on the way up.        *
 * Desktop returns on the first line and its drag is untouched.                                                                                          *
 ***************************************************************************************************************************************************/
document.addEventListener('dragstart', function(event){
    if (!IS_MOBILE) return
    traceGesture('native-dragstart')
    event.preventDefault()
}, true)

/** Drag to reschedule on touch (mobile) ************************************************************************************************************
 * The same two drops the desktop drag offers - into the GAP between two rows, and onto a whole-row [data-drop] target (a group heading including "No  *
 * Due Date", a calendar day, a week column) - reached by a finger. A finger cannot drive the HTML5 drag above - and the drag Android DOES start from a *
 * long press is the enemy of this gesture rather than a way into it, which is why mobile rows carry no draggable attribute at all (see the block just  *
 * above). So none of the machinery above can be used directly; what IS reused, unchanged, is everything below the input layer: betweenGroupInfo's eligibility, the neighbour walk, the two       *
 * indicator painters, the edge auto-scroll helper, and both message shapes - so a touch drop and a mouse drop are the same operation, and the host    *
 * cannot tell them apart.                                                                                                                             *
 *                                                                                                                                                     *
 * THE GESTURE IS MENU-FIRST, and the first Pixel round is why. The design that shipped in the first draft LIFTED the row at the 500ms and deferred    *
 * the menu to a release that never travelled; on the device that lift arrived in the middle of Joplin's own side-menu swipe and the drag did not work  *
 * at all. So the hold now does exactly what it did before this feature existed - it opens the to-do's context menu, with the finger still down - and   *
 * the drag is ARMED behind it, invisibly. What the finger does NEXT decides between the two, once, on the first travel past the LIFT THRESHOLD: UP or  *
 * DOWN lifts the row into the drag and closes the menu; SIDEWAYS is not ours, so the arming is thrown away silently and Android's own gesture is left  *
 * to do whatever it does.                                                                                                                              *
 *                                                                                                                                                      *
 * THE TOLERANCE, which is the third Pixel round's whole subject. The travel is measured from the FIRE point - where the finger was when the menu        *
 * opened - and it has to pass TOUCH_DRAG_LIFT_PX (20), not the 10px slop the PRESS survives on. The previous build measured from the press point with  *
 * the press's own slop, so the two gates were the same number from the same origin and an armed gesture was born one pixel from its own lift: the      *
 * smallest drift closed the menu in the frame after it opened and dimmed the row under a finger that had asked for nothing. That one arithmetic        *
 * produced two of the round's four reports - "the context menu doesn't appear at all on the long press" and "it is moving a little straight away".      *
 * Below the threshold NOTHING happens: nothing is painted, nothing is closed, no guard is taken, and no direction has been decided.                     *
 *                                                                                                                                                      *
 *   (the press)        -> armed   (500ms: the menu opens; capture, the touchmove listener, the row index and the watchdog go on. Nothing visible.)      *
 *   armed              -> lifted  (first travel past the LIFT threshold, |dy| >= |dx|: menu closed, guard taken, the moving rows dim, banner up)        *
 *   armed              -> released (the finger comes up without travelling: the arming is torn down, the menu stays open. Nothing was ever taken.)      *
 *   armed              -> sideways (first travel past the threshold, |dx| > |dy|: torn down, menu left open - the side menu may have the stroke)        *
 *   lifted             -> dropped (release over a gap or a [data-drop]: the message, then the guard release)                                            *
 *   lifted             -> cancelled (release over nothing, a second finger, a pointercancel, the app hiding, a resize/rotation, the watchdog)           *
 *   armed              -> cancelled (the same set: an armed gesture ends the same way, having nothing to release)                                       *
 *                                                                                                                                                     *
 * WHY A NON-PASSIVE touchmove, AND WHY IT PREVENTS FROM THE ARM. Preventing the default on touchmove is the ONE thing that stops Android panning the   *
 * list; a document-level touchmove listener is passive by default in Chrome, and a passive listener's preventDefault() is ignored with a console       *
 * warning. It is attached only from the arm onwards, so ordinary flick-scrolling is never routed through it - and from the arm it prevents EVERY move, *
 * not only the lifted ones. The earlier design left the armed phase unprevented so that a sideways stroke would reach Android whole; the price was     *
 * that the list panned under a held finger, which moved every row out from under the just-opened menu, fired the document scroll listener that closed  *
 * it, and read as the row already moving. The sideways rule survives the change because Joplin's side-menu responder is on the NATIVE side of the      *
 * WebView: this document's preventDefault cancels this document's own default (the pan) and nothing beyond it, so a sideways first move still ends the *
 * gesture and still reaches the app. That is a claim about the platform rather than about this file, and it is the make-or-break device question       *
 * (MOBILE.md, step 18b) - as is whether Android lets the panel keep the finger at all.                                                                  *
 *                                                                                                                                                     *
 * WHY THE ROW IS FOUND BY GEOMETRY, AND WHY THE GEOMETRY IS AUTHORITATIVE. The mobile checkbox ring is a ~40px box overhanging a ~26px row, so        *
 * document.elementFromPoint in the left column returns the NEIGHBOUR row about as often as the right one. The rows' boxes are indexed at arm time      *
 * (shifted by every scroll, and rebuilt whenever the candidate row's live box disagrees with the index - see rowEntryAtY), and the finger's y is       *
 * searched against that index by the pure window.TouchDrag. elementFromPoint is asked TWO questions only - is there a [data-drop] here, is there an h2 *
 * here - and its answer to anything else vetoes nothing: the banner, the trace strip, a menu, the body and the dragged row itself all float over the   *
 * rows on a phone, and none of them gets a say in where the rows are. A heading does, because it is a SIBLING of the rows sitting in the gap the index *
 * would attribute to the row above, and a sticky one floating over the list is genuinely what the finger is on (z-index 2 puts it above any ring       *
 * overhanging from below) - so a heading under the finger ends the resolution either way, as its own target or as a named refusal.                      *
 *                                                                                                                                                     *
 * THE REFRESH GUARD, AND WHY IT IS TAKEN AT THE LIFT RATHER THAN AT THE ARM. A mobile refresh is a full webview RELOAD, which would destroy a drag in  *
 * progress, so a real drag holds ['dialogGuard', true] and releases it on every exit path. It is deliberately NOT taken when the press merely arms,    *
 * because the host answers the RELEASE by repainting once (panel.ts: the last guard down runs refreshPanelData) - and on the released and sideways     *
 * paths that repaint would reload the webview out from under the context menu the press had just opened, breaking the gesture this design exists to    *
 * keep. Taking it at the lift keeps the pair strictly inside the drag proper: a hold-and-release, and a hold-and-swipe, never touch the guard at all.  *
 * The cost is that a refresh landing in the moment between the arm and the lift ends the gesture by reloading - silently, with nothing left holding,   *
 * which is the harmless direction.                                                                                                                     *
 ***************************************************************************************************************************************************/
var TOUCH_DRAG_BAND = 0.5              // mobile: the whole row is live - the top half inserts before it, the bottom half after
var TOUCH_DRAG_SLOP = 10               // px per axis the long PRESS survives, measured from the press point (the adapter's own cancel gate)
var TOUCH_DRAG_LIFT_PX = 20            // ...and px per axis from the FIRE point before the armed gesture decides anything at all: twice the press's
                                       // own gate and about twice Android's ~8dp touch slop, so a held finger's drift can never decide for the user,
                                       // while a deliberate stroke crosses it within half a 40px mobile row
var TOUCH_DRAG_WATCHDOG_MS = 15000     // last resort: no gesture lasts this long, and a stuck one must not hold the guard
var ROW_INDEX_TOLERANCE_PX = 2         // how far a row's indexed box may disagree with its live one before the index is rebuilt

var touchDrag = {
    active: false,          // the gesture owns this finger right now - armed behind the menu, or lifted
    lifted: false,          // ...and the row is actually up: the drag proper, the only state that paints or prevents
    guarded: false,         // ...and the refresh guard has been taken for it (the lift onwards)
    pointerId: null,        // the finger that armed it; a second one cancels
    id: null,               // the pressed row's to-do id, snapshotted at the arm (see liftTouchDrag)
    ids: [],                // the payload, as schedulableSelection() resolved it at the lift
    row: null,              // the pressed row element
    title: '',              // ...and its title, for the banner (read at the lift, which is the only thing that shows it)
    index: null,            // [{ el, top, bottom, info }] - the rows' boxes, searched by y
    indexTop: 0,            // ...and the list's scrollTop when they were measured, so a scroll can shift them
    indexRows: 0,           // ...and how many to-do rows the list held then, the one cheap test of "is this still that list"

    startX: 0, startY: 0,
    x: 0, y: 0,             // the finger's last position, which the auto-scroll re-resolves against
    target: null,           // the resolved drop - { kind: 'between'|'drop' } or { kind: 'none', reason } - null before the first resolve
    autoscroll: 0,          // -1 up / +1 down / 0 not scrolling, traced only when it changes
    watchdog: null,
}

// Whether a long press on a to-do row may ARM the drag behind the menu it has just opened. The three zones that
// already mean something else keep their meaning, and the read-only peek is never a reschedule source (its rows are
// rendered draggable:false for exactly that reason, see renderTodoRowHtml) - all of them get their menu and nothing
// else. A press inside an open overlay never gets this far: the adapter's pointerdown returns on #cockpitOverlay.
function canLiftRow(target, row){
    if (!row || !row.dataset || !row.dataset.todoId) return false
    if (!target || !target.classList) return false
    if (target.classList.contains('todo-checkbox')) return false             // the tick circle opens the date picker
    if (target.classList.contains('todo-notebook')) return false             // the pill moves the note
    if (target.closest && target.closest('.outside-results')) return false   // the read-only peek never drags
    return true
}

// The one scroller the drag cares about: .todos is the only thing in a list view that scrolls.
function touchDragScroller(){
    return currentTodosEl || document.querySelector('.todos')
}

// A label short enough for one line of the banner.
function shortLabel(text){
    var value = String(text || '').replace(/\s+/g, ' ').trim()
    return value.length > 30 ? value.slice(0, 29) + '…' : value
}

// What to call a row in the banner: its title, which is the only part of a row the user reads.
function rowLabel(row){
    var title = row ? row.querySelector('.todo-title') : null
    return shortLabel(title ? title.textContent : '')
}

// Four characters of a note id, for the drop trace: enough to tell one neighbour from another on the strip, and
// '-' for the end of a group, where there is no neighbour at all.
function traceId(id){
    return id ? String(id).slice(0, 4) : '-'
}

// What to call a whole-row drop target: a heading says itself ("Today", "No Due Date"), and a calendar day or a
// week column says the date it carries - the one thing every [data-drop] has.
function dropTargetLabel(el){
    return shortLabel(el.tagName === 'H2' ? el.textContent : el.getAttribute('data-drop'))
}

/** buildRowIndex ***********************************************************************************************************************************
 * The rows' live boxes, in document order, with the between-eligibility each one already resolves to (null for the No-Due group, for a week card and *
 * for anything outside the .todos list - see betweenGroupInfo). The read-only peek's rows are left out entirely: they are not a target of any kind.  *
 * Measured once at the arm; every later scroll SHIFTS it (see syncRowIndex) rather than re-measuring, because     *
 * the boxes move while the finger holds still.                                                                                                       *
 ***************************************************************************************************************************************************/
function buildRowIndex(){
    var rows = []
    for (var row of allTodoRows()){
        if (row.closest && row.closest('.outside-results')) continue
        var rect = row.getBoundingClientRect()
        if (!rect.height) continue
        rows.push({ el: row, top: rect.top, bottom: rect.bottom, info: betweenGroupInfo(row) })
    }
    touchDrag.index = rows
    var scroller = touchDragScroller()
    touchDrag.indexTop = scroller ? scroller.scrollTop : 0
    // Not rows.length: the peek's rows and any zero-height row are skipped above, so what is recorded is the LIVE
    // count this index was measured against - the one thing a no-candidate lookup can cheaply re-ask (rowEntryAtY).
    touchDrag.indexRows = document.querySelectorAll('.todo[data-todo-id]').length
}

/** rowEntryAtY *************************************************************************************************************************************
 * The indexed row under a y, with the index verified against the screen first. The shift in syncRowIndex is exact for a SCROLL and nothing else, and *
 * a mobile panel has other ways to move a row: a re-render between two frames of the drag, a group folding, the soft keyboard resizing the viewport. *
 * A shifted-but-wrong index is the worst failure this gesture has, because it is silent - the insertion line paints somewhere plausible and the drop *
 * writes the neighbours of a row the finger was never over.                                                                                          *
 *                                                                                                                                                    *
 * So the CANDIDATE is checked, and only the candidate: one getBoundingClientRect() on the single row the search returned, against the box the index   *
 * holds for it. More than ROW_INDEX_TOLERANCE_PX apart (or the row is no longer in the document) and the whole index is rebuilt and the search re-run *
 * once. That is one rect per move in the ordinary case, against a full rebuild's rect-plus-heading-walk for every row in the list, which is the cost  *
 * the shift exists to avoid on the device.                                                                                                            *
 *                                                                                                                                                    *
 * With NO candidate there is no row to check - a finger in the whitespace below the last row is the ordinary way to have none - so the cheap question *
 * asked instead is whether the LIST is still the one that was measured, by its row count. That keeps a finger parked off the end of the list from     *
 * rebuilding the index on every frame, while a re-render that added or removed rows still forces the rebuild it needs.                                *
 ***************************************************************************************************************************************************/
function rowEntryAtY(y){
    var entry = window.TouchDrag.rowAtY(touchDrag.index, y)
    if (!rowIndexIsStale(entry)) return entry
    buildRowIndex()
    return window.TouchDrag.rowAtY(touchDrag.index, y)
}

function rowIndexIsStale(entry){
    if (!entry) return document.querySelectorAll('.todo[data-todo-id]').length !== touchDrag.indexRows
    if (!entry.el || !entry.el.isConnected) return true
    return Math.abs(entry.el.getBoundingClientRect().top - entry.top) > ROW_INDEX_TOLERANCE_PX
}

/** syncRowIndex ************************************************************************************************************************************
 * The index after the list has scrolled - the drag's own auto-scroll, or anything else that moves it. A scroll moves every row by the SAME delta and *
 * changes nothing else about them (not a height, not an order, not a group), so the boxes are SHIFTED rather than re-measured: a rebuild is one       *
 * getBoundingClientRect() plus betweenGroupInfo's walk back to the heading for every row in the list, and it would run on every auto-scrolled frame,  *
 * on the device, in the one phase of the gesture where the frame budget is real. Answers whether anything actually moved, so a scroll that changed    *
 * nothing costs no repaint.                                                                                                                          *
 ***************************************************************************************************************************************************/
function syncRowIndex(){
    var scroller = touchDragScroller()
    if (!scroller || !touchDrag.index) return false
    var delta = scroller.scrollTop - touchDrag.indexTop
    if (!delta) return false
    touchDrag.indexTop = scroller.scrollTop
    for (var entry of touchDrag.index){ entry.top -= delta; entry.bottom -= delta }
    return true
}

/** resolveDragTarget *******************************************************************************************************************************
 * What the finger is over right now: a whole-row [data-drop] target, an insertion gap, or one of the five NAMED refusals. Never a silent no-op - the *
 * caller paints exactly one of the three outcomes, so the gesture always says what a release would do, and the trace always says why it would do     *
 * nothing.                                                                                                                                            *
 *                                                                                                                                                     *
 * THE GEOMETRY IS AUTHORITATIVE FOR ROWS, and the third Pixel round is why ("moving one note doesn't land between other notes, only on headings").    *
 * document.elementFromPoint is asked exactly two questions and no others: is there a [data-drop] under the finger, and is there an h2 under it. What  *
 * it returns for anything else - the drag banner, the trace strip, a menu, the body, the dragged row itself, a checkbox ring overhanging from the     *
 * next row - is not consulted at all and can VETO nothing: a gap is resolved from the row index by y, and a floating thing over the list has no say   *
 * in where the rows are. (The banner and the trace strip are pointer-events:none in panel.css besides, so they never even reach the first question.)  *
 *                                                                                                                                                     *
 * The five refusals, each of which used to read as the same bare `drag-target:none`:                                                                  *
 *   outside          the finger's y is outside the .todos client rect - above the list or below it, where no gap exists.                              *
 *   refused-heading  an h2 with no data-drop is under the finger. It is a SIBLING of the rows, so the index (which gives everything between one row's *
 *                    top and the next row's to the row above) would otherwise attribute the heading's whole band - and, while it is stuck to the top  *
 *                    of a scrolled list, the rows it floats over as well - to a row in the group BEFORE it, and write the drop there. The desktop     *
 *                    drag is inert on exactly this point (betweenTargetAt starts from a closest('.todo'), which a heading is not).                    *
 *   no-row           inside the list, but off either end of the index: the whitespace below the last row, or above the first.                          *
 *   no-info          the row under the finger takes no between-drop: the No-Due group, a week card, a month section, anything outside .todos.          *
 *   both-null        a gap in a DATELESS group with no non-dragged neighbour on either side. betweenBounds can form no interval from it (no neighbour *
 *                    to bound it, no group date to anchor it), so the host would write nothing and a line there would promise a move that never came. *
 ***************************************************************************************************************************************************/
function dragTargetNone(reason){
    return { kind: 'none', reason: reason }
}

function resolveDragTarget(){
    var under = document.elementFromPoint(touchDrag.x, touchDrag.y)
    var drop = (under && under.closest) ? under.closest('[data-drop]') : null
    if (drop) return { kind: 'drop', el: drop }
    if (under && under.closest && under.closest('h2')) return dragTargetNone('refused-heading')
    // Off the list entirely - which is the "release outside the list to cancel" the banner offers, and the one
    // refusal that is a deliberate user action rather than a place the gesture could not read.
    var scroller = touchDragScroller()
    if (scroller){
        var box = scroller.getBoundingClientRect()
        if (touchDrag.y < box.top || touchDrag.y >= box.bottom) return dragTargetNone('outside')
    }
    var entry = rowEntryAtY(touchDrag.y)
    if (!entry) return dragTargetNone('no-row')
    if (!entry.info) return dragTargetNone('no-info')
    var before = window.TouchDrag.bandSide(touchDrag.y - entry.top, entry.bottom - entry.top, TOUCH_DRAG_BAND) === 'before'
    if (entry.info.groupDate == null){
        var neighbours = betweenNeighboursAt(entry.el, before, new Set(touchDrag.ids))
        if (!neighbours.prevId && !neighbours.nextId) return dragTargetNone('both-null')
    }
    return { kind: 'between', row: entry.el, before: before, groupDate: entry.info.groupDate, groupEndDate: entry.info.groupEndDate }
}

// Whether two resolved targets are the same one, so the banner and the trace only speak when the answer CHANGES.
function sameDragTarget(a, b){
    if (!a || !b) return a === b
    if (a.kind !== b.kind) return false
    // Two refusals for different reasons are not the same answer: the strip has to see the finger move from
    // `outside` to `refused-heading` to `no-info`, which is the whole of what the next device round reads.
    if (a.kind === 'none') return a.reason === b.reason
    return a.kind === 'between' ? (a.row === b.row && a.before === b.before) : a.el === b.el
}

// Exactly one of the three paints, through the same painters the desktop drag uses.
function paintDragTarget(target){
    if (target && target.kind === 'between'){ paintDropTargetHighlight(null); paintBetweenIndicator(target); return }
    clearBetweenIndicator()
    paintDropTargetHighlight(target && target.kind === 'drop' ? target.el : null)
}

// The banner over the panel: what is moving, and what a release would do with it. It lives on <body> like the
// toast and the context menu, so it is created once and reused.
function showDragBanner(text, cancel){
    var banner = document.getElementById('cockpitDragBanner')
    if (!banner){ banner = document.createElement('div'); banner.id = 'cockpitDragBanner'; document.body.appendChild(banner) }
    banner.textContent = text
    banner.classList.toggle('-cancel', !!cancel)
}

function hideDragBanner(){
    var banner = document.getElementById('cockpitDragBanner')
    if (banner) banner.remove()
}

function dragBannerText(target){
    var moving = 'Moving ' + touchDrag.title
    if (!target || target.kind === 'none') return moving + ' — release to cancel'
    if (target.kind === 'drop') return moving + ' — onto ' + dropTargetLabel(target.el)
    return moving + ' — ' + (target.before ? 'before ' : 'after ') + rowLabel(target.row)
}

// Re-resolve, repaint, and - only when the answer changed - re-label the banner and trace it. A move fires at the
// touch's own rate, so tracing every one of them would push the rest of the gesture out of the ring buffer.
function updateDragTarget(){
    var target = resolveDragTarget()
    paintDragTarget(target)
    if (sameDragTarget(touchDrag.target, target)){ touchDrag.target = target; return }
    touchDrag.target = target
    showDragBanner(dragBannerText(target), target.kind === 'none')
    traceGesture('drag-target:' + (target.kind === 'none' ? 'none:' + target.reason
        : target.kind === 'drop' ? 'drop' : target.before ? 'before' : 'after'))
}

/** armTouchDrag ************************************************************************************************************************************
 * The ARM, at the 500ms fire, with the row's context menu already open and the finger still down. NOTHING here is visible and nothing is claimed: no *
 * lift, no dimming, no banner, no selection change, no payload and above all no refresh guard - a release from here has to leave the menu standing,  *
 * and a guard release would make the host repaint the panel out from under it. All this does is put the gesture in a position to read the finger's   *
 * next move: pointer capture on the row, the non-passive capturing touchmove listener, the row index, and the 15s watchdog that must outlive even a  *
 * gesture nothing ever ends.                                                                                                                         *
 *                                                                                                                                                    *
 * The index is measured NOW rather than at the lift because now is when the list is certainly still: the menu is position:fixed and moves no row, and *
 * any scroll between here and the lift shifts the index through the same listener the lifted drag uses.                                               *
 ***************************************************************************************************************************************************/
function armTouchDrag(){
    var row = longPress.el
    // Nothing can reach here with a gesture still running today - the adapter's pointerdown ends a stale one on
    // the press that begins alone, and the second-pointer listener ends one on a second finger, both before a
    // press could fire - but overwriting the state in place is the ONE way a taken guard could be lost without a release,
    // which is the leak this block's comment and the 15s watchdog exist to prevent. So the invariant is made
    // structural rather than argued: a live gesture is ended through the single end, first.
    if (touchDrag.active) endTouchDrag('re-arm')
    touchDrag.active = true
    touchDrag.lifted = false
    touchDrag.guarded = false
    touchDrag.pointerId = longPress.pointerId
    // The whole of what the press hands over is taken HERE, in one place - including the id, which the lift would
    // otherwise reach back for on a touchmove arriving long after the press object had moved on.
    touchDrag.id = longPress.id
    touchDrag.ids = []
    touchDrag.row = row
    touchDrag.title = ''
    touchDrag.target = null
    touchDrag.autoscroll = 0
    // THE FIRE POINT, not the press point: where the FINGER is at the 500ms, and therefore the only honest origin
    // for "has it moved since". The press point is up to 10px away (the adapter cancels beyond that), so arming
    // from it would leave the gesture one pixel from its own lift threshold. Note the menu itself is drawn at the
    // PRESS point - onLongPressFire synthesises its event from longPress.x/y - so "the fire point" is where the
    // finger is when the menu appears, not where the menu appears. It is the finger the threshold is about.
    touchDrag.startX = touchDrag.x = longPress.lastX
    touchDrag.startY = touchDrag.y = longPress.lastY
    // Non-passive, or the preventDefault() that stops the pan is ignored (see the block header). Capture, like every
    // other listener in the touch layer, so nothing on the way up can take the gesture away. It prevents every move
    // from HERE, armed included: the list must not pan under a held finger, or the menu the fire just opened is
    // dragged out from under it. The sideways rule is unaffected - that responder is native, not this document's.
    document.addEventListener('touchmove', onTouchDragMove, { passive: false, capture: true })
    // Pointer capture keeps this finger's events coming to us even if a re-render detaches the row under it.
    try { row.setPointerCapture(touchDrag.pointerId) } catch (error){}
    buildRowIndex()
    touchDrag.watchdog = setTimeout(function(){ endTouchDrag('watchdog') }, TOUCH_DRAG_WATCHDOG_MS)
    traceGesture('menu-open')
}

/** liftTouchDrag ***********************************************************************************************************************************
 * The LIFT, taken by the first travel past the slop that went UP or DOWN. This is the moment the gesture stops being the menu's and becomes the       *
 * drag's, and everything the armed state refused to do happens here, in one place:                                                                    *
 *   - the context menu the press opened is closed, with no side effects: on mobile showNoteContextMenu never gives it focus, so hideNoteContextMenu   *
 *     hands nothing back and simply removes the element (which also clears it out of elementFromPoint's way, since it sits under the finger).         *
 *   - the refresh guard is taken, for the drag proper only.                                                                                           *
 *   - the selection is settled EXACTLY as the desktop dragstart settles it, and the payload is read from it.                                          *
 *   - every lifted row dims, and the banner names what is moving.                                                                                     *
 *                                                                                                                                                     *
 * THE SELECTION IS NOT THIS GESTURE'S TO COLLAPSE, and the third Pixel round is why. The previous build cleared selectedRowIDs and put the pressed row *
 * in it on EVERY lift - and, since the lift fired on very nearly every hold (it was measured from the press point with the press's own slop), a hold   *
 * left a row painted `-selected` that the user had not selected and nothing took back: "long-hold selects one note, then taps on other notes select    *
 * them all too". The rule here is onTodoDragStart's, verbatim: a drag that starts on a row OUTSIDE the selection makes that row the selection, and a   *
 * drag that starts on a row INSIDE it sweeps the WHOLE set and changes nothing. That is what makes a touch drag and a mouse drag the same operation on *
 * the selection as well as on the host, and it is what lets a multi-selection - however one comes to be built on a phone - move as one. The payload is *
 * schedulableSelection() either way: the to-dos within the selection, in the selection's own order, notes silently dropped. The pressed row is itself  *
 * a to-do and is in the selection by the time this reads it, so it is never empty.                                                                     *
 ***************************************************************************************************************************************************/
function liftTouchDrag(){
    hideNoteContextMenu()
    touchDrag.lifted = true
    touchDrag.guarded = true
    void webviewApi.postMessage(['dialogGuard', true]);
    // Three statements, and they are onTodoDragStart's three: clear, add, paint. Not one more - the anchors a
    // CLICK maintains (lastClickedRowID, lastSelectionInteractionID) are a mouse's Shift-range state and no drag
    // of either kind writes them, so writing them here would make "verbatim" false in the one place the whole
    // selection contract is argued from.
    if (!selectedRowIDs.has(touchDrag.id)){
        selectedRowIDs.clear()
        selectedRowIDs.add(touchDrag.id)
        paintTodoSelection()
    }
    touchDrag.ids = schedulableSelection()
    // Every row that is actually moving dims, not only the one under the finger - the same loop the desktop
    // dragstart runs, so a multi-row touch drag looks like what it is.
    var dragged = new Set(touchDrag.ids)
    for (var draggedRow of allTodoRows()){
        if (dragged.has(draggedRow.dataset.todoId)) draggedRow.classList.add('-dragging')
    }
    // The row is never null here: canLiftRow required its data-todo-id before the arm, and the arm is the only
    // thing that puts a gesture in a state to reach this line. A multi-row drag names the COUNT instead of a
    // title - there is no one title to name, and the count is the thing the user needs confirmed.
    touchDrag.title = touchDrag.ids.length > 1 ? (touchDrag.ids.length + ' to-dos') : rowLabel(touchDrag.row)
    showDragBanner('Moving ' + touchDrag.title + ' — release outside the list to cancel', false)
    traceGesture('drag-lift n=' + touchDrag.ids.length)
}

function onTouchDragMove(event){
    if (!touchDrag.active) return
    // THE line the whole gesture rests on, and it is spoken from the ARM onwards rather than from the lift. The list
    // must not pan under a held finger: a pan moves every row out from under the menu the hold just opened, fires the
    // document scroll listener that used to close it, and reads to the user as "the row is moving already" before
    // anything has been lifted at all - the third Pixel round's F1 and F4, which are the same drift seen twice.
    // What this does NOT do is take Joplin's side-menu swipe away. That responder lives on the NATIVE side of the
    // WebView; preventDefault() here cancels this document's own default action (the pan) and nothing outside it, so
    // the sideways-first rule below keeps its meaning: a sideways stroke still ends the gesture and still reaches the
    // app. That is a claim about the platform, not about this file, and it is what step 18b of MOBILE.md checks.
    event.preventDefault()
    if (!event.touches || event.touches.length !== 1){ endTouchDrag('multi-touch'); return }
    touchDrag.x = event.touches[0].clientX
    touchDrag.y = event.touches[0].clientY
    if (!touchDrag.lifted){
        // THE ONE DECISION, and it is measured from the FIRE point with the LIFT threshold - not from the press
        // point with the press's own 10px slop, which is what made the previous build decide before the user had
        // decided anything. A hand tremor is not a move, and neither is the drift of a finger holding a phone:
        // under TOUCH_DRAG_LIFT_PX the gesture is still just the open menu, nothing is painted, nothing is closed
        // and the refresh guard is not taken. The first travel PAST it is read once and for good - up or down is
        // ours, sideways is Android's and we get out of its way without a trace of state.
        var decision = window.TouchDrag.liftDecision(touchDrag.x - touchDrag.startX, touchDrag.y - touchDrag.startY, TOUCH_DRAG_LIFT_PX)
        if (!decision) return
        if (decision === 'sideways'){ endTouchDrag('sideways'); return }
        // ...and if THIS move arrives non-cancelable, the panel never had the finger to claim: Chromium decided the
        // touch sequence's blocking region before this listener existed, so the preventDefault above is a silent
        // no-op for the whole gesture and the list will pan under the lifted row. The trace is the only thing that
        // can tell that apart from the list simply twitching (MOBILE.md, step 18b).
        if (!event.cancelable) traceGesture('drag-uncancelable')
        liftTouchDrag()
    }
    // The shared edge auto-scroll, fed the finger's own coordinates: inside a band at the top or bottom of the
    // list it scrolls, and re-resolves the target after every frame that moved (the rows travel, the finger does
    // not). Outside both bands the same call stops it.
    edgeAutoscrollUpdate(touchDragScroller(), touchDrag.x, touchDrag.y, onTouchDragScrolled)
    var direction = edgeAutoscrollRunning() ? (autoscrollStep < 0 ? -1 : 1) : 0
    if (direction !== touchDrag.autoscroll){
        touchDrag.autoscroll = direction
        if (direction) traceGesture('drag-autoscroll:' + (direction < 0 ? 'up' : 'down'))
    }
    updateDragTarget()
}

// After a scrolled frame the boxes are all in new places, so the index is shifted before the target is re-asked.
function onTouchDragScrolled(clientX, clientY){
    if (!touchDrag.lifted) return
    syncRowIndex()
    updateDragTarget()
    // ...and RE-AIM at the same point, which is what keeps the loop alive under a finger that is holding still -
    // the whole gesture an edge scroll exists for. The helper stops itself after AUTOSCROLL_IDLE_MS without an
    // update(), a watchdog sized for the HTML5 drag (which re-fires dragover every ~350ms even for a stationary
    // pointer) and explicitly noted there as the net for "a gesture that ended without an event reaching us". A
    // still FINGER sends no touchmove at all, so without this the list would stop after 800ms and only move again
    // if the user wiggled. Nothing is lost by it: a touch drag has real ends of its own, and every one of them
    // calls endTouchDrag, which stops the loop - with the 15s drag watchdog behind them all.
    edgeAutoscrollUpdate(touchDragScroller(), clientX, clientY, onTouchDragScrolled)
}

/** dropTouchDrag ***********************************************************************************************************************************
 * The release over a target: the same two messages the desktop drop posts, with the same payloads, resolved from the release point. The message goes *
 * FIRST and the guard release follows it (endTouchDrag), never the other way round: the host answers the guard coming down with a repaint of its own, *
 * so releasing first would reload the mobile webview once for the release and again for the write - a visible double flash around every drop.        *
 ***************************************************************************************************************************************************/
function dropTouchDrag(){
    var target = touchDrag.target
    var ids = touchDrag.ids
    // A resolved refusal is not a target; it carries its reason to the end, which traces it (see endTouchDrag).
    var landed = !!(target && target.kind !== 'none')
    if (landed && target.kind === 'between'){
        var neighbours = betweenNeighboursAt(target.row, target.before, new Set(ids))
        selectedRowIDs.clear()
        // WHAT is about to be written, not merely that something was: a drop that lands in the wrong gap and one
        // that lands in the right gap and is not written both read as "drag-drop" otherwise, and the device round
        // has nothing but this strip to tell them apart. The neighbour ids are cut to four characters ('-' for an
        // end of a group) because the whole trace is one line on a phone.
        traceGesture('drag-drop:between ' + traceId(neighbours.prevId) + '|' + traceId(neighbours.nextId))
        void webviewApi.postMessage(['todosDroppedBetween', ids, neighbours.prevId, neighbours.nextId, target.groupDate, target.groupEndDate]);
        traceGesture('drag-drop:posted')
    } else if (landed){
        selectedRowIDs.clear()
        // The date the [data-drop] carries, verbatim: a YYYY-MM-DD, or 'clear' for the No Due Date heading.
        traceGesture('drag-drop:date ' + (target.el.dataset.drop || '?'))
        void webviewApi.postMessage(['todosDropped', ids, target.el.dataset.drop]);
        traceGesture('drag-drop:posted')
    }
    endTouchDrag(landed ? 'dropped' : 'no-target')
}

/** endTouchDrag ************************************************************************************************************************************
 * THE ONE END, for every way a drag can finish: a drop, a cancel over nothing, a second finger, a pointercancel, the app going to the background, a  *
 * resize or rotation, and the watchdog. Everything the gesture put up comes down here - the touchmove listener, the scroll loop, both indicator      *
 * paints, the lifted row's dimming, the pointer capture, the banner and the watchdog itself - and the refresh guard is released LAST.                *
 *                                                                                                                                                    *
 * IT IS ALSO THE END OF AN ARMED-BUT-NEVER-LIFTED GESTURE - a release without travel, a sideways swipe, or any of the cancels arriving while the     *
 * menu is still the only thing on screen. Those paths took nothing, so this takes nothing down: what it must NOT do is touch the context menu, which  *
 * belongs to the press rather than to the drag and stays open until the user dismisses it (the lift closes it explicitly, in liftTouchDrag).           *
 *                                                                                                                                                     *
 * There is exactly one early return, before anything has been taken down, and no return between the teardown and the guard release: a leaked         *
 * ['dialogGuard', true] freezes every mobile refresh for the life of the webview, and the only defences past this point are a fresh load's           *
 * resetOverlayGuard and the watchdog above. `guarded` is what keeps the pair balanced - a gesture that never lifted never took the guard, so it must  *
 * not post a release either (an unmatched false would decrement someone else's guard).                                                                *
 ***************************************************************************************************************************************************/
function endTouchDrag(reason){
    if (!touchDrag.active) return
    // Read BEFORE the teardown clears them, and only on the one path that says them: WHICH of resolveDragTarget's
    // refusals was standing at the release, where the finger was, and how many rows the index held. Without the
    // reason every refusal reads as the same bare line, which is why the second strip could not say why a gap drop
    // did nothing on the phone while the same drop passed in the mobile-mode e2e (MOBILE.md, step 18b-bis).
    var noTargetNote = reason !== 'no-target' ? '' :
        (':' + ((touchDrag.target && touchDrag.target.kind === 'none') ? touchDrag.target.reason : 'unresolved')
         + ' y=' + Math.round(touchDrag.y) + ' rows=' + (touchDrag.index ? touchDrag.index.length : 0))
    touchDrag.active = false
    touchDrag.lifted = false
    if (touchDrag.watchdog){ clearTimeout(touchDrag.watchdog); touchDrag.watchdog = null }
    document.removeEventListener('touchmove', onTouchDragMove, { passive: false, capture: true })
    edgeAutoscrollStop()
    clearBetweenIndicator()
    paintDropTargetHighlight(null)
    // Every lifted row, not only the pressed one: a drag from inside a multi-selection dimmed the whole set, and
    // the desktop dragend undims exactly the same way (a row left dim would read as still in flight).
    for (var undim of allTodoRows()) undim.classList.remove('-dragging')
    if (touchDrag.row){
        try { touchDrag.row.releasePointerCapture(touchDrag.pointerId) } catch (error){}
    }
    hideDragBanner()
    touchDrag.row = null
    touchDrag.index = null
    touchDrag.target = null
    touchDrag.ids = []
    touchDrag.autoscroll = 0
    touchDrag.pointerId = null
    touchDrag.id = null
    touchDrag.title = ''
    // The two ends that are not cancels and not drops get their own codes: an armed gesture that simply let go
    // (the menu stays, and that IS the gesture), and one whose first move was sideways (Android's, not ours).
    if (reason === 'released') traceGesture('drag-released')
    else if (reason === 'sideways') traceGesture('drag-sideways-ignored')
    // ...and a third: a LIFTED drag released over nothing droppable. It used to read as `drag-cancel:no-target`,
    // among Android's cancels, which is the one reading it must not have - this end is the user's own doing (the
    // banner said "release to cancel" and they did), while every remaining `drag-cancel:` is the platform taking
    // the gesture away. Traced here rather than in dropTouchDrag so that every end still speaks exactly once.
    else if (reason === 'no-target') traceGesture('drag-release:no-target' + noTargetNote)
    else if (reason !== 'dropped') traceGesture('drag-cancel:' + reason)
    var guarded = touchDrag.guarded
    touchDrag.guarded = false
    if (guarded) void webviewApi.postMessage(['dialogGuard', false]);
}

/** The touch drag's own listeners **********************************************************************************************************************
 * Document-level capture, registered once, exactly like the long-press adapter they extend - and inert until a press has actually ARMED one (endTouchDrag *
 * and each handler return at once when no gesture is in flight), so on desktop, and for every touch that is not a held to-do row, none of this does       *
 * anything at all.                                                                                                                                        *
 ***************************************************************************************************************************************************/
// The release: a LIFTED drag drops, and one that only ever armed lets go of the arming and leaves the menu the
// press opened standing. Either way longPress.fired is still set, so the click the browser synthesises next is
// swallowed by the adapter's own click listener - which is what keeps the note from opening AND what keeps that
// click from reaching the menu now sitting under the finger (the swallower stopPropagation()s it at the document).
document.addEventListener('pointerup', function(event){
    if (!touchDrag.active || event.pointerId !== touchDrag.pointerId) return
    if (touchDrag.lifted){ dropTouchDrag(); return }
    endTouchDrag('released')
}, true)

document.addEventListener('pointercancel', function(event){
    if (touchDrag.active && event.pointerId === touchDrag.pointerId) endTouchDrag('pointercancel')
}, true)

// A SECOND finger while the gesture is armed or lifted: this is no longer one drag. The press the long-press
// adapter has just armed for that finger goes with it, or its own 500ms would open a menu (and arm a second drag)
// out of the cancelled gesture. A press that begins ALONE never reaches this: the adapter's own pointerdown ran
// first and ended the stale gesture it found, so `touchDrag.active` is already false and the guard below returns -
// which is what stops a re-press after a lost pointerup from having its own long press cancelled here.
document.addEventListener('pointerdown', function(event){
    if (!touchDrag.active || event.pointerId === touchDrag.pointerId) return
    cancelLongPress()
    endTouchDrag('second-pointer')
}, true)

// ANY scroll of the list under a live gesture, not only the drag's own auto-scroll (which re-syncs in its own
// callback, so this one finds nothing left to do). If Android pans the list out from under a gesture without
// taking the gesture away - the 18b failure mode, in the sub-case where no pointercancel follows - the boxes the
// index was measured from stop describing the screen, and a release would write neighbours from rows that have
// scrolled off. Re-syncing turns that silent wrong write into a correct one.
document.addEventListener('scroll', function(){
    if (!touchDrag.active) return
    // The index is kept honest even while the drag is only armed. An armed touchmove does now cancel this
    // document's own pan, so this should be unreachable before a lift - but "should" is the word Chromium answers
    // with a non-cancelable move (drag-uncancelable), and that is precisely when the list pans under an armed
    // gesture. Only a LIFTED drag has a target to re-resolve or anything to paint.
    if (syncRowIndex() && touchDrag.lifted) updateDragTarget()
}, true)

// The app going to the background, and a rotation or resize: the boxes the index was built from are gone or about
// to be, and no drag survives either. Unconditional calls - endTouchDrag returns at once when nothing is lifted.
document.addEventListener('visibilitychange', function(){ if (document.hidden) endTouchDrag('hidden') })
window.addEventListener('resize', function(){ endTouchDrag('resize') })
window.addEventListener('orientationchange', function(){ endTouchDrag('orientation') })

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
function closeAllDropdowns(options){
    // keepSuggestions spares the search suggestion list (and with it a multi-select in progress) while still
    // closing the profile / notebook / sort menus. Used for a click that lands INSIDE the search interaction -
    // see the capturing click listener below. Every other caller passes nothing and closes everything, exactly
    // as before.
    var keepSuggestions = !!(options && options.keepSuggestions)
    for (var menu of document.querySelectorAll('.dropdown-menu')){
        if (keepSuggestions && menu.id === 'searchSuggestions') continue
        menu.setAttribute('hidden', '')
    }
    // The search suggestion list carries the .dropdown-menu class too, so the loop above just hid it.
    // Drop its logical state as well, or it would stay "open" while invisible and a following Enter or
    // arrow key would act on the hidden menu instead of committing the search.
    if (!keepSuggestions) hideSearchSuggestions({ reason: 'menus-closed' })
}

function onDropdownToggle(event, menuID){
    event.stopPropagation()
    var menu = document.getElementById(menuID)
    if (!menu) return
    var wasHidden = menu.hasAttribute('hidden')
    closeAllDropdowns()
    hideNoteContextMenu()
    if (wasHidden){
        menu.removeAttribute('hidden')
        // The notebook menu carries an embedded filter box: start every open from a fresh, empty filter (all
        // rows shown), and on desktop focus it so typing filters at once. On mobile it is left unfocused so
        // opening the menu does not pop the soft keyboard. Menus without a filter box (profile, sort) are
        // unaffected - the querySelector simply finds nothing.
        var filterInput = menu.querySelector('.notebook-filter-input')
        if (filterInput){
            filterInput.value = ''
            filterNotebookMenu(menu)
            if (!IS_MOBILE) filterInput.focus()
        }
    }
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

// A click anywhere outside the panel's menus closes them. The search suggestion list is deliberately named
// alongside .dropdown here: it carries the .dropdown-menu class but lives in #searchRow, NOT inside a .dropdown,
// so without this it would count as "outside" and close on a click on one of its own rows. That never showed
// while every pick committed and closed the menu anyway, but a Ctrl+click marks a row and the menu must STAY
// open - and the click that follows the marking mousedown would otherwise shut it immediately.
//
// The SEARCH ROW is spared too, but only while the list is open: going back to the field to type more of the
// token is a move within the search interaction, not a dismissal of it, and it must keep a multi-select in
// progress - the same move Escape already makes when it hands the caret back with the list still open. The
// other menus still close, so clicking the field while the notebook menu is open behaves as before, and a
// click on a row or anywhere else in the panel still closes everything.
document.addEventListener('click', event => {
    var target = event.target
    if (!target || !target.closest){ closeAllDropdowns(); return }
    if (target.closest('.dropdown, #searchSuggestions')) return
    if (searchSuggestion && target.closest('#searchRow')){ closeAllDropdowns({ keepSuggestions: true }); return }
    closeAllDropdowns()
}, true)

// Escape closes an open custom dropdown (notebook / profile / sort all share this menu machinery). Scoped
// to "a dropdown is actually open" so it stays inert otherwise, and so it never fights the two other Escape
// handlers: the search-suggestion Escape is swallowed by the search field itself (it stopPropagation()s),
// and the mobile overlay Escape is swallowed in the capture phase before this bubble-phase listener runs.
// The suggestion list is a .dropdown-menu inside #searchRow (NOT inside a .dropdown), so the selector below
// excludes it and leaves it to its own handler. The notebook filter's own Escape (clear-then-close) runs
// first on the focused input and only lets the empty-box press reach here.
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    if (!document.querySelector('.dropdown > .dropdown-menu:not([hidden])')) return
    closeAllDropdowns()
})

/** Notebook filter (embedded in the notebook dropdown) ******************************************************************************************
 * The notebook menu can list many notebooks, so a filter box is pinned at its top. Typing filters the notebook rows live by a case-insensitive  *
 * substring of the full path ("fam" matches "Family / Payments"); "All notebooks" always stays visible (it carries no data-notebook-row marker). *
 * Enter selects the first still-visible notebook - the same action as clicking its row. Escape clears the text on the first press and, once the   *
 * box is empty, lets the shared dropdown-Escape handler above close the menu. The box is reset (and, on desktop, focused) each time the menu       *
 * opens, so its state never outlives one open; desktop dropdowns are rebuilt on every render anyway, so there is nothing to persist.              *
 ***************************************************************************************************************************************************/
function notebookMenuOf(el){
    return el && el.closest ? el.closest('.dropdown-menu') : null
}

/** applyMenuFilter *********************************************************************************************************************************
 * Shows or hides each of `rows` by whether its .dropdown-label matches `text`, the shared narrowing behind BOTH embedded filter boxes - the notebook  *
 * menu's and the search suggestion list's. The match rule itself lives in the pure window.SearchTokens.matchesFilter, so it is covered by tests. A     *
 * hidden row needs the explicit attribute because .dropdown-item sets display:flex, which overrides the UA [hidden] rule (see panel.css).              *
 ***************************************************************************************************************************************************/
function applyMenuFilter(rows, text){
    for (var i = 0; i < rows.length; i++){
        var label = rows[i].querySelector('.dropdown-label')
        if (window.SearchTokens.matchesFilter(label ? label.textContent : '', text)) rows[i].removeAttribute('hidden')
        else rows[i].setAttribute('hidden', '')
    }
}

function filterNotebookMenu(menu){
    if (!menu) return
    var input = menu.querySelector('.notebook-filter-input')
    applyMenuFilter(menu.querySelectorAll('[data-notebook-row]'), input ? input.value : '')
}

function onNotebookFilterInput(event){
    filterNotebookMenu(notebookMenuOf(event.target))
}

function selectFirstVisibleNotebook(menu){
    if (!menu) return
    // The first NOTEBOOK row still visible after filtering ("All notebooks" is not a data-notebook-row, so
    // Enter never lands on it). Clicking it runs the row's own onclick - the same action as a real click.
    var firstRow = menu.querySelector('[data-notebook-row]:not([hidden])')
    if (firstRow) firstRow.click()
}

function onNotebookFilterKeyDown(event){
    var input = event.currentTarget
    if (event.key === 'Escape'){
        // First Escape with text clears the filter (the menu stays open); swallow it so the shared dropdown
        // Escape handler above does not also close the menu. A second Escape (the box now empty) is NOT
        // swallowed, so it falls through to that handler, which closes the open dropdown.
        if (input.value){
            event.preventDefault()
            event.stopPropagation()
            input.value = ''
            filterNotebookMenu(notebookMenuOf(input))
        }
        return
    }
    if (event.key === 'Enter'){
        event.preventDefault()
        selectFirstVisibleNotebook(notebookMenuOf(input))
    }
}

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
async function onSearchFilterChanged(searchString, opts){
    savedTodosScrollTop = 0
    // An explicit commit (Enter, a pick, an apply) supersedes any commit still held pending by
    // onSearchFieldChanged, so the two can never both fire.
    pendingSearchCommit = null
    // What this webview has now asked the host to hold. A deferred change/search commit for the SAME string is
    // the no-op case and is dropped at source rather than left for the host's equality guard (see
    // onSearchFieldChanged): pressing the field's × posts both, because the × fires `input` (which the
    // empty-field auto-reset commits on) AND `search`.
    lastCommittedSearch = String(searchString == null ? '' : searchString)
    // The search is now committed, so any uncommitted draft and the open suggestion list are done. The
    // outgoing-field snapshot goes with them: it exists to carry text typed AFTER the last commit across a
    // render, so a snapshot taken BEFORE this commit would repaint the field back to a superseded value.
    searchDraft = null
    lastSearchFieldSnapshot = null
    // The host-held copy (mobile) is about the uncommitted draft, which no longer exists.
    clearHostSearchState()
    hideSearchSuggestions({ reason: 'commit' })
    // message[2] asks the host to render even while the mobile search-focus hold is armed, and it is the
    // DEFAULT because every caller of this function is an explicit user commit: a picked suggestion, an applied
    // multi-select, Enter in the field or in the list's filter box, the clear button, the empty-field reset.
    //
    // The hold exists to stop a setHtml wiping the field while the user is TYPING - on mobile a render is a
    // full webview reload. It was never meant to hide results the user has just asked for, but that is what it
    // did: these paths deliberately keep the field focused (so the soft keyboard stays up), so the commit
    // landed host-side and the render was swallowed - the panel simply never filtered. The keyboard closing
    // with the reload is the accepted trade, the same one the empty-field reset already makes: the user has
    // finished searching. Typing itself never reaches here (it only updates the draft), so the hold still
    // protects exactly what it was built for.
    //
    // A future caller that is NOT an explicit commit must opt out with { renderNow: false }.
    var renderNow = !(opts && opts.renderNow === false)
    await webviewApi.postMessage(['searchFilterChanged', searchString, renderNow]);
}

/** maybeAutoResetSearch ***************************************************************************************************************************
 * Emptying the search field returns the panel to the unfiltered "all" view by itself, however the field was emptied - backspace, a cut, or the       *
 * clear button. Without this the panel stayed filtered until the user pressed Enter on an empty field: non-obvious on desktop, and unreachable on    *
 * mobile, where the soft keyboard has no Enter that commits here and Android's WebView does not even render the × (so backspace is the ONLY way to   *
 * clear a query, and it did nothing).                                                                                                                *
 *                                                                                                                                                    *
 * WHAT "still filtered" MEANS, with no new state to keep in sync: input.defaultValue is the server-rendered value ATTRIBUTE, i.e. the filter the host *
 * last committed. Editing the field changes .value and never touches it, so a non-empty defaultValue with an empty .value is exactly "the panel is    *
 * filtered by something the field no longer contains".                                                                                                *
 *                                                                                                                                                    *
 * This is an EXPLICIT programmatic commit on an observed empty value, not another change/search-event dependency - those are precisely what cannot be *
 * relied on here (`input` is the only event a backspace fires). It routes through onSearchFilterChanged, which clears any commit still held pending   *
 * by onSearchFieldChanged, so a later blur cannot commit the same reset a second time.                                                                *
 ***************************************************************************************************************************************************/
// Set once a reset has been posted, so a burst of input events cannot post it again while the render is still
// in flight. Cleared the moment the field has content again (and, on mobile, by the reload itself).
var searchResetPosted = false

function maybeAutoResetSearch(input){
    if (input.value.trim()){ searchResetPosted = false; return false }
    if (searchResetPosted) return false
    if (!String(input.defaultValue || '').trim()) return false      // nothing committed, so nothing to reset
    searchResetPosted = true
    // renderNow: on mobile the host holds every refresh while this field has focus, so without it the reset
    // would produce no visible change until the user happened to blur - which is the whole bug on that platform.
    onSearchFilterChanged('', { renderNow: true })
    return true
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
// The MARKED values of a multi-select in progress: { kind, values: [insert, ...] }, or null when nothing is
// marked. Held by VALUE rather than by row index precisely so the marks survive the dropdown's embedded filter
// being typed, cleared and retyped (and the list being rebuilt as the token fragment changes). The kind rides
// along so marks are dropped the moment the token being completed becomes a different kind.
var searchMarks = null
// The long press that marks a row on touch, and the movement slop that tells a press from a scroll. Same
// numbers as the list's own long-press adapter, so the two gestures feel identical.
var SUGGEST_LONG_PRESS_MS = 500
var SUGGEST_MOVE_SLOP = 10
// The dropdown's embedded filter box, mirrored into module state as it is typed. The box lives in the markup
// the host REPLACES on every render, so by the time reconcile runs its node is already gone and cannot be read:
// holding the text here is what lets a background render put it back (see reopenSearchSuggestions). Same reason
// the marks are held here rather than read off the rows.
var suggestFilterText = ''
var suggestFilterCaret = 0
// Where the caret sat inside the search REGION when a render landed: 'field', 'filter' (the dropdown's embedded
// filter box) or 'apply' (its apply button). Without it every restore hands the caret back to the field, which
// yanks the user out of the box they were narrowing the list with.
var searchFocusTarget = 'field'
// The filter text / caret / focus a restore must apply to the NEXT suggestion list this webview builds. Consumed
// exactly once by renderSearchSuggestions, which is what makes it work for `title:` too: that list is not built
// synchronously but arrives a debounced round-trip later.
var pendingSuggestRestore = null
// The search string this webview most recently asked the host to commit, so a deferred change/search commit for
// the same string can be recognised as a duplicate and dropped (see onSearchFieldChanged).
var lastCommittedSearch = null
// The last value/caret read off the OUTGOING search field, taken on its blur - which is the last instant a field
// the render is about to replace can still be read. It is the fallback restoreSearchDraft uses when no draft
// survives, and it exists for exactly one case: text typed AFTER a commit (which nulls the draft) but before the
// commit's render lands. Cleared by every commit and by a genuine departure, so it can never resurrect
// superseded text.
var lastSearchFieldSnapshot = null

function getSearchInput(){
    return document.getElementById('searchFilter')
}

function readSearchData(){
    var node = document.getElementById('cockpitSearchData')
    if (!node) return { tags: [], notebooks: [] }
    try {
        var data = JSON.parse(node.textContent || '{}')
        return { tags: data.tags || [], notebooks: data.notebooks || [], gestureTrace: !!data.gestureTrace }
    } catch (error) {
        return { tags: [], notebooks: [], gestureTrace: false }
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

// How many candidates a dropdown may hold. The menu shows ~15 rows and scrolls the rest (see panel.css), so the
// cap is about how much is reachable by scrolling rather than about how much is visible. It is deliberately far
// above the old 8: with multi-select the user marks several rows across a long list, and a cap that hid the rest
// would make that impossible. The list is rebuilt on every keystroke, so the build loop is kept cheap - two
// elements per row and ONE delegated listener for the whole list, never a listener or a layout read per row.
var SUGGEST_MAX_ITEMS = 200

function suggestionsFor(token, data){
    var partial = token.partial.toLowerCase()
    if (token.kind === 'tag'){
        return data.tags
            .filter(title => String(title).toLowerCase().indexOf(partial) >= 0)
            .slice(0, SUGGEST_MAX_ITEMS)
            .map(title => ({ insert: String(title), label: String(title) }))
    }
    return data.notebooks
        .filter(notebook => (String(notebook.path).toLowerCase().indexOf(partial) >= 0) || (String(notebook.title).toLowerCase().indexOf(partial) >= 0))
        .slice(0, SUGGEST_MAX_ITEMS)
        .map(notebook => ({ insert: String(notebook.title), label: String(notebook.path) }))
}

// The title: autocomplete cannot use the embedded tag/notebook data - titles are too many to ship on
// every render - so it round-trips to the plugin. Each keystroke is debounced, and a sequence counter
// makes sure only the newest request's response is rendered (async replies can arrive out of order).
var titleSuggestSeq = 0
var titleSuggestTimer = null

function onSearchInput(input){
    updateSearchDraft(input)
    // An emptied field resets the panel to "all" on its own. Checked before the token parsing below because an
    // empty field has no token at all, so that path would simply close the list and return.
    if (maybeAutoResetSearch(input)) return
    var token = tokenAtCaret(input.value, input.selectionStart)
    if (!token){ hideSearchSuggestions({ reason: 'no-token' }); return }
    // Marks belong to the token KIND being completed: they survive the user narrowing a tag: list keystroke by
    // keystroke (the list is rebuilt, the marks are by value), and are dropped the moment the token becomes a
    // different kind - a tag: mark has no meaning in a notebook: list. No token at all clears them above.
    if (searchMarks && searchMarks.kind !== token.kind) searchMarks = null
    if (token.kind === 'title'){ requestTitleSuggestions(input, token); return }
    var items = suggestionsFor(token, readSearchData())
    // Typing one character past the last match empties the list. That is not the end of the multi-select: the
    // user is still completing the same token and a backspace brings the rows straight back, so the marks are
    // kept across the empty state rather than silently thrown away (they would be unrecoverable - the marked
    // values are no longer on screen to re-mark).
    if (!items.length){ hideSearchSuggestions({ keepMarks: true, reason: 'no-matches' }); return }
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
        // Same as the tag:/notebook: path above: an empty answer while the caret is still on the same title:
        // token is a state the user can back out of, so the marks are kept for the backspace.
        if (!titles || !titles.length){ hideSearchSuggestions({ keepMarks: true }); return }
        var items = titles.slice(0, SUGGEST_MAX_ITEMS).map(title => ({ insert: String(title), label: String(title) }))
        searchSuggestion = { token: current, items: items, activeIndex: 0 }
        renderSearchSuggestions(liveInput)
    }, 200)
}

/** renderSearchSuggestions ************************************************************************************************************************
 * Draws the suggestion list under the search row: a sticky filter box (with the apply button at its right) on top, the scrolling rows in the middle,  *
 * and a muted hint line pinned at the bottom. Row labels are set with textContent, so a tag, notebook or note title is never interpreted as markup.   *
 *                                                                                                                                                     *
 * The list is rebuilt on EVERY keystroke in the search field, so the loop is kept cheap: two elements and one    *
 * dataset write per row, no per-row listener (both platforms delegate from the list container) and no layout read *
 * of any kind. See SUGGEST_MAX_ITEMS.                                                                             *
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
    // A list can open between renders (every keystroke builds one), so pick the setting up here as well.
    refreshGestureTraceFlag()
    menu.appendChild(buildSuggestFilterRow(input))

    var list = document.createElement('div')
    list.className = 'suggest-list'
    searchSuggestion.items.forEach((suggestion, index) => {
        var item = document.createElement('div')
        item.className = 'dropdown-item' + (index === searchSuggestion.activeIndex ? ' -current' : '')
        // The value the row inserts, so the delegated handlers below (and the mark painter) can identify a row
        // without carrying an index that filtering would invalidate.
        item.dataset.suggestValue = suggestion.insert
        var label = document.createElement('span')
        label.className = 'dropdown-label'
        label.textContent = suggestion.label
        item.appendChild(label)
        list.appendChild(item)
    })
    wireSuggestList(list, input)
    menu.appendChild(list)

    var hint = document.createElement('div')
    hint.className = 'suggest-hint'
    hint.textContent = window.SearchTokens.hintText(IS_MOBILE)
    menu.appendChild(hint)

    row.appendChild(menu)
    paintSearchMarks()
    applyPendingSuggestRestore(menu, input)
}

/** applyPendingSuggestRestore *********************************************************************************************************************
 * Puts back the parts of an interrupted multi-select that are NOT the marks: the embedded filter box's text and *
 * caret, and which control inside the search region held the focus. Consumed once, by whichever list is built    *
 * next - synchronously for tag:/notebook:, and a debounced round-trip later for title:, which is exactly why     *
 * this is a pending descriptor rather than a call inside reopenSearchSuggestions.                                 *
 *                                                                                                                *
 * Focus moves within the region are not departures: onSearchBlur returns early on a relatedTarget that is still  *
 * inside it, so handing the caret from the freshly-restored field to the box tears nothing down.                  *
 ***************************************************************************************************************************************************/
function applyPendingSuggestRestore(menu, input){
    var restore = pendingSuggestRestore
    pendingSuggestRestore = null
    if (!restore || !menu) return
    var box = menu.querySelector('.suggest-filter-input')
    if (box && restore.filter){
        box.value = restore.filter
        // Narrows the rows AND re-records the mirrored filter state, so a second render carries it too.
        applySuggestFilter(menu)
    }
    if (restore.focus === 'filter' && box){
        box.focus()
        var caret = Math.min(Number(restore.caret) || 0, box.value.length)
        box.setSelectionRange(caret, caret)
        return
    }
    if (restore.focus === 'apply'){
        var apply = menu.querySelector('.suggest-apply')
        // Only when it is actually shown: the marks may have been dropped by the token changing kind, in which
        // case there is no apply button to focus and the field keeps the caret restoreSearchDraft gave it.
        if (apply && !apply.hasAttribute('hidden')){ apply.focus(); return }
    }
    if (input && document.activeElement !== input) input.focus()
}

/** buildSuggestFilterRow **************************************************************************************************************************
 * The box pinned at the top of the open list, narrowing the rows by a case-insensitive substring of their label - the same affordance the notebook   *
 * menu has carried since 1.9.4, for the same reason (the list can be long). Beside it sits the apply button, which inserts every MARKED row at once   *
 * and is shown only while at least one mark exists, so on both platforms it doubles as the multi-select-mode indicator.                               *
 *                                                                                                                                                     *
 * The box is deliberately NOT focused when the list opens: unlike the notebook menu (opened by pressing a button) this list opens while the user is    *
 * typing in the search field, and stealing the caret out of it mid-word would be wrong.                                                               *
 ***************************************************************************************************************************************************/
function buildSuggestFilterRow(input){
    var kind = searchSuggestion.token.kind
    var wrap = document.createElement('div')
    wrap.className = 'suggest-filter'

    var box = document.createElement('input')
    box.type = 'text'
    box.className = 'suggest-filter-input'
    box.placeholder = window.SearchTokens.filterPlaceholder(kind)
    box.setAttribute('aria-label', window.SearchTokens.filterPlaceholder(kind))
    box.setAttribute('autocomplete', 'off')
    box.setAttribute('autocorrect', 'off')
    box.setAttribute('autocapitalize', 'off')
    box.setAttribute('spellcheck', 'false')
    box.addEventListener('input', function(){ applySuggestFilter(document.getElementById('searchSuggestions')) })
    box.addEventListener('keydown', function(event){ handleSuggestKey(event, input) })
    // Which control inside the region holds the caret, so a render that lands mid-narrowing hands it back here
    // rather than to the field (see applyPendingSuggestRestore).
    box.addEventListener('focus', function(){ searchFocusTarget = 'filter' })
    // The box is inside the search field's focus region, so leaving it for anything outside that region ends the
    // search interaction exactly as leaving the field itself does.
    box.addEventListener('blur', onSearchBlur)

    var apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'suggest-apply'
    apply.title = 'Insert the marked entries'
    apply.setAttribute('aria-label', 'Insert the marked entries')
    apply.innerHTML = window.SearchTokens.APPLY_ICON
    apply.setAttribute('hidden', '')
    apply.addEventListener('click', function(){ applyMarkedSuggestions(getSearchInput()) })
    apply.addEventListener('focus', function(){ searchFocusTarget = 'apply' })
    apply.addEventListener('blur', onSearchBlur)

    wrap.appendChild(box)
    wrap.appendChild(apply)
    return wrap
}

/** wireSuggestList ********************************************************************************************************************************
 * ONE set of listeners for the whole list, delegating to whichever row an event landed on. Desktop keeps picking on mousedown (so the pick beats the  *
 * field's blur), with Ctrl/Cmd+press toggling a mark instead and leaving the list open. Touch cannot use a modifier, so it marks with a long press -   *
 * the standard Android pattern - and once anything is marked a plain tap toggles rather than picks; see onSuggestPointerDown for why the touch pick    *
 * had to move from pointerdown to pointerup.                                                                                                          *
 ***************************************************************************************************************************************************/
function wireSuggestList(list, input){
    // Mobile needs nothing here: its press tracking lives in the document-level CAPTURE listeners below,
    // exactly like the to-do rows' long-press adapter. Capture on the document is what makes the gesture
    // immune to anything that might stop propagation on the way up, and it survives the list being rebuilt
    // on every keystroke without re-attaching a thing.
    if (IS_MOBILE) return
    list.addEventListener('mousedown', function(event){
        var item = event.target.closest ? event.target.closest('.dropdown-item') : null
        if (!item) return
        // mousedown, not click, so the pick happens before the field's blur can commit or the menu can be torn
        // down. preventDefault keeps the caret in the search field.
        event.preventDefault()
        var value = item.dataset.suggestValue
        // Ctrl/Cmd+press toggles a mark and leaves the list open; a plain press is the unchanged single pick,
        // whether or not anything is marked.
        if (event.ctrlKey || event.metaKey){ toggleSearchMark(value); return }
        applySearchSuggestion(input, suggestionByValue(value))
    })
}

/** Gesture trace (mobile diagnostic, off by default) **********************************************************************************************
 * Two device rounds have been spent guessing at why a long press on a suggestion row behaves differently on the Pixel than everything here predicts.  *
 * This records the gesture-relevant events as they happen and shows them, newest last, so the next device session can report what actually fired      *
 * instead of what it looked like.                                                                                                                      *
 *                                                                                                                                                      *
 * TWO SINKS, because the trace outgrew its first one. The suggestion list's hint line is still used whenever that list is open - it is right under the *
 * rows being traced - but the ROW gestures (the long press, and the touch drag it lifts a row into) happen with no list on screen at all, so a trace    *
 * written only there was blind to exactly the gesture the next device round has to report on. When there is no hint line the codes go to the toast     *
 * instead, in its STICKY mode: it stays up for the whole gesture rather than fading after three seconds, and the next ordinary toast simply replaces    *
 * it. Nothing is created at all while the setting is off, so "off" really is no strip.                                                                 *
 *                                                                                                                                                      *
 * Off unless the "Gesture trace" setting is on, mobile only, and capped at a handful of entries: a ring buffer of short codes and one textContent write *
 * per traced event, so it costs nothing when off and next to nothing when on. The cap is what decides how much of a gesture is still readable at the    *
 * end of it - a drag arms, changes target a few times, scrolls and drops, and now names WHY each refusal was one - so 12 rather than the 10 the         *
 * press-only trace needed.                                                                                                                              *
 ***************************************************************************************************************************************************/
var GESTURE_TRACE_MAX = 12
var gestureTrace = []
// The setting, read ONCE per render rather than per traced pointer event: tracing sits on the gesture path,
// and JSON-parsing the data island on every pointermove would make "costs nothing when off" untrue.
var gestureTraceOn = false

function refreshGestureTraceFlag(){
    gestureTraceOn = IS_MOBILE && !!readSearchData().gestureTrace
}

function gestureTraceEnabled(){
    return gestureTraceOn
}

function traceGesture(code){
    if (!gestureTraceEnabled()) return
    gestureTrace.push(code)
    if (gestureTrace.length > GESTURE_TRACE_MAX) gestureTrace.shift()
    var text = gestureTrace.join(' > ')
    var hint = document.querySelector('#searchSuggestions .suggest-hint')
    if (hint){ hint.textContent = text; return }
    showToast(text, true)                  // no list on screen (every row gesture): the sticky strip instead
}

/** Touch press tracking (mobile) ******************************************************************************************************************
 * A press that stays put for 500ms marks the row it began on and enters selection mode; a shorter press picks it (or, once anything is marked,        *
 * toggles it). Movement beyond the slop, a pointer cancel or a scroll of the list abandons the press entirely, so scrolling a long list neither marks  *
 * nor picks anything.                                                                                                                                 *
 ***************************************************************************************************************************************************/
var suggestPress = { timer: null, x: 0, y: 0, value: null, fired: false, moved: false, clickArmed: false }

function cancelSuggestPress(){
    if (suggestPress.timer){ clearTimeout(suggestPress.timer); suggestPress.timer = null; traceGesture('press-cancelled') }
    suggestPress.moved = true
}

function onSuggestPointerDown(event){
    if (!IS_MOBILE) return
    if (event.pointerType === 'mouse') return
    if (!event.target || !event.target.closest) return
    // Scoped to a ROW of the open suggestion list; a press on its filter box or apply button is not a mark.
    var item = event.target.closest('#searchSuggestions .dropdown-item')
    if (!item) return
    // preventDefault here cancels the DEFAULT ACTIONS of the press - the focus change and the native text
    // selection / callout that Android would otherwise start - at source, so the search field never blurs and
    // there is nothing to restore. It does NOT stop the list scrolling: panning is governed by touch-action
    // (pan-y, see panel.css) and by touchstart/touchmove, not by cancelling pointerdown. An earlier round
    // assumed otherwise and left the default in place, which is what let the native long press win.
    //
    // What must NOT happen here is committing the pick: a long press begins with this same pointerdown, so a
    // commit here would close the list before the hold could ever fire. The pick waits for pointerup.
    event.preventDefault()
    suggestPress.timer = setTimeout(function(){
        suggestPress.timer = null
        suggestPress.fired = true
        traceGesture('hold-fired')
        if (navigator.vibrate){ try { navigator.vibrate(10) } catch (error){} }
        toggleSearchMark(suggestPress.value)
    }, SUGGEST_LONG_PRESS_MS)
    suggestPress.x = event.clientX
    suggestPress.y = event.clientY
    suggestPress.value = item.dataset.suggestValue
    suggestPress.fired = false
    suggestPress.moved = false
    // Every press that began on a row owns the click the browser will synthesise for it. A pending release
    // from the previous gesture is dropped, so the new press keeps its own arm.
    if (suggestClickArmTimer){ clearTimeout(suggestClickArmTimer); suggestClickArmTimer = null }
    suggestPress.clickArmed = true
    traceGesture('down')
}

function onSuggestPointerMove(event){
    if (!suggestPress.timer) return
    if (Math.abs(event.clientX - suggestPress.x) > SUGGEST_MOVE_SLOP || Math.abs(event.clientY - suggestPress.y) > SUGGEST_MOVE_SLOP) cancelSuggestPress()
}

function onSuggestPointerUp(event){
    if (!IS_MOBILE) return
    if (event.pointerType === 'mouse') return
    traceGesture('up')
    var held = suggestPress.fired
    var moved = suggestPress.moved
    var pressed = suggestPress.value
    cancelSuggestPress()
    suggestPress.fired = false
    suggestPress.value = null
    if (held || moved || pressed == null) return                    // the hold already marked it, or this was a scroll
    var item = event.target && event.target.closest ? event.target.closest('#searchSuggestions .dropdown-item') : null
    if (!item || item.dataset.suggestValue !== pressed) return      // the finger ended on a different row
    // In selection mode (something is marked) a tap toggles; otherwise it is the ordinary single pick.
    if (markedSearchValues().length) toggleSearchMark(pressed)
    else applySearchSuggestion(getSearchInput(), suggestionByValue(pressed))
}

/** The suggestion-row press listeners ***************************************************************************************************************
 * Registered ONCE on the document in the CAPTURE phase, mirroring the to-do rows' long-press adapter above rather than hanging off the list element:  *
 * capture means nothing can stop the gesture on its way up, and a single registration survives the list being rebuilt on every keystroke. All four    *
 * are inert on desktop and for a mouse pointer, and only act on a press that began on a row of the open list.                                          *
 ***************************************************************************************************************************************************/
document.addEventListener('pointerdown', onSuggestPointerDown, true)
document.addEventListener('pointermove', onSuggestPointerMove, true)
document.addEventListener('pointerup', onSuggestPointerUp, true)
document.addEventListener('pointercancel', cancelSuggestPress, true)
// A scroll of the list is not a press on a row - the same signal, and the same capture phase, the to-do
// adapter uses so it catches the inner scroll container too.
document.addEventListener('scroll', cancelSuggestPress, true)

// The arm is released a tick after the gesture ENDS, mirroring releaseSuggestPointerInside. Clearing it only
// when the swallower consumes a click was a leak: a press cancelled by a scroll produces no synthetic click at
// all, so the arm survived and the NEXT click anywhere - this listener is on the document - was eaten instead
// (measured: long-press to mark, scroll, then tap Apply and nothing happens until a second tap). Releasing on
// a tick rather than immediately still covers the click of a cancelled press that does land, and then disarms.
var suggestClickArmTimer = null

function releaseSuggestClickArm(){
    if (!suggestPress.clickArmed || suggestClickArmTimer) return
    suggestClickArmTimer = setTimeout(function(){
        suggestClickArmTimer = null
        suggestPress.clickArmed = false
    }, 0)
}

document.addEventListener('pointerup', releaseSuggestClickArm, true)
document.addEventListener('pointercancel', releaseSuggestClickArm, true)

// The browser synthesises a click right after a touch gesture. The to-do long-press adapter swallows that
// click; this list did not, and that is a concrete difference between the working gesture and the broken one:
// the click lands wherever the gesture ended - which after a cancelled or re-targeted press need not be a row -
// and a click outside the list runs closeAllDropdowns, taking the list down while leaving the typed text
// behind. Exactly the reported "the window closes and bare tag: remains". Capture phase, so it runs before the
// dismissal listeners it is protecting the list from.
document.addEventListener('click', function(event){
    if (!IS_MOBILE || !suggestPress.clickArmed) return
    // One click per gesture, consumed either way, so the arm cannot outlive the press that set it.
    suggestPress.clickArmed = false
    // Only a click that landed OUTSIDE the list can do harm: that is the one which reaches
    // closeAllDropdowns and takes the list down. A click INSIDE the list is already safe (the dismissal
    // listener excludes it) and is very often a control the user meant to press - the Apply button, the
    // filter box, another row - so swallowing it is pure damage. Scoping the swallow this way makes it
    // deterministic: it no longer depends on whether the arm's release wins a race with the synthetic click.
    if (event.target && event.target.closest && event.target.closest('#searchSuggestions')) return
    traceGesture('click-swallowed')
    event.preventDefault()
    event.stopPropagation()
}, true)

// Android's native long press fires a REAL `contextmenu` on whatever is under the finger, and on mobile the panel
// refuses every one of them - rows, headings, the list, the body alike - because two different things ride on it
// and both are damage:
//   - the system callout / selection bar over the list (the CSS suppression, -webkit-touch-callout / user-select
//     in panel.css, is the first defence; this is the belt to its braces), and
//   - the panel's OWN context menu, opened behind the long-press adapter's back: every to-do row carries an inline
//     oncontextmenu="onTodoContextMenu(event, id)", every note row an onNoteContextMenu (src/core/formats.ts, the
//     list rows and the week cards) and every group heading an onHeadingContextMenu (src/core/html.ts) - four
//     inline handlers in all, so Android's long press reached showNoteContextMenu without the adapter
//     ever knowing. That is the second Pixel round's bug. Its TIMING is the device's, not ours - the "Touch & hold
//     delay" accessibility setting plus Chrome's own ~500ms - so the native event can land BEFORE the adapter's
//     fire (a second menu over the first) or AFTER the lift has closed the menu (a menu re-opening over a lifted
//     row, which then swallows the release that should have reached a gap: "the menu doesn't close, and the row is
//     not moved"). Neither showed in the gesture trace, because a row's inline handler is not on any traced path.
// stopImmediatePropagation as well as preventDefault, because preventDefault alone cancels only the NATIVE menu:
// the inline handlers are listeners like any other and would still run. Stopping the event dead in the capture
// phase, at the document, is what makes the long-press adapter the ONLY way a touch opens a context menu.
// Desktop returns on the first line, so a right click there - in the list, on a row, anywhere - is untouched.
// ONE exemption, and it is deliberately not a zone of the panel's but a kind of element: a field TEXT is typed
// into - the search box (#searchFilter), the notebook filter, the alarm overlay's date and time. Android raises
// the text-selection handles and the Paste / Select-all bar through this very event, and in a field on a phone
// that bar is the only way to paste; cancelling it there would be a regression with nothing to gain, since none
// of those fields carries an inline oncontextmenu, none is a drag source and none is a zone the long-press
// adapter recognises. Everything else - rows, headings, the suggestion list, the body - is refused.
// Two teeth in the exemption's selector, and each one is load-bearing rather than defensive:
//   - a checkbox and a radio are <input> elements that take NO text, so the Paste bar is not what a long press on
//     one raises. One of them is the tick circle of every to-do row (input.todo-checkbox, formats.ts) - the FIRST
//     CHILD of the very element that carries oncontextmenu, grown to a 40px tap target on mobile (panel.css), and
//     itself a zone the adapter recognises: onTodoContextMenu's first branch is the circle, and it opens the
//     alarm overlay. Exempting it would have handed Android's long press a second, unguarded route into
//     openAlarmOverlay (which has no re-entry guard: a second call rebuilds the overlay and discards a date or
//     time already typed) on the one zone of a row the belt in showNoteContextMenu does not cover, at a moment
//     the device's "Touch & hold delay" picks. That is this round's bug, narrowed to one circle.
//   - and no exemption may reach INSIDE an element that carries an inline oncontextmenu, whatever kind of control
//     a row grows next: the exemption is for fields that stand on their own, never for a row's own controls.
var CONTEXTMENU_TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable]'
// Every element with an inline oncontextmenu: a to-do row and a note row (both .todo, formats.ts) and a group
// heading (h2[data-todo-ids], html.ts). Doubles as the trace's zone vocabulary just below.
var CONTEXTMENU_HANDLER_ZONE = '.todo, h2[data-todo-ids]'
document.addEventListener('contextmenu', function(event){
    if (!IS_MOBILE) return
    var el = event.target && event.target.closest ? event.target : null
    if (el && el.closest(CONTEXTMENU_TEXT_FIELD) && !el.closest(CONTEXTMENU_HANDLER_ZONE)) return
    traceGesture('contextmenu-suppressed:' + contextmenuZone(el))
    event.preventDefault()
    event.stopImmediatePropagation()
}, true)

// The zone word for the trace, in the adapter's own vocabulary rather than an approximation of it: 'row' is a
// to-do row (.todo[data-todo-id], list row or week card), 'note' a note row (.todo[data-note-id], which opens a
// different menu and is no drag source), 'heading' a group heading with ids on it (h2[data-todo-ids] - a bare h2
// carries no handler). Anything else - the list, the body, the suggestion list - is 'other'.
function contextmenuZone(el){
    if (!el) return 'other'
    if (el.closest('.todo[data-todo-id]')) return 'row'
    if (el.closest('.todo[data-note-id]')) return 'note'
    if (el.closest('h2[data-todo-ids]')) return 'heading'
    return 'other'
}

// True for exactly as long as a press inside the open suggestion list is losing the field its focus. A tap on a
// row is a press on a non-focusable element, which the Android webview answers by dropping focus to <body> with
// a null blur relatedTarget - indistinguishable, from the blur alone, from the user leaving the search field for
// good. This flag is what tells the two apart (see onSearchBlur).
var suggestPointerInside = false
var suggestPointerInsideTimer = null

document.addEventListener('pointerdown', function(event){
    var menu = document.getElementById('searchSuggestions')
    if (!(menu && event.target && menu.contains(event.target))) return
    if (suggestPointerInsideTimer){ clearTimeout(suggestPointerInsideTimer); suggestPointerInsideTimer = null }
    suggestPointerInside = true
}, true)

// The flag lives for the WHOLE press, plus one tick after it ends. Anchoring it to the end rather than to the
// start is what makes it cover a HOLD: a tap's blur arrives within a tick of the pointerdown, but a long press
// keeps the finger down for half a second, and on Android the gesture can blur the field at any point in that
// window (the soft keyboard, a system gesture, the selection UI). Clearing after a tick, as this once did, left
// every one of those blurs looking like the user leaving - which tore the list down mid-hold. It is still tied
// strictly to the press, so an unrelated blur while no finger is down is still read as a genuine departure.
function releaseSuggestPointerInside(){
    if (!suggestPointerInside || suggestPointerInsideTimer) return
    suggestPointerInsideTimer = setTimeout(function(){
        suggestPointerInsideTimer = null
        suggestPointerInside = false
    }, 0)
}

document.addEventListener('pointerup', releaseSuggestPointerInside, true)
document.addEventListener('pointercancel', releaseSuggestPointerInside, true)

function suggestionByValue(value){
    if (!searchSuggestion) return null
    for (var index = 0; index < searchSuggestion.items.length; index++){
        if (searchSuggestion.items[index].insert === value) return searchSuggestion.items[index]
    }
    return null
}

/** Marks ******************************************************************************************************************************************
 * The marked rows of a multi-select in progress. Held by value (see searchMarks), so filtering the list, clearing the filter and filtering again all  *
 * leave them intact, and so does the list being rebuilt as the token fragment changes.                                                                *
 ***************************************************************************************************************************************************/
function markedSearchValues(){
    return searchMarks ? searchMarks.values : []
}

function toggleSearchMark(value){
    if (!searchSuggestion || value == null) return
    var kind = searchSuggestion.token.kind
    if (!searchMarks || searchMarks.kind !== kind) searchMarks = { kind: kind, values: [] }
    var at = searchMarks.values.indexOf(value)
    if (at >= 0) searchMarks.values.splice(at, 1)
    else searchMarks.values.push(value)
    if (!searchMarks.values.length) searchMarks = null
    paintSearchMarks()
    queueSearchState()
}

function clearSearchMarks(){
    searchMarks = null
    paintSearchMarks()
    queueSearchState()
}

// Paint the -marked class onto whichever rows are marked, and show the apply button exactly when at least one
// mark exists. Separate from -current (the keyboard highlight): a row can be both, and they mean different things.
function paintSearchMarks(){
    var menu = document.getElementById('searchSuggestions')
    if (!menu) return
    var marked = markedSearchValues()
    var items = menu.querySelectorAll('.dropdown-item')
    for (var index = 0; index < items.length; index++){
        items[index].classList.toggle('-marked', marked.indexOf(items[index].dataset.suggestValue) >= 0)
    }
    var apply = menu.querySelector('.suggest-apply')
    if (apply){
        if (marked.length) apply.removeAttribute('hidden')
        else apply.setAttribute('hidden', '')
    }
}

/** applySuggestFilter *****************************************************************************************************************************
 * Narrows the open list by its embedded filter box, then makes sure the keyboard highlight is still on a visible row. Marks are untouched: they are   *
 * held by value, so a row that filtering hides keeps its mark and comes back marked.                                                                  *
 ***************************************************************************************************************************************************/
function applySuggestFilter(menu){
    if (!menu) return
    var box = menu.querySelector('.suggest-filter-input')
    // Mirror the box into module state on every narrowing - typing, and the Escape step that empties it - so a
    // render replacing the markup does not take the text with it. Recorded here rather than in the input handler
    // because Escape clears the box through this function too.
    suggestFilterText = box ? box.value : ''
    suggestFilterCaret = box ? (box.selectionStart || 0) : 0
    queueSearchState()
    // One query for both the narrowing and the highlight fix-up: the list can hold SUGGEST_MAX_ITEMS rows and
    // this runs on every keystroke in the filter box.
    var items = menu.querySelectorAll('.dropdown-item')
    applyMenuFilter(items, box ? box.value : '')
    if (!searchSuggestion) return
    var current = items[searchSuggestion.activeIndex]
    if (current && !current.hasAttribute('hidden')) return
    for (var index = 0; index < items.length; index++){
        if (!items[index].hasAttribute('hidden')){ searchSuggestion.activeIndex = index; break }
    }
    paintSearchSuggestionActive()
}

// The suggestion the keyboard is on: the row at activeIndex when it is visible, otherwise the first row the
// filter still shows. Both Enter paths use this, so pressing Enter in the field and in the filter box agree.
function activeSuggestion(){
    if (!searchSuggestion) return null
    var menu = document.getElementById('searchSuggestions')
    if (!menu) return searchSuggestion.items[searchSuggestion.activeIndex] || null
    var items = menu.querySelectorAll('.dropdown-item')
    var current = items[searchSuggestion.activeIndex]
    if (current && !current.hasAttribute('hidden')) return searchSuggestion.items[searchSuggestion.activeIndex] || null
    for (var index = 0; index < items.length; index++){
        if (!items[index].hasAttribute('hidden')) return searchSuggestion.items[index] || null
    }
    return null
}

// Move the keyboard highlight by one row, skipping whatever the filter is hiding.
function moveSuggestActive(delta){
    var menu = document.getElementById('searchSuggestions')
    if (!menu || !searchSuggestion) return
    var items = menu.querySelectorAll('.dropdown-item')
    if (!items.length) return
    var index = searchSuggestion.activeIndex
    for (var step = 0; step < items.length; step++){
        index = (index + delta + items.length) % items.length
        if (!items[index].hasAttribute('hidden')) break
    }
    searchSuggestion.activeIndex = index
    paintSearchSuggestionActive()
    if (items[index] && items[index].scrollIntoView) items[index].scrollIntoView({ block: 'nearest' })
}

function paintSearchSuggestionActive(){
    var menu = document.getElementById('searchSuggestions')
    if (!menu || !searchSuggestion) return
    var items = menu.querySelectorAll('.dropdown-item')
    for (var index = 0; index < items.length; index++){
        items[index].classList.toggle('-current', index === searchSuggestion.activeIndex)
    }
}

function hideSearchSuggestions(options){
    var menu = document.getElementById('searchSuggestions')
    if (menu) traceGesture('list-closed:' + ((options && options.reason) || 'other'))
    if (menu) menu.remove()
    searchSuggestion = null
    // The box and the apply button went with the list, so the mirrored filter text, the caret target and any
    // restore still waiting to be applied to a list that will now never be built all go too. A fresh list always
    // opens with an empty filter box, exactly as before.
    suggestFilterText = ''
    suggestFilterCaret = 0
    searchFocusTarget = 'field'
    pendingSuggestRestore = null
    // No list, no multi-select: the marks belong to the open list and never outlive it - EXCEPT when the list
    // went away only because the user typed past the last match while still completing the SAME token (see
    // keepMarks below). Every other close - a blur, a commit, Escape, a re-render, the token going away
    // entirely - drops them.
    if (!(options && options.keepMarks)) searchMarks = null
}

/** applySearchSuggestion **************************************************************************************************************************
 * Inserts the chosen value in place of the partial token, quoting it when it contains spaces and adding a trailing space, then commits the search    *
 * so picking a suggestion shows its results at once (pick -> see results), which is what the user expects. The field keeps focus for continued        *
 * typing: on desktop restoreSearchDraft refocuses the freshly rendered input (caret at end) after the commit's re-render; on mobile the commit's       *
 * paint is held until blur, exactly as the existing search-focus hold already does.                                                                   *
 ***************************************************************************************************************************************************/
function applySearchSuggestion(input, suggestion){
    if (!input || !searchSuggestion || !suggestion) return
    insertSearchTokens(input, [suggestion.insert])
}

/** applyMarkedSuggestions *************************************************************************************************************************
 * Inserts EVERY marked row at once - the multi-select commit, reached from the apply button and from Enter while anything is marked. It shares one    *
 * insertion path with the single pick above, so quoting, spacing, the duplicate skip and "never touch the rest of the query" are decided in exactly   *
 * one place (the pure window.SearchTokens).                                                                                                          *
 ***************************************************************************************************************************************************/
function applyMarkedSuggestions(input){
    if (!input || !searchSuggestion) return
    var values = markedSearchValues()
    if (!values.length) return
    insertSearchTokens(input, values.slice())
}

/** insertSearchTokens *****************************************************************************************************************************
 * Splices the given values into the field in place of the incomplete token being completed, then commits, so a pick shows its results at once (pick   *
 * -> see results), which is what the user expects. The field keeps focus for continued typing: on desktop restoreSearchDraft refocuses the freshly     *
 * rendered input (caret at end) after the commit's re-render; on mobile the commit's paint is held until blur, exactly as the existing search-focus    *
 * hold already does.                                                                                                                                  *
 *                                                                                                                                                     *
 * Everything about WHAT the new text is - which values are skipped as already present, how they are quoted, where the caret lands, and the guarantee   *
 * that the query either side of the fragment comes back byte-identical - lives in window.SearchTokens.buildTokenInsertion, so it is covered by tests   *
 * rather than by reading this function.                                                                                                                *
 ***************************************************************************************************************************************************/
function insertSearchTokens(input, values){
    var next = window.SearchTokens.buildTokenInsertion(input.value, searchSuggestion.token, values)
    input.value = next.value
    input.focus()
    input.setSelectionRange(next.caret, next.caret)
    updateSearchDraft(input)
    hideSearchSuggestions({ reason: 'applied' })
    // onSearchFilterChanged clears the (now moot) draft and posts the search; the caret settles at the end of
    // the committed text after the re-render's refocus.
    onSearchFilterChanged(input.value)
}

/** handleSuggestKey *******************************************************************************************************************************
 * The keyboard for an OPEN suggestion list, shared by the search field and by the list's embedded filter box so both behave identically.             *
 *   - Arrow up/down move the highlight, skipping rows the filter is hiding.                                                                           *
 *   - Enter APPLIES: with marks it inserts all of them, with none it picks the highlighted row (the first match, unless the arrows moved it) - the     *
 *     unchanged single-pick behaviour.                                                                                                                *
 *   - Escape unwinds one step at a time: the marks first, then the filter text, and only then the list itself. It is swallowed at every step, so it    *
 *     never also reaches the context-menu, dropdown or bare-Escape-collapses-the-selection handlers - the dropdowns keep winning Escape.               *
 ***************************************************************************************************************************************************/
function handleSuggestKey(event, input){
    if (!searchSuggestion) return
    if (event.key === 'ArrowDown'){
        event.preventDefault()
        moveSuggestActive(1)
    } else if (event.key === 'ArrowUp'){
        event.preventDefault()
        moveSuggestActive(-1)
    } else if (event.key === 'Enter'){
        event.preventDefault()
        if (markedSearchValues().length){ applyMarkedSuggestions(input); return }
        applySearchSuggestion(input, activeSuggestion())
    } else if (event.key === 'Escape'){
        event.preventDefault()
        event.stopPropagation()
        escapeSearchSuggestions()
    }
}

function escapeSearchSuggestions(){
    var menu = document.getElementById('searchSuggestions')
    // 1. Marks first: a mis-built multi-selection is undone without losing the list the user is working through.
    if (markedSearchValues().length){ clearSearchMarks(); return }
    // 2. Then the embedded filter text, exactly as the notebook menu's filter does.
    var box = menu ? menu.querySelector('.suggest-filter-input') : null
    if (box && box.value){ box.value = ''; applySuggestFilter(menu); return }
    // 3. Then the list itself, handing the caret back to the search field (the press may have come from the
    //    filter box, which this removes).
    hideSearchSuggestions({ reason: 'escape' })
    var input = getSearchInput()
    if (input) input.focus()
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
    handleSuggestKey(event, getSearchInput())
}

function updateSearchDraft(input){
    searchDraft = { value: input.value, caret: input.selectionStart }
    // A typed character supersedes the outgoing-field snapshot: the draft is now the fresher record.
    lastSearchFieldSnapshot = null
    queueSearchState()
}

function onSearchFocus(){
    searchFocused = true
    searchFocusTarget = 'field'
    // Mobile only: hold the host's refreshes while the field is focused, so a setHtml (a full webview
    // reload on mobile) cannot wipe the input, caret, suggestion list or soft keyboard mid-typing. The
    // host releases the hold and runs the held refresh on blur. Desktop keeps its module-state draft
    // restore instead, so it does not post this (and the host guard is mobile-gated anyway).
    if (IS_MOBILE) void webviewApi.postMessage(['searchFocusChanged', true]);
}

/** The search focus REGION ************************************************************************************************************************
 * The search field and its open suggestion list are ONE focus region. That matters because the list now contains focusable controls of its own - the  *
 * embedded filter box and the apply button - and reaching for either of them blurs the field. Treating that as "the user left the search" would tear   *
 * down the very list they were reaching for, and on mobile would also release the host's refresh hold, whose next setHtml is a full webview reload.    *
 ***************************************************************************************************************************************************/
function inSearchRegion(node){
    if (!node) return false
    if (node === getSearchInput()) return true
    var menu = document.getElementById('searchSuggestions')
    return !!(menu && menu.contains(node))
}

function searchRegionHasFocus(){
    return inSearchRegion(document.activeElement)
}

// Focus is inside the suggestion LIST specifically - not merely somewhere in the search region. The difference
// matters for the deferred commit below: the field keeping focus is exactly how the clear button behaves, and
// that must still commit, while focus having moved into the list is the one case that must not.
function suggestionsHaveFocus(){
    var menu = document.getElementById('searchSuggestions')
    return !!(menu && menu.contains(document.activeElement))
}

/** onSearchFieldChanged ***************************************************************************************************************************
 * The field's own change / search events, which commit the search. They stay the fallbacks they have always been (Electron fires change on blur and  *
 * search on the clear button; Enter is committed explicitly in the keydown), with ONE case handled differently: focus moving from the field into the  *
 * field's OWN suggestion list.                                                                                                                       *
 *                                                                                                                                                    *
 * WHY. The browser fires `change` whenever an input whose value the user edited loses focus - and since the list gained focusable controls (its       *
 * filter box, its apply button), simply reaching for one of them is such a blur. Committing there would run the half-typed query the user was still   *
 * completing, and its re-render would tear the list out from under them mid-interaction.                                                              *
 *                                                                                                                                                    *
 * WHY DEFERRED, and not just "is focus in the list?". At `change` time the browser has NOT yet assigned focus: document.activeElement is still <body> *
 * on every route, so the question cannot be answered yet. One tick later focus has landed and it can. This also makes the answer independent of HOW   *
 * focus moved - a mouse press, Tab (the filter box is literally the field's next tab stop), or a programmatic focus() all behave the same.            *
 *                                                                                                                                                    *
 * AND IT IS ONLY DEFERRED, NEVER DROPPED. A suppressed commit stays PENDING and is flushed by leaveSearchField the moment focus finally does leave    *
 * the search region, so "type a query, reach into the list, then click away" still commits exactly once - the change->commit fallback is delayed, not  *
 * lost. An explicit commit (Enter, a pick, an apply) supersedes any pending one, so the two can never both fire.                                      *
 ***************************************************************************************************************************************************/
// The commit a `change` asked for, held until it is known whether focus left the search region. Null when none
// is waiting.
var pendingSearchCommit = null

function onSearchFieldChanged(value){
    pendingSearchCommit = { value: value }
    setTimeout(function(){
        if (!pendingSearchCommit) return                 // superseded by an explicit commit, or already flushed
        // Focus landed inside the field's own LIST: keep it pending rather than committing now. Deliberately
        // narrower than the whole search region - the clear button fires `search` while the FIELD keeps focus,
        // and that has always committed straight away, so testing the region here would strand it.
        if (suggestionsHaveFocus()) return
        // ALREADY COMMITTED, so this deferred commit has nothing to say. Pressing the field's × fires BOTH
        // `input` - on which the empty-field auto-reset commits "" - and `search`, which lands here with the
        // same "": two identical posts, of which the host's equality guard silently absorbed the second. That
        // equality IS the no-op case, so it is recognised at source instead. A genuinely changed value never
        // matches (the last commit was some other string), so blur-commits are untouched.
        if (pendingSearchCommit.value === lastCommittedSearch){ pendingSearchCommit = null; return }
        flushPendingSearchCommit()
    }, 0)
}

// Run a commit that was held while focus sat inside the suggestion list. A no-op when nothing is pending.
//
// THEORETICAL RACE, deliberately left alone. If a `change` and a host re-render ever landed in the same task,
// this flush could run AFTER reconcile had re-opened the list, closing the list it had just restored (the
// commit's own hideSearchSuggestions). It is unreachable from real input: `change` only fires on a focus move
// the user makes, the flush is one tick behind it, and a render arriving in that same tick would have to be
// triggered by something other than this commit. Probed during review and never observed. Recorded so the
// ordering is understood rather than "fixed" blindly - moving the flush earlier would reintroduce M2 (the
// commit must outlive the teardown), and dropping it would strand the typed query uncommitted.
function flushPendingSearchCommit(){
    var pending = pendingSearchCommit
    pendingSearchCommit = null
    if (pending) onSearchFilterChanged(pending.value)
}

function onSearchBlur(event){
    // A refresh removes the focused field mid-typing, and that removal blurs it. It is not a genuine blur -
    // the user has not gone anywhere - so searchFocused and the draft must survive it for restoreSearchDraft
    // to hand the caret back. A field that is ALREADY detached when its blur arrives is the easy case and is
    // dropped here.
    //
    // MEASURED, that easy case is not the one this build produces. The desktop host's setHtml is a plain
    // `contentElement.innerHTML = html` inside the panel iframe, and Blink clears focus out of the subtree it
    // is about to remove BEFORE detaching it: the removal-blur arrives with event.target STILL CONNECTED,
    // still document.getElementById('searchFilter'), and with a null relatedTarget - at that instant
    // indistinguishable from the user clicking onto something unfocusable. So this check is kept only as a
    // cheap early-out for builds that do detach first; what actually covers the render case is the deferred
    // re-check below.
    if (event && event.target && event.target.isConnected === false) return
    /** The outgoing field's last readable value **************************************************************
     * A blur of the SEARCH FIELD is the last instant a field the host is about to replace can still be read -
     * the removal-blur arrives with the node still connected and still holding whatever the user had typed.
     * Snapshotting it here is what closes the post-commit window: a commit nulls searchDraft, so anything typed
     * between the commit and the arrival of its render had nothing left to restore from and the freshly
     * rendered field repainted from the server-rendered (committed) value instead, discarding it. The snapshot
     * is strictly a FALLBACK - a live draft always wins - and it is cleared by every commit and by a genuine
     * departure, so it can never repaint superseded text.
     **********************************************************************************************************/
    if (event && event.target === getSearchInput()){
        lastSearchFieldSnapshot = { value: event.target.value, caret: event.target.selectionStart }
    }
    // Focus moving WITHIN the region (field -> filter box, filter box -> apply button, and back) is not a blur
    // of the search at all.
    var related = event ? event.relatedTarget : null
    if (inSearchRegion(related)) return
    var menu = document.getElementById('searchSuggestions')
    if (menu && related == null){
        // A press on a suggestion ROW is a press on a non-focusable element: the browser drops focus to <body>
        // and reports no relatedTarget, which from the blur alone looks exactly like the user leaving. The
        // press tracker knows better - if the press landed inside the list, hand the caret straight back and
        // keep everything up. (Desktop never gets here: its picks preventDefault the mousedown.)
        if (suggestPointerInside){ restoreSearchDraft(); return }
        // Otherwise a null relatedTarget is simply unhelpful, so decide on the next tick, once the browser has
        // finished moving focus, rather than tearing an open list down on a guess.
        setTimeout(function(){ if (!searchRegionHasFocus()) leaveSearchField() }, 0)
        return
    }
    /** The same deferral, for a blur with NO list open - DESKTOP only *****************************************
     * This is the commit-with-focus case, and it is why every commit used to end up on <body>. A commit (Enter,
     * the clear button, a picked suggestion, the empty-field auto-reset) closes the suggestion list FIRST and
     * only then asks the host to re-render. So by the time the render's removal-blur arrived there was no menu,
     * the branch above was skipped, control fell straight through to leaveSearchField(), and searchFocused was
     * already false when reconcile's restoreSearchDraft ran two milliseconds later - measured: the restore was
     * reached on every commit and returned at its very first line, every time.
     *
     * Deferring answers the question when it is actually answerable. reconcile() runs from a MutationObserver,
     * i.e. a MICROTASK, so it has always run by the time this macrotask does: if the blur came from a render,
     * restoreSearchDraft has already put the caret back into the freshly rendered field, searchRegionHasFocus()
     * is true and this stands down; if the user genuinely clicked away, nothing refocused and the departure
     * goes through one tick later than it used to - which no caller can observe, since the commit that a
     * departure flushes is itself already deferred a tick by onSearchFieldChanged.
     *
     * DESKTOP ONLY, deliberately. On mobile a setHtml is a full webview reload: no module state survives for a
     * restore to run from, so there is nothing for this to wait for, and the host's search-focus hold - which
     * leaveSearchField releases, and which is what lets a held refresh finally run - must not be delayed. The
     * mobile path through this function is therefore exactly what it was.
     ***************************************************************************************************************/
    if (!IS_MOBILE && related == null){
        setTimeout(function(){ if (!searchRegionHasFocus()) leaveSearchField() }, 0)
        return
    }
    leaveSearchField()
}

// The user has genuinely left the search: drop the uncommitted draft (or a later focus + refresh would
// resurrect this stale text over the freshly rendered field), close the list, and release the mobile refresh
// hold armed on focus so the host runs any refresh it skipped. A commit (Enter / clear) also posts
// searchFilterChanged right after, which the host's equality guard collapses to a single render.
function leaveSearchField(){
    traceGesture('field-left')
    // Focus has now left the region for good, so a commit held back while it sat inside the suggestion list is
    // due: this is what keeps "type a query, reach into the list, then click away" committing exactly once.
    // Flushed FIRST, so the commit lands before the draft is dropped, in the order the browser used to produce
    // (change, then blur).
    flushPendingSearchCommit()
    searchFocused = false
    searchDraft = null
    lastSearchFieldSnapshot = null
    hideSearchSuggestions({ reason: 'field-left' })
    // The host-held draft (mobile) is dropped on the same signal and BEFORE the hold is released, so the render
    // the host then runs can never embed a state this webview has just abandoned.
    clearHostSearchState()
    if (IS_MOBILE) void webviewApi.postMessage(['searchFocusChanged', false]);
}

/** restoreSearchDraft *****************************************************************************************************************************
 * After a refresh replaced the panel while the user was in the search field, this puts focus (and, when present, the uncommitted draft text/caret)   *
 * back. It hangs entirely on searchFocused still being true, which is onSearchBlur's job: the removal of the focused field fires a blur that this     *
 * build reports with the target still connected and no relatedTarget, so onSearchBlur does not answer it on the spot - it defers the decision one     *
 * tick, by which time this restore (a MutationObserver microtask) has already run and refocused the field, and the deferred check sees focus back     *
 * inside the region and stands down. A genuine departure refocuses nothing, so that same check clears searchFocused and no focus is stolen back       *
 * after the user has left. Three cases:                                                                                                               *
 *  - an uncommitted draft survived the refresh: restore its text and caret;                                                                           *
 *  - no draft, but the OUTGOING field was snapshotted on its removal-blur and holds something the freshly rendered field does not: restore that. This  *
 *    is the post-commit keystroke case - a commit nulls the draft, and anything typed between the commit and the arrival of its render used to be      *
 *    repainted away from the server-rendered (committed) value. The snapshot is cleared by every commit, so it can only ever carry text typed AFTER    *
 *    the last commit, never a value the user has since superseded;                                                                                     *
 *  - neither: the refresh was triggered by a commit-with-focus (Enter, or a picked suggestion, or the clear button) with nothing typed since, so the   *
 *    user is still in the field - refocus the freshly rendered input on its server-rendered (committed) value with the caret at the end, so continued  *
 *    typing works. This adds no new webview state - it reuses the existing searchFocused flag - so the mobile reload path is unaffected (there the      *
 *    module state is zeroed by the reload and the host-held search state drives the restore instead; see restoreSearchFromEmbeddedState).              *
 ***************************************************************************************************************************************************/
/** reopenSearchSuggestions ************************************************************************************************************************
 * Rebuilds the suggestion list after a re-render replaced the panel while the user was working in it, with everything the user had already put into   *
 * it: the marks, the embedded filter box's text and caret, and which control held the focus. The list itself is rebuilt from the RESTORED draft text   *
 * (onSearchInput re-parses the token under the caret and re-queries the candidates), so it reflects whatever is now in the field; the marks are put    *
 * back first, and onSearchInput drops them itself if the token has become a different kind. The rest rides in pendingSuggestRestore, applied by         *
 * whichever list is built next - which is what makes it work for title: too, whose list arrives a debounced round-trip later.                          *
 ***************************************************************************************************************************************************/
function reopenSearchSuggestions(kept){
    var input = getSearchInput()
    if (!input) return
    searchMarks = (kept && kept.marks) || null
    pendingSuggestRestore = { filter: (kept && kept.filter) || '', caret: (kept && kept.caret) || 0, focus: (kept && kept.focus) || 'field' }
    onSearchInput(input)
}

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
    var snapshot = lastSearchFieldSnapshot
    lastSearchFieldSnapshot = null
    if (snapshot && snapshot.value !== input.value){
        input.value = snapshot.value
        input.focus()
        var typedCaret = Math.min(Number(snapshot.caret) || 0, input.value.length)
        input.setSelectionRange(typedCaret, typedCaret)
        return
    }
    input.focus()
    var end = input.value.length
    input.setSelectionRange(end, end)
}

/** Search reload-survival (mobile) *****************************************************************************************************************
 * On mobile the panel WebView can be reloaded by the HOST at any moment - an Android renderer-process kill under sync load remounts it with a fresh  *
 * document - and that destroys every variable in this file. Until 2.1.0 that lost the whole in-progress search: the uncommitted query text, the      *
 * caret, an open dropdown and any marks made in it, with no way back (a reloaded document renders the last COMMITTED filter). The fix mirrors the    *
 * overlay descriptor exactly, one layer down: the HOST holds a small { draft, caret, marks, filter, filterCaret, focus } state, posted from here      *
 * (throttled, like queueOverlayState), embedded as a JSON island beside #cockpitOverlayState, and read back by reconcile on the fresh webview, which  *
 * re-runs onSearchInput on the restored draft so the list and the marks come back with it.                                                            *
 *                                                                                                                                                     *
 * DELIBERATELY NOT ROUTED THROUGH dialogGuard, and that is the whole point of a separate channel. The dropdown opens and closes on EVERY keystroke,   *
 * whereas an overlay has exactly two call sites, so bracketing it with the guard would be a leak hazard whose failure mode is frozen refreshes; and   *
 * the guard would be redundant anyway, because the mobile search-focus hold already blocks every Cockpit setHtml while the field is focused. This      *
 * posts no guard at all - it is pure state.                                                                                                            *
 *                                                                                                                                                     *
 * MOBILE ONLY. Desktop's setHtml keeps this module state alive, so its restore runs entirely from the variables above and nothing is posted - which    *
 * also keeps the desktop markup byte-identical (the island is emitted on mobile only).                                                                 *
 *                                                                                                                                                     *
 * CLEARED ON COMMIT AND ON DEPARTURE (onSearchFilterChanged / leaveSearchField), so a stale draft cannot resurrect over a search the user has since    *
 * run or abandoned. Accepted, and shared with the overlay descriptor: a webview torn down WITHOUT a blur - the panel tab closed mid-typing - leaves    *
 * the state held, and the next open restores that draft once (and re-focuses the field). It is the user's own text and one commit or blur clears it.   *
 ***************************************************************************************************************************************************/
var searchStateTimer = null

function currentSearchStateDescriptor(){
    if (!searchFocused) return null
    var input = getSearchInput()
    if (!input) return null
    var draft = searchDraft ? searchDraft : { value: input.value, caret: input.selectionStart }
    return {
        draft: String(draft.value == null ? '' : draft.value),
        caret: Number(draft.caret) || 0,
        marks: searchMarks ? { kind: searchMarks.kind, values: searchMarks.values.slice() } : null,
        filter: suggestFilterText,
        filterCaret: suggestFilterCaret,
        focus: searchFocusTarget,
    }
}

function pushSearchState(){
    if (!IS_MOBILE) return
    void webviewApi.postMessage(['searchState', currentSearchStateDescriptor()])
}

// Trailing-edge throttle for rapid input (every keystroke in the field or the list's filter box, every mark),
// mirroring queueOverlayState/queueScrollPost so a burst posts at most once every 300ms.
function queueSearchState(){
    if (!IS_MOBILE) return
    if (searchStateTimer) return
    searchStateTimer = setTimeout(function(){ searchStateTimer = null; pushSearchState() }, 300)
}

// Drop the host's copy at once, cancelling any throttled post still armed - otherwise a timer fired after a
// commit would re-post the state the commit has just invalidated.
function clearHostSearchState(){
    if (searchStateTimer){ clearTimeout(searchStateTimer); searchStateTimer = null }
    if (!IS_MOBILE) return
    void webviewApi.postMessage(['searchState', null])
}

// The raw text of the embedded search-state island (empty string when absent/null), read by startPanelObserver
// so the host knows whether this freshly loaded document can restore the search itself.
function readEmbeddedSearchStateText(){
    var node = document.getElementById('cockpitSearchState')
    if (!node) return ''
    var text = String(node.textContent || '').trim()
    return text && text !== 'null' ? text : ''
}

/** restoreSearchFromEmbeddedState ******************************************************************************************************************
 * Rebuild the in-progress search on a freshly loaded (mobile) webview from the island the host embedded. The field is refocused, which re-arms the   *
 * host's search-focus hold through onSearchFocus - without it the next refresh would simply wipe the restored state again.                            *
 *                                                                                                                                                     *
 * THE EMPTY-DRAFT TRAP. onSearchInput runs maybeAutoResetSearch first, and that reads "still filtered" off input.defaultValue - the server-rendered   *
 * value ATTRIBUTE, which this restore does not (and must not) touch. So restoring an empty draft over a document rendered with a committed filter      *
 * would look exactly like the user having just emptied the field and would post a reset nobody asked for. Arming searchResetPosted says "that reset    *
 * has already been dealt with"; the very first character the user types clears it again (the guard's own first line), so a later genuine emptying      *
 * still resets the panel.                                                                                                                              *
 ***************************************************************************************************************************************************/
function restoreSearchFromEmbeddedState(){
    var text = readEmbeddedSearchStateText()
    if (!text) return
    var state = null
    try { state = JSON.parse(text) } catch (error){ return }
    if (!state) return
    var input = getSearchInput()
    if (!input) return
    input.value = String(state.draft == null ? '' : state.draft)
    if (!input.value.trim()) searchResetPosted = true
    input.focus()
    var caret = Math.min(Number(state.caret) || 0, input.value.length)
    input.setSelectionRange(caret, caret)
    searchDraft = { value: input.value, caret: caret }
    var marks = (state.marks && Array.isArray(state.marks.values) && state.marks.values.length)
        ? { kind: state.marks.kind, values: state.marks.values.slice() }
        : null
    reopenSearchSuggestions({ marks: marks, filter: String(state.filter || ''), caret: Number(state.filterCaret) || 0, focus: state.focus || 'field' })
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
