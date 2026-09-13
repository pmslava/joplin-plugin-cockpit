/** README ******************************************************************************************************************************************
 * THE DISPLAY FORM - how Cockpit shows a reference's id beside its name, and reads it back.                                                          *
 *                                                                                                                                                    *
 * Both of Cockpit's reference-holding settings ("Excluded notebooks" and "Settings note") name something the user recognises by NAME and Cockpit      *
 * holds by ID, and both used to show only the name - so two notebooks called "Archive", or a settings note whose title someone else also used, looked *
 * identical in a field that was pointed at exactly one of them. They show BOTH: "Lab / Joplin (fdfd6c06e6f549df944a4fb442e1f318)".                    *
 *                                                                                                                                                    *
 * THE ID IS SHOWN WHOLE. 2.6.1 showed the first eight characters, and the owner's live round is why that is gone: an id shortened to a prefix READS   *
 * AS A DIFFERENT ID. He compared the note's real id with the one in the field, saw two different strings, and asked which note the setting was        *
 * pointing at - the one question this display exists to answer. The field is a single-line <input> and a 32-character id makes it scroll; showing an  *
 * id that is the id is worth that.                                                                                                                    *
 *                                                                                                                                                    *
 * PARSE IS WIDER THAN DISPLAY, ON PURPOSE, AND THAT IS THE 2.6.1 MIGRATION. splitDisplayID reads back 6 to 32 hex characters - six being the floor at  *
 * which a bracketed word is an identifier rather than part of a name - because fields written by 2.6.1 are out there holding "Archive (a1b2c3d4)",     *
 * and that text has to go on naming the same notebook and be rewritten to the full form. displayID only ever writes a form this could read back; an id *
 * that is not hex (a fixture, something foreign) gets no bracket at all rather than one that would not survive the round trip.                         *
 *                                                                                                                                                    *
 * Dependency-free on purpose, exactly like horizons.js, between.js and settingsNote.js: the same UMD file is require()d by the Node harness and        *
 * bundled into the host, so the rules the unit checks pin are the rules that run. src/core/settingsNote.js must stay requirable on its own (it is      *
 * loaded in webviews too), so it carries its own copy of these two functions and the harness pins that the copies agree.                               *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require) and webpack
    if (typeof window !== 'undefined') window.CockpitDisplayID = api                  // harmless webview export (unused there)
    else if (root) root.CockpitDisplayID = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    /** An id in the spelling this display form can carry: 6 to 32 lower-case hex characters. A Joplin item id is 32 of them, which is what is shown;
     * the shorter end of the range exists for the parse side, which still has to read back what 2.6.1 wrote. */
    var DISPLAY_ID_PATTERN = /^[0-9a-f]{6,32}$/

    /** "<name> (<id>)", with at least one space before the bracket and a non-blank name in front of it. The name is GREEDY, which is what makes the
     * LAST bracketed group the id: "Budget (deadbeef) (c0ffee11)" is the notebook called "Budget (deadbeef)", not the one called "Budget". */
    var DISPLAY_SUFFIX = /^(.*\S)\s+\(([0-9a-fA-F]{6,32})\)$/

    /** displayID ***********************************************************************************************************************************
     * The id as it is SHOWN: the whole of it, lower-cased. Nothing is truncated - a prefix of an id is a different string from the id, and a user     *
     * comparing the two has no way to tell that it is the same thing.                                                                                 *
     *                                                                                                                                                *
     * Answers "" for anything that is not 6-32 hex characters, which is the one way this module ever refuses to show an id: it would not parse back.   *
     ***************************************************************************************************************************************************/
    function displayID(id){
        var text = String(id === undefined || id === null ? '' : id).trim().toLowerCase()
        return DISPLAY_ID_PATTERN.test(text) ? text : ''
    }

    /** splitDisplayID ******************************************************************************************************************************
     * The two halves of a display form, or NULL when the text is not one: { name, id } for "Lab / Joplin (fdfd6c06)", null for "Lab / Joplin" and for  *
     * anything whose brackets do not hold 6-32 hex characters. Says nothing about whether the id EXISTS - that is the caller's question, and it is     *
     * the question that keeps a notebook genuinely titled "Budget (deadbeef)" working, and the question that lets a SHORT id written by 2.6.1 be       *
     * matched as the prefix it is.                                                                                                                     *
     ***************************************************************************************************************************************************/
    function splitDisplayID(value){
        var match = DISPLAY_SUFFIX.exec(String(value === undefined || value === null ? '' : value).trim())
        if (!match) return null
        return { name: match[1], id: match[2].toLowerCase() }
    }

    return {
        displayID: displayID,
        splitDisplayID: splitDisplayID,
    }
})
