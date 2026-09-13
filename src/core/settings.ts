/** README ******************************************************************************************************************************************
 * This file contains all functions related to settings configuration and management.																*
 * Settings are also where Cockpit keeps the data that used to live on disk: the profile list and the custom panel CSS. The plugin API for settings	*
 * works the same on desktop and mobile, whereas the file system is desktop only.																	*
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { SettingItemType } from "api/types"
import { getAllProfiles, getProfile, profileDataSettingKey } from "./database"
import { refreshInterfaces, setupTimer } from "./timer"
import { EXCLUDED_NOTEBOOKS_KEY, EXCLUDED_NOTEBOOK_IDS_KEY, canonicalTextForStoredIds, parseExcludedIds, resolveNamesToIds } from "./exclusion"
import { getNotebookMap, invalidateNotebookMap, invalidateResultCaches } from "./joplin"
import { dropUnshowableNotebookFilter } from "../ui/panel/panel"
import { isSettingsNoteConnected, onSettingsNoteReferenceChanged, scheduleSettingsNoteWrite } from "./settingsSync"
// The synced key list lives with the note format it belongs to (src/core/settingsNote.js, pure and harness-tested), so
// the handler below and the payload builder can never drift apart on which settings actually travel.
const { SYNCED_SETTING_KEYS } = require("./settingsNote")

/** Variable Setup *********************************************************************************************************************************/
export const customCssSettingKey = "customCss"
export const showToolbarButtonSettingKey = "showToolbarButton"
export const hideDueDateOnBellSettingKey = "hideDueDateOnBell"
export const bellOpensCockpitPickerSettingKey = "bellOpensCockpitPicker"
export const gestureTraceSettingKey = "gestureTrace"
/** The gesture trace's ONE switch. A shipping build must never show the diagnostic strip, whatever a profile happens
 * to have stored, so every reader of gestureTraceSettingKey is gated on this constant and startup resets a stored
 * true back to false (resetUnavailableGestureTrace below). FOR A DEVICE ROUND, IN A DEV BUILD: flip this to true -
 * and, if the toggle should also be reachable from the Settings screen, set public: true on the registration below -
 * then `npm run dist` and sideload. Never commit either flip; with the constant true the harness pins that hold the
 * trace unavailable fail by design. See docs/MOBILE.md §7. */
export const gestureTraceAvailable: boolean = false
export const updateFrequencySettingKey = "updateFrequency"
export const dayStartTimeSettingKey = "dayStartTime"
/** The settings note (src/core/settingsSync.ts). Empty means the feature is off, which is how every install starts. */
export const settingsNoteIdSettingKey = "settingsNoteId"
/** The full 32-character id of the note the visible field names - the source of truth for every read and write of the settings note, exactly as
 * excludedNotebookIds is for the excluded notebooks. The visible field is the user's input AND the display; the id it shows is the whole id, but
 * it is never what a note is looked up by (a field written by 2.6.1 holds only the first eight characters of one, and the display form is text a
 * user can edit either way). Managed by Cockpit; see resolveSettingsNoteReference in settingsSync.ts. */
export const settingsNoteResolvedIdSettingKey = "settingsNoteResolvedId"

/** Theme settings keys. The themes feature (src/core/theme.ts) reads these to build the panel's --cockpit-* override block. */
export const themeModeSettingKey = "themeMode"
export const completedTodoStyleSettingKey = "completedTodoStyle"
export const customFontSizeSettingKey = "customFontSize"
export const customCircleSizeSettingKey = "customCircleSize"
export const customTextColorSettingKey = "customTextColor"
export const customPanelBackgroundSettingKey = "customPanelBackground"
export const customContentBackgroundSettingKey = "customContentBackground"
export const customCheckboxColorSettingKey = "customCheckboxColor"
export const customProgressColorSettingKey = "customProgressColor"
export const customDividerColorSettingKey = "customDividerColor"

/** The theme settings that, when changed, need the panel re-rendered. */
const themeSettingKeys = [
	themeModeSettingKey,
	completedTodoStyleSettingKey,
	customFontSizeSettingKey,
	customCircleSizeSettingKey,
	customTextColorSettingKey,
	customPanelBackgroundSettingKey,
	customContentBackgroundSettingKey,
	customCheckboxColorSettingKey,
	customProgressColorSettingKey,
	customDividerColorSettingKey,
]

/** setupSettings ***********************************************************************************************************************************
 * Sets up the settings used by the plugin. This must run before the profile database is loaded, as the profiles are stored in a setting.			*
 ***************************************************************************************************************************************************/
export async function setupSettings(){
	await joplin.settings.registerSection(
		"section", {
			label: "Cockpit",
			iconName: 'fas fa-tachometer-alt',
			description: "Settings for the Cockpit Plugin",
			name: "agenda"
		})
	await joplin.settings.registerSettings({
		"currentProfileID": {
			label: "The ID of the current profile used by Cockpit",
			value: null,
			type: SettingItemType.Int,
			public: false,
			section: 'section',
		},
		[profileDataSettingKey]: {
			label: "The Cockpit profiles, stored as JSON",
			value: "",
			type: SettingItemType.String,
			public: false,
			section: 'section',
		},
		[customCssSettingKey]: {
			label: "Custom CSS applied to the Cockpit panel",
			value: "",
			type: SettingItemType.String,
			public: false,
			section: 'section',
		},
		[updateFrequencySettingKey]: {
			label: "Panel refresh interval (seconds)",
			description: "How long Cockpit waits between refreshing the panel and the overview notes. Lower is more responsive; higher is lighter on the machine.",
			value: 60,
			type: SettingItemType.Int,
			public: true,
			section: 'section',
		},
		[gestureTraceSettingKey]: {
			// HIDDEN, not removed. The mobile drag rounds are done (2.3.0) and the trace has no place on a user's
			// Settings screen, so it is registered with public: false: Joplin keeps the value, the default stays
			// OFF, and it never appears in Settings › Plugins › Cockpit. Every piece of the machinery behind it
			// (panel.ts's island field, panelWebview.js's traceGesture/refreshGestureTraceFlag and the codes
			// MOBILE.md §7 lists) is untouched and inert. Hiding the toggle was NOT enough on its own (2.5.1):
			// a profile that turned the trace on while it was public kept its stored true, and the strip stayed
			// up on the owner's Pixel with no switch left to turn it off. So the value is no longer what decides
			// anything - gestureTraceAvailable above is, every reader is gated on it, and startup writes a stored
			// true back to false. A device round flips that constant in a dev build (and this public flag too, if
			// the toggle is wanted in Settings); neither flip is ever committed - see docs/MOBILE.md §7. (Written
			// that way on purpose: the harness pin reads this whole block and refuses the enabled spelling in it.)
			label: "Show a touch-gesture trace in the search suggestions (diagnostic)",
			description: "Mobile only, and only while the search suggestion list is open: replaces the list's hint line with the last few touch events (press, hold, cancel, context menu, why the list closed). Leave this off - it exists so a touch problem on a real device can be reported precisely instead of guessed at.",
			value: false,
			type: SettingItemType.Bool,
			public: false,
			section: 'section',
		},
		[showToolbarButtonSettingKey]: {
			label: "Show the Cockpit button in the note toolbar",
			description: "Shows the Cockpit panel toggle button (the gauge icon) in the note editor toolbar. Desktop only. Takes effect after Joplin restarts, since Joplin cannot add or remove a toolbar button while running.",
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: 'section',
		},
		[hideDueDateOnBellSettingKey]: {
			label: "Hide the due date next to the bell in the note title bar and show it on hover",
			description: "When a to-do has an alarm, Joplin prints the due date as text beside the bell in the note title bar, and that text eats the space the title has. This hides it and shows it instead as a small bubble under the bell while the pointer is over the bell. Desktop only. Takes effect after Joplin restarts, since Joplin cannot unload a stylesheet it has already loaded.",
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: 'section',
		},
		[bellOpensCockpitPickerSettingKey]: {
			label: "Open Cockpit's date picker instead of Joplin's when the alarm bell is clicked",
			description: "Clicking the bell in the note title bar opens Cockpit's alarm picker - the calendar, the time columns and the quick buttons - instead of Joplin's own prompt. Desktop and the Markdown editor only, as no plugin code runs in the window with the Rich Text editor. The Note menu's Set alarm item and its keyboard shortcut keep Joplin's picker. Takes effect after Joplin restarts, since Joplin registers editor content scripts only at startup and cannot unregister one afterwards.",
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: 'section',
		},
		"panelSortField": {
			label: "How the panel breaks ties between items sharing a due time: title, updated or created",
			value: "title",
			type: SettingItemType.String,
			public: false,
			section: 'section',
		},
		"panelSortDirection": {
			label: "The direction of the panel's tie-break sorting: asc or desc",
			value: "asc",
			type: SettingItemType.String,
			public: false,
			section: 'section',
		},
		[dayStartTimeSettingKey]: {
			label: "Day start time (HH:MM). A to-do dragged onto a day without a time of its own becomes due at this time",
			value: "09:00",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[settingsNoteIdSettingKey]: {
			label: "Settings note",
			description: "Type Joplin Cockpit Plugin Settings here. Cockpit creates that note if it does not exist yet, or connects to it if it has already synced in from another device - so on a second device, sync first, then type the same title. A note id or link also works. Once connected, the field shows the note as Name (id), the brackets holding the note's full id: that is how Cockpit tells two notes of the same name apart. Leave empty to keep everything on this device. Synced: profiles, custom panel CSS, theme colours, completed-to-do style, day start time and excluded notebooks. Per device: font and circle sizes, refresh interval, toolbar button, title-bar options and which profile is selected.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[settingsNoteResolvedIdSettingKey]: {
			// The full id of the note the visible field above names: the single source of truth for every read and
			// write of the settings note. A bracketed id cannot be resolved back to a note without scanning every
			// note there is, so the field's display form is checked against this. Managed by Cockpit; not shown.
			label: "The resolved id of the settings note (managed by Cockpit)",
			value: "",
			type: SettingItemType.String,
			public: false,
			section: 'section',
		},
		[EXCLUDED_NOTEBOOKS_KEY]: {
			label: "Excluded notebooks",
			description: "Comma-separated notebooks to hide from Cockpit everywhere: search results, panel rows, checkbox counts, the overview notes and the notebook filter/picker. Sub-notebooks of an excluded notebook are hidden too. Type a name, a Parent/Sub path, or a notebook id. Cockpit rewrites each entry as Name (id), the brackets holding the notebook's full id: that is how it tells two notebooks of the same name apart, and it keeps tracking the notebook by that id, so renaming it later keeps the exclusion working. Leave empty to turn the feature off.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[EXCLUDED_NOTEBOOK_IDS_KEY]: {
			// The single source of truth for every exclusion decision: the resolved folder ids, comma
			// separated. Managed by Cockpit from the visible names field above; not shown to the user.
			label: "The resolved ids of the excluded notebooks (managed by Cockpit)",
			value: "",
			type: SettingItemType.String,
			public: false,
			section: 'section',
		},
		[themeModeSettingKey]: {
			label: "Cockpit panel theme",
			description: "How the Cockpit panel is coloured. Applies to the Cockpit panel only, not the rest of Joplin.",
			value: "matchJoplin",
			type: SettingItemType.String,
			isEnum: true,
			options: {
				matchJoplin: "Match Joplin theme",
				light: "Preset — Light",
				dark: "Preset — Dark",
				solarizedLight: "Preset — Solarized Light",
				solarizedDark: "Preset — Solarized Dark",
				nord: "Preset — Nord",
				aritimDark: "Preset — Aritim Dark",
				oledDark: "Preset — OLED Dark",
				custom: "Custom",
			},
			public: true,
			section: 'section',
		},
		[completedTodoStyleSettingKey]: {
			label: "Completed to-dos",
			description: "How a completed to-do's title looks in the Cockpit panel. Applies in every theme mode.",
			value: "asNow",
			type: SettingItemType.String,
			isEnum: true,
			options: {
				asNow: "Normal",
				grayed: "Grayed out",
				strikethrough: "Strikethrough",
				grayedStrikethrough: "Grayed strikethrough",
			},
			public: true,
			section: 'section',
		},
		[customFontSizeSettingKey]: {
			label: "Panel font size (px, 0 = match Joplin)",
			description: "The Cockpit panel's base font size in pixels. 0 follows the Joplin font size. Applies in every theme mode.",
			value: 0,
			type: SettingItemType.Int,
			minimum: 0,
			maximum: 32,
			step: 1,
			public: true,
			section: 'section',
		},
		[customCircleSizeSettingKey]: {
			label: "To-do circle size (px)",
			description: "The diameter of the round to-do checkbox and the note progress ring in the Cockpit panel. The ring and disc keep a constant fine weight at any size; the circle stays centred on the first line of the row. Applies in every theme mode.",
			value: 18,
			type: SettingItemType.Int,
			minimum: 16,
			maximum: 36,
			step: 1,
			public: true,
			section: 'section',
		},
		[customTextColorSettingKey]: {
			label: "Custom: text colour",
			description: "Any CSS colour (e.g. #1D2024, rgb(29,32,36)). Leave empty to follow the Joplin theme. Used only when the theme is Custom.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[customPanelBackgroundSettingKey]: {
			label: "Custom: panel background",
			description: "Any CSS colour (e.g. #1D2024, rgb(29,32,36)). Leave empty to follow the Joplin theme. Used only when the theme is Custom.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[customContentBackgroundSettingKey]: {
			label: "Custom: menu/popup background",
			description: "Background of dropdowns, the context menu and option lists. Any CSS colour. Leave empty to follow the Joplin theme. Used only when the theme is Custom.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[customCheckboxColorSettingKey]: {
			label: "Custom: to-do checkbox colour",
			description: "The colour of a ticked to-do's disc and tick. Any CSS colour. Leave empty to follow the Joplin theme. Used only when the theme is Custom.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[customProgressColorSettingKey]: {
			label: "Custom: progress-ring fill colour",
			description: "The colour of the checkbox-progress ring around an item. Any CSS colour. Leave empty to follow the Joplin theme. Used only when the theme is Custom.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
		[customDividerColorSettingKey]: {
			label: "Custom: divider/border colour",
			description: "Any CSS colour (e.g. #1D2024, rgb(29,32,36)). Leave empty to follow the Joplin theme. Used only when the theme is Custom.",
			value: "",
			type: SettingItemType.String,
			public: true,
			section: 'section',
		},
	})
	// The stored value is reconciled with the build BEFORE the change handler is registered, so the one write this
	// can make does not re-enter the handler below (which has nothing to say about this key anyway).
	await resetUnavailableGestureTrace()
	await joplin.settings.onChange(async (event) => {
		var keys = event && event.keys ? event.keys : []
		if (keys.includes(updateFrequencySettingKey)) await setupTimer()
		// A theme setting change needs the panel redrawn. buildThemeCss is rebuilt inside
		// refreshPanelData, so the new colours reach the markup and get past its equality guard.
		if (keys.some(key => themeSettingKeys.includes(key))) await refreshInterfaces()
		// The user edited the visible "Excluded notebooks" names field: resolve the names to ids (the source
		// of truth), rewrite the field to the canonical resolved titles, and re-render everything so the
		// exclusion takes effect at once.
		if (keys.includes(EXCLUDED_NOTEBOOKS_KEY)) await resolveExcludedNotebooks()
		// The settings note (v2.6.0). A change to anything that TRAVELS schedules a debounced write of the note; a change to the
		// note reference itself repoints the whole feature. Both are no-ops while the reference is empty, which is how it ships.
		if (keys.some(key => SYNCED_SETTING_KEYS.includes(key))) scheduleSettingsNoteWrite()
		if (keys.includes(settingsNoteIdSettingKey)) await onSettingsNoteReferenceChanged()
	})
}

/** resetUnavailableGestureTrace *******************************************************************************************************************
 * Switches the hidden gesture trace back off in any profile that still has it stored ON. From 1.9.10 to 2.2.1 the setting was public, so a device	*
 * round could leave a real profile with a stored true; 2.3.0 then hid the toggle, which took away the only way to turn it back off and left the		*
 * owner's Pixel showing the diagnostic strip for good. A build where the trace is unavailable therefore heals the value at startup instead of		*
 * merely ignoring it. The readers are gated on gestureTraceAvailable as well, so a stale true cannot reach the webview even before this write		*
 * lands. In a dev build (gestureTraceAvailable true) this does nothing and the stored value is honoured as it always was.							*
 ***************************************************************************************************************************************************/
export async function resetUnavailableGestureTrace(){
	if (gestureTraceAvailable) return
	if (!(await joplin.settings.value(gestureTraceSettingKey))) return
	await joplin.settings.setValue(gestureTraceSettingKey, false)
	console.info("Cockpit: the hidden gesture trace was still stored ON in this profile - switched off, as this build does not offer it.")
}

/** refreshExcludedNotebookDisplay ******************************************************************************************************************
 * THE STARTUP PASS, and the whole of the owner's second 2.6.1 defect: his Excluded notebooks field still read "Archive", with no id in it at all,     *
 * however many times he restarted Joplin.                                                                                                            *
 *                                                                                                                                                    *
 * The visible text had exactly two rewrite sites and NEITHER of them runs at startup. resolveExcludedNotebooks below is reached only from the settings *
 * onChange handler, so it needs the user to edit that very field; reconcileExcludedNotebookText (src/ui/panel/panel.ts) is reached only from the folder *
 * poll, and only when the folder signature CHANGES - the first poll of a session merely records the baseline and returns. So an install that already   *
 * held "Archive" went on holding it until the user either retyped the setting or created, renamed or deleted a notebook. The Settings note field       *
 * looked fixed for the same reason in reverse: its own startup read is what rewrites it.                                                              *
 *                                                                                                                                                    *
 * NOTHING NOBODY ASKED FOR MAY CHANGE WHAT IS EXCLUDED, which is why this is not simply resolveExcludedNotebooks under another name. That function     *
 * reads the TEXT and writes the IDS, which is right when the user has just typed in the box and wrong when nobody has touched anything: a name goes    *
 * stale on its own - another device renames the notebook while this one is closed - and resolving the stale name DELETES the exclusion and, with a     *
 * settings note connected, publishes the deletion to every device a debounce later. If a different notebook has taken the freed name, it moves the     *
 * exclusion onto that one instead; if the name has merely become ambiguous, it adds an exclusion nobody asked for. So this pass is ID-AUTHORITATIVE:   *
 * the stored ids are read and never written, and only the visible text is rebuilt around them (canonicalTextForStoredIds in exclusion.ts, which keeps  *
 * the text of an id it cannot label - the keep-rule's half - and the user's own typos, verbatim). That is also what makes it rename-proof, and it is   *
 * the direction the folder poll's reconcile has always worked in.                                                                                     *
 *                                                                                                                                                    *
 * It pays for itself only when there is something to do: with the field empty and no ids stored (which is how the feature ships, and how it stays for  *
 * anyone who never turns it on) it returns before the notebook map is asked for, so an install without the feature makes not one data call for it.     *
 * The one write it can make re-enters the onChange handler, whose resolver reads the text it has just been given - built from the stored ids, in the    *
 * form this build writes - and resolves it straight back to those same ids, so the pair settles on the first pass.                                     *
 ***************************************************************************************************************************************************/
export async function refreshExcludedNotebookDisplay(){
	var raw = String(await joplin.settings.value(EXCLUDED_NOTEBOOKS_KEY) || "")
	var storedIdsCsv = String(await joplin.settings.value(EXCLUDED_NOTEBOOK_IDS_KEY) || "")
	if (!raw && !storedIdsCsv) return
	var map = await getNotebookMap()
	var text = canonicalTextForStoredIds(map, parseExcludedIds(storedIdsCsv), raw)
	if (text !== raw) await joplin.settings.setValue(EXCLUDED_NOTEBOOKS_KEY, text)
}

/** resolveExcludedNotebooks ************************************************************************************************************************
 * Turns the visible, human-typed names field into the hidden id list that every exclusion decision reads, and canonicalises the visible field in       *
 * return. Each entry is resolved case-insensitively against the current notebook map (a bare title, a Parent/Sub path to disambiguate duplicate        *
 * titles, a full id, or the "Name (id)" display form Cockpit itself writes - a short one written by 2.6.1 included; a bare title matching several       *
 * notebooks resolves to all of them). Unresolvable entries are kept verbatim so a typo stays visible. Both writes are guarded by a value comparison     *
 * so the setValue that re-enters this handler settles immediately instead of looping, and the caches are cleared and the interfaces re-rendered only    *
 * when something actually changed.                                                                                                                     *
 *                                                                                                                                                      *
 * While a settings note is connected, a stored id whose notebook is not in the map is KEPT rather than resolved away - see the block below, which is    *
 * what stops an exclusion being deleted on every device by whichever device has not synced that notebook yet.                                           *
 ***************************************************************************************************************************************************/
async function resolveExcludedNotebooks(){
	var raw = String(await joplin.settings.value(EXCLUDED_NOTEBOOKS_KEY) || "")
	var map = await getNotebookMap()
	var resolved = resolveNamesToIds(map, raw)
	var storedIdsCsv = String(await joplin.settings.value(EXCLUDED_NOTEBOOK_IDS_KEY) || "")
	var ids = resolved.ids
	// AN ID THIS DEVICE CANNOT SEE YET IS KEPT, NOT DROPPED - but only while a settings note is carrying the exclusion between devices.
	//
	// The pair (ids + names) arrives from another device as one payload, and notebook ids are the same on every device of one account. A
	// receiving device that has not yet synced the notebook itself - or that is inside the notebook map's own 20s TTL - resolves the name
	// to nothing, and publishing THAT back deletes the exclusion on every device, permanently. The names field already keeps an entry it
	// cannot resolve verbatim, so keeping the matching id leaves the pair byte-identical to what arrived and nothing is written at all.
	//
	// With no settings note configured this does not apply and the old behaviour stands: the id list is purely local, a notebook that is
	// gone is gone, and tidying the pair is right.
	if (isSettingsNoteConnected()){
		for (var storedId of parseExcludedIds(storedIdsCsv)){
			if (map.has(storedId) || ids.includes(storedId)) continue
			ids = ids.concat([storedId])
		}
	}
	var idsCsv = ids.join(",")
	var changed = false
	// The hidden id list keys off the visible field only, so writing it does not re-enter this handler.
	if (idsCsv !== storedIdsCsv){
		await joplin.settings.setValue(EXCLUDED_NOTEBOOK_IDS_KEY, idsCsv)
		changed = true
	}
	// Writing the canonical text re-enters this handler, but on that pass raw already equals canonicalText and
	// the ids already match, so nothing is written and the recursion stops (the loop guard).
	if (resolved.canonicalText !== raw){
		await joplin.settings.setValue(EXCLUDED_NOTEBOOKS_KEY, resolved.canonicalText)
		changed = true
	}
	if (changed){
		// The cached result sets were computed without this exclusion (or with a previous one), so they must
		// not be reused; the notebook map is dropped too so the filter/picker rebuild.
		invalidateResultCaches()
		invalidateNotebookMap()
		// The panel may be pointed AT the notebook that was just excluded. Leaving it there would give the
		// panel a filter its own dropdown cannot show - an empty list under an "All notebooks" label, and a
		// New note created into the excluded notebook without asking. Dropped before the repaint below, so
		// the render that follows already lists everything. After invalidateNotebookMap, so the check reads
		// the fresh map rather than the one the exclusion was made against.
		await dropUnshowableNotebookFilter()
		await refreshInterfaces()
	}
}

/** setCurrentProfileID *****************************************************************************************************************************
 * Saves the current profile ID to settings																											*
 ***************************************************************************************************************************************************/
export async function setCurrentProfileID(profileID){
	await joplin.settings.setValue("currentProfileID", Number(profileID))
}

/** getCurrentProfileID *****************************************************************************************************************************
 * Gets the currently selected profile ID from settings and check that it is valid. If it empty or points to an invalid profile, the first profile	*
 * in the database is selected as the new current profile.																							*																									*
 ***************************************************************************************************************************************************/
export async function getCurrentProfileID(){
	var currentProfileID = await joplin.settings.value("currentProfileID")
	var currentProfile = await getProfile(currentProfileID)
	if (!currentProfile){
		currentProfileID = (await getAllProfiles())[0].id
		await setCurrentProfileID(currentProfileID)
	}
	return currentProfileID
}

/** getDayStartTime *********************************************************************************************************************************
 * The configured start of the day as { hours, minutes }, falling back to 09:00 when the setting cannot be parsed									*
 ***************************************************************************************************************************************************/
export async function getDayStartTime(){
	var value = await joplin.settings.value(dayStartTimeSettingKey)
	var match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim())
	if (!match) return { hours: 9, minutes: 0 }
	return { hours: Math.min(23, Number(match[1])), minutes: Math.min(59, Number(match[2])) }
}

/** getCustomCss ************************************************************************************************************************************
 * Gets the custom CSS that is applied to the panel																									*
 ***************************************************************************************************************************************************/
export async function getCustomCss(){
	return await joplin.settings.value(customCssSettingKey) || ""
}

/** isToolbarButtonEnabled **************************************************************************************************************************
 * Whether the Cockpit toolbar button should be created at startup																					*
 ***************************************************************************************************************************************************/
export async function isToolbarButtonEnabled(){
	return await joplin.settings.value(showToolbarButtonSettingKey)
}

/** isDueDateOnHoverEnabled ************************************************************************************************************************
 * Whether the chrome stylesheet that hides the bell's due-date text (and shows it on hover) should be loaded at startup							*
 ***************************************************************************************************************************************************/
export async function isDueDateOnHoverEnabled(){
	return await joplin.settings.value(hideDueDateOnBellSettingKey)
}

/** isBellPickerEnabled *****************************************************************************************************************************
 * Whether the editor content script that hands the title bar's bell click to Cockpit's alarm dialog should be registered at startup				*
 ***************************************************************************************************************************************************/
export async function isBellPickerEnabled(){
	return await joplin.settings.value(bellOpensCockpitPickerSettingKey)
}

/** setCustomCss ************************************************************************************************************************************
 * Saves the custom CSS that is applied to the panel																								*
 ***************************************************************************************************************************************************/
export async function setCustomCss(customCss){
	await joplin.settings.setValue(customCssSettingKey, customCss || "")
}
