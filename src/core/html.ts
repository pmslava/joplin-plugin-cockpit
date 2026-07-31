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
