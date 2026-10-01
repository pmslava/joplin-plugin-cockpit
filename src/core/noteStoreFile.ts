/** README ******************************************************************************************************************************************
 * THE NOTE STORE'S FILE (2.7.1) - where the mirror waits between two launches, on desktop only. noteStore.ts decides WHEN a save is written and    *
 * WHETHER a saved mirror may be trusted (see PERSISTENCE in its README); this file only knows WHERE the mirror lives and HOW it is read and        *
 * written, the way database.ts keeps the file system out of the profile logic.                                                                     *
 *                                                                                                                                                  *
 * WHERE. <dataDir>/noteStore.v1.json, dataDir being joplin.plugins.dataDir(): a directory per Joplin profile (<profile>/plugin-data/<plugin id> in *
 * 3.6.14), so two profiles never share a mirror. The name carries the format's version, and so does the content (format: 1).                       *
 *                                                                                                                                                  *
 * DESKTOP ONLY. The file system reaches a plugin through joplin.require("fs-extra"), which the mobile app does not have (platform.ts). So the      *
 * question is asked once per session: mobile first (isMobile, whose answer is cached from startup, so it costs no call), then fs-extra, then the   *
 * data directory. When any of them says no, nothing is read, written or asked again, and the store behaves exactly as 2.7.0 did: built from the    *
 * listing at every launch.                                                                                                                         *
 *                                                                                                                                                  *
 * WRITTEN ATOMICALLY. The JSON goes to a sibling temporary name and is then renamed over the file, so a crash or a full disk in the middle of a    *
 * write leaves the previous file whole rather than half of a new one. Writes are queued one after another, so two saves never share the temporary  *
 * name, and a write that fails rejects to its caller without blocking the next.                                                                    *
 *                                                                                                                                                  *
 * WHO WROTE IT. Beside the plugin's version, a file records the app's (appVersionText in platform.ts, the version the startup already read) and    *
 * the client's: Joplin's clientId, a private setting kept in the profile's database.sqlite and generated only when that database has none, so a    *
 * database copied from another machine or profile brings its own. Both are read once with the rest of this answer, and a restore needs both to     *
 * match:                                                                                                                                           *
 * - another clientId is another database under this profile's directory, whose feed the saved cursor means nothing to;                             *
 * - another app version is one rebuild per Joplin update, cheap insurance against a migration that rewrites note fields without writing feed rows. *
 *                                                                                                                                                  *
 * WHAT A READ ANSWERS. { content } for a file that parses and has the shape a restore needs - format 1, written by this very plugin version, on    *
 * this app version and this client, a cursor of digits as a string, an array of notes - or { reason } for why there is nothing to restore: no      *
 * file, a file that cannot be read, one that does not parse (which is removed, so it costs nothing at the next launch either), another format,     *
 * another plugin version, another client, another app version, a malformed one. Any of those but the unparsable one is left in place: the first    *
 * save of the session replaces it. Whether the content is still TRUE is not this file's question; noteStore.ts asks the change feed (restoreRun).  *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { appVersionText, isMobile, requireNodeModule } from "./platform";

/** Constants **************************************************************************************************************************************/
export const storeFileName = "noteStore.v1.json"
export const storeFileFormat = 1
// The running plugin's version, from the manifest webpack bundles in: a file written by any other version is not restored.
export const pluginVersion = String(require("../manifest.json").version)

/** State ******************************************************************************************************************************************/
// The one answer to "can this app keep a file, where, and for whom": the promise of { fs, directory, path, temporaryPath, clientId, appVersion }, or
// of null. Taken on the first ask.
var accessRead = null
// The write in progress, which the next one queues behind.
var writeQueue: Promise<any> = Promise.resolve()

/** storeFileAccess *********************************************************************************************************************************
 * Whether this app can keep the store's file, where, and who writes it: { fs, directory, path, temporaryPath, clientId, appVersion }, or null on   *
 * mobile, without fs-extra, or when the data directory cannot be had. A clientId that cannot be read is "", and so is an app version: a file then  *
 * records "" and is restored only by a launch that reads "" too. Asked once per session; never rejects.                                            *
 ***************************************************************************************************************************************************/
export function storeFileAccess(){
    if (!accessRead) accessRead = openFileAccess()
    return accessRead
}

async function openFileAccess(){
    try {
        if (await isMobile()) return null
        var fs = requireNodeModule("fs-extra", "writeFile")
        if (!fs) return null
        var dataDir = await joplin.plugins.dataDir()
        if (typeof dataDir !== "string" || !dataDir) return null
        var separator = dataDir.indexOf("\\") >= 0 ? "\\" : "/"
        var directory = dataDir.replace(/[\\/]+$/, "")
        var filePath = directory + separator + storeFileName
        var clientId = ""
        try {
            clientId = String((await joplin.settings.globalValue("clientId")) || "")
        } catch (error) {
            // No such setting in this app: the file records "", and the check below compares "" with "".
        }
        var appVersion = await appVersionText()
        return { fs: fs, directory: directory, path: filePath, temporaryPath: filePath + ".tmp", clientId: clientId, appVersion: appVersion }
    } catch (error) {
        console.warn("Cockpit: the note store's file cannot be kept in this app, so the store is built at every launch", error)
        return null
    }
}

/** readStoreFile ***********************************************************************************************************************************
 * The saved store, read and checked for shape (see the README): { content } or { reason }. An unparsable file is removed. Never rejects.           *
 ***************************************************************************************************************************************************/
export async function readStoreFile(access){
    var text
    try {
        text = await access.fs.readFile(access.path, "utf8")
    } catch (error) {
        return { reason: error && error.code === "ENOENT" ? "no saved store" : "unreadable file" }
    }
    var content
    try {
        content = JSON.parse(text)
    } catch (error) {
        await removeStoreFile(access)
        return { reason: "unparsable file" }
    }
    if (!content || typeof content !== "object") return { reason: "malformed file" }
    if (content.format !== storeFileFormat) return { reason: "other format" }
    if (content.pluginVersion !== pluginVersion) return { reason: "other plugin version" }
    if (content.clientId !== access.clientId) return { reason: "another client" }
    if (content.appVersion !== access.appVersion) return { reason: "another app version" }
    if (typeof content.cursor !== "string" || !/^\d+$/.test(content.cursor) || !Array.isArray(content.notes)) return { reason: "malformed file" }
    return { content: content }
}

/** writeStoreFile **********************************************************************************************************************************
 * Writes the serialised store atomically (a temporary sibling, then a rename over the file), queued behind any write still in progress. Answers    *
 * the size of the file it left; rejects when any step fails, leaving the previous file as it was.                                                  *
 ***************************************************************************************************************************************************/
export function writeStoreFile(access, text){
    var write = writeQueue.then(async () => {
        await access.fs.ensureDir(access.directory)
        await access.fs.writeFile(access.temporaryPath, text, "utf8")
        await access.fs.rename(access.temporaryPath, access.path)
        var stats = await access.fs.stat(access.path)
        return stats.size
    })
    writeQueue = write.catch(() => null)
    return write
}

/** removeStoreFile *********************************************************************************************************************************
 * Removes the store's file, quietly: a file that cannot be removed is one the next read finds unparsable again, which costs nothing but the read.  *
 ***************************************************************************************************************************************************/
async function removeStoreFile(access){
    try {
        await access.fs.remove(access.path)
    } catch (error) {
        console.warn("Cockpit: could not remove the note store's unparsable file", error)
    }
}
