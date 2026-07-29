# Agenda

An agenda/calendar/schedule panel plugin for joplin that shows all uncompleted to-dos with a due date

## Screenshots

### Main Interface
![Screenshot1](docs/Screenshot1.png)

### The Agenda Panel
![Screenshot2](docs/Screenshot2.png)


## Installation

### Desktop
Agenda is already in the Joplin plugin repository so it can be installed from the plugins page inside Joplin settings.
1. Open Joplin
2. Go to Tools -> Options in the menu bar
3. Go to Plugins
4. Search for "Agenda"
5. Click Install

### Mobile
Agenda runs on the Joplin mobile app from version 3.3 onwards.
1. Open Joplin
2. Go to Configuration -> Plugins
3. Enable plugin support if it is not already enabled
4. Search for "Agenda"
5. Click Install

Profiles are stored per device rather than synced, so the phone starts with its own default profile. Everything else works the
same as on desktop.

## Usage
Agenda uses profiles to know how to sort, organize and present to-dos in the todo list. You can create many different profiles to generate the to-do lists
you need. For example, you may have one profile for your work to-dos and another for your personal to-dos. You can have one for active tasks, and one for tasks being held. The only limit to the profile system is your imagination and the Joplin search system. 

### Creating a Profile
* To create a profile, click the plus button in the panel, beside the profile dropdown, fill out the profile options and then press create.

### Editing a Profile
* To edit an existing profile, click the pencil button in the panel beside the profile dropdown, edit the profile options and then press save.

### Deleting a Profile
* To delete an existing profile, click the trashcan button in the panel beside the profile dropdown, and then press delete to confirm. 

### Selecting a Profile
* To select a profile, use the profile dropdown list at the top of the panel. 

### Profile Options

#### Name
* In the name box, you can set the name of the profile, that's shown in the profile selection dropdown. 

#### Search Criteria
* In the search criteria box, you can enter the search terms that Agenda will use to find tasks for this profile. Anything that you can enter in the joplin search bar, you can enter here. See the joplin search syntax for details. 

#### Overview Note ID
* The Overview Note ID box allows you to copy all the tasks in the current profile to a new note called the Overview Note. This means that each profile in Agenda, can have a note listing all the tasks for that profile. That way, you can still have your task lists without the Agenda plugin itself. To setup the Overview Note, create a new note where you want all your tasks to be stored, and copy its note ID to the Overview Note ID box in the agenda profile options. It's important to note that Agenda will overwrite this note whenever the task list changes, so make sure you create a note specifically for this purpose and do not make changes to it or those changes will be lost.
* Every device running Agenda writes the overview notes of its own profiles. If the same overview note is configured on more than one device and both are online, each will write its own version of the note and Joplin may record a sync conflict. To avoid this, configure a given overview note on one device only.

#### Show Completed
* The show completed checkbox, if checked, will show tasks even if they have been completed. Otherwise, these tasks will be hidden

#### Show without Due Dates
* The show to-dos without due dates, if checked, will show to-dos, even if they have no due date/alarms set. 

#### Display Format
* The display format allows you to select how the to-dos are displayed in the list. There are currently two options:
    * Interval - This will group to-dos according to the following categories:
        - Overdue
        - Today
        - This Week
        - This Month
        - This Year
    * Date - This will group to-dos by the date they are due.

#### Date and Weekday Formats
* The date and weekday format dropdowns allow you to set how dates are shown in the panel and notes

#### Time Formats
* The time format checkbox allows you to switch between AM/PM or 24 hour time. 

### Showing and Hiding the Panel
* On desktop, click the calendar icon in the toolbar, or click the menu option under Tools -> Agenda
* On mobile, open the plugin panel dialog with the plugin button in the note screen toolbar, and select the Agenda tab

### Settings
* The show profile controls checkbox toggles the create, edit and delete buttons in the panel.
* The update frequency setting controls how often Agenda refreshes as a fallback. Agenda also refreshes as soon as a note
  changes, a sync completes or a to-do alarm fires, so this only needs to be short if you want the interval headings
  (Today, Overdue and so on) to roll over quickly.

### Mobile differences
Joplin's plugin API is not identical on every platform, so a few things differ on mobile:
* There is no Tools menu and no note toolbar for plugins, so the "Toggle Profile Edit Mode" and "Set Panel CSS" commands
  are buttons in the panel heading instead.
* Showing and hiding the panel is handled by the app rather than by Agenda.
* Profiles and the custom panel CSS are stored per device.

## Development
* Download Repo
* Run `npm install`
* Modify code in `/src`
* Update Metadata in `/src/manifest.json` and `/package.json`
* Build plugin with `npm run dist`
* Run the fast checks with `npm test`. These build the plugin and run it against a stubbed plugin API for both desktop
  and mobile, which is a lot faster than installing the plugin on a phone for every change.
* Run the real-app tests with `npm run test:e2e`. These download the Joplin desktop AppImage, launch it with this plugin
  loaded as a development plugin, and drive the genuine GUI with Playwright. They need `xvfb` and Chromium's system
  libraries:
  ```
  sudo npx playwright install-deps chromium
  sudo apt-get install -y xvfb
  npm run test:e2e
  ```
  Override the Joplin version under test with `JOPLIN_E2E_VERSION`. Both suites also run in CI, see
  `.github/workflows/tests.yml`.
* Update the plugin framework with `npm run update`
* Publishing is done by `.github/workflows/publish.yml`, which runs when a GitHub Release is published (or on demand).
  It takes the version from the release tag, writes it into both `package.json` and `src/manifest.json`, builds, and
  publishes to npm. Authentication is npm trusted publishing over OIDC, so there is no npm token to keep in the
  repository; the package's trusted publisher must name this repository and `publish.yml` once, on npmjs.com.
  The Joplin plugin repository then picks the release up from npm via the `joplin-plugin` keyword.

### Notes for contributors
* Webview scripts are named `*Webview.js` on purpose. Webpack is configured to resolve `.js` before `.ts`, so a script named
  `panel.js` next to `panel.ts` is silently bundled in place of the plugin module and the plugin fails to start.
* Node modules such as `fs-extra` and `sqlite3` are only available through `joplin.require` on desktop. Use
  `requireNodeModule` from `src/core/platform.ts`, which returns null when the module is unusable, and keep anything that
  depends on it optional.
* To test on mobile without a phone, install the built `publish/*.jpl` into the [web build](https://app.joplincloud.com/)
  of the mobile app under Configuration -> Plugins -> Advanced -> Install from file.
* Two things in the desktop app are out of reach of the e2e tests, because they are native Electron windows rather than
  part of the renderer: the Tools -> Agenda menu (and the command palette) and the confirmation shown when deleting a
  profile. The commands behind them are covered by `npm test` instead.
* Joplin brings its search index up to date on a timer of its own, so a to-do that was just created does not appear in a
  search straight away. Anything in the tests that waits for the panel to reflect a change needs a generous timeout.
