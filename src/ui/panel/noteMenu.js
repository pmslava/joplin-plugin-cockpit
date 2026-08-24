/** README ******************************************************************************************************************************************
 * The markup for the panel's own note context menu, drawn by Cockpit because Joplin's native note context menu cannot be opened from a plugin       *
 * webview. Kept in ONE pure module - the ordered item list, each item's multi-select label, and the button HTML - so the desktop menu (panelWebview  *
 * .js, via window.NoteMenu) and the Node test harness (require, module.exports below) build byte-identical markup.                                    *
 *                                                                                                                                                    *
 * SELECTION COUNT: menuHtml(count, extraItems) renders the menu for a selection of `count` rows. count === 1 is today's single-note menu, byte-for-  *
 * byte. count > 1 (only reachable on desktop, where Ctrl/Shift multi-select exists) GREYS OUT the single-only actions (Open) - disabled, never       *
 * hidden, so the user still sees them - and gives every multi-capable action a label carrying the count ("Delete 6 notes"), so a mistaken batch is    *
 * visible before the click. `extraItems` (mobile's "Move to date…") are prepended verbatim and are always single-note (mobile has no multi-select).   *
 *                                                                                                                                                    *
 * MIXED SELECTIONS: since 2.1.0 a selection may hold to-do rows AND regular note rows at once, and every action here already takes an id array of     *
 * either kind - Joplin has one note store, and a to-do IS a note with is_todo set. The wording needs no split either: "Delete 3 notes" is true of a   *
 * mixed set for the same reason, and "Switch type of 3 items" already reads for both. So the labels below are deliberately UNCHANGED by the mixed     *
 * selection; only the time-based operations (drag-to-date, set alarm), which live outside this menu, care which kind a row is.                        *
 *                                                                                                                                                    *
 * The labels are static literals (no user text), so nothing here is HTML-escaped - matching the inline template this replaced.                        *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.NoteMenu = api                          // panel webview iframe
    else if (root) root.NoteMenu = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    // The single source of truth for the menu's rows, in order. Each { action, label } is the single-note
    // label; the multi-select label is derived in multiLabel below.
    var NOTE_MENU_ITEMS = [
        { action: 'open', label: 'Open' },
        { action: 'toggleType', label: 'Switch between note and to-do type' },
        { action: 'tags', label: 'Tags...' },
        { action: 'moveToFolder', label: 'Move to notebook...' },
        { action: 'duplicate', label: 'Duplicate' },
        { action: 'copyMarkdownLink', label: 'Copy Markdown link' },
        { action: 'copyNoteID', label: 'Copy note ID' },
        { action: 'delete', label: 'Delete note' },
    ]

    // Actions that can only ever act on ONE note, so with several rows selected they render disabled (greyed)
    // rather than acting on just one of them. Everything else applies to the whole selection.
    var SINGLE_ONLY = { open: true }

    function isSingleOnly(action){ return !!SINGLE_ONLY[action] }

    // The label a multi-capable item shows when `count` (> 1) rows are selected. The count is baked into the
    // wording so a mistaken batch is obvious before the click. Single-only items keep their base label (they
    // render disabled), and any unknown action falls back to its base label too.
    function multiLabel(action, count, baseLabel){
        switch (action){
            case 'toggleType':       return 'Switch type of ' + count + ' items'
            case 'tags':             return 'Tags for ' + count + ' notes...'
            case 'moveToFolder':     return 'Move ' + count + ' to notebook...'
            case 'duplicate':        return 'Duplicate ' + count + ' notes'
            case 'copyMarkdownLink': return 'Copy ' + count + ' Markdown links'
            case 'copyNoteID':       return 'Copy ' + count + ' note IDs'
            case 'delete':           return 'Delete ' + count + ' notes'
            default:                 return baseLabel
        }
    }

    // One menu button. For count === 1 this is byte-for-byte the pre-multi template: the class carries the
    // ` -danger` modifier on delete and nothing else, and there is no aria-disabled. For count > 1 a single-
    // only action gains the ` -disabled` class + aria-disabled (greyed, inert), and every capable action's
    // label carries the count.
    function itemHtml(item, count){
        var multi = count > 1
        var disabled = multi && isSingleOnly(item.action)
        var label = (multi && !disabled) ? multiLabel(item.action, count, item.label) : item.label
        var cls = 'context-menu-item'
            + (item.action === 'delete' ? ' -danger' : '')
            + (disabled ? ' -disabled' : '')
        return '<button type="button" class="' + cls + '" data-action="' + item.action + '"'
            + (disabled ? ' aria-disabled="true"' : '') + '>' + label + '</button>'
    }

    // The full menu innerHTML for a selection of `count` rows. `extraItems` (an optional array of { action,
    // label }) are prepended verbatim - mobile's single-note "Move to date…" entry - and take no count.
    function menuHtml(count, extraItems){
        var n = (count > 1) ? count : 1
        var items = (extraItems || []).concat(NOTE_MENU_ITEMS)
        return items.map(function(item){ return itemHtml(item, n) }).join('')
    }

    return {
        NOTE_MENU_ITEMS: NOTE_MENU_ITEMS,
        isSingleOnly: isSingleOnly,
        multiLabel: multiLabel,
        itemHtml: itemHtml,
        menuHtml: menuHtml,
    }
})
