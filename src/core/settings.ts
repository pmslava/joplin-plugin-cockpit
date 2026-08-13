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

/** Variable Setup *********************************************************************************************************************************/
export const customCssSettingKey = "customCss"
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
			iconName: 'fas fa-calendar',
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
	})
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

/** setCustomCss ************************************************************************************************************************************
 * Saves the custom CSS that is applied to the panel																								*
 ***************************************************************************************************************************************************/
export async function setCustomCss(customCss){
	await joplin.settings.setValue(customCssSettingKey, customCss || "")
}
