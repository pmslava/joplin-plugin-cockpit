/** README ******************************************************************************************************************************************
 * THE SETTINGS NOTE - one Joplin note carrying Cockpit's profiles and view settings between devices, as machine-readable JSON.                      *
 *                                                                                                                                                    *
 * Joplin syncs notes, never plugin settings, so a user who wants the same profiles on their laptop and their phone has to build them twice (issue 5). *
 * The note is the transport that closes that gap, and it is a MAILBOX, not a document: the plugin writes the whole payload when local state changes    *
 * and applies the whole payload when it finds a body it did not write. There is no per-field merging, no reconciliation and no repair - whole-note     *
 * last-writer-wins, and two devices editing at the same moment produce an ordinary Joplin conflict copy the user resolves by hand.                     *
 *                                                                                                                                                    *
 * THE BODY is one human sentence (so a person who stumbles on the note knows what it is and leaves it alone), a blank line, then a fenced ```json      *
 * block holding the payload. Nothing else is read, and nothing else is preserved.                                                                      *
 *                                                                                                                                                    *
 * WHAT TRAVELS: the whole profile store, and the view settings a user would otherwise re-enter by hand (the panel CSS, the theme colours, the          *
 * completed-to-do style, the day start time and the excluded notebooks). WHAT DOES NOT: everything that is a property of the DEVICE rather than of the *
 * view - the selected profile, the refresh interval, the toolbar button and title-bar switches, the font and circle sizes (a phone and a 27" monitor    *
 * want different ones) and the settings note's own id. See SYNCED_SETTING_KEYS below and README.md.                                                     *
 *                                                                                                                                                    *
 * DETERMINISTIC BYTES. Every object that reaches the body is rebuilt with its keys sorted, so two devices holding the same state produce the same      *
 * characters and therefore the same content key. That is what makes "write only when there is something to say" a real no-op instead of a coin flip.   *
 *                                                                                                                                                    *
 * Dependency-free on purpose (no `joplin`, no `api`), exactly like horizons.js and between.js: the very same file is require()d by the Node test       *
 * harness (module.exports below) and bundled into the host by webpack (require("./settingsNote") in settingsSync.ts), so every rule here is            *
 * unit-tested AND drives the real sync. The joplin-dependent half - when to write, when to apply - lives in src/core/settingsSync.ts.                  *
 *                                                                                                                                                    *
 * API                                                                                                                                                *
 *   SETTINGS_NOTE_TITLE            - the exact title the note is created with, and the title a device searches for when connecting by name.           *
 *   SETTINGS_NOTE_SENTENCE         - the one human line at the top of the body. Approved copy; it lives nowhere else.                                  *
 *   SETTINGS_NOTE_VERSION          - the payload's schema version. Bumped only if the shape ever changes incompatibly.                                 *
 *   SYNCED_SETTING_KEYS            - the plugin setting keys that travel, sorted. Everything else is per device by design.                             *
 *   normalizeSettingsPayload(raw)  - { profiles, settings } in canonical form: sorted keys, unknown setting keys dropped, junk coerced away.           *
 *   settingsContentKey(raw)        - the loop-prevention token: the canonical string of the SYNCED CONTENT, with version and updatedAt excluded.       *
 *   buildSettingsNoteBody(c, when) - the exact bytes of a note body for that content, stamped with an ISO timestamp.                                   *
 *   parseSettingsNoteBody(body)    - the payload in a body, or null when there is not one this build can soundly interpret.                            *
 *   isFutureSettingsNote(body)    - whether an unreadable body is unreadable because a NEWER Cockpit wrote it, which is never written over.            *
 *   parseSettingsNoteReference(v)  - what the user typed in the setting: a bare id, ":/id", a Markdown link, a joplin:// URL, or a title.              *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.CockpitSettingsNote = api               // harmless webview export (unused there)
    else if (root) root.CockpitSettingsNote = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    /** The title the "Cockpit: Connect settings note" command gives the note it creates, and the title a second device looks for. */
    var SETTINGS_NOTE_TITLE = 'Joplin Cockpit Plugin Settings'

    /** The one human sentence at the top of the body. Approved copy - change it nowhere else. */
    var SETTINGS_NOTE_SENTENCE = 'This note is used by the Cockpit plugin to sync its profiles and settings between devices. ' +
        'Do not edit it. Change them in Cockpit itself.'

    /** The payload's schema version. A body carrying a HIGHER one is refused outright (see parseSettingsNoteBody). */
    var SETTINGS_NOTE_VERSION = 1

    /** The plugin settings that travel in the note, sorted so the payload's key order is fixed. The names are exactly the keys these settings are
     * registered under in src/core/settings.ts (excludedNotebooks / excludedNotebookIds come from src/core/exclusion.ts).
     *
     * BOTH HALVES OF THE EXCLUSION TRAVEL. The ids are the single source of truth for every exclusion decision and the names are what the user
     * typed; notebook ids are identical on every device of one account, so sending the ids as well as the names means the receiving device does not
     * have to re-resolve anything - and on apply the ids are written FIRST, so the names' own resolver finds everything already resolved and writes
     * nothing back (see applySettingsPayload in settingsSync.ts). */
    var SYNCED_SETTING_KEYS = [
        'completedTodoStyle',
        'customCheckboxColor',
        'customContentBackground',
        'customCss',
        'customDividerColor',
        'customPanelBackground',
        'customProgressColor',
        'customTextColor',
        'dayStartTime',
        'excludedNotebookIds',
        'excludedNotebooks',
        'themeMode',
    ]

    /** The fenced block, located by its opening ```json marker. NON-GREEDY to the first closing fence, so text a user (or a Joplin conflict marker)
     * left behind after the payload cannot swallow it. */
    var JSON_FENCE = /```json[^\S\n]*\n([\s\S]*?)\n?```/

    /** A Joplin item id: 32 lower-case hex characters. Written by the app itself, so the spelling is exact rather than tolerant. */
    var ID_PATTERN = /^[0-9a-f]{32}$/i

    /** sortedObject ********************************************************************************************************************************
     * A copy of an object with its keys in sorted order, so JSON.stringify produces the same characters whatever order the source happened to hold.  *
     * Values are carried across untouched; `undefined` is dropped, as JSON has no spelling for it.                                                   *
     ***************************************************************************************************************************************************/
    function sortedObject(source){
        var out = {}
        if (!source || typeof source !== 'object') return out
        var keys = Object.keys(source).sort()
        for (var index = 0; index < keys.length; index++){
            var value = source[keys[index]]
            if (value === undefined) continue
            out[keys[index]] = value
        }
        return out
    }

    /** normalizeProfiles ***************************************************************************************************************************
     * The profile store in canonical form: a positive nextID and an array of profiles, each with its own keys sorted. The FIELDS of a profile are    *
     * deliberately not validated here - the receiving device runs its own normalizeProfileStore (src/core/database.ts), which is the one place that  *
     * knows what a profile is made of, and which fills in anything a payload from an older or newer build left out.                                   *
     ***************************************************************************************************************************************************/
    function normalizeProfiles(raw){
        var source = (raw && typeof raw === 'object') ? raw : {}
        var nextID = Number(source.nextID)
        if (!Number.isFinite(nextID) || nextID < 1) nextID = 1
        var profiles = []
        var list = Array.isArray(source.profiles) ? source.profiles : []
        for (var index = 0; index < list.length; index++){
            if (!list[index] || typeof list[index] !== 'object' || Array.isArray(list[index])) continue
            profiles.push(sortedObject(list[index]))
        }
        return { nextID: nextID, profiles: profiles }
    }

    /** normalizeSyncedSettings *********************************************************************************************************************
     * Only the keys in SYNCED_SETTING_KEYS, only when the payload actually carries them, in sorted order. A key a payload LEAVES OUT stays out, which *
     * is what makes a missing key mean "keep the local value" rather than "clear it"; a key this build does not know is dropped, so a payload written *
     * by a newer Cockpit is still usable for everything this build does understand.                                                                   *
     ***************************************************************************************************************************************************/
    function normalizeSyncedSettings(raw){
        var source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
        var out = {}
        for (var index = 0; index < SYNCED_SETTING_KEYS.length; index++){
            var key = SYNCED_SETTING_KEYS[index]
            if (!Object.prototype.hasOwnProperty.call(source, key)) continue
            var value = source[key]
            if (value === undefined || value === null) continue
            // Every synced setting is a string in the registration (a colour, a CSS block, an enum name, HH:MM, a CSV). Coercing here means a
            // payload that carries a number or a boolean for one of them still applies as the setting's own type rather than poisoning it.
            out[key] = String(value)
        }
        return out
    }

    /** normalizeSettingsPayload ********************************************************************************************************************
     * The synced content in canonical form - the same rules on both sides, so two devices holding the same state produce the same bytes and the same *
     * content key. version and updatedAt are NOT part of it; they belong to the body, not to the content.                                            *
     ***************************************************************************************************************************************************/
    function normalizeSettingsPayload(raw){
        var source = (raw && typeof raw === 'object') ? raw : {}
        return {
            profiles: normalizeProfiles(source.profiles),
            settings: normalizeSyncedSettings(source.settings),
        }
    }

    /** settingsContentKey **************************************************************************************************************************
     * THE LOOP-PREVENTION TOKEN: a canonical string for the SYNCED CONTENT, with `updatedAt` and `version` deliberately excluded.                     *
     *                                                                                                                                                *
     * The device remembers this for the body it last WROTE or last APPLIED, and refuses to do either again for the same value. Excluding the          *
     * timestamp is what makes that work at all: applying a remote body writes settings and replaces the profile store, both of which schedule a        *
     * write - and a key that included `updatedAt` would differ from the one just applied, so two devices would rewrite the note at each other every    *
     * few seconds, forever, with the content never changing.                                                                                          *
     *                                                                                                                                                *
     * It is the CANONICAL STRING ITSELF, not a digest of it. A short hash would be a few bytes cheaper and would carry a collision risk whose failure  *
     * mode is silent: a remote update that never arrives and never errors. The string costs a few kB of memory (it is never persisted) and removes     *
     * that risk entirely.                                                                                                                             *
     ***************************************************************************************************************************************************/
    function settingsContentKey(raw){
        return JSON.stringify(normalizeSettingsPayload(raw))
    }

    /** buildSettingsNoteBody ***********************************************************************************************************************
     * The exact bytes of the note body for this content, stamped with `updatedAt`. The sentence, a blank line, the fence, and nothing else.          *
     ***************************************************************************************************************************************************/
    function buildSettingsNoteBody(content, updatedAt){
        var normalized = normalizeSettingsPayload(content)
        var payload = {
            version: SETTINGS_NOTE_VERSION,
            updatedAt: String(updatedAt || ''),
            profiles: normalized.profiles,
            settings: normalized.settings,
        }
        return SETTINGS_NOTE_SENTENCE + '\n\n```json\n' + JSON.stringify(payload, null, 2) + '\n```\n'
    }

    /** parseSettingsNoteBody ***********************************************************************************************************************
     * The payload in a note body, or NULL when there is not one that can be soundly interpreted.                                                     *
     *                                                                                                                                                *
     * Null is the whole error channel: no fence, malformed JSON, a non-object, or a FUTURE `version`. A future version is refused rather than half-   *
     * read - a device running an older build must not apply a payload whose fields it cannot see, and must then not write its truncated understanding *
     * back over the note. A missing or older version reads as v1, which is all there has ever been. The caller logs once and keeps working from local *
     * state: a body it cannot read is never a reason to crash, to stop, or to destroy anything.                                                       *
     ***************************************************************************************************************************************************/
    function parseSettingsNoteBody(body){
        var match = JSON_FENCE.exec(String(body || ''))
        if (!match) return null
        var parsed = null
        try {
            parsed = JSON.parse(match[1])
        } catch (error) {
            return null
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        var version = typeof parsed.version === 'number' ? parsed.version : SETTINGS_NOTE_VERSION
        if (version > SETTINGS_NOTE_VERSION) return null
        var normalized = normalizeSettingsPayload(parsed)
        return {
            version: SETTINGS_NOTE_VERSION,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
            profiles: normalized.profiles,
            settings: normalized.settings,
        }
    }

    /** isFutureSettingsNote ************************************************************************************************************************
     * Whether an UNREADABLE body is unreadable because it was written by a NEWER Cockpit, rather than because it is damaged.                        *
     *                                                                                                                                                *
     * The two cases deserve opposite treatment and parseSettingsNoteBody deliberately answers null to both. A damaged body is this device's problem   *
     * and the next local change rewrites it wholesale. A FUTURE body is the other way round: it is perfectly good data whose fields this build cannot *
     * see, so writing over it would quietly delete whatever the newer build stores there, on every device. The runtime therefore refuses to write to  *
     * one at all (see refreshFromSettingsNote in settingsSync.ts).                                                                                     *
     ***************************************************************************************************************************************************/
    function isFutureSettingsNote(body){
        var match = JSON_FENCE.exec(String(body || ''))
        if (!match) return false
        var parsed = null
        try {
            parsed = JSON.parse(match[1])
        } catch (error) {
            return false
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
        return typeof parsed.version === 'number' && parsed.version > SETTINGS_NOTE_VERSION
    }

    /** parseSettingsNoteReference ******************************************************************************************************************
     * What the user put in the "Settings note" setting, read as either an ID or a TITLE.                                                             *
     *                                                                                                                                                *
     * Four spellings all name an id, because all four are things Joplin itself hands a user: the bare id (Note properties), ":/<id>" (the internal    *
     * link form), "[title](:/<id>)" (Copy Markdown link, which is what a right click offers) and the joplin://x-callback-url/openNote?id=<id> external *
     * link. Anything else non-empty is read as a TITLE, which is how a phone connects: there is no comfortable way to copy an id between devices, but  *
     * typing the note's name is easy, and the resolver then rewrites the field to the id it found (see settingsSync.ts).                               *
     *                                                                                                                                                *
     * Returns { kind: 'empty' | 'id' | 'title', id, title }. Never throws, and never guesses: a string that merely LOOKS id-ish (31 hex characters, a  *
     * typo in a pasted id) is a title, so it fails as "no note of that name" rather than as a silent point at nothing.                                 *
     ***************************************************************************************************************************************************/
    function parseSettingsNoteReference(value){
        var text = String(value === undefined || value === null ? '' : value).trim()
        if (!text) return { kind: 'empty', id: '', title: '' }
        // [title](:/<id>) - the Markdown link. The label is ignored: the id is the only part that addresses anything.
        var markdown = /^\[[^\]]*\]\(\s*:\/([0-9a-f]{32})\s*\)$/i.exec(text)
        if (markdown) return { kind: 'id', id: markdown[1].toLowerCase(), title: '' }
        // joplin://x-callback-url/openNote?id=<id>, with any further query parameters the app cares to add.
        var callback = /^joplin:\/\/x-callback-url\/openNote\?(?:[^#]*&)?id=([0-9a-f]{32})\b/i.exec(text)
        if (callback) return { kind: 'id', id: callback[1].toLowerCase(), title: '' }
        // :/<id> - the internal link form.
        var internal = /^:\/([0-9a-f]{32})$/i.exec(text)
        if (internal) return { kind: 'id', id: internal[1].toLowerCase(), title: '' }
        // The bare id.
        if (ID_PATTERN.test(text)) return { kind: 'id', id: text.toLowerCase(), title: '' }
        return { kind: 'title', id: '', title: text }
    }

    return {
        SETTINGS_NOTE_TITLE: SETTINGS_NOTE_TITLE,
        SETTINGS_NOTE_SENTENCE: SETTINGS_NOTE_SENTENCE,
        SETTINGS_NOTE_VERSION: SETTINGS_NOTE_VERSION,
        SYNCED_SETTING_KEYS: SYNCED_SETTING_KEYS,
        normalizeSettingsPayload: normalizeSettingsPayload,
        settingsContentKey: settingsContentKey,
        buildSettingsNoteBody: buildSettingsNoteBody,
        parseSettingsNoteBody: parseSettingsNoteBody,
        isFutureSettingsNote: isFutureSettingsNote,
        parseSettingsNoteReference: parseSettingsNoteReference,
    }
})
