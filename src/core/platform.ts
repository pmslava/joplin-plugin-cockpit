/** README ******************************************************************************************************************************************
 * This file contains helpers to detect which Joplin app the plugin is running in.                                                                  *
 * Parts of the plugin API (menus, the note toolbar) and all node modules (fs-extra, sqlite3) are desktop only, so the plugin has to know where it   *
 * is running before it registers those features.                                                                                                   *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";

/** Variable Setup *********************************************************************************************************************************/
var cachedPlatform = null
// The app's version as joplin.versionInfo() answered it at startup (detectPlatform), or "" when it did not: appVersionText below.
var cachedAppVersion = ""

/** getPlatform *************************************************************************************************************************************
 * Returns the name of the platform the plugin is running on. This is usually "desktop" or "mobile". The result is cached as it cannot change while  *
 * the plugin is loaded.                                                                                                                            *
 ***************************************************************************************************************************************************/
export async function getPlatform(){
    if (cachedPlatform == null){
        cachedPlatform = await detectPlatform()
    }
    return cachedPlatform
}

/** isMobile ****************************************************************************************************************************************
 * Returns true when the plugin is running in the Joplin mobile app (including its web build)                                                       *
 ***************************************************************************************************************************************************/
export async function isMobile(){
    return (await getPlatform()) == "mobile"
}

/** detectPlatform **********************************************************************************************************************************
 * Works out the current platform. joplin.versionInfo() reports it directly on every app version that supports mobile plugins. Older desktop         *
 * versions do not report it, so the presence of a working node module is used as a fallback.                                                       *
 ***************************************************************************************************************************************************/
async function detectPlatform(){
    try {
        var versionInfo = await joplin.versionInfo() as any
        if (versionInfo && versionInfo.version) cachedAppVersion = String(versionInfo.version)
        if (versionInfo && typeof versionInfo.platform == "string"){
            return versionInfo.platform
        }
    } catch (error) {
        console.warn("Cockpit: could not read the app version info", error)
    }
    return requireNodeModule("fs-extra", "readFile") ? "desktop" : "mobile"
}

/** appVersionText (2.7.1) **************************************************************************************************************************
 * The app's version as text ("3.6.14"), from the read detectPlatform made at startup - so it costs no call of its own - or "" when that read       *
 * failed. The saved note store records it and is not restored by another (noteStoreFile.ts): one rebuild per Joplin update, against a migration    *
 * that rewrites note fields without writing feed rows.                                                                                             *
 ***************************************************************************************************************************************************/
export async function appVersionText(){
    await getPlatform()
    return cachedAppVersion
}

// The app version's one read (appVersionAtLeast below): the promise of [major, minor, patch], or of null, taken on the first ask.
var appVersionRead = null

/** appVersionAtLeast (2.7.1) ***********************************************************************************************************************
 * Whether the running app is the given release or a later one, as [major, minor, patch]. The version is read once per session - one read-and-call  *
 * of joplin.versionInfo(), whose answer cannot change while the plugin is loaded - and shared by every later ask. A version that cannot be read or *
 * parsed answers false, so a caller gating new behaviour on a release keeps the old behaviour when it cannot tell.                                 *
 ***************************************************************************************************************************************************/
export async function appVersionAtLeast(wanted){
    if (!appVersionRead) appVersionRead = readAppVersion()
    var version = await appVersionRead
    if (!version) return false
    for (var index = 0; index < 3; index++){
        if (version[index] !== wanted[index]) return version[index] > wanted[index]
    }
    return true
}

async function readAppVersion(){
    try {
        var versionInfo = await joplin.versionInfo() as any
        var parts = /^(\d+)\.(\d+)\.(\d+)/.exec(String(versionInfo && versionInfo.version ? versionInfo.version : ""))
        return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : null
    } catch (error) {
        console.warn("Cockpit: could not read the app version", error)
        return null
    }
}

/** requireNodeModule *******************************************************************************************************************************
 * Loads one of the node modules that Joplin exposes to plugins, and returns null when it is not usable. joplin.require() is a desktop only API: on  *
 * mobile it resolves to a promise rather than a module, so the returned value is checked for a member that the real module is known to have.        *
 ***************************************************************************************************************************************************/
export function requireNodeModule(moduleName, expectedMember){
    try {
        var module = joplin.require(moduleName)
        if (module && typeof module[expectedMember] == "function"){
            return module
        }
    } catch (error) {
        // joplin.require throws on platforms where the module is unavailable
    }
    return null
}
