/** README ******************************************************************************************************************************************
 * The "Excluded notebooks" feature, kept as import-free pure helpers so the low-level data layer (joplin.ts), the panel and settings can all use it   *
 * without importing one another. The owner's requirement: the user types notebooks by NAME (easy), but exclusion is stored and evaluated by notebook  *
 * ID, so renaming a notebook never breaks it. The visible comma-separated names field is only an entry/display surface; the hidden id list is the      *
 * single source of truth for every exclusion decision.                                                                                               *
 *                                                                                                                                                    *
 * THE FIELD SHOWS BOTH: "Lab / Joplin (fdfd6c06), Archive (a1b2c3d4)". The name is what a person recognises, the short id is what Cockpit is holding   *
 * on to - so a field pointed at the wrong one of two same-named notebooks says so at a glance. It still PARSES BACK: the user goes on typing plain     *
 * names, paths or ids, and a " (id)" Cockpit wrote is read as the id it names (see resolveTypedEntry, and shortID for why the id is shortened).        *
 *                                                                                                                                                    *
 * Every function here takes the notebook map (Map<id,{id,title,path,parentID}>, path = "Parent / Child") as a parameter rather than fetching it, so    *
 * this module stays a leaf with no dependency on joplin.ts (which would be circular).                                                                 *
 ***************************************************************************************************************************************************/

/** Setting keys ***********************************************************************************************************************************
 * Defined here (a leaf module) rather than in settings.ts so joplin.ts can read the id list by key without importing settings.ts (which pulls in the  *
 * timer -> panel -> joplin chain).                                                                                                                    *
 ***************************************************************************************************************************************************/
export const EXCLUDED_NOTEBOOKS_KEY = "excludedNotebooks"
export const EXCLUDED_NOTEBOOK_IDS_KEY = "excludedNotebookIds"

/** normalizeSegment / normalizePathKey ********************************************************************************************************
 * Case-insensitive, whitespace-tolerant comparison keys. A path key collapses both "Parent / Child" (the map's rendered path) and a user-typed        *
 * "Parent/Sub" to the same "parent/child", so the two forms match.                                                                                    *
 ***************************************************************************************************************************************************/
function normalizeSegment(value){
    return String(value || "").trim().toLowerCase()
}
function normalizePathKey(value){
    return String(value || "").split("/").map(normalizeSegment).filter(Boolean).join("/")
}

/** parseExcludedIds *******************************************************************************************************************************
 * The hidden id setting (comma-separated folder ids) as a clean array. Empty in, empty out - which is how the whole feature switches off.             *
 ***************************************************************************************************************************************************/
export function parseExcludedIds(raw){
    return String(raw || "").split(",").map(part => part.trim()).filter(Boolean)
}

/** The short id, shared with the settings note *****************************************************************************************************
 * src/core/shortId.js: one pure, dependency-free leaf (the same UMD shape as horizons.js) holding the whole display form - how an id is shortened for *
 * a single-line setting box, and how a " (id)" is read back out of one. Required rather than reimplemented so the notebook field and the settings     *
 * note cannot drift apart on what the brackets mean.                                                                                                 *
 ***************************************************************************************************************************************************/
const { shortID, splitDisplayID } = require("./shortId")

/** A full Joplin folder id, as the user pastes it: 32 hex characters. */
var FULL_ID_PATTERN = /^[0-9a-f]{32}$/

/** idsWithPrefix **********************************************************************************************************************************
 * The notebook ids in the map that begin with this (already lower-cased) prefix. The parse side's whole question: a bracketed group is only an id     *
 * when it actually names something here.                                                                                                             *
 ***************************************************************************************************************************************************/
function idsWithPrefix(map, prefix){
    var out = []
    if (!prefix) return out
    for (var id of map.keys()){
        if (String(id).toLowerCase().indexOf(prefix) === 0) out.push(id)
    }
    return out
}

/** resolveEntry ***********************************************************************************************************************************
 * The notebook ids a single typed entry resolves to. An entry containing "/" is treated as a path and matched against the notebook's full breadcrumb; *
 * a bare entry is matched against the title. Matching is case-insensitive, and a bare title carried by several notebooks resolves to ALL of them.      *
 ***************************************************************************************************************************************************/
export function resolveEntry(map, entry){
    var text = String(entry || "").trim()
    if (!text) return []
    var ids = []
    if (text.includes("/")){
        var wantPath = normalizePathKey(text)
        for (var notebook of map.values()){
            if (normalizePathKey(notebook.path) === wantPath) ids.push(notebook.id)
        }
    } else {
        var wantTitle = normalizeSegment(text)
        for (var candidate of map.values()){
            if (normalizeSegment(candidate.title) === wantTitle) ids.push(candidate.id)
        }
    }
    return ids
}

/** titleIsAmbiguous *******************************************************************************************************************************
 * Whether more than one notebook in the map carries the given title (so a bare title cannot uniquely identify a notebook, and its canonical label      *
 * must fall back to the full path).                                                                                                                   *
 ***************************************************************************************************************************************************/
function titleIsAmbiguous(map, title){
    var key = normalizeSegment(title)
    var count = 0
    for (var notebook of map.values()){
        if (normalizeSegment(notebook.title) === key){
            count++
            if (count > 1) return true
        }
    }
    return false
}

/** canonicalLabel *********************************************************************************************************************************
 * The NAME half of the label: the notebook's bare title when that title is unique, otherwise its full "Parent / Child" path so the user can tell      *
 * duplicate-titled notebooks apart. What the field actually shows is displayLabel below, which is this plus the id.                                    *
 ***************************************************************************************************************************************************/
export function canonicalLabel(map, id){
    var notebook = map.get(id)
    if (!notebook) return null
    return titleIsAmbiguous(map, notebook.title) ? notebook.path : notebook.title
}

/** displayLabel ***********************************************************************************************************************************
 * WHAT THE USER READS IN THE FIELD: the name (or the Parent / Sub path) followed by the short id in brackets - "Lab / Joplin (fdfd6c06)". The name is *
 * the part a person recognises and the id is what Cockpit is actually holding on to, so a field pointed at the wrong one of two same-named notebooks   *
 * says so at a glance instead of looking right. Falls back to the bare name for an id that cannot be shown in a form the parser would take back.       *
 *                                                                                                                                                     *
 * NOTHING THAT CANNOT BE READ BACK IS EVER WRITTEN, which is what the blank-title case is about. A notebook with no title at all would give the label  *
 * " (e1e1e1e1)", and the parser refuses that - it wants a non-blank name in front of the brackets - so the id would be dropped by the very next        *
 * resolve pass and the exclusion silently lost. Writing the bare empty label loses it just as surely (the entry disappears from the comma list). With  *
 * no name to show, the entry is therefore THE FULL ID: the one string that names such a notebook and survives being read back.                         *
 ***************************************************************************************************************************************************/
export function displayLabel(map, id){
    var label = canonicalLabel(map, id)
    if (label == null) return null
    var short = shortID(id, map.keys())
    if (!short) return label
    if (!String(label).trim()) return FULL_ID_PATTERN.test(String(id).toLowerCase()) ? String(id) : label
    return label + " (" + short + ")"
}

/** resolveTypedEntry ******************************************************************************************************************************
 * ONE entry of the visible field, read back to notebook ids - the display form included, so re-reading what Cockpit wrote does not lose the reference. *
 *                                                                                                                                                     *
 * A trailing " (<6-32 hex>)" is stripped ONLY when what is in the brackets is a prefix of an id THIS MAP ACTUALLY HOLDS; otherwise the whole entry is  *
 * the name, so a notebook genuinely titled "Budget (deadbeef)" keeps working. When the stripped prefix names exactly one notebook, THAT ID WINS over   *
 * the name in front of it: the user may not have re-typed the field since the notebook was renamed, and the id is the thing that was true. A prefix    *
 * several notebooks share settles nothing, so the name part is resolved exactly as it always was.                                                      *
 *                                                                                                                                                     *
 * A BARE FULL ID is an entry in its own right, and has to be: the field now PRINTS ids, so a user who wants to be exact will paste one, and the        *
 * setting's own description offers it. It is matched against the map rather than against titles (resolveEntry only ever knew names and paths), and     *
 * comes back rewritten as "Name (short id)" like everything else. An unknown 32-hex string matches nothing and is kept verbatim, like any typo.        *
 ***************************************************************************************************************************************************/
function resolveTypedEntry(map, entry){
    var text = String(entry || "").trim()
    if (!text) return []
    var split = splitDisplayID(text)
    if (split){
        var hits = idsWithPrefix(map, split.id)
        if (hits.length === 1) return hits
        if (hits.length > 1) return resolveEntry(map, split.name)
    }
    var pasted = text.toLowerCase()
    if (FULL_ID_PATTERN.test(pasted)){
        // A 32-character prefix match IS an exact match, so this is the one lookup rather than a second spelling of it.
        var exact = idsWithPrefix(map, pasted)
        if (exact.length === 1) return exact
    }
    return resolveEntry(map, text)
}

/** dedupeLabels ***********************************************************************************************************************************
 * Joins label parts with ", ", dropping later duplicates (case-insensitively) while preserving first-seen order.                                      *
 ***************************************************************************************************************************************************/
function dedupeLabels(parts){
    var out = []
    var seen = new Set()
    for (var part of parts){
        var key = String(part).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(part)
    }
    return out.join(", ")
}

/** resolveNamesToIds ******************************************************************************************************************************
 * Resolves the visible names field to { ids, canonicalText }. Each entry is resolved case-insensitively (title, Parent/Sub path, or the "Name (id)"   *
 * display form Cockpit itself writes - see resolveTypedEntry); a bare title matching several notebooks contributes all of them. The canonical text is  *
 * rebuilt from the resolved ids (path form where a bare title is ambiguous, each with its short id), with any entry that resolved to nothing kept      *
 * verbatim - and unadorned, there being no id to show - so the user can still see and fix their typo.                                                  *
 ***************************************************************************************************************************************************/
export function resolveNamesToIds(map, raw){
    var entries = String(raw || "").split(",").map(part => part.trim()).filter(Boolean)
    var ids = []
    var seenIds = new Set()
    var labelParts = []
    for (var entry of entries){
        var matches = resolveTypedEntry(map, entry)
        if (!matches.length){
            labelParts.push(entry)                 // unresolvable: kept verbatim so the typo is visible, and with no id to show
            continue
        }
        for (var id of matches){
            if (seenIds.has(id)) continue
            seenIds.add(id)
            ids.push(id)
            labelParts.push(displayLabel(map, id))
        }
    }
    return { ids: ids, canonicalText: dedupeLabels(labelParts) }
}

/** canonicalTextFromIds ***************************************************************************************************************************
 * Rebuilds the visible names field from stored ids, used to refresh the display after an excluded notebook is renamed or moved (its id, and therefore  *
 * its exclusion, is unchanged; only the shown title needs updating). Ids no longer present in the map are skipped.                                     *
 ***************************************************************************************************************************************************/
export function canonicalTextFromIds(map, ids){
    var parts = []
    for (var id of ids){
        var label = displayLabel(map, id)
        if (label != null) parts.push(label)
    }
    return dedupeLabels(parts)
}

/** excludedDescendantIdSet ************************************************************************************************************************
 * The excluded ids together with every notebook nested under them, computed from the CURRENT map so a sub-notebook created later under an excluded     *
 * parent is caught. This is the authority the client-side filter uses over every result set before counts and rendering.                              *
 ***************************************************************************************************************************************************/
export function excludedDescendantIdSet(map, ids){
    var set = new Set(ids.filter(id => map.has(id)))
    if (!set.size) return set
    var addedNew = true
    while (addedNew){
        addedNew = false
        for (var notebook of map.values()){
            if (!set.has(notebook.id) && notebook.parentID && set.has(notebook.parentID)){
                set.add(notebook.id)
                addedNew = true
            }
        }
    }
    return set
}

/** buildExclusionClauses **************************************************************************************************************************
 * The server-side "-notebook:\"Title\"" clauses for the excluded ids. Joplin's negated notebook filter is recursive (it removes the notebook and all   *
 * its descendants) but matches by TITLE, so a clause is emitted only when the excluded notebook's title is NOT also carried by a non-excluded notebook  *
 * - otherwise it would over-exclude the innocent namesake. A title carrying a quote (which cannot be embedded in the quoted filter) is skipped too.     *
 * Whatever is omitted here is still removed by the id-based client filter, which is the real authority; these clauses are only an optimisation that     *
 * keeps the server from shipping rows that are about to be dropped.                                                                                    *
 ***************************************************************************************************************************************************/
export function buildExclusionClauses(map, ids){
    var excludedSet = new Set(ids.filter(id => map.has(id)))
    if (!excludedSet.size) return ""
    // Titles carried by at least one KEPT notebook must never be used as a server clause.
    var keptTitles = new Set()
    for (var kept of map.values()){
        if (!excludedSet.has(kept.id)) keptTitles.add(normalizeSegment(kept.title))
    }
    var clauses = []
    var usedTitles = new Set()
    for (var id of excludedSet){
        var notebook = map.get(id)
        if (!notebook) continue
        var title = String(notebook.title || "")
        var key = normalizeSegment(title)
        if (!title || title.includes('"')) continue      // cannot be safely quoted - rely on the client filter
        if (keptTitles.has(key)) continue                 // shared with a kept notebook - would over-exclude
        if (usedTitles.has(key)) continue
        usedTitles.add(key)
        clauses.push(`-notebook:"${title}"`)
    }
    return clauses.join(" ")
}
