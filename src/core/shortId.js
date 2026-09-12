/** README ******************************************************************************************************************************************
 * THE SHORT ID - how Cockpit shows a reference's id beside its name, and reads it back.                                                             *
 *                                                                                                                                                    *
 * Both of Cockpit's reference-holding settings ("Excluded notebooks" and "Settings note") name something the user recognises by NAME and Cockpit      *
 * holds by ID, and both used to show only the name - so two notebooks called "Archive", or a settings note whose title someone else also used, looked *
 * identical in a field that was pointed at exactly one of them. They now show BOTH: "Lab / Joplin (fdfd6c06)".                                        *
 *                                                                                                                                                    *
 * WHY THE ID IS SHORTENED. A Joplin String setting is rendered as a single-line <input> at an inline 50% width (SettingComponent.tsx); there is no     *
 * multiline subtype, and the element's DOM id is a React useId(), so no stylesheet can reach it to wrap or widen it. The text therefore has to be      *
 * short enough to READ in a narrow box, and a full 32-character id beside every name is not. Eight characters are - and they are lengthened, two at a  *
 * time, for as long as anything else on offer shares the prefix, so what is shown always names exactly one thing.                                     *
 *                                                                                                                                                    *
 * DISPLAY AND PARSE ARE EXACTLY AS WIDE AS EACH OTHER. splitDisplayID only reads back a group this module could have written, and shortID only writes  *
 * one that could be read back: 6 to 32 hex characters, six being the floor at which a bracketed word is an identifier rather than part of a name. An   *
 * id that is not hex (a fixture, something foreign) gets no bracket at all rather than one that would not survive the round trip.                      *
 *                                                                                                                                                    *
 * Dependency-free on purpose, exactly like horizons.js, between.js and settingsNote.js: the same UMD file is require()d by the Node harness and        *
 * bundled into the host, so the rules the unit checks pin are the rules that run. src/core/settingsNote.js must stay requirable on its own (it is      *
 * loaded in webviews too), so it carries its own copy of these two functions and the harness pins that the copies agree.                               *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require) and webpack
    if (typeof window !== 'undefined') window.CockpitShortID = api                    // harmless webview export (unused there)
    else if (root) root.CockpitShortID = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    /** An id in the spelling this display form can carry: 6 to 32 lower-case hex characters. A Joplin item id is 32 of them. */
    var SHORT_ID_PATTERN = /^[0-9a-f]{6,32}$/

    /** "<name> (<id>)", with at least one space before the bracket and a non-blank name in front of it. The name is GREEDY, which is what makes the
     * LAST bracketed group the id: "Budget (deadbeef) (c0ffee11)" is the notebook called "Budget (deadbeef)", not the one called "Budget". */
    var DISPLAY_SUFFIX = /^(.*\S)\s+\(([0-9a-fA-F]{6,32})\)$/

    /** shortID *************************************************************************************************************************************
     * The id as it is SHOWN: its first 8 characters, lengthened two at a time (8, 10, 12 ... 32) for as long as some OTHER id on offer begins with    *
     * the same characters. `otherIds` is anything iterable - an array, or a Map's keys - and the id itself may be among them.                         *
     *                                                                                                                                                *
     * Answers "" for anything that is not 6-32 hex characters, which is the one way this module ever refuses to show an id: it would not parse back.  *
     ***************************************************************************************************************************************************/
    function shortID(id, otherIds){
        var text = String(id === undefined || id === null ? '' : id).trim().toLowerCase()
        if (!SHORT_ID_PATTERN.test(text)) return ''
        var others = []
        for (var other of (otherIds || [])){
            var candidate = String(other === undefined || other === null ? '' : other).trim().toLowerCase()
            if (candidate && candidate !== text) others.push(candidate)
        }
        for (var length = 8; length < text.length; length += 2){
            var prefix = text.slice(0, length)
            var shared = false
            for (var rival of others){
                if (rival.indexOf(prefix) === 0){ shared = true; break }
            }
            if (!shared) return prefix
        }
        return text
    }

    /** splitDisplayID ******************************************************************************************************************************
     * The two halves of a display form, or NULL when the text is not one: { name, id } for "Lab / Joplin (fdfd6c06)", null for "Lab / Joplin" and for *
     * anything whose brackets do not hold 6-32 hex characters. Says nothing about whether the id EXISTS - that is the caller's question, and it is     *
     * the question that keeps a notebook genuinely titled "Budget (deadbeef)" working.                                                                *
     ***************************************************************************************************************************************************/
    function splitDisplayID(value){
        var match = DISPLAY_SUFFIX.exec(String(value === undefined || value === null ? '' : value).trim())
        if (!match) return null
        return { name: match[1], id: match[2].toLowerCase() }
    }

    return {
        shortID: shortID,
        splitDisplayID: splitDisplayID,
    }
})
