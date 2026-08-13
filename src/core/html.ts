/** README ******************************************************************************************************************************************
 * Small HTML helpers shared by the formats and the calendar views. They live in their own file so that both can use them without importing each      *
 * other.                                                                                                                                           *
 ***************************************************************************************************************************************************/

/** escapeHtml **************************************************************************************************************************************
 * Escapes the characters that would otherwise be interpreted as markup, so that to-do titles and profile names containing characters such as & or < *
 * are displayed as written                                                                                                                         *
 ***************************************************************************************************************************************************/
export function escapeHtml(value){
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/** dropTargetAttributes ****************************************************************************************************************************
 * The attributes that make an element accept dropped to-dos. The target is either a YYYY-MM-DD date the dropped to-dos become due on, or "clear"    *
 * to remove their due dates. Returns an empty string for no target, so it can be interpolated unconditionally.                                     *
 ***************************************************************************************************************************************************/
export function dropTargetAttributes(target){
    if (!target) return ""
    return ` data-drop="${escapeHtml(target)}" ondragover="onDropTargetOver(event)" ondragleave="onDropTargetLeave(event)" ondrop="onTodoDropped(event)"`
}

/** headingContextAttributes ************************************************************************************************************************
 * The attributes that make a group heading open the set alarm dialog for every to-do in its group on right click. Returns an empty string when the  *
 * group is empty, so it can be interpolated unconditionally.                                                                                       *
 ***************************************************************************************************************************************************/
export function headingContextAttributes(todoIDs){
    if (!todoIDs || !todoIDs.length) return ""
    return ` data-todo-ids="${escapeHtml(todoIDs.join(","))}" oncontextmenu="onHeadingContextMenu(event)"`
}
