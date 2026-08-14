/** README ******************************************************************************************************************************************
 * The markup of the Cockpit panel. It is kept in a TypeScript file rather than an HTML file because reading the plugin directory needs fs-extra,    *
 * which is only available on desktop.                                                                                                              *
 ***************************************************************************************************************************************************/

export var panelTemplate = `
    <style><<THEME_CSS>><<CUSTOM_CSS>></style>
    <<ROOT_MARKER>>
    <<CONTROLS>>
    <section class="todos" data-scroll-top="<<SCROLL_TOP>>" data-render-nonce="<<RENDER_NONCE>>"><<TODOS>></section>
    <<OVERLAY_STATE>>
`
