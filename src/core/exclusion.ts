/** README ******************************************************************************************************************************************
 * The "Excluded notebooks" feature, kept as import-free pure helpers so the low-level data layer (joplin.ts), the panel and settings can all use it   *
 * without importing one another. The owner's requirement: the user types notebooks by NAME (easy), but exclusion is stored and evaluated by notebook  *
 * ID, so renaming a notebook never breaks it. The visible comma-separated names field is only an entry/display surface; the hidden id list is the      *
 * single source of truth for every exclusion decision.                                                                                               *
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
 * The label the visible field should show for a resolved id: its bare title when that title is unique, otherwise its full "Parent / Child" path so    *
 * the user can tell duplicate-titled notebooks apart.                                                                                                 *
 ***************************************************************************************************************************************************/
export function canonicalLabel(map, id){
    var notebook = map.get(id)
    if (!notebook) return null
    return titleIsAmbiguous(map, notebook.title) ? notebook.path : notebook.title
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
 * Resolves the visible names field to { ids, canonicalText }. Each entry is resolved case-insensitively (title, or Parent/Sub path); a bare title      *
 * matching several notebooks contributes all of them. The canonical text is rebuilt from the resolved ids (path form where a bare title is ambiguous), *
 * with any entry that resolved to nothing kept verbatim so the user can still see and fix their typo.                                                  *
 ***************************************************************************************************************************************************/
export function resolveNamesToIds(map, raw){
    var entries = String(raw || "").split(",").map(part => part.trim()).filter(Boolean)
    var ids = []
    var seenIds = new Set()
    var labelParts = []
    for (var entry of entries){
        var matches = resolveEntry(map, entry)
        if (!matches.length){
            labelParts.push(entry)                 // unresolvable: kept verbatim so the typo is visible
            continue
        }
        for (var id of matches){
            if (seenIds.has(id)) continue
            seenIds.add(id)
            ids.push(id)
            labelParts.push(canonicalLabel(map, id))
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
        var label = canonicalLabel(map, id)
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
