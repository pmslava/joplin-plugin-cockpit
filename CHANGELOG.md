# 4.0.0
- Add support for the Joplin mobile app. The panel appears as a tab in the plugin panel dialog, which is opened with the plugin button in the note screen toolbar
- Store profiles in a plugin setting instead of an sqlite3 database, as neither sqlite3 nor the file system is available to plugins on mobile. Existing profiles are imported automatically on first run and the old database file is left untouched
- Store the custom panel CSS in a plugin setting instead of a custom.css file, for the same reason. Any existing custom.css is imported on first run if the file still exists
- Fix the build: the plugin modules `panel.ts` and `editor.ts` were shadowed by the webview scripts `panel.js` and `editor.js` during module resolution, so a freshly built plugin failed to start. The webview scripts are now named `panelWebview.js` and `editorWebview.js`
- Refresh the panel and the overview notes when notes change, when a sync finishes and when a to-do alarm fires, instead of relying on the timer alone. The timer remains as a fallback and its default is now 60 seconds. Because Joplin updates its search index on a timer of its own, each change also triggers a few follow up refreshes over the following half minute, so a newly created or completed to-do still reaches the panel promptly
- Only write an overview note when its content has actually changed, so unchanged to-do lists no longer create a note revision on every refresh
- Only replace the panel markup when it has actually changed, so refreshing no longer resets the scroll position
- Replace the Font Awesome panel icons with inline SVG, as Joplin does not load an icon font into plugin webviews on mobile
- Escape to-do titles and profile names so that titles containing characters such as `&` or `<` are displayed as written
- On mobile, show the "Toggle Profile Edit Mode" and "Set Panel CSS" commands as buttons in the panel heading, since mobile has no Tools menu

# 3.7.1
- Fix database upgrading system to check if table columns actually exist instead of relying on database version number

# 3.7.0
- Move the "Move No Due Dates to End" setting to per profile option
- Remove checking for whether overview note exists

# 3.6.1
- Fix updating function so only one instance runs at a time

# 3.6.0
- Add support for custom css

# 3.5.0
- Add support for sorting to-dos without due dates at the end of lists

# 3.4.1 
- Fix time display bug in tomorrow heading of interval format

# 3.4.0 
- Add Tomorrow heading to interval format

# 3.3.0
- Update all profile notes at once

# 3.2.0
- Add support for profile sorting
- Add Changelog
