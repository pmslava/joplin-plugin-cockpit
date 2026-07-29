/** README ******************************************************************************************************************************************
 * This file contains all functions involved in managing the agenda profile database.                                                               *
 * Profiles are stored as a JSON document in a private plugin setting. Earlier versions of Agenda used an sqlite3 database in the plugin data        *
 * directory, but neither sqlite3 nor the file system is available to plugins on mobile, so that database is imported into the setting the first     *
 * time this version runs and is then left untouched.                                                                                               *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { requireNodeModule } from "./platform";

/** Variable Setup *********************************************************************************************************************************/
export const profileDataSettingKey = "profileData"
const legacyDatabaseFileName = "profiles.sqlite3"
// Agenda up to 3.x was published under this plugin id. Joplin gives every plugin id its own data
// directory, so an install of that version left its database in a directory of its own.
const legacyPluginID = "com.gitlab.BeatLink.joplin-plugin-agenda"
var profileStore = null
var migrationWarning = null

/** profileDefaults *********************************************************************************************************************************
 * The values a profile is created with, and the values used for any field missing from a stored profile                                            *
 ***************************************************************************************************************************************************/
const profileDefaults = {
    name: "New Profile",
    searchCriteria: "",
    noteID: "",
    showCompleted: false,
    showNoDue: false,
    displayFormat: "interval",
    yearFormat: "numeric",
    monthFormat: "long",
    dayFormat: "numeric",
    weekdayFormat: "long",
    timeIs12Hour: true,
    sortOrder: 0,
    noDueDatesAtEnd: false,
}

/** createProfile ***********************************************************************************************************************************
 * Creates a new profile with default settings. The ID of the created profile is returned                                                           *
 ***************************************************************************************************************************************************/
export async function createProfile(){
    var id = profileStore.nextID++
    profileStore.profiles.push({ ...profileDefaults, id: id })
    await saveProfileStore()
    return id
}

/** getAllProfiles **********************************************************************************************************************************
 * Gets all profiles, ordered by sort order and then by name                                                                                        *
 ***************************************************************************************************************************************************/
export async function getAllProfiles(){
    return profileStore.profiles.slice().sort((first, second) => {
        if (first.sortOrder != second.sortOrder) return first.sortOrder - second.sortOrder
        return String(first.name).localeCompare(String(second.name))
    })
}

/** getProfile ***************************************************************************************************************************************
 * Gets the profile for the corresponding profile ID, or null when there is no such profile                                                         *
 ***************************************************************************************************************************************************/
export async function getProfile(profileID){
    var id = Number(profileID)
    if (!Number.isFinite(id)) return null
    return profileStore.profiles.find(profile => profile.id === id) || null
}

/** UpdateProfile ***********************************************************************************************************************************
 * Updates a profile when given the profile ID and profile dict                                                                                     *
 ***************************************************************************************************************************************************/
export async function updateProfile(id, profile){
    var storedProfile = await getProfile(id)
    if (!storedProfile) return
    Object.assign(storedProfile, normalizeProfile(profile, storedProfile.id))
    await saveProfileStore()
}

/** deleteProfile ***********************************************************************************************************************************
 * Deletes the profile for the corresponding ID, so long as its not the last profile                                                                *
 ***************************************************************************************************************************************************/
export async function deleteProfile(id){
    if (profileStore.profiles.length <= 1){
        throw new Error("At least one profile must be in the database");
    }
    var profileID = Number(id)
    profileStore.profiles = profileStore.profiles.filter(profile => profile.id !== profileID)
    await saveProfileStore()
}

/** setupDatabase ***********************************************************************************************************************************
 * Loads the profiles from settings, importing them from the legacy sqlite3 database when there is nothing stored yet. This should run at plugin     *
 * startup, after the settings have been registered.                                                                                                *
 ***************************************************************************************************************************************************/
export async function setupDatabase(){
    profileStore = await loadProfileStore()
    if (!profileStore){
        var migration = await importLegacyDatabase()
        profileStore = migration.profileStore
        migrationWarning = migration.warning
    }
    if (!profileStore){
        profileStore = { nextID: 1, profiles: [] }
    }
    if (profileStore.profiles.length < 1){
        await createProfile()
    } else {
        await saveProfileStore()
    }
}

/** reportDatabaseProblems **************************************************************************************************************************
 * Tells the user about a failed import of the legacy database. This runs after the rest of the plugin has started so that the message box does not  *
 * block startup.                                                                                                                                   *
 ***************************************************************************************************************************************************/
export async function reportDatabaseProblems(){
    if (!migrationWarning) return
    var warning = migrationWarning
    migrationWarning = null
    try {
        await joplin.views.dialogs.showMessageBox(warning)
    } catch (error) {
        console.error("Agenda:", warning, error)
    }
}

/** loadProfileStore ********************************************************************************************************************************
 * Reads the stored profiles from settings. Returns null when nothing valid is stored.                                                              *
 ***************************************************************************************************************************************************/
async function loadProfileStore(){
    var storedData = await joplin.settings.value(profileDataSettingKey)
    if (!storedData) return null
    try {
        return normalizeProfileStore(JSON.parse(storedData))
    } catch (error) {
        console.error("Agenda: the stored profile data could not be read", error)
        return null
    }
}

/** saveProfileStore ********************************************************************************************************************************
 * Writes the profiles back to settings                                                                                                             *
 ***************************************************************************************************************************************************/
async function saveProfileStore(){
    await joplin.settings.setValue(profileDataSettingKey, JSON.stringify(profileStore))
}

/** normalizeProfileStore ***************************************************************************************************************************
 * Makes sure a parsed profile store has the expected shape, that every profile has every field, and that the next ID does not collide with an       *
 * existing profile                                                                                                                                 *
 ***************************************************************************************************************************************************/
function normalizeProfileStore(parsedData){
    if (!parsedData || !Array.isArray(parsedData.profiles)) throw new Error("Profile data is not in the expected format")
    var nextID = Number(parsedData.nextID)
    if (!Number.isFinite(nextID) || nextID < 1) nextID = 1
    var profiles = []
    for (var storedProfile of parsedData.profiles){
        var id = Number(storedProfile ? storedProfile.id : NaN)
        if (!Number.isFinite(id)) id = nextID
        profiles.push(normalizeProfile(storedProfile, id))
        if (id >= nextID) nextID = id + 1
    }
    return { nextID: nextID, profiles: profiles }
}

/** normalizeProfile ********************************************************************************************************************************
 * Returns a profile containing every known field, with each value coerced to the type the rest of the plugin expects. Values arriving from the      *
 * profile editor are all strings or booleans, and values arriving from the legacy database use 0 and 1 for booleans.                                *
 ***************************************************************************************************************************************************/
function normalizeProfile(sourceProfile, id){
    var source = sourceProfile || {}
    var profile = { id: id }
    for (var key of Object.keys(profileDefaults)){
        var defaultValue = profileDefaults[key]
        var value = source[key]
        if (value === undefined || value === null){
            profile[key] = defaultValue
        } else if (typeof defaultValue == "boolean"){
            profile[key] = value !== false && value !== 0 && value !== "false" && value !== ""
        } else if (typeof defaultValue == "number"){
            var numericValue = Number(value)
            profile[key] = Number.isFinite(numericValue) ? numericValue : defaultValue
        } else {
            profile[key] = String(value)
        }
    }
    return profile
}

/** importLegacyDatabase ****************************************************************************************************************************
 * Imports the profiles from the sqlite3 database used by Agenda 3.x. This can only work on desktop, where sqlite3 and fs-extra are available. The   *
 * database file itself is left in place so that downgrading to an older version of Agenda still works.                                              *
 ***************************************************************************************************************************************************/
async function importLegacyDatabase(){
    var sqlite3 = requireNodeModule("sqlite3", "Database")
    var fs = requireNodeModule("fs-extra", "pathExists")
    if (!sqlite3 || !fs) return { profileStore: null, warning: null }

    var databasePath = await findLegacyDatabase(fs)
    if (!databasePath) return { profileStore: null, warning: null }

    try {
        var rows = await readLegacyProfiles(sqlite3, databasePath)
        console.info(`Agenda: imported ${rows.length} profile(s) from ${databasePath}`)
        return { profileStore: normalizeProfileStore({ nextID: 1, profiles: rows }), warning: null }
    } catch (error) {
        console.error("Agenda: could not import the profile database", error)
        return {
            profileStore: null,
            warning: `Agenda could not read your existing profiles from ${databasePath} (${error.message}). A new default profile has been created. The old database has not been modified.`,
        }
    }
}

/** findLegacyDatabase ******************************************************************************************************************************
 * Returns the path of the sqlite3 database left behind by an earlier version of Agenda, or null when there is none. Both this plugin's own data     *
 * directory and the one belonging to the plugin id Agenda used to be published under are looked in, so that the profiles of an existing install are *
 * still picked up.                                                                                                                                 *
 ***************************************************************************************************************************************************/
async function findLegacyDatabase(fs){
    var dataDir = await joplin.plugins.dataDir()
    var separator = dataDir.indexOf("\\") >= 0 ? "\\" : "/"
    var candidates = [dataDir + separator + legacyDatabaseFileName]
    var parentDir = dataDir.slice(0, dataDir.lastIndexOf(separator))
    if (parentDir && !dataDir.endsWith(separator + legacyPluginID)){
        candidates.push([parentDir, legacyPluginID, legacyDatabaseFileName].join(separator))
    }
    for (var candidate of candidates){
        if (await fs.pathExists(candidate)) return candidate
    }
    return null
}

/** readLegacyProfiles ******************************************************************************************************************************
 * Reads every row of the Profile table from the legacy sqlite3 database. sqlite3 has no async/await support, hence the promise wrapper.             *
 ***************************************************************************************************************************************************/
async function readLegacyProfiles(sqlite3, databasePath): Promise<any[]>{
    var database = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY)
    try {
        return await new Promise((resolve, reject) => {
            database.all(`SELECT * FROM Profile ORDER BY id ASC`, {}, (error, rows) => {
                error ? reject(error) : resolve(rows || [])
            })
        })
    } finally {
        try {
            database.close()
        } catch (error) {
            console.warn("Agenda: could not close the legacy profile database", error)
        }
    }
}
