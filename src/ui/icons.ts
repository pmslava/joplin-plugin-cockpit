/** README ******************************************************************************************************************************************
 * The icons used by the panel. They are inlined as SVG rather than taken from Font Awesome because Joplin does not load an icon font into plugin    *
 * webviews on mobile, which would leave the panel buttons blank.                                                                                    *
 ***************************************************************************************************************************************************/

/** svgIcon *****************************************************************************************************************************************
 * Wraps the given SVG path data in an SVG element that takes its size and colour from the surrounding text                                          *
 ***************************************************************************************************************************************************/
function svgIcon(pathData){
    return `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="${pathData}"/></svg>`
}

/** icons *******************************************************************************************************************************************
 * The icon markup, keyed by name                                                                                                                   *
 ***************************************************************************************************************************************************/
export var icons = {
    refresh: svgIcon("M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"),
    plus: svgIcon("M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"),
    edit: svgIcon("M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"),
    trash: svgIcon("M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"),
    sliders: svgIcon("M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"),
    brush: svgIcon("M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1a1.5 1.5 0 0 1 1.11-2.5H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8zM6.5 12a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"),
    chevronLeft: svgIcon("M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"),
    chevronRight: svgIcon("M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"),
    note: svgIcon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM13 9V3.5L18.5 9H13zM7.5 11h9v1.8h-9zM7.5 14.6h9v1.8h-9zM7.5 18.2h5v1.8h-5z"),
    // A ring with a checkmark inside, not a sheet of paper: the panel's own glyph language uses circles and
    // rings for to-dos (every row carries one), so the create button now says "to-do" the same way instead of
    // borrowing the note icon's document silhouette. Drawn as one path in three subpaths - outer circle, inner
    // circle wound the other way to punch the ring open, then the check - so the shared svgIcon() wrapper (one
    // `d`, fill:currentColor, no stroke) still applies and the glyph inherits colour and size like every other.
    // The ring is 2 units thick against the note icon's 1.8-unit rules, so at button size the pair reads as one
    // family; the check clears the inner edge by ~1.5 units, which keeps them apart down to 18px.
    todo: svgIcon("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM16.05 8 10.2 13.85 8 11.65 6.4 13.25l3.8 3.8 7.45-7.45z"),
    // The quick-filter group (2.10). Circles for to-dos and squares for the checkboxes inside a note, which is how
    // the panel already tells the two apart; the three squares share one 18-unit outline (x 3..21, corner radius 3,
    // 2 units thick like the `todo` ring), so at 1.1em they read as one family and differ only in what is inside.
    // Completed to-dos: a filled disc the size of the `todo` ring with the tick knocked out of it, the row's own
    // completed look (a filled disc, white tick). The knock-out is the tick subpath wound against the disc, so the
    // nonzero rule clears it to the background; it is 2.6 units thick, heavier than a positive stroke, because a
    // negative line reads thinner, and sits 0.4 up from the disc's centre to balance its low vertex.
    todoCompleted: svgIcon("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM8.12 10.78 10.5 13.16 15.88 7.78 17.72 9.62 10.5 16.84 6.28 12.62z"),
    // Items with an open checkbox: the empty square of a markdown "[ ]". Outer rounded square, then the inner one
    // (radius 1) wound the other way to punch it open, exactly as the `todo` ring is cut.
    checkboxOpen: svgIcon("M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM6 5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"),
    // Items whose checkboxes are all done: the same square with a 2-unit tick inside, clearing the inner edge by at
    // least 1.5 units on every side so the tick stays apart from the outline down to 16px.
    checkboxDone: svgIcon("M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM6 5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM8.01 11.19 10.5 13.69 15.99 8.19 17.41 9.61 10.5 16.51 6.59 12.61z"),
    // Items without checkboxes: the same square struck through, bottom-left to top-right, with a 2-unit bar whose
    // ends run into the outline's rounded corners. A bar floating inside the square read as a slash or a pencil at
    // 16px and one poking past the corners left stray pixels; corner to corner reads as "crossed out". The bar is
    // wound WITH the outer square, so where it overlaps the outline the winding stays nonzero and nothing is cut.
    checkboxNone: svgIcon("M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM6 5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM3.79 18.79 18.79 3.79 20.21 5.21 5.21 20.21z"),
}

/** iconButton **************************************************************************************************************************************
 * Returns the markup for a clickable icon. A real button element is used so that the control is reachable by keyboard and large enough to tap.      *
 ***************************************************************************************************************************************************/
export function iconButton(iconName, title, onClick, extraClass = ""){
    return `<button type="button" class="icon-button${extraClass ? ` ${extraClass}` : ""}" title="${title}" aria-label="${title}" onclick="${onClick}">${icons[iconName]}</button>`
}
