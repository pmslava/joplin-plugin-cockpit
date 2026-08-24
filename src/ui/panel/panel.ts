/** README ******************************************************************************************************************************************
 * The Cockpit panel. On desktop it is shown beside the note list; on mobile Joplin shows it as a tab in the plugin panel dialog, which is opened    *
 * from the built in toolbar button of the note screen.                                                                                             *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { focusNewItemEditor, getAllTags, getExcludedNotebookIdSet, getNotebookMap, invalidateNotebookMap, invalidateTagsCache, notebookWithDescendants, openTodo, searchTitleSuggestions, setTodoCompleted, setTodoDueDates, setTodoDuesPerId } from "../../core/joplin";
import { clearOptimisticItem, clearTodoCompletionOverride, hasPendingItemOverlay, removeOptimisticItem, revalidateOptimisticInserts, setTodoCompletionOverride, upsertOptimisticItem, viewKeyFor } from "../../core/optimistic";
import { EXCLUDED_NOTEBOOKS_KEY, EXCLUDED_NOTEBOOK_IDS_KEY, canonicalTextFromIds, parseExcludedIds } from "../../core/exclusion";
import { logRefresh, snapshot } from "../../core/instrument";
import { applyAlarmCleared, applyAlarmSet, getAlarmInitialFields, openAlarmDialog } from "../alarm/alarm";
import { refreshInterfaces, scheduleOverview, scheduleReconcile } from "../../core/timer";
import { getSyncStatus } from "../../core/syncStatus";
import { createProfile, getAllProfiles, getProfile, updateProfile } from "../../core/database";
import { getEditorInitial, openDeleteDialog, openEditor } from "../editor/editor";
import { escapeHtml, getFormatter, isCalendarFormat, renderNotesSection, renderOutsideResultsSection, stepCalendarAnchor } from "../../core/formats";
import { toISODate } from "../../core/calendar";
import { getCurrentProfileID, getCustomCss, getDayStartTime, setCurrentProfileID, gestureTraceSettingKey } from "../../core/settings";
import { buildThemeCss } from "../../core/theme";
import { isMobile } from "../../core/platform";
import { isDialogOpen, openPluginDialog, resetOverlayGuard, setOverlayGuard } from "../../core/dialog";
import { panelTemplate } from "./panelTemplate";
import { iconButton, icons } from "../icons";
// The pure "drop between rows" date math (window.CockpitBetween is unused in this bundle; the require pulls the same UMD
// file the Node harness unit-tests, so the drop path and the tests share one implementation). Webpack bundles it in.
const { sequenceBetween, betweenBounds } = require("../../core/between");

/** Variable Declaration ***************************************************************************************************************************/
var panel = null;
var lastRenderedHtml = null;

/** Scroll position (source of truth for mobile) ********************************************************************************************************
 * On desktop the panel webview keeps the scroll position in its own module state (setHtml leaves it alone). On mobile every setHtml is a FULL WEBVIEW  *
 * RELOAD that destroys that module state, so the plugin holds the position instead: the webview posts it (throttled) as scrollChanged, and every render *
 * embeds it as data-scroll-top so the reloaded webview can restore it. renderNonce tags each render; a scrollChanged carrying an old nonce (a late post *
 * from the outgoing webview) is dropped, which is what keeps the deliberate resets below robust. Deliberate view changes (profile, notebook, search,    *
 * sort, calendar) set lastScrollTop = 0 before their refresh, so both platforms start those at the top.                                                *
 ***************************************************************************************************************************************************/
var lastScrollTop = 0
var renderNonce = 0

/** refreshGeneration (out-of-order paint guard) ****************************************************************************************************
 * A monotonically increasing id stamped on every refreshPanelData run. refreshPanelData awaits many data calls (search, note bodies, notebook map)  *
 * before it paints, and it is entered from many uncoordinated triggers (a profile switch, the periodic timer, a sync event, an onNoteChange, the     *
 * background count-fill), so two runs can overlap and finish in the wrong order - a slow older run resolving last would otherwise setHtml its stale   *
 * markup over a newer run's paint. Each run captures the current value; just before it would paint it checks the value is still current and discards  *
 * itself if a newer run has since started. Any note bodies a discarded run fetched still warm the shared cache, so the newer run keeps that work.     *
 ***************************************************************************************************************************************************/
var refreshGeneration = 0

/** Row-height estimate for viewport-first body fetching ******************************************************************************************
 * The background checkbox-count pass fetches the note bodies nearest the viewport first. The host holds the scroll position in pixels (lastScrollTop) *
 * but the body fetch works in row indices, so this rough per-row height converts one to the other. It is only a hint that biases fetch order when the *
 * per-refresh body-fetch cap truncates a large set; being an estimate, a fixed value is enough (rows vary a little and headings add slack).           *
 ***************************************************************************************************************************************************/
const rowHeightEstimate = 40

/** estimateFirstVisibleIndex **********************************************************************************************************************
 * The approximate index of the first row inside the viewport, from the host-held scroll position, with a couple of rows of slack above so a row       *
 * straddling the top edge is still fetched early. Clamped at 0.                                                                                       *
 ***************************************************************************************************************************************************/
function estimateFirstVisibleIndex(){
    var index = Math.floor((Number(lastScrollTop) || 0) / rowHeightEstimate) - 2
    return index > 0 ? index : 0
}

/** searchFocused (mobile hold) *********************************************************************************************************************
 * True while the mobile search field has focus. refreshPanelData skips its setHtml then, because on mobile a setHtml is a full webview reload that      *
 * would wipe the input, caret, suggestion list and soft keyboard mid-typing. The webview posts searchFocusChanged on focus/blur; the held refresh runs  *
 * on blur. Desktop never posts it (it keeps its module-state draft restore), and the guard is mobile-gated, so desktop is unaffected.                   *
 ***************************************************************************************************************************************************/
var searchFocused = false

/** openOverlayState (mobile overlay reload-survival) ***********************************************************************************************
 * A small, fully rebuildable descriptor of the in-panel overlay (notebook / tag / alarm picker) that is currently open, or null when none is. The     *
 * webview posts it on open and on throttled input changes (['overlayState', descriptor]); the host clears it when the overlay closes (the dialogGuard  *
 * false path). It exists because on mobile the panel WebView can be reloaded by the HOST at any time - an Android renderer-process kill under sync     *
 * load remounts it and re-serves the last document Joplin held, which is the PRE-overlay snapshot (the refresh guard blocked any newer setHtml while    *
 * the overlay was up). That reload wipes the overlay, and the plugin's guard cannot help: the reload is host-initiated, not a Cockpit setHtml. So the   *
 * host holds the descriptor and, on the fresh webview's dialogGuardReset, re-renders once with it embedded (see refreshPanelData / the dialogGuardReset *
 * handler) so the reloaded webview can reconstruct the overlay. Null on desktop (overlays are mobile-only), so desktop never embeds or reconstructs.    *
 ***************************************************************************************************************************************************/
var openOverlayState = null

/** editorNoteID (the row highlight follows the main editor) ****************************************************************************************
 * The id of the note the MAIN window's editor/viewer is showing, or "" when none is - including when Joplin's own note list holds SEVERAL notes      *
 * selected, where no single note is open. The panel highlights that row, so its highlight tracks the editor wherever the note was opened from (a      *
 * Cockpit row, the note list, a link). The value is held HERE rather than in the webview because on mobile every render is a full webview reload that *
 * destroys module state; a freshly loaded webview asks for it back (getEditorNote) and the host pushes every change (editorNoteChanged).              *
 *                                                                                                                                                    *
 * It sits outside the refresh lanes on purpose: a selection change mutates no note and changes no markup, so it issues no search, no data call and no *
 * render - only the message. Notes opened in a SECONDARY Joplin window arrive here as ordinary selection changes (Joplin keeps one store whose        *
 * top-level selection belongs to the focused window); they are filtered in the webview, which is the only side that can read which window has focus.  *
 ***************************************************************************************************************************************************/
var editorNoteID = ""

/** trackEditorNoteSelection ************************************************************************************************************************
 * Handles workspace.onNoteSelectionChange: records which note the editor now holds and pushes it to the panel webview. An unchanged selection is     *
 * dropped rather than pushed - Joplin re-emits the selection whenever the focused window changes, and the push collapses the panel's multi-selection *
 * onto the open note, which must only happen when the editor genuinely moved to another note.                                                        *
 ***************************************************************************************************************************************************/
export function trackEditorNoteSelection(noteIDs){
    var ids = Array.isArray(noteIDs) ? noteIDs : []
    var id = ids.length === 1 ? String(ids[0] || "") : ""
    if (id === editorNoteID) return
    editorNoteID = id
    if (!panel) return
    try {
        joplin.views.panels.postMessage(panel, ['editorNoteChanged', id])
    } catch (error) {
        console.warn("Cockpit: could not tell the panel which note is open", error)
    }
}

/** calendarViewState *******************************************************************************************************************************
 * Which month or week the calendar views are showing, and which day is selected. This is where the user has navigated to rather than a setting, so   *
 * it is kept in memory and starts again at today whenever the plugin restarts or the profile changes.                                               *
 * It has to live here rather than in the webview because the panel markup is regenerated from scratch on every refresh.                             *
 ***************************************************************************************************************************************************/
var calendarViewState = { anchor: toISODate(new Date()), selectedDate: null }

/** resetCalendarViewState **************************************************************************************************************************/
function resetCalendarViewState(){
    calendarViewState = { anchor: toISODate(new Date()), selectedDate: null }
}

/** notebookFilter **********************************************************************************************************************************
 * The notebook the panel is filtered to, as a notebook ID, or an empty string for all notebooks. Like the calendar view state this is where the      *
 * user has navigated to rather than a setting, so it lives in memory and starts again at "all notebooks" when the plugin restarts or the profile     *
 * changes.                                                                                                                                          *
 ***************************************************************************************************************************************************/
var notebookFilter = ""

/** searchFilter ************************************************************************************************************************************
 * A search string appended to the profile's search criteria, supporting the full Joplin search syntax (tag:, notebook:, plain words). Empty for no  *
 * extra filtering. Held in memory for the same reason as the notebook filter.                                                                       *
 ***************************************************************************************************************************************************/
var searchFilter = ""

/** Sort state **************************************************************************************************************************************
 * How items sharing a due time (and the notes group) are ordered. Kept in settings so it survives restarts, mirrored here for rendering.            *
 ***************************************************************************************************************************************************/
var sortField = "title"
var sortDirection = "asc"
const sortFieldCycle = ["title", "updated", "created"]
const sortFieldLabels = { title: "Title", updated: "Updated", created: "Created" }

/** notebookPickerDialog ****************************************************************************************************************************/
var notebookPickerDialog = null

/** tagPickerDialog *********************************************************************************************************************************
 * The dialog behind the mobile setTags fallback: a single comma-separated tag input. Only ever opened on mobile (where the native setTags command   *
 * is absent), but created unconditionally at startup so the handle exists if the fallback path runs.                                                *
 ***************************************************************************************************************************************************/
var tagPickerDialog = null

/** setupPanel **************************************************************************************************************************************
 * Creates the panel in joplin and connects the event handler.                                                                                      *
 ***************************************************************************************************************************************************/
export async function setupPanel(){
    panel = await joplin.views.panels.create('panel')
    // The shared quick-button math (window.AlarmQuick) is loaded first, so it exists before panelWebview.js wires
    // the mobile alarm overlay's buttons to it - the same module the desktop alarm dialog and the unit tests use.
    await joplin.views.panels.addScript(panel, '/ui/alarm/alarmQuick.js')
    // The shared note-context-menu markup (window.NoteMenu) is loaded before panelWebview.js builds the menu -
    // the same module the Node unit tests require to pin the single- and multi-select markup.
    await joplin.views.panels.addScript(panel, '/ui/panel/noteMenu.js')
    // The shared editor-note highlight rules (window.EditorNote), loaded before panelWebview.js applies them -
    // the same module the Node unit tests drive through the selection scenarios.
    await joplin.views.panels.addScript(panel, '/ui/panel/editorNote.js')
    // The shared search-token text rules (window.SearchTokens), loaded before panelWebview.js builds the search
    // suggestion dropdown and inserts a picked (or multi-marked) token - the same module the Node unit tests drive
    // through the insertion / quoting / duplicate-skip cases.
    await joplin.views.panels.addScript(panel, '/ui/panel/searchTokens.js')
    await joplin.views.panels.addScript(panel, '/ui/panel/panelWebview.js')
    await joplin.views.panels.addScript(panel, '/ui/panel/panel.css')
    await joplin.views.panels.onMessage(panel, eventHandler)
    notebookPickerDialog = await joplin.views.dialogs.create('notebookPicker')
    tagPickerDialog = await joplin.views.dialogs.create('tagPicker')
    applyProfileHeaderState(await getProfile(await getCurrentProfileID()))
    setupFolderPoll()
}

/** Notebook picker freshness (folder poll) *****************************************************************************************************
 * Joplin exposes no folder/notebook-change workspace event, so a notebook created, renamed or moved elsewhere (or by sync) would otherwise only reach  *
 * the picker when the 20s notebook-map TTL lapsed on the next 60s/120s timer tick - 10s+ stale. This adds a light poll: at most one small metadata      *
 * request every few seconds (the first page of folders by most-recently-updated), hashed; only a real change drops the cached map and repaints. Renames *
 * and moves are covered by the hash; a deletion is caught too (the row leaves the page), and otherwise still resolves via the TTL path. Desktop polls    *
 * only while the panel is visible; mobile always polls but repaints through refreshPanelData, whose guard leaves an open overlay untouched.             *
 ***************************************************************************************************************************************************/
const folderPollIntervalMs = 3000
var folderPollTimer = null
var folderPollInFlight = false
var lastFolderSignature = null

function setupFolderPoll(){
    clearInterval(folderPollTimer)
    // The callback returns the promise so the work is awaitable (harnessable); setInterval ignores it.
    folderPollTimer = setInterval(() => pollFoldersOnce(), folderPollIntervalMs)
}

async function pollFoldersOnce(){
    // At most one request per interval: a still-running poll skips this tick rather than stacking requests.
    if (folderPollInFlight) return
    folderPollInFlight = true
    try {
        var mobile = await isMobile()
        // Desktop: a hidden panel needs nothing, so do not even issue the request. Mobile: always poll (the
        // panel is a tab the user opens and panels.visible() is unreliable there).
        if (!mobile){
            var visible = true
            try { visible = await joplin.views.panels.visible(panel) } catch (error) { visible = true }
            if (!visible) return
        }
        var response = await joplin.data.get(['folders'], {
            fields: ['id', 'title', 'parent_id', 'updated_time'],
            order_by: 'updated_time',
            order_dir: 'DESC',
            page: 1,
            limit: 20,
        })
        // The page is ordered by updated_time so a renamed/moved/created folder (its updated_time bumped)
        // is guaranteed to surface on it. The SIGNATURE, however, is taken over the stable identity fields
        // only (id/title/parent_id) and sorted by id, so a pure updated_time bump - which merely reorders
        // this page, as happens for every folder a sync touches - does not change it. A rename (title), a
        // move (parent_id), a create (new id) or a delete (id gone from the page) still does. This stops a
        // sync's folder churn from invalidating the notebook map + reconciling the excluded text + running a
        // full refresh computation every 3s for no visible change.
        var signature = JSON.stringify(
            (response.items || [])
                .map(folder => [folder.id, folder.title, folder.parent_id])
                .sort((first, second) => String(first[0]).localeCompare(String(second[0])))
        )
        if (lastFolderSignature === null){
            // The first poll only records the baseline; there is nothing to compare against yet.
            lastFolderSignature = signature
            return
        }
        if (signature === lastFolderSignature) return
        lastFolderSignature = signature
        // A notebook changed: drop the cached map so the breadcrumbs rebuild, then repaint. refreshPanelData's
        // own guards handle a hidden desktop panel or an open mobile overlay, and its equality guard suppresses
        // the render when nothing visible actually changed (e.g. only an updated_time bumped).
        invalidateNotebookMap()
        // Rename-safety for the "Excluded notebooks" feature: exclusion is tracked by id, so a rename/move of
        // an excluded notebook does not change WHAT is excluded, but the visible names field must be refreshed
        // to the new title, and a deleted excluded notebook must drop out of the id list.
        await reconcileExcludedNotebookText()
        await refreshPanelData()
    } catch (error) {
        console.warn("Cockpit: folder poll failed", error)
    } finally {
        folderPollInFlight = false
    }
}

/** reconcileExcludedNotebookText *******************************************************************************************************************
 * Keeps the visible "Excluded notebooks" names field in step with the notebooks it points at, using the stored ids (the source of truth). Called from  *
 * the folder poll when a notebook changed: an excluded notebook that was renamed or moved keeps its id (so it stays excluded), and its shown title is   *
 * refreshed; an excluded notebook that was deleted drops out of the id list and the text. A no-op when nothing is excluded. Writing the visible field   *
 * re-enters the settings resolver, which recomputes the same ids and canonical text and stops there - the resolver's own before-write comparison is the *
 * loop guard, so this never oscillates.                                                                                                                 *
 ***************************************************************************************************************************************************/
async function reconcileExcludedNotebookText(){
    var idsCsv = String(await joplin.settings.value(EXCLUDED_NOTEBOOK_IDS_KEY) || "")
    var ids = parseExcludedIds(idsCsv)
    if (!ids.length) return
    var map = await getNotebookMap()
    // Drop ids whose notebook no longer exists (deleted). Writing the hidden id list does not re-enter the
    // resolver (it keys off the visible field only), so this is safe to do first.
    var liveIds = ids.filter(id => map.has(id))
    var liveCsv = liveIds.join(",")
    if (liveCsv !== idsCsv) await joplin.settings.setValue(EXCLUDED_NOTEBOOK_IDS_KEY, liveCsv)
    // Refresh the visible names from the live ids (new titles after a rename/move). Only write when it
    // actually changed, so an unrelated notebook change does not churn the setting.
    var newText = canonicalTextFromIds(map, liveIds)
    var currentText = String(await joplin.settings.value(EXCLUDED_NOTEBOOKS_KEY) || "")
    if (newText !== currentText) await joplin.settings.setValue(EXCLUDED_NOTEBOOKS_KEY, newText)
}

/** applyProfileHeaderState *************************************************************************************************************************
 * Applies a profile's stored header state - notebook filter, search text and sorting - so that switching profiles switches the whole view. Header    *
 * controls used afterwards override it for the session without being written back to the profile.                                                   *
 ***************************************************************************************************************************************************/
function applyProfileHeaderState(profile){
    if (!profile) return
    notebookFilter = String(profile.notebook || "")
    searchFilter = String(profile.panelSearch || "")
    sortField = sortFieldCycle.includes(profile.sortField) ? profile.sortField : "title"
    sortDirection = profile.sortDirection === "desc" ? "desc" : "asc"
}

/** eventHandler ************************************************************************************************************************************
 * Processes all events triggered by the panel's internal javascript                                                                                *
 ***************************************************************************************************************************************************/
async function eventHandler(message){
    if (message[0] == 'scrollChanged'){
        // The webview's throttled scroll position. Store it only when it carries the current render's
        // nonce; a post tagged with an older nonce is a late one from an outgoing webview whose position
        // has since been deliberately reset, so it is dropped. Never triggers a refresh of its own.
        if (Number(message[2]) === renderNonce) lastScrollTop = Number(message[1]) || 0
        return
    } else if (message[0] == 'searchFocusChanged'){
        // Mobile only: hold refreshes while the search field is focused (a setHtml there is a full webview
        // reload that would wipe the field mid-typing), then run the held refresh on blur.
        searchFocused = !!message[1]
        if (!searchFocused) await refreshPanelData()
        return
    } else if (message[0] == 'todoClicked'){
        await openTodo(message[1])
    } else if (message[0] == 'openInNewWindow'){
        await runAppCommand('openNoteInNewWindow', String(message[1] || ""))
    } else if (message[0] == 'newNoteClicked' || message[0] == 'newTodoClicked'){
        await createItem(message[0] == 'newTodoClicked')
    } else if (message[0] == 'sortFieldSelected'){
        if (sortFieldCycle.includes(String(message[1]))) sortField = String(message[1])
        lastScrollTop = 0
        await refreshPanelData()
    } else if (message[0] == 'sortDirectionClicked'){
        sortDirection = sortDirection === "asc" ? "desc" : "asc"
        lastScrollTop = 0
        await refreshPanelData()
    } else if (message[0] == 'renameNotebookClicked'){
        await runNotebookAction('rename', String(message[1] || ""))
    } else if (message[0] == 'moveNotebookClicked'){
        await runNotebookAction('move', String(message[1] || ""))
    } else if (message[0] == 'deleteNotebookClicked'){
        await runNotebookAction('delete', String(message[1] || ""))
    } else if (message[0] == 'createNotebookClicked'){
        await runAppCommand('newFolder')
        invalidateNotebookMap()
        lastRenderedHtml = null
        await refreshInterfaces()
        scheduleReconcile()
        scheduleOverview()
    } else if (message[0] == 'moveToNotebookClicked'){
        var moveIDs = Array.isArray(message[1]) ? message[1] : [message[1]]
        // Desktop runs the native moveToFolder command; mobile (where it is absent) falls back to the
        // notebook picker + a parent_id PUT per note.
        await tryAppCommandWithFallback('moveToFolder', moveIDs, () => moveNotesFallback(moveIDs))
        await refreshInterfaces()
        scheduleReconcile()
        scheduleOverview()
    } else if (message[0] == 'noteMenuAction'){
        await runNoteMenuAction(String(message[1] || ""), String(message[2] || ""))
    } else if (message[0] == 'noteMenuActionMulti'){
        // The batch version: the webview posts this only when several rows are selected (desktop-only).
        var menuMultiIDs = Array.isArray(message[2]) ? message[2].map(id => String(id || "")).filter(Boolean) : []
        await runNoteMenuActionMulti(String(message[1] || ""), menuMultiIDs)
    } else if (message[0] == 'todoChecked'){
        await applyTodoChecked(String(message[1] || ""), !!message[2])
    } else if (message[0] == 'profilesDropdownChanged'){
        // The last entries of the dropdown are actions rather than profiles
        lastScrollTop = 0
        await setCurrentProfileID(message[1])
        // Another profile may show a different calendar, so start it at today rather than wherever the previous one was scrolled to.
        resetCalendarViewState()
        // The profile carries its own header state: notebook filter, search and sorting.
        applyProfileHeaderState(await getProfile(await getCurrentProfileID()))
        // Paint the switched-to view immediately, then fill the rings from note bodies in the background.
        // optimistic reuses the switched-to profile's cached result set, so a previously viewed profile paints
        // with ZERO searches (with the host-held override map still layered on); a first visit does one search
        // and no body fetches. Either way the whole list is on screen before any body GET.
        await refreshPanelFastThenFill({ optimistic: true })
        // Then ONE background truth refresh: a single search-based refreshPanelData so external edits made
        // while this profile was not current (and which its cached result set therefore predates) show now,
        // instead of staying invisible until the periodic backstop. It is a lone refresh - no overview regen,
        // no reconcile job - so it does not reintroduce the multi-lane cascade a mutation arms (a switch still
        // mutates no note). refreshPanelData's generation guard discards it if a newer refresh supersedes it,
        // and its equality guard makes it a no-op paint when the cached view was already the truth. This also
        // narrows the window in which a stale cross-view optimistic entry could be observed after a switch.
        await refreshPanelData()
    } else if (message[0] == 'notebookFilterChanged'){
        notebookFilter = String(message[1] || "")
        lastScrollTop = 0
        await refreshPanelData()
    } else if (message[0] == 'searchTitleSuggestions'){
        // A two-way round-trip: the webview awaits this handler's return value (title: autocomplete).
        return await searchTitleSuggestions(String(message[1] || ""))
    } else if (message[0] == 'searchFilterChanged'){
        searchFilter = String(message[1] || "").trim()
        lastScrollTop = 0
        // message[2] is set only by the webview's empty-field auto-reset, and asks for the render to happen even
        // though the mobile search-focus hold is armed. The hold exists so a setHtml cannot wipe the field
        // mid-typing, but this commit IS the user finishing with the field - they have emptied it and there is
        // nothing left to type - and waiting for a blur that may never come would leave the panel filtered.
        await refreshPanelData(message[2] ? { renderWhileSearchFocused: true } : undefined)
    } else if (message[0] == 'setAlarmClicked'){
        var alarmTodoIDs = Array.isArray(message[1]) ? message[1] : []
        if (alarmTodoIDs.length) await openAlarmDialog(alarmTodoIDs)
    } else if (message[0] == 'todosDropped'){
        var todoIDs = Array.isArray(message[1]) ? message[1] : []
        var dropTarget = String(message[2] || "")
        if (todoIDs.length && dropTarget){
            await setTodoDueDates(todoIDs, dropTarget === "clear" ? null : dropTarget, await getDayStartTime())
            await refreshInterfaces()
            // The moved to-dos only settle into their new groups once the search index has caught up: the
            // reconcile lane repaints the panel then, the overview lane rewrites the notes on its own debounce.
            scheduleReconcile()
            scheduleOverview()
        }
    } else if (message[0] == 'todosDroppedBetween'){
        // Desktop list-view "drop between rows": the webview posts the dragged ids plus the ids of the to-do rows
        // immediately above (prevId) and below (nextId) the insertion gap, and the group's own date (for the edges).
        // A null neighbour means the gap is at a group edge. The dues are computed here, from the neighbours' dues
        // re-read FRESH (the alarm lesson: never trust the stale value the webview last rendered), so a due changed
        // between render and drop is respected.
        var betweenIDs = Array.isArray(message[1]) ? message[1] : []
        var prevID = message[2] ? String(message[2]) : null
        var nextID = message[3] ? String(message[3]) : null
        var groupDate = message[4] ? String(message[4]) : null
        if (betweenIDs.length){
            await applyBetweenDrop(betweenIDs, prevID, nextID, groupDate)
            await refreshInterfaces()
            // Same post-write flow as todosDropped: reconcile repaints once the index catches up, overview rewrites.
            scheduleReconcile()
            scheduleOverview()
        }
    } else if (message[0] == 'calendarNavigate'){
        var profile = await getProfile(await getCurrentProfileID())
        calendarViewState.anchor = stepCalendarAnchor(profile, calendarViewState.anchor, Number(message[1]))
        lastScrollTop = 0
        await refreshPanelData()
    } else if (message[0] == 'calendarToday'){
        resetCalendarViewState()
        lastScrollTop = 0
        await refreshPanelData()
    } else if (message[0] == 'calendarDaySelected'){
        // Selecting the day that is already selected closes the list again.
        calendarViewState.selectedDate = calendarViewState.selectedDate === message[1] ? null : message[1]
        await refreshPanelData()
    } else if (message[0] == 'createProfileClicked'){
        // Desktop only: on mobile the create-profile button opens the in-panel editor overlay (which posts
        // profileSaved) rather than this native-dialog flow. Fast off-screen paint so the panel holds fresh
        // content immediately, then the background fill fetches the rings and the overview lane writes the new
        // profile's overview note. No reconcile: creating a profile mutates no note, so there is no index to
        // catch up to.
        await openEditor()
        lastRenderedHtml = null
        await refreshPanelFastThenFill()
        scheduleOverview()
    } else if (message[0] == 'editProfileClicked'){
        var id = message[1] != null ? Number(message[1]) : await getCurrentProfileID()
        await openEditor(id)
        // Editing the current profile may change its header state, so re-apply it
        if (id == await getCurrentProfileID()) applyProfileHeaderState(await getProfile(id))
        lastRenderedHtml = null
        // A profile edit changes no note data, only which to-dos this profile shows, so paint (fast) and
        // regenerate only THIS profile's overview note - not every profile's - on the overview lane.
        await refreshPanelFastThenFill()
        scheduleOverview([id])
    } else if (message[0] == 'deleteProfileClicked'){
        var deleteID = message[1] != null ? Number(message[1]) : await getCurrentProfileID()
        await openDeleteDialog(deleteID)
        // The deleted profile may have been the current one, in which case another becomes current
        applyProfileHeaderState(await getProfile(await getCurrentProfileID()))
        lastRenderedHtml = null
        await refreshInterfaces()
    } else if (message[0] == 'synchronizeClicked'){
        // Joplin's synchronize command is a toggle: it starts a sync, or cancels the one in
        // progress. It resolves as soon as the sync is scheduled, so completion is tracked through
        // the onSyncStart / onSyncComplete events rather than by awaiting this. Routed through
        // runAppCommand so an absent command degrades to a message box like every other app command.
        await runAppCommand('synchronize')
    } else if (message[0] == 'dialogGuard'){
        // The panel webview brackets every in-panel overlay (notebook, tag, alarm) with dialogGuard
        // true/false so refreshPanelData pauses while it is open - the overlay must not be repainted out
        // from under the user, and on mobile a setHtml would also re-assert the panel viewer's native
        // Modal. The message is posted false on EVERY close path (OK, Cancel, Escape, an outside tap, the
        // Android back gesture), so the counter is always balanced. When the last overlay closes, repaint
        // once to pick up any refresh that was skipped while it was up (a Cancel arms no other refresh);
        // on an OK close the picker's own handler already refreshes, so this extra render is a no-op via
        // the equality guard. Mobile-only in effect: overlays are never opened on desktop.
        setOverlayGuard(!!message[1])
        if (!message[1]){
            // An overlay just closed: it can no longer need reconstructing, so drop its descriptor now,
            // synchronously, BEFORE the repaint below - otherwise a post-close render could still embed
            // the stale descriptor and the reloaded webview would resurrect the overlay the user just
            // dismissed. (The webview deliberately does NOT post a separate overlayState-null message on
            // close, to avoid that race; the host owns the clear.)
            openOverlayState = null
            if (!isDialogOpen()) await refreshPanelData()
        }
    } else if (message[0] == 'overlayState'){
        // The webview's descriptor of the overlay it is showing (posted on open and on throttled input
        // changes). Held so a host-initiated webview reload mid-overlay can be reconstructed; never
        // triggers a refresh of its own (the overlay is up, so refreshes are guarded anyway).
        openOverlayState = message[1] || null
        return
    } else if (message[0] == 'dialogGuardReset'){
        // Posted once per webview (re)load on mobile: clear any overlay guard leaked by a webview that was
        // torn down mid-overlay, so refreshPanelData is not paused forever. Clear the search-focus hold for
        // the same reason: a fresh load has no focused field, so a hold leaked by a torn-down webview (the
        // panel tab closed while the search was focused) would otherwise pause refreshes forever.
        resetOverlayGuard()
        searchFocused = false
        // Overlay reload-survival: message[1] is true when the freshly loaded document ALREADY carries the
        // overlay descriptor (it will reconstruct the overlay itself, so nothing to do). When an overlay
        // should be open but the loaded document does NOT carry it - the classic case being an Android
        // renderer crash that re-served the stale pre-overlay snapshot - re-render once WITH the descriptor
        // embedded so the fresh webview can rebuild it. The webview clears the leaked guard above first and
        // re-arms it when it rebuilds, so this fires exactly once and cannot loop (a document that already
        // carries the descriptor reports message[1] true and is skipped).
        if (openOverlayState && !message[1]) await refreshPanelData()
    } else if (message[0] == 'getEditorNote'){
        // A two-way round-trip: a freshly loaded webview asks which note the editor is showing, so it can
        // paint the highlight straight away rather than waiting for the next selection change. Reads
        // host-held state only - no data call, no render.
        return editorNoteID
    } else if (message[0] == 'getNoteTags'){
        // A two-way round-trip (like searchTitleSuggestions): the tag overlay awaits this to prefill its
        // input with the note's current tags, comma separated.
        return await currentTagsCsv(String(message[1] || ""))
    } else if (message[0] == 'notebookPicked'){
        // Result of the in-panel notebook overlay. The purpose carries which flow opened it, so the same
        // data-API logic the desktop dialogs drive runs here unchanged.
        await applyNotebookPicked(String(message[1] || ""), String(message[2] || ""), message[3])
    } else if (message[0] == 'tagsPicked'){
        // Result of the in-panel tag overlay: the desired comma-separated titles. The diff/attach/detach
        // logic is exactly the desktop fallback's.
        await setNoteTagsFromCsv(String(message[1] || ""), String(message[2] || ""))
        await refreshInterfaces()
        scheduleReconcile()
        scheduleOverview()
    } else if (message[0] == 'getAlarmInitial'){
        // Round-trip: the alarm overlay awaits this to prefill its date/time fields (first to-do's due
        // time, or the day start today). The desktop alarm dialog computes the same starting values.
        return await getAlarmInitialFields(Array.isArray(message[1]) ? message[1] : [])
    } else if (message[0] == 'alarmSet'){
        // Result of the in-panel alarm overlay's OK: the anchor YYYY-MM-DD / HH:MM strings plus the chosen mode and
        // active plan. The host validates the anchor and applies the plan through the shared applyAlarmPlan. The plan
        // rides across as the row-2 accumulator OBJECT (or an absolute string); applyAlarmSet's engine accepts either,
        // so forward it untouched - String()-coercing an object here would produce "[object Object]", which the plan
        // normaliser can only read as the {str:'anchor'} fallback (dragging every dated to-do onto the anchor date).
        await applyAlarmSet(Array.isArray(message[1]) ? message[1] : [], String(message[2] || ""), String(message[3] || ""),
            message[4] != null ? String(message[4]) : undefined,
            (message[5] != null && (typeof message[5] === "object" || typeof message[5] === "string")) ? message[5] : undefined)
    } else if (message[0] == 'alarmCleared'){
        // Result of the in-panel alarm overlay's "Clear alarm".
        await applyAlarmCleared(Array.isArray(message[1]) ? message[1] : [])
    } else if (message[0] == 'getEditorInitial'){
        // Round-trip: the in-panel profile editor overlay awaits this to prefill its fields. For create it
        // returns a null profile (the overlay keeps the template defaults); for edit it returns the profile
        // as a plain object. Mirrors the desktop openEditor's base64 prefill without the encoding.
        return await getEditorInitial(message[1] != null ? Number(message[1]) : undefined)
    } else if (message[0] == 'profileSaved'){
        // Result of the in-panel profile editor overlay's Create/Save. message[1] is the profile id (null on
        // create), message[2] the profile object. Same DB CRUD the desktop editor uses, then the same
        // post-editor refresh as the editProfileClicked branch.
        var savedID = message[1] == null ? await createProfile() : Number(message[1])
        await updateProfile(savedID, message[2])
        if (savedID == await getCurrentProfileID()) applyProfileHeaderState(await getProfile(savedID))
        lastRenderedHtml = null
        // Mobile-only path (the editor overlay is never opened on desktop, so this never runs there). Paint
        // fast and defer just THIS profile's overview-note rewrite to the overview lane, mirroring the
        // switch/create handlers, instead of the heavy inline refreshInterfaces the round meant to remove from
        // the interactive create/save path. Editing may change which to-dos show, so a full (fast) paint is
        // still issued - the search runs; only the ring body-fetches are deferred to the fill. No reconcile:
        // saving a profile mutates no note. The overview scope is the saved profile alone.
        await refreshPanelFastThenFill()
        scheduleOverview([savedID])
    } else if (message[0] == 'profileDeleteRequested'){
        // Result of the in-panel profile editor overlay's Delete. openDeleteDialog keeps its native confirm
        // message box (which shows correctly above the panel on mobile) and the ">1 profile must exist"
        // guard, unchanged. Then refresh as the deleteProfileClicked branch does.
        await openDeleteDialog(Number(message[1]))
        applyProfileHeaderState(await getProfile(await getCurrentProfileID()))
        lastRenderedHtml = null
        await refreshInterfaces()
    }
}

/** readFreshTodoDue ********************************************************************************************************************************
 * The CURRENT due timestamp of one to-do (0 when it has no alarm, is missing, or the id is null), read fresh at drop time. The between-drop math    *
 * needs the neighbours' true present dues, not the value the webview last painted, so a due that changed since the render is honoured.               *
 ***************************************************************************************************************************************************/
async function readFreshTodoDue(todoID){
    if (!todoID) return 0
    try {
        var note = await joplin.data.get(['notes', todoID], { fields: ['todo_due'] })
        return note && note.todo_due && note.todo_due > 0 ? note.todo_due : 0
    } catch (error) {
        return 0
    }
}

/** applyBetweenDrop ********************************************************************************************************************************
 * Assigns due datetimes to the dragged to-dos so they land IN BETWEEN the temporal neighbours of the insertion gap. The neighbours' dues are read   *
 * fresh (readFreshTodoDue), the open interval is resolved by the pure betweenBounds (interior, or a group edge when a neighbour is absent), and the  *
 * per-to-do datetimes come from the pure sequenceBetween (dragged order preserved, strictly increasing). The result is written per id, one PUT each, *
 * exactly like the multi-select alarm plan lands. A null interval (no neighbours AND no usable group date) writes nothing.                           *
 ***************************************************************************************************************************************************/
async function applyBetweenDrop(todoIDs, prevID, nextID, groupDate){
    var dayStart = await getDayStartTime()
    var dayStartMinutes = dayStart.hours * 60 + dayStart.minutes
    var prevDue = await readFreshTodoDue(prevID)
    var nextDue = await readFreshTodoDue(nextID)
    var bounds = betweenBounds(prevDue, nextDue, groupDate, dayStartMinutes)
    if (!bounds) return
    var dues = sequenceBetween(bounds.lo, bounds.hi, todoIDs.length, dayStartMinutes)
    await setTodoDuesPerId(todoIDs.map((id, index) => ({ id: id, due: dues[index] })))
}

/** applyTodoChecked ********************************************************************************************************************************
 * Applies a checkbox tick: one idempotent PUT of the completion state the user set (a ms timestamp, or 0), held optimistically on the plugin side so  *
 * every render shows it until the search index agrees. There is deliberately NO immediate search-based refresh - that was the old flicker (a search   *
 * run before the index caught up repainted the tick away). Instead an optimistic repaint shows the new state at once from cache; the reconcile lane    *
 * then lets the index catch up (and retires the override the moment it does, stopping early), and the overview lane rewrites the notes on its own       *
 * debounce. A failed write rolls the optimistic state back and repaints the truth.                                                                     *
 ***************************************************************************************************************************************************/
async function applyTodoChecked(todoID, checked){
    if (!todoID) return
    var completed = checked ? Date.now() : 0
    setTodoCompletionOverride(todoID, completed)
    try {
        await setTodoCompleted(todoID, completed)
    } catch (error) {
        clearTodoCompletionOverride(todoID)
        console.error("Cockpit: could not update the to-do's completion", error)
        await refreshPanelFastThenFill()
        return
    }
    await refreshPanelData({ optimistic: true })
    // An optimistic arm: the completion override retires the instant a search agrees, so the reconcile lane
    // may stop early once it does (unless a non-optimistic mutation joins the burst).
    scheduleReconcile(true)
    scheduleOverview()
}

/** completedBucketOf *******************************************************************************************************************************
 * Which completed-period switch governs a to-do (mirrors BaseFormat.getCompletedBucket), used to decide whether a completed to-do is visible in the   *
 * active profile when evaluating an optimistic insert locally.                                                                                       *
 ***************************************************************************************************************************************************/
function completedBucketOf(record){
    if (!record.todo_due || record.todo_due <= 0) return "nodue"
    var startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    var endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
    if (record.todo_due < startOfToday.getTime()) return "past"
    if (record.todo_due <= endOfToday.getTime()) return "today"
    return "future"
}

/** isLocallyEvaluableView **************************************************************************************************************************
 * Whether the active view's membership can be decided on the plugin side without a search. It cannot when the profile carries its own search criteria  *
 * or the user has typed extra search text, because those are arbitrary Joplin queries (tag:, title:, free words, any:1 ...). The notebook filter,      *
 * type visibility and completed switches ARE locally evaluable (see noteMatchesView), so a view with no search text can be reasoned about directly.    *
 ***************************************************************************************************************************************************/
function isLocallyEvaluableView(profile){
    return !String(profile.searchCriteria || "").trim() && !String(searchFilter || "").trim()
}

/** noteMatchesView *********************************************************************************************************************************
 * Whether a note/to-do record belongs in the active view, judged only by the locally-evaluable constraints: the notebook filter (including its sub-   *
 * notebooks), whether the profile lists notes, the no-due switch, and the completed-period switches. The caller must have confirmed the view is        *
 * locally evaluable (no search text) first.                                                                                                          *
 ***************************************************************************************************************************************************/
function noteMatchesView(record, profile, notebooks, excludedSet?){
    // An excluded notebook's notes must never surface, not even optimistically, so a create/change inside one
    // is treated as not belonging to the view (which suppresses it, matching the search-side filtering).
    if (excludedSet && excludedSet.has(record.parent_id)) return false
    if (notebookFilter){
        var allowed = notebookWithDescendants(notebooks, notebookFilter)
        if (!allowed.has(record.parent_id)) return false
    }
    if (record.is_todo){
        if ((!record.todo_due || record.todo_due <= 0) && !profile.showNoDue) return false
        if (record.todo_completed && record.todo_completed > 0){
            var bucket = completedBucketOf(record)
            if (bucket === "nodue") return !!profile.showCompletedNoDue
            if (bucket === "past") return !!profile.showCompletedPast
            if (bucket === "today") return !!profile.showCompletedToday
            return !!profile.showCompletedFuture
        }
        return true
    }
    // A regular note appears only when the profile shows notes alongside the to-dos.
    return !!profile.showNotes
}

/** insertCreatedItemOptimistically *****************************************************************************************************************
 * After Cockpit creates a note/to-do, put it into the current view at once from the POST response, so the user does not wait for the search index. It  *
 * is inserted only when the active view is locally evaluable AND the fresh item satisfies it; otherwise the reconcile lane reconciles it via a search. *
 ***************************************************************************************************************************************************/
async function insertCreatedItemOptimistically(newItem, isTodo, folderID){
    // Returns whether it inserted an overlay entry, so the caller can tell the reconcile lane this arm is
    // optimistic; a create that could not be evaluated locally (or did not match the view) returns false and
    // the lane runs its offsets out until the search finds the created item.
    try {
        var profileID = await getCurrentProfileID()
        var profile = await getProfile(profileID)
        if (!profile || !isLocallyEvaluableView(profile)) return false
        var record = {
            id: newItem.id,
            title: String(newItem.title || ""),
            parent_id: folderID,
            is_todo: isTodo ? 1 : 0,
            todo_completed: 0,
            todo_due: 0,
            user_updated_time: Date.now(),
            user_created_time: Date.now(),
        }
        var notebooks = await getNotebookMap()
        if (!noteMatchesView(record, profile, notebooks, await getExcludedNotebookIdSet())) return false
        // Scope the entry to the view it was evaluated against, so it shows in THIS profile/notebook view
        // only and never leaks into another profile's panel or overview note.
        upsertOptimisticItem(record, viewKeyFor(profileID, notebookFilter))
        await refreshPanelData({ optimistic: true })
        return true
    } catch (error) {
        console.warn("Cockpit: could not optimistically insert the new item", error)
        return false
    }
}

/** reconcileExternalNoteChange *********************************************************************************************************************
 * A single external note change (onNoteChange, not one Cockpit itself is mid-flight on): fetch that one note and upsert or suppress it in the current  *
 * view under the same locally-evaluable rule, so an externally created / moved / trashed note shows or disappears without waiting for the periodic     *
 * timer. Search stays the eventual authority - the overlay entry retires as soon as a real search agrees. The single GET is the caller's cost; the     *
 * caller (timer.ts) skips it entirely while a sync is running, where hundreds of notes change and the post-sync reconciliation covers them instead.    *
 * Returns whether it left a host-held optimistic entry (an insert or a suppress), so the caller can tell the reconcile lane this arm is optimistic (it  *
 * may stop early once the index agrees) rather than a blind change that must run its offsets out; a cleared / no-op / errored reconcile returns false.  *
 ***************************************************************************************************************************************************/
export async function reconcileExternalNoteChange(noteID){
    if (!noteID) return false
    // Captured before the GET so the scope is known even on the Not-Found path in the catch below. Every
    // overlay entry this function writes is scoped to the CURRENT view, so an external change judged against
    // this profile never suppresses or inserts the note in another profile's panel or overview note.
    var profileID = await getCurrentProfileID()
    var viewKey = viewKeyFor(profileID, notebookFilter)
    try {
        var profile = await getProfile(profileID)
        if (!profile) return false
        if (!isLocallyEvaluableView(profile)){
            // The view needs a search to decide membership; drop any stale overlay entry and let search rule.
            clearOptimisticItem(noteID)
            return false
        }
        var note = await joplin.data.get(['notes', noteID], {
            fields: ['id', 'title', 'parent_id', 'is_todo', 'todo_completed', 'todo_due', 'deleted_time', 'user_updated_time', 'user_created_time'],
        })
        if (!note){ removeOptimisticItem(noteID, undefined, viewKey); return true }
        var trashed = note.deleted_time && note.deleted_time > 0
        var notebooks = await getNotebookMap()
        if (trashed || !noteMatchesView(note, profile, notebooks, await getExcludedNotebookIdSet())){
            removeOptimisticItem(noteID, !!note.is_todo, viewKey)
        } else {
            upsertOptimisticItem(note, viewKey)
        }
        // An optimistic repaint (no search) so a newly appearing / disappearing item shows at once; the
        // equality guard suppresses it when nothing visible changed, so a mere content edit does not churn.
        await refreshPanelData({ optimistic: true })
        return true
    } catch (error) {
        if (error && error.message === "Not Found"){
            removeOptimisticItem(noteID, undefined, viewKey)
            return true
        }
        console.warn("Cockpit: could not reconcile the changed note", error)
        return false
    }
}

/** togglePanelVisibility ***************************************************************************************************************************
 * Toggles the main panel between shown and hidden. On mobile the panel is a tab in Joplin's own plugin panel dialog, which the user opens and       *
 * closes from the app itself, so hiding it here would leave no way of getting it back.                                                             *
 ***************************************************************************************************************************************************/
export async function togglePanelVisibility() {
    if (await isMobile()) return
    var visibility = await joplin.views.panels.visible(panel);
    await joplin.views.panels.show(panel, !visibility);
    // refreshPanelData skips its work while the panel is hidden, so a refresh is forced here when the
    // panel is being shown, otherwise it would display whatever markup it last held (or nothing).
    if (!visibility) await refreshPanelData();
}

/** refreshPanelData ********************************************************************************************************************************
 * Displays all todos in the panel, according to the formatting specified by the profile and format. The panel is only updated when the markup has   *
 * actually changed, as replacing it resets the scroll position and any in progress interaction.                                                    *
 ***************************************************************************************************************************************************/
 export async function refreshPanelData(options?){
    if (!panel) return
    // Instrumentation: bracket this refresh so the API calls it makes (search / GET / PUT / bodies) and its
    // wall time can be logged, gated behind instrument.ts's DEBUG (a no-op when off). The snapshot is taken
    // before any data work; the delta is logged just before the paint, so guarded no-paint returns cost
    // nothing but a snapshot read.
    var instrumentStart = Date.now()
    var instrumentBefore = snapshot()
    var mobile = await isMobile()
    // Fast first-paint (both platforms): render the checkbox rings from whatever is already cached WITHOUT
    // fetching note bodies, so a profile switch / startup / full refresh paints the whole row list after one
    // search instead of waiting on up to ~600 body GETs. An uncached ring renders empty (no layout shift -
    // the disc keeps its box), and the follow-up fillCounts pass below fills it. The switch/create handlers
    // and refreshInterfaces pair this fast paint with the fill so the rings arrive a beat later.
    var fast = !!(options && options.fast)
    // Background count-fill: the follow-up render after a fast paint. It reuses the fast paint's cached search
    // (no new round-trip) but fetches the note bodies (viewport first) so the rings fill, then paints once.
    // The lastRenderedHtml guard makes it a no-op when nothing changed (a warm cache / a switch back).
    var fillCounts = !!(options && options.fillCounts)
    // Optimistic render: reuse the last search for the active query and layer the host-held overlay/overrides
    // on top (getTodos/getNotes via the viewState flag below), so a tick/create/external-change shows at once
    // without another search. Any-platform; the equality guard still suppresses a render that changes nothing.
    var optimistic = !!(options && options.optimistic)
    // Dialog guard (mobile only): while a Cockpit dialog is open, a panel refresh calls setHtml, which
    // re-asserts the panel viewer's native React Native Modal on top of the dialog's Modal - the "the
    // dialog popped up behind the panel" bug. Skipping the refresh keeps the dialog on top. The guard
    // clears in openPluginDialog's finally once the dialog is dismissed, and every dialog site issues a
    // refresh afterwards on mobile (including the alarm and styler cancel paths, which refresh only on
    // mobile precisely so a skipped refresh is not lost), so nothing is left stale. Gated to mobile:
    // desktop has no such Modal stacking limitation, so its refresh timing stays byte-for-byte unchanged.
    if (mobile && isDialogOpen()) return
    // Mobile only: hold the refresh while the search field has focus. A setHtml on mobile is a full webview
    // reload that would wipe the search input, caret, suggestion list and soft keyboard mid-typing; the held
    // refresh runs when the field blurs (searchFocusChanged). Gated to mobile: on desktop setHtml keeps the
    // field's module-state draft, which restoreSearchDraft paints back, so its refresh timing is unchanged.
    if (mobile && searchFocused && !(options && options.renderWhileSearchFocused)) return
    // Building the markup runs the full search / notes / body query cycle, so it is skipped while the
    // panel is hidden (a closed desktop panel, or a plugin dialog the user has not opened on mobile),
    // which otherwise happens on every 60s timer tick and its follow-ups for no visible effect. The
    // equality guard below still holds the last rendered markup, so the panel renders fresh the moment
    // it is shown again (togglePanelVisibility forces a refresh on show). Any panels.visible() oddity
    // defaults to "visible" so the current behaviour is preserved.
    // On mobile the visibility skip is not applied: the panel is a tab in Joplin's plugin-panel
    // dialog, which the user opens themselves, and togglePanelVisibility (the only forced refresh on
    // show) early-returns on mobile. If panels.visible() reports the not-yet-opened tab as hidden
    // (UNKNOWN #6 in docs/MOBILE.md), skipping here would leave the tab empty on first open with
    // nothing to force a render. Always rendering on mobile restores the pre-batch behaviour that kept
    // the panel current; the skip stays on desktop, where togglePanelVisibility forces a refresh on show.
    var panelVisible = true
    try {
        panelVisible = mobile || await joplin.views.panels.visible(panel)
    } catch (error) {
        console.warn("Cockpit: could not read panel visibility; assuming visible", error)
    }
    if (!panelVisible) return
    // Claim a generation for this run BEFORE any of the awaited data work below. A later run started while
    // this one is still awaiting will claim a higher number; this run then discards itself at the paint
    // guard rather than clobbering the newer paint. Claimed after the early no-paint returns above so those
    // do not needlessly supersede an in-flight run.
    var myGeneration = ++refreshGeneration
    var profileID = await getCurrentProfileID()
    var profile = await getProfile(profileID)
    if (!profile) return
    // Re-validate the optimistic INSERT overlay against the CURRENT view before it is folded into this render.
    // An overlay entry is scoped by viewKey (profileID + notebookFilter), which does NOT capture the profile's
    // visibility switches - so editing e.g. showNoDue or a completed-bucket switch after an item was inserted
    // leaves the viewKey unchanged and a now-hidden item's insert still matching it. The item's own search can
    // never retire that entry (the server filter it was hidden by - due:19700201 / iscompleted:0 - keeps excluding
    // it), so it would otherwise leak into the edited view until the TTL: the CI-caught "undated to-do in a
    // hide-undated profile" regression. Re-running noteMatchesView here drops exactly those stale inserts; a
    // still-matching entry is kept so a profile that still shows the item goes on showing it promptly (no
    // over-fix). When the view can no longer be decided locally (the profile gained searchCriteria, or the user
    // typed search text) no insert may be carried at all, so they are all dropped and the search rules. Gated on a
    // pending overlay, so an ordinary render (nothing overlaid) pays only a size check.
    if (hasPendingItemOverlay()){
        var revalidationKey = viewKeyFor(profileID, notebookFilter)
        if (isLocallyEvaluableView(profile)){
            var revalidationNotebooks = await getNotebookMap()
            var revalidationExcluded = await getExcludedNotebookIdSet()
            revalidateOptimisticInserts(revalidationKey, record => noteMatchesView(record, profile, revalidationNotebooks, revalidationExcluded))
        } else {
            revalidateOptimisticInserts(revalidationKey, () => false)
        }
    }
    // isMobile is carried into the view state so the row HTML generators (renderTodoRow / renderNotesSection)
    // can omit the desktop-only action tooltips on mobile, where hover does not exist and the row already has
    // its long-press flows. Every other platform branch in those generators keys off the same flag.
    var panelViewState = { ...calendarViewState, notebookFilter: notebookFilter, searchFilter: searchFilter, sort: { field: sortField, direction: sortDirection }, fastCheckboxCounts: fast, fillCounts: fillCounts, priorityStart: estimateFirstVisibleIndex(), optimistic: optimistic, isMobile: mobile }
    var formatter = getFormatter(profile, 'html', panelViewState)
    var todosHtml = await formatter.renderHtml()
    var notesHtml = ""
    if (profile.showNotes){
        notesHtml = await renderNotesSection(profile, panelViewState)
        todosHtml = profile.notesPosition === "before" ? notesHtml + todosHtml : todosHtml + notesHtml
    }
    // Results outside current filters (read-only peek). Trigger: the search box holds non-empty text AND the
    // fully-filtered view - the to-dos the formatter just rendered (getRenderedTodoCount, recorded by its own
    // fetchTodos) plus the notes section when the profile shows one - came out with zero rows. renderNotesSection
    // returns "" for zero notes, so this decision needs no extra query. Only in that case is ONE unfiltered
    // search run (renderOutsideResultsSection); with any visible row, or an empty search box, nothing extra runs
    // and the markup stays byte-for-byte as before. This is a pure read - no profile, notebook-picker or setting
    // is touched - and it honours the fast option, which is carried in panelViewState for the checkbox rings.
    var outsideSearchText = String(searchFilter || "").trim()
    var filteredViewIsEmpty = formatter.getRenderedTodoCount() === 0 && notesHtml === ""
    if (outsideSearchText && filteredViewIsEmpty){
        todosHtml += await renderOutsideResultsSection(profile, panelViewState, outsideSearchText)
    }
    var controlsHtml = await getControlsHTML(profileID)
    // The theme block is rebuilt on every render (never memoised) so that a theme-setting change
    // alters the markup and gets past the equality guard below. It sits before the custom CSS, which
    // is injected last and still overrides it.
    var themeCss = await buildThemeCss()
    var customCss = sanitizeCss(await getCustomCss())
    // A hidden marker element carried in the rendered markup on mobile. panelWebview.js reads it on
    // every re-render and adds the cockpit-mobile class to the persistent #joplin-plugin-content
    // wrapper, so mobile-only CSS/JS can branch off it. Empty on desktop, so the desktop markup and DOM
    // are unchanged.
    var rootMarker = mobile ? '<div id="cockpitPlatform" hidden></div>' : ''
    // Overlay reload-survival (mobile): embed the open-overlay descriptor as a JSON data island so a
    // host-reloaded webview can reconstruct the overlay (see openOverlayState). It is part of the
    // equality-compared content below on purpose: openOverlayState is null in every ordinary render (an
    // open overlay guards refreshes, so no render happens while it is up), leaving the island empty and
    // the equality guard untouched; the ONE render where it is non-null is the reconstruct render, whose
    // differing content is exactly what must get past the guard to reach setHtml. "</" is neutralised so a
    // note id/title inside the descriptor cannot close the script element early. Empty on desktop.
    var overlayStateIsland = (mobile && openOverlayState)
        ? `<script id="cockpitOverlayState" type="application/json">${JSON.stringify(openOverlayState).replace(/</g, "\\u003c")}</script>`
        : ''
    var contentHtml = panelTemplate
        .replace("<<THEME_CSS>>", () => themeCss)
        .replace("<<CUSTOM_CSS>>", () => customCss)
        .replace("<<ROOT_MARKER>>", () => rootMarker)
        .replace("<<CONTROLS>>", () => controlsHtml)
        .replace("<<TODOS>>", () => todosHtml)
        .replace("<<OVERLAY_STATE>>", () => overlayStateIsland)
    // Out-of-order guard: if a newer run has started while this one was awaiting its data, discard this run
    // now - BEFORE touching lastRenderedHtml or painting - so a slow older run cannot overwrite the newer
    // paint (nor corrupt the equality baseline with markup that never reached the panel). The newer run owns
    // the paint. Any note bodies this run fetched already warmed the shared cache, so nothing is wasted.
    if (myGeneration !== refreshGeneration) return
    // The equality guard compares content only: the scroll-top and render-nonce placeholders are still
    // present here and are filled in below. Comparing before they are stamped keeps the guard working -
    // otherwise the ever-incrementing nonce would defeat it, forcing a setHtml (a full webview reload on
    // mobile) on every 60s timer tick when nothing has actually changed.
    if (contentHtml === lastRenderedHtml) return
    lastRenderedHtml = contentHtml
    // A real render is happening: bump the nonce and stamp it plus the current scroll position into the
    // markup, so the (re)loaded webview restores the position and tags its scroll posts with this nonce.
    renderNonce++
    var htmlString = contentHtml
        .replace("<<SCROLL_TOP>>", () => String(lastScrollTop))
        .replace("<<RENDER_NONCE>>", () => String(renderNonce))
    await joplin.views.panels.setHtml(panel, htmlString);
    logRefresh(fast ? "fast" : fillCounts ? "fill" : optimistic ? "optimistic" : "full", instrumentBefore, instrumentStart)
}

/** refreshPanelFastThenFill ***********************************************************************************************************************
 * The interactive first-paint path. It paints the whole row list at once WITHOUT any note-body fetches (empty rings), then runs the background pass    *
 * that fetches the bodies (nearest the viewport first) and repaints once with the real rings. A profile switch / create / save uses it so the panel    *
 * appears after a single search instead of stalling on up to ~600 body GETs. options carries the render flags: a switch passes optimistic so a         *
 * previously viewed profile paints straight from the cached result set (zero searches) with the host-held override map layered on. The generation      *
 * guard inside refreshPanelData discards either paint if a newer refresh has superseded it, and the equality guard makes the fill a no-op when the     *
 * rings did not actually change (a warm cache, a switch back).                                                                                         *
 ***************************************************************************************************************************************************/
async function refreshPanelFastThenFill(options?){
    var base = options || {}
    await refreshPanelData({ ...base, fast: true })
    await refreshPanelData({ ...base, fillCounts: true })
}

/** syncButtonTooltip *******************************************************************************************************************************
 * The tooltip for the Synchronize button. While a sync runs it says so and hints that clicking cancels (Joplin's command is a toggle); otherwise it  *
 * shows when the last sync finished, how long it took, and whether it had errors, as far as those are known.                                         *
 ***************************************************************************************************************************************************/
function syncButtonTooltip(sync){
    if (sync.syncing) return "Syncing… (click to cancel)"
    var text = "Synchronize"
    if (sync.lastCompletedAt){
        var time = new Date(sync.lastCompletedAt)
        var hh = String(time.getHours()).padStart(2, "0")
        var mm = String(time.getMinutes()).padStart(2, "0")
        text += ` — Last sync: ${hh}:${mm}`
        if (sync.lastDurationMs != null) text += ` (${Math.round(sync.lastDurationMs / 1000)}s)`
        if (sync.lastWithErrors) text += " — with errors"
    }
    return text
}

/** getControlsHTML *********************************************************************************************************************************
 * The three control rows at the top of the panel: the profile picker with the create buttons, the notebook filter with the sort and synchronize      *
 * buttons, and the search field. Profile management lives inside the profile dropdown as its last entries.                                          *
 ***************************************************************************************************************************************************/
async function getControlsHTML(currentProfileID){
    // The notebook filter offers every notebook, not only the ones the current to-dos live in, so a
    // notebook can be picked even when the active profile's filter hides its to-dos. getNotebookMap
    // is TTL-cached, so this is cheap. Excluded notebooks (and their descendants) are dropped, so the
    // feature hides them from the filter dropdown and the mobile picker too, not only from the results.
    var excludedSet = await getExcludedNotebookIdSet()
    var notebooks = [...(await getNotebookMap()).values()]
        .filter(notebook => !excludedSet.has(notebook.id))
        .sort((first, second) => String(first.path).localeCompare(String(second.path)))
    var mobile = await isMobile()
    var sync = getSyncStatus()
    // The create buttons are labelled on desktop; on mobile they become icon-only (the icon and the title
    // tooltip are kept) so the narrow header gives its width to the profile dropdown instead. Custom panel
    // CSS stays a desktop-only feature reached from the Tools menu, so there is no mobile styler button.
    // The desktop button carries BOTH label wordings - the full one and the short one - and panel.css shows
    // exactly one of them (or neither) for the panel's current width, so the row degrades in two stages and
    // never wraps to a second line. The title/aria-label stay the full wording at every stage, so the
    // icon-only state is still named for a tooltip and for assistive tech.
    var createButtons = mobile
        ? iconButton("note", "New note", "onNewNoteClicked()") + iconButton("todo", "New to-do", "onNewTodoClicked()")
        : `<button type="button" class="create-button" title="New note" aria-label="New note" onclick="onNewNoteClicked()">${icons["note"]}<span class="create-label -long">New note</span><span class="create-label -short">Note</span></button>
            <button type="button" class="create-button" title="New to-do" aria-label="New to-do" onclick="onNewTodoClicked()">${icons["todo"]}<span class="create-label -long">New to-do</span><span class="create-label -short">To-do</span></button>`
    // The "-sync" class gives the button a stable selector for the mobile long-press adapter (which
    // shows its status tooltip as a toast, since touch has no hover). It has no CSS of its own, so it is
    // inert on desktop; "-syncing" still drives the spin animation while a sync runs.
    var syncButton = iconButton("refresh", syncButtonTooltip(sync), "onSynchronizeClicked()", (sync.syncing ? "-syncing " : "") + "-sync")
    // The tag and notebook names that feed the search field's autocomplete, embedded as a JSON
    // island the webview reads. It is user content, so "</" is neutralised (as <) to keep a
    // name from closing the script element early, and the webview builds the dropdown with
    // textContent so nothing here is interpreted as markup.
    var tags = await getAllTags()
    // The notebook id is carried alongside title/path so the mobile in-panel notebook overlay can be
    // built straight from this island (the same list the autocomplete reads), and notebookFilter lets the
    // webview know whether "All notebooks" is active when deciding if a New note needs the notebook
    // overlay. The autocomplete only reads title/path, so the extra fields are inert there and on desktop.
    // The mobile gesture-trace diagnostic (off by default) rides in the island the webview already reads, so
    // it costs no extra round-trip and no new plumbing.
    var gestureTrace = !!(await joplin.settings.value(gestureTraceSettingKey))
    var searchData = JSON.stringify({
        gestureTrace: gestureTrace,
        tags: tags.map(tag => tag.title),
        notebooks: notebooks.map(notebook => ({ id: notebook.id, title: notebook.title, path: notebook.path })),
        notebookFilter: notebookFilter,
    }).replace(/</g, "\\u003c")
    return `
        <section id="profileControls">
            ${getProfileDropdownHTML(await getAllProfiles(), currentProfileID)}
            ${createButtons}
        </section>
        <section id="filterRow">
            ${getNotebookDropdownHTML(notebooks)}
            ${getSortDropdownHTML()}
            ${iconButton(sortDirection === "desc" ? "arrowDown" : "arrowUp", `Sort direction: ${sortDirection === "desc" ? "descending" : "ascending"}`, "onSortDirectionClicked()")}
            ${syncButton}
        </section>
        <section id="searchRow">
            <input id="searchFilter" type="search" placeholder="Search... tag: notebook: title: — any:1 = OR"
                title="Joplin search syntax, applied with Enter. AND by default; start with any:1 to match ANY term (OR). Also tag:, notebook:, title:, -tag:, plain words."
                value="${escapeHtml(searchFilter)}"
                oninput="onSearchInput(this)" onkeydown="onSearchKeyDown(event)"
                onfocus="onSearchFocus()" onblur="onSearchBlur(event)"
                onchange="onSearchFieldChanged(this.value)" onsearch="onSearchFieldChanged(this.value)">
            <script id="cockpitSearchData" type="application/json">${searchData}</script>
        </section>
    `
}

/** getProfileDropdownHTML **************************************************************************************************************************
 * The profile picker, drawn by the panel rather than as a native select so that every row can carry its own always visible edit and delete buttons  *
 * - which also work by tap on mobile, where there is no hover.                                                                                      *
 ***************************************************************************************************************************************************/
function getProfileDropdownHTML(profiles, currentProfileID){
    var currentName = "Profiles"
    var itemsHtml = ""
    for (var profile of profiles){
        var isCurrent = currentProfileID && currentProfileID == profile.id
        if (isCurrent) currentName = profile.name
        itemsHtml += `
            <div class="dropdown-item${isCurrent ? " -current" : ""}" onclick="onDropdownItemClicked(event, 'profilesDropdownChanged', '${profile.id}')">
                <span class="dropdown-label">${escapeHtml(profile.name)}</span>
                <button type="button" class="row-action" title="Edit profile" onclick="onDropdownActionClicked(event, 'editProfileClicked', '${profile.id}')">${icons["edit"]}</button>
                <button type="button" class="row-action" title="Delete profile" onclick="onDropdownActionClicked(event, 'deleteProfileClicked', '${profile.id}')">${icons["trash"]}</button>
            </div>
        `
    }
    itemsHtml += `
        <div class="dropdown-separator"></div>
        <div class="dropdown-item" onclick="onDropdownItemClicked(event, 'createProfileClicked', null)">
            <span class="dropdown-label">+ New profile...</span>
        </div>
    `
    return dropdownHTML("profileMenu", currentName, itemsHtml)
}

/** getNotebookDropdownHTML *************************************************************************************************************************
 * The notebook filter, with rename, move and delete buttons on every notebook row                                                                  *
 ***************************************************************************************************************************************************/
function getNotebookDropdownHTML(notebooks){
    var currentLabel = "All notebooks"
    // A filter box pinned at the top of the open menu (see panel.css .notebook-filter). Its behaviour lives
    // in panelWebview.js (onNotebookFilterInput / onNotebookFilterKeyDown, wired here as inline handlers so
    // it survives the panel's innerHTML swaps like every other control). "All notebooks" carries no
    // data-notebook-row marker, so it is never filtered out and Enter never lands on it; every real notebook
    // row does, which is what the live filter narrows and what Enter-selects-first walks.
    var itemsHtml = `
        <div class="notebook-filter">
            <input type="text" class="notebook-filter-input" placeholder="Filter notebooks..." aria-label="Filter notebooks"
                autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                oninput="onNotebookFilterInput(event)" onkeydown="onNotebookFilterKeyDown(event)">
        </div>
        <div class="dropdown-item${notebookFilter ? "" : " -current"}" data-notebook-all onclick="onDropdownItemClicked(event, 'notebookFilterChanged', '')">
            <span class="dropdown-label">All notebooks</span>
        </div>
    `
    for (var notebook of notebooks){
        var isCurrent = notebook.id === notebookFilter
        if (isCurrent) currentLabel = notebook.path
        itemsHtml += `
            <div class="dropdown-item${isCurrent ? " -current" : ""}" data-notebook-row onclick="onDropdownItemClicked(event, 'notebookFilterChanged', '${escapeHtml(notebook.id)}')">
                <span class="dropdown-label">${escapeHtml(notebook.path)}</span>
                <button type="button" class="row-action" title="Rename notebook" onclick="onDropdownActionClicked(event, 'renameNotebookClicked', '${escapeHtml(notebook.id)}')">${icons["edit"]}</button>
                <button type="button" class="row-action" title="Move notebook" onclick="onDropdownActionClicked(event, 'moveNotebookClicked', '${escapeHtml(notebook.id)}')">${icons["chevronRight"]}</button>
                <button type="button" class="row-action" title="Delete notebook" onclick="onDropdownActionClicked(event, 'deleteNotebookClicked', '${escapeHtml(notebook.id)}')">${icons["trash"]}</button>
            </div>
        `
    }
    itemsHtml += `
        <div class="dropdown-separator"></div>
        <div class="dropdown-item" onclick="onDropdownItemClicked(event, 'createNotebookClicked', null)">
            <span class="dropdown-label">+ New notebook...</span>
        </div>
    `
    return dropdownHTML("notebookMenu", currentLabel, itemsHtml)
}

/** getSortDropdownHTML *****************************************************************************************************************************
 * The sorting picker: its face shows the current sort field, and pressing it lists the choices with the current one highlighted                     *
 ***************************************************************************************************************************************************/
function getSortDropdownHTML(){
    var itemsHtml = ""
    for (var field of sortFieldCycle){
        itemsHtml += `
            <div class="dropdown-item${field === sortField ? " -current" : ""}" onclick="onDropdownItemClicked(event, 'sortFieldSelected', '${field}')">
                <span class="dropdown-label">${sortFieldLabels[field]}</span>
            </div>
        `
    }
    return `
        <div class="dropdown -compact">
            <button type="button" class="dropdown-toggle" title="How items sharing a due time are sorted" onclick="onDropdownToggle(event, 'sortMenu')">
                ${icons["sort"]}<span class="dropdown-toggle-label">${sortFieldLabels[sortField] || "Title"}</span>
            </button>
            <div class="dropdown-menu" id="sortMenu" hidden>${itemsHtml}</div>
        </div>
    `
}

/** dropdownHTML ************************************************************************************************************************************/
function dropdownHTML(menuID, toggleLabel, itemsHtml){
    return `
        <div class="dropdown">
            <button type="button" class="dropdown-toggle" onclick="onDropdownToggle(event, '${menuID}')">
                <span class="dropdown-toggle-label">${escapeHtml(toggleLabel)}</span>
                <span class="dropdown-caret">&#9662;</span>
            </button>
            <div class="dropdown-menu" id="${menuID}" hidden>${itemsHtml}</div>
        </div>
    `
}

/** createItem **************************************************************************************************************************************
 * Creates a note or a to-do and opens it. It goes into the notebook the panel is filtered to; with "All notebooks" selected, a dialog asks where.   *
 ***************************************************************************************************************************************************/
async function createItem(isTodo){
    var folderID = notebookFilter
    if (!folderID){
        // With "All notebooks" selected the user is asked where. Desktop asks with the native notebook
        // picker dialog; mobile asks with the in-panel notebook overlay, which the webview shows itself
        // before posting notebookPicked (createNote/createTodo), so createItem is only reached with a
        // notebook already filtered - nothing to do here on mobile without one.
        if (await isMobile()) return
        folderID = await pickNotebook(isTodo ? "Create to-do in notebook" : "Create note in notebook")
    }
    if (!folderID) return
    await createItemInFolder(isTodo, folderID)
}

/** createItemInFolder ******************************************************************************************************************************
 * Creates a note or to-do in the given notebook and opens it. Shared by createItem (desktop picker / active filter) and the mobile notebook overlay's *
 * createNote / createTodo result.                                                                                                                   *
 ***************************************************************************************************************************************************/
async function createItemInFolder(isTodo, folderID){
    if (!folderID) return
    var newItem = await joplin.data.post(['notes'], null, { parent_id: folderID, is_todo: isTodo ? 1 : 0, title: "" })
    await openTodo(newItem.id)
    // Honour Joplin's own "When creating a new note/to-do" setting (title vs body). A data-API note is not
    // provisional, so the app's own auto-focus never fires for it; this applies the same choice. Desktop-only
    // in effect (the setting and the focus commands are desktop-only, guarded to a no-op on mobile), so this
    // also covers the mobile notebook-overlay create path (applyNotebookPicked -> createItemInFolder) safely.
    await focusNewItemEditor(isTodo)
    // Show the new row at once from the POST response (the record is already in hand) when the active view
    // can be evaluated locally; otherwise the reconcile lane reconciles it via a search once the index has it,
    // and the overview lane rewrites the notes. The insert result tells the lane whether this arm is
    // optimistic (early-stoppable) or a blind create it must poll the search for.
    var insertedOptimistically = await insertCreatedItemOptimistically(newItem, isTodo, folderID)
    scheduleReconcile(insertedOptimistically)
    scheduleOverview()
}

/** applyNotebookPicked *****************************************************************************************************************************
 * Applies the result of the in-panel notebook overlay (mobile). The purpose says which flow opened it, and each branch runs the same data-API logic  *
 * its desktop counterpart does: move notes into a notebook, re-parent a notebook (folderId "" means top level, as the overlay's "(top level)" row     *
 * sends), or create a note/to-do in the chosen notebook.                                                                                            *
 ***************************************************************************************************************************************************/
async function applyNotebookPicked(purpose, folderId, extra){
    if (purpose === 'moveNotes'){
        var moveIDs = Array.isArray(extra) ? extra : []
        for (var id of moveIDs) await joplin.data.put(['notes', id], null, { parent_id: folderId })
        await refreshInterfaces()
        scheduleReconcile()
        scheduleOverview()
    } else if (purpose === 'moveNotebookUnder'){
        var sourceID = String(extra || "")
        if (!sourceID) return
        // A cancelled/absent redraw would leave the tree stale, so force one and drop the notebook cache.
        lastRenderedHtml = null
        invalidateNotebookMap()
        try {
            await joplin.data.put(['folders', sourceID], null, { parent_id: folderId })
        } catch (error) {
            await joplin.views.dialogs.showMessageBox(`Cockpit: the notebook could not be moved (${error.message}).`)
        }
        await refreshInterfaces()
        scheduleReconcile()
        scheduleOverview()
    } else if (purpose === 'createNote' || purpose === 'createTodo'){
        await createItemInFolder(purpose === 'createTodo', folderId)
    }
}

/** runNotebookAction *******************************************************************************************************************************
 * Applies an action from the notebook dropdown's last entries. Apart from creating a notebook, the actions work on the notebook the panel is        *
 * currently filtered to.                                                                                                                           *
 ***************************************************************************************************************************************************/
async function runNotebookAction(action, folderID){
    if (!folderID) return
    // A cancelled dialog leaves the markup unchanged, so force a redraw
    lastRenderedHtml = null
    invalidateNotebookMap()
    if (action == 'rename'){
        await runAppCommand('renameFolder', folderID)
    } else if (action == 'move'){
        var target = await pickNotebook("Move notebook under...", true)
        if (target !== null){
            try {
                await joplin.data.put(['folders', folderID], null, { parent_id: target })
            } catch (error) {
                await joplin.views.dialogs.showMessageBox(`Cockpit: the notebook could not be moved (${error.message}).`)
            }
        }
    } else if (action == 'delete'){
        var folder = (await getNotebookMap()).get(folderID)
        var answer = await joplin.views.dialogs.showMessageBox(`Move the notebook "${folder ? folder.path : folderID}" and its notes to the trash?`)
        if (answer === 0){
            await joplin.data.delete(['folders', folderID])
            if (notebookFilter === folderID) notebookFilter = ""
        }
    }
    await refreshInterfaces()
    scheduleReconcile()
    scheduleOverview()
}

/** pickNotebook ************************************************************************************************************************************
 * Asks the user to choose a notebook and returns its ID, or null when cancelled. With includeRoot, "(top level)" is offered and returned as an      *
 * empty string.                                                                                                                                    *
 ***************************************************************************************************************************************************/
async function pickNotebook(promptTitle, includeRoot = false){
    var excludedSet = await getExcludedNotebookIdSet()
    var notebooks = [...(await getNotebookMap()).values()]
        .filter(notebook => !excludedSet.has(notebook.id))
        .sort((first, second) => String(first.path).localeCompare(String(second.path)))
    var options = notebooks.map(notebook => `<option value="${escapeHtml(notebook.id)}">${escapeHtml(notebook.path)}</option>`).join("")
    if (includeRoot) options = `<option value="__root">(top level)</option>` + options
    await joplin.views.dialogs.setHtml(notebookPickerDialog, `
        <style>
            #joplin-plugin-content { width: 300px; }
        </style>
        <style>
            /* Explicit option colours, because the dropdown list otherwise mixes the theme's light
             * text with the platform's white popup background and becomes unreadable */
            option {
                background-color: var(--joplin-background-color, #ffffff);
                color: var(--joplin-color, #000000);
            }
        </style>
        <form name="picker" style="display: flex; flex-direction: column; gap: 10px; padding: 14px;">
            <strong>${escapeHtml(promptTitle)}</strong>
            <select name="folderId" style="padding: 4px 6px; font-family: inherit; font-size: inherit; color: inherit; background: inherit; border: 1px solid var(--joplin-divider-color, #888); border-radius: 3px;">
                ${options}
            </select>
        </form>
    `)
    var result = await openPluginDialog(notebookPickerDialog)
    if (!result || result.id !== 'ok' || !result.formData || !result.formData.picker) return null
    var picked = result.formData.picker.folderId
    if (picked === "__root") return ""
    return picked || null
}

/** runAppCommand ***********************************************************************************************************************************
 * Runs one of Joplin's own commands, telling the user when the current platform does not have it (several desktop commands do not exist on mobile)  *
 ***************************************************************************************************************************************************/
async function runAppCommand(commandName, args?){
    try {
        await (args === undefined ? joplin.commands.execute(commandName) : joplin.commands.execute(commandName, args))
    } catch (error) {
        console.warn(`Cockpit: the command ${commandName} could not be run`, error)
        await joplin.views.dialogs.showMessageBox(`Cockpit: "${commandName}" is not available here.`)
    }
}

/** tryAppCommandWithFallback ***********************************************************************************************************************
 * Like runAppCommand, but with a mobile-only data-API fallback. moveToFolder / setTags / duplicateNote are registered only on desktop, so on mobile *
 * they throw and hit the "not available here" message box. This runs the native command first: on desktop it exists and succeeds, so the native      *
 * dialog (tag autocomplete, move, duplicate) is preserved exactly. On mobile it throws, and the fallback runs the equivalent through joplin.data.     *
 * If a command is ever added to mobile, the try simply succeeds and the native one is used automatically. Without a fallback (or on desktop) the      *
 * behaviour is identical to runAppCommand.                                                                                                           *
 ***************************************************************************************************************************************************/
async function tryAppCommandWithFallback(commandName, args, fallback){
    try {
        await (args === undefined ? joplin.commands.execute(commandName) : joplin.commands.execute(commandName, args))
    } catch (error) {
        if ((await isMobile()) && fallback){
            await fallback()
        } else {
            console.warn(`Cockpit: the command ${commandName} could not be run`, error)
            await joplin.views.dialogs.showMessageBox(`Cockpit: "${commandName}" is not available here.`)
        }
    }
}

/** moveNotesFallback *******************************************************************************************************************************
 * The mobile fallback for moveToFolder: pick a target notebook and PUT parent_id on each note. No includeRoot - a note must live in a notebook, so   *
 * only notebooks are offered. Uses the same pickNotebook dialog and the same parent_id PUT shape as setTodoDueDates.                                 *
 ***************************************************************************************************************************************************/
async function moveNotesFallback(noteIDs){
    var target = await pickNotebook("Move to notebook")
    if (target === null) return                              // cancelled
    for (var id of noteIDs) await joplin.data.put(['notes', id], null, { parent_id: target })
}

/** duplicateNoteFallback ***************************************************************************************************************************
 * The mobile fallback for duplicateNote: GET the note's copyable fields and POST a fresh copy in the same notebook. Matches desktop's behaviour -    *
 * the title is not renamed, a duplicated task is left open (todo_completed 0), and id / timestamps / order are left for Joplin to assign. The body's  *
 * :/resourceId links resolve to the same shared resources, so no resource duplication is needed (desktop behaves identically).                       *
 ***************************************************************************************************************************************************/
async function duplicateNoteFallback(noteID){
    var note = await joplin.data.get(['notes', noteID], { fields:
        ['title', 'body', 'parent_id', 'is_todo', 'todo_due', 'markup_language', 'source_url', 'author', 'latitude', 'longitude', 'altitude'] })
    await joplin.data.post(['notes'], null, {
        title: note.title, body: note.body, parent_id: note.parent_id,
        is_todo: note.is_todo, todo_due: note.todo_due, todo_completed: 0,
        markup_language: note.markup_language, source_url: note.source_url, author: note.author,
        latitude: note.latitude, longitude: note.longitude, altitude: note.altitude,
    })
}

/** setTagsFallback *********************************************************************************************************************************
 * The mobile fallback for setTags: a single comma-separated tag input prefilled with the note's current tags. On OK the desired titles are diffed    *
 * against the current ones - missing tags are attached (reusing an existing tag id, or creating one), and removed tags are detached. Joplin stores    *
 * tag titles lowercased, so titles are compared case-insensitively.                                                                                  *
 ***************************************************************************************************************************************************/
async function setTagsFallback(noteID){
    var currentTitles = String(await currentTagsCsv(noteID)).split(",").map(part => part.trim()).filter(Boolean)

    await joplin.views.dialogs.setHtml(tagPickerDialog, `
        <style>
            #joplin-plugin-content { width: 300px; }
        </style>
        <form name="tagpicker" style="display: flex; flex-direction: column; gap: 10px; padding: 14px;">
            <strong>Tags (comma separated)</strong>
            <input name="tags" value="${escapeHtml(currentTitles.join(", "))}"
                inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                style="padding: 4px 6px; font-family: inherit; font-size: inherit; color: inherit; background: inherit; border: 1px solid var(--joplin-divider-color, #888); border-radius: 3px;">
        </form>
    `)
    var result = await openPluginDialog(tagPickerDialog)
    if (!result || result.id !== 'ok' || !result.formData || !result.formData.tagpicker) return
    await setNoteTagsFromCsv(noteID, result.formData.tagpicker.tags)
}

/** currentTagsCsv **********************************************************************************************************************************
 * The note's current tag titles as a comma-separated string, in the order Joplin returns them. Used to prefill both the desktop tag dialog and the    *
 * mobile tag overlay (via the getNoteTags round-trip).                                                                                              *
 ***************************************************************************************************************************************************/
async function currentTagsCsv(noteID){
    if (!noteID) return ""
    var currentTags = await joplin.data.get(['notes', noteID, 'tags'], { fields: ['id', 'title'] })
    return (currentTags.items || []).map(tag => String(tag.title || "")).filter(Boolean).join(", ")
}

/** setNoteTagsFromCsv ******************************************************************************************************************************
 * Applies a comma-separated list of desired tag titles to a note: the desired titles are diffed against the current ones - missing tags are attached  *
 * (reusing an existing tag id, or creating one), removed tags are detached. Joplin stores tag titles lowercased, so titles are compared case-         *
 * insensitively. Shared by the desktop tag dialog (setTagsFallback) and the mobile tag overlay (the tagsPicked message).                             *
 ***************************************************************************************************************************************************/
async function setNoteTagsFromCsv(noteID, csv){
    if (!noteID) return
    var currentTags = await joplin.data.get(['notes', noteID, 'tags'], { fields: ['id', 'title'] })
    var currentByTitle = new Map()
    for (var tag of (currentTags.items || [])) currentByTitle.set(String(tag.title || "").toLowerCase(), tag.id)

    // Parse desired titles: trim, lowercase (Joplin stores lowercase), drop blanks and duplicates.
    var desired = new Set()
    for (var raw of String(csv || "").split(",")){
        var title = raw.trim().toLowerCase()
        if (title) desired.add(title)
    }

    // Title -> id over every existing tag, so a desired-but-absent tag reuses its id rather than creating a duplicate.
    var allByTitle = new Map()
    for (var existing of await getAllTags()) allByTitle.set(String(existing.title || "").toLowerCase(), existing.id)

    var createdAny = false
    // Attach every desired tag the note does not already carry.
    for (var wantTitle of desired){
        if (currentByTitle.has(wantTitle)) continue
        var tagID = allByTitle.get(wantTitle)
        if (!tagID){
            var created = await joplin.data.post(['tags'], null, { title: wantTitle })
            tagID = created.id
            createdAny = true
        }
        await joplin.data.post(['tags', tagID, 'notes'], null, { id: noteID })
    }
    // Detach every current tag the user removed.
    for (var [haveTitle, haveID] of currentByTitle){
        if (!desired.has(haveTitle)) await joplin.data.delete(['tags', haveID, 'notes', noteID])
    }
    // A freshly created tag should show up in the search field's tag: autocomplete without waiting for the TTL.
    if (createdAny) invalidateTagsCache()
}

/** copyToClipboard *********************************************************************************************************************************
 * Writes text to the clipboard. joplin.clipboard is Electron-backed, and whether it is wired on the mobile runtime is unknown, so an absent or       *
 * failing clipboard degrades to the same "not available here" message the app commands use rather than throwing an unhandled rejection.             *
 ***************************************************************************************************************************************************/
async function copyToClipboard(text){
    try {
        var clipboard = (joplin as any).clipboard
        if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable')
        await clipboard.writeText(text)
    } catch (error) {
        console.warn('Cockpit: could not write to the clipboard', error)
        await joplin.views.dialogs.showMessageBox('Cockpit: the clipboard is not available here.')
    }
}

/** runNoteMenuAction *******************************************************************************************************************************
 * Applies an action from the panel's context menu to the given note. Actions with no matching command on all platforms are done through the data    *
 * API instead.                                                                                                                                     *
 ***************************************************************************************************************************************************/
async function runNoteMenuAction(action, noteID){
    if (!action || !noteID) return
    if (action == 'open'){
        await openTodo(noteID)
        return
    } else if (action == 'toggleType'){
        var note = await joplin.data.get(['notes', noteID], { fields: ['is_todo'] })
        await joplin.data.put(['notes', noteID], null, { is_todo: note.is_todo ? 0 : 1 })
    } else if (action == 'tags'){
        // Desktop opens its native tag-autocomplete dialog; mobile (no such command) falls back to a
        // comma-separated tag input applied through the data API.
        await tryAppCommandWithFallback('setTags', [noteID], () => setTagsFallback(noteID))
    } else if (action == 'moveToFolder'){
        await tryAppCommandWithFallback('moveToFolder', [noteID], () => moveNotesFallback([noteID]))
    } else if (action == 'duplicate'){
        await tryAppCommandWithFallback('duplicateNote', [noteID], () => duplicateNoteFallback(noteID))
    } else if (action == 'copyMarkdownLink'){
        var linkNote = await joplin.data.get(['notes', noteID], { fields: ['title'] })
        await copyToClipboard(`[${linkNote.title}](:/${noteID})`)
        return
    } else if (action == 'copyNoteID'){
        await copyToClipboard(noteID)
        return
    } else if (action == 'delete'){
        try {
            await joplin.commands.execute('deleteNote', [noteID])
        } catch (error) {
            // The command is desktop only; the data API delete moves the note to the trash
            await joplin.data.delete(['notes', noteID])
        }
    } else {
        return
    }
    await refreshInterfaces()
    scheduleReconcile()
    scheduleOverview()
}

/** runNoteMenuActionMulti **************************************************************************************************************************
 * The batch version of runNoteMenuAction: applies a context-menu action to EVERY selected note in one go, with a SINGLE post-mutation refresh for   *
 * the whole batch (the trio below runs once, after the loop, NOT once per note). Desktop only - the webview only posts this when several rows are    *
 * Ctrl/Shift-selected, which cannot happen on mobile - and the single-only 'open' never reaches here (it renders greyed in the menu).                *
 *                                                                                                                                                    *
 * The destructive per-id writes go through the data API so the batch is atomic per note, goes to the trash reversibly (delete), and is observable:   *
 *   - toggleType: each note flips its OWN type (a mixed note+to-do selection toggles each individually), one is_todo PUT per id.                      *
 *   - moveToFolder: one notebook picker, then a parent_id PUT per note (the existing move fallback, which already loops over an id array).            *
 *   - delete: one DELETE per note to the trash - parity with the single-note delete's data-API path, no extra confirmation dialog.                    *
 * setTags and duplicateNote natively accept an id array and carry the desktop's own multi-note behaviour (setTags seeds the picker with the tags     *
 * COMMON to the selection and applies the add/remove delta to every note; duplicateNote appends " - Copy" to each), so those run as one command with  *
 * the whole set. The copy actions build one newline-joined list.                                                                                     *
 ***************************************************************************************************************************************************/
async function runNoteMenuActionMulti(action, ids){
    if (!action || !Array.isArray(ids) || !ids.length) return
    if (action == 'toggleType'){
        for (var toggleID of ids){
            var toggleNote = await joplin.data.get(['notes', toggleID], { fields: ['is_todo'] })
            await joplin.data.put(['notes', toggleID], null, { is_todo: toggleNote.is_todo ? 0 : 1 })
        }
    } else if (action == 'tags'){
        // Desktop's setTags natively takes an id array (common-tags picker + per-note add/remove delta).
        await runAppCommand('setTags', ids)
    } else if (action == 'moveToFolder'){
        // One notebook picker, then a parent_id PUT per note (moveNotesFallback loops over the array).
        await moveNotesFallback(ids)
    } else if (action == 'duplicate'){
        // duplicateNote natively takes an id array and appends " - Copy" to each title.
        await runAppCommand('duplicateNote', ids)
    } else if (action == 'copyMarkdownLink'){
        var links = []
        for (var linkID of ids){
            var linkNote = await joplin.data.get(['notes', linkID], { fields: ['title'] })
            links.push(`[${linkNote.title}](:/${linkID})`)
        }
        await copyToClipboard(links.join("\n"))
        return
    } else if (action == 'copyNoteID'){
        await copyToClipboard(ids.join("\n"))
        return
    } else if (action == 'delete'){
        // Batch delete to the trash (reversible), a DELETE per note.
        for (var deleteID of ids) await joplin.data.delete(['notes', deleteID])
    } else {
        return
    }
    await refreshInterfaces()
    scheduleReconcile()
    scheduleOverview()
}

/** sanitizeCss *************************************************************************************************************************************
 * Prevents the user's custom CSS from closing the style element it is placed in                                                                    *
 ***************************************************************************************************************************************************/
function sanitizeCss(customCss){
    return String(customCss || "").replace(/<\/(style)/gi, "<\\/$1")
}
