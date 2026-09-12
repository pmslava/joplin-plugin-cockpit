/** README ******************************************************************************************************************************************
 * THE SETTINGS NOTE, RUNTIME HALF - when the note is written, and when what it says is applied.                                                    *
 *                                                                                                                                                  *
 * The note itself (its body, the payload shape, the content key) is src/core/settingsNote.js, which is pure and unit-tested on its own. This file   *
 * is everything that has to talk to Joplin, and it is deliberately small: four pieces of state and two operations.                                  *
 *                                                                                                                                                  *
 *   WRITE  - any local change to synced state (a profile saved, deleted or created, one of the synced settings edited) schedules a debounced write.  *
 *            The write is skipped when the content matches what this device last wrote or last applied.                                             *
 *   APPLY  - the startup read, a completed sync, a change to the note itself and the periodic backstop read the note. A payload whose content        *
 *            differs from that same remembered value is applied WHOLESALE: the profile store is replaced, the synced settings are written.           *
 *                                                                                                                                                  *
 * LOOP PREVENTION is that one remembered value, `lastContentKey` (see settingsContentKey). It is the canonical form of the SYNCED CONTENT - not of   *
 * the body - so the `updatedAt` stamp cannot make a device rewrite what it has just applied, which is the shape every ping-pong in a scheme like     *
 * this takes. It lives in memory only: a fresh session reads the note and applies it, which is correct (that is how a change made while this device  *
 * was closed arrives) and idempotent.                                                                                                               *
 *                                                                                                                                                  *
 * OFF BY DEFAULT, AND FREE WHEN OFF. With the "Settings note" setting empty there is no note id, so every entry point here returns before it reaches *
 * a single data call: startup, every refresh and every note change cost exactly what they cost before this feature existed.                          *
 *                                                                                                                                                  *
 * CONCURRENT EDITS ARE NOT MERGED. Whole-note last-writer-wins. Two devices changing settings at the same moment produce a Joplin conflict copy,     *
 * which the plugin ignores entirely: it always uses the note at the configured id, and the user resolves the conflict themselves. The ONE exception  *
 * is adoption - the first time this device connects to a note that already carries a payload, its own profiles are folded in by name, whichever      *
 * route the connection came in by (see mergeOnFirstConnection).                                                                                       *
 *                                                                                                                                                  *
 * A MANGLED NOTE NEVER STOPS ANYTHING. An unreadable body is logged once, the remembered key is cleared, and the plugin keeps running on local        *
 * state; the next local change rewrites the note wholesale. A note that cannot be read at all (a bad id, a note that has not synced to this device    *
 * yet) leaves this device UNINITIALIZED, which is what forbids it from writing over the note it has never seen.                                      *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { getProfileStoreSnapshot, normalizeProfileStore, replaceProfileStore, setProfileStoreListener } from "./database"
import { EXCLUDED_NOTEBOOKS_KEY, EXCLUDED_NOTEBOOK_IDS_KEY } from "./exclusion"
import { invalidateNotebookMap, invalidateResultCaches } from "./joplin"
import { getCurrentProfileID, settingsNoteIdSettingKey } from "./settings"
import { refreshInterfaces } from "./timer"
import { getEditorNoteID, onProfilesReplaced, showPanelToast, trackEditorNoteSelection } from "../ui/panel/panel"
// The pure note module: the body, the payload and the content key. The same UMD file the Node harness require()s, so the
// rules the tests pin are the rules that run here. Webpack bundles it in.
const { SETTINGS_NOTE_TITLE, SYNCED_SETTING_KEYS, buildSettingsNoteBody, isFutureSettingsNote, parseSettingsNoteBody, parseSettingsNoteReference,
    settingsContentKey } = require("./settingsNote")

/** Variable Setup *********************************************************************************************************************************/
/** A few seconds: long enough to coalesce a burst of profile edits or colour changes, short enough that the other device sees it on its next sync. */
const settingsNoteWriteDelayMs = 3000
/** The note changed under us (our own write, or one that arrived with a sync): wait a beat for the burst to settle, then read it once. */
const settingsNoteReadDelayMs = 1000

/** The note the settings travel in, as a resolved id, or "" when the feature is off. Mirrored here from the setting so that the hot paths - every
 * note change, every periodic tick - can answer "is this us?" without a settings round-trip. Kept in step by onSettingsNoteReferenceChanged. */
var noteId = ""
/** The canonical content this device last WROTE to, or APPLIED from, the note. `null` means "nothing is known" - the next write always writes and
 * the next read always applies, which is the correct state after a failed apply and after an unreadable body. */
var lastContentKey = null
/** Set once the note has actually been READ this session. Nothing is ever written before that. */
var initialized = false
/** A write is wanted. Survives every deferral, so the next drain point performs it. */
var writePending = false
var writeTimer = null
var readTimer = null
/** The note's `updated_time` as this device last saw it, so the periodic tick can tell "nothing moved" from one cheap field read. */
var lastUpdatedTime = null
var warnedUnparseable = false
var warnedWriteFailure = false
/** The note this device has just CREATED, with the content key of the seed written into it. See createSettingsNote. */
var seededNote = null
/** A TITLE the setting holds that named no note when it was last looked for. The toast tells the user to wait for the note to sync, so the
 * search is tried again every time a sync completes - which is exactly when a note that was missing can have arrived. */
var unresolvedTitle = ""
/** Whether the "that note is not a Cockpit settings note" notice has been given for the note currently pointed at. */
var warnedWrongNote = false
/** A notice raised before there was a panel to show it in, kept until there is. See announceNotice. */
var pendingNotice = ""
/** THE FIRST CONNECTION. Set when this device is pointed at a settings note it has not been reading, and consumed by the next successful read of
 * that note, which merges instead of replacing (see mergeOnFirstConnection). One flag for every route in - the command, a typed title, a pasted id
 * or link - so the paths cannot drift apart on what "connecting" means. */
var pendingAdoption = false

/** ONE SETTINGS-NOTE OPERATION AT A TIME.
 *
 * Reading and writing the note are both read-modify-write over `lastContentKey`, and both straddle real suspension points (a data.get, a data.put, a
 * whole refresh). Nothing upstream serializes them, and the overlap is the ordinary case rather than an exotic one: the startup read awaits a full
 * interface refresh, and a sync completing during it fires its own read straight into that. Both would read a null key, both would decide the note
 * says something new, and the payload would be applied twice - two profile-store replacements and two refreshes for one piece of news.
 *
 * `.then(fn, fn)`, not `.then(fn)`: a rejected predecessor must not SKIP the next operation, which would silently wedge the sync for the rest of the
 * session. The stored chain is kept un-rejected for the same reason. Nothing inside a flush or a refresh re-enters this gate, so it cannot deadlock
 * on itself - which is why the combined drains below call the *Locked halves directly rather than the public wrappers. */
var settingsNoteChain: Promise<any> = Promise.resolve()

function withSettingsNote(operation){
    var next = settingsNoteChain.then(operation, operation)
    settingsNoteChain = next.catch(() => undefined)
    return next
}

/** setupSettingsSync *******************************************************************************************************************************
 * Wires the feature up: the profile store tells this module when it changes, and the configured note reference is resolved once so that every hot    *
 * path afterwards can compare against a plain string. Runs after setupDatabase, before anything paints. With the setting empty it costs one settings *
 * read and nothing else - no data call, no setting write.                                                                                            *
 ***************************************************************************************************************************************************/
export async function setupSettingsSync(){
    setProfileStoreListener(scheduleSettingsNoteWrite)
    // THE EDITOR GATE NEEDS A STARTING VALUE. panel.ts learns which note is open from onNoteSelectionChange, and that event does not fire
    // for the note Joplin restored on launch - so a device that was closed ON the settings note would believe nothing is open and write
    // into the editor the user is looking at (which, on mobile, evicts it). One read at startup, guarded: the call is desktop-shaped and
    // an app that does not offer it must not stop the plugin from starting.
    try {
        trackEditorNoteSelection(await joplin.workspace.selectedNoteIds())
    } catch (error) {
        // No selected-note API here, or nothing selected. The gate then behaves as it did before: the first selection change fills it in.
    }
    try {
        noteId = await resolveSettingsNoteReference(true)
    } catch (error) {
        noteId = ""
        console.warn("Cockpit: could not read the settings note setting", error)
    }
}

/** isSettingsNoteConnected *************************************************************************************************************************
 * Whether a settings note is configured at all. Read by the two excluded-notebook reconcilers, which must not tidy away an exclusion id whose        *
 * notebook this device cannot see YET while a note is carrying that pair between devices (see resolveExcludedNotebooks in settings.ts).             *
 ***************************************************************************************************************************************************/
export function isSettingsNoteConnected(){
    return !!noteId
}

/** isSettingsNote **********************************************************************************************************************************
 * Whether a note id is the settings note. The one question the note-change lane asks on every event, so it reads the mirrored id and nothing else.  *
 ***************************************************************************************************************************************************/
export function isSettingsNote(id){
    return !!noteId && String(id || "") === noteId
}

/** scheduleSettingsNoteWrite ***********************************************************************************************************************
 * Schedule a debounced write. Called from the profile store listener and from the settings onChange handler, so no profile create/edit/delete and no *
 * synced setting can be forgotten. Over-triggering is free: the content-key comparison in the flush turns a write with nothing to say into a no-op   *
 * before any note is touched.                                                                                                                       *
 ***************************************************************************************************************************************************/
export function scheduleSettingsNoteWrite(){
    if (!noteId) return
    writePending = true
    if (writeTimer) return
    writeTimer = setTimeout(() => {
        writeTimer = null
        // The promise is RETURNED, not swallowed, so the write is awaitable from the test harness, exactly as the refresh
        // lanes in timer.ts return theirs. setTimeout ignores the return value.
        return flushSettingsNote("debounce")
    }, settingsNoteWriteDelayMs)
}

/** scheduleSettingsNoteRead ************************************************************************************************************************
 * The settings note itself changed (our own write coming back, or another device's arriving with a sync). Read it once the burst has settled. This   *
 * is deliberately NOT the reconcile lane: the note holds no to-dos, so nothing about it belongs in the panel's index-catch-up job.                   *
 ***************************************************************************************************************************************************/
export function scheduleSettingsNoteRead(){
    if (!noteId) return
    if (readTimer) return
    readTimer = setTimeout(() => {
        readTimer = null
        return drainSettingsNote("note-change", false)   // returned for the same reason as the write above
    }, settingsNoteReadDelayMs)
}

/** pollSettingsNote ********************************************************************************************************************************
 * The periodic backstop, and the one place a CHEAP CHANGE CHECK is worth making: a single `updated_time` field read tells whether the note has moved  *
 * at all, and the body is fetched only when it has. A tick with nothing to do therefore costs one field of one note - and, with the feature off,     *
 * nothing whatsoever. Any write this device still owes is drained first, so a change deferred by the editor gate is never left waiting for the user.  *
 ***************************************************************************************************************************************************/
export function pollSettingsNote(reason){
    if (!noteId) return Promise.resolve()
    return drainSettingsNote(reason, true)
}

/** syncSettingsNote ********************************************************************************************************************************
 * The unconditional drain: flush what we owe, then read. Used where something is known to have happened (a completed sync, a change to the note).    *
 ***************************************************************************************************************************************************/
export function syncSettingsNote(reason){
    // A TITLE THAT NAMED NOTHING IS TRIED AGAIN HERE. "Wait for the note to sync to this device" is what the toast tells the user, and a
    // completed sync is precisely when that can have happened - so the promise the message makes is kept rather than left to the user to
    // re-save the setting. Silent: the notice has already been given once, and repeating it every sync would be nagging.
    if (!noteId) return unresolvedTitle ? onSettingsNoteReferenceChanged(false) : Promise.resolve()
    return drainSettingsNote(reason, false)
}

/** drainDeferredSettingsNoteWrite ******************************************************************************************************************
 * The editor gate's own drain point: the note the editor is showing has changed, so a write deferred because the settings note was open can go now.  *
 * Costs nothing at all when there is no write owed, which is every selection change but the rare one after an edit.                                  *
 ***************************************************************************************************************************************************/
export function drainDeferredSettingsNoteWrite(){
    if (!noteId || !writePending) return Promise.resolve()
    return flushSettingsNote("editor-moved")
}

/** drainSettingsNote *******************************************************************************************************************************
 * Flush then read, as ONE serialized operation, in that order: never apply a remote body over local changes this device has not published yet.       *
 ***************************************************************************************************************************************************/
function drainSettingsNote(reason, cheapCheck){
    return withSettingsNote(async () => {
        await flushSettingsNoteLocked(reason)
        if (!noteId) return
        if (cheapCheck && !(await settingsNoteMoved())) return
        await refreshFromSettingsNoteLocked(reason)
    })
}

/** settingsNoteMoved *******************************************************************************************************************************
 * Whether the note's `updated_time` has moved since this device last saw it. Unknown (no stamp yet, or an unreadable note) counts as moved, so the   *
 * caller falls through to the ordinary read and its own error handling rather than deciding anything from a failure here.                            *
 ***************************************************************************************************************************************************/
async function settingsNoteMoved(){
    // AN UNINITIALIZED DEVICE HAS NO BUSINESS TRUSTING A STAMP. `lastUpdatedTime` is recorded by the read, but the apply that followed it can have
    // been refused half way through - and that clears `initialized` while leaving the stamp behind. The tick would then answer "nothing moved" to
    // the end of time, so the device sits out of step, its own edit unpublished, until a sync happens to complete; and the wholesale apply that
    // finally arrives throws that edit away. While the gate is shut the body is fetched again, whatever the stamp says.
    if (!initialized) return true
    if (lastUpdatedTime === null) return true
    try {
        var head: any = await joplin.data.get(['notes', noteId], { fields: ['updated_time'] })
        var stamp = head && head.updated_time
        return !stamp || stamp !== lastUpdatedTime
    } catch (error) {
        return true
    }
}

/** markFirstConnection *****************************************************************************************************************************
 * Arm the one-time merge for the note this device is pointed at, ON THE CHAIN so it cannot be set while a read is already deciding. Used by the      *
 * command for the case the repoint cannot cover: the field already names the note, so writing the same value changes nothing, but this device has    *
 * never managed to read it - which is a first connection like any other.                                                                             *
 ***************************************************************************************************************************************************/
function markFirstConnection(){
    return withSettingsNote(async () => { pendingAdoption = true })
}

/** rememberNotice / announceNotice / flushPendingNotice ********************************************************************************************
 * Tell the user something short, wherever in the startup order we happen to be.                                                                      *
 *                                                                                                                                                    *
 * setupSettingsSync runs beside the profile store it syncs, which is well before setupPanel - so a notice raised while resolving the setting at       *
 * startup (a title that names no note yet, the commonest way a phone connects) had nowhere to go and was lost, leaving only a console line the user   *
 * will never read. The automatic retries are deliberately silent, so that was the ONLY chance to say it. The notice is therefore kept until there is  *
 * a panel, and the startup read - which runs after setupPanel - flushes it. Exactly one notice is ever pending: a second overwrites the first, which  *
 * is right, because the later one describes the state the device is actually in.                                                                     *
 *                                                                                                                                                    *
 * rememberNotice is the delivery half on its own, for the things that are not complaints: setting the note up from the Settings field can happen at   *
 * startup too, and "Cockpit: settings note created" deserves to survive that just as much as a warning does.                                          *
 ***************************************************************************************************************************************************/
function rememberNotice(toast){
    pendingNotice = toast
    flushPendingNotice()
}

function announceNotice(toast, logLine?){
    console.warn(logLine || toast)
    rememberNotice(toast)
}

function flushPendingNotice(){
    if (!pendingNotice) return
    if (!showPanelToast(pendingNotice)) return
    pendingNotice = ""
}

/** flushSettingsNote *******************************************************************************************************************************
 * Write the note, if there is anything to say and it is safe to say it now.                                                                          *
 *                                                                                                                                                    *
 * THREE GATES, and each DEFERS rather than cancels - `writePending` stays set, so the next drain point (a completed sync, a selection change, the     *
 * periodic tick) retries:                                                                                                                            *
 *                                                                                                                                                    *
 *   1. THE NOTE MUST HAVE BEEN READ FIRST. A device that has never successfully read the note does not know what is in it, and writing its own state  *
 *      over an unread note is how a machine that has just installed Cockpit wipes every other device's profiles.                                      *
 *   2. NO WRITE WHILE THE SETTINGS NOTE IS THE NOTE OPEN IN THE EDITOR. A plugin PUT evicts the mobile editor mid-edit, and there is no reason to do   *
 *      that to a user who has opened the note to look at it. The drain points are the selection change away from it, the tick and a completed sync.    *
 *   3. NOTHING TO SAY. The content key equals what this device last wrote or applied, so the note already holds it: the pending write is cleared       *
 *      without touching a note at all. This is the gate that makes over-triggering the schedule free.                                                 *
 ***************************************************************************************************************************************************/
export function flushSettingsNote(reason){
    return withSettingsNote(() => flushSettingsNoteLocked(reason))
}

async function flushSettingsNoteLocked(reason){
    if (!writePending) return
    var targetId = noteId
    if (!targetId){
        clearWrite()
        return
    }
    if (!initialized) return
    if (getEditorNoteID() === targetId) return

    var content = null
    try {
        content = await collectSettingsContent()
    } catch (error) {
        console.warn(`Cockpit: the settings note (${reason}) could not read this device's own state`, error)
        return
    }
    var key = settingsContentKey(content)
    if (key === lastContentKey){
        clearWrite()
        return
    }
    // The note id is re-read immediately before the write rather than trusted from the top of this function: everything above is
    // awaited, and a repoint landing in any of it would send this device's state to whatever note the user has just pointed at.
    if (noteId !== targetId) return
    try {
        await joplin.data.put(['notes', targetId], null, { body: buildSettingsNoteBody(content, new Date().toISOString()) })
    } catch (error) {
        // Not synced yet, deleted, or a bad id. Keep the write pending and try again at the next drain point; say so once.
        if (!warnedWriteFailure){
            warnedWriteFailure = true
            console.warn(`Cockpit: the settings note (${reason}) could not be written to note ${targetId}`, error)
        }
        return
    }
    lastContentKey = key
    warnedWriteFailure = false
    clearWrite()
    try {
        var after: any = await joplin.data.get(['notes', targetId], { fields: ['updated_time'] })
        lastUpdatedTime = (after && after.updated_time) || lastUpdatedTime
    } catch (error) {
        // Best effort: an unknown stamp only costs the next tick a body read.
    }
    console.info(`Cockpit: the settings note (${reason}) was updated with ${content.profiles.profiles.length} profile(s)`)
}

/** clearWrite **************************************************************************************************************************************
 * Drops the pending write AND the debounce timer behind it. The timer goes too so that a write settled early at a drain point cannot leave a timer   *
 * armed that the next local change would then hide behind - the schedule only arms one, and it must belong to the change that is actually waiting.   *
 ***************************************************************************************************************************************************/
function clearWrite(){
    writePending = false
    if (writeTimer){
        clearTimeout(writeTimer)
        writeTimer = null
    }
}

/** collectSettingsContent **************************************************************************************************************************
 * Everything that syncs, as this device currently holds it: the whole profile store (a normalized deep copy) and the synced settings.               *
 ***************************************************************************************************************************************************/
async function collectSettingsContent(){
    var settings = {}
    for (var key of SYNCED_SETTING_KEYS){
        var value = await joplin.settings.value(key)
        settings[key] = value === undefined || value === null ? "" : String(value)
    }
    return { profiles: getProfileStoreSnapshot(), settings: settings }
}

/** refreshFromSettingsNote *************************************************************************************************************************
 * Read the note and, if it says something new, apply it wholesale.                                                                                  *
 *                                                                                                                                                    *
 * The remembered content key is set BEFORE the apply, deliberately: applying writes settings and replaces the profile store, each of which schedules *
 * a write, and those writes must already see themselves as redundant. If the apply then throws, the key is cleared again so the next read retries    *
 * rather than this device silently believing it is in sync.                                                                                          *
 ***************************************************************************************************************************************************/
export function refreshFromSettingsNote(reason){
    return withSettingsNote(() => refreshFromSettingsNoteLocked(reason))
}

async function refreshFromSettingsNoteLocked(reason){
    // The first thing that runs after the panel exists (index.ts calls this before the first paint), so it is where a notice raised during setup
    // finally reaches the user.
    flushPendingNotice()
    if (!noteId){
        // Nothing to read; writes are irrelevant while the feature is off, and the gate above must not hold a write that can never happen.
        initialized = true
        return
    }
    var body = ""
    var title = ""
    try {
        // The TITLE travels with the body because it is the only way to tell a settings note whose payload is damaged from a note that was
        // never a settings note at all - see the wrong-note branch below.
        var note: any = await joplin.data.get(['notes', noteId], { fields: ['body', 'title', 'updated_time'] })
        body = (note && note.body) || ""
        title = String((note && note.title) || "")
        lastUpdatedTime = (note && note.updated_time) || null
    } catch (error) {
        // The note is not readable yet (not synced to this device, or a stale id). Nothing to apply, and - because `initialized`
        // stays false - nothing may be written over it either.
        return
    }
    initialized = true

    var payload = parseSettingsNoteBody(body)
    if (!payload){
        lastContentKey = null
        if (isFutureSettingsNote(body)){
            // A payload from a NEWER Cockpit. It is not damaged - it is data this build cannot see all of - so it is left strictly alone:
            // `initialized` goes back off, which is the gate that forbids this device from writing, and a wholesale write is exactly what
            // would delete the newer build's fields from every device that shares this note. Upgrading this device is the only way out.
            initialized = false
            if (!warnedUnparseable){
                warnedUnparseable = true
                console.warn(`Cockpit: the settings note ${noteId} was written by a newer version of Cockpit; this device will neither ` +
                    "apply nor overwrite it. Update Cockpit here to sync with it again.")
            }
            return
        }
        if (!String(body).trim()){
            // AN EMPTY NOTE, read perfectly well: this is the user who made the note by hand on a second device and connected it by
            // title. There is nothing to apply and nothing to refuse - so seed it with this device's state instead of leaving the
            // pair of devices pointed at a blank mailbox forever.
            console.info("Cockpit: the settings note is empty - writing this device's profiles and settings into it.")
            scheduleSettingsNoteWrite()
            return
        }
        if (title.trim() !== SETTINGS_NOTE_TITLE){
            // NOT A SETTINGS NOTE AT ALL. A body full of prose and a title that is not ours is a note the user pointed the setting at by
            // mistake (a pasted id from the wrong note, a title typed that matched something else). Reading it is harmless; believing it
            // is not - `initialized` true here would let the next profile edit PUT Cockpit's payload over "Dear diary", destroying it.
            // So the gate stays shut, which is the same treatment an unreadable note gets, and the user is told what to fix.
            initialized = false
            if (!warnedWrongNote){
                warnedWrongNote = true
                announceNotice("Cockpit: that note is not a Cockpit settings note",
                    `Cockpit: note ${noteId} is not a Cockpit settings note - point the Settings note setting at the right note, or run ` +
                    "Tools > Cockpit > Connect settings note to make one.")
            }
            return
        }
        // A note carrying OUR title whose payload is damaged (a hand edit, a truncated sync) is still our mailbox: `initialized` stays
        // true, so the next local change rewrites it wholesale, which is the repair.
        if (!warnedUnparseable){
            warnedUnparseable = true
            console.warn(`Cockpit: the settings note ${noteId} could not be read as Cockpit settings; working from this device's own ` +
                "profiles and settings until it is rewritten.")
        }
        return
    }
    warnedUnparseable = false
    warnedWrongNote = false

    // THE KEY IS COMPUTED ON THE STORE AS THIS DEVICE WILL HOLD IT, not on the raw payload.
    //
    // normalizeProfileStore is what a profile becomes here: unknown fields are dropped and missing ones are filled with this build's
    // defaults. The WRITE side reads the store back through that same normalisation, so a key taken from the raw payload disagrees with
    // the very next flush the apply schedules, and the two devices rewrite the note at each other forever. It costs nothing when both
    // devices run the same build (the payload is already in that form) and it is the whole of the fix when they do not: a profile field
    // a newer Cockpit added, or one an older payload never carried, no longer makes the pair cycle.
    var applied = null
    try {
        applied = { profiles: normalizeProfileStore(payload.profiles), settings: payload.settings }
    } catch (error) {
        console.warn(`Cockpit: the settings note (${reason}) carries profiles this build cannot read`, error)
        return
    }

    // THE FIRST CONNECTION MERGES; every read after it replaces. This is the one place it happens, so the command, a typed title and a pasted
    // id all behave identically - see mergeOnFirstConnection.
    if (pendingAdoption){
        pendingAdoption = false
        applied = await mergeOnFirstConnection(applied, reason)
        if (!applied) return
    }

    var key = settingsContentKey(applied)
    if (key === lastContentKey) return      // our own write, or something already applied
    lastContentKey = key
    try {
        await applySettingsPayload(applied, reason)
    } catch (error) {
        // The apply is incomplete - a setting write may have landed and the store listener has already armed a write - so this device
        // must neither believe it is in sync NOR be allowed to publish the half-applied state it is now holding. The next successful
        // read re-opens the gate.
        lastContentKey = null
        initialized = false
        console.warn(`Cockpit: the settings note (${reason}) could not be applied`, error)
    }
}

/** mergeOnFirstConnection **************************************************************************************************************************
 * THE ONE-TIME MERGE, for every way a device can connect to a settings note that already exists.                                                    *
 *                                                                                                                                                    *
 * Ongoing sync is wholesale by design - a profile deleted on another device has to be able to disappear here - but the FIRST connection is the one    *
 * moment where both sides hold profiles that were built independently and neither side's absence is a deletion. A local profile whose NAME the note   *
 * does not carry is appended with a fresh id (names are compared trimmed and case-sensitively: two profiles called "Work" are the same intent, "work" *
 * and "Work" are two deliberate names), and a synced setting the payload leaves out keeps this device's value.                                        *
 *                                                                                                                                                    *
 * It lives HERE, in the read, rather than in the command that used to own it, because there are four ways to connect - the command, typing the note's *
 * title, pasting its id, pasting a link - and they were drifting: only the command merged, so a user who set the second device up the way the         *
 * Settings field tells them to silently lost that device's own profiles. One rule, one place.                                                         *
 *                                                                                                                                                    *
 * The merged store is WRITTEN BACK before it is applied, and only when something was actually appended: this device must not start treating the note  *
 * as the truth while holding profiles the note has never heard of. A write-back that fails aborts the whole connection - nothing is applied, the       *
 * write gate is shut again and the merge is re-armed - because the alternatives are both destructive: applying the merge would leave the other        *
 * devices permanently behind, and applying the note alone would throw this device's profiles away.                                                    *
 *                                                                                                                                                    *
 * Returns the content to apply, or null when the caller must stop.                                                                                    *
 ***************************************************************************************************************************************************/
async function mergeOnFirstConnection(applied, reason){
    var local = null
    try {
        local = await collectSettingsContent()
    } catch (error) {
        // This device cannot state its own side, so it cannot know what the merge would add. Stop rather than guess in either direction.
        pendingAdoption = true
        initialized = false
        console.warn(`Cockpit: the settings note (${reason}) could not read this device's own state to connect with`, error)
        return null
    }
    var merged = {
        profiles: normalizeProfileStore(mergeProfileStores(applied.profiles, local.profiles)),
        settings: Object.assign({}, local.settings, applied.settings),
    }
    // Nothing of this device's was missing from the note: the connection is a plain read, and the note is not given a revision for nothing.
    if (settingsContentKey(merged) === settingsContentKey(applied)) return applied
    try {
        await joplin.data.put(['notes', noteId], null, { body: buildSettingsNoteBody(merged, new Date().toISOString()) })
    } catch (error) {
        pendingAdoption = true
        initialized = false
        console.warn(`Cockpit: the settings note (${reason}) could not be given this device's own profiles`, error)
        return null
    }
    try {
        var after: any = await joplin.data.get(['notes', noteId], { fields: ['updated_time'] })
        lastUpdatedTime = (after && after.updated_time) || lastUpdatedTime
    } catch (error) {
        // Best effort: an unknown stamp only costs the next tick a body read.
    }
    console.info(`Cockpit: connected to the settings note ${noteId} and folded this device's own profiles in - ` +
        `${merged.profiles.profiles.length} profile(s) in all`)
    return merged
}

/** applySettingsPayload ****************************************************************************************************************************
 * Replace this device's synced state with the note's. WHOLESALE, with no per-profile merging: the store the note carries becomes the store, so a     *
 * profile deleted on the other device is deleted here too.                                                                                          *
 *                                                                                                                                                    *
 * The settings are written ONLY where the value actually differs, so an apply that changes two colours does not fire the settings onChange handler    *
 * (and its refresh, and its excluded-notebook resolver) eleven times. The excluded-notebook pair is still written IDS FIRST, because a resolver that  *
 * does run between the two writes should see the ids already in place - but that ORDER IS NOT THE PROTECTION, and must not be mistaken for it: the    *
 * app batches a settings save and fires onChange ONCE, after both values have landed, so the resolver never sees the half-written pair anyway. What   *
 * protects the pair is resolveExcludedNotebooks itself, which keeps an exclusion id whose notebook this device cannot see while a settings note is    *
 * connected (see settings.ts); without that, a notebook that has not synced here yet is read as deleted and the truncated pair is published back.     *
 ***************************************************************************************************************************************************/
async function applySettingsPayload(payload, reason){
    await replaceProfileStore(payload.profiles)

    var exclusionChanged = false
    var written = 0
    for (var key of applyOrderedKeys()){
        if (!Object.prototype.hasOwnProperty.call(payload.settings, key)) continue    // a key the payload leaves out keeps its local value
        var incoming = payload.settings[key]
        var current = await joplin.settings.value(key)
        if (String(current === undefined || current === null ? "" : current) === incoming) continue
        if (key === EXCLUDED_NOTEBOOKS_KEY || key === EXCLUDED_NOTEBOOK_IDS_KEY) exclusionChanged = true
        await joplin.settings.setValue(key, incoming)
        written++
    }

    // The profile this device had selected may not exist in the incoming store; getCurrentProfileID falls back to the first profile and
    // records that choice. The selected profile is per device by design, so this is the only thing said about it here.
    await getCurrentProfileID()
    if (exclusionChanged){
        // Every cached result set was computed under a different exclusion, and the notebook map feeds the filter and the picker.
        invalidateResultCaches()
        invalidateNotebookMap()
    }
    await onProfilesReplaced()
    await refreshInterfaces()
    console.info(`Cockpit: the settings note (${reason}) replaced the profiles with ${payload.profiles.profiles.length} profile(s) ` +
        `and wrote ${written} setting(s)`)
}

/** applyOrderedKeys ********************************************************************************************************************************
 * The synced keys in the order an apply writes them: the excluded-notebook IDS first, everything else after. Stated here rather than left to the     *
 * alphabetical accident that currently puts them in that order anyway - the ordering is a rule, not a coincidence (see applySettingsPayload).        *
 ***************************************************************************************************************************************************/
function applyOrderedKeys(){
    var first = SYNCED_SETTING_KEYS.filter(key => key === EXCLUDED_NOTEBOOK_IDS_KEY)
    return first.concat(SYNCED_SETTING_KEYS.filter(key => key !== EXCLUDED_NOTEBOOK_IDS_KEY))
}

/** onSettingsNoteReferenceChanged ******************************************************************************************************************
 * The user edited the "Settings note" setting. Resolve what they typed (see resolveSettingsNoteReference), and when that names a DIFFERENT note than *
 * the one this device was using, forget everything believed about the old one and read the new one at once rather than at the next tick.             *
 *                                                                                                                                                    *
 * Emptying the field turns the feature off outright: no reads, no writes, and any write still owed is dropped - it was owed to a note the user has    *
 * just disconnected from.                                                                                                                            *
 ***************************************************************************************************************************************************/
export async function onSettingsNoteReferenceChanged(announce?){
    var resolved = ""
    try {
        resolved = await resolveSettingsNoteReference(announce !== false)
    } catch (error) {
        console.warn("Cockpit: could not resolve the settings note setting", error)
        return
    }
    if (resolved === noteId) return
    noteId = resolved
    await withSettingsNote(async () => {
        lastUpdatedTime = null
        warnedUnparseable = false
        warnedWriteFailure = false
        warnedWrongNote = false
        clearWrite()
        if (seededNote && seededNote.id === resolved){
            // The note this device has just CREATED and seeded. Its content is this device's own handwriting, so the read below must
            // recognise it rather than apply it back as though a second device had sent it - an apply is wholesale, and anything the
            // user changed between the POST and this read would be taken as absent from the incoming state and thrown away. Nothing to
            // merge either: the note holds exactly this device's state already.
            lastContentKey = seededNote.key
            initialized = true
            pendingAdoption = false
        } else {
            lastContentKey = null
            initialized = false
            // A REPOINT IS A FIRST CONNECTION, whatever the user typed to cause it - a title, a bare id, a Markdown link, a joplin:// URL.
            // The read it starts therefore folds this device's own profiles into the note instead of replacing them (mergeOnFirstConnection).
            // Repointing at a DIFFERENT note later is a first connection to that note, and merges again.
            pendingAdoption = !!resolved
        }
        seededNote = null
    })
    // AWAITED, not fired off: a repoint is a user action whose whole point is that the new note takes effect now, and awaiting it makes the
    // settings change settle before the handler returns - so the command that repoints (createSettingsNote) and a user pasting an id both see a
    // finished mailbox rather than one still in flight. Nothing here re-enters this handler: an apply writes synced settings, never the reference.
    if (noteId) await refreshFromSettingsNote("reference")
}

/** resolveSettingsNoteReference ********************************************************************************************************************
 * What the setting names, as a note id, or "" for "nothing usable". THIS IS THE WHOLE SETUP UI.                                                     *
 *                                                                                                                                                    *
 * 2.6.0 shipped a Tools menu item to create the note and a Settings field to point at one; the owner's first live round removed the menu item, and    *
 * rightly - creating the note is a one-time action, and a user who is configuring a plugin is already in Settings. So the field does all of it:       *
 *                                                                                                                                                    *
 *   AN ID, in any of its four spellings, is canonicalised to the bare id - what the rest of the plugin uses.                                          *
 *   THE CANONICAL TITLE with no note behind it yet is a request to SET THE FEATURE UP: the note is created here, exactly as the command creates it     *
 *     (same placement, same seed, same token), and the field is rewritten to its id. That makes the first device's whole setup "type the title".      *
 *   ANY TITLE with exactly one note behind it is that note - which is the second device, where the note has already synced in.                        *
 *   ANY OTHER TITLE that matches nothing is left exactly as typed (a user who mistyped can see what they typed), with a notice and a silent retry at   *
 *     the next completed sync. Creating for an arbitrary title would make a typo into a second mailbox, which is the one outcome worth refusing.      *
 *   SEVERAL matches are refused too: guessing which mailbox a user meant is not a thing a plugin should do.                                            *
 *                                                                                                                                                    *
 * Both writes are guarded by a value comparison, the same loop pattern resolveExcludedNotebooks uses: the setValue re-enters this handler, and on that *
 * pass the field already holds the id, so nothing is written and the recursion stops.                                                                 *
 ***************************************************************************************************************************************************/
async function resolveSettingsNoteReference(announce){
    var raw = String(await joplin.settings.value(settingsNoteIdSettingKey) || "")
    var reference = parseSettingsNoteReference(raw)
    if (reference.kind === "empty"){
        unresolvedTitle = ""
        return ""
    }
    if (reference.kind === "id"){
        unresolvedTitle = ""
        if (raw !== reference.id) await joplin.settings.setValue(settingsNoteIdSettingKey, reference.id)
        return reference.id
    }
    var matches = await findNotesTitled(reference.title)
    if (matches.length === 1){
        unresolvedTitle = ""
        await joplin.settings.setValue(settingsNoteIdSettingKey, String(matches[0].id))
        return String(matches[0].id)
    }
    if (!matches.length && isCanonicalSettingsNoteTitle(reference.title)){
        // THE SETUP GESTURE. The user typed the name of the thing they want and there is no such note, so make it - the same
        // createSettingsNote the command runs, which also writes the field, so the id is what this returns. A creation that fails
        // has already said so; the title is remembered and the next completed sync tries again.
        var createdId = await createSettingsNote()
        if (createdId){
            unresolvedTitle = ""
            return createdId
        }
        unresolvedTitle = reference.title
        return ""
    }
    // Remembered so that a completed sync tries again (see syncSettingsNote). Several matches are remembered too: the user is told to paste
    // an id, but the ambiguity can equally be resolved by them deleting the spare note, and a retry then costs one search.
    unresolvedTitle = reference.title
    var complaint = matches.length
        ? `Cockpit: several notes are titled "${reference.title}" - paste the right note's id into the Settings note setting.`
        : `Cockpit: no note titled "${reference.title}" was found - check the title, or wait for the note to sync to this device.`
    // Announced when the user has just asked for this (a setting they edited, a startup); silent on the automatic retries, which would
    // otherwise repeat the same toast after every sync. A notice raised at startup is kept until there is a panel to show it in.
    if (announce) announceNotice(complaint)
    return ""
}

/** isCanonicalSettingsNoteTitle ********************************************************************************************************************
 * Whether what the user typed is the settings note's own name. Trimmed and case-insensitive, because this is a name a person types from memory on a  *
 * phone keyboard, not an identifier - and it is the one string that turns "no such note" into "make one".                                            *
 ***************************************************************************************************************************************************/
function isCanonicalSettingsNoteTitle(title){
    return String(title || "").trim().toLowerCase() === String(SETTINGS_NOTE_TITLE).toLowerCase()
}

/** findNotesTitled *********************************************************************************************************************************
 * The non-trashed notes whose title is EXACTLY this, case-insensitively.                                                                            *
 *                                                                                                                                                    *
 * Joplin's `title:` search token is a token match, not an equality test: it answers "Joplin Cockpit Plugin Settings Backup" to a search for the plain *
 * title. So the query is only the cheap way to narrow the vault, and the exactness is decided here, on the titles that come back. `deleted_time` is    *
 * checked where the API returns it (builds with a trash); where it does not, the field is simply absent and every result counts.                       *
 ***************************************************************************************************************************************************/
async function findNotesTitled(title){
    var wanted = String(title || "").trim().toLowerCase()
    if (!wanted) return []
    var found = []
    try {
        // PAGED, not capped. The token match means the result set is "every note whose title contains these words", which in a big vault
        // can be far more than one page - and the note we want could be on any of them. A fixed limit would silently answer "no such note"
        // to a user whose settings note happens to sort late. The page walk stops on has_more, and at a generous ceiling so a server that
        // always answers has_more cannot spin here forever.
        for (var page = 1; page <= 50; page++){
            var result: any = await joplin.data.get(['search'], {
                query: `title:"${wanted.replace(/"/g, " ")}"`,
                fields: ['id', 'title', 'deleted_time'],
                page: page,
            })
            for (var item of (result && result.items) || []){
                if (item.deleted_time) continue
                if (String(item.title || "").trim().toLowerCase() !== wanted) continue
                found.push(item)
            }
            if (!result || !result.has_more) break
        }
    } catch (error) {
        console.warn("Cockpit: could not search for the settings note", error)
    }
    return found
}

/** connectSettingsNote *****************************************************************************************************************************
 * The "Cockpit: Connect settings note" command. The SETTINGS FIELD is the setup UI (see resolveSettingsNoteReference); this stays registered for the *
 * command palette, and for another plugin or a script that wants the same three steps in one call, but it has no menu item any more.                 *
 *                                                                                                                                                    *
 *   (a) ALREADY CONNECTED, and the note reads: nothing to decide. Read it, apply whatever it says, and say so.                                        *
 *   (b) A NOTE ALREADY EXISTS with the exact title - the ordinary second-device case, where the first device made one and it has synced here. Exactly  *
 *       one match is ADOPTED; several are refused, because guessing which mailbox a user meant is not a thing a plugin should do.                      *
 *   (c) NOTHING EXISTS: create the note, seeded with this device's own state, so turning the feature on never starts from empty.                       *
 *                                                                                                                                                    *
 * Every failure is a console line and a panel toast, never a message box: showMessageBox is a blocking native modal on desktop and renders behind the  *
 * panel overlay on mobile (see copyToClipboard in panel.ts).                                                                                          *
 ***************************************************************************************************************************************************/
export async function connectSettingsNote(){
    try {
        await connectSettingsNoteLocked()
    } catch (error) {
        console.warn("Cockpit: could not connect the settings note", error)
        showPanelToast("Cockpit: could not connect the settings note.")
    }
}

async function connectSettingsNoteLocked(){
    if (noteId){
        var readable = false
        try {
            await joplin.data.get(['notes', noteId], { fields: ['id'] })
            readable = true
        } catch (error) {
            // A stale id: the note was deleted, or this device has never received it. Fall through and look for one by title.
        }
        if (readable){
            await connectToNote(noteId)
            return
        }
    }
    var matches = await findNotesTitled(SETTINGS_NOTE_TITLE)
    if (matches.length > 1){
        announceNotice(`Cockpit: several notes are titled "${SETTINGS_NOTE_TITLE}" - paste the right note's id into the Settings note setting.`)
        return
    }
    if (matches.length === 1){
        await connectToNote(String(matches[0].id))
        return
    }
    await createSettingsNote()
}

/** connectToNote ***********************************************************************************************************************************
 * Point this device at an existing settings note, by the ordinary route: write the id into the setting and let the repoint read it - which is where  *
 * the one-time merge lives (mergeOnFirstConnection), so the command gets exactly what typing the title into the Settings field gets.                 *
 *                                                                                                                                                    *
 * When the field ALREADY names that note, writing the same value changes nothing and no repoint follows, so the merge is armed by hand here. That     *
 * case is real: a device whose note had not synced yet read nothing at startup, and running the command is how the user asks it to try again.         *
 ***************************************************************************************************************************************************/
async function connectToNote(targetId){
    if (targetId === noteId){
        if (!initialized) await markFirstConnection()
        await refreshFromSettingsNote("connect")
    } else {
        await joplin.settings.setValue(settingsNoteIdSettingKey, targetId)
    }
    console.info(`Cockpit: the settings note is note ${targetId}`)
    showPanelToast("Cockpit: settings note connected")
}

/** mergeProfileStores ******************************************************************************************************************************
 * The adopted store, plus every local profile whose name it does not already carry, each given a fresh id from the adopted store's own counter.     *
 ***************************************************************************************************************************************************/
function mergeProfileStores(rawAdopted, local){
    // NORMALIZED FIRST, for the same reason the read side normalizes before taking a content key: a payload whose nextID is missing (or
    // behind its own profiles) would otherwise hand out ids this store already uses - the reviewer's [1, 2, 1]. normalizeProfileStore is
    // the one place that knows what a profile is made of, and it settles the counter as well as the fields.
    var adopted = normalizeProfileStore(rawAdopted)
    var merged = { nextID: adopted.nextID, profiles: adopted.profiles.slice() }
    var names = new Set(adopted.profiles.map(profile => String(profile.name || "").trim()))
    for (var profile of local.profiles){
        var name = String(profile.name || "").trim()
        if (names.has(name)) continue
        names.add(name)
        merged.profiles.push(Object.assign({}, profile, { id: merged.nextID++ }))
    }
    return merged
}

/** createSettingsNote ******************************************************************************************************************************
 * Create the note, seeded from this device's current state, and point the setting at it. Returns the new note's id, or "" when the app would not     *
 * make one - the ONE piece of creation code there is, shared by the Settings field's setup gesture and by the command.                               *
 *                                                                                                                                                    *
 * THE SEED'S CONTENT KEY IS REMEMBERED BEFORE the setting is written and CONSUMED ON THE CHAIN by the repoint that write causes (see                  *
 * onSettingsNoteReferenceChanged). Without it this device reads its OWN freshly written seed as though a second device had sent it - and an apply is  *
 * wholesale, so anything the user changed between the POST and that read is taken as absent from the incoming state and thrown away. Recording it     *
 * before the write rather than after is what makes the order the host delivers the settings change in irrelevant: Joplin's onChange is not            *
 * synchronous with setValue in the app, and it is in the test harness, and the token is correct either way.                                           *
 ***************************************************************************************************************************************************/
async function createSettingsNote(){
    var parentId = await pickFolderForSettingsNote()
    var content = await collectSettingsContent()
    var created: any = await joplin.data.post(['notes'], null, {
        title: SETTINGS_NOTE_TITLE,
        body: buildSettingsNoteBody(content, new Date().toISOString()),
        parent_id: parentId,
    })
    var createdId = String((created && created.id) || "")
    if (!createdId){
        announceNotice("Cockpit: the settings note could not be created.",
            "Cockpit: the settings note was created but the app returned no id for it")
        return ""
    }
    seededNote = { id: createdId, key: settingsContentKey(content) }
    await joplin.settings.setValue(settingsNoteIdSettingKey, createdId)
    // THE LAST WORD, ON THE CHAIN: queueing behind the read the repoint started makes this command's return mean "this device's mailbox
    // is settled". When the host has not delivered the settings change yet, the token above is still waiting for it and nothing is done
    // here - the repoint will do it.
    await withSettingsNote(async () => {
        if (noteId !== createdId) return
        initialized = true
        warnedUnparseable = false
    })
    console.info(`Cockpit: created the settings note ${createdId}`)
    // Through the pending-notice path, not straight at the panel: the Settings field can trigger this at startup (a field still holding
    // the title because a previous attempt failed), and that is before there is a panel to toast into.
    rememberNotice("Cockpit: settings note created")
    return createdId
}

/** pickFolderForSettingsNote ***********************************************************************************************************************
 * Where a newly created settings note goes: the notebook the user is looking at, else the first notebook there is, else a new one called "Cockpit".  *
 * Every step is guarded - workspace.selectedFolder is desktop-shaped and can be absent or throw on mobile - so the fallback chain always produces a  *
 * parent rather than failing the command.                                                                                                            *
 ***************************************************************************************************************************************************/
async function pickFolderForSettingsNote(){
    try {
        var selected: any = await joplin.workspace.selectedFolder()
        if (selected && selected.id) return String(selected.id)
    } catch (error) {
        // No selected folder, or no such call on this platform.
    }
    try {
        var folders: any = await joplin.data.get(['folders'])
        var items = (folders && folders.items) || []
        if (items.length) return String(items[0].id)
    } catch (error) {
        // No folders readable; fall through and make one.
    }
    var folder: any = await joplin.data.post(['folders'], null, { title: "Cockpit" })
    return String((folder && folder.id) || "")
}
