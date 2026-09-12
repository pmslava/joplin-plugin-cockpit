/** README ******************************************************************************************************************************************
 * The keyboard and filter STATE of the desktop notebook-picker dialog, kept in ONE pure module - no DOM, no webviewApi - so the dialog webview      *
 * (notebookPickerWebview.js, via window.NotebookPickerModel) and the Node test harness (require, module.exports below) run the SAME decisions, and   *
 * every case is covered by behavioural tests rather than by reading the source. The DOM glue in the webview is deliberately thin: it reads the rows  *
 * out of the markup the host emitted, asks the four questions below, and writes classes and the hidden input back.                                  *
 *                                                                                                                                                    *
 * THE MATCH RULE IS NOT FORKED. Which rows survive the filter box is decided by the shared SearchTokens.matchesFilter - the very rule behind the      *
 * panel's notebook dropdown and the search suggestion list - so "fam" narrows a dialog exactly as it narrows the menu. It is looked up when it is     *
 * CALLED, not when this file loads: see tokens() below, which explains why the load order of a dialog's scripts is not something to rely on.          *
 *                                                                                                                                                    *
 * ROW INDEXES, NOT IDS. Everything below speaks in indexes into the row array, because the dialog's rows are a fixed list emitted once by the host    *
 * (the dialog's first measurement is taken from that markup, before any script runs, so rows are never built from script) and only ever shown or      *
 * hidden afterwards. A hidden row keeps its index; the highlight simply steps over it, which is what makes the wrap below "wrap over the VISIBLE       *
 * rows".                                                                                                                                              *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.NotebookPickerModel = api               // notebook picker dialog webview
    else if (root) root.NotebookPickerModel = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    /** tokens **************************************************************************************************************************************
     * The shared match rule, resolved when it is CALLED and never at load. joplin.views.dialogs.addScript appends ordinary classic <script> elements *
     * without async=false, so the three scripts of this dialog run in whatever order they finish fetching - this file can perfectly well win the race *
     * against searchTokens.js. A binding taken at load would then be null for the whole life of the dialog and every function below would throw,      *
     * killing the filter, the arrows and Enter while the host's own Enter handler went on submitting the pre-selection. A per-call lookup costs one   *
     * property read and is how alarmWebview.js and panelWebview.js reach their own pure modules. The Node fallback is memoised; the browser one need   *
     * not be, since it is a plain global read.                                                                                                        *
     ***********************************************************************************************************************************************/
    var requiredTokens = null
    function tokens(){
        if (typeof window !== 'undefined' && window.SearchTokens) return window.SearchTokens
        if (typeof globalThis !== 'undefined' && globalThis.SearchTokens) return globalThis.SearchTokens
        if (!requiredTokens && typeof module !== 'undefined' && module.exports) requiredTokens = require('./searchTokens.js')
        return requiredTokens
    }

    // A row is { id, path } (the webview adds its element; nothing here looks at it). A bare string is accepted
    // too, so a test can write a list of paths.
    function pathOf(row){
        if (row == null) return ''
        return String(typeof row === 'string' ? row : (row.path == null ? '' : row.path))
    }

    /** visibleIndexes ******************************************************************************************************************************
     * The indexes of the rows that survive `filter`, in list order - a case-insensitive substring of the full "Parent / Child" path, by the shared   *
     * rule. An empty or blank filter keeps every row.                                                                                                *
     ***********************************************************************************************************************************************/
    function visibleIndexes(rows, filter){
        var list = Array.isArray(rows) ? rows : []
        var out = []
        for (var index = 0; index < list.length; index++){
            if (tokens().matchesFilter(pathOf(list[index]), filter)) out.push(index)
        }
        return out
    }

    /** isVisible ***********************************************************************************************************************************
     * Whether one row survives `filter`. Used by the webview to decide whether the current highlight is still on screen.                            *
     ***********************************************************************************************************************************************/
    function isVisible(rows, index, filter){
        return visibleIndexes(rows, filter).indexOf(Number(index)) !== -1
    }

    /** moveHighlight *******************************************************************************************************************************
     * Where ArrowDown (step >= 0) or ArrowUp (step < 0) puts the highlight, given where it is now. It walks the VISIBLE rows only and WRAPS at both  *
     * ends, so a filtered list behaves as though the hidden rows were not there. A highlight that the filter has hidden is not a position to step     *
     * from, so the move lands on the first visible row going down, and on the last going up. With nothing visible there is nowhere to go: -1.         *
     ***********************************************************************************************************************************************/
    function moveHighlight(rows, filter, current, step){
        var visible = visibleIndexes(rows, filter)
        if (!visible.length) return -1
        var forward = Number(step) >= 0
        var at = visible.indexOf(Number(current))
        if (at === -1) return forward ? visible[0] : visible[visible.length - 1]
        return visible[(at + (forward ? 1 : -1) + visible.length) % visible.length]
    }

    /** enterTarget *********************************************************************************************************************************
     * The row Enter commits: the highlighted one when it is still visible, otherwise the FIRST visible row - the same "Enter picks the first match"  *
     * the notebook dropdown's filter box has. Nothing visible means nothing to commit: -1.                                                            *
     ***********************************************************************************************************************************************/
    function enterTarget(rows, filter, current){
        var visible = visibleIndexes(rows, filter)
        if (!visible.length) return -1
        if (visible.indexOf(Number(current)) !== -1) return Number(current)
        return visible[0]
    }

    /** escapeAction ********************************************************************************************************************************
     * What an Escape press in the filter box means. With text in the box it CLEARS it (and the webview swallows the press, so the dialog stays up);  *
     * with an empty box the press is left alone - 'dismiss' means "do nothing here", and Joplin's own handling cancels the dialog, which is what the  *
     * user asking twice actually means. The same two-step the notebook dropdown's filter has.                                                         *
     ***********************************************************************************************************************************************/
    function escapeAction(filterText){
        return String(filterText == null ? '' : filterText) ? 'clear' : 'dismiss'
    }

    return {
        visibleIndexes: visibleIndexes,
        isVisible: isVisible,
        moveHighlight: moveHighlight,
        enterTarget: enterTarget,
        escapeAction: escapeAction,
    }
})
