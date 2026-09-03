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
import { EXCLUDED_NOTEBOOKS_KEY, EXCLUDED_NOTEBOOK_IDS_KEY, resolveNamesToIds } from "./exclusion"
import { getNotebookMap, invalidateNotebookMap, invalidateResultCaches } from "./joplin"

/** Variable Setup *********************************************************************************************************************************/
export const customCssSettingKey = "customCss"
export const showToolbarButtonSettingKey = "showToolbarButton"
export const hideDueDateOnBellSettingKey = "hideDueDateOnBell"
export const bellOpensCockpitPickerSettingKey = "bellOpensCockpitPicker"
export const gestureTraceSettingKey = "gestureTrace"
export const updateFrequencySettingKey = "updateFrequency"
export const dayStartTimeSettingKey = "dayStartTime"

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
			// OFF, joplin.settings.value() still reads it and it still rides the search-data island - it simply
			// never appears in Settings › Plugins › Cockpit. Every piece of the machinery behind it (panel.ts's
			// island field, panelWebview.js's traceGesture/refreshGestureTraceFlag and the codes MOBILE.md §7
			// lists) is untouched and inert. A future device round re-enables it in a DEV BUILD by turning the
			// public flag below back on, rebuilding and sideloading - see docs/MOBILE.md §7. (Written that way
			// on purpose: the harness pin reads this whole block and refuses the enabled spelling inside it.)
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
			description: "Clicking the bell in the note title bar opens Cockpit's alarm picker - the calendar, the time columns and the quick buttons - instead of Joplin's own prompt. Desktop and the Markdown editor only, as no plugin code runs in the window with the Rich Text editor. The Note menu's Set alarm item and its keyboard shortcut keep Joplin's picker. Takes effect after Joplin restarts, since Joplin cannot register an editor content script while running.",
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
		[EXCLUDED_NOTEBOOKS_KEY]: {
			label: "Excluded notebooks",
			description: "Comma-separated notebook names to hide from Cockpit everywhere: search results, panel rows, checkbox counts, the overview notes and the notebook filter/picker. Sub-notebooks of an excluded notebook are hidden too. To pick one of several notebooks that share a name, give a Parent/Sub path. Entries are resolved to the notebooks themselves and tracked internally by id, so renaming a notebook later keeps the exclusion working. Leave empty to turn the feature off.",
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
	})
}

/** resolveExcludedNotebooks ************************************************************************************************************************
 * Turns the visible, human-typed names field into the hidden id list that every exclusion decision reads, and canonicalises the visible field in       *
 * return. Each entry is resolved case-insensitively against the current notebook map (a bare title, or a Parent/Sub path to disambiguate duplicate     *
 * titles; a bare title matching several notebooks resolves to all of them). Unresolvable entries are kept verbatim so a typo stays visible. Both        *
 * writes are guarded by a value comparison so the setValue that re-enters this handler settles immediately instead of looping, and the caches are       *
 * cleared and the interfaces re-rendered only when something actually changed.                                                                         *
 ***************************************************************************************************************************************************/
async function resolveExcludedNotebooks(){
	var raw = String(await joplin.settings.value(EXCLUDED_NOTEBOOKS_KEY) || "")
	var map = await getNotebookMap()
	var resolved = resolveNamesToIds(map, raw)
	var idsCsv = resolved.ids.join(",")
	var changed = false
	// The hidden id list keys off the visible field only, so writing it does not re-enter this handler.
	if (idsCsv !== String(await joplin.settings.value(EXCLUDED_NOTEBOOK_IDS_KEY) || "")){
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
