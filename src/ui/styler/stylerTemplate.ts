/** README ******************************************************************************************************************************************
 * The markup of the panel styler dialog. It is kept in a TypeScript file rather than an HTML file because reading the plugin directory needs        *
 * fs-extra, which is only available on desktop.                                                                                                    *
 ***************************************************************************************************************************************************/

export var stylerTemplate = `
    <form name="customCSSForm">
        <fieldset>
            <legend>Custom CSS</legend>
            <textarea id="cssTextArea" name="customCss" rows="16" spellcheck="false"><<CSS_DATA>></textarea>
        </fieldset>
    </form>
`
