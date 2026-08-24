# Cockpit — a Joplin plugin

One panel for your to-dos, notes, and the checkboxes inside them, grouped by when they are due.

Cockpit is a single [Joplin](https://joplinapp.org) panel built to replace the notes and notebooks sidebars. It gathers every to-do, every note, and the checkboxes inside them into one view, grouped by due date — so it is your plan and your whole archive at the same time. Switch it between an Overdue / Today / This Week rundown, a flat date list, a month calendar, or a week planner. It is built for one thing: deciding what to do right now.

![The Cockpit panel on desktop](docs/images/hero-panel.png)

*One panel: every to-do and note, grouped by due date, with a progress ring on each row.*

<!-- HERO SHOT (docs/images/hero-panel.png): the desktop panel docked beside the note list,
     a profile selected, the interval view showing Overdue / Today / This Week groups, a couple of
     rows with a partly-filled progress ring, and a visible notebook pill on at least one row. -->

Save any set-up as a profile — its view, filters, search, and what counts as done — then switch profiles to switch the whole view. Narrow the list by notebook or full Joplin search, with autocomplete for `tag:`, `notebook:`, and `title:` — filter the suggestions and pick several at once (Ctrl+click, or press and hold on touch). Reschedule by dragging a to-do onto a day or a group, or open the alarm picker for an exact date and time. Recolour the panel to match Joplin or a built-in theme. It runs on Android too, where the pickers and the profile editor are drawn as touch-native overlays.

![Theme presets and custom colours](docs/images/themes.png)

*Theme presets and custom colours, with adjustable font and circle size.*

<!-- themes.png: the panel under a non-default theme (e.g. Nord or a custom colour set), with the
     Cockpit settings section visible so the font-size / circle-size / completed-to-do-style options
     show. Include at least one completed to-do so its style reads. -->

![The set-alarm picker](docs/images/alarm-picker.png)

*The alarm picker: ISO date, 24-hour time, a Monday-first calendar, and quick shortcuts.*

<!-- alarm-picker.png: the picker open (desktop or the mobile overlay), showing the Monday-first
     calendar grid, the hour/minute columns, and the Today / Tomorrow / +week / +month buttons.
     Pick a to-do so a date is prefilled. -->

## Also

- Overview notes: the same list written into a regular note, readable in any Joplin client.
- A synchronise button that reports the last sync time, duration, and any errors.
- A context menu on every row: open, switch type, tags, move, duplicate, copy link, delete.
- Select several rows with Ctrl+click or Shift+click — to-dos and notes together — and the menu applies
  to the whole set at once. Dragging such a selection onto a date moves only the to-dos in it.
- New note and New to-do buttons that create in the notebook you have filtered to.

## Install

In Joplin, open Settings (Configuration on Android) → Plugins, search for "Cockpit", and click Install. This works on both desktop and Android.

To install the file by hand instead, download `io.github.pmslava.cockpit.jpl` from the [releases page](https://github.com/pmslava/joplin-plugin-cockpit/releases) and use Plugins → Install from file; both platforms use the same file.

### Build from source

```
npm install
npm run dist
```

The build writes `publish/io.github.pmslava.cockpit.jpl`. The same file serves both platforms.

## Credits

Cockpit began as a fork of [Agenda](https://github.com/TheScriptingGuy/Joplin-Agenda-Plugin) by BeatLink and TheScriptingGuy (MIT). The panel, dialogs, and most behaviour have since been reworked, but the profile system and overview notes trace back to their work. The idea of aggregating all your scattered work into one live view came from the [Inline Tag Navigator](https://github.com/alondmnt/joplin-plugin-tag-navigator) plugin by alondmnt, though Cockpit built it on Joplin's core to-do functionality rather than inline tag syntax.

## License

MIT. See [LICENSE](LICENSE).
