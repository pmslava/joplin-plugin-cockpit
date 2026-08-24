/** README ******************************************************************************************************************************************
 * The text rules behind the search field's tag: / notebook: / title: autocomplete, and behind its MULTI-select. Kept in ONE pure module - no DOM, no *
 * webviewApi - so the panel webview (panelWebview.js, via window.SearchTokens) and the Node test harness (require, module.exports below) run the SAME *
 * decisions, and every case below is covered by behavioural tests rather than by reading the source.                                                 *
 *                                                                                                                                                    *
 * THE ONE RULE THAT MATTERS. This is a pure TEXT HELPER for the search field. It NEVER deletes or rewrites what the user has already written.         *
 * buildTokenInsertion replaces exactly ONE span - [token.start, token.end), the incomplete token being completed (the `tag:pro` the user was typing)  *
 * - and returns everything before and after it byte-identical. Other tokens, free text, `any:1`, negations: all untouched. Cockpit does not manage    *
 * AND/OR either: several tag: terms are AND by Joplin's default, and the user's own any:0|1 decides otherwise.                                        *
 *                                                                                                                                                    *
 * QUOTING. A value containing whitespace is wrapped in double quotes ("notebook:\"Family / Payments\""). A value can itself contain a quote and       *
 * Joplin's phrase syntax has no way to escape one, so embedded quotes are stripped before wrapping - the same sanitisation the single-pick path has    *
 * always done, and the same one searchTitleSuggestions applies on the query side.                                                                     *
 *                                                                                                                                                     *
 * DUPLICATE SKIP. A marked value whose rendered token is ALREADY somewhere in the surrounding query is not inserted a second time. The comparison is   *
 * on the whole term (kind + value, case-insensitively, quoted and unquoted spellings normalised to one key), so `notebook:A` and `notebook:"A"` count  *
 * as the same term - while `-tag:x` does NOT suppress `tag:x`, because a negation is a different term with a different meaning.                        *
 *                                                                                                                                                     *
 * SPACING. Inserted tokens are separated by exactly one space and followed by exactly one trailing space, so typing can continue straight after them.  *
 * The text AFTER the replaced fragment is never touched, not even to collapse the double space an apply in the middle of a query can leave. That is    *
 * deliberate: "never rewrite existing content" outranks cosmetics, Joplin tokenises on whitespace so a double space changes nothing, and it keeps the  *
 * single-value output byte-identical to what the pre-multi-select single pick produced.                                                                *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.SearchTokens = api                      // panel webview iframe
    else if (root) root.SearchTokens = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    // One whitespace-separated piece of a query, parsed as a filter term: an optional leading "-", a field name,
    // a colon, and a value that may itself be a quoted phrase. Applied to a WHOLE piece (anchored both ends), so
    // a piece that merely contains a colon somewhere - or that is a quoted phrase, which cannot start with a
    // letter followed by a colon - is not mistaken for a filter.
    var TERM_PATTERN = /^(-?)([A-Za-z]+):("([^"]*)"?|.*)$/

    // The canonical key of one filter term, used only for comparison: sign + kind + value, lower-cased, with the
    // quoted and unquoted spellings of the same value collapsing onto one key.
    function termKey(sign, kind, value){
        return String(sign || '') + String(kind || '').toLowerCase() + ':' + String(value || '').toLowerCase()
    }

    /** splitQueryPieces ****************************************************************************************************************************
     * A query split on whitespace the way Joplin reads it: a double-quoted phrase is ONE piece, whitespace inside it and all. That is what makes the *
     * duplicate skip quote-aware - in `"foo tag:work" tag:` the phrase is a single piece that is not a filter term at all, so it cannot suppress      *
     * inserting tag:work, while a real `tag:"a b"` stays one piece and is read as the term it is.                                                     *
     ***********************************************************************************************************************************************/
    function splitQueryPieces(text){
        var source = String(text || '')
        var pieces = []
        var index = 0
        while (index < source.length){
            while (index < source.length && /\s/.test(source.charAt(index))) index++
            if (index >= source.length) break
            var start = index
            var quoted = false
            while (index < source.length && (quoted || !/\s/.test(source.charAt(index)))){
                if (source.charAt(index) === '"') quoted = !quoted
                index++
            }
            pieces.push(source.slice(start, index))
        }
        return pieces
    }

    // The keys of every filter term in `text`. Used on the query AROUND the fragment being replaced, never on the
    // fragment itself (which is about to go).
    function termKeys(text){
        var keys = {}
        var pieces = splitQueryPieces(text)
        for (var index = 0; index < pieces.length; index++){
            var match = TERM_PATTERN.exec(pieces[index])
            if (!match) continue
            var value = match[4] !== undefined ? match[4] : match[3]
            keys[termKey(match[1], match[2], value)] = true
        }
        return keys
    }

    /** renderToken *********************************************************************************************************************************
     * One search token as it is written into the field: "tag:work", or 'notebook:"Family / Payments"' when the value contains whitespace. Embedded   *
     * double quotes are stripped first (Joplin cannot escape one inside a phrase, so a raw quote would break the committed token).                    *
     ***********************************************************************************************************************************************/
    function renderToken(kind, value){
        var clean = String(value == null ? '' : value).replace(/"/g, '')
        return String(kind) + ':' + (/\s/.test(clean) ? '"' + clean + '"' : clean)
    }

    /** buildTokenInsertion *************************************************************************************************************************
     * The new search text after applying `values` (one for a plain pick, several for a multi-select) to `query`, replacing ONLY the incomplete token *
     * span the caret is in. `token` is { kind, start, end } as tokenAtCaret produces it. Returns { value, caret }, the caret sitting right after the  *
     * inserted run so typing continues naturally.                                                                                                     *
     *                                                                                                                                                *
     * Values are inserted in the order given, minus those already present in the surrounding query and minus repeats within the list itself. When     *
     * every value is skipped the fragment is simply removed (never left as a dangling half-typed `tag:pro`), and the caret stays where it was.        *
     ***********************************************************************************************************************************************/
    function buildTokenInsertion(query, token, values){
        var text = String(query == null ? '' : query)
        var spec = token || {}
        var kind = String(spec.kind || '')
        // Clamp the span to the text, so a stale token (the field changed under an in-flight suggestion) can only
        // ever splice inside the string rather than throw or duplicate its tail.
        var start = Math.max(0, Math.min(Number(spec.start) || 0, text.length))
        var end = Math.max(start, Math.min(Number(spec.end) || 0, text.length))
        var head = text.slice(0, start)
        var tail = text.slice(end)

        var present = termKeys(head + tail)
        var pieces = []
        var list = Array.isArray(values) ? values : (values == null ? [] : [values])
        for (var index = 0; index < list.length; index++){
            var clean = String(list[index] == null ? '' : list[index]).replace(/"/g, '')
            if (!clean) continue                                     // an empty value would render as a bare "tag:"
            var key = termKey('', kind, clean)
            if (present[key]) continue                               // already in the query (or already inserted just now)
            present[key] = true
            pieces.push(renderToken(kind, clean))
        }

        var inserted = pieces.length ? pieces.join(' ') + ' ' : ''
        return { value: head + inserted + tail, caret: head.length + inserted.length }
    }

    /** matchesFilter *******************************************************************************************************************************
     * Whether a suggestion row survives the dropdown's embedded filter box: a case-insensitive substring of its visible label ("fam" matches         *
     * "Family / Payments"). An empty or blank filter matches everything. The same rule the notebook menu's filter has always used.                    *
     ***********************************************************************************************************************************************/
    function matchesFilter(label, filter){
        var needle = String(filter == null ? '' : filter).trim().toLowerCase()
        if (!needle) return true
        return String(label == null ? '' : label).toLowerCase().indexOf(needle) !== -1
    }

    /** hintText ************************************************************************************************************************************
     * The muted line at the dropdown's bottom edge, telling the user how to mark more than one row. Touch has no Ctrl and no hover, so the mobile     *
     * wording names the gesture that actually works there.                                                                                            *
     ***********************************************************************************************************************************************/
    function hintText(isMobile){
        return isMobile ? 'Press and hold - select several' : 'Ctrl+click - select several'
    }

    /** filterPlaceholder ***************************************************************************************************************************
     * The embedded filter box's placeholder, named after what it narrows. Matches the notebook menu's "Filter notebooks..." wording.                  *
     ***********************************************************************************************************************************************/
    function filterPlaceholder(kind){
        if (kind === 'tag') return 'Filter tags...'
        if (kind === 'notebook') return 'Filter notebooks...'
        if (kind === 'title') return 'Filter titles...'
        return 'Filter...'
    }

    // The apply button's glyph (a keyboard return arrow), inlined here rather than taken from src/ui/icons.ts:
    // that module is TypeScript bundled into index.js and unreachable from the webview scripts, which the build
    // copies verbatim. Same reason noteMenu.js carries its own markup. Pinned by the harness.
    var APPLY_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
        + '<path d="M19 7v4H5.83l3.58-3.58L8 6l-6 6 6 6 1.41-1.42L5.83 13H21V7z"/></svg>'

    return {
        renderToken: renderToken,
        buildTokenInsertion: buildTokenInsertion,
        matchesFilter: matchesFilter,
        hintText: hintText,
        filterPlaceholder: filterPlaceholder,
        APPLY_ICON: APPLY_ICON,
    }
})
