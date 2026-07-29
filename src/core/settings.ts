/** README ******************************************************************************************************************************************
 * This file contains all functions related to settings configuration and management.																*
 * Settings are also where Agenda keeps the data that used to live on disk: the profile list and the custom panel CSS. The plugin API for settings	*
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

/** setupSettings ***********************************************************************************************************************************
 * Sets up the settings used by the plugin. This must run before the profile database is loaded, as the profiles are stored in a setting.			*
 ***************************************************************************************************************************************************/
export async function setupSettings(){
	await joplin.settings.registerSection(
		"section", {
			label: "Agenda",
			iconName: 'fas fa-calendar',
			description: "Settings for the Agenda Plugin",
			name: "agenda"
		})
	await joplin.settings.registerSettings({
		"currentProfileID": {
			label: "The ID of the current profile used by Agenda",
			value: null,
			type: SettingItemType.Int,
			public: false,
			section: 'section',
		},
		[profileDataSettingKey]: {
			label: "The Agenda profiles, stored as JSON",
			value: "",
			type: SettingItemType.String,
			public: false,
			section: 'section',
		},
		[customCssSettingKey]: {
			label: "Custom CSS applied to the Agenda panel",
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
