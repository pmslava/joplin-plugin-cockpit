/** README ******************************************************************************************************************************************
 * This file is responsible for setting up and managing the menus for the plugin                                                                    *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { MenuItemLocation } from "api/types"
import { isMobile } from "../../core/platform"

/** setupMenu ***************************************************************************************************************************************
 * Sets up the menu used by the plugin. Menus are a desktop only part of the plugin API; on mobile the same commands are reachable from the buttons *
 * in the panel heading.                                                                                                                            *
 *                                                                                                                                                  *
 * WHAT IS NOT HERE: 'cockpit.connectSettingsNote'. It had a menu item in 2.6.0 and the owner's first live round took it out again - setting up the  *
 * settings note is a one-time action, and it belongs in the one place a user goes to configure the plugin, which is Settings > Plugins > Cockpit.   *
 * Typing the note's title into that field now does everything the item did (see resolveSettingsNoteReference in core/settingsSync.ts). The command  *
 * stays REGISTERED, reachable from the command palette, exactly like the two commands Whereabouts calls.                                            *
 *                                                                                                                                                  *
 * The toggle item carries a keyboard shortcut, and it is the accelerator here that puts the command on Joplin's Options > Keyboard Shortcuts       *
 * screen at all: views.menus.create feeds an item to KeymapService.registerCommandAccelerator ONLY when the item has one, and commands.register    *
 * and toolbarButtons.create never do. Without it the command was invisible there and a user could not even bind a key by hand (issue 4). Joplin    *
 * keeps whatever the user later sets on that screen; the value below is only the default.                                                          *
 *                                                                                                                                                  *
 * Ctrl+Shift+H is deliberately one literal chord on every platform, Control key included on macOS. It was picked from a survey of what is taken:   *
 * Joplin's own defaults use Ctrl+Shift with B, L, M, N, O, P, S, T and V; its CodeMirror editor binds Ctrl+Shift+G and Ctrl+Shift+L; and the       *
 * plugins DDDot, Jarvis, Commands, Copy as HTML and Ridgeline take Ctrl+Shift+. and Ctrl+Shift+C/J/R/E/A among others. C, P, D, T, A and G were    *
 * all taken somewhere, H (hide/show) was free everywhere checked.                                                                                  *
 ***************************************************************************************************************************************************/
 export async function setupMenu(){
    if (await isMobile()) return
    await joplin.views.menus.create(
        'agendaMenu',
        "Cockpit",
        [
            {commandName: 'togglePanelVisibility', accelerator: 'Ctrl+Shift+H'},
            {commandName: 'toggleCockpitToolbarButton'},
            {commandName: 'showStylerDialog'},
        ],
        MenuItemLocation.Tools
    )
}
