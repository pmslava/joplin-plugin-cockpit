/** README ******************************************************************************************************************************************
 * This file contains all functions related to settings configuration and management.																*
 * Settings are also where Cockpit keeps the data that used to live on disk: the profile list and the custom panel CSS. The plugin API for settings	*
 * works the same on desktop and mobile, whereas the file system is desktop only.																	*
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { SettingItemType } from "api/types"
import { getAllProfiles, getProfile, profileDataSettingKey } from "./database"
import { setupTimer } from "./timer"

/** Variable Setup *********************************************************************************************************************************/
export const customCssSettingKey = "customCss"
export const updateFrequencySettingKey = "updateFrequency"
export const dayStartTimeSettingKey = "dayStartTime"

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
		"showProfileControls": {
			label: "Show Profile Controls",
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: 'section',
		},
		[updateFrequencySettingKey]: {
			label: "How many seconds should agenda wait before updating the panel and notes",
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
	})
	await joplin.settings.onChange(async (event) => {
		if (event && event.keys && !event.keys.includes(updateFrequencySettingKey)) return
		await setupTimer()
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
