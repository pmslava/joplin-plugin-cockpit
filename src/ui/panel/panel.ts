/** README ******************************************************************************************************************************************
 * The Cockpit panel. On desktop it is shown beside the note list; on mobile Joplin shows it as a tab in the plugin panel dialog, which is opened    *
 * from the built in toolbar button of the note screen.                                                                                             *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { getAllTags, getNotebookMap, invalidateNotebookMap, invalidateTagsCache, openTodo, searchTitleSuggestions, setTodoDueDates, toggleTodoCompletion } from "../../core/joplin";
import { applyAlarmCleared, applyAlarmSet, getAlarmInitialFields, openAlarmDialog } from "../alarm/alarm";
import { refreshInterfaces, scheduleRefresh } from "../../core/timer";
import { getSyncStatus } from "../../core/syncStatus";
import { getAllProfiles, getProfile } from "../../core/database";
import { openDeleteDialog, openEditor } from "../editor/editor";
import { escapeHtml, getFormatter, isCalendarFormat, renderNotesSection, stepCalendarAnchor } from "../../core/formats";
import { toISODate } from "../../core/calendar";
import { getCurrentProfileID, getCustomCss, getDayStartTime, setCurrentProfileID } from "../../core/settings";
import { buildThemeCss } from "../../core/theme";
import { isMobile } from "../../core/platform";
import { isDialogOpen, openPluginDialog, resetOverlayGuard, setOverlayGuard } from "../../core/dialog";
import { panelTemplate } from "./panelTemplate";
import { iconButton, icons } from "../icons";

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

/** searchFocused (mobile hold) *********************************************************************************************************************
 * True while the mobile search field has focus. refreshPanelData skips its setHtml then, because on mobile a setHtml is a full webview reload that      *
 * would wipe the input, caret, suggestion list and soft keyboard mid-typing. The webview posts searchFocusChanged on focus/blur; the held refresh runs  *
 * on blur. Desktop never posts it (it keeps its module-state draft restore), and the guard is mobile-gated, so desktop is unaffected.                   *
 ***************************************************************************************************************************************************/
var searchFocused = false

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
    await joplin.views.panels.addScript(panel, '/ui/panel/panelWebview.js')
    await joplin.views.panels.addScript(panel, '/ui/panel/panel.css')
    await joplin.views.panels.onMessage(panel, eventHandler)
    notebookPickerDialog = await joplin.views.dialogs.create('notebookPicker')
    tagPickerDialog = await joplin.views.dialogs.create('tagPicker')
    applyProfileHeaderState(await getProfile(await getCurrentProfileID()))
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
        scheduleRefresh()
    } else if (message[0] == 'moveToNotebookClicked'){
        var moveIDs = Array.isArray(message[1]) ? message[1] : [message[1]]
        // Desktop runs the native moveToFolder command; mobile (where it is absent) falls back to the
        // notebook picker + a parent_id PUT per note.
        await tryAppCommandWithFallback('moveToFolder', moveIDs, () => moveNotesFallback(moveIDs))
        await refreshInterfaces()
        scheduleRefresh()
    } else if (message[0] == 'noteMenuAction'){
        await runNoteMenuAction(String(message[1] || ""), String(message[2] || ""))
    } else if (message[0] == 'todoChecked'){
        await toggleTodoCompletion(message[1])
        await refreshInterfaces()
        // The completed to-do only disappears from the list once the search index has caught up.
        scheduleRefresh()
    } else if (message[0] == 'profilesDropdownChanged'){
        // The last entries of the dropdown are actions rather than profiles
        lastScrollTop = 0
        await setCurrentProfileID(message[1])
        // Another profile may show a different calendar, so start it at today rather than wherever the previous one was scrolled to.
        resetCalendarViewState()
        // The profile carries its own header state: notebook filter, search and sorting.
        applyProfileHeaderState(await getProfile(await getCurrentProfileID()))
        await refreshInterfaces()
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
        await refreshPanelData()
    } else if (message[0] == 'setAlarmClicked'){
        var alarmTodoIDs = Array.isArray(message[1]) ? message[1] : []
        if (alarmTodoIDs.length) await openAlarmDialog(alarmTodoIDs)
    } else if (message[0] == 'todosDropped'){
        var todoIDs = Array.isArray(message[1]) ? message[1] : []
        var dropTarget = String(message[2] || "")
        if (todoIDs.length && dropTarget){
            await setTodoDueDates(todoIDs, dropTarget === "clear" ? null : dropTarget, await getDayStartTime())
            await refreshInterfaces()
            // The moved to-dos only settle into their new groups once the search index has caught up.
            scheduleRefresh()
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
        await openEditor()
        lastRenderedHtml = null
        await refreshInterfaces()
    } else if (message[0] == 'editProfileClicked'){
        var id = message[1] != null ? Number(message[1]) : await getCurrentProfileID()
        await openEditor(id)
        // Editing the current profile may change its header state, so re-apply it
        if (id == await getCurrentProfileID()) applyProfileHeaderState(await getProfile(id))
        lastRenderedHtml = null
        await refreshInterfaces()
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
    } else if (message[0] == 'stylerClicked'){
        // Executed as a command rather than called directly so that the panel does not have to import the styler dialog, which imports the panel.
        await joplin.commands.execute('showStylerDialog')
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
        if (!message[1] && !isDialogOpen()) await refreshPanelData()
    } else if (message[0] == 'dialogGuardReset'){
        // Posted once per webview (re)load on mobile: clear any overlay guard leaked by a webview that was
        // torn down mid-overlay, so refreshPanelData is not paused forever. Clear the search-focus hold for
        // the same reason: a fresh load has no focused field, so a hold leaked by a torn-down webview (the
        // panel tab closed while the search was focused) would otherwise pause refreshes forever.
        resetOverlayGuard()
        searchFocused = false
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
        scheduleRefresh()
    } else if (message[0] == 'getAlarmInitial'){
        // Round-trip: the alarm overlay awaits this to prefill its date/time fields (first to-do's due
        // time, or the day start today). The desktop alarm dialog computes the same starting values.
        return await getAlarmInitialFields(Array.isArray(message[1]) ? message[1] : [])
    } else if (message[0] == 'alarmSet'){
        // Result of the in-panel alarm overlay's OK: the raw YYYY-MM-DD / HH:MM strings. The host keeps
        // parseAlarmFields + setTodoDueTimestamps.
        await applyAlarmSet(Array.isArray(message[1]) ? message[1] : [], String(message[2] || ""), String(message[3] || ""))
    } else if (message[0] == 'alarmCleared'){
        // Result of the in-panel alarm overlay's "Clear alarm".
        await applyAlarmCleared(Array.isArray(message[1]) ? message[1] : [])
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
 export async function refreshPanelData(){
    if (!panel) return
    var mobile = await isMobile()
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
    if (mobile && searchFocused) return
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
    var profileID = await getCurrentProfileID()
    var profile = await getProfile(profileID)
    if (!profile) return
    var panelViewState = { ...calendarViewState, notebookFilter: notebookFilter, searchFilter: searchFilter, sort: { field: sortField, direction: sortDirection } }
    var formatter = getFormatter(profile, 'html', panelViewState)
    var todosHtml = await formatter.renderHtml()
    if (profile.showNotes){
        var notesHtml = await renderNotesSection(profile, panelViewState)
        todosHtml = profile.notesPosition === "before" ? notesHtml + todosHtml : todosHtml + notesHtml
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
    var contentHtml = panelTemplate
        .replace("<<THEME_CSS>>", () => themeCss)
        .replace("<<CUSTOM_CSS>>", () => customCss)
        .replace("<<ROOT_MARKER>>", () => rootMarker)
        .replace("<<CONTROLS>>", () => controlsHtml)
        .replace("<<TODOS>>", () => todosHtml)
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
    // is TTL-cached, so this is cheap.
    var notebooks = [...(await getNotebookMap()).values()].sort((first, second) => String(first.path).localeCompare(String(second.path)))
    var mobileButtons = (await isMobile()) ? iconButton("brush", "Set Panel CSS", "onStylerClicked()") : ""
    var sync = getSyncStatus()
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
    var searchData = JSON.stringify({
        tags: tags.map(tag => tag.title),
        notebooks: notebooks.map(notebook => ({ id: notebook.id, title: notebook.title, path: notebook.path })),
        notebookFilter: notebookFilter,
    }).replace(/</g, "\\u003c")
    return `
        <section id="profileControls">
            ${getProfileDropdownHTML(await getAllProfiles(), currentProfileID)}
            <button type="button" class="create-button" title="New note" onclick="onNewNoteClicked()">${icons["notePlus"]}<span>New note</span></button>
            <button type="button" class="create-button" title="New to-do" onclick="onNewTodoClicked()">${icons["todoPlus"]}<span>New to-do</span></button>
        </section>
        <section id="filterRow">
            ${getNotebookDropdownHTML(notebooks)}
            ${getSortDropdownHTML()}
            ${iconButton(sortDirection === "desc" ? "arrowDown" : "arrowUp", `Sort direction: ${sortDirection === "desc" ? "descending" : "ascending"}`, "onSortDirectionClicked()")}
            ${mobileButtons}
            ${syncButton}
        </section>
        <section id="searchRow">
            <input id="searchFilter" type="search" placeholder="Search... tag: notebook: title: — any:1 = OR"
                title="Joplin search syntax, applied with Enter. AND by default; start with any:1 to match ANY term (OR). Also tag:, notebook:, title:, -tag:, plain words."
                value="${escapeHtml(searchFilter)}"
                oninput="onSearchInput(this)" onkeydown="onSearchKeyDown(event)"
                onfocus="onSearchFocus()" onblur="onSearchBlur(event)"
                onchange="onSearchFilterChanged(this.value)" onsearch="onSearchFilterChanged(this.value)">
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
    var itemsHtml = `
        <div class="dropdown-item${notebookFilter ? "" : " -current"}" onclick="onDropdownItemClicked(event, 'notebookFilterChanged', '')">
            <span class="dropdown-label">All notebooks</span>
        </div>
    `
    for (var notebook of notebooks){
        var isCurrent = notebook.id === notebookFilter
        if (isCurrent) currentLabel = notebook.path
        itemsHtml += `
            <div class="dropdown-item${isCurrent ? " -current" : ""}" onclick="onDropdownItemClicked(event, 'notebookFilterChanged', '${escapeHtml(notebook.id)}')">
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
    scheduleRefresh()
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
        scheduleRefresh()
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
        scheduleRefresh()
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
    scheduleRefresh()
}

/** pickNotebook ************************************************************************************************************************************
 * Asks the user to choose a notebook and returns its ID, or null when cancelled. With includeRoot, "(top level)" is offered and returned as an      *
 * empty string.                                                                                                                                    *
 ***************************************************************************************************************************************************/
async function pickNotebook(promptTitle, includeRoot = false){
    var notebooks = [...(await getNotebookMap()).values()].sort((first, second) => String(first.path).localeCompare(String(second.path)))
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
    scheduleRefresh()
}

/** sanitizeCss *************************************************************************************************************************************
 * Prevents the user's custom CSS from closing the style element it is placed in                                                                    *
 ***************************************************************************************************************************************************/
function sanitizeCss(customCss){
    return String(customCss || "").replace(/<\/(style)/gi, "<\\/$1")
}
