/** README ******************************************************************************************************************************************
 * Cockpit's only editor content script. It exists for ONE reason: to take the click on the alarm bell in Joplin's note title bar before Joplin's    *
 * own handler sees it, so that Cockpit's alarm picker opens instead of Joplin's bare datetime prompt.                                               *
 *                                                                                                                                                  *
 * WHY A CODEMIRROR CONTENT SCRIPT, when nothing here touches the note body:                                                                         *
 * The note title bar is private React DOM. No plugin API reaches it, and Joplin's editAlarm command cannot be overridden either - registering a     *
 * declaration under that name REPLACES Joplin's entry, which drops its mapStateToTitle and so removes the due date from the button altogether.      *
 * A ContentScriptType.CodeMirrorPlugin script, however, is loaded by Joplin's PluginLoader as a plain <script> in the renderer document itself -    *
 * unsandboxed, in the same JS realm as Joplin's UI - so it can add a DOM listener to the title bar. The CodeMirror editor is only the vehicle that  *
 * gets this code into the window; it is not a panel and cannot be turned into one.                                                                  *
 *                                                                                                                                                  *
 * CONSEQUENCES, all deliberate and documented in the setting's description:                                                                         *
 *  - Markdown, Split and Viewer-only layouts all work, because Joplin's CM6 component renders its editor in each of them and only toggles the      *
 *    -show-editor/-show-viewer classes. Where that does not hold the script simply never mounts and the bell keeps Joplin's picker.                 *
 *  - The Rich Text (TinyMCE) editor has no CodeMirror instance, so no plugin JS runs in that window and the bell keeps Joplin's own picker.         *
 *  - Mobile is excluded by the plugin side, which registers this script on desktop only.                                                            *
 *                                                                                                                                                  *
 * THE THREE CONSTRAINTS THAT MAKE THE INTERCEPT CORRECT (see docs/DEVLOG.md, v2.5.0):                                                               *
 *  1. The listener is bound to .note-editor-wrapper, NEVER to the button. The bell's React key embeds the due-date text, so the button element is   *
 *     REMOUNTED every time the alarm changes and a listener bound to it would be thrown away by the first alarm the user sets.                      *
 *  2. The click is discriminated by closest('.note-title-info-group button.toolbar-button') AND by the bell's own icon span (.icon-alarm) - never   *
 *     by -has-title, which a to-do WITHOUT an alarm does not carry, and never by position, which would swallow the spellcheck, layout, properties    *
 *     and Cockpit's own gauge buttons.                                                                                                             *
 *  3. The listener runs in the CAPTURE phase and stops the event there. React 18 delegates onClick from a BUBBLE listener on its root container, so *
 *     a capture-phase stopPropagation() on an ancestor BELOW that root is what reliably keeps Joplin's editAlarm from running.                      *
 *                                                                                                                                                  *
 *  4. A listener whose editor has been destroyed stands aside (and unbinds itself). .note-editor-wrapper outlives the CodeMirror instance, so a   *
 *     Markdown -> Rich Text -> Markdown round trip leaves an older listener bound; since this listener stops the event, a stale one would win and  *
 *     post the note id it was destroyed on.                                                                                                       *
 *                                                                                                                                                  *
 * When anything is missing (no note id, a disabled bell, a destroyed editor, an unexpected DOM) the event is left ALONE, so the worst case is       *
 * Joplin's own picker.                                                                                                                             *
 ***************************************************************************************************************************************************/

/** Local typings ***********************************************************************************************************************************
 * Cockpit's bundled api/types.ts predates the CodeMirror editor typings (CodeMirrorControl, MarkdownEditorContentScriptModule, noteIdFacet), and    *
 * regenerating the whole API surface for an intercept that touches no editor state would be a large, unrelated diff. These minimal shapes describe  *
 * exactly the three things this script uses, and no @codemirror dependency is needed for any of them.                                               *
 ***************************************************************************************************************************************************/
interface TitleBarContext {
    postMessage: (message: any) => Promise<any>
}
interface TitleBarEditorView {
    dom?: HTMLElement
    state?: { facet: (facet: any) => any }
}
interface TitleBarEditorControl {
    editor?: TitleBarEditorView
    joplinExtensions?: { noteIdFacet?: any }
}

/** The plugin entry point: Joplin calls the default export with the context, then calls plugin() once per editor MOUNT. */
export default (context: TitleBarContext) => ({
    plugin: (editorControl: TitleBarEditorControl) => {
        var view = editorControl ? editorControl.editor : null
        if (!view || !view.dom) return
        // The stable ancestor. Constraint 1: never the button, which remounts on every alarm change.
        var root = view.dom.closest('.note-editor-wrapper') as HTMLElement
        if (!root) return

        // plugin() runs once per editor MOUNT, not once per note - switching notes reuses the same CodeMirror
        // instance - so the open note's id is read from the facet AT CLICK TIME, never captured here.
        var noteIdFacet = editorControl.joplinExtensions ? editorControl.joplinExtensions.noteIdFacet : null
        var currentNoteId = () => {
            if (!noteIdFacet || !view.state) return ""
            try {
                var id = view.state.facet(noteIdFacet)
                return typeof id === 'string' ? id : ""
            } catch (error) {
                return ""
            }
        }

        var onClick = (event: MouseEvent) => {
            // Constraint 4: a STALE listener must stand aside. .note-editor-wrapper is created by the layout
            // renderer AROUND <NoteEditor>, so it OUTLIVES the CodeMirror instance, while plugin() runs once per
            // editor MOUNT - toggling to the Rich Text editor and back adds a second listener while the first is
            // still bound, holding a destroyed view whose state still answers with the note it died on. Because
            // this listener stops the event immediately, the stale one would WIN and open the picker on the wrong
            // note. A destroyed view's DOM is detached, so isConnected is the test; the listener also unbinds
            // itself here, which keeps a toggling session from accumulating them.
            if (!view.dom || !view.dom.isConnected) {
                root.removeEventListener('click', onClick, true)
                return
            }
            var target = event.target as HTMLElement
            if (!target || typeof target.closest !== 'function') return
            var button = target.closest('.note-title-info-group button.toolbar-button') as HTMLButtonElement
            if (!button) return
            // Constraint 2: the bell is identified by its own icon, not by -has-title (which only appears once the
            // to-do HAS an alarm) and not by its place in the row (which the other title-bar buttons share).
            if (!button.querySelector('span.toolbar-icon.icon-alarm')) return
            // A disabled bell (a plain note, a completed to-do) dispatches no click in the first place; this is the
            // belt to that braces, and it leaves such a click entirely alone.
            if (button.disabled) return
            var noteId = currentNoteId()
            // Without an id there is nothing to hand Cockpit, so Joplin's own picker must be allowed to run.
            if (!noteId) return

            // Constraint 3: taken in the capture phase, before React's delegated bubble listener on its root.
            event.preventDefault()
            event.stopPropagation()
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()

            Promise.resolve(context.postMessage({ type: 'openAlarm', noteId: noteId }))
                .then((result: any) => {
                    if (result && result.ok === false){
                        console.warn(`Cockpit: the bell click did not open the picker (${result.reason || 'unknown reason'})`)
                    }
                })
                .catch((error: any) => {
                    console.warn("Cockpit: the bell click could not be delivered to the plugin", error)
                })
        }
        root.addEventListener('click', onClick, true)
    },
})
