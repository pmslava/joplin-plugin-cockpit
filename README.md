# Cockpit — a Joplin plugin

A tasks-and-notes command center panel for [Joplin](https://joplinapp.org), on desktop and mobile.

## Features

- **Panel** listing all to-dos grouped by due date (interval, date, month calendar or week planner view), plus regular notes if wanted (before or after the to-dos).
- **Two-layer item glyphs**: a small disc marks a to-do (click to complete); a ring around it shows how many of the markdown checkboxes inside the note are ticked — same counting as Joplin's own note list chart.
- **Due dates by drag & drop**: drag to-dos (multi-select with Ctrl / Shift) onto group headings, calendar days or week columns. A to-do keeps its time of day; new ones get the configurable day start time.
- **Set alarm dialog** (right-click a to-do's disc, or a group heading for the whole group): ISO dates, 24h time, Monday-first calendar, hour/minute pickers, Today / Tomorrow / +1 week / +month (same weekday) shortcuts.
- **Context menu** on every row: open, switch note/to-do type, tags, move to notebook, duplicate, copy Markdown link, copy note ID, delete.
- **Filters**: notebook (hierarchical — includes sub-notebooks) and a full Joplin search field (`any:1`, `tag:`, `-tag:`, words...).
- **Profiles as view presets**: each profile stores its search criteria, display format, completed-todo visibility (past / today / future / no due date), notes visibility, notebook filter, search text and sorting — switching profiles switches the whole view.
- **Management built in**: create/edit/delete profiles and rename/move/delete notebooks from the pickers; New note / New to-do buttons that create in the filtered notebook.
- **Overview notes**: write the to-do list into regular notes, so it is visible in any client.

## Credits

Cockpit started as a fork of [Agenda](https://github.com/TheScriptingGuy/Joplin-Agenda-Plugin) by BeatLink and TheScriptingGuy (MIT). The panel, dialogs and most behaviour have since been substantially reworked, but the profile system and overview notes trace back to their work. Thank you!

## License

MIT
