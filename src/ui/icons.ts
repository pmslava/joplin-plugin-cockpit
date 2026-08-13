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
    notePlus: svgIcon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zm-3-7V3.5L18.5 9H13z"),
    sort: svgIcon("M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"),
    arrowUp: svgIcon("M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"),
    arrowDown: svgIcon("M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"),
    todoPlus: svgIcon("M22 5.18 10.59 16.6l-4.24-4.24 1.41-1.41 2.83 2.83L20.59 3.76 22 5.18zm-2.21 5.04c.13.57.21 1.17.21 1.78 0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8c1.58 0 3.04.46 4.28 1.25l1.44-1.44A9.9 9.9 0 0 0 12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10c0-1.19-.22-2.33-.6-3.39l-1.61 1.61zM19 15h-2v2h-2v2h2v2h2v-2h2v-2h-2v-2z"),
}

/** iconButton **************************************************************************************************************************************
 * Returns the markup for a clickable icon. A real button element is used so that the control is reachable by keyboard and large enough to tap.      *
 ***************************************************************************************************************************************************/
export function iconButton(iconName, title, onClick, extraClass = ""){
    return `<button type="button" class="icon-button${extraClass ? ` ${extraClass}` : ""}" title="${title}" aria-label="${title}" onclick="${onClick}">${icons[iconName]}</button>`
}
