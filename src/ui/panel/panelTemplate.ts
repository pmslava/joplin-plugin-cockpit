/** README ******************************************************************************************************************************************
 * The markup of the agenda panel. It is kept in a TypeScript file rather than an HTML file because reading the plugin directory needs fs-extra,     *
 * which is only available on desktop.                                                                                                              *
 ***************************************************************************************************************************************************/

export var panelTemplate = `
    <style><<CUSTOM_CSS>></style>
    <<CONTROLS>>
    <section class="todos"><<TODOS>></section>
`
