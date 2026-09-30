const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs-extra')
const sqlite3 = require('sqlite3')
const { run } = require('./harness')

const todos = [
    { id: 'a'.repeat(32), title: 'Pay rent & bills <urgent>', todo_completed: 0, todo_due: Date.now() - 86400000 },
    { id: 'b'.repeat(32), title: 'Buy milk', todo_completed: 0, todo_due: Date.now() + 3600000 },
    { id: 'c'.repeat(32), title: 'Someday', todo_completed: 0, todo_due: 0 },
]

const mobileRequire = () => { throw new Error('Unable to require module on mobile.') }
const desktopRequire = (name) => (name === 'fs-extra' ? fs : name === 'sqlite3' ? sqlite3 : null)

let failures = 0
async function test(name, fn) {
    try {
        await fn()
        console.log(`  PASS  ${name}`)
    } catch (error) {
        failures++
        console.log(`  FAIL  ${name}\n        ${error.message}`)
    }
}

async function main() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenda-test-'))

    // ---------------------------------------------------------------- mobile
    const mobile = await run({
        dataDir: path.join(tmp, 'mobile-data'),
        installationDir: path.join(tmp, 'mobile-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos,
    })

    await test('mobile: plugin starts and creates the panel', () => {
        assert.deepStrictEqual(mobile.panels, ['panel'])
    })
    await test('mobile: no note-toolbar button is registered', () => {
        assert.deepStrictEqual(mobile.toolbarButtons, [])
    })
    await test('mobile: no Tools menu is registered', () => {
        assert.deepStrictEqual(mobile.menus, [])
    })
    await test('mobile: a default profile is stored in settings', () => {
        const stored = JSON.parse(mobile.settings.profileData)
        assert.strictEqual(stored.profiles.length, 1)
        assert.strictEqual(stored.profiles[0].name, 'All todo and notes')
        assert.strictEqual(stored.profiles[0].displayFormat, 'interval')
    })
    await test('mobile: panel html contains the to-dos', () => {
        const html = mobile.panelHtml['panel-panel']
        assert.ok(html.includes('Buy milk'), 'expected a to-do title in the panel')
        // The Overdue heading now carries data-/context-menu attributes, so match its text, not a bare tag.
        assert.ok(html.includes('>Overdue</h2>'), 'expected the Overdue heading')
    })
    await test('mobile: to-do titles are html escaped', () => {
        const html = mobile.panelHtml['panel-panel']
        assert.ok(html.includes('Pay rent &amp; bills &lt;urgent&gt;'), 'title was not escaped')
    })
    await test('mobile: primary actions are exposed as in-panel buttons', () => {
        const html = mobile.panelHtml['panel-panel']
        // Mobile has no native note toolbar or Tools menu, so the create and sync actions the
        // desktop reaches from those live directly in the panel instead.
        assert.ok(html.includes('onNewNoteClicked()'), 'missing new-note button')
        assert.ok(html.includes('onNewTodoClicked()'), 'missing new-to-do button')
        assert.ok(html.includes('onSynchronizeClicked()'), 'missing synchronize button')
    })
    await test('mobile: icons are inline svg, not font awesome', () => {
        const html = mobile.panelHtml['panel-panel']
        assert.ok(html.includes('<svg'), 'expected inline svg icons')
        assert.ok(!html.includes('class="fa '), 'font awesome classes still present')
    })
    await test('mobile: workspace events are subscribed', () => {
        assert.deepStrictEqual(mobile.workspaceEvents.sort(), ['onNoteAlarmTrigger', 'onNoteChange', 'onNoteSelectionChange', 'onSyncComplete', 'onSyncStart'])
    })
    await test('mobile: no message box shown on a clean install', () => {
        assert.deepStrictEqual(mobile.messageBoxes, [])
    })

    // ------------------------------------------------- desktop with legacy db
    const desktopDataDir = path.join(tmp, 'desktop-data')
    await fs.ensureDir(desktopDataDir)
    const legacyPath = path.join(desktopDataDir, 'profiles.sqlite3')
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(legacyPath)
        db.serialize(() => {
            db.run(`CREATE TABLE Profile (
                id INTEGER PRIMARY KEY, name TEXT, searchCriteria TEXT, noteID TEXT,
                showCompleted BOOLEAN, showNoDue BOOLEAN, displayFormat TEXT, yearFormat TEXT,
                monthFormat TEXT, dayFormat TEXT, weekdayFormat TEXT, timeIs12Hour BOOLEAN,
                sortOrder INTEGER, noDueDatesAtEnd BOOLEAN)`)
            db.run(`INSERT INTO Profile VALUES (1,'Work','tag:work','',0,1,'date','numeric','long','numeric','long',1,2,0)`)
            db.run(`INSERT INTO Profile VALUES (2,'Home','','overviewnoteid',1,0,'interval','numeric','short','2-digit','short',0,1,1)`, (e) => e ? reject(e) : resolve())
        })
        db.close()
    })

    const desktop = await run({
        dataDir: desktopDataDir,
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
        notes: { overviewnoteid: { id: 'overviewnoteid', title: 'Overview', body: 'stale content' } },
    })

    await test('desktop: legacy sqlite profiles are imported', () => {
        const stored = JSON.parse(desktop.settings.profileData)
        assert.strictEqual(stored.profiles.length, 2)
        assert.deepStrictEqual(stored.profiles.map(p => p.name).sort(), ['Home', 'Work'])
    })
    await test('desktop: legacy values keep their types', () => {
        const stored = JSON.parse(desktop.settings.profileData)
        const work = stored.profiles.find(p => p.name === 'Work')
        assert.strictEqual(work.showCompleted, false)
        assert.strictEqual(work.showNoDue, true)
        assert.strictEqual(work.sortOrder, 2)
        assert.strictEqual(work.searchCriteria, 'tag:work')
        assert.strictEqual(work.displayFormat, 'date')
    })
    await test('desktop: the legacy database file is left in place', async () => {
        assert.ok(await fs.pathExists(legacyPath), 'legacy database was removed')
    })
    await test('desktop: the note toolbar button and Tools menu are registered', () => {
        assert.strictEqual(desktop.toolbarButtons.length, 1)
        assert.strictEqual(desktop.toolbarButtons[0].location, 'noteToolbar')
        assert.strictEqual(desktop.menus.length, 1)
    })
    await test('desktop: the panel toggle carries Ctrl+Shift+H, and it is the only menu item with a shortcut', () => {
        // The accelerator on a views.menus.create item is what registers the command with Joplin's keymap, so
        // this pin is what keeps "Toggle Cockpit Panel" on the Keyboard Shortcuts screen (issue 4). One literal
        // chord on every platform - not CmdOrCtrl - by decision.
        const items = desktop.menus[0].items
        const toggle = items.find(item => item.commandName === 'togglePanelVisibility')
        assert.ok(toggle, 'the toggle command is in the Tools > Cockpit menu')
        assert.strictEqual(toggle.accelerator, 'Ctrl+Shift+H')
        const withShortcut = items.filter(item => item.accelerator).map(item => item.commandName)
        assert.deepStrictEqual(withShortcut, ['togglePanelVisibility'], 'no other item claims a chord')
    })
    await test('desktop: the settings note is set up from Settings, so the Tools menu does not carry its command', () => {
        // 2.6.0 gave "Cockpit: Connect settings note" a menu item; the owner's first live round took it out again, because
        // setting the note up is a one-time action and belongs where the plugin is configured. Typing the note's title into
        // the Settings field now does the whole job. The COMMAND stays registered - the palette reaches it, exactly like the
        // two commands Whereabouts calls - so this pins the pair: listed nowhere, registered all the same.
        const items = desktop.menus[0].items.map(item => item.commandName)
        assert.deepStrictEqual(items, ['togglePanelVisibility', 'toggleCockpitToolbarButton', 'showStylerDialog'],
            'exactly the three items the Tools > Cockpit menu had before the settings note existed')
        assert.ok(desktop.commands.some(command => command.name === 'cockpit.connectSettingsNote'),
            'and the command is still registered for the command palette')
    })
    await test('desktop: no mobile-only heading buttons', () => {
        const html = desktop.panelHtml['panel-panel']
        assert.ok(!html.includes('onStylerClicked()'), 'styler button should be desktop-menu only')
    })
    await test('desktop: profiles are ordered by sort order', () => {
        const html = desktop.panelHtml['panel-panel']
        assert.ok(html.indexOf('>Home<') < html.indexOf('>Work<'), 'sortOrder 1 should come before sortOrder 2')
    })
    await test('desktop: the overview note is written', () => {
        assert.strictEqual(desktop.notePuts.length, 1)
        assert.ok(desktop.notePuts[0].body.startsWith('# Home'))
        assert.ok(desktop.notePuts[0].body.includes('Buy milk](:/'))
    })

    // ------------------------------------ commands that are only reachable from native menus
    // These cannot be driven by the Playwright e2e suite, because on desktop they live in the
    // Tools > Cockpit menu and the command palette, both of which are native Electron menus.
    await test('the styler command stores custom css and the panel applies it', async () => {
        const command = desktop.commands.find(c => c.name === 'showStylerDialog')
        assert.ok(command, 'command was not registered')

        desktop.dialogResult = { id: 'ok', formData: { customCSSForm: { customCss: 'h1 { color: red; }' } } }
        await command.execute()
        assert.strictEqual(desktop.settings.customCss, 'h1 { color: red; }')
        // The panel injects custom CSS into its <style> block after the theme CSS, so match the
        // rule itself rather than expecting it to be the whole style element.
        assert.ok(
            desktop.panelHtml['panel-panel'].includes('h1 { color: red; }'),
            'custom css was not applied to the panel'
        )
        desktop.dialogResult = null
    })

    // --------------------------------------------------------- light theme colours
    // These assertions exercise the generated panel markup rather than importing buildThemeCss
    // directly. That keeps the coverage on the same settings -> render path Joplin uses.
    const inlineStyle = (state) => {
        const html = state.panelHtml['panel-panel']
        const start = html.indexOf('<style>') + '<style>'.length
        const end = html.indexOf('</style>', start)
        assert.ok(start >= '<style>'.length && end > start, 'panel has no inline style block')
        return html.slice(start, end)
    }

    await test('Match Joplin emits the effective-theme detection marker', () => {
        assert.ok(
            inlineStyle(desktop).includes('--cockpit-match-joplin:1'),
            'default Match Joplin mode did not enable effective-theme detection'
        )
    })

    const lightTheme = await run({
        dataDir: path.join(tmp, 'light-theme-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
        initialSettings: {
            themeMode: 'light',
            customCss: '.custom-order-marker { color: rebeccapurple; }',
        },
    })
    await test('light theme: generated CSS emits both foreground/background pairs', () => {
        const css = inlineStyle(lightTheme)
        assert.ok(css.includes('--cockpit-match-joplin:0'), 'explicit preset was marked as Match Joplin')
        assert.ok(css.includes('--cockpit-color:#32373F'), 'missing content foreground')
        assert.ok(css.includes('--cockpit-background-color:#ffffff'), 'missing content background')
        assert.ok(css.includes('--cockpit-color2:#ffffff'), 'missing panel foreground')
        assert.ok(css.includes('--cockpit-background-color2:#313640'), 'missing panel background')
    })
    await test('theme CSS is emitted before custom CSS', () => {
        const css = inlineStyle(lightTheme)
        const themeIndex = css.indexOf('--cockpit-color:#32373F')
        const customIndex = css.indexOf('.custom-order-marker')
        assert.ok(themeIndex >= 0 && customIndex > themeIndex, 'custom CSS did not follow the theme block')
    })

    const solarizedLightTheme = await run({
        dataDir: path.join(tmp, 'solarized-light-theme-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
        initialSettings: { themeMode: 'solarizedLight' },
    })
    await test('solarized light theme: generated CSS emits both foreground/background pairs', () => {
        const css = inlineStyle(solarizedLightTheme)
        assert.ok(css.includes('--cockpit-color:#657b83'), 'missing content foreground')
        assert.ok(css.includes('--cockpit-background-color:#fdf6e3'), 'missing content background')
        assert.ok(css.includes('--cockpit-color2:#eee8d5'), 'missing panel foreground')
        assert.ok(css.includes('--cockpit-background-color2:#002b36'), 'missing panel background')
    })

    const darkTheme = await run({
        dataDir: path.join(tmp, 'dark-theme-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
        initialSettings: { themeMode: 'dark' },
    })
    await test('dark theme: restores the muted heading and neutral current-item colours', () => {
        const css = inlineStyle(darkTheme)
        assert.ok(css.includes('--cockpit-match-joplin:0'), 'explicit preset was marked as Match Joplin')
        assert.ok(css.includes('--cockpit-group-heading-color:#999999'), 'heading is not the former muted grey')
        assert.ok(css.includes('--cockpit-current-item-color:#dddddd'), 'selected item foreground is not the former grey')
        assert.ok(css.includes('--cockpit-current-item-background-color:#616161'), 'selected item background is not the former neutral grey')
    })

    const customTheme = await run({
        dataDir: path.join(tmp, 'custom-theme-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
        initialSettings: { themeMode: 'custom', customTextColor: '#123abc' },
    })
    await test('custom theme: text colour sets both foreground variables', () => {
        const css = inlineStyle(customTheme)
        assert.ok(css.includes('--cockpit-match-joplin:0'), 'custom theme was marked as Match Joplin')
        assert.ok(css.includes('--cockpit-color:#123abc'), 'missing content foreground')
        assert.ok(css.includes('--cockpit-color2:#123abc'), 'missing panel foreground')
    })

    // ------------------------------------------------------- idempotent refresh
    await test('desktop: refreshing again rewrites neither the note nor the panel', async () => {
        const putsBefore = desktop.notePuts.length
        const setHtmlBefore = desktop.setHtmlCalls
        await desktop.commands.find(c => c.name === 'togglePanelVisibility') // no-op lookup
        await desktop.panelMessageHandler(['updateInterfacesClicked'])
        assert.strictEqual(desktop.notePuts.length, putsBefore, 'overview note was rewritten despite being unchanged')
        assert.strictEqual(desktop.setHtmlCalls, setHtmlBefore, 'panel html was replaced despite being unchanged')
    })

    // ------------------------------------------------ restart keeps the profiles
    const restarted = await run({
        dataDir: desktopDataDir,
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
        initialSettings: { profileData: desktop.settings.profileData, currentProfileID: 2 },
        notes: { overviewnoteid: { id: 'overviewnoteid', title: 'Overview', body: 'stale' } },
    })
    await test('restart: stored profiles are reused, not re-imported', () => {
        const stored = JSON.parse(restarted.settings.profileData)
        assert.strictEqual(stored.profiles.length, 2)
    })
    await test('restart: the selected profile is preserved', () => {
        assert.strictEqual(Number(restarted.settings.currentProfileID), 2)
    })

    // ------------------------- legacy database left by the previously published plugin id
    // Joplin gives every plugin id its own data directory, so after the plugin id changed the
    // profiles of an existing install are in a sibling directory rather than in our own.
    const pluginDataRoot = path.join(tmp, 'plugin-data')
    const oldPluginDataDir = path.join(pluginDataRoot, 'com.gitlab.BeatLink.joplin-plugin-agenda')
    const newPluginDataDir = path.join(pluginDataRoot, 'com.github.thescriptingguy.joplin-plugin-agenda')
    await fs.ensureDir(oldPluginDataDir)
    await fs.ensureDir(newPluginDataDir)
    await fs.copy(legacyPath, path.join(oldPluginDataDir, 'profiles.sqlite3'))

    const renamed = await run({
        dataDir: newPluginDataDir,
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
    })
    await test('renamed plugin: profiles are imported from the previous plugin id data directory', () => {
        const stored = JSON.parse(renamed.settings.profileData)
        assert.deepStrictEqual(stored.profiles.map(p => p.name).sort(), ['Home', 'Work'])
    })
    await test('renamed plugin: the previous plugin data directory is left untouched', async () => {
        assert.ok(await fs.pathExists(path.join(oldPluginDataDir, 'profiles.sqlite3')))
    })

    // -------------------------------------------------------------- calendar views
    // The anchor is plugin state driven by a message, so these navigate to a fixed month and assert
    // on structure. Nothing here depends on the date the suite happens to run.
    const calendarDue = (day, hour) => new Date(2026, 4, day, hour, 0, 0).getTime() // May 2026
    const calendarTodos = [
        { id: 'd'.repeat(32), title: 'Early May', todo_completed: 0, todo_due: calendarDue(4, 9) },
        { id: 'e'.repeat(32), title: 'Same day one', todo_completed: 0, todo_due: calendarDue(12, 9) },
        { id: 'f'.repeat(32), title: 'Same day two', todo_completed: 0, todo_due: calendarDue(12, 14) },
        { id: '0'.repeat(32), title: 'Same day three', todo_completed: 1, todo_due: calendarDue(12, 16) },
        // Alone on its day and completed, so that day must render a single muted dot.
        { id: '2'.repeat(32), title: 'Finished', todo_completed: 1, todo_due: calendarDue(20, 9) },
        { id: '1'.repeat(32), title: 'Unscheduled', todo_completed: 0, todo_due: 0 },
    ]
    const monthProfile = {
        nextID: 2,
        profiles: [{
            id: 1, name: 'Calendar', searchCriteria: '', noteID: '', showCompleted: true, showNoDue: true,
            displayFormat: 'month', yearFormat: 'numeric', monthFormat: 'long', dayFormat: 'numeric',
            weekdayFormat: 'short', timeIs12Hour: true, sortOrder: 0, noDueDatesAtEnd: false,
            weekStartsOn: 1, maxDotsPerDay: 2,
        }],
    }

    const calendar = await run({
        dataDir: path.join(tmp, 'calendar-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: calendarTodos,
        initialSettings: { profileData: JSON.stringify(monthProfile), currentProfileID: 1 },
    })

    // Navigate to a known month regardless of when the suite runs: step back to May 2026 from today.
    const monthsFromNow = (new Date().getFullYear() - 2026) * 12 + (new Date().getMonth() - 4)
    for (let step = 0; step < Math.abs(monthsFromNow); step++) {
        await calendar.panelMessageHandler(['calendarNavigate', monthsFromNow > 0 ? -1 : 1])
    }

    await test('month view: renders a grid of whole weeks starting on Monday', () => {
        const html = calendar.panelHtml['panel-panel']
        assert.ok(html.includes('class="calendar-grid"'), 'no calendar grid rendered')
        // The grid covers whole weeks around the month rather than a fixed six rows. May 2026 runs
        // Friday the 1st to Sunday the 31st, so a Monday-start grid is Mon 27 Apr to Sun 31 May.
        assert.strictEqual((html.match(/calendar-day-button/g) || []).length, 35)
        assert.strictEqual((html.match(/<tr>/g) || []).length, 6) // 1 header row + 5 week rows
        assert.ok(html.includes('>27<') && html.includes('>31<'), 'grid should span the surrounding weeks')
        const headerRow = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'))
        assert.ok(headerRow.indexOf('Mon') < headerRow.indexOf('Sun'), 'week should start on Monday')
    })

    await test('month view: a Sunday-start profile shifts the columns', async () => {
        const sunday = await run({
            dataDir: path.join(tmp, 'sunday-month-data'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos: calendarTodos,
            initialSettings: {
                profileData: JSON.stringify({
                    nextID: 2,
                    profiles: [{ ...monthProfile.profiles[0], weekStartsOn: 0 }],
                }),
                currentProfileID: 1,
            },
        })
        const header = sunday.panelHtml['panel-panel']
        const headerRow = header.slice(header.indexOf('<thead>'), header.indexOf('</thead>'))
        assert.ok(headerRow.indexOf('Sun') < headerRow.indexOf('Mon'), 'week should start on Sunday')
    })

    await test('month view: shows the navigated month, not today', () => {
        assert.ok(calendar.panelHtml['panel-panel'].includes('May 2026'), 'expected the May 2026 title')
    })

    await test('month view: dots are capped and the overflow is counted', () => {
        const html = calendar.panelHtml['panel-panel']
        // The 12th has three to-dos and the profile caps dots at two. The class is matched with its
        // trailing space so that the wrapping "calendar-dots" element is not counted as a dot.
        const cell = html.slice(html.indexOf('2026-05-12'), html.indexOf('2026-05-13'))
        assert.strictEqual((cell.match(/class="calendar-dot /g) || []).length, 2, 'dots were not capped')
        assert.ok(cell.includes('+1'), 'missing overflow indicator')
    })

    await test('month view: dot colour reflects outstanding versus completed', () => {
        const html = calendar.panelHtml['panel-panel']
        // May 2026 is in the past relative to any later run date, so its outstanding to-dos are overdue.
        assert.ok(html.includes('calendar-dot -overdue'), 'outstanding to-do should render an overdue dot')
        const finishedCell = html.slice(html.indexOf('2026-05-20'), html.indexOf('2026-05-21'))
        assert.ok(finishedCell.includes('calendar-dot -done'), 'completed to-do should render a muted dot')
        assert.ok(html.includes('calendar-day -done'), 'a day whose to-dos are all done should be muted')
    })

    await test('month view: day cells carry an accessible label', () => {
        assert.ok(/aria-label="[^"]*to-dos?, \d+ outstanding"/.test(calendar.panelHtml['panel-panel']))
    })

    await test('month view: to-dos without a due date get their own section', () => {
        const html = calendar.panelHtml['panel-panel']
        assert.ok(html.includes('calendar-undated'), 'missing the undated section')
        assert.ok(html.includes('Unscheduled'), 'undated to-do was dropped')
    })

    await test('month view: selecting a day lists its to-dos, selecting again hides them', async () => {
        await calendar.panelMessageHandler(['calendarDaySelected', '2026-05-12'])
        let html = calendar.panelHtml['panel-panel']
        assert.ok(html.includes('calendar-selected'), 'no selected day section')
        assert.ok(html.includes('Same day one') && html.includes('Same day two'))

        await calendar.panelMessageHandler(['calendarDaySelected', '2026-05-12'])
        html = calendar.panelHtml['panel-panel']
        assert.ok(!html.includes('calendar-selected'), 'selecting twice should close the day')
    })

    await test('month view: the overview note still gets a readable list, not a grid', async () => {
        const withNote = await run({
            dataDir: path.join(tmp, 'calendar-note-data'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos: calendarTodos,
            initialSettings: {
                profileData: JSON.stringify({
                    nextID: 2,
                    profiles: [{ ...monthProfile.profiles[0], noteID: 'calendarnote' }],
                }),
                currentProfileID: 1,
            },
            notes: { calendarnote: { id: 'calendarnote', title: 'Overview', body: 'stale' } },
        })
        assert.strictEqual(withNote.notePuts.length, 1)
        const body = withNote.notePuts[0].body
        assert.ok(!body.includes('calendar-grid'), 'the note should not contain grid markup')
        assert.ok(body.includes('- [ ] ['), 'the note should contain a markdown to-do list')
    })

    await test('week view: renders seven day sections and navigates by weeks', async () => {
        const weekProfile = {
            nextID: 2,
            profiles: [{ ...monthProfile.profiles[0], displayFormat: 'week' }],
        }
        const week = await run({
            dataDir: path.join(tmp, 'week-data'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos: calendarTodos,
            initialSettings: { profileData: JSON.stringify(weekProfile), currentProfileID: 1 },
        })
        // Every render bumps a nonce (for scroll restoration), so the panel HTML is never byte-identical
        // across renders. Compare the navigation title (the week's date range) instead of the whole panel.
        const calendarTitle = (html) => {
            const start = html.indexOf('>', html.indexOf('class="calendar-title"')) + 1
            return html.slice(start, html.indexOf('</button>', start))
        }
        const before = week.panelHtml['panel-panel']
        assert.strictEqual((before.match(/class="week-day/g) || []).length, 7)
        assert.ok(before.includes('week-planner'))
        const titleBefore = calendarTitle(before)

        await week.panelMessageHandler(['calendarNavigate', -1])
        assert.notStrictEqual(calendarTitle(week.panelHtml['panel-panel']), titleBefore, 'navigating a week changed nothing')

        await week.panelMessageHandler(['calendarToday'])
        assert.strictEqual(calendarTitle(week.panelHtml['panel-panel']), titleBefore, 'today should return to the starting week')
    })

    await test('week view: to-dos are tickable in place', async () => {
        const weekProfile = {
            nextID: 2,
            profiles: [{ ...monthProfile.profiles[0], displayFormat: 'week', weekStartsOn: 0 }],
        }
        const week = await run({
            dataDir: path.join(tmp, 'week-sunday-data'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos: calendarTodos,
            initialSettings: { profileData: JSON.stringify(weekProfile), currentProfileID: 1 },
        })
        const html = week.panelHtml['panel-panel']
        assert.ok(html.includes('onTodoChecked('), 'week planner rows should be tickable')
        assert.ok(html.includes('onTodoRowClicked('), 'week planner rows should be openable')
    })

    await test('an unknown display format still falls back to the interval list', async () => {
        const oddProfile = {
            nextID: 2,
            profiles: [{ ...monthProfile.profiles[0], displayFormat: 'quarterly' }],
        }
        const odd = await run({
            dataDir: path.join(tmp, 'odd-format-data'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos: calendarTodos,
            initialSettings: { profileData: JSON.stringify(oddProfile), currentProfileID: 1 },
        })
        const html = odd.panelHtml['panel-panel']
        assert.ok(!html.includes('calendar-grid'), 'unknown format should not render a calendar')
        // Grouped-list headings carry attributes now, so match the opening tag rather than a bare <h2>.
        assert.ok(html.includes('<h2'), 'expected a grouped list')
    })

    // ---------------------------------------------- corrupt / failed migration
    const brokenDir = path.join(tmp, 'broken-data')
    await fs.ensureDir(brokenDir)
    await fs.writeFile(path.join(brokenDir, 'profiles.sqlite3'), 'this is not a database')
    const broken = await run({
        dataDir: brokenDir,
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
    })
    await test('unreadable legacy db: plugin still starts with a default profile', () => {
        const stored = JSON.parse(broken.settings.profileData)
        assert.strictEqual(stored.profiles.length, 1)
    })
    await test('unreadable legacy db: the user is told', () => {
        assert.strictEqual(broken.messageBoxes.length, 1)
        assert.ok(broken.messageBoxes[0].includes('could not read your existing profiles'))
    })

    // ------------------------------------- old app that does not report platform
    const legacyApp = await run({
        dataDir: path.join(tmp, 'legacy-app'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '2.9.0' },
        todos,
    })
    await test('app without platform info: falls back to desktop behaviour', () => {
        assert.strictEqual(legacyApp.toolbarButtons.length, 1)
    })

    const legacyMobile = await run({
        dataDir: path.join(tmp, 'legacy-mobile'),
        installationDir: path.join(tmp, 'mobile-install'),
        require: mobileRequire,
        versionInfo: { version: '3.0.0' },
        todos,
    })
    await test('mobile without platform info: detected via the missing node modules', () => {
        assert.strictEqual(legacyMobile.toolbarButtons.length, 0)
    })

    // ------------------------------------------------ optimistic checkbox toggle (A1)
    // The webview now posts { id, checked } and the host applies it with a single idempotent PUT, holding
    // the state optimistically so a render before the search index catches up still shows the tick.
    const toggleTodos = [
        { id: 'a'.repeat(32), title: 'Tick me', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: 'n'.repeat(32) },
    ]
    const toggle = await run({
        dataDir: path.join(tmp, 'toggle-data'),
        installationDir: path.join(tmp, 'toggle-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: toggleTodos,
    })
    await test('toggle: one idempotent PUT (numeric ms), no GET-before-PUT, no immediate search', async () => {
        const id = 'a'.repeat(32)
        const getsMark = toggle.gets.length
        const searchesBefore = toggle.gets.filter(g => g.path[0] === 'search').length
        const putsBefore = toggle.notePuts.length
        await toggle.panelMessageHandler(['todoChecked', id, true])
        const newPuts = toggle.notePuts.slice(putsBefore)
        assert.strictEqual(newPuts.length, 1, 'expected exactly one PUT')
        assert.strictEqual(newPuts[0].id, id)
        assert.strictEqual(typeof newPuts[0].fields.todo_completed, 'number', 'todo_completed must be a numeric ms timestamp')
        assert.ok(newPuts[0].fields.todo_completed > 0, 'completing writes a positive ms timestamp, not a boolean')
        const newGets = toggle.gets.slice(getsMark)
        assert.ok(!newGets.some(g => g.path[0] === 'notes' && g.path.length === 2 && g.path[1] === id), 'no read-modify-write: nothing GETs the note before the PUT')
        assert.strictEqual(toggle.gets.filter(g => g.path[0] === 'search').length, searchesBefore, 'toggle must not trigger a search (optimistic repaint comes from cache)')
    })
    await test('toggle: a search-based render before the index agrees still shows the ticked state', async () => {
        const id = 'a'.repeat(32)
        await toggle.panelMessageHandler(['todoChecked', id, true])
        // Force a real, non-optimistic render. The search fixture still returns the to-do as incomplete, so
        // only the host-held override can make the row render completed.
        await toggle.panelMessageHandler(['sortDirectionClicked'])
        const html = toggle.panelHtml['panel-panel']
        const at = html.indexOf('data-todo-id="' + id + '"')
        assert.ok(at >= 0, 'the toggled to-do should be present')
        const openTag = html.slice(html.lastIndexOf('<div', at), at)
        assert.ok(openTag.includes('-completed'), 'the override should render the row completed despite the stale search')
    })
    await test('toggle: unticking writes todo_completed 0', async () => {
        const id = 'a'.repeat(32)
        const putsBefore = toggle.notePuts.length
        await toggle.panelMessageHandler(['todoChecked', id, false])
        const newPuts = toggle.notePuts.slice(putsBefore)
        assert.strictEqual(newPuts.length, 1)
        assert.strictEqual(newPuts[0].fields.todo_completed, 0, 'unticking writes 0, a single idempotent PUT')
    })

    // ------------------------------------------------ optimistic create (A2)
    const createFolders = [{ id: 'f'.repeat(32), title: 'Inbox', parent_id: '' }]
    const create = await run({
        dataDir: path.join(tmp, 'create-data'),
        installationDir: path.join(tmp, 'create-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: [],
        folders: createFolders,
    })
    await test('create: a Cockpit-created to-do appears at once with no search round-trip', async () => {
        const folderId = 'f'.repeat(32)
        await create.panelMessageHandler(['notebookFilterChanged', folderId])
        const searchesBefore = create.gets.filter(g => g.path[0] === 'search').length
        await create.panelMessageHandler(['newTodoClicked'])
        assert.ok(create.dataPosts.some(p => p.path[0] === 'notes' && p.path.length === 1), 'a note should have been POSTed')
        assert.ok(create.panelHtml['panel-panel'].includes('data-todo-id="created-1"'), 'the created to-do should be inserted from the POST response')
        assert.strictEqual(create.gets.filter(g => g.path[0] === 'search').length, searchesBefore, 'the optimistic insert must not issue a search')
    })
    const createSearch = await run({
        dataDir: path.join(tmp, 'create-search-data'),
        installationDir: path.join(tmp, 'create-search-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: [],
        folders: createFolders,
    })
    await test('create: no optimistic insert when the view has search text', async () => {
        const folderId = 'f'.repeat(32)
        await createSearch.panelMessageHandler(['notebookFilterChanged', folderId])
        await createSearch.panelMessageHandler(['searchFilterChanged', 'urgent'])
        await createSearch.panelMessageHandler(['newTodoClicked'])
        assert.ok(createSearch.dataPosts.some(p => p.path[0] === 'notes' && p.path.length === 1), 'the note is still created')
        assert.ok(!createSearch.panelHtml['panel-panel'].includes('data-todo-id="created-'), 'an arbitrary search cannot be evaluated locally, so nothing is inserted optimistically')
    })

    // ------------------------------------------------ notebook picker folder poll (A3)
    const pollFolders = [{ id: 'f'.repeat(32), title: 'Inbox', parent_id: '', updated_time: 1000 }]
    const pollOptions = {
        dataDir: path.join(tmp, 'poll-data'),
        installationDir: path.join(tmp, 'poll-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: [],
        folders: pollFolders,
    }
    const poll = await run(pollOptions)
    await test('folder poll: one request per tick, re-renders only when the folders change', async () => {
        const entry = poll.intervals.find(i => i.ms === 3000)
        assert.ok(entry, 'the folder poll interval should be armed')
        const pollGets = () => poll.gets.filter(g => g.path[0] === 'folders' && g.query && g.query.order_by === 'updated_time').length
        // First tick establishes the baseline: one request, no re-render.
        let getsMark = pollGets(); let htmlMark = poll.setHtmlCalls
        await entry.fn()
        assert.strictEqual(pollGets() - getsMark, 1, 'exactly one folder request per tick')
        assert.strictEqual(poll.setHtmlCalls, htmlMark, 'the baseline tick must not re-render')
        // Second tick, folders unchanged: one request, still no re-render.
        getsMark = pollGets(); htmlMark = poll.setHtmlCalls
        await entry.fn()
        assert.strictEqual(pollGets() - getsMark, 1, 'exactly one folder request per tick')
        assert.strictEqual(poll.setHtmlCalls, htmlMark, 'no change must not re-render')
        // Third tick after a rename: the hash changes, so the panel re-renders.
        pollOptions.folders = [{ id: 'f'.repeat(32), title: 'Inbox renamed', parent_id: '', updated_time: 2000 }]
        htmlMark = poll.setHtmlCalls
        await entry.fn()
        assert.ok(poll.setHtmlCalls > htmlMark, 'a folder rename must trigger a re-render')
    })

    // ------------------------------------------------ fast first paint + background fill (B1)
    // A fully-shaped profile so a hand-built profileData renders without falling back. Spread and override
    // per test. searchCriteria differs between profiles so each has its own cache key.
    const baseProfile = {
        name: 'P', searchCriteria: '', noteID: '',
        showCompletedPast: true, showCompletedToday: true, showCompletedFuture: true, showCompletedNoDue: true,
        showNoDue: true, showNotes: false, noDueDatesAtEnd: false, displayFormat: 'interval',
        yearFormat: 'numeric', monthFormat: 'long', dayFormat: 'numeric', weekdayFormat: 'long',
        timeIs12Hour: true, sortOrder: 0, weekStartsOn: 1, maxDotsPerDay: 4,
    }
    const b1Todos = [
        { id: 'a'.repeat(32), title: 'Alpha', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: 'n'.repeat(32), user_updated_time: 1 },
        { id: 'b'.repeat(32), title: 'Beta', todo_completed: 0, todo_due: Date.now() + 7200000, parent_id: 'n'.repeat(32), user_updated_time: 1 },
    ]
    const countBodyFetches = (state) => state.gets.filter(g =>
        g.path[0] === 'notes' && g.path.length === 2 && g.query && Array.isArray(g.query.fields) &&
        g.query.fields.length === 1 && g.query.fields[0] === 'body').length
    const countSearches = (state) => state.gets.filter(g => g.path[0] === 'search').length

    // (a) A desktop profile switch must paint the whole list before it fetches a single checkbox body.
    // Profile Two gets DISTINCT ids so its checkbox bodies are genuinely uncached at switch time (startup
    // already warmed profile One's), forcing the background fill to fetch them - after the fast paint.
    const b1TodosTwo = [
        { id: 'c'.repeat(32), title: 'Gamma', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: 'n'.repeat(32), user_updated_time: 1 },
        { id: 'd'.repeat(32), title: 'Delta', todo_completed: 0, todo_due: Date.now() + 7200000, parent_id: 'n'.repeat(32), user_updated_time: 1 },
    ]
    const switchDesktop = await run({
        dataDir: path.join(tmp, 'b1-switch-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: (q) => q.includes('tag:two') ? b1TodosTwo : b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...baseProfile, id: 1, name: 'One', searchCriteria: 'tag:one', sortOrder: 0 },
                { ...baseProfile, id: 2, name: 'Two', searchCriteria: 'tag:two', sortOrder: 1 },
            ] }),
            currentProfileID: 1,
        },
    })
    await test('desktop fast paint: a profile switch paints the list before any checkbox-body fetch', async () => {
        const mark = switchDesktop.callLog.length
        await switchDesktop.panelMessageHandler(['profilesDropdownChanged', 2])
        const seq = switchDesktop.callLog.slice(mark)
        const firstPaint = seq.indexOf('setHtml')
        const firstBody = seq.indexOf('bodyFetch')
        assert.ok(firstPaint >= 0, 'the switch should paint the panel')
        assert.ok(firstBody >= 0, 'the switch should still fetch the checkbox bodies in the background')
        assert.ok(firstPaint < firstBody, 'the fast paint must precede the first note-body fetch')
    })

    // (b) Generating an overview note must fetch zero checkbox bodies. Proven by a diff: an extra profile
    // whose to-do list is written to a note adds NO body fetches over the same run without it.
    const mdNoOverview = await run({
        dataDir: path.join(tmp, 'b1-md-none-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [
                { ...baseProfile, id: 1, name: 'Active', searchCriteria: 'tag:active', noteID: '' },
            ] }),
            currentProfileID: 1,
        },
    })
    const mdWithOverview = await run({
        dataDir: path.join(tmp, 'b1-md-note-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...baseProfile, id: 1, name: 'Active', searchCriteria: 'tag:active', noteID: '' },
                { ...baseProfile, id: 2, name: 'Overview', searchCriteria: 'tag:other', noteID: 'ov' },
            ] }),
            currentProfileID: 1,
        },
        notes: { ov: { id: 'ov', title: 'Overview', body: 'stale' } },
    })
    await test('markdown overview: writing the note fetches zero checkbox bodies', () => {
        assert.ok(mdWithOverview.notePuts.some(p => p.id === 'ov'), 'the overview note should have been written')
        assert.ok(mdWithOverview.notePuts.some(p => p.id === 'ov' && p.body.includes('](:/')), 'the overview note is a to-do list')
        assert.strictEqual(
            countBodyFetches(mdWithOverview), countBodyFetches(mdNoOverview),
            'the overview-note profile must add no checkbox-body fetches')
    })

    // (c) Switching back to an already-viewed profile paints from the cached result set with zero searches
    // (the background scheduleRefresh, on a real timer, is what refetches later - it is not driven here).
    const cacheDesktop = await run({
        dataDir: path.join(tmp, 'b1-cache-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...baseProfile, id: 1, name: 'One', searchCriteria: 'tag:one', sortOrder: 0 },
                { ...baseProfile, id: 2, name: 'Two', searchCriteria: 'tag:two', sortOrder: 1 },
            ] }),
            currentProfileID: 1,
        },
    })
    await test('switch cache: returning to a viewed profile paints from cache, then one background truth refresh', async () => {
        // View both profiles once so each result set is cached, then switch away.
        await cacheDesktop.panelMessageHandler(['profilesDropdownChanged', 2])
        await cacheDesktop.panelMessageHandler(['profilesDropdownChanged', 1])
        await cacheDesktop.panelMessageHandler(['profilesDropdownChanged', 2])
        const before = countSearches(cacheDesktop)
        const paintsBefore = cacheDesktop.setHtmlCalls
        await cacheDesktop.panelMessageHandler(['profilesDropdownChanged', 1])   // switch BACK to the cached profile
        // The instant paint (fast + fill) is served entirely from the cached result set - zero searches - so the
        // ONLY search is the single trailing background truth refresh, which catches external edits made while
        // this profile was not current. That is exactly one search: not a per-paint search, not a cascade.
        assert.strictEqual(countSearches(cacheDesktop) - before, 1, 'a switch back paints from cache, then does exactly one background truth refresh')
        assert.ok(cacheDesktop.setHtmlCalls > paintsBefore, 'it still repaints for the switched-to profile')
        assert.ok(cacheDesktop.panelHtml['panel-panel'].includes('Alpha'), 'the cached rows are painted')
    })

    // (d) Out-of-order guard: an older refresh frozen mid-search must not overwrite a newer paint once it
    // resumes. The gate freezes the older run with only ONE to-do; the newer run paints BOTH.
    const tokenDesktop = await run({
        dataDir: path.join(tmp, 'b1-token-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [
                { ...baseProfile, id: 1, name: 'Solo', searchCriteria: '' },
            ] }),
            currentProfileID: 1,
        },
    })
    await test('generation token: a delayed older refresh does not overwrite a newer paint', async () => {
        let releaseGate, entered
        const gatePromise = new Promise(resolve => { releaseGate = resolve })
        const enteredPromise = new Promise(resolve => { entered = resolve })
        tokenDesktop.searchGateUsed = false
        tokenDesktop.searchGate = { promise: gatePromise, todos: [b1Todos[0]], onEnter: entered }
        const older = tokenDesktop.panelMessageHandler(['sortDirectionClicked'])   // older: held mid-search
        await enteredPromise                                                       // ...confirmed parked on the gate
        await tokenDesktop.panelMessageHandler(['sortDirectionClicked'])           // newer: searches fresh, paints both
        const htmlAfterNewer = tokenDesktop.panelHtml['panel-panel']
        assert.ok(htmlAfterNewer.includes('b'.repeat(32)), 'the newer refresh painted both to-dos')
        releaseGate()                                                              // older resumes, now stale
        await older
        assert.strictEqual(tokenDesktop.panelHtml['panel-panel'], htmlAfterNewer, 'the stale older refresh must not overwrite the newer paint')
    })

    // ============================================================ B2: refresh-lane budgets + excluded notebooks
    // These are the empirical before/after of the lane split. They are written to FAIL on the pre-branch
    // architecture, where one scheduleRefresh armed a 1/5/15/30s cascade of FULL refreshInterfaces (panel +
    // every overview note + fill), a profile switch armed that cascade too, and sync complete armed it as well.
    // The lanes replace it with: a switch that arms nothing, a bounded reconcile job (panel only, early-stop),
    // and a single debounced overview pass. The reconcile/overview timers are captured by the harness so the
    // suite can fire them by hand and count the work they do.
    const RECONCILE_OFFSETS = [1000, 3000, 7000, 15000, 30000]
    const OVERVIEW_DEBOUNCE = 10000
    const criteriaSearches = (state, needle) => state.gets.filter(g =>
        g.path[0] === 'search' && g.query && String(g.query.query || '').includes(needle)).length
    const targetedNoteGets = (state) => state.gets.filter(g =>
        g.path[0] === 'notes' && g.path.length === 2 && g.query && Array.isArray(g.query.fields) && g.query.fields.length > 1).length
    const armedSince = (state, mark) => state.timeouts.slice(mark)

    // (a) A profile switch arms NO lane: no reconcile job, no overview regen, and still paints before any body.
    const laneSwitch = await run({
        dataDir: path.join(tmp, 'b2-switch-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: (q) => q.includes('tag:two') ? b1TodosTwo : b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 4, profiles: [
                { ...baseProfile, id: 1, name: 'One', searchCriteria: 'tag:one', sortOrder: 0, noteID: '' },
                { ...baseProfile, id: 2, name: 'Two', searchCriteria: 'tag:two', sortOrder: 1, noteID: '' },
                { ...baseProfile, id: 3, name: 'Ov', searchCriteria: 'tag:ovonly', sortOrder: 2, noteID: 'ovnote' },
            ] }),
            currentProfileID: 1,
        },
        notes: { ovnote: { id: 'ovnote', title: 'Ov', body: 'stale' } },
    })
    await test('budget a / switch: a profile switch arms no reconcile job, no overview regen, and paints before any body', async () => {
        const timeoutMark = laneSwitch.timeouts.length
        const ovBefore = criteriaSearches(laneSwitch, 'tag:ovonly')
        const logMark = laneSwitch.callLog.length
        await laneSwitch.panelMessageHandler(['profilesDropdownChanged', 2])
        const armed = armedSince(laneSwitch, timeoutMark)
        // The pre-branch switch armed scheduleRefresh's 1s debounce + 5/15/30s follow-ups here.
        assert.strictEqual(
            armed.filter(t => RECONCILE_OFFSETS.includes(t.ms) || t.ms === OVERVIEW_DEBOUNCE).length, 0,
            'a switch must arm no reconcile or overview lane timer')
        for (const t of armed) await laneSwitch.fireTimeout(t)
        assert.strictEqual(criteriaSearches(laneSwitch, 'tag:ovonly') - ovBefore, 0, 'a switch must regenerate no overview note')
        const seq = laneSwitch.callLog.slice(logMark)
        const firstPaint = seq.indexOf('setHtml'), firstBody = seq.indexOf('bodyFetch')
        assert.ok(firstPaint >= 0, 'the switch paints')
        assert.ok(firstBody < 0 || firstPaint < firstBody, 'the fast paint precedes any checkbox-body fetch')
    })

    // (b) A single external note change: ONE targeted GET, ONE debounced overview pass (not 4), bounded reconcile.
    const laneChange = await run({
        dataDir: path.join(tmp, 'b2-change-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...baseProfile, id: 1, name: 'Active', searchCriteria: '', noteID: '' },
                { ...baseProfile, id: 2, name: 'Ov', searchCriteria: 'tag:ovb', noteID: 'ovb' },
            ] }),
            currentProfileID: 1,
        },
        notes: {
            ovb: { id: 'ovb', title: 'Ov', body: 'stale' },
            ['x'.repeat(32)]: { id: 'x'.repeat(32), title: 'Changed', parent_id: 'n'.repeat(32), is_todo: 1, todo_completed: 0, todo_due: 0, deleted_time: 0, user_updated_time: 5 },
        },
    })
    await test('budget b / note change: one targeted GET, one debounced overview pass, bounded reconcile — not a 4x cascade', async () => {
        const getBefore = targetedNoteGets(laneChange)
        const ovBefore = criteriaSearches(laneChange, 'tag:ovb')
        const panelBefore = countSearches(laneChange) - ovBefore
        const timeoutMark = laneChange.timeouts.length
        await laneChange.noteChangeHandler({ id: 'x'.repeat(32) })
        // A single external change costs exactly one targeted note GET (the reconcile fetch), never a sweep.
        assert.strictEqual(targetedNoteGets(laneChange) - getBefore, 1, 'a single external change costs one targeted GET')
        const armed = armedSince(laneChange, timeoutMark)
        assert.strictEqual(armed.filter(t => RECONCILE_OFFSETS.includes(t.ms)).length, 5, 'one reconcile job of five offsets')
        assert.strictEqual(armed.filter(t => t.ms === OVERVIEW_DEBOUNCE).length, 1, 'exactly one overview debounce')
        for (const t of armed) await laneChange.fireTimeout(t)
        // The overview note is regenerated ONCE. On the pre-branch cascade it was regenerated four times.
        assert.strictEqual(criteriaSearches(laneChange, 'tag:ovb') - ovBefore, 1, 'the overview note is regenerated once, not 4x')
        // The panel reconcile is bounded to its five offsets' searches - not an unbounded/stacked set.
        const panelAfter = countSearches(laneChange) - criteriaSearches(laneChange, 'tag:ovb')
        assert.ok(panelAfter - panelBefore <= 5, 'the reconcile lane issues at most its five bounded searches')
    })

    // (c) The reconcile job stops EARLY once the search reflects the ticked state (its optimistic entry retires).
    const laneEarlyOptions = {
        dataDir: path.join(tmp, 'b2-early-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [{ id: 'a'.repeat(32), title: 'Tick', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: 'n'.repeat(32), user_updated_time: 1 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...baseProfile, id: 1, name: 'Solo', searchCriteria: '', noteID: '' }] }),
            currentProfileID: 1,
        },
    }
    const laneEarly = await run(laneEarlyOptions)
    await test('budget c / reconcile: the job stops early once the search agrees with the tick', async () => {
        const id = 'a'.repeat(32)
        const timeoutMark = laneEarly.timeouts.length
        await laneEarly.panelMessageHandler(['todoChecked', id, true])
        const recTimers = armedSince(laneEarly, timeoutMark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        assert.strictEqual(recTimers.length, 5, 'the tick arms one reconcile job of five offsets')
        // First poll: the index has not caught up (the search still returns the to-do incomplete), so the
        // completion override stays pending and the later offsets remain armed.
        await laneEarly.fireTimeout(recTimers[0])
        assert.ok(!recTimers[1].cleared && !recTimers[4].cleared, 'while the index lags, the later offsets stay armed')
        // The index catches up: the search now returns the to-do completed.
        laneEarlyOptions.todos = [{ id, title: 'Tick', todo_completed: Date.now(), todo_due: Date.now() + 3600000, parent_id: 'n'.repeat(32), user_updated_time: 2 }]
        await laneEarly.fireTimeout(recTimers[1])
        assert.ok(recTimers[2].cleared && recTimers[3].cleared && recTimers[4].cleared, 'the reconcile job cancels its remaining offsets once the search agrees')
    })

    // (d) Sync start + complete each do one fast render; complete arms ONE reconcile job and no overview lane.
    const laneSync = await run({
        dataDir: path.join(tmp, 'b2-sync-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...baseProfile, id: 1, name: 'Active', searchCriteria: '', noteID: '' },
                { ...baseProfile, id: 2, name: 'Ov', searchCriteria: 'tag:ovd', noteID: 'ovd' },
            ] }),
            currentProfileID: 1,
        },
        notes: { ovd: { id: 'ovd', title: 'Ov', body: 'stale' } },
    })
    await test('budget d / sync: start and complete each do one fast render; complete arms one reconcile job and one overview pass', async () => {
        const bodiesBefore = countBodyFetches(laneSync), ovBefore = criteriaSearches(laneSync, 'tag:ovd')
        const startMark = laneSync.timeouts.length
        await laneSync.syncStartHandler()
        assert.strictEqual(countBodyFetches(laneSync) - bodiesBefore, 0, 'sync start fetches no checkbox bodies (fast render only)')
        assert.strictEqual(criteriaSearches(laneSync, 'tag:ovd') - ovBefore, 0, 'sync start regenerates no overview note')
        assert.strictEqual(armedSince(laneSync, startMark).length, 0, 'sync start arms no lane timer')
        const completeMark = laneSync.timeouts.length
        const bodiesBeforeDone = countBodyFetches(laneSync)
        await laneSync.syncCompleteHandler({ withErrors: false })
        assert.strictEqual(countBodyFetches(laneSync) - bodiesBeforeDone, 0, 'sync complete fetches no checkbox bodies (fast render only)')
        const armed = armedSince(laneSync, completeMark)
        assert.strictEqual(armed.filter(t => RECONCILE_OFFSETS.includes(t.ms)).length, 5, 'sync complete arms one reconcile job')
        // A single overview pass is armed too: if the sync's last onNoteChange settled more than the overview
        // debounce before completion, that debounce already fired mid-sync on a stale snapshot and nothing
        // re-armed it, so the overview notes would stay stale until the periodic backstop without this.
        assert.strictEqual(armed.filter(t => t.ms === OVERVIEW_DEBOUNCE).length, 1, 'sync complete arms exactly one overview pass')
        const ovMark = criteriaSearches(laneSync, 'tag:ovd')
        for (const t of armed) await laneSync.fireTimeout(t)
        // The reconcile polls only search the panel; the ONE overview lane regenerates the overview note once.
        assert.strictEqual(criteriaSearches(laneSync, 'tag:ovd') - ovMark, 1, 'the post-sync overview lane regenerates the overview note exactly once')
    })

    // (e) Excluded notebooks: hidden everywhere, id-tracked (rename-safe), and a same-titled namesake is spared.
    // Every folder id is HEX, as a real Joplin id is: the visible field now shows each excluded notebook's id beside its name, whole,
    // and an id that is not 6-32 hex characters could not be read back out of that text, so it is deliberately not written into it.
    const K = 'c'.repeat(32), P = 'd'.repeat(32), AC = 'a'.repeat(32), AP = 'b'.repeat(32), T = 'e'.repeat(32), S = 'f'.repeat(32)
    const exFolders = [
        { id: K, title: 'Client', parent_id: '', updated_time: 10 },
        { id: P, title: 'Personal', parent_id: '', updated_time: 11 },
        { id: AC, title: 'Archive', parent_id: K, updated_time: 12 },   // excluded (via the Client/Archive path)
        { id: AP, title: 'Archive', parent_id: P, updated_time: 13 },   // NAMESAKE - shares the title, NOT excluded
        { id: T, title: 'Trash', parent_id: '', updated_time: 14 },     // excluded (unique title -> a server clause)
        { id: S, title: 'Sub', parent_id: T, updated_time: 15 },        // descendant of Trash -> excluded too
    ]
    const exOptions = {
        dataDir: path.join(tmp, 'b2-exclude-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [
            { id: '1'.repeat(32), title: 'KeepMe', todo_completed: 0, todo_due: 0, parent_id: K, user_updated_time: 1 },
            { id: '2'.repeat(32), title: 'ArchivedC', todo_completed: 0, todo_due: 0, parent_id: AC, user_updated_time: 1 },
            { id: '3'.repeat(32), title: 'NamesakeP', todo_completed: 0, todo_due: 0, parent_id: AP, user_updated_time: 1 },
            { id: '4'.repeat(32), title: 'TrashedItem', todo_completed: 0, todo_due: 0, parent_id: T, user_updated_time: 1 },
            { id: '5'.repeat(32), title: 'SubItem', todo_completed: 0, todo_due: 0, parent_id: S, user_updated_time: 1 },
        ],
        folders: exFolders,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [
                { ...baseProfile, id: 1, name: 'All', searchCriteria: '', noteID: 'ov', showNotes: false },
            ] }),
            currentProfileID: 1,
        },
        notes: { ov: { id: 'ov', title: 'Overview', body: 'stale' } },
    }
    const ex = await run(exOptions)
    // Apply the exclusion by NAME, exactly as the user would. 'Client/Archive' (a path) disambiguates the
    // excluded Archive from its namesake; 'Trash' is a bare unique title.
    await ex.setSetting('excludedNotebooks', 'Client/Archive, Trash')

    await test('budget e / exclude: excluded notebooks (and descendants) vanish from rows; the namesake stays', () => {
        const html = ex.panelHtml['panel-panel']
        assert.ok(html.includes('KeepMe'), 'a kept notebook\'s to-do is shown')
        assert.ok(html.includes('NamesakeP'), 'a non-excluded notebook sharing the excluded title is NOT excluded')
        assert.ok(!html.includes('ArchivedC'), 'the excluded notebook\'s to-do is hidden')
        assert.ok(!html.includes('TrashedItem'), 'the other excluded notebook\'s to-do is hidden')
        assert.ok(!html.includes('SubItem'), 'a descendant of an excluded notebook is hidden too')
    })
    await test('budget e / exclude: resolution stores ids and canonicalises the visible text', () => {
        assert.strictEqual(ex.settings.excludedNotebookIds, `${AC},${T}`, 'the resolved ids are stored (source of truth)')
        assert.strictEqual(ex.settings.excludedNotebooks, `Client / Archive (${AC}), Trash (${T})`,
            'the visible text is rewritten to name AND id (path form where the title is ambiguous, the whole id in brackets)')
    })
    await test('budget e / exclude: no checkbox body is fetched for an excluded to-do (even when every body is stale)', async () => {
        // Make every to-do's body stale so a fresh render must refetch the KEPT ones - proving the excluded
        // ones are dropped BEFORE the body fetch rather than merely served from a warm cache. (Measuring across
        // the whole run would also see the pre-exclusion startup fetch, so this measures one fresh render.)
        exOptions.todos = exOptions.todos.map(t => ({ ...t, user_updated_time: t.user_updated_time + 100 }))
        const mark = ex.gets.length
        await ex.panelMessageHandler(['sortDirectionClicked'])
        const fetched = ex.gets.slice(mark).filter(g =>
            g.path[0] === 'notes' && g.path.length === 2 && g.query && Array.isArray(g.query.fields) &&
            g.query.fields.length === 1 && g.query.fields[0] === 'body').map(g => g.path[1])
        assert.ok(fetched.includes('1'.repeat(32)) && fetched.includes('3'.repeat(32)), 'a kept to-do\'s stale body is refetched')
        assert.ok(!fetched.includes('2'.repeat(32)) && !fetched.includes('4'.repeat(32)) && !fetched.includes('5'.repeat(32)), 'excluded to-dos are dropped before the body fetch')
    })
    await test('budget e / exclude: the overview note excludes the same to-dos', () => {
        const ovPuts = ex.notePuts.filter(p => p.id === 'ov')
        const body = ovPuts[ovPuts.length - 1].body
        assert.ok(body.includes('KeepMe') && body.includes('NamesakeP'), 'the overview lists the kept to-dos')
        assert.ok(!body.includes('ArchivedC') && !body.includes('TrashedItem') && !body.includes('SubItem'), 'the overview omits the excluded to-dos')
    })
    await test('budget e / exclude: the notebook filter/picker omits excluded notebooks (and descendants)', () => {
        const html = ex.panelHtml['panel-panel']
        assert.ok(html.includes('Personal / Archive'), 'the namesake notebook is still offered')
        assert.ok(!html.includes('Client / Archive'), 'the excluded notebook is not offered')
        assert.ok(!html.includes('>Trash<'), 'the excluded notebook is not offered')
        assert.ok(!html.includes('>Sub<'), 'a descendant of an excluded notebook is not offered')
    })
    await test('budget e / exclude: the server query negates only the unambiguous excluded title', () => {
        const searches = ex.gets.filter(g => g.path[0] === 'search' && g.query && String(g.query.query || '').includes('type:todo'))
        const query = String(searches[searches.length - 1].query.query)
        assert.ok(query.includes('-notebook:"Trash"'), 'a uniquely-titled excluded notebook gets a server-side negation')
        assert.ok(!query.includes('-notebook:"Archive"'), 'an excluded title shared with a kept notebook is NOT negated server-side (client id-filter handles it)')
    })
    await test('budget e / exclude: renaming an excluded notebook keeps it excluded (id-tracked) and refreshes the text, no loop', async () => {
        const pollEntry = ex.intervals.find(i => i.ms === 3000)
        assert.ok(pollEntry, 'the folder poll is armed')
        await pollEntry.fn()                                   // baseline signature
        // Rename the excluded Archive-under-Client to a now-unique title (same id).
        exOptions.folders = exFolders.map(f => f.id === AC ? { ...f, title: 'ArchivedFolder', updated_time: 999 } : f)
        await pollEntry.fn()                                   // detects the change -> reconciles the excluded text
        assert.strictEqual(ex.settings.excludedNotebookIds, `${AC},${T}`, 'the id list is unchanged - exclusion survives the rename')
        assert.strictEqual(ex.settings.excludedNotebooks, `ArchivedFolder (${AC}), Trash (${T})`,
            'the visible text is refreshed to the new (now unique) title, and the id beside it is unchanged')
        // No onChange loop: another poll with the same folders changes nothing further.
        const textBefore = ex.settings.excludedNotebooks
        await pollEntry.fn()
        assert.strictEqual(ex.settings.excludedNotebooks, textBefore, 'the reconcile settles - no oscillation')
        // Still excluded from the rows after the rename.
        await ex.panelMessageHandler(['sortDirectionClicked'])
        assert.ok(!ex.panelHtml['panel-panel'].includes('ArchivedC'), 'the renamed notebook\'s to-do stays excluded')
    })

    // ------------------------------------------------------- the field shows the NAME and the WHOLE ID (2.6.1, 2.6.2)
    // The owner's refinement: both of Cockpit's reference-holding settings must show what they point at, not just
    // what it is called. "Excluded notebooks" therefore reads "Lab / Joplin (fdfd6c06...)" - the canonical label it
    // always built, plus the id - and still PARSES BACK, so the field stays a field the user types into. 2.6.1 showed
    // the first eight characters of the id and the owner's live round reversed that: a prefix of an id reads as a
    // DIFFERENT id, so the whole thing is shown. The pure half (what counts as an id, and how a bracketed one is read
    // back) is src/core/displayId.js, which the harness requires directly, three checks below.
    const idLab = 'fdfd6c06' + '0'.repeat(24)
    const idJoplin = 'a1b2c3d4' + '0'.repeat(24)
    const idArchive = 'b0b0b0b0' + '0'.repeat(24)
    // Two ids sharing their first EIGHT characters and differing at the ninth: 2.6.1 showed eight and had to lengthen
    // them to ten to tell these apart; showing the whole id tells them apart with no rule at all.
    const idTwinA = 'abcdef01' + '22' + '0'.repeat(22)
    const idTwinB = 'abcdef01' + '33' + '0'.repeat(22)
    // A notebook a user REALLY named with a bracketed hex word. Nothing may read that as an id - and nothing does,
    // because 'deadbeef' is not the start of any id in this map.
    const idBudget = 'c0ffee11' + '0'.repeat(24)
    const dispFolders = [
        { id: idLab, title: 'Lab', parent_id: '', updated_time: 10 },
        { id: idJoplin, title: 'Joplin', parent_id: idLab, updated_time: 11 },
        { id: idArchive, title: 'Archive', parent_id: '', updated_time: 12 },
        { id: idTwinA, title: 'TwinOne', parent_id: '', updated_time: 13 },
        { id: idTwinB, title: 'TwinTwo', parent_id: '', updated_time: 14 },
        { id: idBudget, title: 'Budget (deadbeef)', parent_id: '', updated_time: 15 },
    ]
    const dispOptions = {
        dataDir: path.join(tmp, 'display-id-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [],
        folders: dispFolders,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...baseProfile, id: 1, name: 'All', searchCriteria: '', noteID: '', showNotes: false }] }),
            currentProfileID: 1,
        },
    }
    const disp = await run(dispOptions)

    await test('excluded notebooks display: a typed name comes back as "Name (id)", and reading that back writes nothing', async () => {
        await disp.setSetting('excludedNotebooks', 'Archive')
        assert.strictEqual(disp.settings.excludedNotebooks, `Archive (${idArchive})`, 'the user typed a name and gets the name AND the whole id')
        assert.strictEqual(disp.settings.excludedNotebookIds, idArchive, 'the hidden id list is the full id, as it always was')
        // THE ROUND TRIP, which is the whole reason the id is written in a form that parses: saving the field again
        // resolves to the same id and rebuilds the same text, so the second pass has nothing to write at all.
        const mark = disp.settingWrites.length
        await disp.setSetting('excludedNotebooks', disp.settings.excludedNotebooks)
        assert.deepStrictEqual(disp.settingWrites.slice(mark).filter(w => w.key !== 'excludedNotebooks').map(w => w.key), [],
            'a second resolve pass over Cockpit\'s own text writes nothing back')
        assert.strictEqual(disp.settings.excludedNotebooks, `Archive (${idArchive})`, 'and leaves the text byte-identical')
    })

    await test('excluded notebooks display: a path entry keeps its path, and two ids sharing eight characters are still told apart', async () => {
        await disp.setSetting('excludedNotebooks', 'Lab/Joplin, TwinOne')
        assert.strictEqual(disp.settings.excludedNotebooks, `Joplin (${idJoplin}), TwinOne (${idTwinA})`,
            'a unique title stays a bare title, and the whole id is shown - which is what makes the twins distinguishable')
        assert.strictEqual(disp.settings.excludedNotebookIds, `${idJoplin},${idTwinA}`)
        // The twins differ only at the ninth character, which is exactly the case 2.6.1 needed a lengthening rule for.
        assert.notStrictEqual(idTwinA, idTwinB)
        assert.strictEqual(idTwinA.slice(0, 8), idTwinB.slice(0, 8), 'precondition: eight characters name both of them')
        await disp.setSetting('excludedNotebooks', 'TwinTwo')
        assert.strictEqual(disp.settings.excludedNotebooks, `TwinTwo (${idTwinB})`, 'and the other twin shows its own id, in full')
        assert.strictEqual(disp.settings.excludedNotebookIds, idTwinB)
    })

    await test('excluded notebooks display: THE ID WINS over a name the user has not re-typed since the rename', async () => {
        await disp.setSetting('excludedNotebooks', 'Archive')
        // The notebook is renamed in Joplin; the field still says what the user last typed. The id in the brackets
        // is the thing that was true, so it resolves and the NAME half is refreshed from it.
        const poll = disp.intervals.find(interval => interval.ms === 3000)
        await poll.fn()                                     // the first pass only records the folder baseline
        dispOptions.folders = dispFolders.map(f => f.id === idArchive ? { ...f, title: 'Archived', updated_time: 999 } : f)
        await poll.fn()                                     // ...and now the rename is seen
        await disp.setSetting('excludedNotebooks', 'Archive (b0b0b0b0)')
        assert.strictEqual(disp.settings.excludedNotebookIds, idArchive, 'the exclusion survives a rename the user never re-typed')
        assert.strictEqual(disp.settings.excludedNotebooks, `Archived (${idArchive})`,
            'the shown name catches up with the notebook - and the short id 2.6.1 wrote is rewritten whole')
        dispOptions.folders = dispFolders
        await poll.fn()                                     // put the fixture back for the checks below
        assert.strictEqual(disp.settings.excludedNotebooks, `Archive (${idArchive})`, 'and follows it back again')
    })

    await test('excluded notebooks display: a notebook genuinely NAMED "Budget (deadbeef)" is not read as an id', async () => {
        // The bracketed word is hex and the right length, so only "is it the start of an id in this map?" tells the
        // two apart. It is not, so the WHOLE entry is the name - and the notebook gets its own real id beside it.
        await disp.setSetting('excludedNotebooks', 'Budget (deadbeef)')
        assert.strictEqual(disp.settings.excludedNotebookIds, idBudget, 'the notebook of that name is what was excluded')
        assert.strictEqual(disp.settings.excludedNotebooks, `Budget (deadbeef) (${idBudget})`, 'its own id is added; the name keeps its brackets')
    })

    await test('excluded notebooks display: an entry that names nothing is kept verbatim, with no id invented for it', async () => {
        await disp.setSetting('excludedNotebooks', 'Archive, Nosuchnotebook')
        assert.strictEqual(disp.settings.excludedNotebooks, `Archive (${idArchive}), Nosuchnotebook`,
            'the typo stays exactly as typed, so the user can see and fix it, and carries no bracket')
        assert.strictEqual(disp.settings.excludedNotebookIds, idArchive)
        await disp.setSetting('excludedNotebooks', '')
    })

    await test('excluded notebooks display: a full notebook id pasted into the field resolves, and an unknown one is still a typo', async () => {
        // The field PRINTS ids now, and the setting's own description offers pasting one, so a full id has to be an entry in
        // its own right - resolveEntry only ever knew titles and paths, so before this a pasted id was read as a name that
        // matched nothing and kept as a typo. It comes back rewritten like anything else.
        await disp.setSetting('excludedNotebooks', idArchive)
        assert.strictEqual(disp.settings.excludedNotebookIds, idArchive, 'the notebook that id names is the one excluded')
        assert.strictEqual(disp.settings.excludedNotebooks, `Archive (${idArchive})`, 'and the field answers with the name and the whole id')
        // Upper case is the same id: Joplin writes them lower-case, but a user pasting from somewhere else may not.
        await disp.setSetting('excludedNotebooks', idJoplin.toUpperCase())
        assert.strictEqual(disp.settings.excludedNotebookIds, idJoplin, 'case is not part of an id')
        // An id that names nothing here is exactly a typo, and is treated as one - not silently excluded, not dropped.
        const unknown = 'dddddddd' + '0'.repeat(24)
        await disp.setSetting('excludedNotebooks', `Archive, ${unknown}`)
        assert.strictEqual(disp.settings.excludedNotebooks, `Archive (${idArchive}), ${unknown}`, 'an unknown id is kept verbatim, with nothing invented')
        assert.strictEqual(disp.settings.excludedNotebookIds, idArchive, 'and excludes nothing')
        await disp.setSetting('excludedNotebooks', '')
        // THE COPY MUST MATCH THE BEHAVIOUR. The description is the only place a user is told a bare id works at all.
        const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'settings.ts'), 'utf8')
        const description = /\[EXCLUDED_NOTEBOOKS_KEY\]: \{[\s\S]*?description: "([^"]*)"/.exec(settingsSource)
        assert.ok(description, 'the Excluded notebooks setting must carry a description')
        assert.ok(/or a notebook id/i.test(description[1]), 'which promises a notebook id is accepted - the behaviour above')
        assert.ok(/Name \(id\)/.test(description[1]), 'and says what the field shows back')
        const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
        assert.ok(/a name, a Parent\/Sub path or a full id/.test(readme), 'and the README says the same three spellings')
    })

    await test('excluded notebooks display: a notebook with a BLANK title keeps its exclusion through a resolve pass', async () => {
        // NOTHING THAT CANNOT BE READ BACK IS EVER WRITTEN. A notebook with no title at all would give the label
        // " (e1e1e1e1)", and the parser refuses that - it wants a non-blank name in front of the brackets - so the id was
        // dropped on the very next resolve pass and the exclusion silently lost. (Main lost it too, by writing an empty
        // label.) With no name to show, the entry IS the full id, which is the one string that names the notebook and
        // survives being read back.
        const idBlank = 'e1e1e1e1' + '0'.repeat(24)
        dispOptions.folders = dispFolders.concat([{ id: idBlank, title: '', parent_id: '', updated_time: 16 }])
        const poll = disp.intervals.find(interval => interval.ms === 3000)
        await poll.fn()
        await poll.fn()
        await disp.setSetting('excludedNotebooks', idBlank)
        assert.strictEqual(disp.settings.excludedNotebookIds, idBlank, 'the nameless notebook is excluded')
        assert.strictEqual(disp.settings.excludedNotebooks, idBlank, 'and the field holds the one string that names it')
        // THE RESOLVE PASS THAT USED TO LOSE IT: feed the field's own text back in.
        await disp.setSetting('excludedNotebooks', disp.settings.excludedNotebooks)
        assert.strictEqual(disp.settings.excludedNotebookIds, idBlank, 'reading Cockpit\'s own text back keeps the exclusion')
        assert.strictEqual(disp.settings.excludedNotebooks, idBlank, 'and settles on the same text')
        await disp.setSetting('excludedNotebooks', '')
        dispOptions.folders = dispFolders
        await poll.fn()
    })

    // ------------------------------------------- the stored field is brought up to date AT STARTUP (2.6.2)
    // THE OWNER'S SECOND DEFECT, and the one the 2.6.1 review missed because every check drove the resolver
    // directly (set the value -> onChange -> rewrite) and none of them modelled A STARTUP THAT CHANGES NOTHING.
    // The visible text had exactly two rewrite sites: the settings onChange handler (the user edits that very
    // field) and the folder poll (and only when the folder signature CHANGES - the first poll of a session just
    // records the baseline). Neither runs at startup, so a field holding 2.6.0's bare "Archive" went on holding
    // it for ever. These checks are all the same shape: a device starts up, nothing else happens, and the field
    // is looked at.
    const startupFolders = [
        { id: idLab, title: 'Lab', parent_id: '', updated_time: 10 },
        { id: idJoplin, title: 'Joplin', parent_id: idLab, updated_time: 11 },
        { id: idArchive, title: 'Archive', parent_id: '', updated_time: 12 },
    ]
    // A to-do INSIDE the excluded notebook, so a check can ask the one question that matters to the user: is the
    // exclusion still doing its job on the very first paint of the session?
    const startupTodos = [{ id: '9'.repeat(32), title: 'InTheArchive', todo_completed: 0, todo_due: 0, parent_id: idArchive, user_updated_time: 1 }]
    const runStartup = (name, initialSettings, folders) => run({
        dataDir: path.join(tmp, `startup-${name}-data`),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: startupTodos,
        folders: folders || startupFolders,
        initialSettings: Object.assign({
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...baseProfile, id: 1, name: 'All', searchCriteria: '', noteID: '', showNotes: false }] }),
            currentProfileID: 1,
        }, initialSettings),
    })
    // Only the two exclusion keys: startup writes profileData (the store is normalised) whatever else happens.
    const exclusionWrites = (state) => state.settingWrites.filter(w => w.key === 'excludedNotebooks' || w.key === 'excludedNotebookIds')
    // The notebook map's own request, as opposed to the folder poll's (which carries order_by).
    const notebookMapGets = (state) => state.gets.filter(g => g.path[0] === 'folders' && !(g.query && g.query.order_by))

    await test('excluded notebooks at startup: a field 2.6.0 left holding a bare NAME gains the id, and the second startup writes nothing', async () => {
        const state = await runStartup('legacy-name', { excludedNotebooks: 'Archive', excludedNotebookIds: idArchive })
        assert.strictEqual(state.settings.excludedNotebooks, `Archive (${idArchive})`,
            'the field is brought up to date without the user touching it - which is the whole defect')
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive, 'the hidden ids are untouched: WHAT is excluded did not change')
        assert.deepStrictEqual(exclusionWrites(state).map(w => w.key), ['excludedNotebooks'], 'exactly one write, and only of the visible half')
        assert.strictEqual(state.notePuts.length, 0, 'and nothing is published - there is no settings note here')
        assert.strictEqual(notebookMapGets(state).length, 1, 'the notebook map is fetched once, which the panel does anyway')
        // ...AND IT SETTLES. The pass is idempotent, so the next launch of the same profile has nothing to say at all.
        const second = await runStartup('legacy-name-again', {
            excludedNotebooks: state.settings.excludedNotebooks,
            excludedNotebookIds: state.settings.excludedNotebookIds,
        })
        assert.deepStrictEqual(exclusionWrites(second), [], 'a second startup writes nothing at all')
        assert.strictEqual(second.settings.excludedNotebooks, `Archive (${idArchive})`, 'and leaves the text byte-identical')
    })

    await test('excluded notebooks at startup: a field 2.6.1 left holding a SHORT id is rewritten whole', async () => {
        const state = await runStartup('short-id', { excludedNotebooks: 'Archive (b0b0b0b0)', excludedNotebookIds: idArchive })
        assert.strictEqual(state.settings.excludedNotebooks, `Archive (${idArchive})`, 'the eight characters 2.6.1 wrote become the whole id')
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive, 'the hidden ids are untouched')
        assert.deepStrictEqual(exclusionWrites(state).map(w => w.key), ['excludedNotebooks'], 'one write of the visible half, and nothing else')
        assert.strictEqual(state.notePuts.length, 0, 'and nothing is published')
    })

    await test('excluded notebooks at startup: a field already in the current form is not written at all', async () => {
        const state = await runStartup('current-form', { excludedNotebooks: `Archive (${idArchive})`, excludedNotebookIds: idArchive })
        assert.deepStrictEqual(exclusionWrites(state), [], 'nothing to do, so nothing is written - the steady state every later launch is in')
        assert.strictEqual(state.settings.excludedNotebooks, `Archive (${idArchive})`)
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive)
    })

    await test('excluded notebooks at startup: with the feature OFF it costs no data call and no write', async () => {
        const state = await runStartup('feature-off', {})
        assert.deepStrictEqual(exclusionWrites(state), [], 'nothing is written into a feature nobody turned on')
        assert.strictEqual(notebookMapGets(state).length, 1, 'and the only notebook-map request is the one the panel makes for itself')
        // The count above cannot see the difference on its own - the map is TTL-cached, so a needless fetch here would be
        // served to the panel a moment later and still be one request. What it does catch is a pass that fetches folders
        // by some other route or drops the cache; the guard that makes the call unnecessary in the first place is the
        // early return, and that is what this reads.
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'settings.ts'), 'utf8')
        const pass = /export async function refreshExcludedNotebookDisplay\([\s\S]*?\n\}/.exec(source)
        assert.ok(pass, 'the startup pass must be findable in the source')
        const guard = pass[0].indexOf('if (!raw && !storedIdsCsv) return')
        const map = pass[0].indexOf('getNotebookMap()')
        assert.ok(guard > 0, 'the empty-pair early return must be there')
        assert.ok(guard < map, 'and it must come BEFORE the notebook map is asked for')
    })

    await test('excluded notebooks at startup: a short id is matched by PREFIX, so a renamed notebook keeps its exclusion', async () => {
        // THE MIGRATION'S REAL TEST. The notebook was renamed while Joplin was closed, and another notebook now carries
        // the name the field still shows - so the NAME half names the wrong notebook and only the eight characters 2.6.1
        // wrote name the right one. Matching them as a prefix is what keeps the exclusion where the user put it.
        const idImpostor = 'cafe0001' + '0'.repeat(24)
        const state = await runStartup('short-id-prefix', {
            excludedNotebooks: 'Archive (b0b0b0b0)',
            excludedNotebookIds: idArchive,
        }, [
            { id: idArchive, title: 'Archived', parent_id: '', updated_time: 12 },
            { id: idImpostor, title: 'Archive', parent_id: '', updated_time: 13 },
        ])
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive, 'the id in the brackets won, as it does on every other route in')
        assert.strictEqual(state.settings.excludedNotebooks, `Archived (${idArchive})`,
            'so the entry is rewritten to the notebook it always named, with its id whole')
    })

    // ---- ...AND THE WORLD CHANGES UNDER THE TEXT WHILE JOPLIN IS CLOSED -------------------------------------------
    // The review's finding, and the reason the startup pass reads the IDS and not the text. A name goes stale with
    // nobody typing anything: another device renames the notebook, or takes the name, or makes it ambiguous, and the
    // sync brings that in before this device ever looks at the field. Resolving the stale TEXT then deletes, moves or
    // adds an exclusion that the user never touched. Nothing here may change WHAT is excluded - only how it is shown.

    await test('excluded notebooks at startup: a notebook RENAMED while Joplin was closed keeps its exclusion, and the text follows it', async () => {
        const state = await runStartup('renamed-while-closed', {
            excludedNotebooks: 'Archive',                    // the 2.6.0 text, written when the notebook was called that
            excludedNotebookIds: idArchive,
        }, [{ id: idArchive, title: 'Archived', parent_id: '', updated_time: 12 }])
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive,
            'the stored id comes through untouched - a rename is not a request to stop excluding anything')
        assert.strictEqual(state.settings.excludedNotebooks, `Archived (${idArchive})`,
            'and the text is rebuilt from that id, so it shows the name the notebook has NOW')
        assert.deepStrictEqual(state.settingWrites.filter(w => w.key === 'excludedNotebookIds'), [],
            'the id list is never written by the startup pass at all')
        assert.strictEqual(state.notePuts.length, 0, 'and nothing is published')
        assert.ok(!String(state.panelHtml['panel-panel'] || '').includes('InTheArchive'),
            'the to-do in it is absent from the very first paint, which is the whole point of the exclusion')
    })

    await test('excluded notebooks at startup: a notebook that TOOK the freed name does not take the exclusion with it', async () => {
        const idImpostor = 'cafe0001' + '0'.repeat(24)
        const state = await runStartup('renamed-and-taken', {
            excludedNotebooks: 'Archive',
            excludedNotebookIds: idArchive,
        }, [
            { id: idArchive, title: 'Archived', parent_id: '', updated_time: 12 },
            { id: idImpostor, title: 'Archive', parent_id: '', updated_time: 13 },   // created elsewhere, under the old name
        ])
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive, 'the exclusion stays on the notebook it was put on')
        assert.strictEqual(state.settings.excludedNotebooks, `Archived (${idArchive})`, 'and the text names that notebook, not its namesake')
    })

    await test('excluded notebooks at startup: a stale name that has become AMBIGUOUS adds nothing', async () => {
        const idSecond = 'cafe0001' + '0'.repeat(24)
        const state = await runStartup('became-ambiguous', {
            excludedNotebooks: 'Archive',
            excludedNotebookIds: idArchive,
        }, [
            { id: idLab, title: 'Lab', parent_id: '', updated_time: 10 },
            { id: idArchive, title: 'Archive', parent_id: '', updated_time: 12 },
            { id: idSecond, title: 'Archive', parent_id: idLab, updated_time: 13 },  // a second one of that name, created elsewhere
        ])
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive,
            'exactly the stored id survives: a name the user typed once must not start excluding a notebook they never saw')
        assert.strictEqual(state.settings.excludedNotebooks, `Archive (${idArchive})`, 'and the text names that one, with its id to say which')
    })

    await test('excluded notebooks at startup: an entry that stands for no stored id is kept exactly as the user left it', async () => {
        const state = await runStartup('typo-kept', {
            excludedNotebooks: 'Archive, Nosuchnotebook',
            excludedNotebookIds: idArchive,
        })
        assert.strictEqual(state.settings.excludedNotebooks, `Archive (${idArchive}), Nosuchnotebook`,
            'the entry that names something is upgraded; the typo beside it is not touched, invented for, or tidied away')
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive, 'and nothing was added for it')
    })

    await test('excluded notebooks at startup: the pass\'s own write is not read back as a user edit', async () => {
        // THE RE-ENTRY, and the last way anything could add an exclusion nobody asked for. Writing the visible field
        // re-enters the settings onChange handler, whose resolver reads the TEXT and writes the IDS. Three states line
        // up here and all three are ordinary: a leftover entry the user never cleaned up ("Work" - the setting's own
        // description promises a typo stays visible), a notebook of that name created elsewhere since, and a rewrite,
        // which is guaranteed on the first launch of every install still holding a 2.6.0 or 2.6.1 form. The resolver
        // then excluded the new notebook and published it. The pass has already computed the text FROM the ids, so the
        // re-entry has nothing correct to add and is suppressed outright.
        const idWork = 'cafe0002' + '0'.repeat(24)
        const state = await runStartup('own-write-not-an-edit', {
            excludedNotebooks: 'Archive, Work',            // "Archive" is the excluded notebook's old name; "Work" was always a typo
            excludedNotebookIds: idArchive,
        }, [
            { id: idArchive, title: 'Archived', parent_id: '', updated_time: 12 },   // renamed while Joplin was closed
            { id: idWork, title: 'Work', parent_id: '', updated_time: 13 },          // created while Joplin was closed
        ])
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive,
            'the notebook that has since taken the leftover name is NOT excluded by it')
        assert.strictEqual(state.settings.excludedNotebooks, `Archived (${idArchive}), Work`,
            'the id is relabelled and the leftover entry is left exactly where the user left it')
        assert.deepStrictEqual(exclusionWrites(state).map(w => w.key), ['excludedNotebooks'],
            'and the write sequence carries no id write at all - the resolver did not run on our own write')
        assert.ok(String(state.panelHtml['panel-panel'] || '').includes('InTheArchive') === false, 'the real exclusion still holds')
    })

    await test('excluded notebooks: a USER edit still resolves normally through the same handler', async () => {
        // The other half of the suppression: it is one shot, and it is spent on the pass's own write. Everything the
        // user does afterwards goes through the resolver exactly as it always has.
        const idWork = 'cafe0002' + '0'.repeat(24)
        const state = await runStartup('user-edit-after-startup', {
            excludedNotebooks: 'Archive, Work',
            excludedNotebookIds: idArchive,
        }, [
            { id: idArchive, title: 'Archived', parent_id: '', updated_time: 12 },
            { id: idWork, title: 'Work', parent_id: '', updated_time: 13 },
        ])
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive, 'precondition: startup added nothing')
        // The user now really does want that notebook excluded, and types it.
        await state.setSetting('excludedNotebooks', 'Work')
        assert.strictEqual(state.settings.excludedNotebookIds, idWork, 'a name the USER typed resolves to its notebook, as it always did')
        assert.strictEqual(state.settings.excludedNotebooks, `Work (${idWork})`, 'and comes back with the id beside it')
        // ...and a second user edit is still resolved: nothing about the one-shot leaks into later changes.
        await state.setSetting('excludedNotebooks', 'Archived')
        assert.strictEqual(state.settings.excludedNotebookIds, idArchive, 'and so does the next one')
    })

    // ---- the display form itself: the pure module both settings share --------------------------------------------
    const DisplayID = require('../src/core/displayId.js')

    await test('display id: the id is shown WHOLE - nothing is truncated anywhere in the display path', () => {
        const full = 'abcdef0123456789abcdef0123456789'
        assert.strictEqual(DisplayID.displayID(full), full, 'the whole id, because a prefix of an id reads as a different id')
        assert.strictEqual(DisplayID.displayID('ABCDEF0123456789ABCDEF0123456789'), full, 'ids are shown lower-case')
        assert.strictEqual(DisplayID.displayID(`  ${full}  `), full, 'and trimmed')
        // The one refusal: what cannot be read back is not written. A Joplin id is always 32 hex characters, so this
        // is only ever reached by a fixture or something foreign - and it gets a bare name rather than a broken id.
        for (const notAnID of ['', 'f1', 'abcde', 'not-hex-at-all', 'zzzzzzzz', 'a'.repeat(33)]){
            assert.strictEqual(DisplayID.displayID(notAnID), '', `"${notAnID}" is not an id this display form can carry`)
        }
        assert.strictEqual(DisplayID.displayID('abcdef'), 'abcdef', 'six characters is the shortest the parse side reads, and is shown whole')
        // NO TRUNCATION IN THE SOURCE EITHER. 2.6.1 cut the id to its first eight characters and lengthened that on a
        // collision; the owner reversed it, and this is the pin that stops any of it creeping back into a display path.
        // NO TRUNCATION IN THE SOURCE EITHER, over every file that builds or writes one of the two fields - the two
        // pure modules, settingsSync.ts (which writes the note reference) and panel.ts (which rebuilds the notebook
        // text from ids). The shapes are matched on the CUT, not on the name of the thing being cut: 2.6.1's own line
        // was `var prefix = text.slice(0, length)`, whose receiver is not called "id" at all, and a backstop that
        // insisted on an id-shaped name would have let exactly the code it exists to catch straight through. Array
        // receivers that have every right to be sliced are named instead, which is a list of two words rather than a
        // rule about names.
        const ARRAY_RECEIVERS = ['profiles', 'items']
        const truncationHits = (source) => {
            // Comment lines go first: they talk about the eight characters 2.6.1 wrote, and must go on doing so.
            const code = source.split('\n').filter(line => !/^\s*[*/]/.test(line) && !/^\s*\/\//.test(line)).join('\n')
            const hits = []
            for (const match of code.matchAll(/(\w+)\s*\.\s*(?:slice|substr|substring)\s*\(\s*[^)]/g)){
                if (!ARRAY_RECEIVERS.includes(match[1])) hits.push(match[0])
            }
            // "keep the first n characters" by regex, and a string literal that is nothing but an ellipsis. A real
            // sentence that happens to end in one ("Syncing... (click to cancel)") is prose, and is left alone.
            for (const pattern of [/\.replace\(\s*\/\^?\(?\.\{\d+\}/, /(['"`])\s*(?:\.\.\.|…)\s*\1/]){
                const found = pattern.exec(code)
                if (found) hits.push(found[0])
            }
            return hits
        }
        // THE BACKSTOP IS ITSELF TESTED, against the exact line 2.6.1 shipped and the two other shapes - because a
        // scan that quietly matches nothing is worse than no scan at all.
        assert.deepStrictEqual(truncationHits('var prefix = text.slice(0, length)'), ['text.slice(0'],
            'the line 2.6.1 actually shortened ids with must be caught')
        assert.strictEqual(truncationHits("settingsNoteDisplay(title, String(id).replace(/^(.{8}).*/, '$1'))").length, 1,
            'and so must a first-n-characters regex')
        assert.strictEqual(truncationHits("label + ' (' + id.slice(0, 8) + '...' + ')'").length, 2, 'and a cut with an ellipsis on it')
        assert.deepStrictEqual(truncationHits('var merged = adopted.profiles.slice()'), [], 'while an array slice is not a truncation')
        assert.deepStrictEqual(truncationHits('return "Syncing… (click to cancel)"'), [], 'nor is an ellipsis inside a real sentence')
        for (const name of ['core/displayId.js', 'core/settingsNote.js', 'core/exclusion.ts', 'core/settingsSync.ts', 'ui/panel/panel.ts']){
            const source = fs.readFileSync(path.join(__dirname, '..', 'src', ...name.split('/')), 'utf8')
            assert.deepStrictEqual(truncationHits(source), [], `src/${name} must not cut an id down in the display path`)
        }
    })

    await test('display id: a display form is split back only when the brackets hold 6-32 hex characters', () => {
        assert.deepStrictEqual(DisplayID.splitDisplayID('Lab / Joplin (fdfd6c06)'), { name: 'Lab / Joplin', id: 'fdfd6c06' })
        assert.deepStrictEqual(DisplayID.splitDisplayID('  Archive (A1B2C3D4)  '), { name: 'Archive', id: 'a1b2c3d4' }, 'trimmed and lower-cased')
        assert.deepStrictEqual(DisplayID.splitDisplayID('Budget (deadbeef) (c0ffee11)'), { name: 'Budget (deadbeef)', id: 'c0ffee11' },
            'the LAST bracketed group is the id, so a name with brackets of its own survives')
        // THE 2.6.1 MIGRATION LIVES HERE: the parse side stays WIDER than the display side, so eight characters in
        // brackets - all any 2.6.1 field holds - is still read back as the id it is a prefix of.
        assert.deepStrictEqual(DisplayID.splitDisplayID('Archive (a1b2c3d4)'), { name: 'Archive', id: 'a1b2c3d4' },
            'a short id written by 2.6.1 is still a display form')
        assert.deepStrictEqual(DisplayID.splitDisplayID(`Archive (${'a1b2c3d4' + '0'.repeat(24)})`),
            { name: 'Archive', id: 'a1b2c3d4' + '0'.repeat(24) }, 'and so is the whole id this build writes')
        for (const plain of ['Archive', 'Archive (v2)', 'Archive (abcd)', 'Archive (' + 'a'.repeat(33) + ')', '(deadbeef)', '', 'Archive(deadbeef)']){
            assert.strictEqual(DisplayID.splitDisplayID(plain), null, `"${plain}" is all name`)
        }
    })

    // ============================================================ Findings 1-5: overlay scoping + lane fixes
    // These reproduce the cross-profile item-overlay leaks (Finding 1) and the lane refinements (Findings 2-5).
    // Each is written to FAIL on HEAD 32a9a88d - where a single GLOBAL item overlay is merged into every query,
    // the folder-poll signature includes updated_time, sync complete arms no overview lane, a cached switch does
    // no truth refresh, and the reconcile early-cancel is recomputed per-arm from hasPendingOptimistic() - and to
    // pass once each overlay entry is scoped to the view it was computed for and the lanes are refined.
    const overlayFolder = 'n'.repeat(32)
    const hideCompleted = { ...baseProfile, showCompletedPast: false, showCompletedToday: false, showCompletedFuture: false, showCompletedNoDue: false, showNoDue: true }
    const showEveryCompleted = { ...baseProfile, showNoDue: true }   // baseProfile already shows every completed bucket

    // (1a) REMOVE leak via an EXTERNAL completion. On a hide-completed profile the index still lags (its
    // iscompleted:0 search still returns the to-do), so the suppress the reconcile computes stays live; switching
    // to a show-completed profile whose search returns the same id must STILL show it - the suppress was the
    // other view's. On HEAD the one global suppress splices it out of the show-completed profile too.
    const removeLeakId = 'a'.repeat(32)
    const removeExtOptions = {
        dataDir: path.join(tmp, 'f1-remove-ext-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        // The lagging index returns the to-do as still-incomplete to BOTH profiles' searches.
        todos: [{ id: removeLeakId, title: 'ExtDone', todo_completed: 0, todo_due: Date.now() + 86400000, parent_id: overlayFolder, user_updated_time: 2 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...hideCompleted, id: 1, name: 'Active', searchCriteria: '', sortOrder: 0, noteID: '' },
                { ...showEveryCompleted, id: 2, name: 'Done', searchCriteria: '', sortOrder: 1, noteID: '' },
            ] }),
            currentProfileID: 1,
        },
        // The REAL note is already completed, so the reconcile judges it out of the hide-completed view.
        notes: { [removeLeakId]: { id: removeLeakId, title: 'ExtDone', parent_id: overlayFolder, is_todo: 1, todo_completed: Date.now(), todo_due: Date.now() + 86400000, deleted_time: 0, user_updated_time: 2 } },
    }
    const removeExt = await run(removeExtOptions)
    await test('F1 remove-leak (external): a completion on a hide-completed profile does not hide it on a show-completed one', async () => {
        await removeExt.noteChangeHandler({ id: removeLeakId })                     // external completion -> suppress in the hide-completed view
        await removeExt.panelMessageHandler(['profilesDropdownChanged', 2])         // switch to the show-completed profile
        assert.ok(removeExt.panelHtml['panel-panel'].includes('data-todo-id="' + removeLeakId + '"'),
            'the completed to-do must be shown on the show-completed profile (the other view\'s suppress must not apply)')
    })

    // (1b) REMOVE leak via the user's OWN tick. Ticking sets a completion override (global, id-keyed, kept) AND -
    // when Joplin echoes the change back as onNoteChange - a suppress in the hide-completed view. The show-completed
    // profile must still show it (override corrects it to completed); on HEAD the global suppress hides it instead.
    const removeOwnOptions = {
        dataDir: path.join(tmp, 'f1-remove-own-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [{ id: removeLeakId, title: 'OwnDone', todo_completed: 0, todo_due: Date.now() + 86400000, parent_id: overlayFolder, user_updated_time: 2 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...hideCompleted, id: 1, name: 'Active', searchCriteria: '', sortOrder: 0, noteID: '' },
                { ...showEveryCompleted, id: 2, name: 'Done', searchCriteria: '', sortOrder: 1, noteID: '' },
            ] }),
            currentProfileID: 1,
        },
        notes: { [removeLeakId]: { id: removeLeakId, title: 'OwnDone', parent_id: overlayFolder, is_todo: 1, todo_completed: Date.now(), todo_due: Date.now() + 86400000, deleted_time: 0, user_updated_time: 2 } },
    }
    const removeOwn = await run(removeOwnOptions)
    await test('F1 remove-leak (own tick): ticking on a hide-completed profile does not hide it on a show-completed one', async () => {
        await removeOwn.panelMessageHandler(['todoChecked', removeLeakId, true])    // user tick: completion override
        await removeOwn.noteChangeHandler({ id: removeLeakId })                     // Joplin echoes it back: suppress in the hide-completed view
        await removeOwn.panelMessageHandler(['profilesDropdownChanged', 2])         // switch to the show-completed profile
        assert.ok(removeOwn.panelHtml['panel-panel'].includes('data-todo-id="' + removeLeakId + '"'),
            'the ticked to-do must be shown on the show-completed profile')
    })

    // (2) INSERT leak. A no-due to-do created on a show-no-due profile must NOT surface on a hide-no-due profile's
    // panel, and a full overview regeneration must write it ONLY into the creating profile's note. On HEAD the one
    // global insert is appended to every query (panel and every profile's overview markdown).
    let insertIndexed = false
    const insertItem = { id: 'created-1', title: 'FreshTodo', todo_completed: 0, todo_due: 0, parent_id: overlayFolder, user_updated_time: 1 }
    const insertOptions = {
        dataDir: path.join(tmp, 'f1-insert-data'),
        installationDir: path.join(tmp, 'mobile-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        // A hides no-due to-dos with due:19700201 (never has it); A shows them and gets it once the index catches up.
        todos: (q) => q.includes('due:19700201') ? [] : (insertIndexed ? [insertItem] : []),
        folders: [{ id: overlayFolder, title: 'Inbox', parent_id: '', updated_time: 1 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...baseProfile, id: 1, name: 'Undated', searchCriteria: '', showNoDue: true, notebook: overlayFolder, sortOrder: 0, noteID: 'ovUndated' },
                { ...baseProfile, id: 2, name: 'Dated', searchCriteria: '', showNoDue: false, notebook: overlayFolder, sortOrder: 1, noteID: 'ovDated' },
            ] }),
            currentProfileID: 1,
        },
        notes: { ovUndated: { id: 'ovUndated', title: 'U', body: 'stale' }, ovDated: { id: 'ovDated', title: 'D', body: 'stale' } },
    }
    const insert = await run(insertOptions)
    await test('F1 insert-leak: a to-do created on one profile stays out of another profile\'s panel and overview', async () => {
        await insert.panelMessageHandler(['newTodoClicked'])                        // create a no-due to-do on the show-no-due profile
        insertIndexed = true                                                        // the index now returns it to that profile's own search
        assert.ok(insert.panelHtml['panel-panel'].includes('data-todo-id="created-1"'), 'the creating profile shows it optimistically')
        await insert.panelMessageHandler(['profilesDropdownChanged', 2])            // switch to the hide-no-due profile
        assert.ok(!insert.panelHtml['panel-panel'].includes('data-todo-id="created-1"'),
            'the created no-due to-do must NOT leak into the hide-no-due profile\'s panel')
        // A full overview regeneration (the debounced lane armed by the create) must write it ONLY into the
        // creating profile's overview note - never the other's.
        const overviewTimer = insert.pendingTimeouts(OVERVIEW_DEBOUNCE).pop()
        assert.ok(overviewTimer, 'the create armed an overview pass')
        await insert.fireTimeout(overviewTimer)
        assert.ok(insert.notePuts.some(p => p.id === 'ovUndated' && p.body.includes('FreshTodo')), 'the creating profile\'s overview note lists it')
        assert.ok(!insert.notePuts.some(p => p.id === 'ovDated' && p.body.includes('FreshTodo')), 'the other profile\'s overview note must NOT list it')
    })

    // (3) Flicker guarantee on the TICKING profile is unchanged: the completion override (global, id-keyed) still
    // makes a search-based render show the ticked state before the index agrees. Pinned by the existing
    // 'toggle: a search-based render before the index agrees still shows the ticked state' check; re-asserted here
    // against the scoped overlay so a regression in that direction is caught alongside these.
    const flickerId = 'a'.repeat(32)
    const flicker = await run({
        dataDir: path.join(tmp, 'f1-flicker-data'),
        installationDir: path.join(tmp, 'flicker-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: [{ id: flickerId, title: 'Tick me', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: overlayFolder }],
    })
    await test('F1 flicker guarantee: the ticking profile still shows the ticked state before the index agrees', async () => {
        await flicker.panelMessageHandler(['todoChecked', flickerId, true])
        await flicker.panelMessageHandler(['sortDirectionClicked'])                 // a real, non-optimistic render
        const html = flicker.panelHtml['panel-panel']
        const at = html.indexOf('data-todo-id="' + flickerId + '"')
        assert.ok(at >= 0, 'the toggled to-do is present')
        assert.ok(html.slice(html.lastIndexOf('<div', at), at).includes('-completed'), 'the override renders it completed despite the stale search')
    })

    // (4) Folder poll: an updated_time-only change must trigger NO invalidation/render computation (no refresh
    // search), while a rename still does. On HEAD the signature includes updated_time, so the bump churns.
    const utFolderId = 'f'.repeat(32)
    const utOptions = {
        dataDir: path.join(tmp, 'f2-poll-data'),
        installationDir: path.join(tmp, 'f2-poll-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: [],
        folders: [{ id: utFolderId, title: 'Inbox', parent_id: '', updated_time: 1000 }],
    }
    const ut = await run(utOptions)
    await test('F2 folder poll: an updated_time-only change causes no refresh; a rename still does', async () => {
        const entry = ut.intervals.find(i => i.ms === 3000)
        assert.ok(entry, 'the folder poll is armed')
        await entry.fn()                                                            // baseline signature
        // Pure updated_time bump: same id/title/parent -> no invalidation, no refresh search.
        utOptions.folders = [{ id: utFolderId, title: 'Inbox', parent_id: '', updated_time: 9999 }]
        const searchesBefore = countSearches(ut)
        await entry.fn()
        assert.strictEqual(countSearches(ut) - searchesBefore, 0, 'an updated_time-only change must not trigger a refresh computation')
        // A rename (title change) still re-renders.
        utOptions.folders = [{ id: utFolderId, title: 'Inbox renamed', parent_id: '', updated_time: 10000 }]
        const htmlBefore = ut.setHtmlCalls
        await entry.fn()
        assert.ok(ut.setHtmlCalls > htmlBefore, 'a rename still triggers a re-render')
    })

    // (6) A cached profile switch schedules exactly ONE background truth refresh and no lane cascade. On HEAD the
    // switch-back paints from cache with zero searches and never refetches the truth until the periodic backstop.
    const truthSwitch = await run({
        dataDir: path.join(tmp, 'f4-truth-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {
            profileData: JSON.stringify({ nextID: 3, profiles: [
                { ...baseProfile, id: 1, name: 'One', searchCriteria: 'tag:one', sortOrder: 0, noteID: '' },
                { ...baseProfile, id: 2, name: 'Two', searchCriteria: 'tag:two', sortOrder: 1, noteID: '' },
            ] }),
            currentProfileID: 1,
        },
    })
    await test('F4 cached switch: a switch back does exactly one background truth refresh and no lane cascade', async () => {
        await truthSwitch.panelMessageHandler(['profilesDropdownChanged', 2])       // warm both caches
        await truthSwitch.panelMessageHandler(['profilesDropdownChanged', 1])
        await truthSwitch.panelMessageHandler(['profilesDropdownChanged', 2])
        const searchesBefore = countSearches(truthSwitch)
        const timeoutMark = truthSwitch.timeouts.length
        await truthSwitch.panelMessageHandler(['profilesDropdownChanged', 1])       // switch BACK to the cached profile
        assert.strictEqual(countSearches(truthSwitch) - searchesBefore, 1, 'exactly one background truth refresh search')
        const armed = armedSince(truthSwitch, timeoutMark)
        assert.strictEqual(armed.filter(t => RECONCILE_OFFSETS.includes(t.ms) || t.ms === OVERVIEW_DEBOUNCE).length, 0,
            'the truth refresh arms no reconcile or overview lane (no cascade)')
    })

    // (7) Mixed burst: a non-optimistic mutation joining a burst that already holds an optimistic override must run
    // its reconcile offsets to the end - the override retiring must NOT cut it short. On HEAD the early-cancel is
    // recomputed from hasPendingOptimistic() at re-arm, so it cancels the moment the override retires.
    const mixedId = 'a'.repeat(32)
    const mixedOptions = {
        dataDir: path.join(tmp, 'f5-mixed-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [{ id: mixedId, title: 'Mix', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: overlayFolder, user_updated_time: 1 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...baseProfile, id: 1, name: 'Solo', searchCriteria: '', noteID: '' }] }),
            currentProfileID: 1,
        },
        notes: { [mixedId]: { id: mixedId, title: 'Mix', parent_id: overlayFolder, is_todo: 1, todo_completed: 0, todo_due: Date.now() + 3600000, deleted_time: 0, user_updated_time: 1 } },
    }
    const mixed = await run(mixedOptions)
    await test('F5 mixed burst: a non-optimistic mutation keeps reconciling after the optimistic override retires', async () => {
        await mixed.panelMessageHandler(['todoChecked', mixedId, true])            // optimistic tick: override pending
        const mark = mixed.timeouts.length
        await mixed.panelMessageHandler(['todosDropped', [mixedId], '2027-01-01'])  // non-optimistic move joins the burst
        const rec = armedSince(mixed, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        assert.strictEqual(rec.length, 5, 'the due-date move re-arms the reconcile job (five offsets)')
        await mixed.fireTimeout(rec[0])                                             // index lagging: override still pending
        mixedOptions.todos = [{ id: mixedId, title: 'Mix', todo_completed: Date.now(), todo_due: Date.now() + 3600000, parent_id: overlayFolder, user_updated_time: 2 }]
        await mixed.fireTimeout(rec[1])                                             // index catches up: override retires
        assert.ok(!rec[2].cleared && !rec[3].cleared && !rec[4].cleared,
            'the non-optimistic move keeps its later offsets armed despite the override retiring')
    })

    // ============================================================ Edit-staleness: overlay re-validation on visibility change
    // The CI-caught regression (e2e/panel-todos.spec.ts:62 and :90). An item-overlay INSERT is scoped by a viewKey
    // of profileID + notebookFilter ONLY - NOT the profile's visibility switches. So an item inserted while a
    // switch permitted it (an undated to-do while showNoDue was on, a completed to-do while its bucket was on)
    // keeps matching the unchanged viewKey after the SAME profile is EDITED to turn that switch off, and the
    // server search can never retire it (its own due:19700201 / iscompleted:0 filter excludes the item), so it
    // leaks into the edited view until the 60s TTL. The existing F1 insert-leak only covers a profile SWITCH
    // (a DIFFERENT viewKey, already isolated); these cover the EDIT of the same profile. E1/E2/E4/E5 are written
    // to FAIL on unfixed fbc4eab; E3/E6/E7 are guards that must pass on both (no over-fix, refuse-path intact).
    const stFolder = overlayFolder // 'n'.repeat(32)
    const stInbox = [{ id: stFolder, title: 'Inbox', parent_id: '', updated_time: 1 }]
    // A fully-shaped profile pinned to the one folder, so notebookFilter (hence viewKey) is fixed across an edit.
    const undatedProfile = (showNoDue) => ({ ...baseProfile, id: 1, name: 'Edit', searchCriteria: '', showNoDue, showNotes: false, notebook: stFolder, sortOrder: 0, noteID: '' })
    const completedProfile = (on) => ({ ...baseProfile, id: 1, name: 'Edit', searchCriteria: '', showNoDue: true, showNotes: false, notebook: stFolder, sortOrder: 0, noteID: '',
        showCompletedPast: on, showCompletedToday: on, showCompletedFuture: on, showCompletedNoDue: on })
    const criteriaProfile = (searchCriteria) => ({ ...baseProfile, id: 1, name: 'Edit', searchCriteria, showNoDue: true, showNotes: false, notebook: stFolder, sortOrder: 0, noteID: '' })
    const undatedNote = (id) => ({ id, title: 'SomedayTask', parent_id: stFolder, is_todo: 1, todo_completed: 0, todo_due: 0, deleted_time: 0, user_updated_time: 1 })
    const datedNote = (id) => ({ id, title: 'DatedTask', parent_id: stFolder, is_todo: 1, todo_completed: 0, todo_due: Date.now() + 3600000, deleted_time: 0, user_updated_time: 1 })
    const completedNote = (id) => ({ id, title: 'DoneTask', parent_id: stFolder, is_todo: 1, todo_completed: Date.now(), todo_due: Date.now() + 86400000, deleted_time: 0, user_updated_time: 2 })
    const stRun = (extra) => run(Object.assign({
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        // The index never returns the item to EITHER the show- or the hide- query, so the overlay is the ONLY
        // thing that can put it on screen: its presence proves an overlay insert, its absence proves none.
        todos: [],
        folders: stInbox,
    }, extra))

    // (E1) The exact CI failure. An undated to-do created externally while the profile SHOWS undated is upserted
    // and rendered; editing the SAME profile to hide undated must retire it. On unfixed fbc4eab it leaks.
    const e1Id = 'a'.repeat(32)
    const e1 = await stRun({
        dataDir: path.join(tmp, 'st-e1-data'),
        initialSettings: { profileData: JSON.stringify({ nextID: 2, profiles: [undatedProfile(true)] }), currentProfileID: 1 },
        notes: { [e1Id]: undatedNote(e1Id) },
    })
    await test('edit-staleness E1 (undated, external): an undated to-do shown under show-undated vanishes when the SAME profile is edited to hide undated', async () => {
        await e1.noteChangeHandler({ id: e1Id })
        assert.ok(e1.panelHtml['panel-panel'].includes('data-todo-id="' + e1Id + '"'), 'precondition: a show-undated profile shows the externally-created undated to-do')
        assert.ok(e1.panelHtml['panel-panel'].includes('No Due Date'), 'precondition: the No Due Date heading is present while undated to-dos are shown')
        await e1.panelMessageHandler(['profileSaved', 1, undatedProfile(false)])   // edit the SAME profile to hide undated (viewKey unchanged)
        const html = e1.panelHtml['panel-panel']
        assert.ok(!html.includes('data-todo-id="' + e1Id + '"'), 'the undated to-do must NOT leak into the hide-undated view after the edit')
        assert.ok(!html.includes('No Due Date'), 'no No Due Date heading remains after hiding undated')
    })

    // (E2) The same leak via a Cockpit-created undated to-do. Creation itself is untouched: the note is still
    // POSTed and opened (createItemInFolder posts + openTodo before the optimistic insert); only the stale
    // overlay entry must be retired by the edit.
    const e2 = await stRun({
        dataDir: path.join(tmp, 'st-e2-data'),
        installationDir: path.join(tmp, 'mobile-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        initialSettings: { profileData: JSON.stringify({ nextID: 2, profiles: [undatedProfile(true)] }), currentProfileID: 1 },
    })
    await test('edit-staleness E2 (undated, Cockpit-created): a created undated to-do vanishes when the SAME profile is edited to hide undated (creation still posts+opens)', async () => {
        await e2.panelMessageHandler(['newTodoClicked'])
        assert.ok(e2.dataPosts.some(p => p.path[0] === 'notes' && p.path.length === 1), 'the note is still created (POSTed) - creation is unaffected by the fix')
        assert.ok(e2.panelHtml['panel-panel'].includes('data-todo-id="created-1"'), 'precondition: the show-undated profile shows the created undated to-do')
        await e2.panelMessageHandler(['profileSaved', 1, undatedProfile(false)])
        assert.ok(!e2.panelHtml['panel-panel'].includes('data-todo-id="created-1"'), 'the created undated to-do must NOT leak into the hide-undated view after the edit')
    })

    // (E3) Over-fix guard: on a profile that STILL shows undated, an externally-created undated to-do appears and
    // KEEPS showing across an unrelated re-render - re-validation must keep a still-matching entry. Passes on both.
    const e3Id = 'b'.repeat(32)
    const e3 = await stRun({
        dataDir: path.join(tmp, 'st-e3-data'),
        initialSettings: { profileData: JSON.stringify({ nextID: 2, profiles: [undatedProfile(true)] }), currentProfileID: 1 },
        notes: { [e3Id]: undatedNote(e3Id) },
    })
    await test('edit-staleness E3 (over-fix guard): a show-undated profile shows an external undated to-do and keeps it across an unrelated re-render', async () => {
        await e3.noteChangeHandler({ id: e3Id })
        assert.ok(e3.panelHtml['panel-panel'].includes('data-todo-id="' + e3Id + '"'), 'a show-undated profile shows the externally-created undated to-do promptly')
        await e3.panelMessageHandler(['sortDirectionClicked'])                      // a benign, non-edit re-render
        assert.ok(e3.panelHtml['panel-panel'].includes('data-todo-id="' + e3Id + '"'), 'the still-matching undated to-do keeps showing (the fix must not drop a valid entry)')
    })

    // (E4) The completed-bucket analogue. A completed to-do shown under a show-completed profile must vanish when
    // the SAME profile is edited to hide completed. fetchTodos only bucket-filters when showAnyCompleted, so a
    // hide-completed view relies on iscompleted:0 server-side - which an overlay insert bypasses. Fails pre-fix.
    const e4Id = 'a'.repeat(32)
    const e4 = await stRun({
        dataDir: path.join(tmp, 'st-e4-data'),
        initialSettings: { profileData: JSON.stringify({ nextID: 2, profiles: [completedProfile(true)] }), currentProfileID: 1 },
        notes: { [e4Id]: completedNote(e4Id) },
    })
    await test('edit-staleness E4 (completed, external): a completed to-do shown under show-completed vanishes when the SAME profile is edited to hide completed', async () => {
        await e4.noteChangeHandler({ id: e4Id })
        assert.ok(e4.panelHtml['panel-panel'].includes('data-todo-id="' + e4Id + '"'), 'precondition: a show-completed profile shows the externally-completed to-do')
        await e4.panelMessageHandler(['profileSaved', 1, completedProfile(false)])
        assert.ok(!e4.panelHtml['panel-panel'].includes('data-todo-id="' + e4Id + '"'), 'the completed to-do must NOT leak into the hide-completed view after the edit')
    })

    // (E5) When an edit makes the view no longer locally evaluable (the profile GAINS searchCriteria), a carried
    // insert can no longer be judged locally, so it must be dropped and the search made the sole authority. On
    // unfixed fbc4eab the insert keeps matching the unchanged viewKey and leaks into the search-filtered view.
    const e5Id = 'a'.repeat(32)
    const e5 = await stRun({
        dataDir: path.join(tmp, 'st-e5-data'),
        initialSettings: { profileData: JSON.stringify({ nextID: 2, profiles: [criteriaProfile('')] }), currentProfileID: 1 },
        notes: { [e5Id]: datedNote(e5Id) },
    })
    await test('edit-staleness E5 (gains searchCriteria): a carried insert is dropped when the profile gains searchCriteria (search becomes the sole authority)', async () => {
        await e5.noteChangeHandler({ id: e5Id })
        assert.ok(e5.panelHtml['panel-panel'].includes('data-todo-id="' + e5Id + '"'), 'precondition: the locally-evaluable profile shows the externally-created to-do')
        await e5.panelMessageHandler(['profileSaved', 1, criteriaProfile('tag:work')])   // no longer locally evaluable
        assert.ok(!e5.panelHtml['panel-panel'].includes('data-todo-id="' + e5Id + '"'), 'the carried insert must be dropped once only the search can decide membership')
    })

    // (E6) Refuse-path guard: an external change on a profile that ALREADY has searchCriteria must take the
    // reconcile (search) path and make NO direct optimistic insert. With a stale index (search returns nothing)
    // the item's absence after a forced optimistic repaint proves no insert was carried. Passes on both.
    const e6Id = 'a'.repeat(32)
    const e6 = await stRun({
        dataDir: path.join(tmp, 'st-e6-data'),
        initialSettings: { profileData: JSON.stringify({ nextID: 2, profiles: [criteriaProfile('tag:work')] }), currentProfileID: 1 },
        notes: { [e6Id]: datedNote(e6Id) },
    })
    await test('edit-staleness E6 (searchCriteria refuse guard): an external change on a searchCriteria profile makes no direct optimistic insert', async () => {
        await e6.noteChangeHandler({ id: e6Id })
        await e6.panelMessageHandler(['sortDirectionClicked'])                      // force a repaint that would surface any overlay insert
        assert.ok(!e6.panelHtml['panel-panel'].includes('data-todo-id="' + e6Id + '"'), 'a not-locally-evaluable view carries no optimistic insert (the reconcile/search path owns it)')
    })

    // (E7) Direct-path guard: a profile that hides undated THROUGHOUT never surfaces an externally-created undated
    // to-do, because the reconcile already judges it out via noteMatchesView. Passes on both (documents that the
    // reconcile-time gate is - and stays - correct; the E1 leak is purely the post-insert visibility EDIT).
    const e7Id = 'a'.repeat(32)
    const e7 = await stRun({
        dataDir: path.join(tmp, 'st-e7-data'),
        initialSettings: { profileData: JSON.stringify({ nextID: 2, profiles: [undatedProfile(false)] }), currentProfileID: 1 },
        notes: { [e7Id]: undatedNote(e7Id) },
    })
    await test('edit-staleness E7 (direct hide-undated guard): a profile that hides undated never surfaces an externally-created undated to-do', async () => {
        await e7.noteChangeHandler({ id: e7Id })
        assert.ok(!e7.panelHtml['panel-panel'].includes('data-todo-id="' + e7Id + '"'), 'the reconcile judges an undated to-do out of a hide-undated view (no insert made)')
        assert.ok(!e7.panelHtml['panel-panel'].includes('No Due Date'), 'no No Due Date heading in a hide-undated view')
    })

    // ------------------------------------------------ results outside current filters
    // The read-only peek shown when the search box has text but the fully-filtered view is empty. The
    // harness serves options.todos to the "type:todo ..." list query and options.outsideResults to the
    // type-less verbatim search the peek runs, so a run with todos:[] models an empty filtered view whose
    // search text still matches things elsewhere in the vault.
    const outsideProfileData = JSON.stringify({
        nextID: 2,
        profiles: [{
            id: 1, name: 'Filtered', searchCriteria: '', noteID: '',
            showCompleted: true, showNoDue: true, showNotes: false,
            displayFormat: 'interval', yearFormat: 'numeric', monthFormat: 'long', dayFormat: 'numeric',
            weekdayFormat: 'short', timeIs12Hour: true, sortOrder: 0, noDueDatesAtEnd: false,
        }],
    })
    const outsideResults = [
        { id: 'a1'.repeat(16), title: 'Milk run in Shopping', is_todo: 1, todo_completed: 0, parent_id: 'nbShopping', user_updated_time: 10 },
        { id: 'a2'.repeat(16), title: 'Milk delivery notes', is_todo: 1, todo_completed: 0, parent_id: 'nbShopping', user_updated_time: 11 },
    ]
    let outsideRunSeq = 0
    const runOutside = (extra) => run(Object.assign({
        dataDir: path.join(tmp, 'outside-' + (++outsideRunSeq)),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [],
        initialSettings: { profileData: outsideProfileData, currentProfileID: 1 },
    }, extra))

    await test('outside results: empty filtered view + search shows the section from the unfiltered search', async () => {
        const state = await runOutside({ outsideResults })
        await state.panelMessageHandler(['searchFilterChanged', 'milk'])
        const html = state.panelHtml['panel-panel']
        assert.ok(html.includes('class="outside-results"'), 'the outside-results section is missing')
        assert.ok(html.includes('Results outside current filters (2)'), 'missing the heading with the count')
        // The two titles exist only in outsideResults (todos is []), so their presence proves the rows came
        // from the unfiltered search rather than the filtered list.
        assert.ok(html.includes('Milk run in Shopping') && html.includes('Milk delivery notes'), 'outside rows were not rendered')
        // The peek rows must not be drag-reschedule sources: no other .todo rows exist here, so nothing is draggable.
        assert.ok(!html.includes('draggable="true"'), 'outside rows must not be draggable')
        assert.ok(!html.includes('ondragstart'), 'outside rows must not carry drag handlers')
        // Nor may they enter the persistent selection set: selection survives re-renders on desktop and only
        // powers dragging/bulk actions the peek cannot use, so a selectable peek row would leak into a later
        // multi-row drag of an ordinary row. With todos:[] the only rows here are peek rows, so no selection
        // onmousedown may appear at all.
        assert.ok(!html.includes('onTodoRowMouseDown('), 'outside rows must not be selectable')
        // They otherwise behave like normal rows (checkbox ticks, title opens).
        assert.ok(html.includes('onTodoChecked('), 'outside rows should keep their checkbox')
        assert.ok(html.includes('onTodoRowClicked('), 'outside rows should be openable')
    })

    await test('outside results: display is capped at 15 with a +more footer when there are more', async () => {
        const many = []
        for (let i = 0; i < 18; i++) many.push({ id: String(i).padStart(32, 'z'), title: 'Match number ' + i, is_todo: 1, todo_completed: 0, parent_id: 'nbX', user_updated_time: i })
        const state = await runOutside({ outsideResults: many, outsideHasMore: true })
        await state.panelMessageHandler(['searchFilterChanged', 'match'])
        const html = state.panelHtml['panel-panel']
        // Only 15 rows render; the panel has no other .todo rows (todos is []), so count data-todo-id.
        assert.strictEqual((html.match(/data-todo-id=/g) || []).length, 15, 'the display should be capped at 15 rows')
        assert.ok(html.includes('and 3+ more matches'), 'missing the +more footer (18 fetched, 15 shown, has_more)')
        assert.ok(html.includes('Results outside current filters (18)'), 'the heading count should be the number fetched')
    })

    await test('outside results: no section when the search box is empty', async () => {
        const state = await runOutside({ outsideResults })
        // No searchFilterChanged: the search box is empty even though the filtered view is empty.
        const html = state.panelHtml['panel-panel']
        assert.ok(!html.includes('outside-results'), 'no section should show without search text')
        assert.ok(!html.includes('Results outside current filters'), 'no heading should show without search text')
    })

    await test('outside results: no section when the filtered view has rows', async () => {
        // todos is the three-item fixture from the top of the file, so the type:todo list query is non-empty.
        const state = await runOutside({ todos, outsideResults })
        await state.panelMessageHandler(['searchFilterChanged', 'milk'])
        const html = state.panelHtml['panel-panel']
        assert.ok(!html.includes('outside-results'), 'no section should show when the filtered list is non-empty')
    })

    await test('outside results: rendering the peek writes no setting, profile or note', async () => {
        const state = await runOutside({ outsideResults })
        const before = { settings: state.settingWrites.length, puts: state.notePuts.length, posts: state.dataPosts.length, deletes: state.dataDeletes.length }
        await state.panelMessageHandler(['searchFilterChanged', 'milk'])
        assert.ok(state.panelHtml['panel-panel'].includes('class="outside-results"'), 'precondition: the section should be shown')
        assert.strictEqual(state.settingWrites.length, before.settings, 'the peek must not write a setting or profile')
        assert.strictEqual(state.notePuts.length, before.puts, 'the peek must not write a note')
        assert.strictEqual(state.dataPosts.length, before.posts, 'the peek must not create anything')
        assert.strictEqual(state.dataDeletes.length, before.deletes, 'the peek must not delete anything')
    })

    await test('outside results: the search text is html-escaped in the output', async () => {
        const state = await runOutside({ outsideResults })
        await state.panelMessageHandler(['searchFilterChanged', '<img src=x onerror=1>'])
        const html = state.panelHtml['panel-panel']
        assert.ok(!html.includes('<img src=x onerror=1>'), 'raw search markup survived into the output')
        assert.ok(html.includes('Nothing in current filters matches "&lt;img src=x onerror=1&gt;"'), 'the search text was not escaped in the message line')
    })

    await test('outside results: a to-do stays tickable but a regular note renders like the Notes section', async () => {
        // type:'note' brings back BOTH to-dos and regular notes, told apart by is_todo. A to-do (is_todo:1) must
        // keep its tickable checkbox and completion handler; a regular note (is_todo:0) must be drawn the way the
        // panel's Notes section draws it - a display-only progress circle, no tickable checkbox, no to-do
        // completion handler - so ticking a non-to-do is impossible, while it stays openable.
        const todoId = 'to'.repeat(16)
        const noteId = 'no'.repeat(16)
        const mixed = [
            { id: todoId, title: 'A real to-do', is_todo: 1, todo_completed: 0, parent_id: 'nbMix', user_updated_time: 3 },
            { id: noteId, title: 'A plain note', is_todo: 0, todo_completed: 0, parent_id: 'nbMix', user_updated_time: 4 },
        ]
        const state = await runOutside({ outsideResults: mixed })
        await state.panelMessageHandler(['searchFilterChanged', 'thing'])
        const html = state.panelHtml['panel-panel']
        assert.ok(html.includes('class="outside-results"'), 'precondition: the peek should be shown')

        // The to-do renders as a to-do row: a tickable checkbox and the completion handler.
        const todoAt = html.indexOf('data-todo-id="' + todoId + '"')
        assert.notStrictEqual(todoAt, -1, 'the to-do should render as a to-do row')
        const todoRow = html.slice(html.lastIndexOf('<div class="todo', todoAt), html.indexOf('</div>', todoAt))
        assert.ok(todoRow.includes('onTodoChecked('), 'the peek to-do should keep its completion handler')
        assert.ok(todoRow.includes('type="checkbox"'), 'the peek to-do should keep its tickable checkbox')

        // The regular note renders as a note row: display-only circle, no checkbox, no completion handler, openable.
        const noteAt = html.indexOf('data-note-id="' + noteId + '"')
        assert.notStrictEqual(noteAt, -1, 'the regular note should render as a note row, not a to-do row')
        assert.ok(!html.includes('data-todo-id="' + noteId + '"'), 'the note must not be given a to-do row')
        const noteRow = html.slice(html.lastIndexOf('<div class="todo', noteAt), html.indexOf('</div>', noteAt))
        assert.ok(!noteRow.includes('onTodoChecked('), 'the peek note must not get a to-do completion handler')
        assert.ok(!noteRow.includes('type="checkbox"'), 'the peek note must not get a tickable checkbox')
        assert.ok(noteRow.includes('note-progress'), 'the peek note should show the display-only progress circle')
        assert.ok(noteRow.includes('onNoteRowClicked('), 'the peek note should still be openable')
    })

    // The peek lifts the profile filters, but an EXCLUDED notebook is a harder boundary: its content must
    // never surface here either. The harness serves outsideResults verbatim (it does not itself honour the
    // -notebook: clause), so an excluded row is dropped only by the client-side recursive id filter -- the
    // authority searchOutsideFilters applies before the body fetch and the cache -- and, because both the
    // rendered rows and the header/footer counts derive from that returned set, every count shrinks with it.
    await test('outside results: an excluded notebook\'s content never surfaces in the peek (rows + header/footer counts)', async () => {
        const nbKept = 'k'.repeat(32), nbExcluded = 'x'.repeat(32)
        const peekFolders = [
            { id: nbKept, title: 'Shopping', parent_id: '', updated_time: 1 },
            { id: nbExcluded, title: 'Secret', parent_id: '', updated_time: 2 },
        ]
        // 16 kept + 2 excluded = 18 fetched; after exclusion 16 remain, so 15 show and 1 spills to the footer.
        // Un-filtered it would be 18 -> "and 3 more" under a "(18)" heading, so the counts alone prove the drop.
        const peekItems = []
        for (let i = 0; i < 16; i++) {
            peekItems.push({ id: String(i).padStart(32, 'k'), title: 'KeepItem' + i, is_todo: 1, todo_completed: 0, parent_id: nbKept, user_updated_time: i })
        }
        peekItems.push({ id: 'e'.repeat(31) + '1', title: 'ExcludedAlpha', is_todo: 1, todo_completed: 0, parent_id: nbExcluded, user_updated_time: 90 })
        peekItems.push({ id: 'e'.repeat(31) + '2', title: 'ExcludedBravo', is_todo: 0, todo_completed: 0, parent_id: nbExcluded, user_updated_time: 91 })
        const state = await runOutside({ outsideResults: peekItems, folders: peekFolders })
        await state.setSetting('excludedNotebooks', 'Secret')
        await state.panelMessageHandler(['searchFilterChanged', 'keep'])
        const html = state.panelHtml['panel-panel']
        assert.ok(html.includes('class="outside-results"'), 'precondition: the peek should be shown')
        // Rows: a kept-notebook match appears; neither excluded-notebook item does (the to-do or the note).
        assert.ok(html.includes('KeepItem0'), 'a kept-notebook match still appears in the peek')
        assert.ok(!html.includes('ExcludedAlpha'), 'an excluded-notebook to-do must not appear in the peek')
        assert.ok(!html.includes('ExcludedBravo'), 'an excluded-notebook note must not appear in the peek')
        // Counts: the header is the FILTERED total (16, not 18) and the footer spills the filtered remainder (1, not 3).
        assert.ok(html.includes('Results outside current filters (16)'), 'the header count reflects the filtered set (excluded rows dropped)')
        assert.ok(html.includes('and 1 more matches'), 'the footer count reflects the filtered set')
        assert.strictEqual((html.match(/data-todo-id=/g) || []).length, 15, 'exactly 15 kept rows are shown (excluded rows never entered the set)')
        // The server-side optimisation is wired too: the peek query negates the unambiguously-titled excluded notebook.
        const peekSearches = state.gets.filter(g => g.path[0] === 'search' && g.query &&
            !String(g.query.query || '').includes('type:todo') && !String(g.query.query || '').includes('type:note'))
        assert.ok(peekSearches.length > 0, 'the peek issued its unfiltered search')
        assert.ok(String(peekSearches[peekSearches.length - 1].query.query).includes('-notebook:"Secret"'),
            'the peek query carries the server-side negation of the excluded title')
    })

    // ------------------------------------------------ deep last-resort tier: results in excluded notebooks
    // The user's problem: a note lives in an EXCLUDED notebook, so the ordinary peek (which respects the
    // exclusion) finds nothing, and the panel used to declare "No matches ... anywhere." - a lie, since the note
    // was merely hidden by the exclusion. The deep tier runs ONE more verbatim search that ignores the exclusion,
    // so explicit name-hunting can still reach the note, under a muted "Results in excluded notebooks" heading. It
    // appears ONLY when the ordinary peek is empty, so the exclusion stays meaningful everywhere else.
    const countTypeless = (s) => s.gets.filter(g => g.path[0] === 'search' && g.query &&
        !String(g.query.query || '').includes('type:todo') && !String(g.query.query || '').includes('type:note')).length
    const archiveNb = 'ar'.repeat(16), keptNb = 'kp'.repeat(16)
    const deepFolders = [
        { id: archiveNb, title: 'Archive', parent_id: '', updated_time: 1 },   // excluded (unique title -> a server clause)
        { id: keptNb, title: 'Projects', parent_id: '', updated_time: 2 },       // a kept notebook, offered as a filter
    ]
    // The harness serves this same array to BOTH type-less searches: the ordinary peek drops it via the client
    // id-filter (its parent is the excluded Archive) and so comes out empty, while the deep tier keeps it - exactly
    // the real split between the two searches. Tags Map is a REGULAR note (is_todo:0), so it must render as a note row.
    const tmId = 'tm'.repeat(16)
    const tagsMapNote = [{ id: tmId, title: 'Tags Map', is_todo: 0, todo_completed: 0, parent_id: archiveNb, user_updated_time: 5 }]
    const assertDeepTier = (html, where) => {
        // Zero regular-peek rows: the ordinary "outside current filters" section never appears.
        assert.ok(!html.includes('Results outside current filters'), 'the ordinary peek section must be absent (' + where + ')')
        // The deep tier is present, counted, and carries the note.
        assert.ok(html.includes('Results in excluded notebooks (1)'), 'the excluded-notebooks tier is missing (' + where + ')')
        assert.ok(html.includes('Tags Map'), 'the excluded note is not rendered in the tier (' + where + ')')
        // Rendered as a note row (a regular note, not a to-do), openable, its pill naming the excluded notebook.
        assert.ok(html.includes('data-note-id="' + tmId + '"'), 'the excluded note should render as a note row (' + where + ')')
        assert.ok(!html.includes('data-todo-id="' + tmId + '"'), 'the excluded note must not be given a to-do row (' + where + ')')
        assert.ok(html.includes('onNoteRowClicked('), 'the tier row must carry the open handler - opening it is the point (' + where + ')')
        assert.ok(/class="todo-notebook"[^>]*>Archive</.test(html), 'the tier row pill must name the excluded notebook (' + where + ')')
        // Read-only: with todos:[] the tier's note is the only row, so no drag/select handler may appear at all.
        assert.ok(!html.includes('draggable="true"'), 'the tier row must not be draggable (' + where + ')')
        assert.ok(!html.includes('onNoteRowMouseDown('), 'the tier row must not be selectable (' + where + ')')
        // The message is truthful now: the false "anywhere" line is gone, replaced by the in-filters line.
        assert.ok(!html.includes('anywhere'), 'the false "anywhere" line must be gone once the tier has hits (' + where + ')')
        assert.ok(html.includes('Nothing in current filters matches "title:&quot;Tags Map&quot;".'), 'the in-filters line should head the tier (' + where + ')')
    }

    await test('deep tier: an excluded note is found by an explicit quoted-phrase search (All notebooks)', async () => {
        const state = await runOutside({ outsideResults: tagsMapNote, folders: deepFolders })
        await state.setSetting('excludedNotebooks', 'Archive')
        const before = countTypeless(state)
        await state.panelMessageHandler(['searchFilterChanged', 'title:"Tags Map"'])
        const html = state.panelHtml['panel-panel']
        // Zero regular results: with todos:[] the filtered view is empty (the tier's note is a note row, not a to-do row).
        assert.strictEqual((html.match(/data-todo-id=/g) || []).length, 0, 'the filtered to-do view is empty')
        assertDeepTier(html, 'All notebooks')
        // The quoted phrase reached the deep search verbatim - quotes intact, no exclusion clause bolted on - which
        // also proves a quoted phrase traverses the whole peek pipeline unmangled.
        const newSearches = state.gets.filter(g => g.path[0] === 'search' && g.query &&
            !String(g.query.query || '').includes('type:todo') && !String(g.query.query || '').includes('type:note')).slice(before)
        const deepOnes = newSearches.filter(g => !String(g.query.query).includes('-notebook:'))
        assert.strictEqual(deepOnes.length, 1, 'exactly one deep-tier search ran (verbatim, no exclusion clause)')
        assert.strictEqual(String(deepOnes[0].query.query), 'title:"Tags Map"', 'the deep tier searched the verbatim quoted phrase')
    })

    await test('deep tier: the same excluded note is found under a different notebook filter too', async () => {
        const state = await runOutside({ outsideResults: tagsMapNote, folders: deepFolders })
        await state.setSetting('excludedNotebooks', 'Archive')
        await state.panelMessageHandler(['notebookFilterChanged', keptNb])   // narrow to a kept notebook
        await state.panelMessageHandler(['searchFilterChanged', 'title:"Tags Map"'])
        assertDeepTier(state.panelHtml['panel-panel'], 'notebook filter = Projects')
    })

    await test('deep tier: absent when the ordinary peek already has results (no second search)', async () => {
        // outsideResults live in a kept notebook and no exclusion is set, so the ordinary peek is non-empty.
        const state = await runOutside({ outsideResults })
        const before = countTypeless(state)
        await state.panelMessageHandler(['searchFilterChanged', 'milk'])
        const html = state.panelHtml['panel-panel']
        assert.ok(html.includes('Results outside current filters'), 'the ordinary peek should show its results')
        assert.ok(!html.includes('Results in excluded notebooks'), 'the deep tier must not appear when the peek has rows')
        assert.strictEqual(countTypeless(state) - before, 1, 'no second (deep) search runs when the peek already had results')
    })

    await test('deep tier: absent when the search box is empty', async () => {
        const state = await runOutside({ outsideResults: tagsMapNote, folders: deepFolders })
        await state.setSetting('excludedNotebooks', 'Archive')
        // No searchFilterChanged: the box is empty, so neither the peek nor the deep tier runs.
        const html = state.panelHtml['panel-panel']
        assert.ok(!html.includes('Results in excluded notebooks'), 'the deep tier must not appear without search text')
        assert.ok(!html.includes('outside-results'), 'no peek/tier section at all without search text')
    })

    await test('deep tier: both searches empty shows the truthful "anywhere" line and no tier section', async () => {
        // An exclusion IS set, so the deep tier genuinely runs its extra search; it just finds nothing either.
        const state = await runOutside({ outsideResults: [], folders: deepFolders })
        await state.setSetting('excludedNotebooks', 'Archive')
        const before = countTypeless(state)
        await state.panelMessageHandler(['searchFilterChanged', 'ghostnote'])
        const html = state.panelHtml['panel-panel']
        assert.ok(html.includes('No matches for "ghostnote" anywhere.'), 'the truthful anywhere line should show when both tiers are empty')
        assert.ok(!html.includes('Results in excluded notebooks'), 'no excluded-tier section when the deep search is also empty')
        assert.ok(!html.includes('Results outside current filters'), 'no ordinary peek section when it is empty')
        assert.strictEqual(countTypeless(state) - before, 2, 'the empty peek is followed by exactly one deep search before the anywhere line')
    })

    await test('deep tier: exactly one extra search, and a cache-hit re-render adds none', async () => {
        const exNb = 'ex'.repeat(16), keepNb = 'ke'.repeat(16)
        const folders = [
            { id: exNb, title: 'Archive', parent_id: '', updated_time: 1 },
            { id: keepNb, title: 'Projects', parent_id: '', updated_time: 2 },
        ]
        // A to-do (not a note) in the excluded notebook, so it can be ticked to drive an optimistic repaint.
        const hiddenId = 'hd'.repeat(16)
        const hidden = [{ id: hiddenId, title: 'Hidden Task', is_todo: 1, todo_completed: 0, parent_id: exNb, user_updated_time: 3 }]
        const state = await runOutside({ outsideResults: hidden, folders })
        await state.setSetting('excludedNotebooks', 'Archive')
        const before = countTypeless(state)
        await state.panelMessageHandler(['searchFilterChanged', 'hidden'])
        const newSearches = state.gets.filter(g => g.path[0] === 'search' && g.query &&
            !String(g.query.query || '').includes('type:todo') && !String(g.query.query || '').includes('type:note')).slice(before)
        // Two type-less searches: the peek (carrying the -notebook: exclusion clause) and exactly ONE deep tier
        // search (verbatim, no clause).
        assert.strictEqual(newSearches.length, 2, 'the committed search runs the peek plus exactly one deep search')
        assert.strictEqual(newSearches.filter(g => !String(g.query.query).includes('-notebook:')).length, 1, 'exactly one of them is the deep tier (no exclusion clause)')
        assert.ok(state.panelHtml['panel-panel'].includes('Results in excluded notebooks (1)'), 'precondition: the tier is shown')
        // A cache-hit re-render: ticking the tier to-do drives an optimistic repaint that must reuse BOTH the peek
        // and the deep-tier caches, adding zero searches.
        const mark = countTypeless(state)
        await state.panelMessageHandler(['todoChecked', hiddenId, true])
        assert.strictEqual(countTypeless(state), mark, 'the optimistic repaint re-renders the peek+tier from cache, issuing no search')
    })

    // ============================================================ row-wide click-to-open (dead-zone opens the item)
    // The bug: a left click on a row's dead zone (its padding, the gap beside a short title, the strip below a
    // short title) SELECTED the row but opened nothing, because opening was gated on the todo-title zone alone.
    // The fix broadens the row-level click handlers so ANY non-zone left click opens the item, exactly like the
    // title, while the checkbox / notebook-pill / modifier guards stay. These checks pin (a) the handlers' new
    // shape - read from the webview source, since this harness renders the panel markup but never executes the
    // webview JS - (b) that every row surface carries the row-level open handler on its ROOT element, (c) the peek
    // gains row-wide open while staying non-selectable and non-draggable, and (d) the zone markup is byte-stable.
    const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panelWebview.js'), 'utf8')
    // The body of a top-level webview handler: from its `function name(` to the closing brace at column 0. The
    // inner blocks all close with an indented `}` (never `\n}`), so the first `\n}` is the function's own end.
    // The shared search-token text rules, required like AlarmQuick / NoteMenu / EditorNote: the same file the
    // webview loads, so these tests exercise what ships. Used by the notebook-filter pin (which shares the
    // narrowing rule) and by the multi-select suite near the end of this file.
    const SearchTokens = require('../src/ui/panel/searchTokens.js')
    // The shared row-selection rules, required the same way: the very file the webview loads, so the checks below
    // exercise what ships rather than a paraphrase of it.
    const RowSelection = require('../src/ui/panel/rowSelection.js')
    // Realistic 32-char note ids for the pure selection checks (the later suites have their own id32).
    const rowId = (prefix) => (prefix + '0'.repeat(32)).slice(0, 32)
    const handlerBody = (name) => {
        const start = webviewSource.indexOf('function ' + name + '(')
        assert.ok(start >= 0, name + ' not found in panelWebview.js')
        const end = webviewSource.indexOf('\n}', start)
        assert.ok(end > start, 'could not delimit ' + name)
        return webviewSource.slice(start, end)
    }
    // The body of onLongPressFire's `todo` branch alone: from the brace that opens it to the `else if` that
    // closes it. Used to assert what is INSIDE that branch rather than what merely follows its first line.
    const fireTodoBranch = (fire) => {
        const open = fire.indexOf("if (longPress.kind === 'todo'){")
        assert.ok(open >= 0, "onLongPressFire must still branch on longPress.kind === 'todo'")
        const close = fire.indexOf("else if (longPress.kind === 'note')", open)
        assert.ok(close > open, "could not delimit the fire's to-do branch (the note branch that ends it is gone)")
        return fire.slice(open, close)
    }

    // (a) The handler shape. The pre-fix code opened ONLY inside `if (event.target.classList.contains('todo-title'))`,
    // so the absence of that exact title-zone gate - while the checkbox / pill / modifier guards remain and the open
    // still fires - is precisely the fix, and pre-fix source would fail this.
    await test('row click: onTodoRowClicked opens beyond the title, keeping the checkbox/pill/modifier guards', () => {
        const body = handlerBody('onTodoRowClicked')
        assert.ok(body.includes("classList.contains('todo-checkbox')"), 'the tick-circle guard must stay (a checkbox click must not open)')
        assert.ok(body.includes("classList.contains('todo-notebook')"), 'the notebook-pill guard must stay (a pill click filters, not opens)')
        assert.ok(/event\.(ctrlKey|metaKey|shiftKey)/.test(body), 'the modifier (multi-select) guard must stay')
        assert.ok(body.includes('onRowClicked(event, todoID)'), 'the row must still reach the shared open path')
        assert.ok(handlerBody('onRowClicked').includes('onTodoClicked(rowID)'), 'which must still open the item')
        assert.ok(!body.includes("classList.contains('todo-title')"), 'opening must NOT be gated on the title zone - a dead-zone click must open too')
    })
    await test('row click: onNoteRowClicked opens beyond the title (a note row has no checkbox to guard)', () => {
        const body = handlerBody('onNoteRowClicked')
        assert.ok(body.includes("classList.contains('todo-notebook')"), 'the notebook-pill guard must stay')
        assert.ok(body.includes('onRowClicked(event, noteID)'), 'the row must still reach the shared open path')
        assert.ok(!body.includes("classList.contains('todo-title')"), 'opening must NOT be gated on the title zone')
        // A note row is now selectable, so a modifier click on one is selection-only exactly as on a to-do row:
        // Ctrl-clicking a tenth row into a batch must not also move the editor.
        assert.ok(/event\.(ctrlKey|metaKey|shiftKey)/.test(body), 'a modifier click on a note row must not open it')
    })
    await test('row dblclick: onRowDoubleClicked stays title-scoped and desktop-only', () => {
        // Double-click-to-new-window is a title-only, desktop-only affordance; the dead-zone open fix must not
        // spread it to the whole row.
        const body = handlerBody('onRowDoubleClicked')
        assert.ok(body.includes("classList.contains('todo-title')"), 'dblclick-to-new-window must stay gated on the title zone')
        assert.ok(body.includes('IS_MOBILE'), 'dblclick-to-new-window must stay desktop-only')
        assert.ok(body.includes('openInNewWindow'), 'dblclick must still open a new window')
    })

    // ---- MULTI-DRAG: preserve an already-multi selection on the pre-drag mousedown (the 1.9.x regression fix) ----
    // The bug: pressing a Ctrl-selected row to start a drag fired a PLAIN mousedown first (the browser always fires
    // mousedown before dragstart); the plain branch collapsed the whole selection to that one row, so onTodoDragStart
    // saw a single id and only ONE to-do moved. The fix PRESERVES a multi-selection on the plain press so a drag sweeps
    // the set; the collapse-to-single moves to the plain CLICK (no drag). These pin the shape; pre-fix source fails them.
    await test('multi-drag: a plain press on an already-multi-selected row PRESERVES the whole set (drag sweeps it)', () => {
        // The rule itself now lives in the shared pure module, so it is exercised BEHAVIOURALLY here rather than
        // pattern-matched: a plain press on a row already inside a multi-selection returns the set unchanged.
        const ids = [rowId('r1'), rowId('r2'), rowId('r3')]
        const kept = RowSelection.pressSelection({ selected: ids, lastClicked: ids[0], lastInteraction: ids[2] }, ids[1], {}, ids)
        assert.deepStrictEqual(kept.selected, ids,
            'a plain press on an already-multi-selected row must PRESERVE the selection (not collapse it before dragstart)')
        // And the press that is NOT on a multi-selection still replaces it, which is what makes the preserve a
        // narrow exception rather than "a plain press never collapses".
        assert.deepStrictEqual(RowSelection.pressSelection({ selected: ids, lastClicked: ids[0] }, rowId('r9'), {}, ids.concat([rowId('r9')])).selected,
            [rowId('r9')], 'a plain press elsewhere still replaces the selection')
        assert.deepStrictEqual(RowSelection.pressSelection({ selected: [ids[0]], lastClicked: ids[0] }, ids[0], {}, ids).selected,
            [ids[0]], 'and a plain press on a SINGLE selection is not a multi-selection to preserve')
        // The webview delegates, rather than carrying a second copy of the rule.
        const body = handlerBody('onRowPressed')
        assert.ok(body.includes('window.RowSelection.pressSelection('), 'the press must be decided by the shared rule')
        assert.ok(/shift: !!event\.shiftKey/.test(body), 'Shift range-select must stay')
        assert.ok(/ctrl: !!\(event\.ctrlKey \|\| event\.metaKey\)/.test(body), 'Ctrl/Cmd toggle-select must stay')
    })
    await test('multi-drag: a plain click with no drag collapses the selection to just the clicked row', () => {
        const ids = [rowId('r1'), rowId('r2'), rowId('r3')]
        const collapsed = RowSelection.clickSelection({ selected: ids, lastClicked: ids[0] }, ids[1])
        assert.deepStrictEqual(collapsed.selected, [ids[1]], 'a plain click must collapse the selection to the clicked row')
        assert.strictEqual(collapsed.lastClicked, ids[1], 'and the clicked row becomes the range anchor')
        assert.strictEqual(collapsed.changed, true, 'a real collapse reports itself, so the caller repaints')
        // Already the sole selection: a no-op, so a plain single click never repaints needlessly.
        assert.strictEqual(RowSelection.clickSelection({ selected: [ids[1]], lastClicked: ids[1] }, ids[1]).changed, false,
            'clicking the row that is already the sole selection must change nothing')
        const body = handlerBody('onRowClicked')
        assert.ok(body.includes('window.RowSelection.clickSelection('), 'the click must be decided by the shared rule')
        assert.ok(body.includes('onTodoClicked(rowID)'), 'the plain click must still open the row')
    })
    await test('multi-drag: onTodoDragStart sends the whole selection MINUS the notes (only a to-do has a due date)', () => {
        const body = handlerBody('onTodoDragStart')
        assert.ok(body.includes('var ids = schedulableSelection()'),
            'the drag payload must be the to-dos within the selection, not the raw selection')
        assert.ok(/setData\('text\/plain', ids\.join\(','\)\)/.test(body), 'every dragged id must go into the dataTransfer, comma-joined')
        // A drag with nothing schedulable in it is cancelled outright rather than started with an empty payload.
        assert.ok(body.includes('if (!ids.length){ event.preventDefault(); return }'),
            'a payload with no to-dos in it must cancel the drag')
        // The filtering rule itself, behaviourally: selection order is kept and the notes simply are not in it.
        const todo1 = rowId('t1'), todo2 = rowId('t2'), note1 = rowId('n1')
        assert.deepStrictEqual(RowSelection.schedulableIDs([todo1, note1, todo2], [todo1, todo2]), [todo1, todo2],
            'the notes of a mixed selection must be dropped from a time payload, in selection order')
        assert.deepStrictEqual(RowSelection.schedulableIDs([note1], [todo1, todo2]), [],
            'a selection with no to-dos in it has nothing to schedule')
        assert.ok(handlerBody('schedulableSelection').includes('window.RowSelection.schedulableIDs('),
            'and the webview must use the shared rule for it')
    })

    // (b) Every row surface carries the row-level open handler on its ROOT element. One interval render supplies
    // both an interval to-do row and a note row; a second render supplies a week planner card.
    const rowFolder = 'n'.repeat(32)
    const rowTodoId = 'a'.repeat(32)
    const rowNoteId = 'e'.repeat(32)
    const rowState = await run({
        dataDir: path.join(tmp, 'rowopen-interval-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [{ id: rowTodoId, title: 'Interval row to-do', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: rowFolder, user_updated_time: 1 }],
        searchNotes: [{ id: rowNoteId, title: 'A plain note row', is_todo: 0, todo_completed: 0, parent_id: rowFolder, user_updated_time: 2 }],
        folders: [{ id: rowFolder, title: 'Inbox', parent_id: '', updated_time: 1 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [
                { ...baseProfile, id: 1, name: 'Rows', searchCriteria: '', showNotes: true, notesPosition: 'after', noteID: '' },
            ] }),
            currentProfileID: 1,
        },
    })
    // The opening tag of the row whose data-*-id matches `marker`: from its `<div` to the first `>` after it.
    const rootOpenTag = (html, marker) => {
        const at = html.indexOf(marker)
        assert.ok(at >= 0, 'row not found for ' + marker)
        return html.slice(html.lastIndexOf('<div', at), html.indexOf('>', at) + 1)
    }
    await test('row markup: an interval to-do row root carries onclick=onTodoRowClicked', () => {
        const tag = rootOpenTag(rowState.panelHtml['panel-panel'], 'data-todo-id="' + rowTodoId + '"')
        assert.ok(tag.includes('class="todo"'), 'the interval row root should be a plain .todo')
        assert.ok(tag.includes(`onclick="onTodoRowClicked(event, '${rowTodoId}')"`), 'the to-do row root must carry the row-level open handler')
    })
    await test('row markup: a note row root carries onclick=onNoteRowClicked', () => {
        const tag = rootOpenTag(rowState.panelHtml['panel-panel'], 'data-note-id="' + rowNoteId + '"')
        assert.ok(tag.includes('class="todo -note"'), 'the note row root should be a .todo.-note')
        assert.ok(tag.includes(`onclick="onNoteRowClicked(event, '${rowNoteId}')"`), 'the note row root must carry the row-level open handler')
    })

    const weekCardState = await run({
        dataDir: path.join(tmp, 'rowopen-week-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [{ id: rowTodoId, title: 'Week card to-do', todo_completed: 0, todo_due: Date.now(), parent_id: rowFolder, user_updated_time: 1 }],
        folders: [{ id: rowFolder, title: 'Inbox', parent_id: '', updated_time: 1 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [
                { ...baseProfile, id: 1, name: 'Wk', displayFormat: 'week', searchCriteria: '', noteID: '' },
            ] }),
            currentProfileID: 1,
        },
    })
    await test('row markup: a week planner card root carries onclick=onTodoRowClicked', () => {
        const html = weekCardState.panelHtml['panel-panel']
        assert.ok(html.includes('week-planner'), 'precondition: the week planner rendered')
        const tag = rootOpenTag(html, 'data-todo-id="' + rowTodoId + '"')
        assert.ok(tag.includes('class="todo -card'), 'the week card root should be a .todo.-card')
        assert.ok(tag.includes(`onclick="onTodoRowClicked(event, '${rowTodoId}')"`), 'the week card root must carry the row-level open handler')
    })

    // (c) The peek rows gain row-wide open on their ROOT while staying non-selectable and non-draggable: the same
    // row-level onclick handler is present, but the selection onmousedown and the drag attribute/handlers are not.
    await test('row markup (peek): peek rows carry the row-level open handler but no selection/drag on their root', async () => {
        const state = await runOutside({ outsideResults: [
            { id: 'to'.repeat(16), title: 'Peek to-do', is_todo: 1, todo_completed: 0, parent_id: 'nbP', user_updated_time: 3 },
            { id: 'no'.repeat(16), title: 'Peek note', is_todo: 0, todo_completed: 0, parent_id: 'nbP', user_updated_time: 4 },
        ] })
        await state.panelMessageHandler(['searchFilterChanged', 'peek'])
        const html = state.panelHtml['panel-panel']
        const todoTag = rootOpenTag(html, 'data-todo-id="' + 'to'.repeat(16) + '"')
        assert.ok(todoTag.includes('onclick="onTodoRowClicked(event,'), 'the peek to-do row root must carry the row-level open handler')
        assert.ok(!todoTag.includes('onmousedown'), 'the peek to-do row must not be selectable (no onmousedown on its root)')
        assert.ok(!todoTag.includes('draggable') && !todoTag.includes('ondragstart'), 'the peek to-do row must not be draggable')
        const noteTag = rootOpenTag(html, 'data-note-id="' + 'no'.repeat(16) + '"')
        assert.ok(noteTag.includes('onclick="onNoteRowClicked(event,'), 'the peek note row root must carry the row-level open handler')
        assert.ok(!noteTag.includes('onmousedown'), 'the peek note row must not be selectable (no onmousedown on its root)')
    })

    // ============================================================ no native HTML5 drag on a mobile row
    // THE THIRD PIXEL ROUND'S ROOT CAUSE. Android's WebView starts a native HTML5 drag from a LONG PRESS on a
    // draggable element: it fires dragstart (the desktop onTodoDragStart runs and hands the user a translucent
    // copy of the row as the platform's drag image) and then cancels the touch sequence, which takes the panel's
    // own 500ms long-press timer with it - so no context menu opens, the touch drag never arms, and the only drop
    // that still lands is onto a heading, through the NATIVE drag's inline ondrop. Four device reports, one cause,
    // and the fix is that a mobile row is not draggable in the first place. Pinned as three things: the mobile row
    // has neither the attribute nor the handlers, the desktop row still has both, and the mobile row is the
    // desktop row with exactly those and nothing else removed (selection, opening, the menu and the tick circle
    // all carry on unchanged - the phone's whole panel would otherwise go with them).
    const mobileRowState = await run({
        dataDir: path.join(tmp, 'nativedrag-interval-data'),
        installationDir: path.join(tmp, 'nativedrag-mobile-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: [{ id: rowTodoId, title: 'Interval row to-do', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: rowFolder, user_updated_time: 1 }],
        searchNotes: [{ id: rowNoteId, title: 'A plain note row', is_todo: 0, todo_completed: 0, parent_id: rowFolder, user_updated_time: 2 }],
        folders: [{ id: rowFolder, title: 'Inbox', parent_id: '', updated_time: 1 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [
                { ...baseProfile, id: 1, name: 'Rows', searchCriteria: '', showNotes: true, notesPosition: 'after', noteID: '' },
            ] }),
            currentProfileID: 1,
        },
    })
    const mobileWeekState = await run({
        dataDir: path.join(tmp, 'nativedrag-week-data'),
        installationDir: path.join(tmp, 'nativedrag-week-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: [{ id: rowTodoId, title: 'Week card to-do', todo_completed: 0, todo_due: Date.now(), parent_id: rowFolder, user_updated_time: 1 }],
        folders: [{ id: rowFolder, title: 'Inbox', parent_id: '', updated_time: 1 }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [
                { ...baseProfile, id: 1, name: 'Wk', displayFormat: 'week', searchCriteria: '', noteID: '' },
            ] }),
            currentProfileID: 1,
        },
    })
    // The drag attribute and the two handlers, and nothing else: what a mobile row must not have, and what taking
    // them off a desktop row must leave behind.
    const withoutNativeDrag = (tag) => tag.replace(' draggable="true"', '').replace(/\s*ondragstart="[^"]*"\s*ondragend="[^"]*"/, '')

    await test('row markup (mobile): a to-do row is not draggable - Android must not start a native drag from the long press', () => {
        const tag = rootOpenTag(mobileRowState.panelHtml['panel-panel'], 'data-todo-id="' + rowTodoId + '"')
        assert.ok(!tag.includes('draggable'), 'a mobile to-do row must carry no draggable attribute')
        assert.ok(!tag.includes('ondragstart') && !tag.includes('ondragend'), 'nor either drag handler')
        // ...and everything a phone actually uses is still there. This is the half that makes the change safe:
        // the long press (oncontextmenu), the tap (onclick), the selection the desktop drag shares (onmousedown)
        // and the double tap are all untouched, because only the HTML5 drag was ever the problem.
        assert.ok(tag.includes(`oncontextmenu="onTodoContextMenu(event, '${rowTodoId}')"`), 'the row keeps its context-menu handler')
        assert.ok(tag.includes(`onclick="onTodoRowClicked(event, '${rowTodoId}')"`), 'the row keeps its open handler')
        assert.ok(tag.includes(`onmousedown="onTodoRowMouseDown(event, '${rowTodoId}')"`), 'the row keeps its selection handler - nativeDrag is not draggable:false')
        assert.ok(tag.includes(`ondblclick="onRowDoubleClicked(event, '${rowTodoId}')"`), 'the row keeps its double-click handler')
    })

    await test('row markup (mobile): a week planner card is under the same rule', () => {
        const html = mobileWeekState.panelHtml['panel-panel']
        assert.ok(html.includes('week-planner'), 'precondition: the week planner rendered')
        const tag = rootOpenTag(html, 'data-todo-id="' + rowTodoId + '"')
        assert.ok(tag.includes('class="todo -card'), 'precondition: this is the week card')
        assert.ok(!tag.includes('draggable'), 'a mobile week card must carry no draggable attribute either')
        assert.ok(!tag.includes('ondragstart') && !tag.includes('ondragend'), 'nor either drag handler')
        assert.ok(tag.includes(`onmousedown="onTodoRowMouseDown(event, '${rowTodoId}')"`), 'and it keeps its selection handler')
        // The whole mobile panel, not just this row: nothing anywhere in it may be draggable, or Android has a
        // way back in through whatever was missed.
        assert.ok(!html.includes('draggable='), 'no element of a mobile panel may be draggable')
        assert.ok(!html.includes('ondragstart'), 'and none may carry a dragstart handler')
        assert.ok(!mobileRowState.panelHtml['panel-panel'].includes('draggable='), '...the interval panel included')
    })

    await test('row markup (desktop): the drag is untouched, and the mobile row is that row minus exactly it', () => {
        for (const [what, state] of [['list row', rowState], ['week card', weekCardState]]){
            const tag = rootOpenTag(state.panelHtml['panel-panel'], 'data-todo-id="' + rowTodoId + '"')
            assert.ok(tag.includes(' draggable="true"'), `the desktop ${what} must still be draggable`)
            assert.ok(tag.includes(`ondragstart="onTodoDragStart(event, '${rowTodoId}')"`), `the desktop ${what} must keep its dragstart`)
            assert.ok(tag.includes('ondragend="onTodoDragEnd(event)"'), `the desktop ${what} must keep its dragend`)
        }
        // The DIFFERENCE is exactly the drag: strip the attribute and the two handlers from the desktop tag and
        // what is left is the mobile tag, byte for byte. Anything else that had quietly changed with the platform
        // - a lost onmousedown, a reordered attribute, a dropped id - fails here rather than on the device.
        assert.strictEqual(withoutNativeDrag(rootOpenTag(rowState.panelHtml['panel-panel'], 'data-todo-id="' + rowTodoId + '"')),
            rootOpenTag(mobileRowState.panelHtml['panel-panel'], 'data-todo-id="' + rowTodoId + '"'),
            'a mobile list row must be the desktop list row minus exactly the drag attribute and its two handlers')
        assert.strictEqual(withoutNativeDrag(rootOpenTag(weekCardState.panelHtml['panel-panel'], 'data-todo-id="' + rowTodoId + '"')),
            rootOpenTag(mobileWeekState.panelHtml['panel-panel'], 'data-todo-id="' + rowTodoId + '"'),
            'and a mobile week card must be the desktop week card minus exactly the same')
    })

    // (d) The zone markup a click distinguishes - the tick circle, the title anchor and the notebook pill - is
    // byte-stable for a representative row: the fix lives entirely in the row-level click handler, so no zone
    // gained or lost markup. Targeted fragment checks, not a brittle whole-row snapshot.
    await test('row markup: the checkbox / title / pill zone markup is unchanged by the fix', () => {
        const html = rowState.panelHtml['panel-panel']
        const at = html.indexOf('data-todo-id="' + rowTodoId + '"')
        const row = html.slice(html.lastIndexOf('<div', at), html.indexOf('</div>', at) + '</div>'.length)
        // Checkbox zone: still the tickable input wired to onTodoChecked (the tick path is untouched).
        assert.ok(row.includes('class="todo-checkbox'), 'the checkbox zone markup changed')
        assert.ok(row.includes(`onchange="onTodoChecked('${rowTodoId}', this.checked)"`), 'the checkbox onchange wiring changed')
        // Title zone: still a plain .todo-title anchor with no click handler of its own (opening is row-level).
        assert.ok(row.includes('<a class="todo-title"'), 'the title zone markup changed')
        assert.ok(!/<a class="todo-title"[^>]*onclick=/.test(row), 'the title anchor must not carry its own onclick (opening is row-level)')
        // Notebook-pill zone: still the pill carrying its notebook id.
        assert.ok(row.includes(`class="todo-notebook" data-notebook-id="${rowFolder}"`), 'the notebook-pill zone markup changed')
    })

    // ============================================================ cross-frame selection drag (desktop passthrough)
    // The bug: drag-selecting text in Joplin's editor and dragging PAST the note edge INTO this panel froze the
    // selection, because the panel is a separate same-origin iframe that swallows the drag's pointer events - so the
    // editor (whose CodeMirror selection is driven by MAIN-window document listeners) stopped receiving them. The fix
    // makes the panel's OWN iframe pointer-events:none for the duration of such a foreign MOUSE drag, so the drag
    // falls back through to the main document and the selection keeps extending; the iframe is restored the instant
    // the drag ends. The e2e spec proves the live behaviour in real Joplin; these checks pin the webview wiring -
    // especially every ALWAYS-restore path - since this harness renders panel markup but never executes the webview JS.
    await test('selection drag: begin/end passthrough toggles the panel iframe pointer-events (the restore invariant)', () => {
        const begin = handlerBody('beginForeignSelectionDrag')
        assert.ok(begin.includes("frame.style.pointerEvents = 'none'"), 'begin must make the iframe transparent to pointer events')
        assert.ok(begin.includes('cockpitPanelIframe()'), 'begin must act on our own iframe')
        const end = handlerBody('endForeignSelectionDrag')
        assert.ok(/panelPointerIsDown = false/.test(end), 'end must clear the press-began-inside flag')
        assert.ok(end.includes("frame.style.pointerEvents = ''"), 'end must RESTORE the iframe pointer-events (the always-restore invariant)')
    })
    await test('selection drag: our own iframe is reached via the same-origin parent (window.frameElement), guarded', () => {
        const body = handlerBody('cockpitPanelIframe')
        assert.ok(body.includes('window.frameElement'), 'the iframe must be found via window.frameElement (same-origin parent access)')
        assert.ok(/catch/.test(body), 'parent access must be guarded so a cross-origin host disables the affordance rather than throwing')
    })
    await test('selection drag: the probe is desktop + mouse + primary-button, and skips a press that began inside', () => {
        const body = handlerBody('onPanelSelectionDragProbe')
        assert.ok(body.includes('IS_MOBILE'), 'the probe must be desktop-only (gated on IS_MOBILE)')
        assert.ok(body.includes("pointerType !== 'mouse'"), 'the probe must be mouse-only (gated on the pointer type)')
        assert.ok(/event\.buttons & 1/.test(body), 'the probe must require the primary button to be held')
        assert.ok(body.includes('panelPointerIsDown'), 'a drag that began inside the panel must be left alone')
        assert.ok(body.includes('beginForeignSelectionDrag()'), 'a foreign primary-button drag must engage the passthrough')
        assert.ok(body.includes('endForeignSelectionDrag()'), 'a probe with the button released must safety-restore')
    })
    await test('selection drag: pointerdown records a press begun inside; pointercancel does NOT clear it', () => {
        assert.ok(webviewSource.includes("if (event.pointerType === 'mouse') panelPointerIsDown = true"),
            'a mouse pointerdown inside the panel must record the press origin')
        assert.ok(webviewSource.includes("document.addEventListener('pointerup', endForeignSelectionDrag, true)"),
            'a real button release must restore the iframe and clear the flag')
        assert.ok(!/addEventListener\('pointercancel', endForeignSelectionDrag/.test(webviewSource),
            'pointercancel must NOT clear the origin flag - the button is still held when a native row drag takes over')
        assert.ok(webviewSource.includes("document.addEventListener('pointerover', onPanelSelectionDragProbe, true)") &&
                  webviewSource.includes("document.addEventListener('pointermove', onPanelSelectionDragProbe, true)"),
            'the probe must run on pointerover and pointermove')
    })
    await test('selection drag: the parent window ALWAYS restores on every end-of-drag route', () => {
        // The passthrough hands the live drag to the parent document, so its END fires there - restore from all of them.
        assert.ok(/window\.parent/.test(webviewSource), 'the restore must be wired on the parent window')
        for (const evt of ['mouseup', 'pointerup', 'dragend', 'blur']){
            assert.ok(webviewSource.includes(`parentWindow.addEventListener('${evt}', endForeignSelectionDrag, true)`),
                `the parent-window always-restore must cover ${evt}`)
        }
    })
    await test('selection drag: a re-render repairs an orphaned passthrough but never disturbs an active one', () => {
        const body = handlerBody('reconcile')
        assert.ok(body.includes('!foreignSelectionDragActive'), 'the re-render repair must be guarded on the drag NOT being active')
        assert.ok(/reconcileFrame\.style\.pointerEvents === 'none'/.test(body) && /reconcileFrame\.style\.pointerEvents = ''/.test(body),
            'a re-render must clear a stuck pointer-events:none so the panel can never stay dead to input')
    })

    // ============================================================ alarm quick buttons (shared pure math)
    // The five quick buttons (Today, Tomorrow, +week, +month(day), +month(date)) compute their date/time entirely
    // in this shared, deterministic module - the SAME one both the desktop dialog (alarmWebview.js) and the mobile
    // overlay (panelWebview.js) call from their button wiring - so the owner's acceptance examples are pinned here
    // once for both. now/baseDate are explicit Dates and preservedTime is {hours,minutes}|null (never Date.now()).
    // atDate takes a 1-based month for readability (new Date's own month arg is 0-based).
    const AlarmQuick = require('../src/ui/alarm/alarmQuick.js')
    const atDate = (y, m, d, hh, mm, ss, ms) => new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0, ms || 0)

    await test('quick Today: ceilHour(now)+1h always (:xx rounds up, exact :00 keeps, then +1h)', () => {
        assert.deepStrictEqual(AlarmQuick.today(atDate(2022, 1, 9, 14, 25)), { date: '2022-01-09', time: '16:00' })
        assert.deepStrictEqual(AlarmQuick.today(atDate(2022, 1, 9, 14, 55)), { date: '2022-01-09', time: '16:00' })
        assert.deepStrictEqual(AlarmQuick.today(atDate(2022, 1, 9, 15, 1)),  { date: '2022-01-09', time: '17:00' })
        assert.deepStrictEqual(AlarmQuick.today(atDate(2022, 1, 9, 15, 0, 0, 0)), { date: '2022-01-09', time: '16:00' })
    })
    await test('quick Today: an exact hour carrying stray seconds still rounds up', () => {
        // 15:00:30 is past the hour, so ceilHour -> 16:00 then +1h -> 17:00 (exercises ceilHour's seconds branch).
        assert.deepStrictEqual(AlarmQuick.today(atDate(2022, 1, 9, 15, 0, 30)), { date: '2022-01-09', time: '17:00' })
    })
    await test('quick Today: crossing midnight keeps the arithmetic result (rolls to the next day)', () => {
        assert.deepStrictEqual(AlarmQuick.today(atDate(2022, 1, 9, 23, 30)), { date: '2022-01-10', time: '01:00' })
    })
    await test('quick Tomorrow: today+1 day; a fresh time is ceilHour(now)', () => {
        assert.deepStrictEqual(AlarmQuick.tomorrow(atDate(2022, 1, 9, 14, 36), null), { date: '2022-01-10', time: '15:00' })
    })
    await test('quick +week: baseDate+7 days; fresh uses ceilHour(now), preserved keeps the clock time', () => {
        assert.deepStrictEqual(AlarmQuick.week(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), null), { date: '2022-01-16', time: '15:00' })
        assert.deepStrictEqual(AlarmQuick.week(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), { hours: 16, minutes: 30 }), { date: '2022-01-16', time: '16:30' })
    })
    await test('quick +month(day): same weekday-ordinal next month, 5th->last, Dec->Jan rollover', () => {
        // 2022-01-09 is the 2nd Sunday of January -> 2022-02-13, the 2nd Sunday of February.
        assert.strictEqual(AlarmQuick.monthWeekday(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), null).date, '2022-02-13')
        // 2022-01-29 is the 5th Saturday of January; February has only four -> its LAST Saturday, 2022-02-26.
        assert.strictEqual(AlarmQuick.monthWeekday(atDate(2022, 1, 29, 14, 36), atDate(2022, 1, 29), null).date, '2022-02-26')
        // 2022-12-11 is the 2nd Sunday of December -> 2023-01-08, the 2nd Sunday of January (year rolls over).
        assert.strictEqual(AlarmQuick.monthWeekday(atDate(2022, 12, 11, 14, 36), atDate(2022, 12, 11), null).date, '2023-01-08')
    })
    await test('quick +month(date): same day-of-month next month, Jan-31 clamps (non-leap + leap), Dec->Jan rollover', () => {
        assert.strictEqual(AlarmQuick.monthDate(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), null).date, '2022-02-09')
        // Jan 31 -> February clamps to the last day: 2022 is not a leap year (Feb 28), 2024 is (Feb 29).
        assert.strictEqual(AlarmQuick.monthDate(atDate(2022, 1, 31, 14, 36), atDate(2022, 1, 31), null).date, '2022-02-28')
        assert.strictEqual(AlarmQuick.monthDate(atDate(2024, 1, 31, 14, 36), atDate(2024, 1, 31), null).date, '2024-02-29')
        // Dec 31 -> Jan 31 of the next year (the day exists, so no clamp; year rolls over).
        assert.strictEqual(AlarmQuick.monthDate(atDate(2022, 12, 31, 14, 36), atDate(2022, 12, 31), null).date, '2023-01-31')
    })
    await test('quick +month(date): preservedTime is kept while the date advances', () => {
        assert.deepStrictEqual(AlarmQuick.monthDate(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), { hours: 16, minutes: 30 }), { date: '2022-02-09', time: '16:30' })
    })

    // ---------------------------------------------- row-1 absolute helpers (nextSaturday / nextMonday) across a week
    // nextSaturday = the nearest Saturday >= today (today when today is Saturday); nextMonday = the Monday strictly
    // AFTER today (+7 when today is Monday). Walk a full week starting Fri 2022-01-07 so every weekday is exercised.
    await test('nextSaturday: nearest Saturday >= today across a full week (Saturday -> today, Sunday -> +6)', () => {
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        // 2022-01-07 Fri, 08 Sat, 09 Sun, 10 Mon, 11 Tue, 12 Wed, 13 Thu.
        assert.strictEqual(iso(AlarmQuick.nextSaturday(atDate(2022, 1, 7, 13, 0))), '2022-01-08')   // Fri -> next day
        assert.strictEqual(iso(AlarmQuick.nextSaturday(atDate(2022, 1, 8, 13, 0))), '2022-01-08')   // Sat -> today
        assert.strictEqual(iso(AlarmQuick.nextSaturday(atDate(2022, 1, 9, 13, 0))), '2022-01-15')   // Sun -> +6
        assert.strictEqual(iso(AlarmQuick.nextSaturday(atDate(2022, 1, 10, 13, 0))), '2022-01-15')  // Mon
        assert.strictEqual(iso(AlarmQuick.nextSaturday(atDate(2022, 1, 11, 13, 0))), '2022-01-15')  // Tue
        assert.strictEqual(iso(AlarmQuick.nextSaturday(atDate(2022, 1, 12, 13, 0))), '2022-01-15')  // Wed
        assert.strictEqual(iso(AlarmQuick.nextSaturday(atDate(2022, 1, 13, 13, 0))), '2022-01-15')  // Thu
    })
    await test('nextMonday: the Monday strictly AFTER today across a full week (Monday -> +7, Sunday -> +1)', () => {
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        assert.strictEqual(iso(AlarmQuick.nextMonday(atDate(2022, 1, 7, 13, 0))), '2022-01-10')   // Fri -> next Mon
        assert.strictEqual(iso(AlarmQuick.nextMonday(atDate(2022, 1, 8, 13, 0))), '2022-01-10')   // Sat
        assert.strictEqual(iso(AlarmQuick.nextMonday(atDate(2022, 1, 9, 13, 0))), '2022-01-10')   // Sun -> +1
        assert.strictEqual(iso(AlarmQuick.nextMonday(atDate(2022, 1, 10, 13, 0))), '2022-01-17')  // Mon -> +7 (strictly after)
        assert.strictEqual(iso(AlarmQuick.nextMonday(atDate(2022, 1, 11, 13, 0))), '2022-01-17')  // Tue
        assert.strictEqual(iso(AlarmQuick.nextMonday(atDate(2022, 1, 13, 13, 0))), '2022-01-17')  // Thu
    })
    await test('quick Weekends / Next Monday: absolute date, time = preserved else ceilHour(now)', () => {
        // 2022-01-11 is a Tuesday; nearest Saturday = 2022-01-15, next Monday = 2022-01-17.
        assert.deepStrictEqual(AlarmQuick.weekends(atDate(2022, 1, 11, 14, 36), null), { date: '2022-01-15', time: '15:00' })
        assert.deepStrictEqual(AlarmQuick.weekends(atDate(2022, 1, 11, 14, 36), { hours: 8, minutes: 5 }), { date: '2022-01-15', time: '08:05' })
        assert.deepStrictEqual(AlarmQuick.monday(atDate(2022, 1, 11, 14, 36), null), { date: '2022-01-17', time: '15:00' })
    })

    // ---------------------------------------------- row-2 field-writing math (single-select / SAME: one press = one increment)
    await test('quick +hour: baseDate at (preserved else ceilHour(now)) + 1 hour; rolls the date across midnight', () => {
        assert.deepStrictEqual(AlarmQuick.hour(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), null), { date: '2022-01-09', time: '16:00' })         // ceilHour 15:00 +1h
        assert.deepStrictEqual(AlarmQuick.hour(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), { hours: 16, minutes: 30 }), { date: '2022-01-09', time: '17:30' })
        assert.deepStrictEqual(AlarmQuick.hour(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), { hours: 23, minutes: 30 }), { date: '2022-01-10', time: '00:30' }) // rolls midnight
    })
    await test('quick +day: baseDate + 1 day; time = preserved else ceilHour(now); month rollover', () => {
        assert.deepStrictEqual(AlarmQuick.day(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 9), null), { date: '2022-01-10', time: '15:00' })
        assert.deepStrictEqual(AlarmQuick.day(atDate(2022, 1, 9, 14, 36), atDate(2022, 1, 31), { hours: 16, minutes: 30 }), { date: '2022-02-01', time: '16:30' })
    })
    // The accumulate() primitive: one row-2 press increments the plan's counter on a COPY; an absolute string / anchor
    // starts a FRESH accumulator (that is the reset an absolute press or calendar pick installs).
    await test('accumulate: increments on a copy; resets from an absolute string; never mutates its input', () => {
        assert.deepStrictEqual(AlarmQuick.accumulate('anchor', 'hours'), { hours: 1, days: 0, weeks: 0, monthsDay: 0, monthsDate: 0 })
        assert.deepStrictEqual(AlarmQuick.accumulate('today', 'days'), { hours: 0, days: 1, weeks: 0, monthsDay: 0, monthsDate: 0 })   // absolute press reset -> fresh +1
        const acc = { hours: 0, days: 1, weeks: 0, monthsDay: 0, monthsDate: 0 }
        assert.deepStrictEqual(AlarmQuick.accumulate(acc, 'hours'), { hours: 1, days: 1, weeks: 0, monthsDay: 0, monthsDate: 0 })      // +day then +hour
        assert.deepStrictEqual(acc, { hours: 0, days: 1, weeks: 0, monthsDay: 0, monthsDate: 0 })                                      // input untouched
        assert.deepStrictEqual(AlarmQuick.accumulate({ hours: 2 }, 'hours'), { hours: 3, days: 0, weeks: 0, monthsDay: 0, monthsDate: 0 }) // +hour x3
    })

    // ============================================================ multi-select PLAN + MODE engine (applyAlarmPlan)
    // The multi-select rework: applyAlarmPlan(todos, plan, anchor, mode, now) -> [{id, due}] is the single pure
    // function the host computes every selected to-do's final due through (the webview posts only the plan descriptor
    // - mode + last-pressed plan + the anchor fields - and the host re-reads the fresh dues and applies it). Pinned
    // here for both webviews at once, exactly like the quick-button math above. dueAt/fmt keep the cases readable.
    const dueAt = (y, m, d, hh, mm) => atDate(y, m, d, hh, mm).getTime()
    const fmtDue = ts => { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
    const planMap = (todos, plan, anchor, mode, now) => AlarmQuick.applyAlarmPlan(todos, plan, anchor, mode, now).map(r => r.id + '=' + fmtDue(r.due)).join('  ')

    await test('applyAlarmPlan - OWNER ACCEPTANCE: two to-dos at 22:00 and 23:00, Tomorrow (respect) -> tomorrow 22:00 and 23:00', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 't1', due: dueAt(2026, 8, 19, 22, 0) }, { id: 't2', due: dueAt(2026, 8, 19, 23, 0) }]
        const anchor = { date: '2026-08-19', time: '22:00' }   // anchor = first to-do (its time is 22:00)
        assert.strictEqual(planMap(todos, 'tomorrow', anchor, 'respect', now), 't1=2026-08-20 22:00  t2=2026-08-20 23:00')
    })
    await test('applyAlarmPlan - Today (respect): every DATE becomes today, each to-do keeps its OWN time', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 't1', due: dueAt(2026, 8, 10, 22, 0) }, { id: 't2', due: dueAt(2026, 8, 12, 23, 0) }]
        const anchor = { date: '2026-08-19', time: '09:00' }
        assert.strictEqual(planMap(todos, 'today', anchor, 'respect', now), 't1=2026-08-19 22:00  t2=2026-08-19 23:00')
    })
    await test('applyAlarmPlan - Today (respect): a no-alarm to-do takes today + the ANCHOR time', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'due', due: dueAt(2026, 8, 10, 22, 0) }, { id: 'none', due: 0 }]
        const anchor = { date: '2026-08-19', time: '09:30' }
        assert.strictEqual(planMap(todos, 'today', anchor, 'respect', now), 'due=2026-08-19 22:00  none=2026-08-19 09:30')
    })
    // Each row-2 "+" increment in RESPECT mode over a MIXED set: the two dated to-dos shift from their OWN dates
    // keeping their OWN times; the no-due one accumulates from today at ceilHour(now)'s time (NOT the anchor - that is
    // the accumulator's no-due rule). The legacy single-shift strings 'week'/'monthWeekday'/'monthDate' normalise to
    // single-count accumulators, so they exercise the same path. Jan 9 2022 = a Sunday (2nd); Jan 20 = a Thursday (3rd);
    // mixedNow = 08:00 exactly, so ceilHour(now) = 08:00 and the no-due base is 2022-01-15 08:00.
    const MIXED = [{ id: 'a', due: dueAt(2022, 1, 9, 16, 30) }, { id: 'b', due: dueAt(2022, 1, 20, 9, 15) }, { id: 'c', due: 0 }]
    const MIXED_ANCHOR = { date: '2022-01-15', time: '15:00' }
    const mixedNow = atDate(2022, 1, 15, 8, 0)
    await test('applyAlarmPlan - +week (respect, mixed): each dated to-do +7 days from its own date, no-due from ceilHour(now)', () => {
        assert.strictEqual(planMap(MIXED, 'week', MIXED_ANCHOR, 'respect', mixedNow), 'a=2022-01-16 16:30  b=2022-01-27 09:15  c=2022-01-22 08:00')
    })
    await test('applyAlarmPlan - +month(day) (respect, mixed): same weekday-ordinal next month from own date, no-due from ceilHour(now)', () => {
        // a: 2nd Sunday Jan -> 2nd Sunday Feb = Feb 13; b: 3rd Thursday Jan -> 3rd Thursday Feb = Feb 17; c: 3rd Saturday
        // Jan (the 15th) -> 3rd Saturday Feb = Feb 19, at the 08:00 no-due base time.
        assert.strictEqual(planMap(MIXED, 'monthWeekday', MIXED_ANCHOR, 'respect', mixedNow), 'a=2022-02-13 16:30  b=2022-02-17 09:15  c=2022-02-19 08:00')
    })
    await test('applyAlarmPlan - +month(date) (respect, mixed): same day-of-month next month from own date, no-due from ceilHour(now)', () => {
        assert.strictEqual(planMap(MIXED, 'monthDate', MIXED_ANCHOR, 'respect', mixedNow), 'a=2022-02-09 16:30  b=2022-02-20 09:15  c=2022-02-15 08:00')
    })
    await test('applyAlarmPlan - SAME FOR ALL reproduces 1.8.3 for EVERY button: all to-dos get the one anchor datetime', () => {
        // In 1.8.3 a quick button wrote the fields and OK set every to-do to that one datetime. Here the anchor IS the
        // button's computed result (single-select math), and mode "same" must set every to-do to exactly it.
        const now = atDate(2022, 1, 9, 14, 36)
        const base = atDate(2022, 1, 9)
        const cases = [
            AlarmQuick.today(now),
            AlarmQuick.tomorrow(now, null),
            AlarmQuick.week(now, base, null),
            AlarmQuick.monthWeekday(now, base, null),
            AlarmQuick.monthDate(now, base, null),
        ]
        const plans = ['today', 'tomorrow', 'week', 'monthWeekday', 'monthDate']
        for (let i = 0; i < cases.length; i++) {
            const anchor = cases[i]
            const expectTs = atDate(Number(anchor.date.slice(0, 4)), Number(anchor.date.slice(5, 7)), Number(anchor.date.slice(8, 10)), Number(anchor.time.slice(0, 2)), Number(anchor.time.slice(3, 5))).getTime()
            const r = AlarmQuick.applyAlarmPlan(MIXED, plans[i], anchor, 'same', now)
            assert.strictEqual(r.length, 3, 'same mode returns one entry per to-do')
            for (const entry of r) assert.strictEqual(entry.due, expectTs, `same mode must set every to-do to the anchor for plan ${plans[i]}`)
        }
    })
    await test('applyAlarmPlan - single-select is a one-element same-mode selection: byte-identical to 1.8.3', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const anchor = { date: '2026-08-25', time: '07:45' }
        const r = AlarmQuick.applyAlarmPlan([{ id: 'solo', due: dueAt(2026, 8, 1, 12, 0) }], 'anchor', anchor, 'same', now)
        assert.deepStrictEqual(r, [{ id: 'solo', due: atDate(2026, 8, 25, 7, 45).getTime() }])
    })
    await test('applyAlarmPlan - manual pick (plan "anchor", respect): sets the anchor DATE for all, each keeps its own time', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2026, 8, 10, 22, 0) }, { id: 'b', due: dueAt(2026, 8, 12, 8, 5) }, { id: 'c', due: 0 }]
        const anchor = { date: '2026-08-30', time: '09:00' }
        assert.strictEqual(planMap(todos, 'anchor', anchor, 'respect', now), 'a=2026-08-30 22:00  b=2026-08-30 08:05  c=2026-08-30 09:00')
    })

    // describeAlarmPlan: the one-line explanation shown above the calendar (multi only). Pinned to the owner's example
    // wording so both webviews render the identical text and the date format matches the fields (YYYY-MM-DD / HH:MM).
    await test('describeAlarmPlan - respect date-for-all, all dated: "All N to-dos -> DATE, keeping their own times."', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2026, 8, 1, 9, 0) }, { id: 'b', due: dueAt(2026, 8, 2, 9, 0) }]
        assert.strictEqual(AlarmQuick.describeAlarmPlan(todos, 'anchor', { date: '2026-08-20', time: '15:00' }, 'respect', now), 'All 2 to-dos -> 2026-08-20, keeping their own times.')
    })
    await test('describeAlarmPlan - respect accumulator with a no-due: "N to-dos shift ... from their own schedules; 1 -> ceilHour(now)+shift."', () => {
        const now = atDate(2026, 8, 19, 10, 0)   // ceilHour(now) = 10:00, so the no-due base is 2026-08-19 10:00
        const todos = [{ id: 'a', due: dueAt(2026, 8, 1, 9, 0) }, { id: 'b', due: dueAt(2026, 8, 2, 9, 0) }, { id: 'c', due: dueAt(2026, 8, 3, 9, 0) }, { id: 'd', due: 0 }]
        assert.strictEqual(AlarmQuick.describeAlarmPlan(todos, 'week', { date: '2026-08-26', time: '15:00' }, 'respect', now), '3 to-dos shift +1 week from their own schedules; 1 without a due date -> 2026-08-26 10:00.')
    })
    await test('describeAlarmPlan - same mode: "All to-dos -> <anchor datetime>."', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2026, 8, 1, 9, 0) }, { id: 'b', due: 0 }]
        assert.strictEqual(AlarmQuick.describeAlarmPlan(todos, 'week', { date: '2026-08-20', time: '15:00' }, 'same', now), 'All to-dos -> 2026-08-20 15:00.')
    })

    // ============================================================ accumulator plan engine (applyAlarmPlan / describe)
    // The row-2 accumulator plan is an object {hours,days,weeks,monthsDay,monthsDate} passed straight to the pure
    // engine. Under RESPECT a dated to-do shifts from its OWN datetime (order: months, then weeks/days, then hours,
    // keeping its own clock except as +hour moves it); a no-due to-do accumulates from today at ceilHour(now)'s time.
    await test('accumulator (respect): +hour x3 on [22:00, no-due] -> own time +3h (rolls a day), no-due = ceilHour(now)+3h', () => {
        const now = atDate(2026, 8, 19, 10, 0)   // ceilHour(now) = 10:00
        const todos = [{ id: 't1', due: dueAt(2026, 8, 19, 22, 0) }, { id: 'none', due: 0 }]
        const anchor = { date: '2026-08-19', time: '09:00' }
        // t1: 22:00 + 3h = next day 01:00; none: 2026-08-19 10:00 + 3h = 13:00.
        assert.strictEqual(planMap(todos, { hours: 3 }, anchor, 'respect', now), 't1=2026-08-20 01:00  none=2026-08-19 13:00')
    })
    await test('accumulator (respect): +day then +hour composes on a dated to-do (date +1, then time +1h)', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2026, 8, 19, 10, 0) }]
        // {days:1, hours:1}: 2026-08-19 10:00 -> +1 day = 08-20 10:00 -> +1h = 08-20 11:00.
        assert.strictEqual(planMap(todos, { days: 1, hours: 1 }, { date: '2026-08-19', time: '09:00' }, 'respect', now), 'a=2026-08-20 11:00')
    })
    await test('accumulator (respect): +hour alone crossing midnight keeps the arithmetic result', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2026, 8, 19, 23, 30) }]
        assert.strictEqual(planMap(todos, { hours: 1 }, { date: '2026-08-19', time: '09:00' }, 'respect', now), 'a=2026-08-20 00:30')
    })
    await test('accumulator (respect): +month(date) x2 clamps SEQUENTIALLY (Jan 31 -> Feb 28 -> Mar 28, not Mar 31)', () => {
        const now = atDate(2022, 1, 15, 8, 0)
        const todos = [{ id: 'a', due: dueAt(2022, 1, 31, 12, 0) }]
        assert.strictEqual(planMap(todos, { monthsDate: 2 }, { date: '2022-01-15', time: '09:00' }, 'respect', now), 'a=2022-03-28 12:00')
    })
    await test('accumulator (respect): a JSON-string plan (the desktop hidden-field round-trip) normalises identically', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2026, 8, 19, 10, 0) }]
        const asObject = planMap(todos, { days: 2, hours: 1 }, { date: '2026-08-19', time: '09:00' }, 'respect', now)
        const asJSON = planMap(todos, JSON.stringify({ days: 2, hours: 1 }), { date: '2026-08-19', time: '09:00' }, 'respect', now)
        assert.strictEqual(asJSON, asObject)
        assert.strictEqual(asObject, 'a=2026-08-21 11:00')   // +2 days then +1h
    })
    await test('accumulator (SAME / single-select): the plan is ignored - every to-do gets the one anchor datetime', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const anchor = { date: '2026-08-25', time: '07:45' }
        const anchorTs = atDate(2026, 8, 25, 7, 45).getTime()
        // Multi SAME: the +hour/+day presses already wrote the anchor fields, so every to-do lands on that one anchor.
        const multi = AlarmQuick.applyAlarmPlan([{ id: 'a', due: dueAt(2026, 8, 1, 9, 0) }, { id: 'b', due: 0 }], { hours: 1, days: 1 }, anchor, 'same', now)
        for (const entry of multi) assert.strictEqual(entry.due, anchorTs)
        // Single-select is a one-element same-mode selection with an accumulator plan -> still just the anchor.
        const single = AlarmQuick.applyAlarmPlan([{ id: 'solo', due: dueAt(2026, 8, 1, 12, 0) }], { hours: 1 }, anchor, 'same', now)
        assert.deepStrictEqual(single, [{ id: 'solo', due: anchorTs }])
    })
    await test('accumulator: mode round-trip respect -> same -> respect is stateless and never mutates the plan', () => {
        const now = atDate(2026, 8, 19, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2026, 8, 19, 10, 0) }, { id: 'b', due: 0 }]
        const anchor = { date: '2026-08-19', time: '09:00' }
        const acc = { hours: 1, days: 2, weeks: 0, monthsDay: 0, monthsDate: 0 }
        const before = JSON.parse(JSON.stringify(acc))
        const respect1 = planMap(todos, acc, anchor, 'respect', now)
        planMap(todos, acc, anchor, 'same', now)
        const respect2 = planMap(todos, acc, anchor, 'respect', now)
        assert.strictEqual(respect1, respect2, 'the respect result must be identical before and after visiting same')
        assert.deepStrictEqual(acc, before, 'apply must never mutate the accumulator (mode round-trip is stateless)')
    })
    await test('describeAlarmPlan (accumulator): narrates "+2 days +1 hour from their own schedules" + the no-due datetime', () => {
        const now = atDate(2026, 8, 24, 14, 0)   // ceilHour(now) = 14:00, no-due base 2026-08-24 14:00
        const todos = [{ id: 'a', due: dueAt(2026, 8, 1, 9, 0) }, { id: 'b', due: dueAt(2026, 8, 2, 9, 0) }, { id: 'c', due: 0 }]
        // {days:2, hours:1}: no-due = 2026-08-24 14:00 + 2 days + 1h = 2026-08-26 15:00.
        assert.strictEqual(AlarmQuick.describeAlarmPlan(todos, { days: 2, hours: 1 }, { date: '2026-08-26', time: '09:00' }, 'respect', now),
            '2 to-dos shift +2 days +1 hour from their own schedules; 1 without a due date -> 2026-08-26 15:00.')
    })
    await test('describeAlarmPlan (accumulator): all dated -> "...from their own schedules."; all no-due -> the one datetime', () => {
        const now = atDate(2026, 8, 24, 14, 0)
        const allDated = [{ id: 'a', due: dueAt(2026, 8, 1, 9, 0) }, { id: 'b', due: dueAt(2026, 8, 2, 9, 0) }]
        assert.strictEqual(AlarmQuick.describeAlarmPlan(allDated, { weeks: 1, days: 2 }, { date: '2026-08-26', time: '09:00' }, 'respect', now),
            'All 2 to-dos shift +1 week +2 days from their own schedules.')
        const allNoDue = [{ id: 'a', due: 0 }, { id: 'b', due: 0 }]
        // no-due base 2026-08-24 14:00 + 1h = 2026-08-24 15:00.
        assert.strictEqual(AlarmQuick.describeAlarmPlan(allNoDue, { hours: 1 }, { date: '2026-08-26', time: '09:00' }, 'respect', now),
            'All 2 to-dos -> 2026-08-24 15:00.')
    })
    await test('describeAlarmPlan: the new absolute plans (Weekends / Next Monday) keep the date-for-all wording', () => {
        const now = atDate(2022, 1, 11, 10, 0)   // Tuesday; weekends -> 2022-01-15, next Monday -> 2022-01-17
        const todos = [{ id: 'a', due: dueAt(2022, 1, 1, 9, 0) }, { id: 'b', due: dueAt(2022, 1, 2, 9, 0) }]
        assert.strictEqual(AlarmQuick.describeAlarmPlan(todos, 'weekends', { date: '2022-01-20', time: '15:00' }, 'respect', now), 'All 2 to-dos -> 2022-01-15, keeping their own times.')
        assert.strictEqual(AlarmQuick.describeAlarmPlan(todos, 'nextMonday', { date: '2022-01-20', time: '15:00' }, 'respect', now), 'All 2 to-dos -> 2022-01-17, keeping their own times.')
    })
    await test('applyAlarmPlan: the new absolute plans (Weekends / Next Monday) land every to-do on that date, own time kept', () => {
        const now = atDate(2022, 1, 11, 10, 0)
        const todos = [{ id: 'a', due: dueAt(2022, 1, 1, 16, 30) }, { id: 'b', due: 0 }]
        const anchor = { date: '2022-01-20', time: '08:15' }
        assert.strictEqual(planMap(todos, 'weekends', anchor, 'respect', now), 'a=2022-01-15 16:30  b=2022-01-15 08:15')
        assert.strictEqual(planMap(todos, 'nextMonday', anchor, 'respect', now), 'a=2022-01-17 16:30  b=2022-01-17 08:15')
    })

    // ============================================================ HOST GLUE: the mobile alarm overlay's alarmSet message
    // Unlike the pure-function checks above, this drives the COMPILED bundle end to end. The overlay posts the row-2
    // accumulator plan as a raw OBJECT (webviewApi.postMessage(['alarmSet', ids, date, time, mode, plan]) in
    // panelWebview.js). The host's onMessage handler (panel.ts) must forward that object to applyAlarmSet untouched:
    // String()-coercing it yields "[object Object]", which normalizePlan can only read as the {str:'anchor'} fallback,
    // so under multi + respect every dated to-do is DRAGGED onto the anchor date instead of shifted from its own base.
    const glueId1 = 'e'.repeat(32)
    const glueId2 = 'f'.repeat(32)
    const alarmGlueNotes = {
        [glueId1]: { id: glueId1, title: 'Jan 9', todo_completed: 0, todo_due: dueAt(2022, 1, 9, 16, 30), parent_id: 'n'.repeat(32) },
        [glueId2]: { id: glueId2, title: 'Jan 20', todo_completed: 0, todo_due: dueAt(2022, 1, 20, 8, 0), parent_id: 'n'.repeat(32) },
    }
    const alarmGlue = await run({
        dataDir: path.join(tmp, 'alarm-glue-data'),
        installationDir: path.join(tmp, 'alarm-glue-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos: Object.values(alarmGlueNotes),
        notes: alarmGlueNotes,
    })
    await test('host glue (mobile alarmSet): an OBJECT accumulator plan shifts each to-do from its OWN base, not onto the anchor date', async () => {
        const putsBefore = alarmGlue.notePuts.length
        // A +day press makes the overlay's live plan the accumulator {days:1}; the anchor fields read 2022-01-09 10:00.
        // multi-select + respect: each DATED to-do must shift +1 day from its own datetime, NEVER be dragged onto Jan 9.
        await alarmGlue.panelMessageHandler(['alarmSet', [glueId1, glueId2], '2022-01-09', '10:00', 'respect',
            { hours: 0, days: 1, weeks: 0, monthsDay: 0, monthsDate: 0 }])
        const duePuts = alarmGlue.notePuts.slice(putsBefore).filter(p => p.fields && Object.prototype.hasOwnProperty.call(p.fields, 'todo_due'))
        const got = {}
        for (const put of duePuts) got[put.id] = put.fields.todo_due
        assert.strictEqual(got[glueId1], dueAt(2022, 1, 10, 16, 30), 'Jan 9 16:30 must shift to Jan 10 16:30 (own base +1 day), not stay on the anchor date')
        assert.strictEqual(got[glueId2], dueAt(2022, 1, 21, 8, 0), 'Jan 20 08:00 must shift to Jan 21 08:00 (own base +1 day), not drag onto the anchor date')
    })

    // Markup: the five labelled buttons + their handlers render in BOTH implementations - the desktop dialog HTML
    // template in alarm.ts and the mobile overlay builder in panelWebview.js - and the retired handlers are gone.
    // Read as source text: this harness renders the panel markup but never a native dialog or the overlay iframe,
    // and the version check below reads files the same way. webviewSource is the panelWebview.js text read above.
    const QUICK_LABELS = ['>Today<', '>Tomorrow<', '>Weekends<', '>Next Monday<', '>+hour<', '>+day<', '>+week<', '>+month(day)<', '>+month(date)<']
    const QUICK_HANDLERS = ['onAlarmQuickToday()', 'onAlarmQuickTomorrow()', 'onAlarmQuickWeekends()', 'onAlarmQuickNextMonday()', 'onAlarmQuickHour()', 'onAlarmQuickDay()', 'onAlarmQuickWeek()', 'onAlarmQuickMonthWeekday()', 'onAlarmQuickMonthDate()']
    await test('quick markup (desktop dialog): the nine two-row labelled buttons render in alarm.ts, old handlers gone', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'alarm', 'alarm.ts'), 'utf8')
        for (const label of QUICK_LABELS) assert.ok(src.includes(label), 'desktop dialog missing quick label ' + label)
        for (const handler of QUICK_HANDLERS) assert.ok(src.includes(handler), 'desktop dialog missing quick handler ' + handler)
        assert.ok(!src.includes('setAlarmDateOffset') && !src.includes('setAlarmDateNextMonth'), 'the old quick-button handlers must be gone from the desktop dialog')
    })
    // Two-row structure (both platforms): row 1 the four absolute dates in the pinned order, row 2 the five
    // accumulating increments in the pinned order, each a .alarm-quick-row. On the desktop dialog each row also carries
    // an EXPLICIT fixed height (a static-markup reservation so Joplin's measure-before-draw sizes the dialog to the two
    // rows), replacing the old single wrapping quick row. The mobile overlay mirrors the two rows (no fixed height - it
    // sizes dynamically). Read as source text.
    const ROW1 = ['>Today<', '>Tomorrow<', '>Weekends<', '>Next Monday<']
    const ROW2 = ['>+hour<', '>+day<', '>+week<', '>+month(day)<', '>+month(date)<']
    const assertTwoRows = (src, where) => {
        const quickOpen = src.indexOf('id="alarmQuick"')
        assert.ok(quickOpen >= 0, where + ': #alarmQuick is missing')
        // Two .alarm-quick-row containers within #alarmQuick, in order.
        const r1 = src.indexOf('alarm-quick-row', quickOpen)
        const r2 = src.indexOf('alarm-quick-row', r1 + 1)
        assert.ok(r1 > quickOpen && r2 > r1, where + ': #alarmQuick must contain two .alarm-quick-row containers')
        // Row 1's four absolute labels all sit in the first row (before row 2 opens); row 2's five in the second.
        for (const label of ROW1) { const at = src.indexOf(label, quickOpen); assert.ok(at > r1 && at < r2, where + ': ' + label + ' must be in row 1'); }
        for (const label of ROW2) { const at = src.indexOf(label, quickOpen); assert.ok(at > r2, where + ': ' + label + ' must be in row 2'); }
        // Pinned order within each row.
        for (let i = 1; i < ROW1.length; i++) assert.ok(src.indexOf(ROW1[i], quickOpen) > src.indexOf(ROW1[i - 1], quickOpen), where + ': row 1 order broken at ' + ROW1[i])
        for (let i = 1; i < ROW2.length; i++) assert.ok(src.indexOf(ROW2[i], quickOpen) > src.indexOf(ROW2[i - 1], quickOpen), where + ': row 2 order broken at ' + ROW2[i])
    }
    await test('two-row quick markup: desktop dialog + mobile overlay both pin the absolute row then the accumulator row', () => {
        const desktop = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'alarm', 'alarm.ts'), 'utf8')
        assertTwoRows(desktop, 'desktop dialog')
        assertTwoRows(webviewSource, 'mobile overlay')
        // Desktop reserves an explicit fixed height on each row (replaces the old single wrapping quick row).
        assert.ok(/\.alarm-quick-row\s*{[^}]*height:\s*\d+px/.test(desktop), 'the desktop .alarm-quick-row must reserve an explicit fixed height')
        assert.ok(/\.alarm-quick-row\s*{[^}]*box-sizing:\s*border-box/.test(desktop), 'the desktop .alarm-quick-row height must be a border-box reservation')
        assert.ok(/\.alarm-quick-row\s*{[^}]*flex-wrap:\s*nowrap/.test(desktop), 'the desktop rows must never wrap (a single line at the fixed width keeps the measurement stable)')
        assert.ok(!/#alarmQuick\s*{[^}]*flex-wrap:\s*wrap/.test(desktop), 'the old single wrapping quick row must be gone')
    })
    // Layout structure (owner UI polish, desktop dialog): pin the NEW markup+CSS shape so the two fixes can't
    // silently regress. Layout correctness itself (columns end at the calendar's bottom, buttons fill the row)
    // is verified visually by the owner; here we only assert the mechanism is present, reading alarm.ts as text.
    await test('alarm dialog layout: columns stretch to the calendar and the quick row is a full-width sibling', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'alarm', 'alarm.ts'), 'utf8')
        // Fix 1 - the calendar+columns row is an explicit non-wrapping stretch container...
        assert.ok(src.includes('class="alarm-stretch-row"'), 'the calendar+columns row is missing its stretch-container class')
        assert.ok(/#alarmBody\s*{[^}]*flex-wrap:\s*nowrap/.test(src), 'the row must never wrap: calendar left, time columns right, side by side under any width')
        assert.ok(/#alarmBody\s*{[^}]*align-items:\s*stretch/.test(src), 'the row must stretch its children to the calendar height')
        // ...the calendar reserves EXACTLY its deterministic drawn height (nav 30 + 4 margin + weekday row 22 +
        // six week rows of 28 = 224px) as min-height, so Joplin's measure-before-draw pass sizes the empty dialog
        // to the same height the grid will later draw - no clip at measurement, no overshoot once populated...
        assert.ok(/#alarmCalendar\s*{[^}]*min-height:\s*224px/.test(src), 'the calendar must reserve its exact 224px drawn height as min-height so the measured (empty) dialog is as tall as the populated grid')
        // ...and each column is a relative height-constraint wrapper around an absolutely-positioned scroller.
        assert.ok(/\.alarm-time-col\s*{[^}]*position:\s*relative/.test(src), 'the time column must be the relative height-constraint wrapper')
        assert.ok(!/\.alarm-time-col\s*{[^}]*height:/.test(src.replace(/\.cockpit-mobile[^}]*}/g, '')), 'the desktop time column must not carry a fixed pixel height')
        assert.ok(/\.alarm-time-scroll\s*{[^}]*position:\s*absolute/.test(src) && /\.alarm-time-scroll\s*{[^}]*overflow-y:\s*auto/.test(src), 'the scroller must be an absolutely-positioned overflow area filling the column')
        assert.ok(src.includes('class="alarm-time-scroll" id="alarmHourCol"') && src.includes('class="alarm-time-scroll" id="alarmMinuteCol"'), 'the hour/minute scrollers must keep their ids so the webview still populates and scrolls them')
        // Owner rework - the quick-button row now PRECEDES the calendar+columns row (moved above the calendar), and is
        // still a sibling of it, not nested inside it.
        const quick = src.indexOf('id="alarmQuick"')
        const bodyOpen = src.indexOf('id="alarmBody"')
        assert.ok(quick >= 0 && bodyOpen >= 0 && src.indexOf('id="alarmTimePanel"') > bodyOpen, 'precondition: both the quick row and the calendar+columns row are present')
        assert.ok(quick < bodyOpen, 'the quick-button row must come BEFORE the calendar+columns row (moved above the calendar)')
        // Walk div depth from the alarmQuick tag to its matching close; the calendar row must begin after it (siblings).
        let depth = 1, quickEnd = -1
        const tagRe = /<\/?div\b/g
        tagRe.lastIndex = src.indexOf('>', quick) + 1
        for (let m; (m = tagRe.exec(src)); ) {
            depth += m[0] === '</div' ? -1 : 1
            if (depth === 0) { quickEnd = m.index; break }
        }
        assert.ok(quickEnd >= 0 && bodyOpen > quickEnd, 'the quick-button row must be a sibling of, not nested inside, the calendar+columns row')
    })
    await test('quick markup (mobile overlay): the nine two-row labelled buttons render in panelWebview.js, old handlers gone', () => {
        for (const label of QUICK_LABELS) assert.ok(webviewSource.includes(label), 'mobile overlay missing quick label ' + label)
        for (const handler of QUICK_HANDLERS) assert.ok(webviewSource.includes(handler), 'mobile overlay missing quick handler ' + handler)
        assert.ok(!webviewSource.includes('setAlarmDateOffset') && !webviewSource.includes('setAlarmDateNextMonth'), 'the old quick-button handlers must be gone from the mobile overlay')
    })

    // ============================================================ multi-select plan markup + measurement reservation
    const alarmTsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'alarm', 'alarm.ts'), 'utf8')

    // The multi-select rows (explanation + mode picker) are emitted ONLY for a multi selection, and RESPECT is the
    // default mode. Both webviews build them from the same multi flag, so the desktop dialog and mobile overlay agree.
    await test('plan markup (desktop dialog): multi reserves the explanation + mode rows; single omits them; default mode is respect', () => {
        // The explanation line and mode picker are gated on `multi` (built from todoIDs.length > 1).
        assert.ok(/var multi = todoIDs\.length > 1/.test(alarmTsSrc), 'the dialog must know single-vs-multi when building the markup')
        assert.ok(/var explainRow = multi \?/.test(alarmTsSrc), 'the explanation line must be emitted for multi only')
        assert.ok(/var modeRow = multi \?/.test(alarmTsSrc), 'the mode picker must be emitted for multi only')
        assert.ok(/var planField = multi \?/.test(alarmTsSrc), 'the hidden plan field must be emitted for multi only')
        assert.ok(alarmTsSrc.includes('id="alarmExplain"') && alarmTsSrc.includes('id="alarmMode"'), 'the explanation and mode picker ids must be present')
        // RESPECT is the default: its radio carries `checked`, and it appears before the `same` radio.
        const respectAt = alarmTsSrc.indexOf('value="respect" checked')
        const sameAt = alarmTsSrc.indexOf('value="same"')
        assert.ok(respectAt >= 0, 'the respect mode radio must be the default (checked)')
        assert.ok(sameAt > respectAt, 'the respect radio must precede the same radio')
        // Both multi-only rows carry a FIXED box-sizing height in the dialog CSS so the measure-before-draw pass sizes
        // the dialog to the height the filled rows will occupy (the explanation is JS-filled AFTER measurement). The
        // explanation now holds two lines at the larger (quick-button) font, so its reservation is 38px; the mode row
        // stays a single line at 26px.
        assert.ok(/#alarmExplain\s*{[^}]*height:\s*38px/.test(alarmTsSrc) && /#alarmExplain\s*{[^}]*box-sizing:\s*border-box/.test(alarmTsSrc), 'the explanation row must reserve a fixed 38px box-sizing height (two lines at the quick-button font size)')
        assert.ok(/#alarmMode\s*{[^}]*height:\s*26px/.test(alarmTsSrc) && /#alarmMode\s*{[^}]*box-sizing:\s*border-box/.test(alarmTsSrc), 'the mode picker row must reserve a fixed 26px box-sizing height')
        // Font size: the explanation and the mode-picker labels reuse the quick buttons' font-size (inherit) rather
        // than a smaller literal, so all three render at one size. The quick buttons declare font-size: inherit; so
        // must these two rows (the mode labels inherit from #alarmMode).
        assert.ok(/#alarmQuick button\s*{[^}]*font-size:\s*inherit/.test(alarmTsSrc), 'precondition: the quick buttons inherit their font-size')
        assert.ok(/#alarmExplain\s*{[^}]*font-size:\s*inherit/.test(alarmTsSrc), "the explanation must reuse the quick buttons' font-size (inherit), not a smaller literal")
        assert.ok(/#alarmMode\s*{[^}]*font-size:\s*inherit/.test(alarmTsSrc), "the mode picker must reuse the quick buttons' font-size (inherit), not a smaller literal")
        // Layout order (owner rework): fields -> quick -> calendar -> mode picker -> explanation (moved below the mode
        // picker, above the footer).
        const iQuick = alarmTsSrc.indexOf('id="alarmQuick"')
        const iBody = alarmTsSrc.indexOf('id="alarmBody"')
        const iMode = alarmTsSrc.indexOf('${modeRow}')
        const iExplain = alarmTsSrc.indexOf('${explainRow}')
        assert.ok(iQuick >= 0 && iBody > iQuick && iMode > iBody && iExplain > iMode, 'order must be quick -> calendar -> mode picker -> explanation')
    })

    // The mobile overlay builder mirrors the same structure (quick above the calendar; explanation + mode rows gated on
    // multi) and calls the shared describeAlarmPlan; only the DOM glue and (dynamic-height) styling differ.
    await test('plan markup (mobile overlay): mirrors the desktop structure, multi-gated rows, shared describeAlarmPlan', () => {
        const oOpen = webviewSource.indexOf('function openAlarmOverlay(')
        assert.ok(oOpen >= 0, 'openAlarmOverlay must exist')
        const oBody = webviewSource.slice(oOpen, webviewSource.indexOf('\n}', oOpen))
        assert.ok(/var isMulti = restore \?/.test(oBody), 'the overlay must know single-vs-multi at build time')
        assert.ok(/var explainRow = isMulti \?/.test(oBody) && /var modeRow = isMulti \?/.test(oBody), 'the explanation + mode rows must be multi-only')
        assert.ok(oBody.includes('value="respect" checked'), 'respect must be the overlay default mode')
        // Order in the overlay innerHTML: quick -> calendar -> mode -> explanation (explanation moved below the mode).
        const iQuick = oBody.indexOf('id="alarmQuick"')
        const iBody = oBody.indexOf('id="alarmBody"')
        const iMode = oBody.indexOf('${modeRow}')
        const iExplain = oBody.indexOf('${explainRow}')
        assert.ok(iQuick >= 0 && iBody > iQuick && iMode > iBody && iExplain > iMode, 'overlay order must be quick -> calendar -> mode picker -> explanation')
        assert.ok(webviewSource.includes('AlarmQuick.describeAlarmPlan('), 'the overlay must render the explanation from the shared describeAlarmPlan')
    })

    // The overlay descriptor (openOverlayState) must carry the full plan model so a host-initiated reload reconstructs
    // it. Round-trip it through the same reopen path the webview uses: build a descriptor, JSON it, parse it, and check
    // mode + plan + dues + multi survive.
    await test('overlay descriptor round-trips mode + plan + dues (reload survival)', () => {
        // The descriptor builder writes multi/mode/plan/dues for the alarm kind.
        assert.ok(/multi: alarmIsMulti, mode: alarmMode, plan: alarmActivePlan, dues: alarmTodoDues/.test(webviewSource), 'currentOverlayDescriptor must serialise the full plan model for the alarm overlay')
        // The reopen path restores mode/plan/dues/multi from the descriptor.
        assert.ok(/var isMulti = restore \? !!restore\.multi/.test(webviewSource), 'openAlarmOverlay must restore multi from the descriptor')
        assert.ok(/alarmMode = restore\.mode === 'same'/.test(webviewSource), 'openAlarmOverlay must restore the mode from the descriptor')
        assert.ok(/alarmTodoDues = Array\.isArray\(restore\.dues\)/.test(webviewSource), 'openAlarmOverlay must restore the dues from the descriptor')
        assert.ok(/setAlarmActivePlan\(restore\.plan/.test(webviewSource), 'openAlarmOverlay must restore the active plan from the descriptor')
        // A concrete JSON round-trip of a representative descriptor.
        const descriptor = { kind: 'alarm', ids: ['x'], date: '2026-08-20', time: '15:00', hasAlarm: true, timeUserSet: false, multi: true, mode: 'respect', plan: 'weekends', dues: [{ id: 'x', due: 123 }, { id: 'y', due: 0 }] }
        const round = JSON.parse(JSON.stringify(descriptor))
        assert.strictEqual(round.mode, 'respect')
        assert.strictEqual(round.plan, 'weekends')
        assert.strictEqual(round.multi, true)
        assert.deepStrictEqual(round.dues, [{ id: 'x', due: 123 }, { id: 'y', due: 0 }])
    })
    // The accumulator plan is an OBJECT, and the descriptor's `plan: alarmActivePlan` must round-trip it (and the
    // restore's setAlarmActivePlan(restore.plan) reconstructs the exact accumulator) so a mid-overlay reload keeps the
    // pressed increments. Verify a JSON round-trip preserves the object AND that the shared engine treats the survivor
    // identically to the original.
    await test('overlay descriptor round-trips the ACCUMULATOR object (reload keeps the pressed increments)', () => {
        const descriptor = { kind: 'alarm', ids: ['x', 'y'], date: '2026-08-19', time: '09:00', hasAlarm: true, timeUserSet: true, multi: true, mode: 'respect', plan: { hours: 1, days: 2, weeks: 0, monthsDay: 0, monthsDate: 0 }, dues: [{ id: 'x', due: dueAt(2026, 8, 19, 10, 0) }, { id: 'y', due: 0 }] }
        const round = JSON.parse(JSON.stringify(descriptor))
        assert.deepStrictEqual(round.plan, { hours: 1, days: 2, weeks: 0, monthsDay: 0, monthsDate: 0 }, 'the accumulator object must survive the JSON round-trip')
        const now = atDate(2026, 8, 19, 10, 0)
        const anchor = { date: descriptor.date, time: descriptor.time }
        assert.strictEqual(planMap(descriptor.dues, descriptor.plan, anchor, 'respect', now), planMap(round.dues, round.plan, anchor, 'respect', now), 'the survivor must apply identically to the original')
    })

    // Measurement invariant, asserted ALGEBRAICALLY: parse the four heights out of the dialog CSS and check the
    // calendar's reserved min-height equals nav height + nav bottom-margin + weekday-header height + 6 * week-row
    // height, all read from the SAME CSS. This makes the 224px reservation and the row heights unable to drift apart
    // silently - change any row height without updating the reservation and this fails.
    await test('measurement invariant (algebraic): #alarmCalendar min-height == nav + margin + weekday + 6*week-row', () => {
        const num = (re, label) => { const m = alarmTsSrc.match(re); assert.ok(m, 'could not read ' + label + ' from the dialog CSS'); return Number(m[1]) }
        const minHeight = num(/#alarmCalendar\s*{[^}]*min-height:\s*(\d+)px/, '#alarmCalendar min-height')
        const navHeight = num(/\.alarm-cal-nav\s*{[^}]*height:\s*(\d+)px/, '.alarm-cal-nav height')
        const navMargin = num(/\.alarm-cal-nav\s*{[^}]*margin-bottom:\s*(\d+)px/, '.alarm-cal-nav margin-bottom')
        const weekdayHeight = num(/\.alarm-cal-grid th\s*{[^}]*height:\s*(\d+)px/, '.alarm-cal-grid th height')
        const weekRowHeight = num(/\.alarm-cal-grid td\s*{[^}]*height:\s*(\d+)px/, '.alarm-cal-grid td height')
        const computed = navHeight + navMargin + weekdayHeight + 6 * weekRowHeight
        assert.strictEqual(minHeight, computed, `the reserved min-height (${minHeight}) must equal nav ${navHeight} + margin ${navMargin} + weekday ${weekdayHeight} + 6*${weekRowHeight} = ${computed}`)
    })

    // ============================================================ drop BETWEEN rows (Feature C) + day-start (A/B)
    // The between-drop date math is a shared, deterministic core module (src/core/between.js) - the SAME UMD file the
    // host bundles (require in panel.ts) and the harness unit-tests here - so the owner's acceptance examples are pinned
    // once and drive the real drop path. dueAt(y, m, d, hh, mm) builds a local ms timestamp (1-based month).
    const Between = require('../src/core/between.js')
    const DAYSTART = 9 * 60   // 09:00, the default day-start, as minutes-of-day

    await test('betweenDue rule 1 (owner example): between 2022-01-08 and 2022-01-10 -> 2022-01-09 09:00', () => {
        assert.strictEqual(Between.betweenDue(dueAt(2022, 1, 8, 9, 0), dueAt(2022, 1, 10, 9, 0), DAYSTART), dueAt(2022, 1, 9, 9, 0))
    })
    await test('betweenDue rule 1 (multi free day): between 2022-01-08 and 2022-01-15 -> 2022-01-11 09:00 (floor midpoint day)', () => {
        assert.strictEqual(Between.betweenDue(dueAt(2022, 1, 8, 9, 0), dueAt(2022, 1, 15, 9, 0), DAYSTART), dueAt(2022, 1, 11, 9, 0))
        // The exact clock times of the two neighbours do not change the midpoint day or the day-start result.
        assert.strictEqual(Between.betweenDue(dueAt(2022, 1, 8, 23, 30), dueAt(2022, 1, 15, 1, 15), DAYSTART), dueAt(2022, 1, 11, 9, 0))
    })
    await test('betweenDue rule 2 (same day): between 14:20 and 17:40 -> 16:00 (:00 nearest the midpoint)', () => {
        assert.strictEqual(Between.betweenDue(dueAt(2026, 8, 19, 14, 20), dueAt(2026, 8, 19, 17, 40), DAYSTART), dueAt(2026, 8, 19, 16, 0))
    })
    await test('betweenDue rule 2 (no :00 fits): between 14:10 and 14:40 -> 14:25 (minute midpoint)', () => {
        assert.strictEqual(Between.betweenDue(dueAt(2026, 8, 19, 14, 10), dueAt(2026, 8, 19, 14, 40), DAYSTART), dueAt(2026, 8, 19, 14, 25))
    })
    await test('betweenDue rule 2 (midnight-spanning adjacent days): 23:30 -> next 00:30 lands on 00:00', () => {
        assert.strictEqual(Between.betweenDue(dueAt(2026, 8, 19, 23, 30), dueAt(2026, 8, 20, 0, 30), DAYSTART), dueAt(2026, 8, 20, 0, 0))
    })
    await test('betweenDue :00 tie -> the earlier hour', () => {
        // Midpoint exactly on :30 (15:00..16:00) => 15:00 and 16:00 are equidistant boundaries; the only :00 strictly
        // inside is none, so this is the minute midpoint 15:30. A true :00 tie needs the midpoint on an exact :30 with
        // two whole hours inside: 14:30..16:30 -> mid 15:30, hours 15:00/16:00 equidistant -> earlier 15:00.
        assert.strictEqual(Between.betweenDue(dueAt(2026, 8, 19, 14, 30), dueAt(2026, 8, 19, 16, 30), DAYSTART), dueAt(2026, 8, 19, 15, 0))
    })
    await test('betweenDue degenerate interval (equal / inverted) -> lo unchanged (unmoved in time)', () => {
        const eq = dueAt(2026, 8, 19, 14, 0)
        assert.strictEqual(Between.betweenDue(eq, eq, DAYSTART), eq)
        assert.strictEqual(Between.betweenDue(dueAt(2026, 8, 19, 15, 0), dueAt(2026, 8, 19, 14, 0), DAYSTART), dueAt(2026, 8, 19, 15, 0))
    })
    // EQUAL DIVISION (1.9.2): N dropped notes split the open interval into N+1 equal parts, note k at
    // lo + k*(hi-lo)/(N+1). Owner acceptance case: (14:00, 18:00, N=3) -> exactly [15:00, 16:00, 17:00].
    await test('sequenceBetween equal division (owner case): 3 ids between 14:00 and 18:00 -> [15:00, 16:00, 17:00]', () => {
        const seq = Between.sequenceBetween(dueAt(2026, 8, 19, 14, 0), dueAt(2026, 8, 19, 18, 0), 3, DAYSTART)
        assert.strictEqual(seq.length, 3)
        assert.ok(seq[0] < seq[1] && seq[1] < seq[2], 'the datetimes must strictly increase')
        // 4h / 4 parts = 1h steps; the points are already whole hours, so the :00-snap keeps them.
        assert.deepStrictEqual(seq, [dueAt(2026, 8, 19, 15, 0), dueAt(2026, 8, 19, 16, 0), dueAt(2026, 8, 19, 17, 0)])
    })
    await test('sequenceBetween equal division: 2 ids between 14:00 and 17:00 -> [15:00, 16:00]', () => {
        const seq = Between.sequenceBetween(dueAt(2026, 8, 19, 14, 0), dueAt(2026, 8, 19, 17, 0), 2, DAYSTART)
        assert.deepStrictEqual(seq, [dueAt(2026, 8, 19, 15, 0), dueAt(2026, 8, 19, 16, 0)])   // 3h / 3 parts = 1h steps
    })
    await test('sequenceBetween equal division: :00-snap would collide -> plain minute-rounded points', () => {
        // (14:00, 16:00, N=3): 2h / 4 parts = 30-min steps -> 14:30, 15:00, 15:30. Snapping to :00 (half up) would
        // give 15:00, 15:00, 16:00 - a collision (two 15:00) and 16:00 = hi is not strictly inside - so the snap is
        // rejected and the plain minute-rounded equal points stand.
        const seq = Between.sequenceBetween(dueAt(2026, 8, 19, 14, 0), dueAt(2026, 8, 19, 16, 0), 3, DAYSTART)
        assert.deepStrictEqual(seq, [dueAt(2026, 8, 19, 14, 30), dueAt(2026, 8, 19, 15, 0), dueAt(2026, 8, 19, 15, 30)])
    })
    await test('sequenceBetween day-scale: 3 ids across Jan 8 -> Jan 15 (D=6 free days) -> [Jan 9, Jan 11, Jan 13] @09:00', () => {
        // D = dayDiff - 1 = 6 free days (Jan 9..14). index_k = floor(k*(D+1)/(N+1)) = floor(k*7/4): 1, 3, 5
        // -> the 1st, 3rd, 5th free days = Jan 9, Jan 11, Jan 13, each at the 09:00 day-start. Distinct by D>=N.
        const seq = Between.sequenceBetween(dueAt(2022, 1, 8, 9, 0), dueAt(2022, 1, 15, 9, 0), 3, DAYSTART)
        assert.ok(seq[0] < seq[1] && seq[1] < seq[2], 'three distinct days, strictly increasing')
        assert.deepStrictEqual(seq, [dueAt(2022, 1, 9, 9, 0), dueAt(2022, 1, 11, 9, 0), dueAt(2022, 1, 13, 9, 0)])
    })
    await test('sequenceBetween day-scale fallback: D=1 with N=3 uses rule-2 equal division over the raw interval', () => {
        // Jan 8 09:00 .. Jan 10 09:00 has only D=1 free day (Jan 9) < N=3, so it falls back to time-scale equal
        // division of the 48h interval: 48h / 4 parts = 12h steps -> Jan 8 21:00, Jan 9 09:00, Jan 9 21:00 (all :00).
        const seq = Between.sequenceBetween(dueAt(2022, 1, 8, 9, 0), dueAt(2022, 1, 10, 9, 0), 3, DAYSTART)
        assert.ok(seq[0] < seq[1] && seq[1] < seq[2], 'strictly increasing across the day boundary')
        assert.deepStrictEqual(seq, [dueAt(2022, 1, 8, 21, 0), dueAt(2022, 1, 9, 9, 0), dueAt(2022, 1, 9, 21, 0)])
    })
    await test('sequenceBetween narrow interval: ties allowed, monotone non-decreasing, never inverts', () => {
        // (14:00, 14:02, N=3): 2 minutes / 4 parts = 30s steps -> 14:00:30, 14:01:00, 14:01:30. Minute-rounding
        // (half up) gives 14:01, 14:01, 14:02 (14:02 clamps to hi). The interval genuinely cannot fit 3 distinct
        // whole minutes, so a tie is allowed; the :00-snap (all -> 14:00 = lo) is rejected as not strictly inside.
        const seq = Between.sequenceBetween(dueAt(2026, 8, 19, 14, 0), dueAt(2026, 8, 19, 14, 2), 3, DAYSTART)
        assert.deepStrictEqual(seq, [dueAt(2026, 8, 19, 14, 1), dueAt(2026, 8, 19, 14, 1), dueAt(2026, 8, 19, 14, 2)])
        for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], 'monotone non-decreasing, never inverts')
    })
    await test('sequenceBetween N=1 is betweenDue verbatim (single-drop unchanged)', () => {
        // count 1 must equal the approved single-drop: (14:20, 17:40) -> 16:00, the :00 nearest the midpoint.
        assert.deepStrictEqual(
            Between.sequenceBetween(dueAt(2026, 8, 19, 14, 20), dueAt(2026, 8, 19, 17, 40), 1, DAYSTART),
            [Between.betweenDue(dueAt(2026, 8, 19, 14, 20), dueAt(2026, 8, 19, 17, 40), DAYSTART)])
        assert.deepStrictEqual(
            Between.sequenceBetween(dueAt(2026, 8, 19, 14, 20), dueAt(2026, 8, 19, 17, 40), 1, DAYSTART),
            [dueAt(2026, 8, 19, 16, 0)])
    })
    await test('betweenBounds: interior returns (prevDue, nextDue) and ignores the group date', () => {
        assert.deepStrictEqual(
            Between.betweenBounds(dueAt(2026, 8, 19, 10, 0), dueAt(2026, 8, 19, 16, 0), '2026-08-19', DAYSTART),
            { lo: dueAt(2026, 8, 19, 10, 0), hi: dueAt(2026, 8, 19, 16, 0) })
    })
    await test('betweenBounds: top edge lo = date@day-start, hi = firstDue', () => {
        assert.deepStrictEqual(
            Between.betweenBounds(0, dueAt(2026, 8, 19, 14, 0), '2026-08-19', DAYSTART),
            { lo: dueAt(2026, 8, 19, 9, 0), hi: dueAt(2026, 8, 19, 14, 0) })
    })
    await test('betweenBounds: top edge fall-through - day-start >= firstDue -> (date@00:00, firstDue)', () => {
        assert.deepStrictEqual(
            Between.betweenBounds(0, dueAt(2026, 8, 19, 7, 0), '2026-08-19', DAYSTART),
            { lo: dueAt(2026, 8, 19, 0, 0), hi: dueAt(2026, 8, 19, 7, 0) })
    })
    await test('betweenBounds: bottom edge lo = lastDue, hi = date@23:59', () => {
        assert.deepStrictEqual(
            Between.betweenBounds(dueAt(2026, 8, 19, 14, 0), 0, '2026-08-19', DAYSTART),
            { lo: dueAt(2026, 8, 19, 14, 0), hi: dueAt(2026, 8, 19, 23, 59) })
    })
    // Dateless groups (Overdue/Future): the eligibility gate is relaxed to them (a between-drop needs no group
    // date - the neighbours define the interval), so betweenBounds must resolve a null groupDate from the neighbours.
    await test('betweenBounds (dateless, Overdue): interior needs no group date - (prevDue, nextDue)', () => {
        // Two overdue (past) neighbours, null groupDate: the interior interval is purely their dues.
        assert.deepStrictEqual(
            Between.betweenBounds(dueAt(2022, 1, 8, 10, 0), dueAt(2022, 1, 8, 16, 0), null, DAYSTART),
            { lo: dueAt(2022, 1, 8, 10, 0), hi: dueAt(2022, 1, 8, 16, 0) })
    })
    await test('betweenBounds (dateless): top edge derives the day from the next neighbour (@day-start)', () => {
        assert.deepStrictEqual(
            Between.betweenBounds(0, dueAt(2022, 1, 8, 14, 0), null, DAYSTART),
            { lo: dueAt(2022, 1, 8, 9, 0), hi: dueAt(2022, 1, 8, 14, 0) })
        // Fall-through when day-start >= firstDue: (day-of(firstDue)@00:00, firstDue).
        assert.deepStrictEqual(
            Between.betweenBounds(0, dueAt(2022, 1, 8, 7, 0), null, DAYSTART),
            { lo: dueAt(2022, 1, 8, 0, 0), hi: dueAt(2022, 1, 8, 7, 0) })
    })
    await test('betweenBounds (dateless): bottom edge derives the day from the prev neighbour (@23:59)', () => {
        assert.deepStrictEqual(
            Between.betweenBounds(dueAt(2022, 1, 8, 14, 0), 0, null, DAYSTART),
            { lo: dueAt(2022, 1, 8, 14, 0), hi: dueAt(2022, 1, 8, 23, 59) })
    })
    await test('betweenBounds: no neighbours AND no usable date -> null (host writes nothing)', () => {
        assert.strictEqual(Between.betweenBounds(0, 0, null, DAYSTART), null)
        assert.strictEqual(Between.betweenBounds(0, 0, 'not-a-date', DAYSTART), null)
    })
    // A MULTI-DAY group (an interval period section since v2.2.0) carries two days: its data-drop is the FIRST day of
    // the slice and its data-drop-end the last. The bottom edge must anchor on the LAST day - with only the first, its
    // hi lands BEFORE the group's own rows, the interval inverts and betweenDue degenerates to lo, so every to-do
    // dropped under the last row of This/Next Week, Month or Year would be pinned to that row's own due.
    await test('betweenBounds (multi-day group): the bottom edge anchors on the group END day, not on its first day', () => {
        const first = '2026-09-07', last = '2026-09-30'                       // a "This Month" slice: Sep 7 .. Sep 30
        const lastRow = dueAt(2026, 9, 20, 10, 0)
        assert.deepStrictEqual(
            Between.betweenBounds(lastRow, 0, first, DAYSTART, last),
            { lo: lastRow, hi: dueAt(2026, 9, 30, 23, 59) }, 'hi must be the END day at 23:59')
        // ...and the interval it yields is a real one, forward of the last row rather than collapsed onto it.
        const placed = Between.betweenDue(lastRow, dueAt(2026, 9, 30, 23, 59), DAYSTART)
        assert.ok(placed > lastRow && placed <= dueAt(2026, 9, 30, 23, 59), 'the dropped to-do must land after the last row and inside the slice')
        // Without the end day the same drop inverts: this is the shape the regression produced, pinned so it cannot
        // come back unnoticed if the plumbing is ever dropped.
        assert.deepStrictEqual(
            Between.betweenBounds(lastRow, 0, first, DAYSTART),
            { lo: lastRow, hi: dueAt(2026, 9, 7, 23, 59) }, 'without the end day the bound is the slice FIRST day (inverted)')
    })
    await test('betweenBounds (multi-day group): the top edge still anchors on the FIRST day, and an empty group spans both', () => {
        const first = '2026-09-07', last = '2026-09-30'
        const firstRow = dueAt(2026, 9, 8, 14, 0)
        assert.deepStrictEqual(
            Between.betweenBounds(0, firstRow, first, DAYSTART, last),
            { lo: dueAt(2026, 9, 7, 9, 0), hi: firstRow }, 'the top edge opens at the slice first day @day-start')
        // Both neighbours absent (the whole group is being dragged): the interval is the group's whole SPAN.
        assert.deepStrictEqual(
            Between.betweenBounds(0, 0, first, DAYSTART, last),
            { lo: dueAt(2026, 9, 7, 9, 0), hi: dueAt(2026, 9, 30, 23, 59) }, 'no neighbours -> the whole span')
    })
    await test('betweenBounds (one-day group): an end day equal to the date, or none at all, behaves exactly as before', () => {
        const both = Between.betweenBounds(dueAt(2026, 8, 19, 14, 0), 0, '2026-08-19', DAYSTART, '2026-08-19')
        const only = Between.betweenBounds(dueAt(2026, 8, 19, 14, 0), 0, '2026-08-19', DAYSTART)
        assert.deepStrictEqual(both, only, 'a Date-view / Today / Tomorrow heading is unaffected by the new argument')
        assert.deepStrictEqual(both, { lo: dueAt(2026, 8, 19, 14, 0), hi: dueAt(2026, 8, 19, 23, 59) })
        // A dateless group (Overdue/Future) sends null for both and still derives its day from the neighbour.
        assert.deepStrictEqual(
            Between.betweenBounds(dueAt(2022, 1, 8, 14, 0), 0, null, DAYSTART, null),
            { lo: dueAt(2022, 1, 8, 14, 0), hi: dueAt(2022, 1, 8, 23, 59) }, 'dateless bottom edge unchanged')
    })

    // ---- HOST GLUE: drive the COMPILED bundle's message paths (the alarm lesson: unit math + real wiring both) ----
    const nb = 'nb'.repeat(16)
    const dup = (a, b) => (a + b).repeat(16)   // a distinct 32-char id from a 2-char seed
    const cPrev = dup('a', '1'), cNext = dup('b', '2'), cDrag = dup('c', '3'), cDrag2 = dup('d', '4')
    const betweenNotes = {
        [cPrev]:  { id: cPrev,  title: 'prev',  todo_completed: 0, todo_due: dueAt(2026, 8, 19, 10, 0), parent_id: nb },
        [cNext]:  { id: cNext,  title: 'next',  todo_completed: 0, todo_due: dueAt(2026, 8, 19, 16, 0), parent_id: nb },
        [cDrag]:  { id: cDrag,  title: 'drag',  todo_completed: 0, todo_due: dueAt(2026, 8, 19, 20, 0), parent_id: nb },
        [cDrag2]: { id: cDrag2, title: 'drag2', todo_completed: 0, todo_due: dueAt(2026, 8, 19, 21, 0), parent_id: nb },
    }
    const betweenGlue = await run({
        dataDir: path.join(tmp, 'between-glue-data'),
        installationDir: path.join(tmp, 'between-glue-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: Object.values(betweenNotes),
        notes: betweenNotes,
    })
    const duePutsSince = (glue, before) => {
        const map = {}
        for (const put of glue.notePuts.slice(before).filter(p => p.fields && Object.prototype.hasOwnProperty.call(p.fields, 'todo_due'))) map[put.id] = put.fields.todo_due
        return map
    }
    await test('host glue (todosDroppedBetween interior): one id between 10:00 and 16:00 -> 13:00, one PUT', () => {
        // async handler; the harness returns the promise. Drive it and read the PUTs it produced.
        return betweenGlue.panelMessageHandler(['todosDroppedBetween', [cDrag], cPrev, cNext, '2026-08-19']).then(() => {
            const got = duePutsSince(betweenGlue, 0)
            assert.strictEqual(got[cDrag], dueAt(2026, 8, 19, 13, 0), 'the dragged id lands at the :00 nearest the midpoint of its neighbours')
        })
    })
    await test('host glue (todosDroppedBetween multi): two ids between 14:00 and 17:00 -> 15:00, 16:00 (equal division, order preserved)', async () => {
        betweenGlue.notes[cPrev].todo_due = dueAt(2026, 8, 19, 14, 0)
        betweenGlue.notes[cNext].todo_due = dueAt(2026, 8, 19, 17, 0)
        const before = betweenGlue.notePuts.length
        await betweenGlue.panelMessageHandler(['todosDroppedBetween', [cDrag, cDrag2], cPrev, cNext, '2026-08-19'])
        const got = duePutsSince(betweenGlue, before)
        // 3h split into 3 equal parts -> 1h steps; the dragged order maps to the strictly-increasing sequence.
        assert.strictEqual(got[cDrag], dueAt(2026, 8, 19, 15, 0), 'first dragged id')
        assert.strictEqual(got[cDrag2], dueAt(2026, 8, 19, 16, 0), 'second dragged id, strictly later')
    })
    await test('host glue (todosDroppedBetween top edge, no prev): uses date@day-start -> 11:00', async () => {
        betweenGlue.notes[cNext].todo_due = dueAt(2026, 8, 19, 14, 0)
        const before = betweenGlue.notePuts.length
        await betweenGlue.panelMessageHandler(['todosDroppedBetween', [cDrag], null, cNext, '2026-08-19'])
        const got = duePutsSince(betweenGlue, before)
        assert.strictEqual(got[cDrag], dueAt(2026, 8, 19, 11, 0), 'between day-start 09:00 and the first row 14:00, the :00 nearest 11:30 is 11:00')
    })
    await test('host glue (todosDroppedBetween bottom edge, no next): uses date@23:59 -> 19:00', async () => {
        betweenGlue.notes[cPrev].todo_due = dueAt(2026, 8, 19, 14, 0)
        const before = betweenGlue.notePuts.length
        await betweenGlue.panelMessageHandler(['todosDroppedBetween', [cDrag], cPrev, null, '2026-08-19'])
        const got = duePutsSince(betweenGlue, before)
        assert.strictEqual(got[cDrag], dueAt(2026, 8, 19, 19, 0), 'between the last row 14:00 and 23:59, the :00 nearest ~18:59 is 19:00')
    })
    await test('host glue (todosDroppedBetween re-reads dues FRESH): a neighbour changed since render is honoured', async () => {
        // The neighbour's due is mutated AFTER the panel would have rendered; the host must read it fresh at drop time.
        betweenGlue.notes[cPrev].todo_due = dueAt(2026, 8, 19, 10, 0)
        betweenGlue.notes[cNext].todo_due = dueAt(2026, 8, 19, 12, 0)   // moved earlier than the stale 16:00/18:00 above
        const before = betweenGlue.notePuts.length
        await betweenGlue.panelMessageHandler(['todosDroppedBetween', [cDrag], cPrev, cNext, '2026-08-19'])
        const got = duePutsSince(betweenGlue, before)
        assert.strictEqual(got[cDrag], dueAt(2026, 8, 19, 11, 0), 'between the FRESH 10:00 and 12:00 -> 11:00, not a value from the stale render')
    })
    await test('host glue (todosDroppedBetween, MULTI-DAY group bottom edge): the slice END day bounds it, not the first', async () => {
        // The shape an interval period section posts since v2.2.0: data-drop is the FIRST day of the slice
        // (2026-09-07) and data-drop-end its last (2026-09-30). Dropping below the group's last row must spread
        // FORWARD into the slice; with only the first day the interval inverts and the to-do stays put.
        betweenGlue.notes[cPrev].todo_due = dueAt(2026, 9, 20, 10, 0)
        const before = betweenGlue.notePuts.length
        await betweenGlue.panelMessageHandler(['todosDroppedBetween', [cDrag], cPrev, null, '2026-09-07', '2026-09-30'])
        const got = duePutsSince(betweenGlue, before)
        assert.ok(got[cDrag] > dueAt(2026, 9, 20, 10, 0) && got[cDrag] < dueAt(2026, 9, 30, 23, 59),
            `the dropped to-do must land strictly inside (last row, slice end), was ${new Date(got[cDrag])}`)
        assert.strictEqual(got[cDrag], dueAt(2026, 9, 25, 9, 0), 'the midpoint DAY of Sep 20..Sep 30 at the 09:00 day start')
    })
    await test('host glue (todosDroppedBetween, DATELESS group / Overdue): null groupDate, interior between two past dues', async () => {
        // The Overdue between-drop posts a NULL groupDate (the group has no date); the interior interval comes purely
        // from the neighbours' (past) dues, so the dragged row lands strictly between them.
        betweenGlue.notes[cPrev].todo_due = dueAt(2022, 1, 8, 10, 0)   // an overdue neighbour above the gap
        betweenGlue.notes[cNext].todo_due = dueAt(2022, 1, 8, 16, 0)   // an overdue neighbour below the gap
        const before = betweenGlue.notePuts.length
        await betweenGlue.panelMessageHandler(['todosDroppedBetween', [cDrag], cPrev, cNext, null])
        const got = duePutsSince(betweenGlue, before)
        assert.strictEqual(got[cDrag], dueAt(2022, 1, 8, 13, 0), 'between 10:00 and 16:00 -> the :00 nearest 13:00, with NO group date')
        assert.ok(got[cDrag] > dueAt(2022, 1, 8, 10, 0) && got[cDrag] < dueAt(2022, 1, 8, 16, 0), 'strictly between the two past neighbours')
    })

    // ---- HOST GLUE: day-start setting (A) + heading-drop time rules (B), through the real todosDropped path ----
    const abDated = dup('e', '5'), abNoDue = dup('f', '6'), abCustom = dup('g', '7'), abInvalid = dup('h', '8')
    const abNotes = {
        [abDated]:   { id: abDated,   title: 'dated',   todo_completed: 0, todo_due: dueAt(2026, 8, 19, 14, 30), parent_id: nb },
        [abNoDue]:   { id: abNoDue,   title: 'no due',  todo_completed: 0, todo_due: 0, parent_id: nb },
        [abCustom]:  { id: abCustom,  title: 'custom',  todo_completed: 0, todo_due: 0, parent_id: nb },
        [abInvalid]: { id: abInvalid, title: 'invalid', todo_completed: 0, todo_due: 0, parent_id: nb },
    }
    const abGlue = await run({
        dataDir: path.join(tmp, 'ab-glue-data'),
        installationDir: path.join(tmp, 'ab-glue-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: Object.values(abNotes),
        notes: abNotes,
    })
    await test('host glue (todosDropped, Feature B): a dated to-do keeps its own time; a no-due one gets date@day-start (default 09:00)', async () => {
        const before = abGlue.notePuts.length
        await abGlue.panelMessageHandler(['todosDropped', [abDated, abNoDue], '2026-12-25'])
        const got = duePutsSince(abGlue, before)
        assert.strictEqual(got[abDated], dueAt(2026, 12, 25, 14, 30), 'the dated to-do keeps 14:30, only its date moves')
        assert.strictEqual(got[abNoDue], dueAt(2026, 12, 25, 9, 0), 'the no-due to-do gets the target date at the default day-start 09:00')
    })
    await test('host glue (Feature A, custom day-start): a no-due drop uses the configured HH:MM (06:15)', async () => {
        await abGlue.setSetting('dayStartTime', '06:15')
        const before = abGlue.notePuts.length
        await abGlue.panelMessageHandler(['todosDropped', [abCustom], '2026-12-25'])
        const got = duePutsSince(abGlue, before)
        assert.strictEqual(got[abCustom], dueAt(2026, 12, 25, 6, 15), 'getDayStartTime must read the custom setting')
    })
    await test('host glue (Feature A, invalid day-start): a malformed setting falls back to 09:00', async () => {
        await abGlue.setSetting('dayStartTime', 'not-a-time')
        const before = abGlue.notePuts.length
        await abGlue.panelMessageHandler(['todosDropped', [abInvalid], '2026-12-25'])
        const got = duePutsSince(abGlue, before)
        assert.strictEqual(got[abInvalid], dueAt(2026, 12, 25, 9, 0), 'a malformed HH:MM falls back to 09:00, not NaN')
    })

    // ---- WEBVIEW SOURCE SHAPE: the harness cannot execute the webview JS, so pin the between-zone wiring as source ----
    await test('webview between-drop wiring: exists, desktop-gated, reuses the markup, cleaned up on dragend/drop', () => {
        // The gesture posts its own message shape and reads the existing markup (the row id + its heading's data-drop date).
        assert.ok(webviewSource.includes("['todosDroppedBetween', ids, prevId, nextId, target.groupDate, target.groupEndDate]"), 'the between drop must post todosDroppedBetween with prev/next/groupDate/groupEndDate')
        assert.ok(/getAttribute\('data-drop'\)/.test(webviewSource) && /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(webviewSource), 'the group date must be read from the existing heading data-drop (a YYYY-MM-DD)')
        // A group spanning several days (an interval period section) carries its LAST day too; the bottom edge needs
        // it, since data-drop is only the first day of the slice.
        assert.ok(/getAttribute\('data-drop-end'\)/.test(webviewSource), 'the slice end day must be read from the heading data-drop-end')
        assert.ok(/parentElement\.classList\.contains\('todos'\)/.test(webviewSource), 'eligibility must be limited to rows that are direct children of .todos (list views only)')
        // Desktop-gated: both drag handlers bail immediately on mobile (drag does not exist there anyway).
        // ...and the dragover is limited to a drag THIS PANEL started, so a foreign drag (text from another window)
        // draws no insertion line for a payload that could never be dropped.
        assert.ok(/function onBetweenDragOver\(event\)\{\s*if \(IS_MOBILE \|\| !isPanelDragEvent\(event\)\) return/.test(webviewSource),
            'onBetweenDragOver must be desktop-gated (IS_MOBILE) and limited to a drag this panel started')
        assert.ok(/async function onBetweenDrop\(event\)\{\s*if \(IS_MOBILE\) return/.test(webviewSource), 'onBetweenDrop must be desktop-gated (IS_MOBILE)')
        // Stateless delegated wiring that survives every setHtml, and a clean-up on both drop and dragend.
        assert.ok(webviewSource.includes("document.addEventListener('dragover', onBetweenDragOver"), 'the dragover listener must be delegated on the document')
        assert.ok(webviewSource.includes("document.addEventListener('drop', onBetweenDrop"), 'the drop listener must be delegated on the document')
        assert.ok(webviewSource.includes("document.addEventListener('dragend', clearBetweenIndicator"), 'the indicator must be cleaned up on dragend')
        assert.ok(/function onBetweenDrop[\s\S]*clearBetweenIndicator\(\)/.test(webviewSource), 'the indicator must be cleaned up on drop too')
        // The indicator classes the CSS styles.
        assert.ok(webviewSource.includes("'-drop-before'") && webviewSource.includes("'-drop-after'"), 'the insertion line uses the -drop-before / -drop-after classes')
    })
    await test('between-drop eligibility: dateless groups (Overdue/Future) qualify; only No-Due is excluded', () => {
        // The gate must EXCLUDE only the No-Due group (data-drop 'clear') - its rows carry no due to sit between - and
        // treat a dateless heading (no data-drop) as eligible with a NULL groupDate (interior interval from the
        // neighbours; edges derived host-side). A dated heading still yields its YYYY-MM-DD groupDate.
        assert.ok(/betweenGroupInfo/.test(webviewSource), 'eligibility resolves through betweenGroupInfo')
        assert.ok(/drop === 'clear'/.test(webviewSource), "the No-Due group ('clear') must be the only excluded group")
        assert.ok(/return \{ groupDate: null, groupEndDate: null \}/.test(webviewSource), 'a dateless group (Overdue/Future) must be eligible with a null groupDate')
        assert.ok(/return \{ groupDate: drop, groupEndDate: \(end && /.test(webviewSource), 'a dated group must still carry its YYYY-MM-DD date, plus its end day when it spans several')
    })
    await test('panel.css between-drop indicator: an inset box-shadow (no layout shift), a --cockpit-* accent, no @media', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        const ruleBody = (selector) => {
            const at = css.indexOf(selector)
            assert.ok(at >= 0, `panel.css is missing the ${selector} rule`)
            const open = css.indexOf('{', at), close = css.indexOf('}', open)
            return css.slice(open + 1, close)
        }
        for (const selector of ['.todo.-drop-before {', '.todo.-drop-after {']) {
            const body = ruleBody(selector)
            assert.ok(/box-shadow:\s*inset/.test(body), `${selector} must draw the line as an inset box-shadow`)
            assert.ok(/var\(--cockpit-/.test(body), `${selector} must colour the line from a --cockpit-* variable`)
            // No layout-shifting properties: the line must not add height/border/margin that would move rows.
            assert.ok(!/(^|;|\s)(height|border|margin|padding):/.test(body), `${selector} must not change box geometry (no layout shift)`)
            assert.ok(!/@media/.test(body), `${selector} must not use @media`)
        }
    })

    // ---- WEBVIEW SOURCE SHAPE: drag auto-scroll at the list edges (same reason - the harness cannot run the webview) ----
    await test('webview drag auto-scroll: the document dragover feeds the helper, and drop/dragend/dragleave stop it', () => {
        // Delegated on the document like the between-rows gesture, so one wiring survives every setHtml re-render.
        assert.ok(webviewSource.includes("document.addEventListener('dragover', onDragAutoscroll"), 'the dragover path must be delegated on the document')
        // Anchored INSIDE the handler (a lazy [\s\S]*? gap would still pass if the call moved to another function).
        assert.ok(handlerBody('onDragAutoscroll').includes('edgeAutoscrollUpdate(container, event.clientX, event.clientY, refreshDropTargetsUnderPointer)'),
            'the dragover handler must feed the container and the full pointer position to the autoscroll helper')
        // BOTH ends of a drag stop it: a drop and a dragend. Losing either leaves the list scrolling after the gesture.
        assert.ok(webviewSource.includes("document.addEventListener('drop', endPanelDrag"), 'a drop must end the panel drag, and with it the scrolling')
        assert.ok(webviewSource.includes("document.addEventListener('dragend', endPanelDrag"), 'a dragend must end the panel drag, and with it the scrolling')
        // ...and so does the drag LEAVING the document, which neither of those two covers: a pointer carried out
        // through the top or bottom edge is outside the container vertically, where the overshoot rule pins the speed
        // at maximum, so without this the list runs on for the whole watchdog - the better part of a thousand pixels.
        assert.ok(webviewSource.includes("document.addEventListener('dragleave', onPanelDragLeave"), 'a drag leaving the document must stop the scrolling too')
        const leaveBody = handlerBody('onPanelDragLeave')
        assert.ok(leaveBody.includes('clearPanelDragEffects()'), 'the dragleave handler must take the scroll loop and both paints down')
        // ...and it must NOT drop the ownership flag with them. Leaving is not an END: the drag OPERATION survives
        // the pointer leaving the iframe, and the same drag brought back over the list has to be able to draw its
        // insertion line, scroll and drop exactly as before. Ending ownership here would make the departure a
        // one-way door - onBetweenDragOver bails on that gate before its own preventDefault, so the browser would
        // fire no drop at all for the rest of the drag, while the ungated heading drops carried on working.
        assert.ok(!leaveBody.includes('endPanelDrag(') && !/panelDragActive\s*=/.test(leaveBody),
            'the dragleave handler must not end the drag itself: a drag that leaves and comes back must still be able to drop')
        // Both halves of "left the document", and the second is the load-bearing one: a dragleave ALSO fires when the
        // element under a HOLDING-STILL pointer changes because the auto-scroll moved the rows under it, and Blink
        // does not reliably name the element the drag moved to. relatedTarget alone would stop the loop the moment
        // the scrolling it exists for started working.
        assert.ok(leaveBody.includes('if (event.relatedTarget !== null) return'), 'the dragleave handler must ignore a move to another element of this document')
        assert.ok(/clientX < window\.innerWidth && .*clientY < window\.innerHeight|x < window\.innerWidth && y < window\.innerHeight/.test(leaveBody),
            'the dragleave handler must also require the pointer to be outside the document box, so a still pointer the list scrolls under is never mistaken for a departure')
        // Ending the drag drops ownership AND everything the drag left running or lit; the effects sweep is its own
        // function because the departure above needs exactly that half. Pinned as membership rather than as one
        // regex over the statement ORDER: the order is not a property anything depends on, and pinning it would fail
        // a harmless reshuffle. A target the list scrolled out from under a STILL pointer owes no dragleave, so
        // without the two paint sweeps its highlight would survive the whole gesture.
        const endBody = handlerBody('endPanelDrag')
        assert.ok(endBody.includes('panelDragActive = false'), 'ending the drag must drop the ownership flag')
        assert.ok(endBody.includes('clearPanelDragEffects()'), 'ending the drag must take its on-screen effects down too')
        const effects = handlerBody('clearPanelDragEffects')
        assert.ok(effects.includes('edgeAutoscrollStop()'), 'clearing the drag effects must stop the scroll loop')
        assert.ok(effects.includes('paintDropTargetHighlight(null)'), 'clearing the drag effects must clear the whole-row drop highlight')
        assert.ok(effects.includes('clearBetweenIndicator()'), 'clearing the drag effects must clear the between-rows insertion line')
    })
    await test('webview drag auto-scroll: the watchdog is a safety net, well above any drag event cadence', () => {
        // It must NOT be the thing keeping the loop alive. A pointer holding still in the band is the gesture this
        // feature exists for, and that is exactly when events dry up: the HTML drag-and-drop model iterates every
        // 350ms, and the touch drag this helper is meant to be shared with sends nothing at all for a still finger.
        // Anything at or below that cadence would deliver "wiggle the mouse to keep it scrolling" instead.
        const idle = /var AUTOSCROLL_IDLE_MS = (\d+)/.exec(webviewSource)
        assert.ok(idle, 'the watchdog timeout must be a named, tunable constant')
        assert.ok(Number(idle[1]) >= 500, `the watchdog must sit well above the 350ms drag cadence, not at ${idle[1]}ms`)
        assert.ok(/Date\.now\(\) - autoscrollAt > AUTOSCROLL_IDLE_MS\)\{ edgeAutoscrollStop\(\); return \}/.test(webviewSource),
            'the loop must stop itself when no update has arrived within the watchdog timeout')
        assert.ok(/cancelAnimationFrame\(autoscrollFrame\)/.test(webviewSource), 'stopping must cancel the pending frame, so no rAF loop survives a drag')
    })
    await test('webview drag auto-scroll: desktop-gated, and only for a drag this panel started', () => {
        assert.ok(/function onDragAutoscroll\(event\)\{\s*if \(IS_MOBILE \|\| !isPanelDragEvent\(event\)\) return/.test(webviewSource),
            'the dragover handler must bail on mobile (no HTML5 drag there) and on a drag this panel did not start')
        // Ownership is asked of the DRAG, not only of a flag: the flag's only clears are drop and dragend, and a drag
        // whose source row a mid-drag re-render detached can end without either reaching the document listener.
        assert.ok(handlerBody('onTodoDragStart').includes('panelDragActive = true'), "the panel's own dragstart must raise the flag")
        assert.ok(handlerBody('onTodoDragStart').includes("setData(PANEL_DRAG_TYPE, '1')"), "the panel's own dragstart must stamp the drag with the ownership type")
        const owner = handlerBody('isPanelDragEvent')
        assert.ok(owner.includes('if (!panelDragActive) return false'), 'ownership must still require a drag of ours to be in flight')
        assert.ok(/dataTransfer\.types/.test(owner) && owner.includes('PANEL_DRAG_TYPE'),
            'ownership must also read the type off the drag itself (types is readable in dragover, getData is not)')
        assert.ok(handlerBody('onTodoDragEnd').includes('endPanelDrag()'), "the panel's own dragend must end it")
    })
    await test('webview drag auto-scroll: the loop stops at the limit and re-resolves the targets under a still pointer', () => {
        const tick = handlerBody('edgeAutoscrollTick')
        // The scroll limit: a frame that cannot move the container ends the loop rather than spinning to the dragend.
        assert.ok(tick.includes('if (el.scrollTop === before){ edgeAutoscrollStop(); return }'), 'a frame that did not move the container must end the loop')
        // Leaving the band ends it too - update() is the only caller that can see the pointer move out.
        assert.ok(handlerBody('edgeAutoscrollUpdate').includes('if (!step){ edgeAutoscrollStop(); return }'), 'a pointer outside both bands must stop the loop')
        // The callback runs with the pointer position, AFTER the next frame is booked: a throwing callback must not be
        // able to leave the loop dead-but-not-stopped (frame null, everything else still set).
        assert.ok(tick.includes('autoscrollOnScroll(autoscrollClientX, autoscrollClientY)'), 'the scroll callback must be handed the pointer position')
        assert.ok(tick.indexOf('requestAnimationFrame(edgeAutoscrollTick)') < tick.indexOf('autoscrollOnScroll(autoscroll'),
            'the next frame must be booked before the callback runs')
        assert.ok(/try \{ autoscrollOnScroll/.test(tick), 'a throwing callback must not kill the loop')
        // Both drop affordances are re-resolved from that position, not just the insertion line: the rows AND the
        // headings move under a still pointer, and -drop-over is otherwise only ever removed by its own dragleave.
        const refresh = handlerBody('refreshDropTargetsUnderPointer')
        assert.ok(refresh.includes('document.elementFromPoint(clientX, clientY)'), 'the refresh must re-ask what is under the pointer')
        assert.ok(refresh.includes('paintBetweenIndicator('), 'the refresh must re-resolve the between-rows insertion line')
        assert.ok(refresh.includes('paintDropTargetHighlight('), 'the refresh must re-resolve the whole-row drop highlight')
    })
    await test('webview drag auto-scroll: a release while the list is moving is accepted, not refused', () => {
        // The browser decides whether to fire `drop` at all from the LAST dragover it delivered. While the list
        // scrolls under a still pointer, the target that has just arrived was never asked - so without a document
        // level acceptance the release is silently refused and the to-do does not move.
        const body = handlerBody('onDragAutoscroll')
        assert.ok(body.includes('if (!edgeAutoscrollRunning()) return'), 'the acceptance must be limited to the frames where the list is actually moving')
        assert.ok(body.indexOf('event.preventDefault()') > body.indexOf('if (!edgeAutoscrollRunning()) return'),
            'the dragover must accept the drop while the list is moving')
        // ...and a release that lands on an inert spot must still not let the browser act on the dragged text.
        assert.ok(handlerBody('onBetweenDrop').includes('if (panelDragActive) event.preventDefault()'),
            'a drop with no between-target must suppress the default action for a drag of ours')
    })
    await test('webview drag auto-scroll: the band and speed curve are named constants, and overshoot pins the speed', () => {
        // The brief asked for tunable constants at the top of the helper; inlining any of them back into the maths
        // would leave the feel unfindable.
        assert.ok(/var AUTOSCROLL_BAND_RATIO = [\d.]+[\s\S]{0,600}var AUTOSCROLL_BAND_MIN = \d+[\s\S]{0,600}var AUTOSCROLL_BAND_MAX = \d+[\s\S]{0,600}var AUTOSCROLL_SPEED_MIN = \d+[\s\S]{0,600}var AUTOSCROLL_SPEED_MAX = \d+/.test(webviewSource),
            'the band and speed constants must be declared together at the top of the helper')
        const step = handlerBody('edgeAutoscrollStep')
        for (const name of ['AUTOSCROLL_BAND_RATIO', 'AUTOSCROLL_BAND_MIN', 'AUTOSCROLL_BAND_MAX', 'AUTOSCROLL_SPEED_MIN', 'AUTOSCROLL_SPEED_MAX']){
            assert.ok(step.includes(name), `the step maths must read ${name} rather than inline its value`)
        }
        // Overshooting the container vertically means "more, faster", not "stop": .todos has the controls block above
        // it and the panel's padding below, so shoving the pointer to the very edge lands just outside the box.
        assert.ok(step.includes('if (clientY < rect.top) return -AUTOSCROLL_SPEED_MAX'), 'a pointer above the container must scroll up at full speed')
        assert.ok(step.includes('if (clientY > rect.bottom) return AUTOSCROLL_SPEED_MAX'), 'a pointer below the container must scroll down at full speed')
        // ...but off to the SIDE is someone else's gesture.
        assert.ok(step.includes('if (clientX < rect.left || clientX > rect.right) return 0'), 'a pointer beside the container must not scroll it')
        // ...and the band is clamped to HALF the height as well, so in a very short container the top and bottom bands
        // cannot overlap into a list with no inert middle left at all.
        assert.ok(step.includes('Math.min(rect.height / 2'), 'the band must be clamped to half the container height, so the two bands never overlap')
    })

    // ============================================================ drag to reschedule on TOUCH (mobile)
    // Two layers, tested the two ways this harness can. The band and row-index arithmetic is a real module,
    // required and driven directly - it is the part that would be wrong on a device and invisible in review, so
    // its boundaries are exercised rather than pattern-matched. The gesture itself lives in the webview, which
    // this harness renders but never executes, so its load-bearing shapes are pinned as SOURCE: the guard
    // discipline (a leaked dialogGuard freezes mobile refreshes for the life of the webview), the non-passive
    // touchmove (the one thing that stops Android panning the list, and only once the row is up), the zones the arm
    // path must refuse, the menu-first order the first Pixel round forced, and the desktop paths that must stay
    // exactly where they were.
    const TouchDrag = require('../src/ui/panel/touchDrag.js')

    await test('touchDrag.bandSide: the mobile 0.5 splits a row in half with the midline going BEFORE, and no inert middle', () => {
        // 0.5 is the mobile band: every point of the row is a live target (a finger is not a cursor, and a dead
        // strip in a 26px row reads as the gesture ignoring you).
        assert.strictEqual(TouchDrag.bandSide(0, 26, 0.5), 'before', 'the very top of the row inserts above it')
        assert.strictEqual(TouchDrag.bandSide(12, 26, 0.5), 'before', 'just above the midline inserts above')
        assert.strictEqual(TouchDrag.bandSide(13, 26, 0.5), 'before', 'the midline ITSELF is before - the split is total and deterministic')
        assert.strictEqual(TouchDrag.bandSide(14, 26, 0.5), 'after', 'past the midline inserts below')
        assert.strictEqual(TouchDrag.bandSide(26, 26, 0.5), 'after', 'the very bottom of the row inserts below it')
        // The gap between two rows: an offset PAST the row's height is still that row's "after" side, which is
        // the same gap as the next row's "before". A point above the row is its "before".
        assert.strictEqual(TouchDrag.bandSide(40, 26, 0.5), 'after', 'a point below the row belongs to the gap under it')
        assert.strictEqual(TouchDrag.bandSide(-4, 26, 0.5), 'before', 'a point above the row belongs to the gap over it')
        // A zero-height row collapses to its top edge, where the <= rule makes every point "before".
        assert.strictEqual(TouchDrag.bandSide(0, 0, 0.5), 'before', 'a zero-height row has only a top edge')
    })

    await test('touchDrag.bandSide: the same function serves the desktop 0.4, whose middle stays inert', () => {
        // The desktop drag keeps BETWEEN_BAND 0.4 and its inert middle, which it resolves itself; what this
        // pins is that the shared arithmetic still answers the 0.4 question the same way at both edges, so the
        // two gestures cannot drift into different ideas of where a row's halves are.
        assert.strictEqual(TouchDrag.bandSide(4, 26, 0.4), 'before', 'inside the desktop top band')
        assert.strictEqual(TouchDrag.bandSide(13, 26, 0.4), 'after', 'the desktop middle is past the 0.4 band')
    })

    await test('touchDrag.rowAtY: gaps belong to the row above, and both ends of the list are null', () => {
        const index = [
            { top: 0, bottom: 10, id: 'a' },
            { top: 14, bottom: 24, id: 'b' },
            { top: 28, bottom: 38, id: 'c' },
        ]
        const at = (y) => { const hit = TouchDrag.rowAtY(index, y); return hit ? hit.id : null }
        assert.strictEqual(at(-1), null, 'above the first row there is nothing to insert against')
        assert.strictEqual(at(0), 'a', "a row's own top edge is that row")
        assert.strictEqual(at(9), 'a', 'inside the first row')
        assert.strictEqual(at(10), 'a', 'the gap under a row belongs to it (its "after" side)')
        assert.strictEqual(at(13), 'a', '...all the way to the next row')
        assert.strictEqual(at(14), 'b', "...which starts at the next row's own top")
        assert.strictEqual(at(37), 'c', 'inside the last row')
        assert.strictEqual(at(38), null, "the last row's bottom edge is already off the end")
        assert.strictEqual(at(1000), null, 'far below the list')
        assert.strictEqual(TouchDrag.rowAtY([], 5), null, 'an empty index resolves to nothing')
        assert.strictEqual(TouchDrag.rowAtY(null, 5), null, 'and so does no index at all')
        // A single-row index has both boundaries at once.
        const one = [{ top: 5, bottom: 15, id: 'only' }]
        assert.strictEqual(TouchDrag.rowAtY(one, 4), null, 'above a one-row list')
        assert.strictEqual(TouchDrag.rowAtY(one, 5).id, 'only', 'on it')
        assert.strictEqual(TouchDrag.rowAtY(one, 15), null, 'below it')
    })

    await test('touchDrag.rowAtY: the binary search agrees with a linear scan over a long list', () => {
        // The search is a binary one because the index is rebuilt after every auto-scrolled frame and asked on
        // every touch move; this compares it against the obvious slow answer at every pixel of a 60-row list.
        const index = []
        for (let i = 0; i < 60; i++) index.push({ top: i * 30, bottom: i * 30 + 26, id: 'r' + i })
        const linear = (y) => {
            if (y < index[0].top || y >= index[index.length - 1].bottom) return null
            let found = null
            for (const entry of index) if (entry.top <= y) found = entry
            return found
        }
        for (let y = -5; y <= 60 * 30 + 5; y++) {
            const got = TouchDrag.rowAtY(index, y)
            const want = linear(y)
            assert.strictEqual(got ? got.id : null, want ? want.id : null, `rowAtY disagrees at y=${y}`)
        }
    })

    // The two thresholds AS SHIPPED, read from the panel rather than repeated here, so the pure checks below can
    // never go on proving things about numbers the gesture no longer uses. Their values and their RELATION are
    // pinned by name further down ('the two bands are named constants').
    const PRESS_SLOP = Number(/var TOUCH_DRAG_SLOP = (\d+)/.exec(webviewSource)[1])
    const LIFT_PX = Number(/var TOUCH_DRAG_LIFT_PX = (\d+)/.exec(webviewSource)[1])

    await test('touchDrag.movedBeyond: per axis, and exactly the slop is still held still', () => {
        assert.strictEqual(TouchDrag.movedBeyond(10, 0, 0, 0, 10), false, 'exactly the slop has not moved (the long press says the same)')
        assert.strictEqual(TouchDrag.movedBeyond(11, 0, 0, 0, 10), true, 'one past the slop on x has')
        assert.strictEqual(TouchDrag.movedBeyond(0, -11, 0, 0, 10), true, 'and so has one past it on y, in either direction')
        assert.strictEqual(TouchDrag.movedBeyond(7, 7, 0, 0, 10), false, 'the rule is per AXIS, not a diagonal distance')
        // The same arithmetic answers the drag's own, larger question: one function, two thresholds, so "has it
        // moved" cannot come to mean two different things to the press and to the lift.
        assert.strictEqual(TouchDrag.movedBeyond(LIFT_PX, 0, 0, 0, LIFT_PX), false, 'exactly the lift threshold is still held still too')
        assert.strictEqual(TouchDrag.movedBeyond(0, LIFT_PX + 1, 0, 0, LIFT_PX), true, 'and one past it has travelled')
    })

    await test('touchDrag.liftDecision: the LIFT threshold first, then the axis - and a perfect diagonal lifts', () => {
        // The whole of the menu-first gesture's decision. The hold opens the context menu with the finger still
        // down; this says what the finger did NEXT, once, and for good: up or down is the drag, across is Joplin's
        // own side-menu swipe and the panel gets out of its way.
        const d = (dx, dy) => TouchDrag.liftDecision(dx, dy, LIFT_PX)
        const past = LIFT_PX + 1
        assert.strictEqual(d(0, 0), null, 'a finger that has not moved has decided nothing')
        assert.strictEqual(d(LIFT_PX, 0), null, 'exactly the threshold is still held still, the same as movedBeyond')
        assert.strictEqual(d(LIFT_PX - 1, LIFT_PX - 1), null, 'the threshold is per AXIS, not a diagonal distance')
        assert.strictEqual(d(0, past), 'vertical', 'down past the threshold is the drag')
        assert.strictEqual(d(0, -past), 'vertical', '...and so is up')
        assert.strictEqual(d(past, 0), 'sideways', 'across past the threshold is the side menu, not ours')
        assert.strictEqual(d(-past, 0), 'sideways', '...in either direction')
        assert.strictEqual(d(past, past), 'vertical', 'a perfect diagonal goes to the drag: a refused swipe is one flick from being re-tried, a refused lift is not')
        assert.strictEqual(d(past + 1, past), 'sideways', 'one pixel more across than down is sideways')
        assert.strictEqual(d(past, past + 1), 'vertical', 'and one more down than across is vertical')
        assert.strictEqual(d(-past, past + 1), 'vertical', 'the two axes are compared by magnitude, never by sign')
        // THE THIRD PIXEL ROUND'S ARITHMETIC. The press survives on 10px from the press point; if the lift used
        // that same number the arm would be born at the edge of its own threshold and the smallest drift after the
        // menu opened would lift the row and close the menu. Everything the OLD gate would have decided, this one
        // must still call undecided - which is what "some tolerance for hold and move" means as a test.
        for (const [dx, dy] of [[0, PRESS_SLOP + 1], [PRESS_SLOP + 1, 0], [PRESS_SLOP + 2, PRESS_SLOP + 2],
                                [0, -LIFT_PX], [LIFT_PX - 1, 0], [0, LIFT_PX], [-LIFT_PX, LIFT_PX]]){
            assert.strictEqual(d(dx, dy), null, `travel of ${dx},${dy} is inside the tolerance and must decide nothing`)
            // ...and the table is only worth anything while every row of it really IS a travel the old gate would
            // have decided on. This asserts that, rather than re-asserting the line above in a longer form.
            assert.strictEqual(TouchDrag.movedBeyond(dx, dy, 0, 0, PRESS_SLOP), true,
                `${dx},${dy} must be past the press's own ${PRESS_SLOP}px slop, or it proves no tolerance at all`)
        }
        // The threshold gate IS movedBeyond, at whatever number the caller passes, so the two cannot drift apart:
        // anything that has moved for one has moved for the other, at every point of a grid straddling both
        // boundaries in all four quadrants.
        for (const threshold of [PRESS_SLOP, LIFT_PX]){
            for (let dx = -30; dx <= 30; dx++) for (let dy = -30; dy <= 30; dy++){
                assert.strictEqual(TouchDrag.liftDecision(dx, dy, threshold) === null, !TouchDrag.movedBeyond(dx, dy, 0, 0, threshold),
                    `the threshold gate must agree with movedBeyond at ${dx},${dy} (threshold ${threshold})`)
            }
        }
    })

    await test('webview touch drag: the arm refuses the tick circle, the notebook pill and the read-only peek', () => {
        // Every zone that already means something else keeps meaning it, and the peek's rows are not reschedule
        // sources at all (they are rendered draggable:false for exactly that reason). All of them get their
        // context menu on the fire like every other kind, and arm no drag behind it.
        const lift = handlerBody('canLiftRow')
        assert.ok(lift.includes("classList.contains('todo-checkbox')"), 'a press on the tick circle must not lift the row (it opens the date picker)')
        assert.ok(lift.includes("classList.contains('todo-notebook')"), 'a press on the notebook pill must not lift the row (it moves the note)')
        assert.ok(lift.includes("closest('.outside-results')"), 'a read-only peek row must never be lifted')
        assert.ok(/dataset\.todoId/.test(lift), 'only a to-do row can be lifted at all')
        // ...and the fourth guard is one layer up, in the adapter that arms the press: an event inside an open
        // overlay is the overlay's own and never arms anything.
        assert.ok(/closest\('#cockpitOverlay'\)\) return/.test(webviewSource), 'a press inside an in-panel overlay must not arm the press at all')
        // The branch itself: only kind 'todo', and only when the zone allows it. Asserted as an ORDERING rather
        // than as one regex spanning both lines, so a comment growing between them cannot silently retire the pin.
        const fire = handlerBody('onLongPressFire')
        const todoBranch = fireTodoBranch(fire)
        assert.ok(fire.includes('if (canLiftRow(longPress.target, longPress.el)) armTouchDrag()'),
            'only a to-do row body arms the drag; note rows, headings and the sync button reach their own handlers untouched')
        // CONTAINMENT, not mere ordering: the branch is sliced from `if (longPress.kind === 'todo'){` to the
        // `else if` that ends it, and the arm must be inside THAT. An arm moved out of the branch - into the
        // else-if chain, or after the whole chain - would still be "after the branch opened" and would arm the
        // drag on a note row, a heading or the sync button, so ordering alone is not the property to pin.
        assert.ok(todoBranch.includes('armTouchDrag()'),
            'the arm must sit INSIDE the to-do branch of the fire, not merely after it opens')
        assert.strictEqual((fire.match(/armTouchDrag\(\)/g) || []).length, 1,
            'and it must be armed from exactly one place in the fire')
    })

    await test('webview touch drag: the hold opens the MENU first and only arms the drag behind it', () => {
        // The first Pixel round killed the lift-at-500ms design: the lift landed in the middle of Joplin's own
        // side-menu swipe and neither gesture won. The hold is back to being exactly what it was before this
        // feature existed - it opens the to-do's context menu, with the finger still down - and the drag is armed
        // silently behind that menu, for the next move to decide.
        const fire = handlerBody('onLongPressFire')
        assert.ok(fire.includes('onTodoContextMenu(ev, longPress.id)'), 'a held to-do row must open its menu at the fire, as it always did')
        assert.ok(fire.indexOf('onTodoContextMenu(ev') < fire.indexOf('armTouchDrag()'),
            'the menu must open BEFORE the arm: the arm is what indexes the rows, and it may only measure a list that already carries everything the fire puts on screen (the menu is position:fixed and moves no row, which is what makes this order safe rather than merely tidy)')
        assert.strictEqual((fire.match(/\breturn\b/g) || []).length, 0,
            'no kind may short-circuit the fire any more: every one of the four opens its own menu')
        // The arm takes NOTHING. A release from there has to leave the menu standing, and a guard release would
        // have the host repaint the panel out from under it (panel.ts runs refreshPanelData on the last guard down).
        const arm = handlerBody('armTouchDrag')
        assert.ok(!arm.includes('dialogGuard'), 'the arm must not take the refresh guard')
        assert.ok(!arm.includes("classList.add('-dragging')"), 'the arm must not lift the row')
        assert.ok(!arm.includes('showDragBanner('), 'the arm must not put the banner up')
        assert.ok(!arm.includes('schedulableSelection()'), 'the arm must not resolve a payload')
        assert.ok(!arm.includes('selectedRowIDs'), 'the arm must not touch the selection')
        assert.ok(!arm.includes('NoteContextMenu'), 'and above all it must not close the menu it was armed behind')
        // What it DOES put in place is everything the next move needs to be read, plus the watchdog that has to
        // outlive a gesture nothing ever ends.
        assert.ok(/addEventListener\('touchmove', onTouchDragMove/.test(arm), 'the arm must attach the move listener')
        assert.ok(arm.includes('setPointerCapture'), 'the arm must capture the finger, so a re-render cannot take the moves away')
        assert.ok(arm.includes('buildRowIndex()'), 'the arm must index the rows, while the list is certainly still')
        assert.ok(arm.includes('TOUCH_DRAG_WATCHDOG_MS'), 'the arm must start the watchdog')
        // ...and it snapshots the whole of what the press hands over, the id included. The lift can run many
        // seconds later, on a touchmove, and must not reach back into a longPress object that has moved on.
        assert.ok(arm.includes('touchDrag.id = longPress.id'), 'the arm must snapshot the pressed row\'s id')
        assert.strictEqual(handlerBody('liftTouchDrag').includes('longPress.'), false,
            'and the lift must read that snapshot, never longPress itself')
        // The one way a taken guard could go missing without a release: arming OVER a gesture still in flight,
        // which would overwrite `touchDrag.guarded` in place. Unreachable today (the second-pointer listener ends
        // the old gesture before a new press can fire), so the pin is on the SHAPE - the arm hands a live gesture
        // to the single end rather than clearing the flag itself - which is what keeps it unreachable-by-accident.
        assert.ok(/if \(touchDrag\.active\) endTouchDrag\('re-arm'\)/.test(arm),
            'the arm must end any gesture still in flight through the single end, before it overwrites the state')
        assert.ok(arm.indexOf('endTouchDrag(') < arm.indexOf('touchDrag.guarded = false'),
            '...and it must do so BEFORE clearing the guard flag, or the release would be lost exactly as it is today')
    })

    await test("webview touch drag: Android's long-press contextmenu never reaches a row - the adapter alone opens the menu", () => {
        // THE SECOND PIXEL ROUND'S BUG. The hold opened the menu (18a) and the vertical move lifted the row, but
        // the menu did not close and the release never rescheduled anything. The cause is not in the drag at all:
        // every to-do row carries an inline oncontextmenu="onTodoContextMenu(event, id)" and every note row an
        // onNoteContextMenu (src/core/formats.ts), and Android's native long press fires a REAL contextmenu on the
        // row. Its timing is the device's - the "Touch & hold delay" setting plus Chrome's own ~500ms - so it can
        // land before the adapter's fire (a menu over a menu) or after the lift (a menu re-opening over a lifted
        // row, which then eats the release that should have reached a gap). None of it was traced, because a
        // row's inline handler is on no traced path.
        //
        // First: the hazard is real, and stays real - the inline handlers are what the panel's own rendering
        // emits, and this pin is worthless the day they are gone.
        const formatsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'formats.ts'), 'utf8')
        assert.ok(formatsSource.includes('oncontextmenu="onTodoContextMenu(event,'), 'a to-do row must still carry its inline contextmenu handler (the hazard this suppression exists for)')
        assert.ok(formatsSource.includes('oncontextmenu="onNoteContextMenu(event,'), 'and so must a note row')
        const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'html.ts'), 'utf8')
        assert.ok(htmlSource.includes('oncontextmenu="onHeadingContextMenu(event)"'),
            'and so must a group heading - the fourth inline handler, in src/core/html.ts rather than formats.ts, which an inventory that reads only formats.ts would miss')
        assert.strictEqual((formatsSource.match(/oncontextmenu=/g) || []).length + (htmlSource.match(/oncontextmenu=/g) || []).length, 4,
            'the list row, the week card, the note row and the group heading: four inline handlers, none of which may run on mobile')
        // The suppression, and its SCOPE: any target at all, not just the search suggestion list it started as.
        const block = /document\.addEventListener\('contextmenu', function\(event\)\{([\s\S]*?)\}, true\)/.exec(webviewSource)
        assert.ok(block, 'the panel must still handle contextmenu in the capture phase, at the document')
        const body = block[1]
        assert.ok(/^\s*if \(!IS_MOBILE\) return/.test(body),
            'desktop must return on the FIRST line: a right click there - on a row, in the list, anywhere - is byte-identical to before')
        assert.ok(!body.includes("closest('#searchSuggestions')"),
            'the suppression must NOT be scoped to the suggestion list any more - a row is exactly what it has to cover')
        // What may gate the suppression, and what may not. Past the desktop line there is EXACTLY one early
        // return - the editable-field exemption - so no zone of the panel's can be carved back out of the
        // suppression, by an `if` or by a ternary (an earlier version of this pin forbade only the `if` shape,
        // and a ternary early-return would have walked straight through it).
        const past = body.slice(body.indexOf('if (!IS_MOBILE) return') + 'if (!IS_MOBILE) return'.length)
        assert.strictEqual((past.match(/\breturn\b/g) || []).length, 1,
            '...and to no zone of the panel\'s: past the desktop line exactly one early return may stand, and nothing else may gate the suppression on where the press landed')
        assert.ok(past.includes('if (el && el.closest(CONTEXTMENU_TEXT_FIELD) && !el.closest(CONTEXTMENU_HANDLER_ZONE)) return'),
            'that one return is the text-field exemption: Android raises the text-selection handles and the Paste / Select-all bar through this same event, and in a field on a phone that bar is the only way to paste')
        // The fields it exempts are real, and are the ones a finger is held down in on mobile.
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        assert.ok(panelSource.includes('<input id="searchFilter"'), 'the search box is an input, so the exemption reaches it')
        assert.ok(panelSource.includes('class="notebook-filter-input"'), '...and so is the notebook filter')
        assert.ok(webviewSource.includes('<input id="alarmDate"') && webviewSource.includes('<input id="alarmTime"'),
            '...and so are the mobile alarm overlay\'s date and time, which are typed into with the panel in mobile mode')
        // ...and what it may NOT reach, which is the whole of the exemption's risk: a row's own controls. The tick
        // circle of every to-do row is an <input> (input.todo-checkbox) sitting INSIDE the element that carries
        // oncontextmenu, so an exemption written as a bare `input` hands Android's long press a route into
        // onTodoContextMenu's checkbox branch - selection rewritten, openAlarmOverlay re-entered, a typed date
        // discarded - on the one zone of a row that never reaches showNoteContextMenu and so has no belt. Two
        // independent teeth stop it, and each is pinned on what it MEANS rather than on one spelling.
        assert.ok(formatsSource.includes('class="todo-checkbox'),
            'the hazard is real: the tick circle is an <input>, which is why the exemption has to be about text and not about the tag')
        const checkboxRows = formatsSource.split('<div class="todo').slice(1).filter(row => row.includes('class="todo-checkbox'))
        assert.strictEqual(checkboxRows.length, 2, 'two row templates carry a tick circle: the list row and the week card')
        for (const row of checkboxRows){
            assert.ok(row.includes('oncontextmenu=') && row.indexOf('class="todo-checkbox') > row.indexOf('oncontextmenu='),
                '...and it sits INSIDE the element carrying the handler, so an exempted checkbox lets the event bubble straight to that handler')
        }
        const fieldSelector = /var CONTEXTMENU_TEXT_FIELD = '([^']+)'/.exec(webviewSource)
        assert.ok(fieldSelector, 'the exempted kinds must be named once, as a selector of their own')
        for (const part of fieldSelector[1].split(',').map(text => text.trim())){
            if (!/^input\b/.test(part)) continue
            for (const kind of ['checkbox', 'radio']){
                assert.ok(part.includes(':not([type="' + kind + '"])'),
                    `a ${kind} takes no text, raises no Paste bar and (for the checkbox) IS a row's tick circle, nested inside the element that carries the inline handler: the exemption's input branch must exclude it - saw: ${part}`)
            }
        }
        const zoneSelector = /var CONTEXTMENU_HANDLER_ZONE = '([^']+)'/.exec(webviewSource)
        assert.ok(zoneSelector, 'and the handler-carrying zones must be named once too - the second tooth')
        const zones = zoneSelector[1].split(',').map(text => text.trim())
        assert.ok(zones.includes('.todo'),
            'every to-do row, week card and note row is a .todo and every one of them carries an inline oncontextmenu, so no exemption may reach inside one - whatever control a row grows next')
        assert.ok(zones.includes('h2[data-todo-ids]'),
            '...and so does a group heading with ids on it (src/core/html.ts)')
        assert.ok(body.includes('event.preventDefault()'), 'the native callout / selection bar must be cancelled')
        assert.ok(body.includes('event.stopImmediatePropagation()'),
            'and the event must be stopped dead, or preventDefault alone leaves the inline oncontextmenu handlers to run - which IS the bug')
        // ...and the refusal itself stands at the listener's top level, unconditional. That is the SHAPE a
        // zone-scoped rewrite would have to break, asserted positively rather than by forbidding one spelling.
        const indentOf = text => /^\s*/.exec(text)[0].length
        const bodyLines = body.split('\n').filter(text => text.trim())
        const topLevel = indentOf(bodyLines.find(text => text.includes('if (!IS_MOBILE) return')))
        for (const call of ['event.preventDefault()', 'event.stopImmediatePropagation()']){
            assert.strictEqual(indentOf(bodyLines.find(text => text.includes(call))), topLevel,
                `${call} must stand at the listener's top level, on every event the exemption did not return on - nested in a branch it would be scoped all over again`)
        }
        assert.ok(body.includes("traceGesture('contextmenu-suppressed:"),
            'a suppressed contextmenu must say so in the trace, with the zone it landed in - the device round had no way to see this happening')
        assert.strictEqual((body.match(/traceGesture\(/g) || []).length, 1, 'and exactly once per event, or one long press would flood the strip')
        // The zone word is the adapter's vocabulary, not an approximation of it: a bare h2 carries no handler and
        // a .todo is a to-do row OR a note row (.todo.-note, formats.ts), which open different menus. A strip read
        // literally on a device is worth only as much as the words on it.
        const zoneWord = handlerBody('contextmenuZone')
        for (const [selector, word] of [['.todo[data-todo-id]', "'row'"], ['.todo[data-note-id]', "'note'"], ['h2[data-todo-ids]', "'heading'"]]){
            assert.ok(zoneWord.includes(`closest('${selector}')`), `the zone word must be told apart by ${selector}`)
            assert.ok(zoneWord.includes(`return ${word}`), `...and must be able to read ${word}`)
        }
        assert.ok(zoneWord.includes("return 'other'"), 'and everything else - the list, the body, the suggestion list - is other')

        // Second: the belt to those braces, inside the menu itself. A gesture that owns the finger - armed behind
        // the menu the fire opened, or lifted - blocks every other route into showNoteContextMenu.
        const show = handlerBody('showNoteContextMenu')
        assert.ok(show.includes("if (touchDrag.active){ traceGesture('menu-blocked'); return }"),
            'a live touch gesture must block any other opener of the context menu, and say so in the trace')
        assert.ok(show.indexOf('touchDrag.active') < show.indexOf('hideNoteContextMenu()'),
            '...and block it BEFORE hideNoteContextMenu runs: a blocked call that closed the open menu on its way out is the other half of the reported symptom ("the menu vanishes")')
        // What makes `touchDrag.active` a SUFFICIENT guard is the fire's order, so the order is pinned here too,
        // from the other side: the adapter's own call reaches the menu while the flag is still false, and every
        // later one - a native contextmenu that got past the capture listener, a stray handler - finds it true.
        const fire = handlerBody('onLongPressFire')
        assert.ok(fire.indexOf('onTodoContextMenu(ev') < fire.indexOf('armTouchDrag()'),
            'the fire must open the menu BEFORE it arms the drag, or the guard above would block the adapter\'s own menu and the hold would open nothing at all')
        assert.ok(!handlerBody('armTouchDrag').includes('showNoteContextMenu'), 'and the arm must open no menu of its own')
        // The lift still closes the menu itself, and gains nothing else: the suppression is what keeps it closed.
        assert.strictEqual((handlerBody('liftTouchDrag').match(/hideNoteContextMenu\(\)/g) || []).length, 1,
            'the lift closes the menu exactly once, and nothing was added beside it')
    })

    await test('webview touch drag: the lift is measured from the FIRE point, past a threshold of its own', () => {
        // THE THIRD PIXEL ROUND'S FIX, in one place. The old decision came from the PRESS point with the PRESS's
        // own 10px slop, and the long press cancels beyond exactly 10px from exactly that point - so the two gates
        // were the same number from the same origin and an armed gesture was born one pixel from its own lift. Any
        // drift after the menu opened lifted the row at once, closing the menu in the frame after it appeared
        // ("the context menu doesn't appear at all") and dimming the row under a finger that had asked for nothing
        // ("it is moving a little straight away"). Two halves, and both are pinned: the ORIGIN and the THRESHOLD.
        const move = handlerBody('onTouchDragMove')
        assert.ok(move.includes('window.TouchDrag.liftDecision(touchDrag.x - touchDrag.startX, touchDrag.y - touchDrag.startY, TOUCH_DRAG_LIFT_PX)'),
            'the decision must come from the shared module, measured from the arm origin with the LIFT threshold - never with TOUCH_DRAG_SLOP')
        assert.ok(!move.includes('TOUCH_DRAG_SLOP'), 'the press\'s own slop has no business in the lift decision')
        // ...and the arm origin is the FIRE point - where the finger was when the menu opened - which the adapter
        // keeps in lastX/lastY precisely because the fire has no event of its own to read.
        const arm = handlerBody('armTouchDrag')
        assert.ok(/touchDrag\.startX = touchDrag\.x = longPress\.lastX/.test(arm) && /touchDrag\.startY = touchDrag\.y = longPress\.lastY/.test(arm),
            'the drag must arm from the fire point (longPress.lastX/lastY), not from the press point (longPress.x/y)')
        assert.ok(/longPress\.lastX = event\.clientX; longPress\.lastY = event\.clientY/.test(webviewSource),
            'and every move the press survives must keep that fire point up to date')
        assert.ok(/longPress\.x = longPress\.lastX = event\.clientX; longPress\.y = longPress\.lastY = event\.clientY/.test(webviewSource),
            '...starting from the press point itself, so a hold that never moves still arms from where the finger is')
        // The press's OWN gate is untouched and still reads the press point: it asks how far the whole press has
        // wandered, which is a different question from where the finger has got to.
        assert.ok(/Math\.abs\(event\.clientX - longPress\.x\) > 10 \|\| Math\.abs\(event\.clientY - longPress\.y\) > 10\) cancelLongPress\(\)/.test(webviewSource),
            'the long press must still cancel on 10px from the PRESS point')
        assert.ok(/if \(!decision\) return/.test(move), 'inside the threshold nothing happens at all - the gesture is still only the open menu')
        assert.ok(/if \(decision === 'sideways'\)\{ endTouchDrag\('sideways'\); return \}/.test(move),
            'a sideways first move must tear the arming down through the one end, and do nothing else whatsoever')
        assert.ok(move.includes('liftTouchDrag()'), 'a vertical first move must lift the row')
        assert.ok(move.indexOf("endTouchDrag('sideways')") < move.indexOf('liftTouchDrag()'),
            'and the sideways bail must be tested first, or a sideways move would fall straight through into the lift')
        // The lift is where everything the armed state refused to do happens, in one place - including closing the
        // menu, which is done by the gesture taking the finger over rather than by the one end (see below).
        const lift = handlerBody('liftTouchDrag')
        assert.ok(lift.includes('hideNoteContextMenu()'), 'the lift must close the menu the press opened, before any target is resolved under it')
        assert.ok(lift.includes("['dialogGuard', true]") && lift.includes('touchDrag.guarded = true'),
            'the lift is where the refresh guard is taken, and where `guarded` starts saying so')
        assert.ok(!handlerBody('endTouchDrag').includes('NoteContextMenu'),
            'the one end must never touch the context menu: it also ends the gestures whose whole point is that the menu stays')
    })

    await test('webview touch drag: the lift respects the selection instead of collapsing it, and moves the whole of it', () => {
        // F2 OF THE THIRD PIXEL ROUND. The old lift ran `selectedRowIDs.clear(); add(id)` on EVERY lift, and the
        // lift fired on nearly every hold - so a hold left a row painted `-selected` that the user had not
        // selected and nothing took back. The rule is now onTodoDragStart's, verbatim: a drag from a row OUTSIDE
        // the selection makes that row the selection; a drag from a row INSIDE it sweeps the whole set untouched.
        const lift = handlerBody('liftTouchDrag')
        assert.ok(/if \(!selectedRowIDs\.has\(touchDrag\.id\)\)\{[\s\S]*?selectedRowIDs\.clear\(\)[\s\S]*?selectedRowIDs\.add\(touchDrag\.id\)/.test(lift),
            'the lift may only rewrite the selection when the pressed row is NOT in it')
        assert.strictEqual((lift.match(/selectedRowIDs\.clear\(\)/g) || []).length, 1,
            '...and exactly once, inside that guard: an unconditional clear is the bug being fixed')
        // VERBATIM is a claim about what is NOT written as much as about what is. lastClickedRowID and
        // lastSelectionInteractionID are the anchors a CLICK maintains for a Shift range; no drag of either kind
        // touches them, and a lift that did would be a second selection mechanism wearing the first one's name.
        for (const anchor of ['lastClickedRowID', 'lastSelectionInteractionID']){
            const written = new RegExp(anchor + '\\s*=[^=]')
            assert.strictEqual(written.test(lift), false, `the lift must not write ${anchor} - the desktop dragstart does not`)
            assert.strictEqual(written.test(handlerBody('onTodoDragStart')), false, `...and this pin is only honest while onTodoDragStart does not either (${anchor})`)
        }
        // The desktop dragstart is the reference, so the two are compared here rather than described twice.
        const dragStart = handlerBody('onTodoDragStart')
        assert.ok(/if \(!selectedRowIDs\.has\(todoID\)\)\{/.test(dragStart), 'the desktop dragstart is the semantics being mirrored')
        assert.ok(lift.includes('touchDrag.ids = schedulableSelection()') && dragStart.includes('schedulableSelection()'),
            'both gestures take the payload from schedulableSelection() - the to-dos within the selection, in its own order')
        // The whole selection is what MOVES, and it must look like it: every payload row dims, exactly as the
        // desktop dragstart dims them, and the banner names the count rather than one of the titles.
        assert.ok(/var dragged = new Set\(touchDrag\.ids\)/.test(lift) && /dragged\.has\(draggedRow\.dataset\.todoId\)\) draggedRow\.classList\.add\('-dragging'\)/.test(lift),
            'every row in the payload must dim, not only the one under the finger')
        assert.ok(/touchDrag\.ids\.length > 1 \? \(touchDrag\.ids\.length \+ ' to-dos'\) : rowLabel\(touchDrag\.row\)/.test(lift),
            'a multi-row drag must name the COUNT in the banner; a single row keeps its title')
        assert.ok(lift.includes('showDragBanner('), 'the lift is what shows the rows are up')
        // ...and the one end undims all of them again, or a row left dim reads as still in flight.
        const end = handlerBody('endTouchDrag')
        assert.ok(/for \(var undim of allTodoRows\(\)\) undim\.classList\.remove\('-dragging'\)/.test(end),
            'the one end must undim every row, not only the pressed one')
        // The DROP clears the selection, because the desktop drop paths do - and only because they do.
        for (const name of ['dropTouchDrag', 'onTodoDropped', 'onBetweenDrop']){
            assert.ok(handlerBody(name).includes('selectedRowIDs.clear()'), `${name} clears the selection after a drop, like every other drop path`)
        }
        // ...but nothing else in the touch gesture touches it. The arm takes nothing, and the ends that took
        // nothing give nothing back: a hold-and-release, a sideways swipe and a cancel must leave the selection
        // exactly as they found it.
        assert.ok(!handlerBody('armTouchDrag').includes('selectedRowIDs'), 'the arm must not touch the selection')
        assert.ok(!handlerBody('endTouchDrag').includes('selectedRowIDs'), 'and neither may the one end')
    })

    await test('webview touch drag: the touchmove listener is NON-PASSIVE, and prevents the pan from the ARM', () => {
        // A document-level touchmove listener is passive by default in Chrome, and a passive listener's
        // preventDefault() does nothing at all - so this option is the whole gesture on Android.
        assert.ok(/addEventListener\('touchmove', onTouchDragMove, \{ passive: false, capture: true \}\)/.test(webviewSource),
            'the drag touchmove listener must be registered non-passive (and capturing)')
        // ...and removed with the SAME options, or removeEventListener does not match it and the listener - which
        // preventDefaults every touchmove - outlives the drag and kills the list's scrolling for good.
        assert.ok(/removeEventListener\('touchmove', onTouchDragMove, \{ passive: false, capture: true \}\)/.test(webviewSource),
            'the same listener must be removed with matching options')
        const move = handlerBody('onTouchDragMove')
        // ONE preventDefault, unguarded, before anything else the handler does. The earlier design guarded it on
        // `touchDrag.lifted` so a sideways stroke would reach Android whole; the price was that the list panned
        // under a HELD finger, which drags every row out from under the menu the fire just opened, fires the
        // document scroll listener that used to close it, and reads as the row already moving - two of the third
        // Pixel round's four reports. The sideways rule survives because Joplin's side-menu responder is native:
        // this document's preventDefault cancels this document's default (the pan) and nothing beyond it.
        assert.strictEqual((move.match(/event\.preventDefault\(\)/g) || []).length, 1,
            'there must be exactly ONE preventDefault: an armed gesture prevents the pan just as a lifted one does')
        assert.ok(!/if \(touchDrag\.lifted\) event\.preventDefault\(\)/.test(move),
            'and it must not be guarded by the lifted flag - that guard IS the un-prevented pre-lift pan')
        const prevent = move.indexOf('event.preventDefault()')
        assert.ok(prevent < move.indexOf('touches.length !== 1'),
            'it must come before the two-finger bail, so even the frame that ends the gesture does not let the list pan')
        assert.ok(prevent < move.indexOf('liftDecision'), '...and before the decision, which is about direction, not about who owns the finger')
        assert.ok(move.indexOf('if (!touchDrag.active) return') < prevent,
            'the one thing it must come after is the not-active guard: a document with no gesture in flight prevents nothing')
        // A preventDefault() on a non-cancelable move is a silent no-op, which is how Chromium reports that it
        // decided the touch sequence's blocking region before this listener existed. Traced at the lift, because
        // that is the first move whose loss the user would actually see - and because it is the only thing that
        // tells 18b's "the list panned under the lifted row" apart from "the list twitched inside the tolerance".
        assert.ok(move.includes("if (!event.cancelable) traceGesture('drag-uncancelable')"),
            'a lifting move that arrives non-cancelable must say so in the trace')
        assert.ok(move.indexOf('drag-uncancelable') < move.indexOf('liftTouchDrag()'),
            '...before the lift it is about to make pointless')
    })

    await test('webview touch drag: a stale gesture is cleared by the next press that begins alone', () => {
        // THE OTHER ROUTE TO "the context menu doesn't appear at all", and it has nothing to do with the lift.
        // showNoteContextMenu turns every opener away while a gesture is active, so a gesture whose pointerup was
        // lost swallows every menu until the 15s watchdog. The reset must NOT be written as a pointer id
        // comparison: Blink hands every touch point a fresh id, so `event.pointerId === touchDrag.pointerId` is
        // never true for the ordinary "one finger presses twice" and the reset would be dead code on the device.
        // What it is written on is isPrimary - a press that begins with no other finger down, which an unfinished
        // gesture cannot be joined by - and that is a property of the event, not a guess about the platform.
        assert.ok(/if \(touchDrag\.active && event\.isPrimary\) endTouchDrag\('stale-pointer'\)/.test(webviewSource),
            'the adapter\'s pointerdown must end a stale gesture on the next press that begins alone')
        assert.strictEqual(/event\.pointerId === touchDrag\.pointerId\) endTouchDrag\('stale-pointer'\)/.test(webviewSource), false,
            '...and never on a pointer id the platform does not reuse, which would never fire')
        const adapterStart = webviewSource.indexOf('longPress.fired = false')
        const reset = webviewSource.indexOf("endTouchDrag('stale-pointer')", adapterStart)
        const zoneGate = webviewSource.indexOf("if (!kind) return", adapterStart)
        assert.ok(reset > adapterStart && reset < zoneGate,
            '...before the zone check can early-return, so a press on an unrecognised zone still clears the stale state')
        assert.ok(webviewSource.indexOf('longPress.timer = setTimeout(onLongPressFire', adapterStart) > reset,
            '...and before the timer that would fire into it')
        // It goes through the ONE end, so the stale gesture's refresh guard comes down with it rather than leaking.
        assert.ok(/endTouchDrag\('stale-pointer'\)/.test(webviewSource) && handlerBody('endTouchDrag').includes("['dialogGuard', false]"),
            'and through the single end, so a leaked guard cannot survive the reset')
        // The second-pointer listener keeps its own job: a DIFFERENT finger is a different situation (the press
        // that finger armed goes with it), and the two must not be collapsed into one.
        assert.ok(/if \(!touchDrag\.active \|\| event\.pointerId === touchDrag\.pointerId\) return\s*\n\s*cancelLongPress\(\)\s*\n\s*endTouchDrag\('second-pointer'\)/.test(webviewSource),
            'a genuine second finger still ends the gesture as a second finger, and takes its own pending press with it')
        // ...and the ORDER of the two listeners is what keeps a fresh press alive: the adapter's pointerdown is
        // registered first, so on a primary press it has already cleared `active` and the second-pointer listener
        // returns at its own guard instead of cancelling the long press that press just started. Registered the
        // other way round, the reset above would fix the menu and the cancel below would take it away again.
        assert.ok(webviewSource.indexOf("endTouchDrag('stale-pointer')") < webviewSource.indexOf("endTouchDrag('second-pointer')"),
            'the stale reset must be registered before the second-pointer listener, or it cancels the press it just rescued')
    })

    await test('webview touch drag: endTouchDrag is ONE end that cannot return before releasing the refresh guard', () => {
        // A leaked ['dialogGuard', true] freezes every mobile refresh for the life of the webview, so the shape
        // pinned here is "no way out without the release": exactly one return, and it is the not-active guard on
        // the first line, before anything has been taken down. The statement ORDER of the teardown is not pinned -
        // nothing depends on it - but the absence of a second exit is.
        const end = handlerBody('endTouchDrag')
        assert.ok(/^function endTouchDrag\(reason\)\{\s*if \(!touchDrag\.active\) return\b/.test(end),
            'the only early return must be the not-active guard, on the first line')
        assert.strictEqual((end.match(/\breturn\b/g) || []).length, 1,
            'endTouchDrag must have no other return: every exit path has to reach the guard release')
        assert.ok(end.includes("['dialogGuard', false]"), 'endTouchDrag must release the refresh guard')
        assert.ok(end.includes('touchDrag.guarded'), 'and only when the drag actually took it (an unmatched false would decrement someone else\'s guard)')
        // Everything the gesture put up comes down here too, so no exit can leave the panel dressed for a drag.
        assert.ok(end.includes('edgeAutoscrollStop()'), 'ending the drag must stop the scroll loop')
        assert.ok(end.includes('clearBetweenIndicator()'), 'ending the drag must clear the insertion line')
        assert.ok(end.includes('paintDropTargetHighlight(null)'), 'ending the drag must clear the whole-row highlight')
        assert.ok(end.includes("classList.remove('-dragging')"), 'ending the drag must undim the lifted row')
        assert.ok(end.includes('hideDragBanner()'), 'ending the drag must take the banner down')
        assert.ok(end.includes('clearTimeout(touchDrag.watchdog)'), 'ending the drag must cancel its own watchdog')
    })

    await test('webview touch drag: EVERY exit routes through that one end - cancel, second finger, hide, rotate, watchdog', () => {
        // The exits are the call sites, and they all call the one function rather than tearing down by hand:
        // that is what makes "every exit path releases the guard" a property of the shape above.
        for (const [pattern, why] of [
            [/pointercancel[\s\S]{0,220}endTouchDrag\('pointercancel'\)/, 'a pointercancel must end the drag'],
            [/pointerdown[\s\S]{0,320}endTouchDrag\('second-pointer'\)/, 'a second finger must end the drag'],
            [/visibilitychange[\s\S]{0,120}endTouchDrag\('hidden'\)/, 'the app going to the background must end the drag'],
            [/'resize'[\s\S]{0,80}endTouchDrag\('resize'\)/, 'a resize must end the drag'],
            [/'orientationchange'[\s\S]{0,80}endTouchDrag\('orientation'\)/, 'a rotation must end the drag'],
            [/setTimeout\(function\(\)\{ endTouchDrag\('watchdog'\) \}, TOUCH_DRAG_WATCHDOG_MS\)/, 'the watchdog must end the drag'],
            [/endTouchDrag\(landed \? 'dropped' : 'no-target'\)/, 'a release over nothing must end the drag as well as a drop'],
            [/endTouchDrag\('multi-touch'\)/, 'a second finger arriving mid-move must end the drag'],
            // The two ends an ARMED gesture has of its own: a finger that came up without travelling, and a first
            // move that went sideways. Both took nothing, and both must still unwind through the same one end -
            // that is what takes the touchmove listener, the pointer capture and the watchdog back off.
            [/endTouchDrag\('released'\)/, 'a release that never moved must tear the arming down'],
            [/endTouchDrag\('sideways'\)/, 'a sideways first move must tear the arming down'],
        ]) assert.ok(pattern.test(webviewSource), why)
        // ...and the lifted flag is written in exactly three places, or a torn-down gesture could leave a handler
        // still thinking the row is up: the arm starts a gesture that is not lifted, the lift raises it, the one
        // end lowers it. Nothing else may touch it.
        assert.strictEqual((webviewSource.match(/touchDrag\.lifted = false/g) || []).length, 2,
            'the lifted flag is lowered in two places only: the arm that initialises the gesture, and the one end')
        assert.ok(handlerBody('armTouchDrag').includes('touchDrag.lifted = false'), 'the arm must start a gesture that is not lifted')
        assert.ok(handlerBody('endTouchDrag').includes('touchDrag.lifted = false'), 'and the one end must lower it again')
        assert.strictEqual((webviewSource.match(/touchDrag\.lifted = true/g) || []).length, 1,
            'and only one place raises it')
        assert.ok(handlerBody('liftTouchDrag').includes('touchDrag.lifted = true'), '...the lift itself')
        // ...and nothing else lowers the flag behind its back.
        assert.strictEqual((webviewSource.match(/touchDrag\.active = false/g) || []).length, 1,
            'only endTouchDrag may clear the active flag')
    })

    await test('webview touch drag: the drop message is posted BEFORE the guard release, never after', () => {
        // The host answers the last guard coming down with a repaint of its own (panel.ts), and a mobile repaint
        // is a full webview reload - so releasing first would reload once for the release and again for the
        // write, a visible double flash around every drop.
        const drop = handlerBody('dropTouchDrag')
        assert.ok(drop.includes("['todosDroppedBetween', ids, neighbours.prevId, neighbours.nextId, target.groupDate, target.groupEndDate]"),
            'a gap drop must post the same message shape the desktop drop posts')
        assert.ok(drop.includes("['todosDropped', ids, target.el.dataset.drop]"), 'a whole-row drop must post the same message the desktop drop posts')
        assert.ok(drop.indexOf("'todosDroppedBetween'") < drop.indexOf('endTouchDrag('), 'the between message must be posted before the drag is ended')
        assert.ok(drop.indexOf("'todosDropped'") < drop.indexOf('endTouchDrag('), 'the date message must be posted before the drag is ended')
        assert.ok(!drop.includes('dialogGuard'), 'the drop must not release the guard itself - that belongs to the one end, after the message')
        // The guard is taken at the LIFT rather than at the arm, so the two gestures that end with the menu still
        // open - a release that never moved, and a sideways first move - never touch it: the host's repaint on the
        // release would otherwise reload the webview out from under the very menu the press had just opened.
        assert.ok(!handlerBody('armTouchDrag').includes('dialogGuard'), 'the arm must not take the guard')
        assert.ok(handlerBody('liftTouchDrag').includes("['dialogGuard', true]"), 'the lift must take it')
    })

    await test('webview touch drag: the GEOMETRY is authoritative for a gap, and nothing floating over the list may veto it', () => {
        // F3 OF THE THIRD PIXEL ROUND: "moving one note doesn't land between other notes, only on headings".
        // elementFromPoint is asked exactly two questions - is there a [data-drop] here, is there an h2 here - and
        // its answer to anything else is not consulted at all. On a phone the banner, the trace strip, a menu and
        // the dragged row itself all sit over the rows; a resolution that let any of them stand between the finger
        // and the index would refuse the gaps and keep only the big targets, which is exactly the report.
        const resolve = handlerBody('resolveDragTarget')
        assert.strictEqual((resolve.match(/elementFromPoint/g) || []).length, 1, 'the DOM is asked where the finger is exactly once')
        assert.strictEqual((resolve.match(/under\.closest\(/g) || []).length, 2,
            'and exactly two questions are asked of what it returned: [data-drop], and h2. A third would be a veto.')
        assert.ok(resolve.includes("closest('[data-drop]')"), 'the whole-row targets are the existing [data-drop] elements')
        assert.ok(resolve.indexOf("closest('h2')") > resolve.indexOf("closest('[data-drop]')"),
            'the heading question must come AFTER [data-drop], or the headings that DO accept drops would be refused too')
        assert.ok(resolve.indexOf('elementFromPoint') < resolve.indexOf('rowEntryAtY'),
            'the whole-row targets must be resolved before the gaps, or a heading would read as the gap above it')
        // ...and the rows themselves come from the pure module against the index, never from elementFromPoint.
        assert.ok(handlerBody('rowEntryAtY').includes('window.TouchDrag.rowAtY(touchDrag.index'), 'the row must be found geometrically, in the index')
        assert.ok(resolve.includes('window.TouchDrag.bandSide('), 'and its side by the shared band rule')
        // EVERY refusal is named. A bare `none` is what made the second strip unable to say why a gap drop did
        // nothing on the phone while the same drop passed in the mobile-mode e2e.
        for (const reason of ['outside', 'refused-heading', 'no-row', 'no-info', 'both-null']){
            assert.ok(resolve.includes(`dragTargetNone('${reason}')`), `the refusal '${reason}' must be named where it is decided`)
        }
        assert.strictEqual((resolve.match(/return null/g) || []).length, 0, 'no refusal may leave without saying which one it was')
        assert.ok(/function dragTargetNone\(reason\)\{\s*return \{ kind: 'none', reason: reason \}/.test(webviewSource),
            'a refusal is a resolved answer of its own kind, not the absence of one')
        // The rules those five names stand for are unchanged, and still pinned as rules rather than as spellings.
        assert.ok(/info\.groupDate == null/.test(resolve), 'both-null must stay limited to a DATELESS group (a dated one spans its own day)')
        assert.ok(/!neighbours\.prevId && !neighbours\.nextId\) return dragTargetNone\('both-null'\)/.test(resolve),
            'both neighbours absent in a dateless group is not a target: betweenBounds can form no interval from it')
        assert.ok(/touchDrag\.y < box\.top \|\| touchDrag\.y >= box\.bottom\) return dragTargetNone\('outside'\)/.test(resolve),
            "'outside' is the finger leaving the .todos rect - the release the banner offers as a cancel")
        // Two refusals for different reasons are two different answers, or the strip would show only the first.
        assert.ok(/if \(a\.kind === 'none'\) return a\.reason === b\.reason/.test(handlerBody('sameDragTarget')),
            'a change of refusal must re-trace and re-label, not read as "the same nothing"')
        // The banner and the trace strip are pointer-events:none besides, so they never even reach the first
        // question - belt and braces, since the resolution above already cannot be vetoed by them.
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        for (const selector of ['#cockpitDragBanner', '#cockpitToast']){
            const at = css.indexOf(selector + ' {')
            assert.ok(at >= 0, `panel.css is missing the ${selector} rule`)
            const rule = css.slice(at, css.indexOf('}', at))
            assert.ok(/pointer-events:\s*none/.test(rule), `${selector} floats over the list and must never take the finger the drag needs`)
        }
    })

    await test('webview touch drag: the index is verified against the screen before a gap is read off it', () => {
        // The shift in syncRowIndex is exact for a SCROLL and for nothing else, and a mobile panel has other ways
        // to move a row: a re-render between two frames, a group folding, the soft keyboard. A shifted-but-wrong
        // index is this gesture's worst failure because it is SILENT - the line paints somewhere plausible and the
        // drop writes the neighbours of a row the finger was never over.
        const at = handlerBody('rowEntryAtY')
        assert.ok(at.includes('rowIndexIsStale(entry)') && at.includes('buildRowIndex()'),
            'a stale index must be rebuilt on demand, and the search re-run against it')
        const stale = handlerBody('rowIndexIsStale')
        assert.ok(/Math\.abs\(entry\.el\.getBoundingClientRect\(\)\.top - entry\.top\) > ROW_INDEX_TOLERANCE_PX/.test(stale),
            'the check is the CANDIDATE row\'s live box against the one the index holds for it')
        assert.ok(stale.includes('!entry.el.isConnected'), 'a row that has left the document is stale by definition')
        // ...and it is the candidate ALONE. A rebuild is a rect plus a walk to the heading for every row in the
        // list, on every move, on the device - which is the cost the shift exists to avoid.
        assert.strictEqual((stale.match(/getBoundingClientRect/g) || []).length, 1, 'exactly one rect is measured per lookup')
        // With no candidate there is no row to check, so the cheap question asked instead is whether the LIST is
        // still the one that was measured - which keeps a finger parked below the last row from rebuilding the
        // index on every frame, while a re-render that added or removed rows still forces the rebuild it needs.
        assert.ok(/if \(!entry\) return document\.querySelectorAll\('\.todo\[data-todo-id\]'\)\.length !== touchDrag\.indexRows/.test(stale),
            'a no-candidate lookup must re-ask the row COUNT, not rebuild blindly')
        assert.ok(handlerBody('buildRowIndex').includes("touchDrag.indexRows = document.querySelectorAll('.todo[data-todo-id]').length"),
            'and the build must record the live count it was measured against')
        assert.ok(/var ROW_INDEX_TOLERANCE_PX = 2/.test(webviewSource), 'the tolerance must be a named, tunable constant')
    })

    await test('webview touch drag: the row index skips the peek, and every scroll shifts it', () => {
        const build = handlerBody('buildRowIndex')
        assert.ok(build.includes("closest('.outside-results')"), 'the read-only peek is not a target of any kind')
        assert.ok(build.includes('getBoundingClientRect()'), 'the index holds the rows\' live boxes')
        assert.ok(build.includes('betweenGroupInfo(row)'), 'each row carries the eligibility the desktop drop already resolves')
        assert.ok(build.includes('touchDrag.indexTop = scroller ? scroller.scrollTop : 0'),
            'the index must record the scroll position it was measured at, so a later scroll can shift it')
        // The rows move under a finger that is holding still, which is the whole auto-scroll gesture. A scroll moves
        // every row by the same delta and changes nothing else about them, so the boxes are shifted, not re-measured:
        // a rebuild is a getBoundingClientRect() plus a walk to the heading per row, on every frame, on the device.
        const sync = handlerBody('syncRowIndex')
        assert.ok(/delta = scroller\.scrollTop - touchDrag\.indexTop/.test(sync), 'the shift is the list\'s own scroll delta')
        assert.ok(/entry\.top -= delta; entry\.bottom -= delta/.test(sync), 'and it moves every box by exactly that')
        assert.ok(/if \(!delta\) return false/.test(sync), 'a scroll that moved nothing must cost nothing')
        const scrolled = handlerBody('onTouchDragScrolled')
        assert.ok(scrolled.includes('syncRowIndex()'), 'a scrolled frame must re-sync the index - the boxes have all moved')
        assert.ok(scrolled.includes('updateDragTarget()'), '...and re-resolve what the finger is now over')
        // ...and so must a scroll the drag did not ask for: if the list pans out from under a lifted row without the
        // gesture being taken away, an unsynced index would write neighbours from rows that have scrolled off.
        assert.ok(/addEventListener\('scroll', function\(\)\{\s*if \(!touchDrag\.active\) return[\s\S]{0,700}if \(syncRowIndex\(\) && touchDrag\.lifted\) updateDragTarget\(\)\s*\}, true\)/.test(webviewSource),
            'any scroll under a live gesture must re-sync the index - and only a LIFTED one has a target to re-resolve or anything to paint')
        // ...and re-aim at the same point, or the helper's idle watchdog stops the list after 800ms: a still
        // FINGER sends no touchmove at all, and holding still at the edge is the entire gesture.
        assert.ok(scrolled.includes('edgeAutoscrollUpdate('), 'a scrolled frame must re-aim the loop, or a still finger would stop it')
        assert.ok(handlerBody('onTouchDragMove').includes('edgeAutoscrollUpdate(touchDragScroller(), touchDrag.x, touchDrag.y, onTouchDragScrolled)'),
            'the touch drag must feed the SHARED edge auto-scroll helper, not a second copy of the band maths')
        assert.ok(/function touchDragScroller\(\)\{\s*return currentTodosEl \|\| document\.querySelector\('\.todos'\)/.test(webviewSource),
            'and the index, the shift and the auto-scroll must all mean the same scroller')
    })

    await test('webview touch drag: the two bands are named constants - 0.5 on touch, the desktop 0.4 untouched', () => {
        assert.ok(/var TOUCH_DRAG_BAND = 0\.5/.test(webviewSource), 'the touch band must be a named constant of its own, and 0.5 (no inert middle)')
        assert.ok(/var BETWEEN_BAND = 0\.4/.test(webviewSource), 'the desktop band must still be 0.4, with its inert middle')
        assert.ok(/var TOUCH_DRAG_SLOP = 10/.test(webviewSource), 'the press slop must match the long press it lifts out of')
        assert.ok(/var TOUCH_DRAG_LIFT_PX = 20/.test(webviewSource), 'the lift threshold must be a named constant of its own')
        assert.ok(/var TOUCH_DRAG_WATCHDOG_MS = \d+/.test(webviewSource), 'the watchdog must be a named, tunable constant')
        // THE RELATION, not just the two numbers. The press survives 10px from the press point; if the lift used
        // that same number from that same origin the arm would be born at the edge of its own threshold, which is
        // the arithmetic behind two of the third Pixel round's four reports. BIGGER is the property that is pinned;
        // the 20 itself is a taste, and a modest one because Android's own drag - the round's real cause - is gone.
        const slop = Number(/var TOUCH_DRAG_SLOP = (\d+)/.exec(webviewSource)[1])
        const liftPx = Number(/var TOUCH_DRAG_LIFT_PX = (\d+)/.exec(webviewSource)[1])
        assert.ok(liftPx > slop, 'the lift threshold must be LARGER than the slop the press survives on, or the drag decides before the user has')
        assert.ok(webviewSource.indexOf('var TOUCH_DRAG_LIFT_PX') > webviewSource.indexOf('var TOUCH_DRAG_SLOP'),
            'and the two must stay side by side, where the relation between them is readable')
    })

    await test('webview selection: a touch changes the selection only through the shared rules, and the drag adds no path of its own', () => {
        // WHAT MAIN'S SEMANTICS ARE, pinned so the touch drag cannot quietly become a second selection mechanism.
        // A row carries onmousedown and onclick and no touch handler at all (src/core/formats.ts), so on a phone
        // the selection can only ever be reached through the browser's compatibility mouse events - and both of
        // those hand the decision to the shared, DOM-free window.RowSelection. Shift and Ctrl are unreachable from
        // a finger, so pressSelection can only return the pressed row alone or PRESERVE an existing multi-set.
        assert.deepStrictEqual(RowSelection.pressSelection({ selected: [rowId('a')], lastClicked: null, lastInteraction: null },
            rowId('b'), {}, [rowId('a'), rowId('b')]).selected, [rowId('b')],
            'a plain press on another row replaces the selection - a touch cannot accumulate one through this path')
        assert.deepStrictEqual(RowSelection.pressSelection({ selected: [rowId('a'), rowId('b')], lastClicked: null, lastInteraction: null },
            rowId('a'), {}, [rowId('a'), rowId('b')]).selected, [rowId('a'), rowId('b')],
            '...but a press INSIDE a multi-selection preserves it, which is the rule the drag inherits')
        assert.deepStrictEqual(RowSelection.clickSelection({ selected: [rowId('a'), rowId('b')], lastClicked: null }, rowId('a')).selected,
            [rowId('a')], 'and a plain click collapses onto the clicked row')
        for (const name of ['onRowPressed', 'onRowClicked']){
            assert.ok(handlerBody(name).includes('window.RowSelection.'), `${name} must keep handing the decision to the shared rules`)
        }
        // ...and the touch layer writes the selection in exactly ONE place: the lift, under the dragstart guard.
        // The arm, the move, the ends and the resolution must not touch it at all.
        for (const name of ['armTouchDrag', 'onTouchDragMove', 'endTouchDrag', 'resolveDragTarget', 'updateDragTarget']){
            assert.ok(!handlerBody(name).includes('selectedRowIDs'), `${name} must not touch the selection`)
        }
        // The two codes that can settle what a phone actually delivers here. Whether the compatibility mouse
        // events arrive at all after a long press is a platform behaviour this repo cannot read off its own
        // source, and the third Pixel round reported a selection that grows as the user taps around - so the
        // strip has to be able to say whether these handlers ever ran, and what the size was after each.
        assert.ok(handlerBody('onRowPressed').includes("if (IS_MOBILE) traceGesture('row-press:' + traceId(rowID) + ' n=' + selectedRowIDs.size)"),
            'a mobile press must say so on the strip, with the resulting selection size')
        assert.ok(handlerBody('onRowClicked').includes("if (IS_MOBILE) traceGesture('row-click:' + traceId(rowID) + ' n=' + selectedRowIDs.size)"),
            '...and so must a mobile click, so a hold followed by two taps reads as three lines')
    })

    await test('webview touch drag: the desktop HTML5 handlers keep their IS_MOBILE gates', () => {
        // The touch gesture is an ADDITION: nothing about the desktop drag moved, and the mobile early-returns
        // that were there before this feature are still there. They are not decoration: Android DOES fire an
        // HTML5 drag (see the block below), so every one of these is a live gate rather than a dead one.
        assert.ok(/function onBetweenDragOver\(event\)\{\s*if \(IS_MOBILE \|\| !isPanelDragEvent\(event\)\) return/.test(webviewSource), 'onBetweenDragOver stays desktop-gated')
        assert.ok(/async function onBetweenDrop\(event\)\{\s*if \(IS_MOBILE\) return/.test(webviewSource), 'onBetweenDrop stays desktop-gated')
        assert.ok(/function onDragAutoscroll\(event\)\{\s*if \(IS_MOBILE \|\| !isPanelDragEvent\(event\)\) return/.test(webviewSource), 'onDragAutoscroll stays desktop-gated')
        assert.ok(/function onPanelDragLeave\(event\)\{\s*if \(IS_MOBILE \|\| !isPanelDragEvent\(event\)\) return/.test(webviewSource), 'onPanelDragLeave stays desktop-gated')
        // The neighbour walk is now shared by both gestures rather than copied into the new one.
        assert.ok(handlerBody('onBetweenDrop').includes('betweenNeighboursAt(target.row, target.before'), 'the desktop drop must use the shared neighbour resolution')
        assert.ok(handlerBody('dropTouchDrag').includes('betweenNeighboursAt(target.row, target.before'), 'and so must the touch drop, so the two cannot disagree about a gap')
    })

    await test('webview touch drag: on mobile no dragstart becomes a drag, whoever started it', () => {
        // The markup gate (a mobile row carries no draggable attribute - pinned in the row-markup block above) is
        // the fix; these are its two belts, and both exist because the failure they prevent is silent. Android
        // starting its own HTML5 drag from a long press cancels the touch sequence, so the panel's 500ms timer
        // never fires and the user sees no menu at all - with nothing on the gesture strip to say why, which is
        // exactly how the third Pixel round's strip read.
        assert.ok(/document\.addEventListener\('dragstart', function\(event\)\{\s*if \(!IS_MOBILE\) return\s*traceGesture\('native-dragstart'\)\s*event\.preventDefault\(\)\s*\}, true\)/.test(webviewSource),
            'a capturing document dragstart listener must cancel every drag on mobile, and name it on the strip')
        // Capture, and at the document: it has to run before any inline ondragstart a row might still carry, and
        // before anything on the way up can stop it.
        const dragStart = handlerBody('onTodoDragStart')
        assert.ok(dragStart.includes("if (IS_MOBILE){ traceGesture('native-dragstart:handler'); return }"),
            'the desktop dragstart handler must refuse to run on mobile, and say so')
        assert.ok(dragStart.indexOf('IS_MOBILE') < dragStart.indexOf('selectedRowIDs'),
            'and it must refuse BEFORE it touches the selection - a native drag that rewrote the selection is half the report')
        assert.ok(dragStart.indexOf('IS_MOBILE') < dragStart.indexOf("classList.add('-dragging')"),
            '...and before it dims anything')
        // The CSS belt, which is what the WebView reads before it decides whether an element can be picked up.
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        assert.ok(/\.cockpit-mobile \.todo \{\s*-webkit-user-drag: none;/.test(css),
            'a mobile row must be -webkit-user-drag:none as well as un-draggable in the markup')
    })

    await test('webview touch drag: the trace falls back to the sticky toast when no suggestion hint is on screen', () => {
        // Every row gesture happens with the suggestion list closed, so a trace written only into that list's
        // hint line was blind to exactly the gesture the device round has to report on.
        const trace = handlerBody('traceGesture')
        assert.ok(trace.includes("querySelector('#searchSuggestions .suggest-hint')"), 'the hint line stays the sink while the list is open')
        assert.ok(/showToast\(text, true\)/.test(trace), 'with no hint line the codes go to the toast in its sticky mode')
        const toast = handlerBody('showToast')
        assert.ok(/function showToast\(text, sticky\)/.test(toast), 'showToast must take a sticky mode')
        assert.ok(toast.includes('if (sticky) return'), 'a sticky toast must not arm the fade timer')
        assert.ok(/GESTURE_TRACE_MAX = 12/.test(webviewSource),
            'the ring must hold a whole drag - arm, retargets (each now naming its refusal), scroll, drop - which is why it grew with the reasons')
        // ...and the drag speaks in codes that name what happened, only when the answer CHANGES.
        for (const code of ['menu-open', "'drag-lift n='", 'drag-uncancelable', "'drag-target:'", "'drag-autoscroll:'", "'drag-drop:between '",
                            "'drag-drop:date '", "'drag-cancel:'", 'drag-released', 'drag-sideways-ignored',
                            // The second Pixel round's three: a contextmenu the panel refused (with the zone it
                            // landed in), a menu opener the live gesture turned away, and the drop path saying
                            // WHAT it wrote rather than only that it wrote something.
                            "'contextmenu-suppressed:'", "'menu-blocked'", "'drag-drop:posted'", "'drag-release:no-target'",
                            // The third round's: every refusal named where it is decided, the stale-gesture reset
                            // that used to silence the menu, and the two codes that can finally say whether a phone
                            // delivers the compatibility mouse events a row's selection depends on.
                            "'drag-target:' + (target.kind === 'none' ? 'none:' + target.reason", "'stale-pointer'",
                            "'row-press:'", "'row-click:'",
                            // ...and the round's root cause: a native HTML5 drag the platform started behind the
                            // gesture's back, which is invisible from inside the panel unless it is named.
                            "'native-dragstart'", "'native-dragstart:handler'"]){
            assert.ok(webviewSource.includes(code), `the trace must carry ${code}`)
        }
        // The drop trace names the write, on both branches, BEFORE the message goes and again once it has: a drop
        // into the wrong gap and a correct drop that was never posted read identically otherwise, and the device
        // round has nothing but this strip to tell them apart.
        const drop = handlerBody('dropTouchDrag')
        assert.ok(drop.includes("traceGesture('drag-drop:between ' + traceId(neighbours.prevId) + '|' + traceId(neighbours.nextId))"),
            'a gap drop must trace the two neighbours it is about to write between')
        assert.ok(drop.includes("traceGesture('drag-drop:date ' + (target.el.dataset.drop || '?'))"),
            'a whole-row drop must trace the date it is about to write')
        assert.strictEqual((drop.match(/traceGesture\('drag-drop:posted'\)/g) || []).length, 2,
            'and each branch must confirm the postMessage returned - one code per branch, and only after the post')
        for (const branch of ["'todosDroppedBetween'", "'todosDropped'"]){
            assert.ok(drop.indexOf('drag-drop:between ') < drop.indexOf(branch) || drop.indexOf('drag-drop:date ') < drop.indexOf(branch),
                `the ${branch} branch must trace what it is writing before it writes it`)
            assert.ok(drop.indexOf(branch) < drop.lastIndexOf("traceGesture('drag-drop:posted')"),
                `...and confirm it after`)
        }
        assert.ok(handlerBody('traceId').includes("String(id).slice(0, 4)"),
            'the ids in that trace are cut short: the whole strip is one line on a phone')
        // The trace is the whole of what the device round can report, and the menu-first gesture's three outcomes
        // have to be told apart in it: the row went up, the finger let go with the menu still open, or the stroke
        // was the side menu's. So none of the three shares the cancel code.
        const end = handlerBody('endTouchDrag')
        assert.ok(end.includes("if (reason === 'released') traceGesture('drag-released')"), 'a release that never moved must trace as itself')
        assert.ok(end.includes("else if (reason === 'sideways') traceGesture('drag-sideways-ignored')"), 'and so must a sideways first move')
        assert.ok(end.includes("else if (reason === 'no-target') traceGesture('drag-release:no-target' + noTargetNote)"),
            'a LIFTED drag released over nothing droppable must read as the user\'s own release, not as one of the platform\'s cancels')
        // ...and it must say WHICH nothing, where the finger was, and how many rows the index held. Five refusals
        // used to read as one bare line, which is why the second strip could not tell "the gap was refused because
        // a sticky heading was under the finger" from "the index no longer described the screen".
        assert.ok(/var noTargetNote = reason !== 'no-target' \? '' :/.test(end), 'the note is built only on the path that says it')
        assert.ok(end.includes("touchDrag.target.kind === 'none') \? touchDrag.target.reason : 'unresolved'"),
            'the reason is the standing refusal, and a release before anything was resolved says so rather than guessing')
        assert.ok(end.includes("' y=' + Math.round(touchDrag.y)") && end.includes("' rows=' + (touchDrag.index ? touchDrag.index.length : 0)"),
            'with the release point and the size of the index it was read against')
        assert.ok(end.indexOf('var noTargetNote') < end.indexOf('touchDrag.active = false'),
            'and it must be read BEFORE the teardown clears the target, the position and the index')
        assert.ok(end.includes("else if (reason !== 'dropped') traceGesture('drag-cancel:' + reason)"), 'everything else is a cancel, and a drop traces its own code')
        assert.strictEqual((end.match(/traceGesture\(/g) || []).length, 4,
            'and every end still speaks exactly once: released, sideways, no-target, or a cancel')
        assert.ok(handlerBody('updateDragTarget').includes('if (sameDragTarget(touchDrag.target, target)){ touchDrag.target = target; return }'),
            'the target trace must fire on a CHANGE only, or one move would flood the whole buffer')
    })

    await test('webview touch drag: a release that never moved tears the arming down and leaves the menu standing', () => {
        // The gesture is speculative in the other direction now: the press has ALREADY opened the menu, and a
        // finger that comes up without travelling simply throws away an arming nobody ever saw.
        assert.ok(/if \(touchDrag\.lifted\)\{ dropTouchDrag\(\); return \}/.test(webviewSource), 'a release from a LIFTED drag drops')
        assert.ok(/if \(touchDrag\.lifted\)\{ dropTouchDrag\(\); return \}\s*endTouchDrag\('released'\)/.test(webviewSource),
            'and a release from a merely armed one goes through the one end - which is what takes the touchmove listener, the capture and the watchdog back off')
        const at = webviewSource.indexOf("document.addEventListener('pointerup', function(event){\n    if (!touchDrag.active")
        assert.ok(at >= 0, 'the drag\'s own release listener must still be there')
        const release = webviewSource.slice(at, webviewSource.indexOf('}, true)', at))
        assert.ok(!release.includes('ContextMenu'), 'the release must neither open nor close a menu: the press opened it 500ms ago and it stays')
        assert.ok(!release.includes('synthEvent'), '...so it needs no synthetic event of its own any more')
        // The synthetic click that follows is what would otherwise dismiss that menu (the capture dismiss listener)
        // or open the note (tap-to-open), and both are held off by longPress.fired still being set. That flag is
        // read AFTER cancelLongPress has run on the release, which is why the cancel must tidy up its TIMER and
        // nothing else: clearing `fired` there would let the click through and the menu would vanish the instant
        // the finger came up. It is the only field of longPress that outlives the press - the drag snapshots
        // everything it needs at the arm - so this pin is what keeps the cancel from growing a second job.
        const cancel = handlerBody('cancelLongPress')
        assert.strictEqual(cancel.replace(/longPress\.timer/g, '').includes('longPress.'), false,
            'cancelLongPress must touch longPress.timer and nothing else - the click swallower and the menu-dismiss bail both read longPress.fired after it has run')
        assert.ok(webviewSource.indexOf("document.addEventListener('pointerup', cancelLongPress, true)") >= 0,
            'the adapter\'s own pointerup must still cancel the pending press')
        const dismiss = webviewSource.indexOf('if (longPress && longPress.fired) return')
        const swallow = webviewSource.indexOf('if (longPress.fired){ longPress.fired = false; event.preventDefault(); event.stopPropagation() }')
        assert.ok(dismiss >= 0 && swallow > dismiss,
            'the menu-dismiss click listener must be registered before the swallower, so it sees fired still set and stands aside')
        // ...and the flag that click consumes is reset at the START of the next touch press, ABOVE every early
        // return in the adapter's pointerdown. It has to be, because a fired press does not always get a click to
        // consume it: one that travelled past the browser's tap slop afterwards synthesises none (a hold on the
        // tick circle and then a move, a drag that lifted - its touchmove is preventDefault()ed), so `fired`
        // outlives its own gesture. What keeps that from costing the NEXT tap is this reset running before the
        // zone check and before the `#cockpitOverlay` return - so even a press this adapter wants nothing to do
        // with still clears it. The e2e ring case leans on exactly that: it dismisses the date picker with a
        // finger, whose pointerdown lands inside the overlay and clears the flag on the way to returning.
        const downAt = webviewSource.indexOf("document.addEventListener('pointerdown', function(event){\n    if (!IS_MOBILE) return")
        assert.ok(downAt >= 0, "the long-press adapter's pointerdown listener must still be there")
        const down = webviewSource.slice(downAt, webviewSource.indexOf('}, true)', downAt))
        // Statements only: every anchor below carries its own newline and indent, because the comment above the
        // reset quotes two of these lines verbatim and a bare substring would match the prose instead of the code.
        const reset = down.indexOf('\n    longPress.fired = false')
        assert.ok(reset >= 0, 'the touch pointerdown must clear a stale fired flag')
        for (const [bail, what] of [["\n    if (event.target.closest('#cockpitOverlay')) return", 'the overlay return'],
                                    ['\n    if (!event.target.closest) return', 'the closest() guard'],
                                    ['\n    if (!kind) return', 'the unrecognised-zone return']]){
            const at = down.indexOf(bail)
            assert.ok(at >= 0, 'the pointerdown must still have ' + what)
            assert.ok(reset < at, 'the reset must come before ' + what + ', or a press that returns there strands the flag for the next tap')
        }
    })

    await test('panel.css touch drag: a thicker insertion line, a banner, and NO touch-action on .todo', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        const ruleBody = (selector) => {
            const at = css.indexOf(selector)
            assert.ok(at >= 0, `panel.css is missing the ${selector} rule`)
            const open = css.indexOf('{', at), close = css.indexOf('}', open)
            return css.slice(open + 1, close)
        }
        for (const selector of ['.cockpit-mobile .todo.-drop-before {', '.cockpit-mobile .todo.-drop-after {']) {
            const body = ruleBody(selector)
            assert.ok(/box-shadow:\s*inset 0 -?4px/.test(body), `${selector} must draw a 4px line, still as an inset box-shadow (no layout shift)`)
            assert.ok(/var\(--cockpit-/.test(body), `${selector} must colour the line from a --cockpit-* variable`)
        }
        // The row index is measured at the ARM, and only then does the lift paint the selection and dim the row.
        // That order is safe exactly as long as neither class can move a row: `.todo.-selected` and
        // `.todo.-dragging` must stay purely visual, or the lift would invalidate the index it is about to use
        // and every gap the drag resolves would be one row out. Nothing else pins this, and it is one CSS
        // property away from being silently untrue.
        for (const selector of ['.todo.-selected {', '.todo.-dragging {']) {
            const body = ruleBody(selector)
            const boxModel = /(^|[\s;])(width|height|min-width|min-height|max-width|max-height|padding|padding-[a-z]+|margin|margin-[a-z]+|border(?!-radius)[a-z-]*|display|position|top|bottom|left|right|transform|font-size|line-height|box-sizing|flex[a-z-]*)\s*:/
            assert.ok(!boxModel.test(body),
                `${selector} must stay purely visual - the drag's row index is built before either class is applied, so anything that changes a row's box would invalidate it`)
        }
        const banner = ruleBody('#cockpitDragBanner {')
        assert.ok(/position: fixed/.test(banner), 'the banner must be fixed over the panel')
        assert.ok(/pointer-events: none/.test(banner), 'the banner must never take the finger the drag needs')
        assert.ok(css.includes('#cockpitDragBanner.-cancel {'), 'the banner must have a cancel state')
        // The one thing that must NOT be here: a touch-action on the rows would apply to every touch on every
        // row, always, and kill the flick-scrolling of the list. The drag stops the pan per gesture instead.
        // Scanned over EVERY rule whose selector list mentions a row, in any shape (".cockpit-mobile .todos .todo",
        // ".todo.-dragging", a grouped selector), rather than the one spelling the feature happened to use.
        const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
        for (const rule of bare.match(/[^{}]+\{[^}]*\}/g) || []) {
            const selector = rule.slice(0, rule.indexOf('{'))
            if (!/(^|[\s,.>+~])\.todo(?![\w-])/.test(selector)) continue
            assert.ok(!/touch-action/.test(rule), `no touch-action may be put on the to-do rows, and "${selector.trim()}" has one`)
        }
    })

    await test('panel.ts loads the touch-drag module before the webview that uses it', () => {
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        const module = panelSource.indexOf("addScript(panel, '/ui/panel/touchDrag.js')")
        const webview = panelSource.indexOf("addScript(panel, '/ui/panel/panelWebview.js')")
        assert.ok(module >= 0, 'the touch-drag module must be added to the panel')
        assert.ok(module < webview, 'and before panelWebview.js, which resolves targets through it')
    })

    // Version lockstep: the four version fields (package.json, src/manifest.json, and BOTH package-lock fields)
    // drifted once when the lockfile was left stale. This cheap read-and-compare keeps all four pinned together.
    await test('version: package.json, manifest, and both package-lock fields are all 2.6.3', () => {
        const root = path.join(__dirname, '..')
        const readJSON = (...rel) => JSON.parse(fs.readFileSync(path.join(root, ...rel), 'utf8'))
        const pkg = readJSON('package.json')
        const manifest = readJSON('src', 'manifest.json')
        const lock = readJSON('package-lock.json')
        const expected = '2.6.3'
        assert.strictEqual(pkg.version, expected, 'package.json version')
        assert.strictEqual(manifest.version, expected, 'src/manifest.json version')
        assert.strictEqual(lock.version, expected, 'package-lock.json top-level version')
        assert.strictEqual(lock.packages[''].version, expected, 'package-lock.json root package entry version')
    })

    // A plain to-do (no checkboxes inside, marked .-plain) must show ONLY the small disc, never the ring: the ring
    // carries meaning (checkboxes exist), so rendering the full ring structure on a plain to-do makes it look like it
    // HAS checkboxes. So the plain state strips the box's conic-gradient ring and its ::after hollow (background:none),
    // and instead gives the standalone disc a DARK rim so it reads on the panel background. The rim must NOT move or
    // resize the disc: the ::before fill stays 10x10 at inset 4, identical to the disc inside a ring - it is grown to
    // inset 2 with a 2px border (border-box keeps the content box at inset 4) and background-clip:content-box keeps the
    // fill clipped there. The rim colour is a NEW dedicated variable (--cockpit-plain-disc-rim), dark on every theme.
    // Read panel.css as source text, as the other CSS checks do.
    await test('plain disc: ring stripped, 2px dark rim via --cockpit-plain-disc-rim, geometry untouched', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        const ruleBody = (selector) => {
            const at = css.indexOf(selector)
            assert.ok(at >= 0, `panel.css is missing the ${selector} rule`)
            const open = css.indexOf('{', at)
            const close = css.indexOf('}', open)
            assert.ok(open >= 0 && close > open, `panel.css ${selector} rule is malformed`)
            return css.slice(open + 1, close)
        }
        // The ring-strip is BACK: the .-plain marker sets background:none on the box AND its ::after, so a plain to-do
        // shows only the disc (no conic-gradient ring, no hollow) and never reads as having checkboxes.
        assert.ok(/\.todo-checkbox\.-plain\s*,\s*\.todo-checkbox\.-plain::after\s*\{[^}]*background:\s*none/.test(css),
            'the .-plain marker must strip the ring: background:none on the box and its ::after')
        // The rim rule exists on the plain disc, using the NEW variable at 2px, with background-clip:content-box so the
        // fill is not enlarged under the translucent rim.
        const plainBefore = ruleBody('.todo-checkbox.-plain::before {')
        assert.ok(/border:\s*2px\s+solid\s+var\(--cockpit-plain-disc-rim\)/.test(plainBefore),
            'the plain disc must carry a 2px border in var(--cockpit-plain-disc-rim)')
        assert.ok(/inset:\s*2px/.test(plainBefore),
            'the plain disc ::before must grow to inset 2px so the rim sits outside the unchanged inset-4 fill')
        assert.ok(/background-clip:\s*content-box/.test(plainBefore),
            'the plain disc fill must be clipped to content-box so the rim does not enlarge it')
        // The new rim variable is defined (so custom CSS can override it) and is a dark literal, not a --joplin-* alias.
        assert.ok(/--cockpit-plain-disc-rim:\s*rgba\(0,\s*0,\s*0,\s*0\.55\)/.test(css),
            'the --cockpit-plain-disc-rim variable must be defined as a dark translucent-black literal')
        // The mobile equivalent applies the same rim, offset by the tap padding.
        const mobilePlain = ruleBody('.cockpit-mobile .todo-checkbox.-plain::before {')
        assert.ok(/border:\s*2px\s+solid\s+var\(--cockpit-plain-disc-rim\)/.test(mobilePlain) &&
                  /inset:\s*calc\(var\(--tap-pad\)\s*\+\s*2px\)/.test(mobilePlain) &&
                  /background-clip:\s*content-box/.test(mobilePlain),
            'the mobile plain disc must apply the same 2px rim at inset calc(tap-pad + 2px) with content-box clip')
        // Ringed rows are untouched: the base .todo-checkbox conic-gradient track and the two fixed insets the
        // "circles saga" depends on are intact, and the rim rules are gated behind .-plain so a counted row never sees
        // them. (No .-plain in a counted row's class list.)
        assert.ok(/background:\s*conic-gradient\([^;]*var\(--cockpit-divider-color/.test(ruleBody('.todo-checkbox {')),
            'the base .todo-checkbox conic-gradient track (the ringed rows use it) must be intact')
        assert.ok(/--cockpit-circle-size:\s*18px/.test(css), 'the 18px --cockpit-circle-size default must be intact')
        assert.ok(/inset:\s*3px/.test(ruleBody('.todo-checkbox::after')), 'the 3px ring inset must be intact')
        assert.ok(/inset:\s*4px/.test(ruleBody('.todo-checkbox::before')), 'the 4px disc inset must be intact')
    })

    // ============================================================ MULTI-SELECT CONTEXT MENU (desktop)
    // With several rows Ctrl/Shift-selected, the panel's own note context menu must act on the WHOLE selection
    // for the actions that can apply to many, and grey out (never hide) the single-only ones. Two layers are
    // pinned here: (1) the shared markup module NoteMenu (required, like AlarmQuick, since this harness never
    // executes the webview JS) builds a byte-stable single-note menu and, for N>1, a menu with count-bearing
    // labels and a disabled single-only item; (2) the host batch handler (noteMenuActionMulti) applies each
    // action to every id through the data API with ONE post-mutation refresh for the whole batch, not N.
    const NoteMenu = require('../src/ui/panel/noteMenu.js')

    // -- (1) markup -------------------------------------------------------------------------------------------
    await test('multi-menu markup: N=1 is byte-identical to the pre-multi single-note menu', () => {
        const item = (cls, action, label) => `<button type="button" class="${cls}" data-action="${action}">${label}</button>`
        const expected = [
            item('context-menu-item', 'open', 'Open'),
            item('context-menu-item', 'toggleType', 'Switch between note and to-do type'),
            item('context-menu-item', 'tags', 'Tags...'),
            item('context-menu-item', 'moveToFolder', 'Move to notebook...'),
            item('context-menu-item', 'duplicate', 'Duplicate'),
            item('context-menu-item', 'copyMarkdownLink', 'Copy Markdown link'),
            item('context-menu-item', 'copyNoteID', 'Copy note ID'),
            item('context-menu-item -danger', 'delete', 'Delete note'),
        ].join('')
        assert.strictEqual(NoteMenu.menuHtml(1, []), expected)
        assert.strictEqual(NoteMenu.menuHtml(1), expected, 'a lone selection coerces to the single-note menu')
    })
    await test('multi-menu markup: the mobile "Move to date…" extra prepends, single-note, unchanged', () => {
        const html = NoteMenu.menuHtml(1, [{ action: 'setDueDate', label: 'Move to date…' }])
        assert.ok(html.startsWith('<button type="button" class="context-menu-item" data-action="setDueDate">Move to date…</button>'),
            'the mobile set-due-date entry must prepend the menu verbatim')
        assert.ok(html.includes('data-action="delete">Delete note</button>'), 'the base single-note items follow unchanged')
        assert.ok(!/aria-disabled/.test(html), 'a single-note menu disables nothing')
    })
    await test('multi-menu markup: N>1 greys out Open (shown, not hidden) and counts every capable action', () => {
        const html = NoteMenu.menuHtml(6, [])
        // Open is single-only: rendered, but disabled (greyed via -disabled + aria-disabled + inert), base label.
        assert.ok(html.includes('<button type="button" class="context-menu-item -disabled" data-action="open" aria-disabled="true">Open</button>'),
            'Open must render disabled (greyed, aria-disabled), never hidden')
        assert.ok(html.includes('data-action="toggleType">Switch type of 6 items</button>'), 'toggleType must count')
        assert.ok(html.includes('data-action="tags">Tags for 6 notes...</button>'), 'tags must count')
        assert.ok(html.includes('data-action="moveToFolder">Move 6 to notebook...</button>'), 'move must count')
        assert.ok(html.includes('data-action="duplicate">Duplicate 6 notes</button>'), 'duplicate must count')
        assert.ok(html.includes('data-action="copyMarkdownLink">Copy 6 Markdown links</button>'), 'copy-link must count')
        assert.ok(html.includes('data-action="copyNoteID">Copy 6 note IDs</button>'), 'copy-id must count')
        assert.ok(html.includes('class="context-menu-item -danger" data-action="delete">Delete 6 notes</button>'), 'delete must count and stay -danger')
        // Only the single-only action is disabled: exactly one aria-disabled in the whole menu.
        assert.strictEqual((html.match(/aria-disabled/g) || []).length, 1, 'only Open may be disabled on a multi-selection')
        assert.strictEqual((html.match(/ -disabled"/g) || []).length, 1, 'only Open carries the -disabled class')
    })

    // -- (2) host batch glue ----------------------------------------------------------------------------------
    let multiRunSeq = 0
    const desktopRun = async (opts) => {
        const dir = path.join(tmp, `multi-${multiRunSeq}`)
        const installDir = path.join(tmp, `multi-install-${multiRunSeq}`)
        multiRunSeq++
        await fs.ensureDir(dir)
        return run(Object.assign({
            dataDir: dir,
            installationDir: installDir,
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
        }, opts))
    }
    const id32 = (prefix) => (prefix + '0'.repeat(32)).slice(0, 32)

    await test('multi host glue (delete): N ids -> N DELETEs to the trash, and ONE refresh cycle (not N)', async () => {
        // Baseline: a single-note action runs the same post-mutation refresh trio exactly once.
        const single = await desktopRun({ notes: { [id32('s')]: { id: id32('s'), title: 's', is_todo: 1 } } })
        await single.panelMessageHandler(['noteMenuAction', 'toggleType', id32('s')])
        const singleTimers = single.timeouts.length

        const ids = [id32('d1'), id32('d2'), id32('d3')]
        const notes = {}
        for (const id of ids) notes[id] = { id, title: 'todo ' + id, is_todo: 1, todo_completed: 0, todo_due: 0 }
        const multi = await desktopRun({ notes })
        await multi.panelMessageHandler(['noteMenuActionMulti', 'delete', ids])
        // Exactly N DELETEs, each ['notes', id] (the data API delete moves the note to the trash, reversible).
        assert.strictEqual(multi.dataDeletes.length, ids.length, 'one DELETE per selected note')
        assert.deepStrictEqual(
            multi.dataDeletes.map(p => p.join('/')).sort(),
            ids.map(id => 'notes/' + id).sort(),
            'each DELETE targets its own note id')
        // ONE refresh cycle for the whole batch: the same lane-timer count a single action arms, not N times.
        assert.strictEqual(multi.timeouts.length, singleTimers, 'the batch must refresh ONCE, not once per note')
    })
    await test('multi host glue (toggleType): each id toggles its OWN type (a mixed note+to-do selection)', async () => {
        const ids = [id32('t1'), id32('t2'), id32('t3')]
        const notes = {
            [ids[0]]: { id: ids[0], title: 'a', is_todo: 1 },   // to-do -> note
            [ids[1]]: { id: ids[1], title: 'b', is_todo: 0 },   // note  -> to-do
            [ids[2]]: { id: ids[2], title: 'c', is_todo: 1 },   // to-do -> note
        }
        const m = await desktopRun({ notes })
        await m.panelMessageHandler(['noteMenuActionMulti', 'toggleType', ids])
        const puts = m.notePuts.filter(p => ids.includes(p.id))
        assert.strictEqual(puts.length, 3, 'one is_todo PUT per selected note')
        const byId = Object.fromEntries(puts.map(p => [p.id, p.fields.is_todo]))
        assert.strictEqual(byId[ids[0]], 0, 'a to-do flips to a note')
        assert.strictEqual(byId[ids[1]], 1, 'a note flips to a to-do')
        assert.strictEqual(byId[ids[2]], 0, 'each item toggles its OWN type, never a shared one')
    })
    await test('multi host glue (moveToFolder): one notebook picker, then N parent_id PUTs', async () => {
        const ids = [id32('m1'), id32('m2')]
        const notes = {}
        for (const id of ids) notes[id] = { id, title: 'todo', is_todo: 1, parent_id: 'src' }
        const folders = [{ id: 'src', title: 'Source', parent_id: '' }, { id: 'dest', title: 'Dest', parent_id: '' }]
        const m = await desktopRun({ notes, folders })
        // The notebook picker returns the destination folder.
        m.dialogResult = { id: 'ok', formData: { picker: { folderId: 'dest' } } }
        await m.panelMessageHandler(['noteMenuActionMulti', 'moveToFolder', ids])
        const puts = m.notePuts.filter(p => ids.includes(p.id))
        assert.strictEqual(puts.length, 2, 'one parent_id PUT per selected note')
        for (const p of puts) assert.strictEqual(p.fields.parent_id, 'dest', 'every selected note re-parents to the picked notebook')
    })
    await test('multi host glue (mixed kinds): a batch of to-dos AND notes is applied to every id, unfiltered', async () => {
        // The 2.1.0 headline reaches the host as an ordinary id array: Joplin has ONE note store, so nothing here
        // may look at is_todo to decide whether an id belongs in the batch. Proved on the two actions that could
        // plausibly have been written to assume to-dos - the per-id delete and the per-id type flip.
        const todoID = id32('mx1'), noteID = id32('mx2')
        const notes = { [todoID]: { id: todoID, title: 'a to-do', is_todo: 1 }, [noteID]: { id: noteID, title: 'a note', is_todo: 0 } }
        const del = await desktopRun({ notes: JSON.parse(JSON.stringify(notes)) })
        await del.panelMessageHandler(['noteMenuActionMulti', 'delete', [todoID, noteID]])
        assert.deepStrictEqual(del.dataDeletes.map(p => p[1]), [todoID, noteID],
            'a mixed selection must delete BOTH kinds, in the order given')
        const flip = await desktopRun({ notes: JSON.parse(JSON.stringify(notes)) })
        await flip.panelMessageHandler(['noteMenuActionMulti', 'toggleType', [todoID, noteID]])
        const flips = flip.notePuts.filter(p => p.id === todoID || p.id === noteID)
        assert.strictEqual(flips.length, 2, 'both kinds are flipped')
        assert.strictEqual(flips.find(p => p.id === todoID).fields.is_todo, 0, 'the to-do becomes a note')
        assert.strictEqual(flips.find(p => p.id === noteID).fields.is_todo, 1, 'and the note becomes a to-do - each flips its OWN type')
    })
    await test('multi host glue (copyMarkdownLink): reads each title for the list, mutates nothing', async () => {
        const ids = [id32('c1'), id32('c2')]
        const notes = { [ids[0]]: { id: ids[0], title: 'First' }, [ids[1]]: { id: ids[1], title: 'Second' } }
        const m = await desktopRun({ notes })
        await m.panelMessageHandler(['noteMenuActionMulti', 'copyMarkdownLink', ids])
        const titleGets = m.gets.filter(g => g.path[0] === 'notes' && g.path.length === 2 && ids.includes(g.path[1]))
        assert.strictEqual(titleGets.length, 2, 'one title read per note for the newline-joined link list')
        assert.strictEqual(m.notePuts.filter(p => ids.includes(p.id)).length, 0, 'a copy must not mutate any note')
        assert.strictEqual(m.dataDeletes.length, 0, 'a copy must not delete any note')
    })

    // ============================================================ TYPE FLIP: instant, and exactly one row
    // Switching an item between note and to-do type used to reach the panel only when the search index caught up
    // (the 7s reconcile rung), and until then the item rendered TWICE - once under a to-do heading, once under
    // NOTES. The two sections are two searches over the SAME lagging index, and an overlay entry spoke for only
    // one of the two lists, so an entry written for the new type could not correct the other list (worse: a
    // suppress destroyed itself against the to-dos, which are merged first, before the notes merge could use it).
    // Three layers are pinned here: an entry is now authoritative about the id's TYPE (it inserts into that type's
    // list and suppresses the id from the other, retiring only once BOTH agree), Cockpit's own toggle captures the
    // flip and repaints from the overlay at once, and a search row whose own is_todo contradicts its list is dropped.
    const flipFolder = 'n'.repeat(32)
    const flipSoon = Date.now() + 3600000
    const flipProfile = (extra) => ({ ...baseProfile, id: 1, name: 'Flip', searchCriteria: '', showNotes: true, showNoDue: true, sortOrder: 0, noteID: '', ...extra })
    const flipProfileData = (extra) => JSON.stringify({ nextID: 2, profiles: [flipProfile(extra)] })
    let flipRunSeq = 0
    // The defaults are written INTO the caller's options object (not a copy), so a test can go on changing what
    // the simulated index returns after the run has started - the index catching up is half of what is measured.
    const flipRun = (opts) => {
        opts.dataDir = path.join(tmp, 'flip-' + (++flipRunSeq))
        opts.installationDir = path.join(tmp, 'desktop-install')
        opts.require = desktopRequire
        opts.versionInfo = { version: '3.7.0', platform: 'desktop' }
        if (!opts.folders) opts.folders = [{ id: flipFolder, title: 'Inbox', parent_id: '', updated_time: 1 }]
        if (!opts.initialSettings) opts.initialSettings = { profileData: flipProfileData(), currentProfileID: 1 }
        return run(opts)
    }
    // A rendered row is counted by its wrapper's id attribute - the to-do sections stamp data-todo-id, the NOTES
    // section data-note-id - so "once, in the right section" is exactly one of the two across the whole panel.
    const rowCount = (state, id, kind) =>
        (String(state.panelHtml['panel-panel'] || '').match(new RegExp('data-' + kind + '-id="' + id + '"', 'g')) || []).length
    // The fields the post-flip record is judged (noteMatchesView + the trash guard) and rendered from. The harness
    // projects a single-note GET to exactly the fields asked for, as the real API does, so a narrowed list here
    // shows up as an undefined title, a mis-judged notebook, or a resurrected trashed note - never as a pass.
    const FLIP_GET_FIELDS = ['id', 'title', 'parent_id', 'is_todo', 'todo_completed', 'todo_due', 'deleted_time', 'user_updated_time', 'user_created_time']

    // (1) The duplicate, exactly as reported: an external note -> to-do flip while the index still files the item
    // under type:note. Its stale row carries is_todo 0, so nothing but the overlay can take it out of NOTES.
    const extTodoId = 'a'.repeat(32)
    const extTodo = await flipRun({
        todos: [],
        searchNotes: [{ id: extTodoId, title: 'FlippedItem', is_todo: 0, parent_id: flipFolder, user_updated_time: 1 }],
        notes: { [extTodoId]: { id: extTodoId, title: 'FlippedItem', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: 0, user_updated_time: 2 } },
    })
    await test('type flip (external, note -> to-do): the item renders ONCE, in the to-do section, while the index still lists it as a note', async () => {
        assert.strictEqual(rowCount(extTodo, extTodoId, 'note'), 1, 'precondition: the stale index renders it under NOTES')
        await extTodo.noteChangeHandler({ id: extTodoId })
        assert.strictEqual(rowCount(extTodo, extTodoId, 'todo'), 1, 'the flipped item shows in the to-do section at once')
        assert.strictEqual(rowCount(extTodo, extTodoId, 'note'), 0, 'and its stale NOTES row is gone - never both at once')
    })

    // (2) The mirror: an external to-do -> note flip while the index still files it under type:todo.
    const extNoteId = 'b'.repeat(32)
    const extNote = await flipRun({
        todos: [{ id: extNoteId, title: 'FlippedBack', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }],
        searchNotes: [],
        notes: { [extNoteId]: { id: extNoteId, title: 'FlippedBack', parent_id: flipFolder, is_todo: 0, todo_completed: 0, todo_due: 0, deleted_time: 0, user_updated_time: 2 } },
    })
    await test('type flip (external, to-do -> note): the item renders ONCE, under NOTES, while the index still lists it as a to-do', async () => {
        assert.strictEqual(rowCount(extNote, extNoteId, 'todo'), 1, 'precondition: the stale index renders it as a to-do')
        await extNote.noteChangeHandler({ id: extNoteId })
        assert.strictEqual(rowCount(extNote, extNoteId, 'note'), 1, 'the flipped item shows under NOTES at once')
        assert.strictEqual(rowCount(extNote, extNoteId, 'todo'), 0, 'and its stale to-do row is gone')
    })

    // (3) Flip into a type the view HIDES (undated to-do, showNoDue off): the suppress belongs to the to-do list,
    // which is merged FIRST and never held the id - so it must not retire there, or the stale NOTES row below it
    // could never be taken out (and would come back on every later render until the TTL).
    const hiddenFlipId = 'c'.repeat(32)
    const hiddenFlip = await flipRun({
        todos: [],
        searchNotes: [{ id: hiddenFlipId, title: 'GoesHidden', is_todo: 0, parent_id: flipFolder, user_updated_time: 1 }],
        notes: { [hiddenFlipId]: { id: hiddenFlipId, title: 'GoesHidden', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: 0, deleted_time: 0, user_updated_time: 2 } },
        initialSettings: { profileData: flipProfileData({ showNoDue: false }), currentProfileID: 1 },
    })
    await test('type flip (external, into a hidden type): the NOTES row goes and stays gone - the suppress survives the to-dos-first merge', async () => {
        assert.strictEqual(rowCount(hiddenFlip, hiddenFlipId, 'note'), 1, 'precondition: it is listed as a note')
        await hiddenFlip.noteChangeHandler({ id: hiddenFlipId })
        assert.strictEqual(rowCount(hiddenFlip, hiddenFlipId, 'note'), 0, 'the stale NOTES row is removed on the optimistic paint')
        assert.strictEqual(rowCount(hiddenFlip, hiddenFlipId, 'todo'), 0, 'and the undated to-do is not shown either (the view hides it)')
        await hiddenFlip.panelMessageHandler(['sortDirectionClicked'])          // a real, search-based render
        assert.strictEqual(rowCount(hiddenFlip, hiddenFlipId, 'note'), 0, 'the entry is still held, so the stale row cannot come back')
    })

    // (4) Cockpit's own toggle: instant, from the overlay, with no search and an early-stoppable arm.
    const ownFlipId = 'd'.repeat(32)
    const ownFlipOptions = {
        todos: [{ id: ownFlipId, title: 'OwnFlip', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }],
        searchNotes: [],
        notes: { [ownFlipId]: { id: ownFlipId, title: 'OwnFlip', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: 0, user_updated_time: 1 } },
    }
    const ownFlip = await flipRun(ownFlipOptions)
    await test('type flip (Cockpit toggle): the row changes section on the spot - unchanged PUT, no search, no fired timer', async () => {
        assert.strictEqual(rowCount(ownFlip, ownFlipId, 'todo'), 1, 'precondition: it starts in the to-do section')
        const searchesBefore = countSearches(ownFlip)
        const paintsBefore = ownFlip.setHtmlCalls
        const mark = ownFlip.timeouts.length
        const getMark = ownFlip.gets.length
        await ownFlip.panelMessageHandler(['noteMenuAction', 'toggleType', ownFlipId])
        // (a) the write is exactly what it always was
        const puts = ownFlip.notePuts.filter(p => p.id === ownFlipId)
        assert.strictEqual(puts.length, 1, 'exactly one PUT for the flip')
        assert.deepStrictEqual(puts[0].fields, { is_todo: 0 }, 'and it writes only the flipped is_todo')
        // ...and it is still ONE read, but a wide one: every field the post-flip record is judged and rendered
        // by must be asked for, since the API answers with exactly the fields requested and nothing else.
        const flipGets = ownFlip.gets.slice(getMark).filter(g =>
            g.path[0] === 'notes' && g.path.length === 2 && g.path[1] === ownFlipId &&
            !(g.query.fields.length === 1 && g.query.fields[0] === 'body'))
        assert.strictEqual(flipGets.length, 1, 'the flip still costs a single note read (checkbox bodies aside)')
        assert.deepStrictEqual(flipGets[0].query.fields.slice().sort(), FLIP_GET_FIELDS.slice().sort(),
            'the toggleType GET must ask for exactly the fields the overlay record needs')
        // (b) the paint that follows already shows the new section - no reconcile timeout has been fired
        assert.ok(ownFlip.setHtmlCalls > paintsBefore, 'the flip repaints immediately')
        assert.strictEqual(rowCount(ownFlip, ownFlipId, 'note'), 1, 'the item is under NOTES on that very paint')
        assert.strictEqual(rowCount(ownFlip, ownFlipId, 'todo'), 0, 'and out of the to-do section - never both')
        // (c) it costs no round-trip: the overlay is layered onto the warm result caches
        assert.strictEqual(countSearches(ownFlip) - searchesBefore, 0, 'the optimistic repaint issues no search')
        // (d) the arm is optimistic, so the burst stops as soon as the index agrees
        const rec = armedSince(ownFlip, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        assert.strictEqual(rec.length, 5, 'one reconcile job of five offsets')
        ownFlipOptions.todos = []
        ownFlipOptions.searchNotes = [{ id: ownFlipId, title: 'OwnFlip', is_todo: 0, parent_id: flipFolder, user_updated_time: 2 }]
        await ownFlip.fireTimeout(rec[0])
        assert.strictEqual(ownFlip.pendingTimeouts(3000).length, 0, 'the index having caught up, the remaining offsets are cancelled')
    })

    // (5) The batch toggle: a mixed selection lands in BOTH new sections on ONE paint.
    const batchTodoId = id32('bt'), batchNoteId = id32('bn')
    const batchFlip = await flipRun({
        todos: [{ id: batchTodoId, title: 'BatchTodo', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }],
        searchNotes: [{ id: batchNoteId, title: 'BatchNote', is_todo: 0, parent_id: flipFolder, user_updated_time: 1 }],
        notes: {
            [batchTodoId]: { id: batchTodoId, title: 'BatchTodo', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: 0, user_updated_time: 1 },
            [batchNoteId]: { id: batchNoteId, title: 'BatchNote', parent_id: flipFolder, is_todo: 0, todo_completed: 0, todo_due: 0, deleted_time: 0, user_updated_time: 1 },
        },
    })
    await test('type flip (batch toggle): both rows land in their NEW sections on ONE paint', async () => {
        assert.strictEqual(rowCount(batchFlip, batchTodoId, 'todo'), 1, 'precondition: the to-do is a to-do')
        assert.strictEqual(rowCount(batchFlip, batchNoteId, 'note'), 1, 'precondition: the note is a note')
        const paintsBefore = batchFlip.setHtmlCalls
        await batchFlip.panelMessageHandler(['noteMenuActionMulti', 'toggleType', [batchTodoId, batchNoteId]])
        assert.strictEqual(batchFlip.setHtmlCalls - paintsBefore, 1, 'the batch paints ONCE, not once per note')
        for (const id of [batchTodoId, batchNoteId]){
            const batchGet = batchFlip.gets.filter(g => g.path[0] === 'notes' && g.path.length === 2 && g.path[1] === id).pop()
            assert.deepStrictEqual(batchGet.query.fields.slice().sort(), FLIP_GET_FIELDS.slice().sort(),
                'each id in the batch is read with the same wide field list as the single flip')
        }
        assert.strictEqual(rowCount(batchFlip, batchTodoId, 'note'), 1, 'the to-do is now under NOTES')
        assert.strictEqual(rowCount(batchFlip, batchTodoId, 'todo'), 0, 'and gone from the to-do section')
        assert.strictEqual(rowCount(batchFlip, batchNoteId, 'todo'), 1, 'the note is now a to-do row')
        assert.strictEqual(rowCount(batchFlip, batchNoteId, 'note'), 0, 'and gone from NOTES')
    })

    // (6a) Non-regression: a tick is still instant and still retires against its own list.
    const tickPinId = 'e'.repeat(32)
    const tickPinOptions = {
        todos: [{ id: tickPinId, title: 'TickPin', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }],
        searchNotes: [],
    }
    const tickPin = await flipRun(tickPinOptions)
    await test('type flip (pin): a checkbox tick is unaffected - instant, no search, and it still retires when the index agrees', async () => {
        const searchesBefore = countSearches(tickPin)
        const mark = tickPin.timeouts.length
        await tickPin.panelMessageHandler(['todoChecked', tickPinId, true])
        assert.strictEqual(countSearches(tickPin) - searchesBefore, 0, 'the tick repaints from the cache, with no search')
        const html = tickPin.panelHtml['panel-panel']
        const at = html.indexOf('data-todo-id="' + tickPinId + '"')
        assert.ok(html.slice(html.lastIndexOf('<div', at), at).includes('-completed'), 'the row renders completed at once')
        const rec = armedSince(tickPin, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        tickPinOptions.todos = [{ id: tickPinId, title: 'TickPin', is_todo: 1, todo_completed: Date.now(), todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 2 }]
        await tickPin.fireTimeout(rec[0])
        assert.strictEqual(tickPin.pendingTimeouts(3000).length, 0, 'the override retires once the search agrees, and the burst stops')
    })

    // (6b) Non-regression: a created note's insert must splice nothing out of the to-do list.
    const createPinTodoId = 'f'.repeat(32)
    const createPin = await flipRun({
        todos: [{ id: createPinTodoId, title: 'BystanderTodo', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }],
        searchNotes: [],
    })
    await test('type flip (pin): a created note inserts under NOTES and splices nothing out of the to-do list', async () => {
        createPin.dialogResult = { id: 'ok', formData: { picker: { folderId: flipFolder } } }   // the desktop "create in notebook" picker
        await createPin.panelMessageHandler(['newNoteClicked'])
        assert.strictEqual(rowCount(createPin, 'created-1', 'note'), 1, 'the created note shows under NOTES')
        assert.strictEqual(rowCount(createPin, 'created-1', 'todo'), 0, 'and nowhere in the to-do section')
        assert.strictEqual(rowCount(createPin, createPinTodoId, 'todo'), 1, 'the unrelated to-do row is untouched')
    })

    // (6c) Non-regression: a trash suppress still hides the row and still retires against its own list.
    const trashPinId = '1'.repeat(32)
    const trashPinOptions = {
        todos: [{ id: trashPinId, title: 'TrashPin', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }],
        searchNotes: [],
        notes: { [trashPinId]: { id: trashPinId, title: 'TrashPin', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: Date.now(), user_updated_time: 2 } },
    }
    const trashPin = await flipRun(trashPinOptions)
    await test('type flip (pin): a trashed to-do is still suppressed at once, and the entry still retires when the index drops it', async () => {
        assert.strictEqual(rowCount(trashPin, trashPinId, 'todo'), 1, 'precondition: the stale index still lists it')
        const mark = trashPin.timeouts.length
        await trashPin.noteChangeHandler({ id: trashPinId })
        assert.strictEqual(rowCount(trashPin, trashPinId, 'todo'), 0, 'the trashed to-do disappears at once')
        const rec = armedSince(trashPin, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        trashPinOptions.todos = []                                              // the index drops it too
        await trashPin.fireTimeout(rec[0])
        assert.strictEqual(trashPin.pendingTimeouts(3000).length, 0, 'the suppress retires once neither list returns it, and the burst stops')
    })

    // (6d) A view only a search can decide (the profile carries searchCriteria) writes NO overlay entry - the flip
    // falls back to the full refresh and a blind arm, exactly as every other context-menu action does - and the row
    // must therefore KEEP its old section rather than vanish from both: nothing else can draw the item until the
    // index catches up. The fixture models Joplin as measured: the index picks the ROWS from a table it re-syncs on
    // a timer of its own (so type:todo still returns the id) while the fields come from the live note (so the
    // payload's is_todo is already the flipped one) - which is why the to-do list is a function of the fixture the
    // PUT mutates rather than a frozen row.
    const criteriaFlipId = '2'.repeat(32)
    const criteriaFlipNote = { id: criteriaFlipId, title: 'CriteriaFlip', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: 0, user_updated_time: 1 }
    const criteriaFlipOptions = {
        todos: () => [{ ...criteriaFlipNote }],
        searchNotes: [],
        notes: { [criteriaFlipId]: criteriaFlipNote },
        initialSettings: { profileData: flipProfileData({ searchCriteria: 'tag:work' }), currentProfileID: 1 },
    }
    const criteriaFlip = await flipRun(criteriaFlipOptions)
    await test('type flip (pin): on a searchCriteria profile the flip writes no overlay entry, arms the lane blind, and never blanks the row', async () => {
        assert.strictEqual(rowCount(criteriaFlip, criteriaFlipId, 'todo'), 1, 'precondition: the item is listed as a to-do')
        const mark = criteriaFlip.timeouts.length
        await criteriaFlip.panelMessageHandler(['noteMenuAction', 'toggleType', criteriaFlipId])
        // No optimistic move: the search is the sole authority there, so the row stays where the index has it -
        // and it stays SOMEWHERE. The two lists can never both hold it: one stale index value answers both queries.
        assert.strictEqual(rowCount(criteriaFlip, criteriaFlipId, 'todo'), 1, 'the stale placement stands until a search says otherwise')
        assert.strictEqual(rowCount(criteriaFlip, criteriaFlipId, 'note'), 0, 'and nothing was inserted into NOTES')
        const rec = armedSince(criteriaFlip, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        await criteriaFlip.fireTimeout(rec[0])
        assert.strictEqual(rowCount(criteriaFlip, criteriaFlipId, 'todo') + rowCount(criteriaFlip, criteriaFlipId, 'note'), 1,
            'a real search-based render still draws the item exactly once - an explicit flip must never look like a delete')
        assert.strictEqual(criteriaFlip.pendingTimeouts(3000).length, 1, 'a blind arm runs its bounded offsets out - nothing optimistic to retire')
        // Once the index has caught up the item is a note like any other, and lands under NOTES.
        criteriaFlipOptions.todos = () => []
        criteriaFlipOptions.searchNotes = [{ id: criteriaFlipId, title: 'CriteriaFlip', is_todo: 0, parent_id: flipFolder, user_updated_time: 2 }]
        await criteriaFlip.fireTimeout(rec[1])
        assert.strictEqual(rowCount(criteriaFlip, criteriaFlipId, 'note'), 1, 'the search eventually moves it to NOTES')
        assert.strictEqual(rowCount(criteriaFlip, criteriaFlipId, 'todo'), 0, 'and out of the to-do section')
    })

    // (7) The last layer: whatever the query asked for, a returned row's own is_todo decides which list it may
    // appear in - on the ordinary path, not only under any:1 (whose narrowing is pinned by its own section).
    const contradict = await flipRun({
        todos: [
            { id: '3'.repeat(32), title: 'RealTodo', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 },
            { id: '4'.repeat(32), title: 'NotATodoAnyMore', is_todo: 0, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 },
        ],
        searchNotes: [
            { id: '5'.repeat(32), title: 'RealNote', is_todo: 0, parent_id: flipFolder, user_updated_time: 1 },
            { id: '6'.repeat(32), title: 'NotANoteAnyMore', is_todo: 1, parent_id: flipFolder, user_updated_time: 1 },
        ],
    })
    // (8) A flip made on the STALE row of a note that has since been trashed. Reachable because a trash arriving
    // during a sync is deliberately not reconciled per note (timer.ts skips it while syncing), so the pre-trash
    // row can still be on screen. Search never returns a trashed note, so an INSERT for one could only be retired
    // by the 60s TTL - the flip must recognise the trash and suppress instead, exactly as the external reconcile
    // does. This also pins deleted_time in the flip's field list: without it the trashed note is inserted.
    const trashFlipId = '7'.repeat(32)
    const trashFlipOptions = {
        todos: [{ id: trashFlipId, title: 'TrashedStale', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }],
        searchNotes: [],
        notes: { [trashFlipId]: { id: trashFlipId, title: 'TrashedStale', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: Date.now(), user_updated_time: 1 } },
    }
    const trashFlip = await flipRun(trashFlipOptions)
    await test('type flip (trashed row): flipping the stale row of a trashed note never puts that note back on screen', async () => {
        assert.strictEqual(rowCount(trashFlip, trashFlipId, 'todo'), 1, 'precondition: the stale row is on screen')
        const mark = trashFlip.timeouts.length
        await trashFlip.panelMessageHandler(['noteMenuAction', 'toggleType', trashFlipId])
        assert.strictEqual(trashFlip.notePuts.filter(p => p.id === trashFlipId).length, 1, 'the flip itself is still written')
        assert.strictEqual(rowCount(trashFlip, trashFlipId, 'note'), 0, 'a trashed note must NOT be inserted under NOTES')
        assert.strictEqual(rowCount(trashFlip, trashFlipId, 'todo'), 0, 'and its stale to-do row goes with it')
        // A suppress retires against the first search that no longer lists the id, which is what lets the burst
        // stop early; an insert for a trashed note could never be retired by any search at all.
        const rec = armedSince(trashFlip, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        trashFlipOptions.todos = []
        await trashFlip.fireTimeout(rec[0])
        assert.strictEqual(rowCount(trashFlip, trashFlipId, 'todo') + rowCount(trashFlip, trashFlipId, 'note'), 0, 'still gone after a real search')
        assert.strictEqual(trashFlip.pendingTimeouts(3000).length, 0, 'the suppress retires, so the burst stops early')
    })

    // (9) The suppress a flip-to-hidden writes must not outlive the switch that justified it. The viewKey carries
    // the profile id and the notebook filter only, so turning the switch back ON leaves the entry matching - and
    // its own list now legitimately returns the item, so its verdict pins "present" and no merge can ever retire
    // it. Re-validation takes such an entry back instead, and the item returns in its own section, once.
    const hiddenBackId = '8'.repeat(32)
    const hiddenBackRow = { id: hiddenBackId, title: 'BackAgain', is_todo: 1, todo_completed: 0, todo_due: 0, parent_id: flipFolder, user_updated_time: 2 }
    const hiddenBackOptions = {
        // A hide-undated profile's own query (due:19700201) can never return an undated to-do, whatever the index
        // knows; the show-undated query returns it once the index has caught up with the flip.
        todos: (q) => q.includes('due:19700201') ? [] : [{ ...hiddenBackRow }],
        searchNotes: [{ id: hiddenBackId, title: 'BackAgain', is_todo: 0, parent_id: flipFolder, user_updated_time: 1 }],
        notes: { [hiddenBackId]: { id: hiddenBackId, title: 'BackAgain', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: 0, deleted_time: 0, user_updated_time: 2 } },
        initialSettings: { profileData: flipProfileData({ showNoDue: false }), currentProfileID: 1 },
    }
    const hiddenBack = await flipRun(hiddenBackOptions)
    await test('type flip (suppress vs its own switch): re-enabling the switch that hid the flipped item brings it back, once', async () => {
        await hiddenBack.noteChangeHandler({ id: hiddenBackId })                    // flipped into a type this view hides
        assert.strictEqual(rowCount(hiddenBack, hiddenBackId, 'note'), 0, 'precondition: hidden from NOTES')
        assert.strictEqual(rowCount(hiddenBack, hiddenBackId, 'todo'), 0, 'precondition: and hidden from the to-dos')
        hiddenBackOptions.searchNotes = []                                          // the index catches up with the flip
        await hiddenBack.panelMessageHandler(['profileSaved', 1, flipProfile({ showNoDue: true })])
        assert.strictEqual(rowCount(hiddenBack, hiddenBackId, 'todo'), 1, 'the item is back in the to-do section, exactly once')
        assert.strictEqual(rowCount(hiddenBack, hiddenBackId, 'note'), 0, 'and not under NOTES as well')
        await hiddenBack.panelMessageHandler(['sortDirectionClicked'])              // a further, search-based render
        assert.strictEqual(rowCount(hiddenBack, hiddenBackId, 'todo'), 1, 'and it keeps showing on the next render')
    })

    // (11) An external to-do -> note conversion (the Joplin editor, another plugin's PUT) must drop any pending
    // tick of that id. Once the item is not a to-do, no search can produce the row that would retire the
    // completion override - getTodos drops it on the is_todo re-check before the overrides are applied - so a
    // leftover override holds the optimistic layer "pending" for its whole TTL (the reconcile burst then runs
    // every rung) and re-applies the stale tick if the item is converted back inside that window.
    const overrideFlipId = '9'.repeat(32)
    // The row the index serves. Its fields are moved by hand below, so each step models one real state: the tick
    // not yet indexed, the conversion indexed, the conversion undone with the to-do left un-ticked in Joplin.
    const overrideRow = { id: overrideFlipId, title: 'TickThenFlip', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }
    const overrideFlipOptions = {
        todos: () => [{ ...overrideRow }],
        searchNotes: [],
        notes: { [overrideFlipId]: { id: overrideFlipId, title: 'TickThenFlip', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: 0, user_updated_time: 1 } },
    }
    const overrideFlip = await flipRun(overrideFlipOptions)
    await test('type flip (external, ticked to-do): converting a ticked to-do elsewhere drops the tick override instead of orphaning it', async () => {
        await overrideFlip.panelMessageHandler(['todoChecked', overrideFlipId, true])       // optimistic tick, index lagging
        const mark = overrideFlip.timeouts.length
        overrideFlipOptions.notes[overrideFlipId].is_todo = 0                                // converted in the Joplin editor
        overrideRow.is_todo = 0                                                              // the row's own is_todo is live
        await overrideFlip.noteChangeHandler({ id: overrideFlipId })
        // The index catches up with the conversion, so the item-overlay insert retires at the first poll. If the
        // completion override were still held, the layer would stay pending and the burst could not stop early.
        overrideFlipOptions.searchNotes = [{ id: overrideFlipId, title: 'TickThenFlip', is_todo: 0, parent_id: flipFolder, user_updated_time: 2 }]
        const rec = armedSince(overrideFlip, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        await overrideFlip.fireTimeout(rec[0])
        assert.strictEqual(overrideFlip.pendingTimeouts(3000).length, 0, 'nothing optimistic is left pending, so the burst stops early')
        // ...and the user-visible half: converted back to an UN-ticked to-do, the panel must not re-apply the tick.
        overrideFlipOptions.notes[overrideFlipId].is_todo = 1
        overrideFlipOptions.notes[overrideFlipId].todo_completed = 0
        overrideRow.is_todo = 1
        overrideRow.user_updated_time = 3
        overrideFlipOptions.searchNotes = []
        await overrideFlip.panelMessageHandler(['sortDirectionClicked'])                     // a real, search-based render
        const html = overrideFlip.panelHtml['panel-panel']
        const at = html.indexOf('data-todo-id="' + overrideFlipId + '"')
        assert.ok(at >= 0, 'the item is a to-do again')
        assert.ok(!html.slice(html.lastIndexOf('<div', at), at).includes('-completed'),
            'the row renders un-ticked, as Joplin has it - no stale override may be re-applied')
    })

    // (11b) The same orphaned-tick hazard, reached by a TRASH rather than a conversion. Joplin's search never returns
    // a trashed note - in either list - so once the note is in the trash no getTodos result can carry the row whose
    // todo_completed would retire the override. Left behind it sits out its whole 60s TTL holding the optimistic layer
    // "pending" (the reconcile burst then runs every rung instead of stopping when the index agrees) and re-applies the
    // stale tick if the note is restored from the trash inside that window.
    const overrideTrashId = '8'.repeat(32)
    // As in (11): the fields are moved by hand between the steps, so each one models a real state of the same note.
    const overrideTrashRow = { id: overrideTrashId, title: 'TickThenTrash', is_todo: 1, todo_completed: 0, todo_due: flipSoon, parent_id: flipFolder, user_updated_time: 1 }
    const overrideTrashOptions = {
        todos: () => [{ ...overrideTrashRow }],
        searchNotes: [],
        notes: { [overrideTrashId]: { id: overrideTrashId, title: 'TickThenTrash', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: 0, user_updated_time: 1 } },
    }
    const overrideTrash = await flipRun(overrideTrashOptions)
    await test('trash (external, ticked to-do): trashing a ticked to-do elsewhere drops the tick override instead of orphaning it', async () => {
        await overrideTrash.panelMessageHandler(['todoChecked', overrideTrashId, true])     // optimistic tick, index lagging
        const mark = overrideTrash.timeouts.length
        overrideTrashOptions.notes[overrideTrashId].deleted_time = Date.now()               // trashed in the Joplin app
        await overrideTrash.noteChangeHandler({ id: overrideTrashId })
        assert.strictEqual(rowCount(overrideTrash, overrideTrashId, 'todo'), 0, 'the trashed to-do disappears at once')
        // The index drops the trashed note from both lists, so the suppress retires at the first poll. If the
        // completion override were still held, the layer would stay pending and the burst could not stop early.
        overrideTrashOptions.todos = () => []
        const rec = armedSince(overrideTrash, mark).filter(t => RECONCILE_OFFSETS.includes(t.ms))
        await overrideTrash.fireTimeout(rec[0])
        assert.strictEqual(overrideTrash.pendingTimeouts(3000).length, 0, 'nothing optimistic is left pending, so the burst stops early')
        // ...and the user-visible half: restored from the trash still un-ticked, the panel must not re-apply the tick.
        overrideTrashOptions.notes[overrideTrashId].deleted_time = 0
        overrideTrashRow.user_updated_time = 3
        overrideTrashOptions.todos = () => [{ ...overrideTrashRow }]
        await overrideTrash.panelMessageHandler(['sortDirectionClicked'])                   // a real, search-based render
        const html = overrideTrash.panelHtml['panel-panel']
        const at = html.indexOf('data-todo-id="' + overrideTrashId + '"')
        assert.ok(at >= 0, 'the to-do is back from the trash')
        assert.ok(!html.slice(html.lastIndexOf('<div', at), at).includes('-completed'),
            'the row renders un-ticked, as Joplin has it - no stale override may be re-applied')
    })

    // (12) One render, one view. The revalidation pass keys its entries by the notebook filter and then awaits a
    // settings read before judging them; reading the filter live in the predicate would let a notebook chip
    // clicked inside that await judge THIS view's entries by the NEXT view's filter and delete a legitimate
    // insert. The harness hook fires the chip click inside that very read.
    const driftId = 'd'.repeat(32)
    const driftOther = 'e'.repeat(32)
    const drift = await flipRun({
        todos: [],                                                                          // only the overlay can show it
        searchNotes: [],
        folders: [{ id: flipFolder, title: 'Inbox', parent_id: '', updated_time: 1 }, { id: driftOther, title: 'Other', parent_id: '', updated_time: 1 }],
        notes: { [driftId]: { id: driftId, title: 'DriftItem', parent_id: flipFolder, is_todo: 1, todo_completed: 0, todo_due: flipSoon, deleted_time: 0, user_updated_time: 1 } },
    })
    await test('type flip (one view per render): a notebook chip clicked mid-render cannot delete the unfiltered view\'s own insert', async () => {
        await drift.noteChangeHandler({ id: driftId })                                      // insert for the unfiltered view
        assert.strictEqual(rowCount(drift, driftId, 'todo'), 1, 'precondition: the unfiltered view shows it')
        // The next render suspends on the excluded-notebook read; the chip click lands exactly there.
        drift.onSettingRead = async (key) => {
            if (key !== 'excludedNotebookIds') return
            drift.onSettingRead = null
            await drift.panelMessageHandler(['notebookFilterChanged', driftOther])
        }
        await drift.panelMessageHandler(['sortDirectionClicked'])
        await drift.panelMessageHandler(['notebookFilterChanged', ''])                       // back to the unfiltered view
        assert.strictEqual(rowCount(drift, driftId, 'todo'), 1, 'the entry keyed for this view survives another view\'s filter')
    })

    // (10) The three overlay calls of one render must agree on ONE view key. The merges take theirs from the view
    // state captured before the render's awaits; finalizeOverlay has to use that same snapshot, or a notebook chip
    // clicked mid-render leaves the render's verdicts unconsumed (and wipes another view's). Pinned at the source,
    // since the harness cannot change the filter inside an awaited render.
    await test('type flip (one view key per render): every overlay call of a render keys off the render snapshot, not the live filter', () => {
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        assert.ok(panelSource.includes('var viewNotebookFilter = notebookFilter'),
            'the render must take ONE snapshot of the notebook filter')
        assert.ok(panelSource.includes('var revalidationKey = viewKeyFor(profileID, viewNotebookFilter)'),
            'the re-validation key must come from that snapshot')
        assert.ok(panelSource.includes('notebookFilter: viewNotebookFilter'),
            'and so must the view state the two merges consume')
        assert.ok(panelSource.includes('finalizeOverlay(viewKeyFor(profileID, panelViewState.notebookFilter)'),
            'finalizeOverlay must key off panelViewState.notebookFilter - the value the two merges used')
        // The judgement itself takes the filter as a parameter, so no caller can accidentally judge one view's
        // entries by another view's filter across an await.
        assert.ok(panelSource.includes('function noteMatchesView(record, profile, notebooks, excludedSet, filter){'),
            'noteMatchesView must take the notebook filter, not read the module-level one')
        assert.ok(!/^\s*if \(notebookFilter\)\{/m.test(panelSource),
            'and nothing in the judgement may read the live notebookFilter')
    })

    await test('type flip (stale index row): a search row whose own is_todo contradicts its list is dropped, on the ordinary path too', async () => {
        const html = contradict.panelHtml['panel-panel']
        assert.ok(html.includes('RealTodo') && html.includes('RealNote'), 'the rows that agree with their list are kept')
        assert.strictEqual(rowCount(contradict, '4'.repeat(32), 'todo'), 0, 'a type:todo row that is no longer a to-do is dropped')
        // The unfiltered view reads its notes from the live listing, which files every item by its CURRENT type: the ex-to-do is a note
        // now and shows there once, and the ex-note is a to-do the listing keeps out of Notes.
        assert.strictEqual(rowCount(contradict, '4'.repeat(32), 'note'), 1, 'the live listing lists the ex-to-do as the note it now is')
        assert.strictEqual(rowCount(contradict, '6'.repeat(32), 'note'), 0, 'and keeps the ex-note out of Notes')
        // A notebook filter keeps the view locally evaluable but sends the notes to the SEARCH, whose stale type:note row must go too.
        await contradict.panelMessageHandler(['notebookFilterChanged', flipFolder])
        const filtered = contradict.panelHtml['panel-panel']
        assert.ok(filtered.includes('RealTodo') && filtered.includes('RealNote'), 'the rows that agree with their list are kept under the filter')
        assert.ok(!filtered.includes('NotATodoAnyMore'), 'a type:todo row that is no longer a to-do is dropped')
        assert.ok(!filtered.includes('NotANoteAnyMore'), 'a type:note row that is no longer a note is dropped')
    })

    // ============================================================ notebook picker UX (taller menu, ESC-close, embedded filter)
    // Three additions to the custom notebook-filter dropdown: it opens at least two-thirds tall, Escape closes it, and a
    // filter box pinned at its top narrows the notebook rows live. The harness renders the panel markup but never runs the
    // webview JS, so the runtime behaviour is proved by the e2e spec; here we pin (a) the markup - the filter box is present
    // and pinned above the rows, the per-row rename/move/delete icons are untouched, every notebook row is a data-notebook-row
    // and "All notebooks" is not - (b) the CSS - #notebookMenu is capped at 66vh (scoped, so profile/sort keep 320px), a
    // filtered row is hidden, no @media - and (c) the webview source shape - the Escape-close is scoped to an OPEN dropdown,
    // the filter is a case-insensitive path substring, Enter selects the first visible notebook, and the box auto-focuses on
    // desktop only.
    const nbFolders = [
        { id: 'n'.repeat(32), title: 'Family', parent_id: '' },
        { id: 'm'.repeat(32), title: 'Payments', parent_id: 'n'.repeat(32) },
        { id: 'k'.repeat(32), title: 'Work', parent_id: '' },
    ]
    const nbState = await run({
        dataDir: path.join(tmp, 'nb-data'),
        installationDir: path.join(tmp, 'nb-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [],
        folders: nbFolders,
    })

    await test('notebook markup: a filter box is pinned above the rows; per-row icons and the All/notebook markers are intact', () => {
        const html = nbState.panelHtml['panel-panel']
        const menuStart = html.indexOf('id="notebookMenu"')
        assert.ok(menuStart >= 0, 'the notebook menu must be present')
        // The filter box, with the live-filter handlers wired inline so it survives the panel's innerHTML swaps.
        const filterAt = html.indexOf('notebook-filter-input', menuStart)
        assert.ok(filterAt >= 0, 'the notebook menu must carry the embedded filter input')
        assert.ok(html.includes('oninput="onNotebookFilterInput(event)"'), 'the filter box must filter live on input')
        assert.ok(html.includes('onkeydown="onNotebookFilterKeyDown(event)"'), 'the filter box must handle Enter/Escape')
        // Pinned at the TOP: the box comes before the All-notebooks row (and therefore before every notebook row) in the menu.
        const allRowAt = html.indexOf('data-notebook-all', menuStart)
        assert.ok(allRowAt >= 0 && filterAt < allRowAt, 'the filter box must be pinned above the All-notebooks row')
        // "All notebooks" is NOT a filterable notebook row (Enter must never land on it, the filter must never hide it).
        assert.ok(!/data-notebook-all[^>]*data-notebook-row|data-notebook-row[^>]*data-notebook-all/.test(html),
            'the All-notebooks row must not be a data-notebook-row')
        // Every real notebook row is a data-notebook-row and still shows its full breadcrumb path in the label.
        assert.ok(/data-notebook-row[^>]*>\s*<span class="dropdown-label">Family \/ Payments<\/span>/.test(html),
            'each notebook row must be a data-notebook-row carrying its full path label')
        // The per-row action icons are byte-for-byte unchanged.
        assert.ok(html.includes("onDropdownActionClicked(event, 'renameNotebookClicked'"), 'the Rename icon must be intact')
        assert.ok(html.includes("onDropdownActionClicked(event, 'moveNotebookClicked'"), 'the Move icon must be intact')
        assert.ok(html.includes("onDropdownActionClicked(event, 'deleteNotebookClicked'"), 'the Delete icon must be intact')
    })

    await test('notebook css: #notebookMenu is capped near 66vh (scoped), a filtered row is hidden, no @media', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        const ruleBody = (selector) => {
            const at = css.indexOf(selector)
            assert.ok(at >= 0, `panel.css is missing the ${selector} rule`)
            const open = css.indexOf('{', at), close = css.indexOf('}', open)
            return css.slice(open + 1, close)
        }
        const nbMenu = ruleBody('#notebookMenu {')
        assert.ok(/max-height:[^;]*66vh/.test(nbMenu), 'the notebook menu must open at least two-thirds tall (66vh)')
        assert.ok(!/@media/.test(nbMenu), 'the notebook menu height rule must not use @media')
        // Scoped: the shared .dropdown-menu keeps its 320px cap, so the profile and sort menus are unchanged. Anchored to
        // the line-start rule so the lookup does not collide with ".dropdown.-compact .dropdown-menu {".
        assert.ok(/max-height:\s*320px/.test(ruleBody('\n.dropdown-menu {')), 'the shared dropdown cap (profile/sort) must stay 320px')
        // A filtered-out notebook row must actually vanish (the base .dropdown-item display:flex would otherwise win over [hidden]).
        assert.ok(/display:\s*none/.test(ruleBody('.dropdown-item[hidden] {')), 'a filtered notebook row must be hidden')
        // The pinned box colours its background from a --cockpit-* variable (theme-following), not a hard-coded literal.
        assert.ok(/var\(--cockpit-/.test(ruleBody('.notebook-filter {')), 'the pinned filter background must come from a --cockpit-* variable')
    })

    await test('notebook webview: Escape-close is scoped to an OPEN dropdown, the filter is a case-insensitive path substring, Enter picks the first visible', () => {
        // (a) Escape closes an OPEN custom dropdown only - scoped by the selector so it never fires when nothing is open,
        // and so it leaves the search-suggestion and mobile-overlay Escape handlers alone.
        // The selector appears twice now: the bare-Escape selection collapse reads it as a "a dropdown owns this
        // Escape" guard before this handler is reached. The close handler is the later one.
        const escIdx = webviewSource.lastIndexOf('.dropdown > .dropdown-menu:not([hidden])')
        assert.ok(escIdx >= 0, 'the Escape-close must be scoped to an OPEN dropdown (.dropdown > .dropdown-menu:not([hidden]))')
        const escRegion = webviewSource.slice(escIdx - 220, escIdx + 160)
        assert.ok(escRegion.includes("'Escape'"), 'the scoped close must be gated on the Escape key')
        assert.ok(escRegion.includes('closeAllDropdowns()'), 'the scoped Escape must close the open dropdown via closeAllDropdowns()')
        // (b) The live filter: a case-insensitive substring of the full path, read from each data-notebook-row's label.
        // The narrowing itself now lives in the shared applyMenuFilter (the search suggestion list grew the same
        // embedded filter box in 1.9.8), whose match rule is the pure, tested window.SearchTokens.matchesFilter -
        // so this menu is pinned on WHICH rows it narrows, and the rule is exercised for real above.
        const filterBody = handlerBody('filterNotebookMenu')
        assert.ok(filterBody.includes('data-notebook-row'), 'the filter must walk the notebook rows (data-notebook-row)')
        assert.ok(filterBody.includes('applyMenuFilter('), 'the notebook filter must go through the shared narrowing')
        const sharedFilter = handlerBody('applyMenuFilter')
        assert.ok(sharedFilter.includes('window.SearchTokens.matchesFilter('), 'the match rule must be the shared, tested one')
        assert.ok(sharedFilter.includes("setAttribute('hidden'") && sharedFilter.includes("removeAttribute('hidden')"),
            'the filter must show/hide rows by the hidden attribute')
        assert.strictEqual(SearchTokens.matchesFilter('Family / Payments', 'FAM'), true,
            'and that rule is a case-insensitive substring of the full path')
        // (c) Enter selects the first STILL-VISIBLE notebook - the same action as clicking its row - never "All notebooks".
        const keyBody = handlerBody('onNotebookFilterKeyDown')
        assert.ok(keyBody.includes("'Enter'") && keyBody.includes('selectFirstVisibleNotebook('), 'Enter must select the first visible notebook')
        const firstBody = handlerBody('selectFirstVisibleNotebook')
        assert.ok(firstBody.includes('[data-notebook-row]:not([hidden])') && firstBody.includes('.click()'),
            'the first-visible pick must click the first unhidden notebook row (the same action as a click)')
        // (d) Escape is a two-step: clear the text first (swallowed so the menu stays open), then - box empty - fall through
        // to the scoped document handler that closes it.
        assert.ok(/Escape[\s\S]*input\.value[\s\S]*stopPropagation\(\)/.test(keyBody),
            'the first Escape must clear the filter text and be swallowed so the menu stays open')
        // (e) The box auto-focuses on OPEN, desktop only (mobile would pop the soft keyboard).
        const toggleBody = handlerBody('onDropdownToggle')
        assert.ok(toggleBody.includes('notebook-filter-input') && toggleBody.includes('.focus()') && toggleBody.includes('!IS_MOBILE'),
            'opening the notebook menu must reset and (desktop-only) focus the filter box')
    })

    // ============================================================ the notebook picker DIALOG: a drawn list with a filter box
    // The desktop picker ("Create to-do in notebook", "Move to notebook", "Move notebook under...") used to hold a native
    // <select name="folderId">. On a vault with a hundred notebooks that cost it two things: the open popup is a PLATFORM
    // window, so its scrollbar stayed white over a dark theme and no stylesheet could reach it, and there was no way to
    // narrow the list. It is now an ordinary list the plugin draws and themes itself - a filter box pinned above it, one
    // .picker-row per notebook, and a HIDDEN folderId input the dialog's script rewrites, so the result shape stays
    // { picker: { folderId } } and the three checks that already drive this dialog are untouched.
    //
    // The harness renders markup but never runs a dialog's script, so this splits the same way the notebook menu above
    // does: the MARKUP and the CSS the host emits are driven for real here, the runtime behaviour is proved by the pure
    // NotebookPickerModel (below, unit-tested directly - it is the module the dialog's glue asks every question) and by
    // e2e/notebook-picker.spec.ts in the real app.
    const PK_BETA = 'p'.repeat(32), PK_ALPHA = 'q'.repeat(32), PK_ZETA = 'r'.repeat(32), PK_HIDDEN = 's'.repeat(32)
    const pick = await run({
        dataDir: path.join(tmp, 'picker-data'),
        installationDir: path.join(tmp, 'picker-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [],
        folders: [
            { id: PK_BETA, title: 'Beta', parent_id: '' },
            { id: PK_ALPHA, title: 'Alpha', parent_id: '' },
            { id: PK_ZETA, title: 'Zeta', parent_id: PK_ALPHA },      // "Alpha / Zeta" - sorts between Alpha and Beta
            { id: PK_HIDDEN, title: 'Hidden', parent_id: '' },        // excluded below, so it must never be offered
        ],
        // The app is showing Beta, so Beta's row is the one that starts selected.
        selectedFolder: { id: PK_BETA, title: 'Beta' },
    })
    await pick.setSetting('excludedNotebooks', 'Hidden')
    // Two opens, captured one at a time - the dialog is reused, so each setHtml overwrites the last. (1) the move
    // picker, which offers notebooks only; (2) "Move notebook under...", the one flow that offers (top level).
    await pick.panelMessageHandler(['noteMenuActionMulti', 'moveToFolder', ['1'.repeat(32)]])
    const pickMoveHtml = pick.dialogHtml['dialog-notebookPicker']
    await pick.panelMessageHandler(['moveNotebookClicked', PK_ZETA])
    const pickUnderHtml = pick.dialogHtml['dialog-notebookPicker']
    // Every row of one picker's markup, as [id, path] pairs, in emitted order, plus which one carries -selected.
    const pickerRowsOf = (html) => [...String(html).matchAll(/<div class="picker-row([^"]*)" data-id="([^"]*)">([^<]*)<\/div>/g)]
        .map(match => ({ selected: match[1].includes('-selected'), id: match[2], path: match[3] }))

    await test('picker markup: a filter box above a drawn list of every kept notebook, sorted by path, and no native select', () => {
        assert.ok(pickMoveHtml, 'the notebook picker must have been given markup')
        // The form's NAME is what carries the answer back as formData.picker.folderId.
        const formAt = pickMoveHtml.indexOf('<form name="picker"')
        assert.ok(formAt >= 0, 'the picker must still post a form named "picker"')
        const formEnd = pickMoveHtml.indexOf('</form>', formAt)
        assert.ok(formEnd > formAt, 'the picker form must be closed')
        // The filter box is pinned ABOVE the list, and both are inside the form.
        const filterAt = pickMoveHtml.indexOf('class="picker-filter"', formAt)
        const listAt = pickMoveHtml.indexOf('class="picker-list"', formAt)
        assert.ok(filterAt > formAt && listAt > filterAt && listAt < formEnd, 'the filter input must sit above the list, inside the form')
        assert.ok(pickMoveHtml.includes('placeholder="Filter notebooks..."'), 'the filter box must say what it narrows')
        assert.ok(/class="picker-filter"[^>]*\bautofocus\b/.test(pickMoveHtml), 'the filter box must be autofocused (desktop dialog, no soft keyboard)')
        // The white-scrollbar popup this replaced must be gone entirely.
        assert.ok(!pickMoveHtml.includes('<select'), 'the native select must be gone - it is the whole reason for the rework')
        // Rows: every KEPT notebook, by full path, in path order.
        assert.deepStrictEqual(pickerRowsOf(pickMoveHtml).map(row => row.path), ['Alpha', 'Alpha / Zeta', 'Beta'],
            'the rows are every kept notebook, sorted by full path')
        assert.ok(!pickMoveHtml.includes('Hidden'), 'an excluded notebook is never offered')
        assert.ok(!pickMoveHtml.includes(PK_HIDDEN), "nor is the excluded notebook's id")
    })

    await test('picker markup: the answer rides a hidden folderId input inside the form, pre-set to the selected notebook', () => {
        const formAt = pickMoveHtml.indexOf('<form name="picker"')
        const formEnd = pickMoveHtml.indexOf('</form>', formAt)
        const hiddenAt = pickMoveHtml.indexOf('<input type="hidden" name="folderId"', formAt)
        assert.ok(hiddenAt > formAt && hiddenAt < formEnd,
            'the hidden folderId input must live inside form[name=picker] - that is what keeps formData.picker.folderId')
        // Pre-selection: the notebook the app is showing starts selected, in the markup AND in the hidden input, so
        // OK commits it without the user touching anything.
        const rows = pickerRowsOf(pickMoveHtml)
        const selected = rows.filter(row => row.selected)
        assert.strictEqual(selected.length, 1, 'exactly one row starts selected')
        assert.strictEqual(selected[0].path, 'Beta', 'the selected row is the notebook the app is showing')
        assert.ok(pickMoveHtml.includes(`<input type="hidden" name="folderId" value="${PK_BETA}">`),
            'and the hidden input carries that same id, so a bare OK returns it')
    })

    await test('picker markup: "(top level)" is offered first for "Move notebook under...", and never for a note move', () => {
        assert.ok(!pickMoveHtml.includes('(top level)'), 'a note must go into a notebook, so the move picker offers no root row')
        const underRows = pickerRowsOf(pickUnderHtml)
        assert.strictEqual(underRows[0].path, '(top level)', 'the root row is offered FIRST when includeRoot')
        assert.strictEqual(underRows[0].id, '__root', 'and carries the __root sentinel pickNotebook maps back to ""')
        assert.deepStrictEqual(underRows.slice(1).map(row => row.path), ['Alpha', 'Alpha / Zeta', 'Beta'],
            'with the same excluded-filtered, path-sorted notebooks under it')
        // And it is the row that starts SELECTED, as the old dropdown's first option was. Not the notebook the
        // app is showing (Beta here): in this flow that is very often the notebook being moved, so pre-selecting
        // it would offer to make it the parent of itself.
        assert.strictEqual(underRows.filter(row => row.selected).length, 1, 'exactly one row starts selected')
        assert.ok(underRows[0].selected, 'the root row is the pre-selection for "Move notebook under..."')
        assert.ok(pickUnderHtml.includes('<input type="hidden" name="folderId" value="__root">'),
            'and the hidden input starts on __root, which pickNotebook maps back to ""')
    })

    await test('picker css: the scrollbar is themed here (the point of the rework), the dialog height is fixed in pixels, and there is no @media', () => {
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        const start = panelSource.indexOf('async function pickNotebook(')
        assert.ok(start >= 0, 'pickNotebook not found in panel.ts')
        const end = panelSource.indexOf('\n}', panelSource.indexOf('openPluginDialog(notebookPickerDialog)', start))
        assert.ok(end > start, 'could not delimit pickNotebook')
        const body = panelSource.slice(start, end)
        // The reason the <select> went: a drawn list CAN be given a themed, thin scrollbar.
        assert.ok(/\.picker-list::-webkit-scrollbar\s*{[^}]*width:\s*6px/.test(body), 'the list must carry a thin ::-webkit-scrollbar')
        assert.ok(/\.picker-list::-webkit-scrollbar-track\s*{[^}]*background:\s*transparent/.test(body), 'with a transparent track')
        assert.ok(/\.picker-list::-webkit-scrollbar-thumb\s*{[^}]*background:\s*var\(--joplin-/.test(body),
            'and a thumb coloured from the theme, which is what the white platform scrollbar could never be')
        // Joplin sizes a fit-to-content dialog from this markup; a viewport query has no business in it, and a vh
        // cap would answer to a viewport the dialog does not have.
        assert.ok(!body.includes('@media'), 'a dialog stylesheet must never carry an @media rule')
        const contentRule = body.slice(body.indexOf('#joplin-plugin-content {'), body.indexOf('.picker-form {'))
        assert.ok(/width:\s*380px/.test(contentRule), 'the dialog is widened for long notebook paths')
        // HEIGHT, not max-height: the frame re-centres itself on every content resize, so a box that can shrink
        // while the user filters makes the whole dialog jump. A fixed height cannot.
        assert.ok(/height:\s*\$\{pickerDialogHeight\(\)\}px/.test(contentRule),
            'the dialog must be given a FIXED pixel height from the reported viewport, never a max-height')
        assert.ok(!/max-height/.test(contentRule), 'a max-height would let the frame shrink and jump again')
        // And the list fills whatever that fixed height leaves, rather than sizing itself from its rows.
        const listRule = body.slice(body.indexOf('.picker-list {'), body.indexOf('.picker-list::-webkit-scrollbar'))
        assert.ok(/flex:\s*1 1 auto/.test(listRule) && /min-height:\s*0/.test(listRule) && /overflow-y:\s*auto/.test(listRule),
            'the list must fill the fixed height and scroll inside it (min-height:0, or a flex item refuses to shrink)')
        assert.ok(!/max-height/.test(listRule), 'the list must not cap itself - the dialog height is what bounds it now')
        // A filtered-out row must actually vanish: .picker-row sets display, which would otherwise beat [hidden].
        assert.ok(/\.picker-row\[hidden\]\s*{[^}]*display:\s*none/.test(body), 'a filtered-out row must be hidden')
        // Colours follow the theme with a literal fallback, as the old <option> rule did.
        assert.ok(/\.picker-row\s*{[^}]*color:\s*var\(--joplin-color,/.test(body), 'row text follows the theme')
        assert.ok(/\.picker-row\.-selected\s*{[^}]*var\(--joplin-selected-color,/.test(body), 'the selected row follows the theme')
    })

    await test('picker height: fixed, sized from the panel viewport, clamped, and 420px until a panel has reported one', async () => {
        const dialogCss = () => String(pick.dialogHtml['dialog-notebookPicker'])
        const openPicker = () => pick.panelMessageHandler(['noteMenuActionMulti', 'moveToFolder', ['1'.repeat(32)]])
        // (a) The opens above happened before any webview reported a height, which is also every pre-2.6 webview
        // and every run that never posts: the dialog falls back to a constant rather than to no height at all.
        assert.ok(pickMoveHtml.includes('height: 420px'), 'with no viewport ever reported the dialog falls back to 420px')
        // (b) The report itself is pure state - it must not repaint the panel or cost a request. A window resize
        // posts this, and a resize has no business re-rendering the list.
        const paintsBefore = pick.setHtmlCalls
        const getsBefore = pick.gets.length
        await pick.panelMessageHandler(['viewportHeight', 1000])
        assert.strictEqual(pick.setHtmlCalls, paintsBefore, 'a viewport report must not repaint the panel')
        assert.strictEqual(pick.gets.length, getsBefore, 'nor issue a single request')
        // (c) 0.62 of the reported viewport, in pixels, on the content box Joplin measures.
        await openPicker()
        assert.ok(dialogCss().includes('height: 620px'), 'a 1000px panel gives a 620px dialog (0.62 of the viewport)')
        // (d) Clamped at both ends: a tiny window must not produce a three-row dialog, a huge one must not
        // produce a strip taller than the screen.
        await pick.panelMessageHandler(['viewportHeight', 500])
        await openPicker()
        assert.ok(dialogCss().includes('height: 360px'), 'a small panel is clamped up to the 360px floor while the window can hold it')
        // The floor yields to a window too short for it: 400 - 140 = 260 beats both the floor and 0.62 * 400 = 248, so the
        // dialog's top edge (title and filter box) is never centred off the screen.
        await pick.panelMessageHandler(['viewportHeight', 400])
        await openPicker()
        assert.ok(dialogCss().includes('height: 260px'), 'a window too short for the floor gets viewport - 140 instead')
        await pick.panelMessageHandler(['viewportHeight', 2000])
        await openPicker()
        assert.ok(dialogCss().includes('height: 880px'), 'a large panel is clamped down to the 880px ceiling')
        // (e) A nonsense report is ignored rather than stored, so the last good height stands.
        await pick.panelMessageHandler(['viewportHeight', 0])
        await openPicker()
        assert.ok(dialogCss().includes('height: 880px'), 'a zero height is ignored, not taken as a new viewport')
        // (f) The webview end: posted on load and on a throttled resize, never on every frame of a drag.
        const webviewSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panelWebview.js'), 'utf8')
        assert.ok(/webviewApi\.postMessage\(\['viewportHeight', height\]\)/.test(webviewSrc), 'the panel must report its own inner height')
        assert.ok(/window\.addEventListener\('resize', queueViewportPost\)/.test(webviewSrc), 'and re-report it when the window is resized')
        const queueBody = handlerBody('queueViewportPost')
        assert.ok(/setTimeout\([\s\S]*300\)/.test(queueBody), 'the resize report must be throttled, like the scroll post')
        assert.ok(handlerBody('startPanelObserver').includes('postViewportHeight()'), 'and posted once on load, before any resize happens')
    })

    await test('notebook overlay: its height is locked on open, so filtering cannot shrink and re-centre it (mobile)', () => {
        const overlayBody = handlerBody('openNotebookOverlay')
        // The same jump as the desktop dialog: the overlay panel is centred and capped at 90vh, so hiding rows
        // shrinks it and it re-centres under the finger.
        assert.ok(/overlayPanelEl\.style\.height = overlayPanelEl\.offsetHeight \+ 'px'/.test(overlayBody),
            'the overlay panel must be locked to its rendered height')
        assert.ok(overlayBody.includes('if (IS_MOBILE){'), 'mobile only - the desktop panel has no overlay')
        // Taken AFTER the rows are in the DOM, or the measurement is of an empty panel.
        const lockAt = overlayBody.indexOf('overlayPanelEl.offsetHeight')
        const rowsAt = overlayBody.indexOf('body.appendChild(list)')
        assert.ok(rowsAt >= 0 && lockAt > rowsAt, 'the height must be read after the rows are in the DOM, not before')
        // The 90vh cap stays: it is what produced the height being locked in.
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        assert.ok(/\.cockpit-overlay-panel\s*{[^}]*max-height:\s*90vh/.test(css), 'the overlay must keep its 90vh cap')
    })

    await test('picker scripts: the dialog loads the shared matcher, then the pure model, then the glue - and all three ship in dist', () => {
        const loaded = pick.dialogScripts.filter(entry => entry.handle === 'dialog-notebookPicker').map(entry => entry.script)
        assert.deepStrictEqual(loaded, ['/ui/panel/searchTokens.js', '/ui/panel/notebookPickerModel.js', '/ui/panel/notebookPickerWebview.js'],
            'the matcher and the model must be in place before the glue that calls them')
        // The registered paths are a promise the build has to keep: a webview script is copied verbatim into dist
        // (and from there into the .jpl), so a file that is not there is a dialog that throws on open.
        for (const file of ['searchTokens.js', 'notebookPickerModel.js', 'notebookPickerWebview.js']){
            assert.ok(fs.existsSync(path.join(__dirname, '..', 'dist', 'ui', 'panel', file)),
                `dist/ui/panel/${file} must be built - the dialog asks Joplin for it by that path`)
        }
    })

    await test('picker glue: the rows are read from the markup, never built, and every decision goes through the pure model', () => {
        const glue = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'notebookPickerWebview.js'), 'utf8')
        // The dialog's FIRST measurement is taken from the markup the host wrote, before this script runs, so a
        // list built from script would open at the height of an empty dialog and then jump. The glue reads rows.
        assert.ok(glue.includes("querySelectorAll('.picker-row')"), 'the glue must read the rows the host emitted')
        assert.ok(!/createElement\(/.test(glue), 'the glue must never build rows (the dialog is first sized before it runs)')
        // The rows are plain divs, so a click on one drops focus to <body> - after which Enter reaches nothing
        // and Escape cancels the dialog instead of clearing the filter. The caret goes back to the box.
        assert.ok(glue.includes('function focusPickerFilter('), 'the glue must be able to hand the caret back to the filter box')
        const clickBody = glue.slice(glue.indexOf('function onPickerListClick('), glue.indexOf('function onPickerListDoubleClick('))
        assert.ok(clickBody.includes('focusPickerFilter()'), 'a row click must refocus the filter box, so the keyboard keeps working')
        // No forked logic: the four questions are all asked of the shared module.
        for (const call of ['visibleIndexes(', 'moveHighlight(', 'enterTarget(', 'escapeAction(']){
            assert.ok(glue.includes('window.NotebookPickerModel.' + call), `the glue must ask the model ${call}`)
        }
        // The bootstrap: a dialog's scripts are injected after the document is parsed and the SAME document is
        // reused for the next open, so init can be gated neither on DOMContentLoaded alone nor on running once.
        assert.ok(/new MutationObserver\(initNotebookPickerIfNeeded\)/.test(glue), 'init must re-run for each freshly written form')
        assert.ok(glue.includes("document.readyState === 'loading'"), 'and must not wait for a DOMContentLoaded that has already fired')
    })

    // The pure model itself, driven directly - this is where the runtime behaviour of the filter and the keyboard is
    // actually proved, since the Node harness cannot execute a dialog webview.
    const NotebookPickerModel = require('../src/ui/panel/notebookPickerModel.js')
    const pickerModelRows = [
        { id: 'a', path: 'Alpha' },
        { id: 'b', path: 'Alpha / Beta' },
        { id: 'c', path: 'Gamma' },
        { id: 'd', path: 'Gamma / Beta' },
    ]

    await test('picker model: the filter is a case-insensitive substring of the FULL path, and an empty box keeps everything', () => {
        assert.deepStrictEqual(NotebookPickerModel.visibleIndexes(pickerModelRows, ''), [0, 1, 2, 3], 'an empty filter keeps every row')
        assert.deepStrictEqual(NotebookPickerModel.visibleIndexes(pickerModelRows, '   '), [0, 1, 2, 3], 'so does a blank one')
        assert.deepStrictEqual(NotebookPickerModel.visibleIndexes(pickerModelRows, 'BETA'), [1, 3], 'case-insensitive')
        assert.deepStrictEqual(NotebookPickerModel.visibleIndexes(pickerModelRows, 'alpha /'), [1], 'the PARENT part of the path matches too')
        assert.deepStrictEqual(NotebookPickerModel.visibleIndexes(pickerModelRows, 'zzz'), [], 'no match leaves nothing visible')
        assert.strictEqual(NotebookPickerModel.isVisible(pickerModelRows, 2, 'beta'), false, 'a row the filter hid is not visible')
        assert.strictEqual(NotebookPickerModel.isVisible(pickerModelRows, 3, 'beta'), true, 'a row it kept is')
    })

    await test('picker model: the arrows walk the VISIBLE rows and wrap, and a hidden highlight enters from the near end', () => {
        // Unfiltered: plain stepping, wrapping at both ends.
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, '', 0, 1), 1, 'down steps to the next row')
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, '', 3, 1), 0, 'down from the last wraps to the first')
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, '', 0, -1), 3, 'up from the first wraps to the last')
        // Filtered: the hidden rows are stepped OVER, not through - 1 and 3 are the only visible ones.
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, 'beta', 1, 1), 3, 'down skips the hidden rows between')
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, 'beta', 3, 1), 1, 'and wraps over them')
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, 'beta', 1, -1), 3, 'up wraps the same way')
        // A highlight the filter has hidden is not a position to step from: enter from the near end instead.
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, 'beta', 0, 1), 1, 'down from a hidden row lands on the first visible')
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, 'beta', 0, -1), 3, 'up from a hidden row lands on the last visible')
        assert.strictEqual(NotebookPickerModel.moveHighlight(pickerModelRows, 'zzz', 0, 1), -1, 'with nothing visible there is nowhere to go')
    })

    await test('picker model: Enter commits the highlight when it survived the filter, otherwise the first visible row', () => {
        assert.strictEqual(NotebookPickerModel.enterTarget(pickerModelRows, '', 2), 2, 'an unfiltered Enter commits what is highlighted')
        assert.strictEqual(NotebookPickerModel.enterTarget(pickerModelRows, 'beta', 3), 3, 'a highlight that survived the filter is kept')
        assert.strictEqual(NotebookPickerModel.enterTarget(pickerModelRows, 'beta', 0), 1,
            'a highlight the filter hid gives way to the first visible row - type, press Enter, done')
        assert.strictEqual(NotebookPickerModel.enterTarget(pickerModelRows, 'beta', -1), 1, 'so does having no highlight at all')
        assert.strictEqual(NotebookPickerModel.enterTarget(pickerModelRows, 'zzz', 1), -1, 'and a filter matching nothing commits nothing')
    })

    await test('picker glue: the selection follows the filter - re-pointed when it is hidden, emptied when nothing matches', () => {
        const glue = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'notebookPickerWebview.js'), 'utf8')
        // The selection IS the answer - it is what the hidden input carries and what an OK click commits. Leaving
        // it on a row the filter has just hidden means "type beta, see one row, click OK" files the note in the
        // notebook that WAS highlighted, one the user can no longer see; a filter matching nothing commits the
        // stale id the same way. So every filter pass re-points the selection, by the rule Enter uses.
        const filterBody = glue.slice(glue.indexOf('function applyPickerFilter('), glue.indexOf('function clearPickerSelection('))
        assert.ok(filterBody.includes('window.NotebookPickerModel.enterTarget('),
            'applyPickerFilter must re-point the selection through the model, not merely show and hide rows')
        assert.ok(/if \(target >= 0\) selectPickerRow\(/.test(filterBody), 'a surviving target is selected (highlight + hidden input)')
        assert.ok(filterBody.includes('clearPickerSelection()'), 'and no target at all clears the selection')
        // Cleared means EMPTY, not "left as it was": an empty folderId makes pickNotebook return null, and all
        // three callers abort on null. Only the "(top level)" row answers with a deliberate "", via __root.
        const clearBody = glue.slice(glue.indexOf('function clearPickerSelection('), glue.indexOf('/** submitPicker'))
        assert.ok(/pickerSelectedIndex\s*=\s*-1/.test(clearBody), 'clearing must drop the selected index')
        assert.ok(clearBody.includes("classList.remove('-selected')"), 'and unmark every row')
        assert.ok(/hidden\.value\s*=\s*''/.test(clearBody), 'and empty the hidden folderId input')
        // The host half of that contract, unchanged: "" comes back as null, and only __root survives as "".
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        assert.ok(/if \(picked === "__root"\) return ""/.test(panelSource), 'the root sentinel must still map to the empty string')
        assert.ok(/return picked \|\| null/.test(panelSource), 'and any other empty answer must come back as null (cancelled)')
        // The rule itself, exercised: a hidden highlight gives way to the first visible row, and nothing visible
        // commits nothing. (enterTarget is what applyPickerFilter asks, so these are the two cases it handles.)
        assert.strictEqual(NotebookPickerModel.enterTarget(pickerModelRows, 'beta', 0), 1,
            'a selection the filter hid moves to the first visible row')
        assert.strictEqual(NotebookPickerModel.enterTarget(pickerModelRows, 'zzz', 0), -1,
            'and with nothing visible there is no target at all, so the answer is emptied')
    })

    await test('picker model: the shared matcher is looked up per CALL, never bound at load', () => {
        const modelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'notebookPickerModel.js'), 'utf8')
        // joplin.views.dialogs.addScript appends ordinary classic scripts without async=false, so the dialog's
        // three files run in whatever order they finish fetching. A binding taken at load would be null for the
        // life of the dialog whenever this file wins the race against searchTokens.js - and the host's own Enter
        // handler would go on submitting the pre-selection while the filter, the arrows and Enter all threw.
        assert.ok(modelSource.includes('var api = factory()'), 'the factory must not be handed a pre-resolved matcher')
        const tokensAt = modelSource.indexOf('function tokens(){')
        assert.ok(tokensAt >= 0, 'the model must resolve the matcher through a tokens() getter')
        const tokensEnd = modelSource.indexOf('\n    }', tokensAt)
        assert.ok(tokensEnd > tokensAt, 'could not delimit tokens()')
        const reads = []
        for (let at = modelSource.indexOf('window.SearchTokens'); at !== -1; at = modelSource.indexOf('window.SearchTokens', at + 1)) reads.push(at)
        assert.ok(reads.length > 0, 'the model must read the shared matcher off the global somewhere')
        for (const at of reads){
            assert.ok(at > tokensAt && at < tokensEnd,
                'every window.SearchTokens read must sit INSIDE tokens() - a load-time binding cannot survive the script race')
        }
        assert.ok(modelSource.slice(tokensAt, tokensEnd).includes("require('./searchTokens.js')"),
            'with the Node fallback in the same getter, so the harness reaches the one implementation too')
    })

    await test('picker model: a dialog whose scripts load out of order still filters once the matcher arrives', () => {
        // The race, run for real rather than asserted: evaluate the model in a context that HAS a window but no
        // SearchTokens on it yet and no require to fall back on - exactly a dialog where this file beat
        // searchTokens.js - then let the matcher arrive afterwards, as the slower script would.
        const vm = require('vm')
        const modelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'notebookPickerModel.js'), 'utf8')
        const dialogWindow = { window: {} }
        vm.createContext(dialogWindow)
        vm.runInContext(modelSource, dialogWindow)
        const racedModel = dialogWindow.window.NotebookPickerModel
        assert.ok(racedModel, 'the model must still install itself on the window when it loads first')
        dialogWindow.window.SearchTokens = SearchTokens          // searchTokens.js finishes loading a moment later
        // Array.from, because an array made inside the vm carries THAT realm's Array.prototype and would fail a
        // deepStrictEqual on its prototype rather than on its contents.
        assert.deepStrictEqual(Array.from(racedModel.visibleIndexes(pickerModelRows, 'beta')), [1, 3],
            'the filter must work from the first keystroke after the matcher arrives, not throw for the life of the dialog')
        assert.strictEqual(racedModel.enterTarget(pickerModelRows, 'beta', 0), 1, 'and so must Enter')
        assert.strictEqual(racedModel.moveHighlight(pickerModelRows, 'beta', 1, 1), 3, 'and the arrows')
    })

    await test('picker model: Escape is the dropdown\'s two-step - clear the text first, then leave the press to Joplin', () => {
        assert.strictEqual(NotebookPickerModel.escapeAction('fam'), 'clear', 'the first Escape clears the filter')
        assert.strictEqual(NotebookPickerModel.escapeAction(' '), 'clear', 'even a lone space is text the user typed')
        assert.strictEqual(NotebookPickerModel.escapeAction(''), 'dismiss', 'an empty box is left to Joplin, which cancels the dialog')
        assert.strictEqual(NotebookPickerModel.escapeAction(null), 'dismiss', 'and so is an absent one')
    })

    // The mobile half of the same rework: the in-panel notebook overlay (the picker Android gets, since a plugin
    // dialog there is always drawn behind the panel) grows the same filter box. Source-shape pins, as every other
    // webview check is - the harness renders markup but never runs panelWebview.js.
    await test('notebook overlay: a filter box above the list, narrowing through the shared matcher, and never focused', () => {
        const overlayBody = handlerBody('openNotebookOverlay')
        assert.ok(overlayBody.includes("'cockpit-overlay-input -filter'"), 'the overlay must carry a filter box, reusing the overlay input skin')
        assert.ok(overlayBody.includes("placeholder = 'Filter notebooks...'"), 'and say what it narrows, in the dropdown\'s wording')
        // Pinned ABOVE the list: appended to the body first.
        const boxAt = overlayBody.indexOf('body.appendChild(filterBox)')
        const listAt = overlayBody.indexOf('body.appendChild(list)')
        assert.ok(boxAt >= 0 && listAt > boxAt, 'the filter box must be appended above the row list')
        // Never focused on open: a focus pops the Android soft keyboard over the list the user came to read.
        assert.ok(!overlayBody.includes('.focus()'), 'the overlay filter box must NOT be focused (it would pop the soft keyboard)')
        // The narrowing is the shared, tested rule - not a second substring test written here.
        const narrowBody = handlerBody('filterNotebookOverlay')
        assert.ok(narrowBody.includes('window.SearchTokens.matchesFilter('), 'the overlay filter must use the shared match rule')
        assert.ok(narrowBody.includes("setAttribute('hidden'") && narrowBody.includes("removeAttribute('hidden')"),
            'and show/hide rows by the hidden attribute')
        // A selection the filter has hidden must not survive: OK commits overlayNotebookSelection, so committing
        // a row the user can no longer see is the desktop dialog's own bug in overlay form.
        assert.ok(/overlayNotebookSelection\s*=\s*null/.test(narrowBody),
            'a selection the overlay filter hides must be cleared, so OK cannot commit an invisible notebook')
        assert.ok(narrowBody.includes("classList.remove('-selected')"), 'and its highlight must go with it')
        // Enter picks the first still-visible row - the same action as tapping it.
        const overlayKeyBody = handlerBody('onNotebookOverlayFilterKeyDown')
        assert.ok(overlayKeyBody.includes("'Enter'") && overlayKeyBody.includes(':not([hidden])') && overlayKeyBody.includes('.click()'),
            'Enter must select the first still-visible row, by clicking it')
        // A narrowed-away row must actually vanish: .cockpit-overlay-item sets display:flex, which beats [hidden].
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        assert.ok(/\.cockpit-overlay-item\[hidden\]\s*{[^}]*display:\s*none/.test(css), 'a narrowed-away overlay row must be hidden')
        assert.ok(/\.cockpit-overlay-input\.-filter\s*{[^}]*min-height:\s*40px/.test(css), 'the box must keep the 40px touch height')
    })

    await test('notebook overlay: the typed filter rides in the reload-survival descriptor, and a reconstruct re-narrows the list', () => {
        const descriptorBody = handlerBody('currentOverlayDescriptor')
        const notebookBranch = descriptorBody.slice(descriptorBody.indexOf("kind === 'notebook'"), descriptorBody.indexOf("kind === 'tag'"))
        assert.ok(notebookBranch.includes('filter:'), 'the notebook descriptor must carry the filter text')
        assert.ok(notebookBranch.includes('notebookOverlayFilterInput()'), 'read live from the box, like the tag overlay reads its input')
        const overlayBody = handlerBody('openNotebookOverlay')
        assert.ok(/filter:\s*\(restore && restore\.filter\)/.test(overlayBody), 'a reconstruct must start from the saved filter text')
        assert.ok(overlayBody.includes('filterBox.value = overlayContext.filter'), 'which is put back into the box')
        assert.ok(/if \(overlayContext\.filter\) filterNotebookOverlay\(\)/.test(overlayBody),
            'and applied to the freshly built rows, so the reconstructed list is narrowed as the user left it')
        // The typing itself is throttled onto the descriptor channel, like every other overlay input.
        assert.ok(handlerBody('onNotebookOverlayFilterInput').includes('queueOverlayState()'),
            'typing must post the descriptor (throttled), so a reload has the latest text')
    })

    // ============================================================ 1.9.5: outside dismissal, editor-note highlight, create buttons
    // Three changes ship together here. (1) The custom context menu (Cockpit draws its own, because Joplin's native note
    // menu cannot be opened from a plugin webview) stayed open when the user clicked the main editor: the panel is an
    // IFRAME, so such a click reaches neither this document nor - when it lands in another Joplin webview - the main one.
    // (2) The row highlight now follows the note the MAIN editor shows, with notes opened in a SECONDARY Joplin window
    // deliberately ignored. (3) The create buttons lose their plus-bearing icons and degrade in two stages instead of
    // wrapping. The harness renders the panel markup but never executes the webview JS, so the webview halves are pinned
    // by source shape (as the row-click / notebook-filter checks above are) and the host half is driven for real.
    const panelCssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
    const iconsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'icons.ts'), 'utf8')

    await test('outside dismiss: the menu closes on the panel window blur AND on a press in the parent document, desktop only', () => {
        const body = handlerBody('dismissPanelPopups')
        assert.ok(body.includes('if (IS_MOBILE) return'), 'the outside dismissal must be desktop-only (mobile has no outside)')
        assert.ok(body.includes('hideNoteContextMenu()'), 'it must close the custom context menu')
        assert.ok(body.includes('closeAllDropdowns()'), 'it must close the panel dropdowns / suggestion list on the same signal')
        // Signal 1: this iframe's own window blur - the only thing that fires when focus goes to ANOTHER webview
        // (the rendered note viewer is an iframe of its own, whose events reach neither document).
        assert.ok(/window\.addEventListener\('blur', dismissPanelPopups\)/.test(webviewSource),
            "the panel window's blur must dismiss the popups")
        // Signal 2: a capturing mousedown on the PARENT document - a press outside the panel even when it never had focus.
        assert.ok(/parentWindow\.addEventListener\('mousedown', dismissPanelPopups, true\)/.test(webviewSource),
            'a press in the main window must dismiss the popups (capture, on the parent document)')
        // The menu takes focus when it opens, so there is always focus to lose; desktop only.
        const menuBody = handlerBody('showNoteContextMenu')
        assert.ok(/if \(!IS_MOBILE\)\{[\s\S]*menu\.tabIndex = -1[\s\S]*menu\.focus\(/.test(menuBody),
            'the menu must take focus on desktop so the blur dismissal has focus to lose')
        // Closing the menu hands focus back to whatever held it - but NEVER on the outside-click path: the
        // parent's capturing mousedown runs BEFORE the browser moves focus to the clicked element, so the
        // other two guards still read "menu has focus, in the focused window" and the panel would pull focus
        // back out of the click the user just made.
        assert.ok(body.includes('dismissingFromOutside = true'), 'an outside dismissal must mark itself')
        assert.ok(/var restore = !dismissingFromOutside &&/.test(handlerBody('hideNoteContextMenu')),
            'the focus hand-back must be suppressed for an outside dismissal, and kept for Escape / an item click')
        // Taking focus must not make the menu LOOK focused: it is a container, not a keyboard control, and
        // without this it picks up the browser's :focus-visible ring (which follows the desktop accent
        // colour on Linux). Both states are covered so a host theme styling either is neutralised, and the
        // suppression is scoped to the container so the items keep their own hover/keyboard styling.
        assert.ok(/#noteContextMenu:focus,\s*#noteContextMenu:focus-visible \{[^}]*outline:\s*none/.test(panelCssSource),
            'the focused menu must not paint a focus ring, in either focus state')
        assert.ok(!/\.context-menu-item[^{]*:focus[^{]*\{[^}]*outline:\s*none/.test(panelCssSource),
            'the suppression must not reach the menu items')
        // The pre-existing in-panel dismissals are untouched.
        // The scroll dismissal stays, with ONE exemption: a hold that has armed the touch drag owns its menu, and
        // a pan arriving under it must not close it (the third Pixel round's "the context menu doesn't appear at
        // all"). Desktop never has an armed gesture, so the dismissal there is exactly what it was.
        assert.ok(/document\.addEventListener\('scroll', function\(\)\{\s*if \(touchDrag && touchDrag\.active && !touchDrag\.lifted\) return\s*hideNoteContextMenu\(\)\s*\}, true\)/.test(webviewSource),
            'the scroll dismissal must stay, standing aside only for an ARMED (never a lifted, never a desktop) gesture')
        assert.ok(/event\.key === 'Escape'\) hideNoteContextMenu\(\)/.test(webviewSource), 'the Escape dismissal must stay')
    })

    // -- the highlight rules, driven for real ------------------------------------------------------------------
    // The decision "what does an editor change do to the highlight and to the panel's own selection" lives in a
    // pure, DOM-free module (editorNote.js) exactly so it can be EXERCISED here rather than pattern-matched in the
    // webview source: the earlier source-shape-only cover let two wrong rules through (an unrelated selection
    // change wiping a deliberate multi-selection, and an external open of a selected note leaving that whole
    // selection armed for the next drag). The webview is then only asserted to delegate to it.
    const EditorNote = require('../src/ui/panel/editorNote.js')
    const applyNote = (selected, id, extra) => EditorNote.nextSelection(
        Object.assign({ selected, picked: null, lastClicked: selected.length ? selected[0] : null }, extra), id)

    await test('editor highlight: the highlight always moves to the open note, and never joins the selection', () => {
        const next = applyNote([], id32('e1'))
        assert.strictEqual(next.picked, id32('e1'), 'the open note must become the highlight')
        assert.deepStrictEqual(next.selected, [], 'and must NOT enter the drag/batch selection')
        // "No single note is open" (Joplin's own list holds several, or none) clears the highlight.
        assert.strictEqual(applyNote([], '').picked, null, 'an empty id must clear the highlight')
        assert.strictEqual(applyNote([], null).picked, null, 'a null id must clear the highlight')
    })

    await test('editor highlight: a DELIBERATE multi-selection survives every editor change (M3)', () => {
        // Joplin emits selection changes for reasons that have nothing to do with the panel - clicking a notebook
        // in the sidebar auto-selects its first note, a sync or an alarm moves the cursor. None of them may destroy
        // a multi-row selection the user is halfway through building.
        const ids = [id32('m1'), id32('m2'), id32('m3')]
        const unrelated = EditorNote.nextSelection({ selected: ids, picked: null, lastClicked: ids[0] }, id32('zz'))
        assert.deepStrictEqual(unrelated.selected, ids, 'an unrelated open must leave the multi-selection intact')
        assert.strictEqual(unrelated.picked, id32('zz'), 'while the highlight still moves to the open note')
        assert.strictEqual(unrelated.lastClicked, ids[0], "and the user's Shift anchor is left alone")
        // Same when the opened note happens to BE one of the selected rows (M4): the set is user-owned either way.
        const member = EditorNote.nextSelection({ selected: ids, picked: null, lastClicked: ids[0] }, ids[1])
        assert.deepStrictEqual(member.selected, ids, 'opening a member of the selection must not silently trim it')
        assert.strictEqual(member.picked, ids[1], 'the highlight follows the opened member')
        // Clearing the highlight (no single note open) must not take the selection with it either.
        assert.deepStrictEqual(EditorNote.nextSelection({ selected: ids, picked: ids[0], lastClicked: null }, '').selected, ids,
            'losing the open note must not clear a multi-selection')
    })

    await test('editor highlight: a lone selected row is kept only when it IS the opened note', () => {
        const own = id32('s1')
        // Cockpit's own row-click open: the click collapsed the selection onto the row, then the open arrives.
        const kept = applyNote([own], own)
        assert.deepStrictEqual(kept.selected, [own], "Cockpit's own open must keep the row it just selected")
        assert.strictEqual(kept.picked, own)
        // The editor genuinely moving elsewhere drops the now-stale single selection AND moves the highlight.
        const moved = applyNote([own], id32('s2'))
        assert.deepStrictEqual(moved.selected, [], 'a stale single selection must not be left behind')
        assert.strictEqual(moved.picked, id32('s2'), 'the highlight moves to the newly opened note')
        assert.strictEqual(moved.lastClicked, id32('s2'), 'the Shift anchor follows the highlight when the selection is dropped')
        // A note the panel does not list is simply an id that matches no row: the highlight is effectively removed.
        assert.deepStrictEqual(applyNote([own], '').selected, [], 'no open note clears a single selection')
        assert.strictEqual(applyNote([own], '').picked, null)
    })

    await test('editor highlight: a push is accepted only from the window the panel lives in (secondary windows)', () => {
        // Joplin keeps ONE store whose top-level selection belongs to the FOCUSED window, so a secondary window's
        // note arrives as an ordinary selection change. Only the webview can tell which window has focus.
        assert.strictEqual(EditorNote.acceptsPush({ isMobile: false, windowFocused: true }), true,
            "a push must apply while the panel's own window is focused")
        assert.strictEqual(EditorNote.acceptsPush({ isMobile: false, windowFocused: false }), false,
            'a push arriving while another window (or another app) holds the focus must be ignored')
        assert.strictEqual(EditorNote.acceptsPush({ isMobile: true, windowFocused: false }), true,
            'mobile has no second window, so it always applies')
        assert.strictEqual(EditorNote.acceptsPush(), false, 'a missing context must not be read as focused')
    })

    // -- Escape collapses a multi-selection to one row ---------------------------------------------------------
    await test('escape collapse: the LAST row the user selected survives, the same way for Shift and Ctrl', () => {
        const order = [id32('r1'), id32('r2'), id32('r3'), id32('r4')]
        // A Shift range r1..r3 pressed at r3: the far END of the range is the last thing selected, NOT the
        // anchor it was measured from. (This is the case that changed: the anchor used to win here.)
        assert.deepStrictEqual(EditorNote.collapseSelection([order[0], order[1], order[2]], order[2], order), [order[2]],
            'a Shift range collapses onto the row that was just pressed')
        // A range dragged UPWARDS (anchor r4, pressed r2) keeps the pressed row just the same.
        assert.deepStrictEqual(EditorNote.collapseSelection([order[1], order[2], order[3]], order[1], order), [order[1]],
            'the direction the range was built in makes no difference')
        // A Ctrl-built set collapses onto the last Ctrl+press that ADDED a row, wherever it sits in the list.
        assert.deepStrictEqual(EditorNote.collapseSelection([order[2], order[0], order[1]], order[0], order), [order[0]],
            'a Ctrl set collapses onto the last row added, not the topmost one')
    })

    await test('escape collapse: without a usable last selection the TOPMOST selected row in list order survives', () => {
        const order = [id32('r1'), id32('r2'), id32('r3'), id32('r4')]
        // A Ctrl+press that DESELECTS records nothing, so the last recorded row is the one selected before it -
        // and if THAT row has since been deselected too, the collapse falls through to the topmost selected row.
        assert.deepStrictEqual(EditorNote.collapseSelection([order[2], order[1]], order[0], order), [order[1]],
            'a recorded row that is no longer selected falls back to the topmost selected row')
        assert.deepStrictEqual(EditorNote.collapseSelection([order[2], id32('gone')], id32('gone'), order), [order[2]],
            'a recorded row that has left the list falls back the same way')
        assert.deepStrictEqual(EditorNote.collapseSelection([id32('x'), id32('y')], id32('q'), order), [id32('x')],
            'a selection whose rows are all off the list still collapses to exactly one')
    })

    await test('escape collapse: one or no selected rows are left exactly as they are', () => {
        const order = [id32('r1'), id32('r2')]
        // Slava asked for collapse-to-one, not deselect-all: a single selection must survive Escape untouched.
        assert.deepStrictEqual(EditorNote.collapseSelection([order[1]], order[0], order), [order[1]], 'a single selection is a no-op')
        assert.deepStrictEqual(EditorNote.collapseSelection([], order[0], order), [], 'an empty selection is a no-op')
    })

    await test('escape collapse (webview): the last SELECTING press is recorded, and it is not the range anchor', () => {
        // Behavioural now that the rule is a pure module: the two anchors move independently, and only a press
        // that actually SELECTS moves the one an Escape collapses onto.
        const order = [rowId('a'), rowId('b'), rowId('c'), rowId('d')]
        // A Shift range records the row just pressed - the far end - while the anchor deliberately stays put so a
        // further Shift+press resizes the range instead of chaining from its end.
        const ranged = RowSelection.pressSelection({ selected: [order[0]], lastClicked: order[0], lastInteraction: order[0] }, order[2], { shift: true }, order)
        assert.deepStrictEqual(ranged.selected, [order[0], order[1], order[2]], 'the Shift range must run anchor -> pressed row')
        assert.strictEqual(ranged.lastInteraction, order[2], 'a Shift range must record the row just pressed as the last selection')
        assert.strictEqual(ranged.lastClicked, order[0], 'the Shift branch must NOT move the range anchor')
        // A Ctrl+press records only when it ADDS: a press that deselects points at a row that is no longer in
        // the selection, so the last row actually selected stays the one an Escape collapses onto.
        const added = RowSelection.pressSelection({ selected: [order[0]], lastClicked: order[0], lastInteraction: order[0] }, order[3], { ctrl: true }, order)
        assert.deepStrictEqual(added.selected, [order[0], order[3]], 'a Ctrl+press must add the row')
        assert.strictEqual(added.lastInteraction, order[3], 'and record it as the last selection')
        const removed = RowSelection.pressSelection({ selected: [order[0], order[3]], lastClicked: order[3], lastInteraction: order[3] }, order[3], { ctrl: true }, order)
        assert.deepStrictEqual(removed.selected, [order[0]], 'a Ctrl+press on a selected row must deselect it')
        assert.strictEqual(removed.lastInteraction, order[3], 'a deselecting press must not record a new last selection')
        assert.strictEqual(removed.lastClicked, order[3], 'but it still moves the range anchor')
        // The webview writes both back, and the collapse is driven by the last SELECTING press.
        const body = handlerBody('onRowPressed')
        assert.ok(body.includes('lastClickedRowID = next.lastClicked') && body.includes('lastSelectionInteractionID = next.lastInteraction'),
            'the webview must write both anchors back from the shared decision')
        assert.ok(handlerBody('collapseMultiSelection').includes('lastSelectionInteractionID'),
            'the collapse must be driven by the last selecting press, not by the range anchor')
    })

    await test('mixed selection: a NOTE row selects exactly like a to-do row, and the collapse order spans both', () => {
        // The 2.1.0 headline. Up to 2.0.0 a press on a note row CLEARED the selection and only lit the
        // highlight-only pickedNoteID; the two row handlers are now one path, so a note row Ctrl/Shift-selects
        // and a mixed selection is ordinary.
        const pressBody = handlerBody('onRowPressed')
        assert.ok(handlerBody('onNoteRowMouseDown').includes('onRowPressed(event, noteID)'),
            'a note row press must go through the SAME handler a to-do row press does')
        assert.ok(handlerBody('onTodoRowMouseDown').includes('onRowPressed(event, todoID)'),
            'and so must a to-do row press')
        assert.ok(!handlerBody('onNoteRowMouseDown').includes('pickedNoteID = noteID'),
            'pressing a note row must no longer set the highlight-only store instead of selecting')
        assert.ok(pressBody.includes('pickedNoteID = null'), 'a press of either kind drops the editor-tracking highlight')
        // The order a Shift range and an Escape collapse are measured along holds BOTH kinds, and leaves the
        // read-only peek out (its rows carry no selection handler at all).
        // The CLICK path must refuse the peek too - see the dedicated check below for why the range-order
        // exclusion is not enough on its own.
        assert.ok(handlerBody('onRowClicked').includes("event.target.closest('.outside-results')"),
            'the click path must refuse to select a read-only peek row')
        const rowsBody = handlerBody('allSelectableRows')
        assert.ok(handlerBody('allRows').includes("'.todo[data-todo-id], .todo[data-note-id]'"),
            'both row kinds must be in the row query')
        assert.ok(rowsBody.includes(".closest('.outside-results')"), 'the read-only peek must stay out of the selectable order')
        assert.ok(handlerBody('onRowPressed').includes('allSelectableRows().map(rowIDOf)'),
            'the Shift range must be measured along the selectable rows of both kinds')
        assert.ok(handlerBody('collapseMultiSelection').includes('allSelectableRows().map(rowIDOf)'),
            'and so must the Escape collapse fallback')
        // A mixed selection is nothing special to the rules: ids are ids.
        const mixed = [rowId('t1'), rowId('n1'), rowId('t2')]
        assert.deepStrictEqual(RowSelection.pressSelection({ selected: [mixed[0]], lastClicked: mixed[0] }, mixed[2], { shift: true }, mixed).selected,
            mixed, 'a Shift range across a note row must take the note with it')
        // The context menu batches whatever is selected, of either kind - the host handler already takes an id
        // array and the labels are kind-neutral (see noteMenu.js).
        const menuBody = handlerBody('showNoteContextMenu')
        assert.ok(/selectedRowIDs\.has\(noteID\) && selectedRowIDs\.size > 1/.test(menuBody),
            'any row inside a multi-row selection must open the batch menu, whichever kind it is')
    })

    await test('read-only peek: a CLICK on a peek row opens it and selects NOTHING (MAJOR-1)', () => {
        // The peek's rows are suppressed at the MARKUP level for the press only: renderTodoRowHtml(draggable:false)
        // and renderNoteRowHtml(selectable:false) drop the selection onmousedown, but BOTH still emit onclick -
        // click-to-open is exactly what the peek is for. Before this guard the click's collapse wrote a peek row
        // into selectedRowIDs, where it persisted across renders; and since a selection now drives the BATCH
        // context menu, that made Delete / Move / Tags / Duplicate / Switch-type reachable on rows the user was
        // deliberately shown READ-ONLY - from outside their own filters, and from excluded notebooks.
        //
        // Checked on the rendered markup as well as the handler, because "the markup suppresses it" is precisely
        // the assumption that was wrong: the pin below fails if a peek row ever gains an onmousedown, AND if the
        // click handler ever stops refusing it.
        const clickBody = handlerBody('onRowClicked')
        assert.ok(clickBody.includes("event.target.closest('.outside-results')"),
            'the click path must recognise a peek row')
        const guardAt = clickBody.indexOf("closest('.outside-results')")
        const collapseAt = clickBody.indexOf('window.RowSelection.clickSelection(')
        assert.ok(guardAt >= 0 && collapseAt > guardAt,
            'and it must refuse BEFORE the collapse writes the row into the selection')
        assert.ok(/closest\('\.outside-results'\)\)\{\s*\n\s*void onTodoClicked\(rowID\)\s*\n\s*return/.test(clickBody),
            'a peek row must still OPEN - only the selection half is skipped')
        // The OTHER path that writes a peek row into the selection: a right click (or mobile long press) on a
        // peek to-do's TICK CIRCLE. draggable:false suppresses neither the oncontextmenu nor the .todo-checkbox
        // element, so the branch that seeds the selection for the due-date picker had to be guarded too -
        // otherwise the peek id lands in selectedRowIDs, gets an alarm written to it, and is then reachable by
        // the batch menu after Ctrl+adding an ordinary row.
        const menuByZone = handlerBody('onTodoContextMenu')
        const circleAt = menuByZone.indexOf("classList.contains('todo-checkbox')")
        const peekBailAt = menuByZone.indexOf("closest('.outside-results')")
        const seedAt = menuByZone.indexOf('selectedRowIDs.add(todoID)')
        assert.ok(circleAt >= 0 && peekBailAt > circleAt && seedAt > peekBailAt,
            'the tick-circle branch must refuse a peek row BEFORE it seeds the selection')
        assert.ok(menuByZone.indexOf('requestAlarm(') > peekBailAt,
            'and therefore before it opens the due-date picker for it')
        // Narrow: the row's other right-click zones still work on a peek row (the single-note menu is what a
        // peeked note is for), so the bail must NOT sit at the top of the function.
        assert.ok(peekBailAt > menuByZone.indexOf('event.preventDefault()'),
            'the guard is scoped to the tick circle, not to the whole context menu')
        assert.ok(menuByZone.includes('showNoteContextMenu(event, todoID, true)'),
            'a right click elsewhere on a peek row must still open its single-note menu')
        // The formats side of the same rule: neither peek row kind may carry a selection handler.
        const formatsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'formats.ts'), 'utf8')
        assert.ok(/var selectHandler = draggable \? `[\s\S]{0,120}onmousedown="onTodoRowMouseDown/.test(formatsSource),
            'a non-draggable (peek) to-do row must carry no selection onmousedown')
        assert.ok(/var selectHandler = selectable \? `[\s\S]{0,120}onmousedown="onNoteRowMouseDown/.test(formatsSource),
            'a non-selectable (peek) note row must carry no selection onmousedown')
    })

    await test('read-only peek: the rendered peek rows carry onclick but no onmousedown', async () => {
        // Rendered for real: a committed search that matches nothing in the filtered view, with the match living
        // outside it, is the only thing that produces the peek - so this is the markup the user actually gets.
        const peekTodo = id32('pk1'), peekNote = id32('pk2')
        const peek = await run({
            dataDir: path.join(tmp, 'peek-select-data'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos: [],
            searchNotes: [],
            outsideResults: [
                { id: peekTodo, title: 'Peek to-do', is_todo: 1, todo_completed: 0, parent_id: 'f', user_updated_time: 1 },
                { id: peekNote, title: 'Peek note', is_todo: 0, parent_id: 'f', user_updated_time: 2 },
            ],
            folders: [{ id: 'f', title: 'Inbox', parent_id: '', updated_time: 1 }],
        })
        await peek.panelMessageHandler(['searchFilterChanged', 'zzqqxx'])
        const html = peek.panelHtml['panel-panel']
        assert.ok(html.includes('outside-results'), 'the peek section must have rendered')
        for (const [id, kind] of [[peekTodo, 'to-do'], [peekNote, 'note']]){
            const at = html.indexOf(id)
            assert.ok(at >= 0, `the peek ${kind} row must be present`)
            const tag = html.slice(html.lastIndexOf('<div', at), html.indexOf('>', at) + 1)
            assert.ok(/onclick="on(Todo|Note)RowClicked/.test(tag), `the peek ${kind} row must still open on click`)
            assert.ok(!/onmousedown/.test(tag), `the peek ${kind} row must carry NO selection onmousedown`)
        }
    })

    await test('escape collapse (webview): only a BARE Escape reaches the selection, and it never opens anything', () => {
        const body = handlerBody('collapseMultiSelection')
        assert.ok(body.includes('if (selectedRowIDs.size <= 1) return'), 'it must only act on a real multi-selection')
        assert.ok(body.includes('window.EditorNote.collapseSelection('), 'the kept row must come from the shared rule')
        assert.ok(body.includes('paintTodoSelection()'), 'the collapse must repaint')
        assert.ok(!body.includes('pickedNoteID') && !body.includes('onTodoClicked'),
            'the collapse is selection-only: it must not move the editor-tracking highlight or open the kept note')
        // Escape belongs first to whatever is open. The guards are read from the DOM, and this listener is
        // registered ABOVE every other Escape handler in the file, so those popups are still open when it runs.
        const collapseIdx = webviewSource.indexOf('collapseMultiSelection()\n})')
        assert.ok(collapseIdx >= 0, 'the bare-Escape listener must call the collapse')
        const guards = webviewSource.slice(webviewSource.lastIndexOf("event.key !== 'Escape'", collapseIdx), collapseIdx)
        for (const [needle, why] of [
            ["getElementById('noteContextMenu')", 'the context menu keeps Escape'],
            ['.dropdown > .dropdown-menu:not([hidden])', 'an open dropdown keeps Escape'],
            ["getElementById('searchSuggestions')", 'the suggestion list keeps Escape'],
            ['overlayOpen', 'a mobile overlay keeps Escape'],
            ['document.activeElement === getSearchInput()', 'the search field keeps its own Escape'],
        ]) assert.ok(guards.includes(needle), why)
        assert.ok(collapseIdx < webviewSource.indexOf("if (event.key === 'Escape') hideNoteContextMenu()"),
            'the collapse listener must be registered before the other Escape handlers, so it sees them still open')
    })

    await test('editor highlight: a read-back is stale exactly when the selection generation moved on', () => {
        // getEditorNote answers a question asked a moment ago. Both an accepted push AND a row press bump the
        // generation, so an answer that arrives after either must be discarded - otherwise the answer paints
        // the older editor note over the newer state, which for a row press means dropping the single-row
        // selection that press just made.
        assert.strictEqual(EditorNote.readBackIsStale(4, 4), false, 'an untouched generation must apply the answer')
        assert.strictEqual(EditorNote.readBackIsStale(4, 5), true, 'a bump while the read-back was in flight must discard it')
    })

    await test('editor highlight (webview): the webview delegates to the shared rules and re-reads on regained focus (M2)', () => {
        const body = handlerBody('applyEditorNoteSelection')
        assert.ok(body.includes('window.EditorNote.nextSelection('), 'the webview must apply the shared rules, not its own')
        assert.ok(body.includes('pickedNoteID = next.picked') && body.includes('paintTodoSelection()'),
            'and write the decision back into the highlight store, repainting at once')
        // The paint must honour the highlight-only store on TO-DO rows too (it used to key those off
        // selectedRowIDs alone, so a to-do open in the editor would not have highlighted).
        assert.ok(/selectedRowIDs\.has\(id\) \|\| id === pickedNoteID/.test(handlerBody('paintTodoSelection')),
            'a row must highlight from the selection OR the editor note')
        // And BOTH kinds go through that one rule: a note row used to be painted from pickedNoteID alone, so a
        // selected note could never have shown as selected.
        assert.ok(handlerBody('paintTodoSelection').includes('for (var row of allRows())'),
            'the paint must run over both row kinds through the same rule')
        // Both inbound paths - the push and the read-back - are filtered through the same acceptance rule.
        const acceptBody = handlerBody('acceptsEditorNote')
        assert.ok(acceptBody.includes('window.EditorNote.acceptsPush(') && acceptBody.includes('panelWindowIsFocused()'),
            'acceptance must combine the shared rule with the live window focus')
        const pushIdx = webviewSource.indexOf("message[0] === 'editorNoteChanged'")
        assert.ok(pushIdx >= 0, 'the webview must handle the editorNoteChanged push')
        assert.ok(/if \(!acceptsEditorNote\(\)\) return/.test(webviewSource.slice(pushIdx, pushIdx + 260)),
            'a push from another window must be dropped')
        const readBody = handlerBody('requestEditorNote')
        assert.ok(readBody.includes('if (!acceptsEditorNote()) return'),
            'the read-back must apply the SAME filter, so a panel loading behind a secondary window is not seeded from it')
        assert.ok(readBody.includes("postMessage(['getEditorNote'])") && readBody.includes('applyEditorNoteSelection(id)'),
            'the read-back must ask the host and apply the answer (no self-disabling guard: a resync must be able to move or clear the highlight)')
        assert.ok(/readBackIsStale\(seq, editorNoteSeq\)/.test(readBody), 'a read-back overtaken by a newer generation must be dropped')
        // Both things that move the panel's selection bump that generation: an accepted push, and a row press.
        assert.ok(/editorNoteSeq\+\+[\s\S]{0,120}applyEditorNoteSelection\(message\[1\]\)/.test(webviewSource),
            'an accepted push must bump the selection generation')
        // Both row kinds now press through the ONE shared handler, so the bump lives there - and reaches both.
        for (const handler of ['onTodoRowMouseDown', 'onNoteRowMouseDown']){
            assert.ok(handlerBody(handler).includes('onRowPressed(event, '),
                `${handler} must go through the shared press handler`)
            assert.ok(handlerBody('onRowPressed').includes('editorNoteSeq++'),
                `${handler} must bump the generation, so an in-flight read-back cannot drop the selection the press just made`)
        }
        // The resync itself: a regained window focus re-reads, because every push that arrived unfocused was
        // dropped and the host does not re-send an unchanged id.
        assert.ok(/parentWindow\.addEventListener\('focus', queueEditorNoteResync\)/.test(webviewSource),
            'the panel must re-read the editor note when its window regains focus')
        assert.ok(!/parentWindow\.addEventListener\('focus', queueEditorNoteResync, true\)/.test(webviewSource),
            'the focus listener must NOT capture, or it would fire for every element focused in the main window')
        // The panel's window focus is read from the TOP document: the panel's own iframe document only has focus
        // when focus sits inside the panel.
        const focusBody = handlerBody('panelWindowIsFocused')
        assert.ok(focusBody.includes('window.top') && focusBody.includes('hasFocus()'),
            'the focus question is about the WINDOW, so it must ask the top document')
        assert.ok(/catch[\s\S]*return true/.test(focusBody), 'a cross-origin host must fall back to accepting the push')
    })

    // -- host glue: the selection event pushes the id and costs nothing else -----------------------------------
    const selectionNoteA = id32('sela')
    const selectionNoteB = id32('selb')
    const selection = await desktopRun({
        notes: {
            [selectionNoteA]: { id: selectionNoteA, title: 'Selected A', is_todo: 1 },
            [selectionNoteB]: { id: selectionNoteB, title: 'Selected B', is_todo: 1 },
        },
    })

    await test('editor highlight (host): a selection change pushes the id and issues no search, GET, render or lane', async () => {
        const getsBefore = selection.gets.length
        const htmlBefore = selection.setHtmlCalls
        const timersBefore = selection.timeouts.length
        const messagesBefore = selection.panelMessages.length
        await selection.noteSelectionHandler({ value: [selectionNoteA] })
        assert.deepStrictEqual(selection.panelMessages.slice(messagesBefore), [['editorNoteChanged', selectionNoteA]],
            'the open note must be pushed to the panel webview')
        assert.strictEqual(selection.gets.length, getsBefore, 'a selection change must cost no data API call')
        assert.strictEqual(selection.setHtmlCalls, htmlBefore, 'a selection change must not re-render the panel')
        assert.strictEqual(selection.timeouts.length, timersBefore, 'a selection change must arm no refresh lane')
    })

    await test('editor highlight (host): an unchanged selection is not re-pushed (a window refocus must not collapse a multi-selection)', async () => {
        const messagesBefore = selection.panelMessages.length
        await selection.noteSelectionHandler({ value: [selectionNoteA] })
        assert.strictEqual(selection.panelMessages.length, messagesBefore,
            'Joplin re-emits the selection on every window focus change; only a genuine move may reach the panel')
    })

    await test('editor highlight (host): several notes selected in Joplin\'s list means no single note is open, so the highlight clears', async () => {
        await selection.noteSelectionHandler({ value: [selectionNoteA, selectionNoteB] })
        assert.deepStrictEqual(selection.panelMessages[selection.panelMessages.length - 1], ['editorNoteChanged', ''],
            'a multi-note selection must clear the highlight rather than pick one arbitrarily')
        assert.strictEqual(await selection.panelMessageHandler(['getEditorNote']), '',
            'a freshly loaded webview must be told there is no open note')
    })

    await test('editor highlight (host): getEditorNote answers a reloaded webview with the note the editor holds', async () => {
        await selection.noteSelectionHandler({ value: [selectionNoteB] })
        assert.strictEqual(await selection.panelMessageHandler(['getEditorNote']), selectionNoteB,
            'the round-trip must return the host-held id (the mobile reload restores the highlight through it)')
    })

    // -- create buttons: clean icons, two-stage degradation, never wrapping -----------------------------------
    // The to-do icon was REPLACED (1.9.8): it used to be the note icon's document sheet with a checkmark on it,
    // which read as "note", and the panel's own glyph language uses a ring for a to-do on every single row. It is
    // now a ring with a checkmark inside. The note icon is untouched, so the sheet must appear exactly ONCE.
    await test('create buttons: the note icon is a sheet, the to-do icon is a ring with a check, neither carries a plus', () => {
        assert.ok(!/notePlus|todoPlus/.test(iconsSource), 'the plus-bearing icon names must be gone')
        assert.ok(/\bnote: svgIcon\(/.test(iconsSource) && /\btodo: svgIcon\(/.test(iconsSource),
            'the create buttons must use the plain note / to-do icons')
        // The two retired plus glyphs: the "+" punched into the note sheet, and the "+" badge on the check circle.
        assert.ok(!iconsSource.includes('h-3v3h-2v-3H8v-2h3v-3h2v3h3v2z'), 'the note icon must no longer carry a plus cutout')
        assert.ok(!iconsSource.includes('M19 15h-2v2h-2v2h2v2h2v-2h2v-2h-2v-2z'), 'the to-do icon must no longer carry a plus badge')
        // The document sheet belongs to the note icon ALONE now.
        const sheet = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM13 9V3.5L18.5 9H13z'
        assert.strictEqual((iconsSource.match(new RegExp(sheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
            'only the note icon may carry the document sheet - the to-do icon is a ring, not a sheet')
        // The to-do glyph: an outer circle, an inner circle wound the other way (which is what punches the ring
        // open under the shared svgIcon wrapper's single fill:currentColor path), then the check.
        const todoPath = (iconsSource.match(/\btodo: svgIcon\("([^"]+)"\)/) || [])[1] || ''
        assert.ok(todoPath.startsWith('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z'),
            'the to-do icon must open with the outer circle')
        assert.ok(todoPath.includes('zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z'),
            'it must carry the counter-wound inner circle that makes the ring an open ring rather than a disc')
        assert.ok(/z[Mm][^z]*l[^z]*z$/.test(todoPath), 'it must end with the checkmark subpath inside the ring')
        assert.ok(/fill="currentColor"/.test(iconsSource) && !/stroke=/.test(iconsSource),
            'the icons stay fill-only: the ring is an open path, never a stroked circle (svgIcon emits no stroke attribute)')
    })

    await test('create buttons: the desktop markup carries both wordings, and the full one stays the accessible name', () => {
        const html = desktop.panelHtml['panel-panel']
        assert.ok(html.includes('<span class="create-label -long">New note</span><span class="create-label -short">Note</span>'),
            'the new-note button must carry the full and short wordings')
        assert.ok(html.includes('<span class="create-label -long">New to-do</span><span class="create-label -short">To-do</span>'),
            'the new-to-do button must carry the full and short wordings')
        // The icon-only stage still names the action for the tooltip and for assistive tech.
        assert.ok(html.includes('title="New note" aria-label="New note"'), 'the new-note button must stay named at every stage')
        assert.ok(html.includes('title="New to-do" aria-label="New to-do"'), 'the new-to-do button must stay named at every stage')
        // Mobile stays icon-only (MOBILE.md §5): the label spans exist only in the desktop markup.
        assert.ok(!mobile.panelHtml['panel-panel'].includes('create-label'), 'mobile keeps its icon-only create buttons')
    })

    await test('create buttons css: the profile row never wraps, and the two degraded stages are class-driven', () => {
        // Never a second line: the buttons shorten and then drop their labels instead.
        assert.ok(/#profileControls \{[^}]*flex-wrap:\s*nowrap/.test(panelCssSource),
            'the profile row must not wrap - the create buttons degrade instead')
        // Widest stage: only the full wording shows.
        assert.ok(/\.create-label\.-short \{\s*display:\s*none/.test(panelCssSource), 'at full width only the full wording shows')
        // The stages are CLASSES set by measurement (see below), not pixel media queries: the row's content width
        // scales with Joplin's font-size setting, so a fixed breakpoint clean at the 13px default clips the second
        // button at 16-18px.
        assert.ok(!/@media[^}]*create-label/.test(panelCssSource), 'the stages must not be pinned to a pixel breakpoint')
        assert.ok(/#profileControls\.-labels-short \.create-label\.-long \{[^}]*display:\s*none/.test(panelCssSource),
            'the short stage hides the full wording')
        assert.ok(/#profileControls\.-labels-short \.create-label\.-short \{[^}]*display:\s*inline/.test(panelCssSource),
            'the short stage shows the short wording')
        assert.ok(/#profileControls\.-labels-none \.create-label\.-long,\s*#profileControls\.-labels-none \.create-label\.-short \{[^}]*display:\s*none/.test(panelCssSource),
            'the icon-only stage drops both wordings (both selectors, so it never loses on specificity)')
        assert.ok(/#profileControls\.-labels-none \.dropdown \{[^}]*min-width:\s*40px/.test(panelCssSource),
            'at the narrowest the profile picker gives up its width before the buttons can overflow')
    })

    await test('create buttons: the stage is MEASURED per render and per resize, widest first, desktop only', () => {
        const body = handlerBody('applyCreateButtonStage')
        assert.ok(body.includes('if (IS_MOBILE) return'), 'mobile renders icon-only markup already')
        // Widest first, stepping down only while the row actually overflows - so the stage follows the real font
        // size and theme rather than a guessed breakpoint.
        assert.ok(/classList\.remove\('-labels-short', '-labels-none'\)/.test(body), 'each measurement must start from the widest stage')
        assert.strictEqual((body.match(/row\.scrollWidth <= row\.clientWidth\) return/g) || []).length, 2,
            'it must stop at the first stage that fits (two overflow checks: full, then short)')
        assert.ok(/classList\.add\('-labels-short'\)[\s\S]*classList\.add\('-labels-none'\)/.test(body),
            'the stages must be applied in order: short wording, then icon only')
        assert.ok(/window\.addEventListener\('resize', applyCreateButtonStage\)/.test(webviewSource),
            'a panel resize must re-measure')
        // Measured on a real re-render (the controls are rebuilt at their widest each time), inside the .todos
        // identity branch so the class it sets cannot drive the mutation observer round again.
        assert.ok(handlerBody('reconcile').includes('applyCreateButtonStage()'), 'every re-render must re-measure')
        // A host stylesheet change is a font change too - Joplin's font-size setting is what the row is
        // measured against - and it arrives with no resize and no re-render. Coalesced, because a theme swap
        // fires the head observer several times, and deliberately not wired to the panel's own mutation
        // observer (the stage classes are mutations, which would drive it round every frame).
        assert.ok(handlerBody('onHostStyleChanged').includes('scheduleCreateButtonStage()'),
            'a theme / font-size change must re-measure without waiting for a resize or a render')
        assert.ok(/new MutationObserver\(onHostStyleChanged\)\.observe\(document\.head/.test(webviewSource),
            'the head observer must drive that re-measure')
        assert.ok(handlerBody('scheduleCreateButtonStage').includes('requestAnimationFrame'), 'the re-measure must be coalesced')
    })

    // ============================================================ multi-select in the search token dropdowns
    // The tag: / notebook: / title: autocomplete became a MULTI-select: the list is taller (~15 rows, scrolling),
    // carries its own filter box and an apply button, and rows can be MARKED (Ctrl+click on desktop, a long press
    // then taps on touch) so several tokens are inserted at once.
    //
    // The part that can actually go wrong is the TEXT, and it is the part Slava drew a hard line under: this is a
    // pure text helper that must never delete or rewrite what the user has already typed. That decision lives in a
    // pure, DOM-free module (searchTokens.js) exactly so it can be EXERCISED here rather than pattern-matched in
    // the webview source. The webview halves (wiring, marks, focus region, Escape chain) are pinned by shape, as
    // the row-click / notebook-filter / editor-highlight checks above are, because this harness renders the panel
    // markup but never executes the webview JS.
    // The field as the user left it, with the incomplete token located the way tokenAtCaret reports it.
    const insertAt = (query, kind, fragment, values) => {
        // lastIndexOf, not indexOf: the fragment being completed is the one at the caret, and an earlier
        // COMPLETE token can contain it as a prefix ("tag:done" contains "tag:d").
        const start = query.lastIndexOf(fragment)
        assert.ok(start >= 0, `fixture error: "${fragment}" is not in "${query}"`)
        return SearchTokens.buildTokenInsertion(query, { kind, start, end: start + fragment.length }, values)
    }

    await test('search tokens: everything outside the completed fragment comes back byte-identical', () => {
        // The whole point. Other tokens, free text, any:1 and a negation all survive an apply untouched.
        const query = 'any:1 milk -tag:done notebook:Home tag:pro'
        const next = insertAt(query, 'tag', 'tag:pro', ['project'])
        assert.strictEqual(next.value, 'any:1 milk -tag:done notebook:Home tag:project ',
            'only the half-typed tag: fragment may be replaced')
        // And in the MIDDLE of a query, where the tail is what a rewrite would damage.
        const mid = insertAt('tag:pro and then some free text', 'tag', 'tag:pro', ['project'])
        assert.strictEqual(mid.value.slice(mid.caret), ' and then some free text',
            'the text after the fragment must be preserved verbatim, double space and all')
    })

    await test('search tokens: several marked values insert as one properly spaced run, caret after it', () => {
        const next = insertAt('any:1 milk tag:pro', 'tag', 'tag:pro', ['project', 'work', 'home'])
        assert.strictEqual(next.value, 'any:1 milk tag:project tag:work tag:home ',
            'exactly one space between the tokens and exactly one trailing space')
        assert.strictEqual(next.caret, next.value.length, 'the caret lands after the inserted run, ready to keep typing')
    })

    await test('search tokens: values needing quotes are quoted, and an embedded quote is stripped', () => {
        const next = insertAt('notebook:fam', 'notebook', 'notebook:fam', ['Family / Payments', 'Home'])
        assert.strictEqual(next.value, 'notebook:"Family / Payments" notebook:Home ',
            'only the value with whitespace is quoted')
        // Joplin's phrase syntax cannot escape a quote, so a raw one would break the committed token.
        assert.strictEqual(SearchTokens.renderToken('title', 'He said "hi" now'), 'title:"He said hi now"')
        assert.strictEqual(SearchTokens.renderToken('tag', 'plain'), 'tag:plain')
    })

    await test('search tokens: a value already in the query is skipped, but a NEGATION is not the same term', () => {
        // Already there, verbatim.
        assert.strictEqual(insertAt('tag:done tag:d', 'tag', 'tag:d', ['done', 'new']).value, 'tag:done tag:new ',
            'a token already in the query must not be inserted a second time')
        // Quoted and unquoted spellings of one value are the same term.
        assert.strictEqual(insertAt('notebook:"A B" notebook:', 'notebook', 'notebook:', ['A B', 'C']).value,
            'notebook:"A B" notebook:C ', 'the quoted and unquoted spellings must collapse onto one term')
        // Case-insensitive: Joplin stores tags lower-cased and searches case-insensitively.
        assert.strictEqual(insertAt('tag:Work tag:w', 'tag', 'tag:w', ['work']).value, 'tag:Work ',
            'the duplicate check must be case-insensitive')
        // A negation means the opposite, so it must NOT suppress the positive term.
        assert.strictEqual(insertAt('-tag:x tag:', 'tag', 'tag:', ['x']).value, '-tag:x tag:x ',
            '-tag:x must not suppress tag:x - they are different terms')
        // Repeats within one marked set collapse too.
        assert.strictEqual(insertAt('tag:', 'tag', 'tag:', ['a', 'b', 'a']).value, 'tag:a tag:b ',
            'a value marked twice must be inserted once')
    })

    await test('search tokens: when every value is skipped the fragment goes, leaving no dangling half-token', () => {
        const next = insertAt('milk tag:done tag:do', 'tag', 'tag:do', ['done'])
        assert.strictEqual(next.value, 'milk tag:done ', 'the half-typed fragment must not be left behind')
        assert.strictEqual(insertAt('milk tag:pro', 'tag', 'tag:pro', []).value, 'milk ', 'no values at all removes the fragment')
        // An empty value would render as a bare "tag:", which is not a filter.
        assert.strictEqual(insertAt('tag:p', 'tag', 'tag:p', ['', 'ok']).value, 'tag:ok ', 'an empty value is skipped')
    })

    await test('search tokens: a quoted free-text phrase cannot suppress a real insertion (m5)', () => {
        // The duplicate skip reads the query as Joplin does: a double-quoted phrase is ONE piece, so `tag:work`
        // sitting INSIDE `"foo tag:work"` is not a filter term at all and must not make the pick silently insert
        // nothing. A real term, quoted value and all, still suppresses.
        assert.strictEqual(insertAt('"foo tag:work" tag:', 'tag', 'tag:', ['work']).value, '"foo tag:work" tag:work ',
            'a term inside a quoted phrase must not suppress the insertion')
        assert.strictEqual(insertAt('tag:work tag:', 'tag', 'tag:', ['work']).value, 'tag:work ',
            'a real term still suppresses')
        assert.strictEqual(insertAt('tag:"a b" tag:', 'tag', 'tag:', ['a b']).value, 'tag:"a b" ',
            'and so does one whose value is a quoted phrase')
        // An unterminated quote is read conservatively: the rest of the query becomes one piece, which is not a
        // term, so nothing is suppressed (a wrong skip is silent, a wrong insert is visible and undoable).
        assert.strictEqual(insertAt('"foo tag:work tag:', 'tag', 'tag:', ['work']).value, '"foo tag:work tag:work ',
            'an unterminated quote must not suppress either')
    })

    await test('search tokens: the two DELIBERATE divergences from the old single-pick output (m6)', () => {
        // Found by fuzzing. Both are improvements over what the pre-multi-select code emitted, and both are
        // pinned here so the difference is a decision on the record rather than a surprise.
        //
        // 1. A value that is empty once its quotes are stripped. The old code emitted a bare `tag: ` - not a
        //    filter, just litter the user then had to delete. Now the fragment is simply removed.
        assert.strictEqual(insertAt('tag:p', 'tag', 'tag:p', ['"']).value, '',
            'a value that sanitises to nothing must leave no bare "tag:" behind')
        // 2. A value already present in the query. The old code inserted it a second time; now it is skipped and
        //    the half-typed fragment goes, which is what the user meant by picking it.
        assert.strictEqual(insertAt('tag:done tag:d', 'tag', 'tag:d', ['done']).value, 'tag:done ',
            'an already-present value must not be duplicated')
    })

    await test('search tokens: a SINGLE value otherwise produces exactly what the pre-multi-select pick produced', () => {
        // The regression pin. The old applySearchSuggestion built `kind + ':' + maybeQuoted + ' '` and spliced it
        // over [token.start, token.end); one insertion path now serves both, so it must agree byte for byte -
        // apart from the two deliberate divergences pinned just above.
        const cases = [
            ['tag:pro', 'tag', 'tag:pro', 'project', 'tag:project '],
            ['find tag:', 'tag', 'tag:', 'a b', 'find tag:"a b" '],
            // The double space is the OLD behaviour too, and is the point: the tail keeps its own leading
            // space because nothing after the fragment is ever rewritten.
            ['notebook:x rest', 'notebook', 'notebook:x', 'Home', 'notebook:Home  rest'],
        ]
        for (const [query, kind, fragment, value, expected] of cases){
            assert.strictEqual(insertAt(query, kind, fragment, [value]).value, expected,
                `single pick of "${value}" into "${query}"`)
        }
    })

    await test('search tokens: an out-of-range token span can only splice inside the text, never throw', () => {
        // The field can change under an in-flight suggestion (the debounced title: round-trip).
        const next = SearchTokens.buildTokenInsertion('ab', { kind: 'tag', start: 99, end: 120 }, ['x'])
        assert.strictEqual(next.value, 'abtag:x ')
        assert.strictEqual(SearchTokens.buildTokenInsertion(null, null, ['x']).value, 'tag:x '.replace('tag', ''),
            'a missing kind still yields a well-formed string')
    })

    await test('search tokens: the filter match, the platform hint and the per-kind placeholder', () => {
        assert.strictEqual(SearchTokens.matchesFilter('Family / Payments', 'fam'), true, 'case-insensitive substring')
        assert.strictEqual(SearchTokens.matchesFilter('Family / Payments', 'PAY'), true)
        assert.strictEqual(SearchTokens.matchesFilter('Family / Payments', 'zzz'), false)
        assert.strictEqual(SearchTokens.matchesFilter('anything', '   '), true, 'a blank filter matches everything')
        assert.strictEqual(SearchTokens.matchesFilter('anything', ''), true)
        // Touch has no Ctrl and no hover, so the hint names the gesture that actually works there.
        assert.ok(/Ctrl\+click/.test(SearchTokens.hintText(false)), 'desktop names Ctrl+click')
        assert.ok(/[Pp]ress and hold/.test(SearchTokens.hintText(true)), 'mobile names the long press')
        assert.strictEqual(SearchTokens.filterPlaceholder('tag'), 'Filter tags...')
        assert.strictEqual(SearchTokens.filterPlaceholder('notebook'), 'Filter notebooks...')
        assert.strictEqual(SearchTokens.filterPlaceholder('title'), 'Filter titles...')
    })

    await test('search tokens: the module is loaded into the webview BEFORE panelWebview.js can use it', () => {
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        const tokensAt = panelSource.indexOf("addScript(panel, '/ui/panel/searchTokens.js')")
        const webviewAt = panelSource.indexOf("addScript(panel, '/ui/panel/panelWebview.js')")
        assert.ok(tokensAt >= 0, 'searchTokens.js must be added to the panel')
        assert.ok(webviewAt > tokensAt, 'it must be loaded before panelWebview.js, which calls into it at render time')
        // UMD, like editorNote.js / noteMenu.js: the same file serves the webview and this harness.
        const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'searchTokens.js'), 'utf8')
        assert.ok(/module\.exports = api/.test(moduleSource) && /window\.SearchTokens = api/.test(moduleSource),
            'the module must export to both Node and the webview')
    })

    await test('search dropdown: ONE insertion path - the webview delegates the text decision to the pure module', () => {
        // No second copy of the quoting / splicing logic in the webview, or the tests above would stop covering
        // what actually ships.
        assert.ok(handlerBody('insertSearchTokens').includes('window.SearchTokens.buildTokenInsertion('),
            'the insertion must come from the shared module')
        assert.ok(handlerBody('applySearchSuggestion').includes('insertSearchTokens('), 'the single pick goes through it')
        assert.ok(handlerBody('applyMarkedSuggestions').includes('insertSearchTokens('), 'the multi apply goes through it')
        assert.ok(!/needsQuote/.test(webviewSource), 'the webview must not keep its own quoting logic')
    })

    await test('search dropdown: Ctrl/Cmd+click marks and KEEPS the list open; a plain click still picks', () => {
        const body = handlerBody('wireSuggestList')
        assert.ok(/event\.ctrlKey \|\| event\.metaKey/.test(body), 'Ctrl and Cmd must both mark (the row code uses both)')
        assert.ok(/toggleSearchMark\(value\); return/.test(body), 'marking must return before the pick, leaving the list open')
        assert.ok(body.includes('applySearchSuggestion(input, suggestionByValue(value))'), 'a plain press must still pick')
        assert.ok(body.includes("addEventListener('mousedown'"), 'desktop keeps picking on mousedown, so the pick beats the blur')
        // ONE delegated listener for the whole list, not one per row: the list is rebuilt on every keystroke and
        // now holds up to SUGGEST_MAX_ITEMS rows.
        assert.ok(/SUGGEST_MAX_ITEMS = 200/.test(webviewSource), 'the candidate cap must be raised well past the visible rows')
        assert.ok(!/item\.addEventListener/.test(handlerBody('renderSearchSuggestions')),
            'the row loop must not attach a listener per row')
    })

    await test('search dropdown: the field and the open list are ONE focus region', () => {
        // Reaching for the list's filter box or apply button blurs the field. Treating that as leaving would tear
        // down the very list the user reached for - and on mobile would release the host refresh hold, whose next
        // setHtml is a full webview reload.
        const blur = handlerBody('onSearchBlur')
        assert.ok(blur.includes('if (inSearchRegion(related)) return'), 'a blur into the region must be ignored')
        assert.ok(blur.includes('isConnected === false) return'), 'the removal-blur guard must stay')
        assert.ok(/if \(suggestPointerInside\)\{ restoreSearchDraft\(\); return \}/.test(blur),
            'a tap on a non-focusable row (null relatedTarget) must hand the caret back, not tear the list down')
        assert.ok(/setTimeout\(function\(\)\{ if \(!searchRegionHasFocus\(\)\) leaveSearchField\(\) \}, 0\)/.test(blur),
            'an otherwise-unhelpful null relatedTarget must be decided next tick, not guessed at')
        // ...and the SAME deferral with no list open, which is the commit-with-focus case. A commit closes the
        // list before it asks the host to render, so the render's removal-blur arrives with no menu; gating the
        // deferral on a menu therefore sent every commit (Enter, the clear button, a pick, the empty-field
        // auto-reset) straight to leaveSearchField, clearing searchFocused a couple of milliseconds before
        // reconcile's restoreSearchDraft ran - measured: the restore was reached every time and returned at its
        // first line, leaving activeElement on <body>. Desktop only: on mobile a setHtml is a full reload, so
        // there is no surviving state to restore and the host's focus hold must not be released a tick later.
        assert.ok(/if \(!IS_MOBILE && related == null\)\{/.test(blur),
            'a null-relatedTarget blur with NO list open must be deferred too, or every commit loses the caret')
        assert.ok(blur.indexOf('if (menu && related == null)') < blur.indexOf('if (!IS_MOBILE && related == null)'),
            'the open-list branch keeps first refusal, so the mobile path through this function is unchanged')
        const region = handlerBody('inSearchRegion')
        assert.ok(region.includes('getSearchInput()') && region.includes('searchSuggestions'),
            'the region is the field plus the open list')
        // The teardown itself is unchanged, just moved behind the region test.
        const leave = handlerBody('leaveSearchField')
        assert.ok(leave.includes('searchFocused = false') && leave.includes('searchDraft = null') &&
                  /hideSearchSuggestions\(\{ reason: 'field-left' \}\)/.test(leave),
            'a genuine leave still drops the draft and closes the list')
        assert.ok(/IS_MOBILE\) void webviewApi\.postMessage\(\['searchFocusChanged', false\]\)/.test(leave),
            'and still releases the mobile refresh hold')
    })

    await test('search commit: a change caused by focus entering the list is DEFERRED, not dropped (M1/M2)', () => {
        // The browser fires `change` on an edited input whenever it loses focus, and the list now holds focusable
        // controls (its filter box, its apply button), so simply reaching for one is such a blur. Committing there
        // runs the half-typed query and re-renders the panel out from under the interaction.
        //
        // It must be answered on a DEFERRED tick, not inline: at `change` time the browser has not yet assigned
        // focus (activeElement is still <body> on every route), so an inline activeElement test is dead code - and
        // it would answer only for the mouse anyway, leaving Tab (the filter box is the field's next tab stop) and
        // programmatic focus() committing. Deferring makes the answer independent of HOW focus moved.
        const body = handlerBody('onSearchFieldChanged')
        assert.ok(/setTimeout\(/.test(body), 'the decision must be deferred a tick - at change time focus has not landed yet')
        assert.ok(/if \(suggestionsHaveFocus\(\)\) return/.test(body),
            'and must then ask where focus actually IS, so mouse, Tab and focus() all behave alike')
        // NARROWER than the whole search region on purpose: the clear button fires `search` while the FIELD
        // keeps focus, and that has always committed at once. Testing the region here would strand it pending
        // until the user happened to click away - the same class of bug as the dead activeElement test.
        assert.ok(!/searchRegionHasFocus/.test(body) && !/inSearchRegion/.test(body),
            'the clear button still commits - do not use the whole-region test here')
        assert.ok(handlerBody('suggestionsHaveFocus').includes("getElementById('searchSuggestions')"),
            'the narrow test asks only about the suggestion list')
        assert.ok(body.includes('pendingSearchCommit = { value: value }'), 'the commit is held, not discarded')
        assert.ok(!/activeElement/.test(body), 'the dead inline activeElement test must be gone')
        // M2: a held commit is DEFERRED, never lost - leaveSearchField flushes it once focus leaves the region,
        // so "type, reach into the list, click away" still commits exactly once.
        const leave = handlerBody('leaveSearchField')
        assert.ok(leave.includes('flushPendingSearchCommit()'), 'leaving the region must flush a held commit')
        assert.ok(leave.indexOf('flushPendingSearchCommit()') < leave.indexOf('searchDraft = null'),
            'flushed before the draft is dropped, so the committed value is still the typed one')
        // Exactly once: an explicit commit supersedes a pending one, so the two can never both fire.
        assert.ok(handlerBody('onSearchFilterChanged').includes('pendingSearchCommit = null'),
            'an explicit commit (Enter, a pick, an apply) must supersede a held one')
        assert.ok(handlerBody('flushPendingSearchCommit').includes('pendingSearchCommit = null'),
            'and a flush must clear the slot before running, so it cannot fire twice')
        // Wired on the markup side, on BOTH fallback events.
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        assert.ok(/onchange="onSearchFieldChanged\(this\.value\)" onsearch="onSearchFieldChanged\(this\.value\)"/.test(panelSource),
            'the field must route change and search through the deferred commit')
        assert.ok(!/onchange="onSearchFilterChanged/.test(panelSource), 'the unguarded handler must not remain wired')
        // Enter is unaffected: it commits explicitly in the keydown, which is why it never relied on `change`.
        assert.ok(handlerBody('onSearchKeyDown').includes('onSearchFilterChanged(searchInput.value)'),
            'Enter must still commit directly')
    })

    await test('search dropdown: clicking back into the search field keeps the list and its marks (M3)', () => {
        // Escape already hands the caret back to the field with the list still open; the mouse must be allowed the
        // same move. Before this, the capturing click-closer saw #searchFilter as "outside" and ran
        // closeAllDropdowns, silently destroying a multi-select in progress.
        assert.ok(/if \(searchSuggestion && target\.closest\('#searchRow'\)\)\{ closeAllDropdowns\(\{ keepSuggestions: true \}\); return \}/.test(webviewSource),
            'with the list open, a click in the search row must keep it (and its marks)')
        // Only the suggestion list is spared - the other menus still close, so clicking the field while the
        // notebook menu is open behaves exactly as before.
        const close = handlerBody('closeAllDropdowns')
        assert.ok(/keepSuggestions && menu\.id === 'searchSuggestions'\) continue/.test(close),
            'keepSuggestions must spare only the suggestion list')
        assert.ok(/if \(!keepSuggestions\) hideSearchSuggestions\(\{ reason: 'menus-closed' \}\)/.test(close),
            'and only then skip dropping its state')
        // A click on a row, or anywhere else, still closes everything; a target with no closest() still does too.
        assert.ok(/if \(!target \|\| !target\.closest\)\{ closeAllDropdowns\(\); return \}/.test(webviewSource),
            'a target without closest() must still close everything, as before')
        assert.ok(/closest\('\.dropdown, #searchSuggestions'\)\) return/.test(webviewSource),
            'clicks inside a menu or the list are still the menus\' own')
    })

    await test('search dropdown: typing past the last match keeps the marks so a backspace gets them back (m7)', () => {
        // The empty state is recoverable - one backspace brings the rows straight back - but the marked values are
        // no longer on screen, so dropping them there would be unrecoverable.
        const input = handlerBody('onSearchInput')
        assert.ok(/if \(!items\.length\)\{ hideSearchSuggestions\(\{ keepMarks: true, reason: 'no-matches' \}\); return \}/.test(input),
            'no matches must not throw away a multi-select in progress')
        assert.ok(/if \(!token\)\{ hideSearchSuggestions\(\{ reason: 'no-token' \}\); return \}/.test(input),
            'but the token going away entirely still drops them')
        assert.ok(/hideSearchSuggestions\(\{ keepMarks: true[^}]*\}\)/.test(handlerBody('requestTitleSuggestions')),
            'the title: round-trip must treat an empty answer the same way')
        const hide = handlerBody('hideSearchSuggestions')
        assert.ok(/if \(!\(options && options\.keepMarks\)\) searchMarks = null/.test(hide),
            'every other close - blur, commit, Escape, a re-render - still drops the marks')
        // The kind guard still applies, so the kept marks cannot leak into a different token.
        assert.ok(/searchMarks && searchMarks\.kind !== token\.kind\) searchMarks = null/.test(input),
            'a different token kind must still drop them')
    })

    await test('search dropdown: Escape unwinds marks, then the filter, then the list - and is swallowed each time', () => {
        const body = handlerBody('escapeSearchSuggestions')
        const marksAt = body.indexOf('clearSearchMarks()')
        const filterAt = body.indexOf("box.value = ''")
        const closeAt = body.indexOf('hideSearchSuggestions(')
        assert.ok(marksAt >= 0 && filterAt > marksAt && closeAt > filterAt,
            'the order must be marks, then filter text, then the list itself')
        assert.ok(body.includes('input.focus()'), 'closing from the filter box must hand the caret back to the field')
        const keys = handlerBody('handleSuggestKey')
        assert.ok(/event\.key === 'Escape'\)\{[\s\S]*preventDefault\(\)[\s\S]*stopPropagation\(\)[\s\S]*escapeSearchSuggestions\(\)/.test(keys),
            'every Escape step must be swallowed, so the dropdown keeps winning Escape')
        // The bare-Escape selection collapse (1.9.7) must still stand aside while this list is open.
        assert.ok(/if \(document\.getElementById\('searchSuggestions'\)\) return/.test(webviewSource),
            'the bare-Escape collapse must still yield to an open suggestion list')
    })

    await test('search dropdown: Enter applies every mark, or picks the highlighted row when there is none', () => {
        const keys = handlerBody('handleSuggestKey')
        assert.ok(/if \(markedSearchValues\(\)\.length\)\{ applyMarkedSuggestions\(input\); return \}/.test(keys),
            'with marks, Enter must insert them all')
        assert.ok(keys.includes('applySearchSuggestion(input, activeSuggestion())'),
            'with none, Enter keeps the existing first-match pick')
        // The same handler serves the field and the list's filter box, so both agree.
        assert.ok(handlerBody('onSearchKeyDown').includes('handleSuggestKey(event, getSearchInput())'),
            'the search field uses the shared handler while the list is open')
        assert.ok(handlerBody('buildSuggestFilterRow').includes('handleSuggestKey(event, input)'),
            'so does the embedded filter box')
        // Arrow keys skip whatever the filter is hiding.
        assert.ok(handlerBody('moveSuggestActive').includes("hasAttribute('hidden')"), 'the arrows must skip filtered-out rows')
    })

    await test('search dropdown: marks are held by VALUE, so filtering cannot lose them', () => {
        assert.ok(/var searchMarks = null/.test(webviewSource), 'the marks live outside the per-keystroke list state')
        const toggle = handlerBody('toggleSearchMark')
        assert.ok(toggle.includes('searchMarks.values.indexOf(value)'), 'a mark is identified by its value, never by a row index')
        assert.ok(/searchMarks\.kind !== kind/.test(toggle), 'marks belong to one token kind')
        // Filtering only hides rows; it must not touch the marks.
        assert.ok(!/searchMarks/.test(handlerBody('applySuggestFilter')), 'filtering must leave the marks alone')
        // A kind change (tag: -> notebook:) drops them; no list at all drops them.
        assert.ok(/searchMarks && searchMarks\.kind !== token\.kind\) searchMarks = null/.test(handlerBody('onSearchInput')),
            'a different token kind must drop the marks')
        assert.ok(handlerBody('hideSearchSuggestions').includes('searchMarks = null'), 'no list, no marks')
    })

    await test('search dropdown: a background re-render carries an in-progress multi-select across', () => {
        // The panel markup is replaced on every refresh, which used to close the list. Losing a half-built
        // ten-tag selection to a sync landing would be expensive, so the marks ride across and the list re-opens
        // from the restored draft.
        const body = handlerBody('reconcile')
        assert.ok(/var keptSuggest = \(searchFocused && searchSuggestion\)/.test(body),
            'an OPEN list, not merely the marks, is what rides across the render')
        assert.ok(/marks: searchMarks, filter: suggestFilterText, caret: suggestFilterCaret, focus: searchFocusTarget/.test(body),
            'the marks are kept across the render, and so are the filter text, its caret and where the focus was')
        const restoreAt = body.indexOf('restoreSearchDraft()')
        const reopenAt = body.indexOf('reopenSearchSuggestions(keptSuggest)')
        assert.ok(restoreAt >= 0 && reopenAt > restoreAt, 'the list is rebuilt AFTER the draft text is back')
        assert.ok(handlerBody('reopenSearchSuggestions').includes('onSearchInput(input)'),
            'the rebuild goes through the normal path, so the candidates match whatever is now in the field')
    })

    await test('search dropdown: the re-render also carries the embedded FILTER text, its caret and the focus', () => {
        // Slava: "Sync is a very often thing here". A sync-triggered reconcile used to re-open the list with the
        // marks intact but the filter box emptied - so the list snapped back to full width and the caret jumped
        // out to the search field, mid-selection.
        //
        // The box is inside the markup the host REPLACES, so by the time reconcile runs its node is gone: the text
        // has to be mirrored into module state as it is typed, which is what makes carrying it possible at all.
        const filter = handlerBody('applySuggestFilter')
        assert.ok(/suggestFilterText = box \? box\.value : ''/.test(filter),
            'the filter box must be mirrored into module state on every narrowing')
        assert.ok(/suggestFilterCaret = box \? \(box\.selectionStart \|\| 0\) : 0/.test(filter), 'and so must its caret')
        // Where the focus was: the field, the box, or the apply button.
        const row = handlerBody('buildSuggestFilterRow')
        assert.ok(/box\.addEventListener\('focus', function\(\)\{ searchFocusTarget = 'filter' \}\)/.test(row),
            'reaching into the filter box must be recorded')
        assert.ok(/apply\.addEventListener\('focus', function\(\)\{ searchFocusTarget = 'apply' \}\)/.test(row),
            'and so must reaching for the apply button')
        assert.ok(handlerBody('onSearchFocus').includes("searchFocusTarget = 'field'"), 'and the field itself')
        // The restore is applied to whichever list is built NEXT, which is what makes it work for title: too -
        // that list arrives a debounced round-trip later rather than synchronously.
        assert.ok(handlerBody('reopenSearchSuggestions').includes('pendingSuggestRestore = {'),
            'the re-open must arm a pending restore rather than touching a list that does not exist yet')
        assert.ok(handlerBody('renderSearchSuggestions').includes('applyPendingSuggestRestore(menu, input)'),
            'and every built list must consume it')
        const apply = handlerBody('applyPendingSuggestRestore')
        assert.ok(apply.includes('pendingSuggestRestore = null'), 'consumed exactly once')
        assert.ok(apply.includes('box.value = restore.filter') && apply.includes('applySuggestFilter(menu)'),
            'the text must go back AND re-narrow the rows')
        assert.ok(/restore\.focus === 'filter'[\s\S]{0,200}box\.setSelectionRange\(caret, caret\)/.test(apply),
            'the caret must go back into the box it came from')
        assert.ok(/restore\.focus === 'apply'[\s\S]{0,400}apply\.focus\(\)/.test(apply),
            'and the apply button must be able to keep it too')
        // A list that closes for real takes the mirrored state with it, so a FRESH list always opens with an
        // empty box - the behaviour before this change.
        const hide = handlerBody('hideSearchSuggestions')
        assert.ok(hide.includes("suggestFilterText = ''") && hide.includes('pendingSuggestRestore = null'),
            'closing the list must drop the mirrored filter text and any unconsumed restore')
    })

    await test('search dropdown: touch marks with a long press, and the pick moved off pointerdown', () => {
        // A long press BEGINS with a pointerdown, so the old commit-on-pointerdown would have closed the list
        // before the hold could fire; and preventDefault on a touch pointerdown also stops the list scrolling.
        const down = handlerBody('onSuggestPointerDown')
        assert.ok(/event\.preventDefault\(\)/.test(down),
            'the touch pointerdown cancels its default actions (see the 1.9.10 mirror test for why)')
        assert.ok(/setTimeout\([\s\S]*toggleSearchMark\(suggestPress\.value\)[\s\S]*SUGGEST_LONG_PRESS_MS/.test(down),
            'a hold must mark the row it began on')
        assert.ok(/SUGGEST_LONG_PRESS_MS = 500/.test(webviewSource), 'the hold matches the list long-press (500ms)')
        const up = handlerBody('onSuggestPointerUp')
        assert.ok(/if \(held \|\| moved/.test(up), 'a hold that already marked, or a scroll, must not also pick')
        assert.ok(/if \(markedSearchValues\(\)\.length\) toggleSearchMark\(pressed\)/.test(up),
            'in selection mode a tap toggles')
        assert.ok(/else applySearchSuggestion\(getSearchInput\(\), suggestionByValue\(pressed\)\)/.test(up),
            'with nothing marked a tap is the ordinary single pick')
        assert.ok(handlerBody('onSuggestPointerMove').includes('SUGGEST_MOVE_SLOP'), 'movement past the slop abandons the press')
        assert.ok(/document\.addEventListener\('scroll', cancelSuggestPress, true\)/.test(webviewSource),
            'scrolling must abandon the press, on the same capture signal the to-do adapter uses')
        // The dropdown deliberately posts NO dialogGuard: it opens and closes on every keystroke, so bracketing it
        // could leak the guard and freeze mobile refreshes forever - and the search-focus hold already pauses them.
        assert.ok(!/dialogGuard/.test(handlerBody('renderSearchSuggestions')) && !/dialogGuard/.test(handlerBody('hideSearchSuggestions')),
            'the suggestion list must not touch the overlay refresh guard')
    })

    await test('mobile long press: the row gestures mirror the PROVEN to-do-row adapter (1.9.9 device fix)', () => {
        // Slava's Pixel: a short tap picked correctly, but a HOLD closed the whole list and left only the typed
        // fragment. The JS press tracker was already a copy of the to-do adapter; what it did NOT copy was that
        // adapter's CSS. Android's native long press therefore won on these rows - it started a text selection
        // and raised the system callout, which takes the pointer (pointercancel abandons the 500ms hold) and
        // blurs the field (which tore the list down). These pin both halves of the mirror.
        //
        // (a) The CSS suppression, the same three properties the to-do rows carry, mobile-gated like them.
        const suppression = /\.cockpit-mobile #searchSuggestions \.dropdown-item,\s*\.cockpit-mobile #searchSuggestions \.dropdown-label \{([^}]*)\}/.exec(panelCssSource)
        assert.ok(suppression, 'the suggestion rows must carry the mobile gesture suppression')
        assert.ok(/-webkit-touch-callout:\s*none/.test(suppression[1]), 'the iOS/Android long-press callout must be suppressed')
        assert.ok(/-webkit-user-select:\s*none/.test(suppression[1]) && /[^-]user-select:\s*none/.test(suppression[1]),
            'native text selection must be suppressed, in both spellings')
        // pan-y, NOT a blanket preventDefault: the list must still scroll vertically (15 rows and more).
        assert.ok(/touch-action:\s*pan-y/.test(suppression[1]),
            'the rows must keep vertical scrolling while giving up every other native gesture')
        // 1.9.10 correction: the earlier round asserted the ABSENCE of preventDefault here, on the premise that
        // cancelling a touch pointerdown blocks panning. That premise was wrong - panning is governed by
        // touch-action (pan-y, asserted above) and by touchstart/touchmove, not by pointerdown - and leaving
        // the default in place is what let Android's native long press take the gesture. Cancelling it kills
        // the focus change and the native selection at source, so the field never blurs.
        assert.ok(/event\.preventDefault\(\)/.test(handlerBody('onSuggestPointerDown')),
            'the touch pointerdown must cancel its default actions (focus change, native selection)')
        // What must not happen is a SYNCHRONOUS pick: a hold begins with this same pointerdown, so committing
        // here would close the list before the 500ms could elapse. Marking from inside the hold's timer is the
        // gesture itself and is expected.
        const downBody = handlerBody('onSuggestPointerDown')
        assert.ok(!/applySearchSuggestion/.test(downBody), 'the pointerdown must never pick - the pick waits for pointerup')
        const beforeTimer = downBody.slice(0, downBody.indexOf('setTimeout('))
        assert.ok(!/toggleSearchMark/.test(beforeTimer), 'and must not mark before the hold has actually fired')
        // The to-do rows keep their own rule - this ADDS to the proven one, it does not move it.
        assert.ok(/\.cockpit-mobile \.todo,\s*\.cockpit-mobile h2\[data-todo-ids\] \{[^}]*-webkit-touch-callout:\s*none/.test(panelCssSource),
            'the to-do rows must keep the suppression that has always worked')

        // (b) The listeners are registered ONCE on the document in the CAPTURE phase, like the to-do adapter,
        // rather than on the list element: capture cannot be stopped on the way up, and one registration
        // survives the list being rebuilt on every keystroke.
        for (const wiring of [
            "document.addEventListener('pointerdown', onSuggestPointerDown, true)",
            "document.addEventListener('pointermove', onSuggestPointerMove, true)",
            "document.addEventListener('pointerup', onSuggestPointerUp, true)",
            "document.addEventListener('pointercancel', cancelSuggestPress, true)",
        ]){
            assert.ok(webviewSource.includes(wiring), `the press tracking must be wired as: ${wiring}`)
        }
        assert.ok(handlerBody('wireSuggestList').includes('if (IS_MOBILE) return'),
            'nothing touch-related may hang off the list element any more')
        // Each handler does its own gating, exactly as the to-do adapter's does.
        const down = handlerBody('onSuggestPointerDown')
        assert.ok(down.includes('if (!IS_MOBILE) return') && down.includes("event.pointerType === 'mouse'"),
            'the press tracker must be inert on desktop and for a mouse')
        assert.ok(down.includes("closest('#searchSuggestions .dropdown-item')"),
            'and must only arm on a row of the OPEN suggestion list')

        // (c) contextmenu on mobile is suppressed PANEL-WIDE since the second Pixel round (the rows' own inline
        // handlers were opening the context menu behind the touch drag's back - see the touch-drag block's
        // "Android's long-press contextmenu never reaches a row" pin), so this list is covered a fortiori and
        // what is left to check here is that it still IS covered and that desktop still is not.
        const menuBlock = /document\.addEventListener\('contextmenu', function\(event\)\{([\s\S]*?)\}, true\)/.exec(webviewSource)
        assert.ok(menuBlock, 'the contextmenu suppression must still be there')
        assert.ok(menuBlock[1].includes('if (!IS_MOBILE) return'), 'and only on mobile - desktop right-click is untouched')
        assert.ok(menuBlock[1].includes('preventDefault()'), 'the native menu must be prevented over this list too')
        assert.ok(!menuBlock[1].includes("closest('#searchSuggestions')"),
            '...and no longer ONLY over this list: scoping it back to the suggestions is exactly what let Android open a row menu behind the drag')
    })

    await test('mobile long press: the synthetic click is swallowed, as the to-do adapter has always done (1.9.10)', () => {
        // The named difference between the working gesture and the broken one. The browser synthesises a click
        // after a touch gesture; the to-do adapter swallows it, this list did not. That click lands wherever the
        // gesture ended - after a cancelled or re-targeted press, not necessarily on a row - and a click outside
        // the list runs closeAllDropdowns, which removes the list while leaving the typed text in the field:
        // exactly the reported "the window closes and bare tag: remains".
        const proven = /document\.addEventListener\('click', function\(event\)\{\s*if \(longPress\.fired\)\{ longPress\.fired = false; event\.preventDefault\(\); event\.stopPropagation\(\) \}\s*\}, true\)/
        assert.ok(proven.test(webviewSource), 'the to-do adapter must keep its click swallower (the model being copied)')
        // The suggestion list now has the same guard, armed by any press that began on one of its rows.
        assert.ok(/if \(!IS_MOBILE \|\| !suggestPress\.clickArmed\) return/.test(webviewSource),
            'the suggestion list must swallow the click of its own gesture, mobile only')
        assert.ok(/suggestPress\.clickArmed = true/.test(handlerBody('onSuggestPointerDown')),
            'a press that began on a row owns the click that follows it')
        // THE RELEASE SIDE. Arming was pinned; releasing was not, which is exactly how a leak shipped: the arm
        // was cleared ONLY by the swallower consuming a click, and a press cancelled by a scroll produces no
        // synthetic click at all - so the arm survived and this document-level listener ate the NEXT click
        // anywhere (measured: long-press to mark, scroll, tap Apply, nothing happens until a second tap).
        assert.ok(webviewSource.includes("document.addEventListener('pointerup', releaseSuggestClickArm, true)") &&
                  webviewSource.includes("document.addEventListener('pointercancel', releaseSuggestClickArm, true)"),
            'the arm must be released when the gesture ENDS, however it ended')
        const armRelease = handlerBody('releaseSuggestClickArm')
        assert.ok(armRelease.includes('setTimeout('),
            'a tick later, so a cancelled press whose click DOES land is still covered before disarming')
        assert.ok(armRelease.includes('if (!suggestPress.clickArmed || suggestClickArmTimer) return'),
            'and idempotently, only for a live arm')
        assert.ok(handlerBody('onSuggestPointerDown').includes('if (suggestClickArmTimer){ clearTimeout(suggestClickArmTimer); suggestClickArmTimer = null }'),
            'a fresh press must cancel a pending release so it keeps its own arm')
        // The swallow is scoped to clicks OUTSIDE the list, which is what makes it deterministic rather than a
        // race with the release: a click inside the list is already safe (the dismissal listener excludes it)
        // and is usually a control the user meant to press - the Apply button, the filter box, another row.
        const swallowAt = webviewSource.indexOf("if (!IS_MOBILE || !suggestPress.clickArmed) return")
        const swallowBody = webviewSource.slice(swallowAt, webviewSource.indexOf('}, true)', swallowAt))
        assert.ok(swallowBody.includes('suggestPress.clickArmed = false'), 'it consumes the arm either way')
        assert.ok(swallowBody.includes("closest('#searchSuggestions')) return"),
            'and never swallows a click that landed inside the list')
        // Capture phase, so it runs before the dismissal listeners it is protecting the list from.
        const swallower = /if \(!IS_MOBILE \|\| !suggestPress\.clickArmed\) return[\s\S]*?\}, true\)/.exec(webviewSource)
        assert.ok(swallower, 'the swallower must be registered in the capture phase')
    })

    await test('mobile diagnostic: the gesture trace is a mobile-only, default-off, HIDDEN setting (1.9.10, hidden in 2.3.0)', () => {
        // After two device rounds spent guessing, the next one can report what actually fired.
        const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'settings.ts'), 'utf8')
        assert.ok(/gestureTraceSettingKey = "gestureTrace"/.test(settingsSource), 'the setting must exist')
        const block = /\[gestureTraceSettingKey\]: \{([\s\S]*?)\},/.exec(settingsSource)
        assert.ok(block, 'the setting must be registered')
        assert.ok(/value: false/.test(block[1]), 'and default to OFF')
        assert.ok(/type: SettingItemType\.Bool/.test(block[1]), 'as a Bool')
        // HIDDEN, not removed (2.3.0, the owner's call once the mobile drag rounds were done): the mobile drag
        // shipped, so a diagnostic strip has no place on a user's Settings screen - but every line of the
        // machinery below stays, so a future device round only flips this one word in a dev build. public: false
        // keeps the setting registered, readable and default-off; everything the rest of this pin asserts is
        // exactly what it asserted while the setting was public, which is the point of hiding it rather than
        // deleting it.
        assert.ok(/public: false/.test(block[1]),
            'and it must be OFF the Settings screen - public: false, so it stays readable without being offered')
        assert.ok(!/public: true/.test(block[1]), 'with no public: true left in the block to contradict that')
        // Reaches the webview through the island it already reads - no new plumbing, no extra round-trip.
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        assert.ok(/gestureTrace: gestureTrace,/.test(panelSource), 'it must ride in the search-data island')
        // Inert unless mobile AND enabled, so it costs nothing when off.
        // THE SURFACING. The flag reached the island but readSearchData() never returned it, so
        // gestureTraceEnabled() read undefined and the whole diagnostic was dead code. The previous pin only
        // checked that the setting existed, which is why that shipped. Drive the real reader against a real
        // island instead of pattern-matching it.
        const readBody = handlerBody('readSearchData')
        assert.ok(readBody.includes('gestureTrace: !!data.gestureTrace'),
            'readSearchData must surface gestureTrace, or the setting does nothing at all')
        assert.ok(readBody.includes('return { tags: [], notebooks: [], gestureTrace: false }'),
            'including on the malformed-island fallback, so the shape never varies')
        // Executed for real against a stub document, so a missing property fails here rather than on a device.
        const runReader = new Function('document', readBody + '\n}; return readSearchData()')
        const island = (text) => ({ getElementById: () => ({ textContent: text }) })
        assert.strictEqual(runReader(island('{"gestureTrace":true,"tags":[],"notebooks":[]}')).gestureTrace, true,
            'an island carrying the flag must come back with it set')
        assert.strictEqual(runReader(island('{"tags":[],"notebooks":[]}')).gestureTrace, false,
            'and an island without it must come back false, never undefined')
        // Read ONCE per render, not per traced pointer event - tracing sits on the gesture path.
        assert.ok(handlerBody('gestureTraceEnabled').includes('return gestureTraceOn'),
            'the per-event check must be a cached boolean, not a JSON parse')
        assert.ok(handlerBody('refreshGestureTraceFlag').includes('gestureTraceOn = IS_MOBILE && !!readSearchData().gestureTrace'),
            'the cached flag stays mobile-only and opt-in')
        assert.ok(handlerBody('reconcile').includes('refreshGestureTraceFlag()'), 'refreshed once per render')
        assert.ok(handlerBody('renderSearchSuggestions').includes('refreshGestureTraceFlag()'),
            'and when a list opens between renders')
        assert.ok(handlerBody('traceGesture').includes('if (!gestureTraceEnabled()) return'),
            'and every trace point must bail out first when it is off')
        // It reports WHY the list closed, which is the question two device rounds could not answer.
        assert.ok(/list-closed:' \+ \(\(options && options\.reason\)/.test(webviewSource),
            'the teardown must record its reason')
        for (const reason of ['menus-closed', 'field-left', 'commit', 'no-token', 'escape', 'applied']){
            assert.ok(webviewSource.includes("reason: '" + reason + "'"), `the ${reason} teardown must be named`)
        }
        // 2.5.1: HIDING THE TOGGLE WAS NOT THE SAME AS TURNING IT OFF. Joplin keeps a setting's stored value when
        // the registration goes public: false, so the owner's Pixel - where the trace was switched on for the 2.3.0
        // rounds while the toggle was still public (1.9.10 through 2.2.1) - kept reading back true and kept the
        // sticky strip at the bottom of the panel, with no switch left anywhere to turn it off. What decides now is
        // the BUILD, not the value: one exported constant, false in everything that ships.
        assert.ok(/export const gestureTraceAvailable(?:: boolean)? = false/.test(settingsSource),
            'the shipped source must declare the trace unavailable')
        assert.ok(!/export const gestureTraceAvailable(?:: boolean)? = true/.test(settingsSource),
            'and no dev-build flip of that constant may ever be committed')
        // EVERY reader is gated on it, counted across the whole of src/ so a third one cannot appear later that
        // quietly trusts the stored value: the startup self-heal (which returns before reading in a dev build) and
        // the island writer (which short-circuits the read entirely) are the only two.
        const srcFiles = []
        const walkSrc = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) walkSrc(full)
                else srcFiles.push(full)
            }
        }
        walkSrc(path.join(__dirname, '..', 'src'))
        let traceReads = 0
        for (const file of srcFiles){
            traceReads += (fs.readFileSync(file, 'utf8').match(/settings\.value\(gestureTraceSettingKey\)/g) || []).length
        }
        assert.strictEqual(traceReads, 2,
            'exactly two reads of the setting may exist in src/ - the self-heal and the island writer - and both are gated below')
        assert.ok(/var gestureTrace = gestureTraceAvailable && !!\(await joplin\.settings\.value\(gestureTraceSettingKey\)\)/.test(panelSource),
            'the island writer must consult the build constant FIRST, short-circuiting the read, so a stale true cannot reach the webview even on the render that precedes the startup reset')
        const resetBody = /export async function resetUnavailableGestureTrace\(\)\{([\s\S]*?)\n\}/.exec(settingsSource)
        assert.ok(resetBody, 'the startup self-heal must exist')
        assert.ok(/^\s*if \(gestureTraceAvailable\) return/.test(resetBody[1]),
            'and stand down in a dev build before it reads anything')
        assert.ok(/await joplin\.settings\.setValue\(gestureTraceSettingKey, false\)/.test(resetBody[1]),
            'writing the stored value back to false is the whole point of it')
        assert.ok(/console\.info\(/.test(resetBody[1]), 'and saying so once in the log')
        assert.ok(/await resetUnavailableGestureTrace\(\)/.test(settingsSource), 'it must actually be called at startup')
        assert.ok(settingsSource.indexOf('registerSettings(') < settingsSource.indexOf('await resetUnavailableGestureTrace()'),
            'after the settings are registered, since it reads and writes one of them')
    })

    // ------------------------------------------------ the stale gesture trace heals itself (2.5.1)
    // The owner's report: the mobile panel still shows the diagnostic strip and the setting that switched it off is
    // gone. Both runs below model that profile exactly - a stored `gestureTrace: true` left over from a build where
    // the toggle was public - and prove the two halves of the fix on both platforms: the value is written back to
    // false at startup, and the island the webview reads carries the flag OFF regardless.
    const staleTraceMobile = await run({
        dataDir: path.join(tmp, 'stale-trace-mobile-data'),
        installationDir: path.join(tmp, 'mobile-install'),
        require: mobileRequire,
        versionInfo: { version: '3.7.0', platform: 'mobile' },
        todos,
        initialSettings: { gestureTrace: true },
    })
    const staleTraceDesktop = await run({
        dataDir: path.join(tmp, 'stale-trace-desktop-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos,
        initialSettings: { gestureTrace: true },
    })

    for (const [platform, state] of [['mobile', staleTraceMobile], ['desktop', staleTraceDesktop]]){
        await test(`${platform}: a profile with the hidden gesture trace still stored ON has it switched off at startup (2.5.1)`, () => {
            const writes = state.settingWrites.filter(write => write.key === 'gestureTrace')
            assert.deepStrictEqual(writes, [{ key: 'gestureTrace', value: false }],
                'startup must write the stale true back to false, exactly once')
            assert.strictEqual(state.settings.gestureTrace, false, 'and the stored value must end the run OFF')
        })
        await test(`${platform}: the stale trace never reaches the webview - the island carries it OFF (2.5.1)`, () => {
            const html = state.panelHtml['panel-panel']
            assert.ok(html.includes('<script id="cockpitSearchData"'), 'the search-data island must be rendered')
            assert.ok(html.includes('"gestureTrace":false'), 'and it must carry the flag OFF')
            assert.ok(!html.includes('"gestureTrace":true'),
                'with no trace marker anywhere in the panel html - the strip is drawn only when this flag is true')
        })
    }

    await test('the gesture trace is one constant away from coming back, and that constant is the dev build (2.5.1)', () => {
        // THE DEV-BUILD BEHAVIOUR, pinned as such. Flip gestureTraceAvailable to true in src/core/settings.ts and
        // the 2.3.0 behaviour returns whole: resetUnavailableGestureTrace returns on its first line, so a stored
        // true is left alone, and the island writer's `gestureTraceAvailable && ...` stops short-circuiting and
        // hands the stored value to the webview - the strip is back, without a line of plumbing changing. That is
        // deliberately the ONLY switch (plus the registration's public flag, if the toggle is also wanted on the
        // Settings screen), and it is what MOBILE.md's device-round recipe names. With the flip in place the pins
        // above go red by design; the flip is never committed.
        const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'settings.ts'), 'utf8')
        const constant = /export const gestureTraceAvailable(?:: boolean)? = (true|false)/.exec(settingsSource)
        assert.ok(constant, 'the constant must be a single exported literal, so flipping it is a one-word edit')
        assert.strictEqual(constant[1], 'false', 'and it ships false')
        const mobileDoc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'MOBILE.md'), 'utf8')
        assert.ok(mobileDoc.includes('gestureTraceAvailable'),
            'the dev-build recipe in docs/MOBILE.md must name the constant, or the next device round flips the wrong word')
    })

    await test('mobile long press: the press-inside flag covers the whole HOLD, not just a tap (1.9.9 device fix)', () => {
        // A tap's blur lands within a tick of the pointerdown, so clearing the flag on a start-anchored tick was
        // enough for a tap. A HOLD keeps the finger down for half a second, and any blur Android raises in that
        // window then looked like the user leaving: leaveSearchField hid the list and posted
        // searchFocusChanged(false), which is exactly the reported "the window closes, leaving only tag:".
        assert.ok(/document\.addEventListener\('pointerup', releaseSuggestPointerInside, true\)/.test(webviewSource) &&
                  /document\.addEventListener\('pointercancel', releaseSuggestPointerInside, true\)/.test(webviewSource),
            'the flag must be released when the press ENDS, not a tick after it began')
        const release = handlerBody('releaseSuggestPointerInside')
        assert.ok(/setTimeout\(/.test(release),
            'and one tick after that, so the blur the press itself causes is still covered')
        // It stays tied strictly to the press: an unrelated blur with no finger down is still a real departure.
        assert.ok(/if \(!suggestPointerInside \|\| suggestPointerInsideTimer\) return/.test(release),
            'releasing must be idempotent and only apply to a live press')
        // The blur path consumes it, keeping the list and handing the caret back.
        assert.ok(/if \(suggestPointerInside\)\{ restoreSearchDraft\(\); return \}/.test(handlerBody('onSearchBlur')),
            'a blur during a press inside the list must hand the caret back, not tear the list down')
    })

    // ============================================================ any:1 must not dissolve Cockpit's narrowing
    // The bug: Cockpit builds its searches by concatenating its own terms onto the user's criteria
    // (`type:todo`, `iscompleted:0`, `due:...`, the excluded-notebook clauses). Joplin's `any:1` ORs EVERY term
    // in the string, so each of those became an alternative rather than a constraint - and `type:todo` matches
    // every to-do, so the filter collapsed and the panel listed everything (Slava: "any:1 shows notes with none
    // of the tags"). Proven by logging the query that was sent; fixed by keeping Cockpit's terms out of such a
    // query and applying them to the results instead.
    const anyFolder = 'n'.repeat(32)
    const anySoon = Date.now() + 3600000
    // One of each thing the narrowing is supposed to remove, plus one row that must survive.
    const anyTodos = [
        { id: 'a'.repeat(32), title: 'AnyOpenDue',   is_todo: 1, todo_completed: 0,          todo_due: anySoon, parent_id: anyFolder, user_updated_time: 1 },
        { id: 'b'.repeat(32), title: 'AnyCompleted', is_todo: 1, todo_completed: Date.now(), todo_due: anySoon, parent_id: anyFolder, user_updated_time: 1 },
        { id: 'c'.repeat(32), title: 'AnyNoDue',     is_todo: 1, todo_completed: 0,          todo_due: 0,       parent_id: anyFolder, user_updated_time: 1 },
        { id: 'd'.repeat(32), title: 'AnyPlainNote', is_todo: 0, todo_completed: 0,          todo_due: 0,       parent_id: anyFolder, user_updated_time: 1 },
    ]
    // A profile that hides completed and no-due, so all three narrowing terms are actually in play.
    const anyProfile = {
        ...baseProfile, name: 'Any', showNotes: false, showNoDue: false,
        showCompletedPast: false, showCompletedToday: false, showCompletedFuture: false, showCompletedNoDue: false,
    }
    const anyRun = async () => await run({
        dataDir: path.join(tmp, 'any-mode-data-' + Math.random().toString(36).slice(2)),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: anyTodos,
        folders: [{ id: anyFolder, title: 'Box', parent_id: '' }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...anyProfile, id: 1, sortOrder: 0, noteID: '' }] }),
            currentProfileID: 1,
        },
    })
    const listQueries = (state) => state.gets.filter(g => g.path[0] === 'search').map(g => String(g.query.query))
    const shownTitles = (state) => (String(state.panelHtml['panel-panel'] || '').match(/class="todo-title"[^>]*>([^<]*)/g) || [])
        // Interval rows render as "11:09 AM - Title"; the time prefix is not what these checks are about.
        .map(x => x.split('>').pop().trim().replace(/^\d{1,2}:\d{2}(\s?[AP]M)?\s*-\s*/i, ''))

    await test('any:1: Cockpit sends the user query ALONE - none of its own terms become OR alternatives', async () => {
        const state = await anyRun()
        state.gets.length = 0
        await state.panelMessageHandler(['searchFilterChanged', 'tag:one tag:two any:1'])
        const queries = listQueries(state)
        assert.ok(queries.length > 0, 'a search must have run')
        for (const q of queries){
            // These are the terms that silently became alternatives, and with them the whole filter.
            assert.ok(!/type:todo/.test(q), `type:todo must not ride along in an any:1 query: ${q}`)
            assert.ok(!/type:note/.test(q), `type:note must not ride along in an any:1 query: ${q}`)
            assert.ok(!/iscompleted:/.test(q), `iscompleted: must not ride along in an any:1 query: ${q}`)
            assert.ok(!/due:19700201/.test(q), `the due floor must not ride along in an any:1 query: ${q}`)
            assert.strictEqual(q.trim(), 'tag:one tag:two any:1', 'the user string is sent verbatim')
        }
    })

    await test('any:1: the narrowing those terms did is applied to the results instead', async () => {
        // The stub answers the type-less any:1 search with the whole fixture set, exactly as the real API
        // would once type:todo is gone. Only the open, due to-do may survive: the completed one, the one with
        // no due date and the plain note are all removed by Cockpit itself.
        const state = await anyRun()
        await state.panelMessageHandler(['searchFilterChanged', 'tag:one tag:two any:1'])
        assert.deepStrictEqual(shownTitles(state), ['AnyOpenDue'],
            'type:todo, iscompleted:0 and the due floor must still be constraints under any:1')
    })

    await test('any:1: a query WITHOUT it is byte-identical to before - the common path is untouched', async () => {
        const state = await anyRun()
        state.gets.length = 0
        await state.panelMessageHandler(['searchFilterChanged', 'tag:one tag:two'])
        const queries = listQueries(state)
        const listQuery = queries.find(q => q.includes('type:todo'))
        assert.ok(listQuery, 'the ordinary path must still push type:todo into the query')
        assert.ok(/iscompleted:0/.test(listQuery), 'and iscompleted:0, since this profile hides completed')
        assert.ok(/due:19700201/.test(listQuery), 'and the due floor, since this profile hides no-due')
        assert.ok(listQuery.includes('tag:one tag:two'), 'with the user criteria appended as always')
    })

    await test('any:1: the cache key describes what it caches', () => {
        // The ordinary query encodes the whole view - its narrowing terms ARE the query - so it doubles as the
        // key. An any:1 query does not: the narrowing moved out of it while the cached value is the NARROWED
        // list, so two views differing only in "show completed" would share one entry. Unreachable today, but a
        // key that does not describe its value is a trap for the next change.
        const cacheSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'joplin.ts'), 'utf8')
        assert.ok(cacheSource.includes('`any|c${showCompleted ? 1 : 0}|d${showNoDue ? 1 : 0}|x${excluded.clauses}|${query}`'),
            'the any-mode to-do key must carry the narrowing state it applied')
        assert.ok(cacheSource.includes('var cacheKey = unfiltered ? `listing|x${excluded.clauses}` : anyMode ? `any|x${excluded.clauses}|${query}` : query'),
            'and the notes key its own, with the listing path naming its source and exclusion state')
        assert.ok(cacheSource.includes('if (limit) cacheKey += `|n${limit}`'), 'a capped notes set is keyed by its cap')
        for (const site of ['todosResultCache.has(cacheKey)', 'todosResultCache.get(cacheKey)',
                            'notesResultCache.has(cacheKey)', 'notesResultCache.get(cacheKey)',
                            'cacheResult(todosResultCache, cacheKey, allTodos)',
                            'cacheResult(notesResultCache, cacheKey, allNotes)']){
            assert.ok(cacheSource.includes(site), `every cache site must use the key: ${site}`)
        }
        assert.ok(!/cacheResult\((todos|notes)ResultCache, query,/.test(cacheSource),
            'nothing may still cache under the raw query')
    })

    await test('any:1: detection is a whole token, and errs towards the safe (client-side) path', async () => {
        // Read from the webview-independent source: the same rule the plugin compiles in.
        const joplinSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'joplin.ts'), 'utf8')
        assert.ok(/const ANY_MODE_PATTERN = \/\(\^\|\\s\)any:1\(\\s\|\$\)\/i/.test(joplinSource),
            'any:1 must be matched as a whitespace-delimited token, case-insensitively')
        // notebook: is deliberately LEFT in the query: Joplin keeps notebook scope as AND even under any:1, so
        // it is still a constraint there, and moving it client-side would cost a much wider search.
        assert.ok(/notebook:` keeps|notebook:` is|notebook:. is left in the query|keeps notebook scope as AND/.test(joplinSource),
            'the notebook: decision must be recorded next to the rule')
        // The excluded-notebook ids were always the authority client-side, so dropping their clauses is safe.
        assert.ok(/filterExcluded\(allTodos, excluded\.set\)/.test(joplinSource),
            'the excluded-notebook filter must still run on the any:1 path')
    })

    // ---- emptying the field returns the panel to "all" (the second Pixel report, 1.9.9) -------------------
    // Diagnosed empirically before fixing: the HOST was never at fault - an empty committed query already
    // restores the unfiltered view on both platforms. The two broken layers were (1) the webview never
    // committed at all when the field was emptied by input (backspace/cut: `input` is the only event they
    // fire, `change` waits for a blur, `search` for the ×), and (2) on mobile the search-focus hold swallowed
    // the render even when a commit did happen.
    await test('empty search (host): an empty committed query restores the unfiltered view on both platforms', async () => {
        for (const state of [desktop, mobile]){
            await state.panelMessageHandler(['searchFilterChanged', 'Zzqq-no-such-note'])
            const filtered = state.panelHtml['panel-panel']
            assert.ok(/id="searchFilter"[\s\S]*?value="Zzqq-no-such-note"/.test(filtered), 'the filter must render as committed')
            await state.panelMessageHandler(['searchFilterChanged', ''])
            const cleared = state.panelHtml['panel-panel']
            assert.ok(/id="searchFilter"[\s\S]*?value=""/.test(cleared),
                'an empty commit must clear the committed filter - the host side was never the bug')
        }
    })

    await test('empty search (host): the auto-reset renders through the mobile focus hold, ordinary commits still do not', async () => {
        // The hold exists so a setHtml cannot wipe the field mid-typing - on mobile a render is a full webview
        // reload. The reset is the one commit that must be exempt: the user has emptied the field, there is
        // nothing left to type, and waiting for a blur that may never come leaves the panel filtered forever.
        await mobile.panelMessageHandler(['searchFilterChanged', 'tag:work'])
        await mobile.panelMessageHandler(['searchFocusChanged', true])

        const beforeOrdinary = mobile.setHtmlCalls
        await mobile.panelMessageHandler(['searchFilterChanged', 'tag:other'])
        assert.strictEqual(mobile.setHtmlCalls - beforeOrdinary, 0,
            'an ordinary commit while the field is focused must still be held on mobile')

        const beforeReset = mobile.setHtmlCalls
        await mobile.panelMessageHandler(['searchFilterChanged', '', true])
        assert.strictEqual(mobile.setHtmlCalls - beforeReset, 1, 'the auto-reset must render straight away')
        assert.ok(/id="searchFilter"[\s\S]*?value=""/.test(mobile.panelHtml['panel-panel']),
            'and the render must show the cleared filter')
        // The hold is not torn down by the exemption: the field is still focused as far as the host knows, so
        // the next ordinary commit is held again.
        const afterReset = mobile.setHtmlCalls
        await mobile.panelMessageHandler(['searchFilterChanged', 'tag:again'])
        assert.strictEqual(mobile.setHtmlCalls - afterReset, 0, 'the hold must survive the exempted render')
        await mobile.panelMessageHandler(['searchFocusChanged', false])
    })

    await test('committed search (host): EVERY explicit commit renders, even with the field focused', async () => {
        // The Pixel report: committing a tag:/notebook:/title: search left the list unfiltered. The pick, the
        // apply button and Enter all deliberately keep the field focused (so the soft keyboard stays up), and
        // the mobile hold swallowed the render - the commit landed host-side and nothing painted. The hold is
        // there to stop a setHtml wiping the field while the user is TYPING, not to hide results they asked
        // for, so every explicit commit is now exempt.
        const focused = await run({
            dataDir: path.join(tmp, 'commit-hold-data'),
            installationDir: path.join(tmp, 'mobile-install'),
            require: mobileRequire,
            versionInfo: { version: '3.7.0', platform: 'mobile' },
            todos,
        })
        await focused.panelMessageHandler(['searchFocusChanged', true])

        const beforeFlagged = focused.setHtmlCalls
        await focused.panelMessageHandler(['searchFilterChanged', 'tag:foo', true])
        assert.strictEqual(focused.setHtmlCalls - beforeFlagged, 1,
            'an explicit commit must paint at once, focused or not')
        assert.ok(/id="searchFilter"[\s\S]*?value="tag:foo"/.test(focused.panelHtml['panel-panel']),
            'and the painted markup must carry the committed filter')

        // The hold still does its real job: a commit that is NOT an explicit one is still held while typing.
        const beforeUnflagged = focused.setHtmlCalls
        await focused.panelMessageHandler(['searchFilterChanged', 'tag:partial'])
        assert.strictEqual(focused.setHtmlCalls - beforeUnflagged, 0,
            'the typing protection must survive - an unflagged commit is still held on mobile')

        // And the committed search survives the reload cycle the render causes.
        await focused.panelMessageHandler(['searchFilterChanged', 'tag:foo', true])
        const beforeReopen = focused.setHtmlCalls
        await focused.panelMessageHandler(['dialogGuardReset', false])
        assert.strictEqual(focused.setHtmlCalls - beforeReopen, 0, 'a fresh webview bootstrap renders nothing by itself')
        assert.ok(/id="searchFilter"[\s\S]*?value="tag:foo"/.test(focused.panelHtml['panel-panel']),
            'and it must not revert the committed filter - no path may commit "" the user did not ask for')
    })

    await test('search reload-survival (host): the host holds the in-progress search and re-serves it ONCE', async () => {
        // Mobile only, and the same non-looping handshake the overlay descriptor uses. A renderer kill remounts
        // the webview with a fresh document that carries only the last COMMITTED filter, so the draft, the open
        // dropdown and its marks are gone unless the HOST is holding them.
        const held = await run({
            dataDir: path.join(tmp, 'search-state-data'),
            installationDir: path.join(tmp, 'mobile-install'),
            require: mobileRequire,
            versionInfo: { version: '3.7.0', platform: 'mobile' },
            todos,
        })
        await held.panelMessageHandler(['searchFocusChanged', true])
        const beforeState = held.setHtmlCalls
        await held.panelMessageHandler(['searchState', { draft: 'milk tag:pro', caret: 12, marks: { kind: 'tag', values: ['project'] }, filter: 'pr', filterCaret: 2, focus: 'filter' }])
        assert.strictEqual(held.setHtmlCalls - beforeState, 0, 'holding the state must never render by itself')

        // The reloaded webview reports that its document does NOT carry the island: the host re-renders once WITH it.
        const beforeReload = held.setHtmlCalls
        await held.panelMessageHandler(['dialogGuardReset', false, false])
        assert.strictEqual(held.setHtmlCalls - beforeReload, 1, 'a document without the island must be re-served with it')
        const html = held.panelHtml['panel-panel']
        assert.ok(html.includes('id="cockpitSearchState"'), 'the reconstruct render must embed the search state island')
        const island = JSON.parse(html.slice(html.indexOf('id="cockpitSearchState" type="application/json">') + 'id="cockpitSearchState" type="application/json">'.length, html.indexOf('</script>', html.indexOf('id="cockpitSearchState"'))))
        assert.strictEqual(island.draft, 'milk tag:pro', 'with the uncommitted draft')
        assert.deepStrictEqual(island.marks, { kind: 'tag', values: ['project'] }, 'the marks')
        assert.strictEqual(island.filter, 'pr', 'the dropdown filter text')
        assert.strictEqual(island.focus, 'filter', 'and where the caret was')

        // A document that ALREADY carries it reconstructs itself, so the host stands down - the flow cannot loop.
        const beforeCarrying = held.setHtmlCalls
        await held.panelMessageHandler(['dialogGuardReset', false, true])
        assert.strictEqual(held.setHtmlCalls - beforeCarrying, 0, 'a document that carries the island must not be re-served')

        // Cleared on commit/departure: the webview posts null, and the next render carries no island at all.
        await held.panelMessageHandler(['searchState', null])
        await held.panelMessageHandler(['searchFilterChanged', 'milk', true])
        assert.ok(!held.panelHtml['panel-panel'].includes('id="cockpitSearchState"'),
            'a cleared state must leave no island behind, so nothing can resurrect an abandoned draft')
    })

    await test('search reload-survival (host): nothing is embedded on desktop, and a name cannot close the island', async () => {
        const desk = await run({
            dataDir: path.join(tmp, 'search-state-desktop'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos,
        })
        const before = desk.panelHtml['panel-panel']
        await desk.panelMessageHandler(['searchState', { draft: 'x', caret: 1, marks: null, filter: '', filterCaret: 0, focus: 'field' }])
        await desk.panelMessageHandler(['searchFilterChanged', 'x'])
        assert.ok(!desk.panelHtml['panel-panel'].includes('cockpitSearchState'),
            'desktop keeps its module state, so it must embed no island and stay byte-comparable to before')
        assert.ok(before.length > 0)
        // The draft is user text, so "</" is neutralised exactly as in the other two islands.
        const evil = await run({
            dataDir: path.join(tmp, 'search-state-evil'),
            installationDir: path.join(tmp, 'mobile-install'),
            require: mobileRequire,
            versionInfo: { version: '3.7.0', platform: 'mobile' },
            todos,
        })
        await evil.panelMessageHandler(['searchState', { draft: 'title:"</script><img src=x>"', caret: 0, marks: null, filter: '', filterCaret: 0, focus: 'field' }])
        await evil.panelMessageHandler(['dialogGuardReset', false, false])
        const evilHtml = evil.panelHtml['panel-panel']
        const islandAt = evilHtml.indexOf('id="cockpitSearchState"')
        assert.ok(islandAt >= 0, 'the island must be there')
        assert.ok(!evilHtml.slice(islandAt, evilHtml.indexOf('</script>', islandAt)).includes('</script'),
            'a draft cannot close the script element early')
    })

    await test('search reload-survival (webview): posted throttled on mobile only, cleared on commit and departure', () => {
        const queue = handlerBody('queueSearchState')
        assert.ok(queue.includes('if (!IS_MOBILE) return'), 'desktop keeps its module state and posts nothing')
        assert.ok(/searchStateTimer = setTimeout\(function\(\)\{ searchStateTimer = null; pushSearchState\(\) \}, 300\)/.test(queue),
            'a burst of keystrokes must post at most once every 300ms, like queueOverlayState')
        // Every input that can change the state queues a post.
        for (const [handler, why] of [
            ['updateSearchDraft', 'typing in the field'],
            ['toggleSearchMark', 'marking a row'],
            ['clearSearchMarks', 'clearing the marks'],
            ['applySuggestFilter', 'narrowing the list'],
        ]) assert.ok(handlerBody(handler).includes('queueSearchState()'), `${why} must update the held state`)
        // Cleared at source on a commit and on a genuine departure, so a stale draft cannot resurrect.
        const clear = handlerBody('clearHostSearchState')
        assert.ok(clear.includes('clearTimeout(searchStateTimer)'),
            'the clear must cancel a throttled post still armed, or it would re-post what it just cleared')
        assert.ok(clear.includes("postMessage(['searchState', null])"), 'and tell the host')
        assert.ok(handlerBody('onSearchFilterChanged').includes('clearHostSearchState()'), 'a commit clears it')
        assert.ok(handlerBody('leaveSearchField').includes('clearHostSearchState()'), 'and so does leaving the field')
        // ORDER on departure: the state is dropped BEFORE the focus hold is released, so the render the host then
        // runs cannot embed a state this webview has just abandoned.
        const leave = handlerBody('leaveSearchField')
        assert.ok(leave.indexOf('clearHostSearchState()') < leave.indexOf("postMessage(['searchFocusChanged', false])"),
            'the clear must land before the hold is released')
        // Explicitly NO dialogGuard: the dropdown opens and closes on every keystroke, so bracketing it with the
        // guard would be a leak hazard whose failure mode is refreshes frozen forever.
        for (const handler of ['queueSearchState', 'pushSearchState', 'clearHostSearchState', 'restoreSearchFromEmbeddedState']){
            assert.ok(!/dialogGuard/.test(handlerBody(handler)), `${handler} must not touch the dialog guard`)
        }
    })

    await test('search reload-survival (webview): the restore re-runs the search path and cannot fire a spurious reset', () => {
        const restore = handlerBody('restoreSearchFromEmbeddedState')
        assert.ok(restore.includes('input.focus()'),
            'the restore must refocus the field, which re-arms the host hold - without it the next refresh wipes it again')
        assert.ok(restore.includes('reopenSearchSuggestions({ marks:'),
            'the list, the marks and the dropdown filter all come back through the shared re-open path')
        // THE TRAP: onSearchInput runs maybeAutoResetSearch first, and that reads "still filtered" off
        // input.defaultValue - the server-rendered attribute this restore does not touch. An empty restored draft
        // over a document rendered with a committed filter would therefore look exactly like the user having just
        // emptied the field, and would commit a reset nobody asked for.
        assert.ok(restore.includes("if (!input.value.trim()) searchResetPosted = true"),
            'an empty restored draft must arm the posted-guard so no reset is fired for it')
        assert.ok(handlerBody('maybeAutoResetSearch').includes("if (input.value.trim()){ searchResetPosted = false; return false }"),
            'and the very first character the user types must clear that guard again')
        // Only on a FRESH webview: guarded on searchFocused, so it can never run over a live interaction.
        const reconcileBody = handlerBody('reconcile')
        assert.ok(reconcileBody.includes('if (IS_MOBILE && !searchFocused) restoreSearchFromEmbeddedState()'),
            'the restore is mobile-only and only ever runs when no live search state survived')
        // The bootstrap handshake tells the host whether this document already carries the island.
        assert.ok(webviewSource.includes("postMessage(['dialogGuardReset', !!stateText, !!readEmbeddedSearchStateText()])"),
            'the reset post must report the search island too, so the host re-serves it exactly once')
    })

    await test('post-commit keystrokes (webview): a render landing after a commit cannot repaint typed text away', () => {
        // A commit nulls searchDraft, so a render arriving afterwards repainted the field from its
        // server-rendered (committed) value - discarding anything typed in between. The blur of the OUTGOING
        // field is the last instant that field can still be read, so its value is snapshotted there and used as
        // the restore's fallback.
        const blur = handlerBody('onSearchBlur')
        assert.ok(/if \(event && event\.target === getSearchInput\(\)\)\{[\s\S]{0,200}lastSearchFieldSnapshot = \{ value: event\.target\.value, caret: event\.target\.selectionStart \}/.test(blur),
            'the outgoing field must be snapshotted on its blur')
        const restore = handlerBody('restoreSearchDraft')
        const draftAt = restore.indexOf('if (searchDraft){')
        const snapAt = restore.indexOf('var snapshot = lastSearchFieldSnapshot')
        assert.ok(draftAt >= 0 && snapAt > draftAt, 'a live draft must still win; the snapshot is only the fallback')
        assert.ok(restore.includes('if (snapshot && snapshot.value !== input.value)'),
            'and it is only applied when it actually differs from what was rendered')
        assert.ok(restore.includes('lastSearchFieldSnapshot = null'), 'consumed once')
        // It can only ever carry text typed AFTER the last commit: a commit and a genuine departure both drop it,
        // and a typed character supersedes it with the fresher draft.
        assert.ok(handlerBody('onSearchFilterChanged').includes('lastSearchFieldSnapshot = null'),
            'a commit must drop the snapshot, or an apply could be undone by a pre-apply value')
        assert.ok(handlerBody('leaveSearchField').includes('lastSearchFieldSnapshot = null'), 'so must a genuine departure')
        assert.ok(handlerBody('updateSearchDraft').includes('lastSearchFieldSnapshot = null'), 'and a keystroke supersedes it')
    })

    await test('clear button: the deferred commit no longer double-posts the empty reset', () => {
        // Pressing the field's × fires BOTH `input` - on which the empty-field auto-reset commits "" - and
        // `search`, which arrives at the deferred commit with the same "". The host's equality guard absorbed the
        // second post; the duplicate is now recognised at source, because that equality IS the no-op case.
        const changed = handlerBody('onSearchFieldChanged')
        assert.ok(changed.includes('if (pendingSearchCommit.value === lastCommittedSearch){ pendingSearchCommit = null; return }'),
            'a deferred commit equal to what is already committed must be dropped')
        assert.ok(handlerBody('onSearchFilterChanged').includes('lastCommittedSearch = String(searchString == null ? \'\' : searchString)'),
            'every commit must record what it asked the host to hold')
        // The guard is on the DEFERRED path only, so the explicit commits (Enter, a pick, an apply, the auto-reset)
        // are untouched - re-committing the same query from the keyboard still renders.
        assert.ok(!handlerBody('onSearchFilterChanged').includes('lastCommittedSearch)'),
            'the explicit commit path must not gate itself on the last committed value')
        // And it is narrower than "never commit twice": a genuinely changed value still commits on blur.
        assert.ok(changed.includes('flushPendingSearchCommit()'), 'a changed value still commits')
        assert.ok(handlerBody('flushPendingSearchCommit').includes('onSearchFilterChanged(pending.value)'),
            'through the one commit path')
        // The guard is re-anchored on every render from the value the host actually SERVED, because the host can
        // move the filter without this webview committing (a profile switch applies the profile's panelSearch).
        // Comparing against a stale value would drop a commit that was not a no-op.
        assert.ok(handlerBody('reconcile').includes('lastCommittedSearch = renderedSearch.defaultValue'),
            'every render must re-anchor what the host is holding')
    })

    await test('committed search (host): the exemption is inert on desktop, byte for byte', async () => {
        // renderNow only ever matters under the mobile hold. Proven by rendering the same commit both ways on
        // desktop and comparing the markup, rather than by reading the guard.
        const opts = (tag) => ({
            dataDir: path.join(tmp, 'commit-desktop-' + tag),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos,
        })
        const plain = await run(opts('plain'))
        const flagged = await run(opts('flagged'))
        await plain.panelMessageHandler(['searchFocusChanged', true])
        await flagged.panelMessageHandler(['searchFocusChanged', true])
        const beforePlain = plain.setHtmlCalls
        const beforeFlagged = flagged.setHtmlCalls
        await plain.panelMessageHandler(['searchFilterChanged', 'tag:foo'])
        await flagged.panelMessageHandler(['searchFilterChanged', 'tag:foo', true])
        assert.strictEqual(plain.setHtmlCalls - beforePlain, flagged.setHtmlCalls - beforeFlagged,
            'desktop must render the same number of times either way')
        assert.strictEqual(plain.panelHtml['panel-panel'], flagged.panelHtml['panel-panel'],
            'and produce byte-identical markup')
    })

    await test('committed search (webview): the flag is the DEFAULT, and only commits can carry it', () => {
        const body = handlerBody('onSearchFilterChanged')
        assert.ok(body.includes('var renderNow = !(opts && opts.renderNow === false)'),
            'renderNow must default ON, so a commit path cannot forget it')
        assert.ok(body.includes("postMessage(['searchFilterChanged', searchString, renderNow])"),
            'and travel as message[2]')
        // Every caller of this function is an explicit user commit - that is what makes the default safe.
        const callSites = (webviewSource.match(/onSearchFilterChanged\(/g) || []).length
        assert.strictEqual(callSites, 5, 'the commit function plus its four explicit call sites')
        for (const site of [
            "onSearchFilterChanged('', { renderNow: true })",     // the empty-field auto-reset
            'onSearchFilterChanged(input.value)',                  // a picked suggestion / applied multi-select
            'onSearchFilterChanged(searchInput.value)',            // Enter in the field
            'onSearchFilterChanged(pending.value)',                // the clear button / a blur-change
        ]){
            assert.ok(webviewSource.includes(site), `explicit commit path missing: ${site}`)
        }
        // Typing must NOT commit: the input path only updates the draft (and the empty-field reset, which is
        // itself an explicit commit on an observed empty value).
        const input = handlerBody('onSearchInput')
        assert.ok(input.includes('updateSearchDraft(input)'), 'typing updates the draft')
        assert.ok(!/onSearchFilterChanged/.test(input), 'and never commits directly')
        assert.ok(!/onSearchFilterChanged/.test(handlerBody('updateSearchDraft')), 'nor does the draft writer')
        // Host side: message[2] becomes the exemption, and the hold is honoured otherwise.
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        assert.ok(/message\[2\] \? \{ renderWhileSearchFocused: true \} : undefined/.test(panelSource),
            'the host must turn message[2] into the render exemption')
        assert.ok(/if \(mobile && searchFocused && !\(options && options\.renderWhileSearchFocused\)\) return/.test(panelSource),
            'and the hold must stay in place for everything else')
    })

    await test('empty search (webview): the reset is an explicit commit on an observed empty value', () => {
        const body = handlerBody('maybeAutoResetSearch')
        // "Still filtered?" is read from the server-rendered value ATTRIBUTE, which the user's editing never
        // touches - so there is no new state to keep in sync with the host.
        assert.ok(body.includes('input.defaultValue'),
            'the committed filter must come from defaultValue, not from a second copy of the host state')
        assert.ok(/if \(input\.value\.trim\(\)\)\{ searchResetPosted = false; return false \}/.test(body),
            'a field with content resets the guard and does nothing else')
        assert.ok(body.includes("onSearchFilterChanged('', { renderNow: true })"),
            'the reset must be an EXPLICIT commit, and must ask to render through the mobile hold')
        assert.ok(body.includes('searchResetPosted = true'), 'and must not post itself twice while a render is in flight')
        // Wired into the INPUT path - the only event a backspace or a cut fires - ahead of the token parsing.
        const input = handlerBody('onSearchInput')
        assert.ok(input.includes('if (maybeAutoResetSearch(input)) return'), 'the input path must try the reset')
        assert.ok(input.indexOf('maybeAutoResetSearch') < input.indexOf('tokenAtCaret'),
            'before the token parsing, since an empty field has no token')
        // It composes with the deferred-commit machinery: routing through onSearchFilterChanged clears any
        // commit still held pending, so a later blur cannot commit the same reset again.
        assert.ok(handlerBody('onSearchFilterChanged').includes('pendingSearchCommit = null'),
            'the reset must supersede a pending blur-commit')
        // The renderNow flag rides as message[2]; every other caller omits it.
        assert.ok(handlerBody('onSearchFilterChanged').includes("postMessage(['searchFilterChanged', searchString, renderNow])"),
            'renderNow must travel as message[2] (it is the default now - see the commit-render rule below)')
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        assert.ok(/message\[2\] \? \{ renderWhileSearchFocused: true \} : undefined/.test(panelSource),
            'the host must turn message[2] into the render exemption')
        assert.ok(/if \(mobile && searchFocused && !\(options && options\.renderWhileSearchFocused\)\) return/.test(panelSource),
            'and the hold must honour it without being removed')
    })

    await test('search dropdown markup: a filter box with the apply button, and the hint at the bottom edge', () => {
        const body = handlerBody('renderSearchSuggestions')
        assert.ok(body.includes('buildSuggestFilterRow(input)'), 'the filter row is pinned above the rows')
        assert.ok(body.includes("hint.textContent = window.SearchTokens.hintText(IS_MOBILE)"),
            'the hint wording is platform-specific and comes from the shared module')
        assert.ok(body.includes("label.textContent = suggestion.label"), 'row labels stay textContent - never interpreted as markup')
        const filter = handlerBody('buildSuggestFilterRow')
        assert.ok(filter.includes('window.SearchTokens.APPLY_ICON'), 'the apply button carries the enter-arrow glyph')
        assert.ok(filter.includes("apply.setAttribute('hidden', '')"), 'it starts hidden - it appears only once something is marked')
        assert.ok(!/box\.focus\(\)/.test(filter),
            'the filter box must NOT steal the caret: this list opens while the user is typing in the search field')
        const paint = handlerBody('paintSearchMarks')
        assert.ok(/classList\.toggle\('-marked'/.test(paint), 'marked rows get their own class')
        assert.ok(/apply\.removeAttribute\('hidden'\)/.test(paint), 'the apply button appears exactly when a mark exists')
    })

    await test('search dropdown css: ~15 rows then scroll, capped by the panel, with the marks visually distinct', () => {
        // Tall enough to work through, never taller than the panel - the same shape as #notebookMenu's cap, with a
        // larger offset because this menu hangs off the third control row.
        assert.ok(/#searchSuggestions \{[^}]*max-height:\s*min\(calc\(15 \* [^)]*\)[^)]*\), calc\(100vh - \d+px\)\)/.test(panelCssSource),
            'the list must target ~15 rows and stay inside the panel height')
        assert.ok(/#searchSuggestions \{[^}]*overflow:\s*hidden/.test(panelCssSource),
            'the MENU must not scroll - only .suggest-list inside it, so the filter box and hint stay put')
        assert.ok(/\.suggest-list \{[^}]*overflow-y:\s*auto/.test(panelCssSource), 'the rows are what scrolls')
        // The mark reads differently from the keyboard highlight, because a row can be both at once.
        assert.ok(/\.dropdown-item\.-marked \{[^}]*box-shadow:\s*inset/.test(panelCssSource),
            'a marked row must be distinguishable from the -current keyboard highlight')
        // User custom CSS must be able to win, and the panel's public variables are what everything is built from.
        const suggestRules = (panelCssSource.match(/\.suggest-[a-z]+[^{]*\{[^}]*\}/g) || []).join('\n')
        assert.ok(suggestRules.length > 0, 'the suggestion rules must exist')
        assert.ok(!/!important/.test(suggestRules), 'no !important - a user stylesheet has to be able to override these')
        assert.ok(/--cockpit-/.test(suggestRules), 'colours come from the public --cockpit-* variables')
        // Touch targets, gated on the mobile class so the desktop panel is untouched.
        assert.ok(/\.cockpit-mobile \.suggest-filter-input \{[^}]*min-height:\s*40px/.test(panelCssSource),
            'the filter box is a 40px tap target on mobile')
        assert.ok(/\.cockpit-mobile \.suggest-apply \{[^}]*40px/.test(panelCssSource),
            'so is the apply button - it commits a selection built by long press')
    })

    await test('search dropdown: the title: round-trip offers enough rows to mark, at no extra request', () => {
        // tag:/notebook: read the embedded island, but title: round-trips to the host, whose cap used to be 10 -
        // fewer than the list now shows, let alone what a multi-select needs to reach.
        const joplinSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'joplin.ts'), 'utf8')
        assert.ok(/const titleSuggestionLimit = 50/.test(joplinSource), 'the title: cap must clear the visible rows')
        assert.ok(!/limit: 10,/.test(joplinSource.slice(joplinSource.indexOf('searchTitleSuggestions'), joplinSource.indexOf('/** getNotes'))),
            'no hard-coded 10 may survive in the title: path')
        // Still ONE request per suggestion round, on both branches - a bigger page, not more calls.
        const titleBody = joplinSource.slice(joplinSource.indexOf('export async function searchTitleSuggestions'), joplinSource.indexOf('/** getNotes'))
        assert.strictEqual((titleBody.match(/await joplin\.data\.get\(/g) || []).length, 2,
            'exactly two data.get sites (the empty-partial branch and the search branch), one of which runs per call')
    })

    await test('search dropdown (host): a title: suggestion round-trip still costs exactly one data.get', async () => {
        // Driven for real against the stubbed API: the raised cap must not turn one request into several.
        const before = desktop.gets.length
        const answered = await desktop.panelMessageHandler(['searchTitleSuggestions', 'buy'])
        assert.ok(Array.isArray(answered), 'the webview must get an array back')
        assert.strictEqual(desktop.gets.length - before, 1, 'one suggestion round-trip must issue exactly one data.get')
        assert.strictEqual(desktop.gets[desktop.gets.length - 1].query.limit, 50, 'and ask for the raised page size')
    })

    await test('clipboard copy (host): one uninterrupted call, no proxy probe, no blocking dialog', () => {
        // `joplin` is a sandbox PROXY: handler.get RECORDS each member on the pending call path and only
        // handler.apply pops one segment back off, so an uncalled read is permanent corruption. The old guard
        // read clipboard, then read writeText for a typeof, then read writeText again to call it - the host got
        // joplin.clipboard.writeText.writeText and threw. The guard could never have worked anyway: a Proxy over
        // a function is always truthy and always typeof 'function'.
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        const copyAt = panelSource.indexOf('async function copyToClipboard(')
        assert.ok(copyAt > 0, 'copyToClipboard must exist')
        const copyBody = panelSource.slice(copyAt, panelSource.indexOf('\n}', copyAt))
        assert.ok(copyBody.includes('await (joplin as any).clipboard.writeText(text)'),
            'the write must be ONE expression: every member read before the call is appended to the proxy path')
        assert.ok(!/typeof/.test(copyBody),
            'no typeof probe of a joplin member - inspecting the API is exactly what breaks the call')
        assert.ok(!/showMessageBox/.test(copyBody),
            'a failed copy must never raise a plugin dialog (desktop: a blocking native modal; mobile: it opens behind the panel)')
        assert.ok(copyBody.includes('notifyPanel('), 'the failure notice goes to the panel toast instead')
        const notifyAt = panelSource.indexOf('function notifyPanel(')
        assert.ok(notifyAt > 0, 'notifyPanel must exist')
        const notifyBody = panelSource.slice(notifyAt, panelSource.indexOf('\n}', notifyAt))
        assert.ok(notifyBody.includes("postMessage(panel, ['panelToast'"), 'and it travels as the panelToast message')
    })

    await test('clipboard copy (host): the Markdown link is built once, with Joplin\'s own bracket escaping', () => {
        // Byte-identical to Note.markdownTag: an unescaped ] in the title closes the label early and the rest of
        // the link stops parsing. Parentheses are deliberately left alone - they sit inside the label, and the
        // URL is ":/" plus a hex id, so Joplin's escapeLinkUrl would be a no-op on it.
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        const linkAt = panelSource.indexOf('function markdownNoteLink(')
        assert.ok(linkAt > 0, 'markdownNoteLink must exist')
        const linkBody = panelSource.slice(linkAt, panelSource.indexOf('\n}', linkAt))
        assert.ok(linkBody.includes(String.raw`.replace(/(\[|\])/g, '\\$1')`),
            'both square brackets must be backslash-escaped, and nothing else')
        assert.ok(linkBody.includes('](:/${noteID})'), 'the URL is ":/" plus the raw id')
        // BOTH copy branches go through it - the single-note one and the batch one.
        assert.ok(panelSource.includes('await copyToClipboard(markdownNoteLink(linkNote.title, noteID))'),
            'runNoteMenuAction must build its link through markdownNoteLink')
        assert.ok(panelSource.includes('links.push(markdownNoteLink(linkNote.title, linkID))'),
            'and so must runNoteMenuActionMulti')
        assert.ok(!/copyToClipboard\(`\[\$\{/.test(panelSource) && !/links\.push\(`\[\$\{/.test(panelSource),
            'no branch may still assemble the link inline, unescaped')
        // The batch join stays a newline: Joplin joins with a space, Cockpit deliberately does not.
        assert.ok(panelSource.includes('await copyToClipboard(links.join("\\n"))'), 'the batch link list stays newline-joined')
        assert.ok(panelSource.includes('await copyToClipboard(ids.join("\\n"))'), 'and so does the batch id list')
    })

    await test('clipboard copy (webview): the toast arrives on the single existing onMessage chain', () => {
        // Joplin allows ONE onMessage handler per view, so the notice has to extend the handler that already
        // carries editorNoteChanged rather than register a second one that would silently replace it.
        assert.strictEqual((webviewSource.match(/webviewApi\.onMessage\(/g) || []).length, 1,
            'the panel must register exactly one onMessage handler')
        const chainAt = webviewSource.indexOf('webviewApi.onMessage(')
        const chain = webviewSource.slice(chainAt, webviewSource.indexOf('\n    reconcile()', chainAt))
        assert.ok(/else if \(message\[0\] === 'panelToast'\)/.test(chain),
            'the toast branch must live inside that handler')
        assert.ok(chain.includes('showToast(String(message[1] || ""))'), 'and show the pushed text in the panel toast')
        assert.ok(/#cockpitToast \{/.test(panelCssSource) && !/\.cockpit-mobile #cockpitToast/.test(panelCssSource),
            'the toast is not gated on the mobile class, so the desktop panel can show it too')
    })

    // ============================================ the Whereabouts contract (v2.4.0): two commands for other plugins
    // Cockpit registers two commands that exist for ANOTHER PLUGIN to call. The Whereabouts plugin puts a notebook
    // chip under the note title: a left click runs core's openNote and then executes 'cockpit.filterByNotebook' with
    // the folder id, a double click reveals the note in Joplin's list and then executes 'cockpit.revealNote' with the
    // note id. Both are fire-and-forget over there and every failure is swallowed, so a name changed here does not
    // break anything loudly - the integration just silently stops working. The two NAMES are therefore pinned as the
    // cross-plugin contract, and what each promises is pinned with them.
    const nbAlpha = 'a1'.repeat(16)
    const nbBeta = 'b2'.repeat(16)
    const nbSecret = 'c3'.repeat(16)
    const revealFolders = [
        { id: nbAlpha, title: 'Alpha', parent_id: '', updated_time: 1 },
        { id: nbBeta, title: 'Beta', parent_id: '', updated_time: 2 },
        { id: nbSecret, title: 'Secret', parent_id: '', updated_time: 3 },
    ]
    const todoAlpha = 'd4'.repeat(16)
    const todoBeta = 'e5'.repeat(16)
    const todoSecret = 'f6'.repeat(16)
    const notePlain = '07'.repeat(16)
    const revealTodos = [
        { id: todoAlpha, title: 'Alpha task', todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: nbAlpha },
        { id: todoBeta, title: 'Beta task', todo_completed: 0, todo_due: Date.now() + 7200000, parent_id: nbBeta },
        { id: todoSecret, title: 'Secret task', todo_completed: 0, todo_due: Date.now() + 10800000, parent_id: nbSecret },
    ]
    // The single note record of each item, as the reveal's own read gets it back (it asks for exactly
    // id/parent_id/is_todo/todo_completed/title, and the harness serves only the fields a caller asks for).
    const revealNotes = {
        [todoAlpha]: { id: todoAlpha, parent_id: nbAlpha, is_todo: 1, todo_completed: 0, title: 'Alpha task', body: '' },
        [todoBeta]: { id: todoBeta, parent_id: nbBeta, is_todo: 1, todo_completed: 0, title: 'Beta task', body: '' },
        [todoSecret]: { id: todoSecret, parent_id: nbSecret, is_todo: 1, todo_completed: 0, title: 'Secret task', body: '' },
        [notePlain]: { id: notePlain, parent_id: nbAlpha, is_todo: 0, todo_completed: 0, title: 'Alpha plain note', body: '' },
    }
    // A to-dos-only profile (showNotes false): that is what makes revealing a plain NOTE fall all the way through to
    // the pinned peek row, and it keeps the notes section out of every other case here.
    const revealProfileData = JSON.stringify({
        nextID: 2,
        profiles: [{
            id: 1, name: 'Tasks', searchCriteria: '', noteID: '',
            showCompleted: true, showNoDue: true, showNotes: false,
            displayFormat: 'interval', yearFormat: 'numeric', monthFormat: 'long', dayFormat: 'numeric',
            weekdayFormat: 'short', timeIs12Hour: true, sortOrder: 0, noDueDatesAtEnd: false,
        }],
    })
    let revealRunSeq = 0
    const runReveal = (extra) => run(Object.assign({
        dataDir: path.join(tmp, 'reveal-' + (++revealRunSeq)),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: revealTodos,
        folders: revealFolders,
        notes: revealNotes,
        initialSettings: { profileData: revealProfileData, currentProfileID: 1 },
    }, extra))
    const panelOf = (state) => state.panelHtml['panel-panel']
    // Which notebook the panel's own dropdown says is current, as the id it would filter by ("" for the
    // "All notebooks" row). Read from the -current row of the notebook menu itself (the profile dropdown above it
    // marks a -current row of its own, and the sort menu below it another).
    const currentNotebookID = (html) => {
        const menu = html.slice(html.indexOf('id="notebookMenu"'), html.indexOf('id="sortMenu"'))
        const at = menu.indexOf('dropdown-item -current')
        if (at < 0) return null
        const row = menu.slice(at, menu.indexOf('</div>', at))
        if (row.includes('data-notebook-all')) return ''
        return (row.match(/'notebookFilterChanged', '([^']*)'/) || [])[1] || null
    }
    // What the notebook dropdown's own BUTTON says. It is the label the user reads, and the whole of the reported
    // confusion was that it said "All notebooks" while the panel was in fact filtered to an excluded one.
    const notebookLabelOf = (html) => {
        const menuAt = html.indexOf('id="notebookMenu"')
        if (menuAt < 0) return null
        const head = html.slice(0, menuAt)
        const labelAt = head.lastIndexOf('<span class="dropdown-toggle-label">')
        if (labelAt < 0) return null
        return head.slice(labelAt + '<span class="dropdown-toggle-label">'.length, head.indexOf('</span>', labelAt))
    }
    const revealIDOf = (html) => (html.match(/data-reveal-id="([^"]*)"/) || [])[1] || ''
    const listsRow = (html, id) => html.includes(`data-todo-id="${id}"`) || html.includes(`data-note-id="${id}"`)
    const executeCommand = async (state, name, ...args) => {
        const command = state.commands.find(c => c.name === name)
        assert.ok(command, `the ${name} command is not registered`)
        return await command.execute(...args)
    }

    await test('whereabouts contract: exactly the two command names Whereabouts calls are registered, with palette labels and no menu item', async () => {
        const state = await runReveal({})
        const names = state.commands.map(c => c.name)
        // THE contract. Whereabouts executes these two strings verbatim (its src/index.ts) and swallows the
        // failure when they are absent, so renaming one here is a silent breakage - which is what this pins.
        assert.ok(names.includes('cockpit.filterByNotebook'), "the notebook-chip left click executes 'cockpit.filterByNotebook'")
        assert.ok(names.includes('cockpit.revealNote'), "the notebook-chip double click executes 'cockpit.revealNote'")
        // The full registration set, so a command added or dropped is a deliberate edit of this line.
        assert.deepStrictEqual(names.sort(), [
            'cockpit.connectSettingsNote', 'cockpit.filterByNotebook', 'cockpit.revealNote', 'showStylerDialog',
            'toggleCockpitToolbarButton', 'togglePanelVisibility',
        ])
        const labelled = (name) => state.commands.find(c => c.name === name).label
        assert.strictEqual(labelled('cockpit.filterByNotebook'), 'Cockpit: filter by notebook')
        assert.strictEqual(labelled('cockpit.revealNote'), 'Cockpit: reveal note')
        // Neither is useful without an argument, so neither gets a menu or toolbar item of its own: the desktop
        // registers exactly the one toolbar button and the one Tools menu it always had.
        assert.strictEqual(state.toolbarButtons.length, 1, 'no new toolbar button may appear for these commands')
        assert.strictEqual(state.menus.length, 1, 'no new menu may appear for these commands')
    })

    await test('cockpit.filterByNotebook: an id filters the panel to that notebook, marks it current, and repaints once', async () => {
        const state = await runReveal({})
        assert.ok(listsRow(panelOf(state), todoBeta), 'precondition: unfiltered, every notebook is listed')
        const paintsBefore = state.setHtmlCalls
        await executeCommand(state, 'cockpit.filterByNotebook', nbAlpha)
        const html = panelOf(state)
        assert.ok(listsRow(html, todoAlpha), 'the filtered-to notebook keeps its rows')
        assert.ok(!listsRow(html, todoBeta), 'another notebook\'s rows are gone')
        assert.strictEqual(currentNotebookID(html), nbAlpha, 'the notebook dropdown must mark the filtered notebook -current')
        assert.strictEqual(state.setHtmlCalls - paintsBefore, 1, 'the command does exactly one repaint')
    })

    await test('cockpit.filterByNotebook: "" clears the filter back to all notebooks (and so does no argument)', async () => {
        const state = await runReveal({})
        await executeCommand(state, 'cockpit.filterByNotebook', nbAlpha)
        assert.strictEqual(currentNotebookID(panelOf(state)), nbAlpha, 'precondition: filtered')
        await executeCommand(state, 'cockpit.filterByNotebook', '')
        assert.ok(listsRow(panelOf(state), todoBeta), 'an empty id means all notebooks')
        assert.strictEqual(currentNotebookID(panelOf(state)), '', 'the All notebooks row is current again')
        // A caller that passes nothing at all means the same thing, and must not throw back into it.
        await executeCommand(state, 'cockpit.filterByNotebook', nbBeta)
        assert.strictEqual(currentNotebookID(panelOf(state)), nbBeta, 'precondition: filtered again')
        await executeCommand(state, 'cockpit.filterByNotebook')
        assert.strictEqual(currentNotebookID(panelOf(state)), '', 'a missing argument clears the filter too')
    })

    await test('cockpit.filterByNotebook: an unknown notebook id is a no-op - no clear, no repaint, no throw', async () => {
        const state = await runReveal({})
        await executeCommand(state, 'cockpit.filterByNotebook', nbAlpha)
        const paintsBefore = state.setHtmlCalls
        // A stale chip pointing at a deleted notebook must not blank the filter the user is working in.
        await executeCommand(state, 'cockpit.filterByNotebook', 'deadbeef'.repeat(4))
        assert.strictEqual(state.setHtmlCalls, paintsBefore, 'an unknown id must not repaint the panel')
        assert.strictEqual(currentNotebookID(panelOf(state)), nbAlpha, 'an unknown id must leave the filter alone')
    })

    // ============================================================ the notebook filter may never point at an excluded notebook
    // Reported from a real vault, with a screenshot: a note open in an excluded "Archive", the panel's dropdown reading
    // "All notebooks", the list EMPTY, and New to-do / New note creating straight into Archive without asking. Three
    // wrong answers with one cause - notebookFilter was holding an excluded notebook's id. The dropdown builds its rows
    // from the excluded-filtered list, so it could not find that id among them and fell back to its "All notebooks"
    // label; the search really was narrowed to Archive, which the exclusion then emptied; and createItem saw a
    // non-empty filter and used it. Three writers could put it there (the Whereabouts command, a reveal, a profile
    // saved before the notebook was excluded), so all three go through creatableNotebookID now, createItem re-checks on
    // the way out, and the resolver drops the filter when the setting makes it excluded.
    await test('excluded filter (the report): a chip click on an excluded notebook is a no-op with a notice, and New to-do still asks', async () => {
        const state = await runReveal({})
        await state.setSetting('excludedNotebooks', 'Secret')
        assert.ok(!listsRow(panelOf(state), todoSecret), 'precondition: the excluded notebook is out of the list')
        const paintsBefore = state.setHtmlCalls
        const toastsBefore = state.panelMessages.filter(message => message[0] === 'panelToast').length
        // Whereabouts' left click on the chip of a note that lives in Archive. Fire-and-forget over there.
        await executeCommand(state, 'cockpit.filterByNotebook', nbSecret)
        assert.strictEqual(state.setHtmlCalls, paintsBefore, 'an excluded notebook must not repaint the panel')
        assert.strictEqual(currentNotebookID(panelOf(state)), '', 'and must leave the filter on all notebooks')
        // Unlike the unknown-id no-op above, this one SAYS something: it is a setting the user made and has
        // probably forgotten, and silence is how the reported confusion started.
        const toasts = state.panelMessages.filter(message => message[0] === 'panelToast')
        assert.strictEqual(toasts.length - toastsBefore, 1, 'exactly one notice is raised')
        assert.ok(/excluded/i.test(String(toasts[toasts.length - 1][1])), 'which says the notebook is excluded in the settings')
        // The other half of the report: the create must ASK, not file the note into Archive behind the user's back.
        const postsBefore = state.dataPosts.length
        await state.panelMessageHandler(['newTodoClicked'])
        assert.ok(state.dialogHtml['dialog-notebookPicker'], 'New to-do must open the notebook picker')
        assert.strictEqual(state.dataPosts.length, postsBefore, 'and must create nothing until the picker answers')
    })

    await test('excluded filter (reveal): a note in an excluded notebook is pinned, and the filter is never pointed at it', async () => {
        const state = await runReveal({})
        await state.setSetting('excludedNotebooks', 'Secret')
        assert.strictEqual(currentNotebookID(panelOf(state)), '', 'precondition: all notebooks')
        await executeCommand(state, 'cockpit.revealNote', todoSecret)
        const html = panelOf(state)
        // Step (b) of the reveal cascade - point the filter at the note's own notebook - is skipped for a notebook
        // the panel may not show. Nothing is lost: the row could not be listed either way, and step (c) answers.
        assert.strictEqual(currentNotebookID(html), '', 'the filter must NOT move to the excluded notebook')
        assert.strictEqual(notebookLabelOf(html), 'All notebooks', 'and the label agrees with it')
        assert.ok(html.includes('Revealed - outside current filters (1)'), 'the reveal still answers, by pinning the note')
        assert.ok(html.includes(`data-todo-id="${todoSecret}"`), 'with the revealed note itself on screen')
        assert.ok(revealIDOf(html), 'and the render carries the reveal marker')
    })

    await test('excluded filter (profile): a stored notebook that is now excluded starts at all notebooks, and the profile is left alone', async () => {
        // A profile saved while "Secret" was an ordinary notebook, opened after it was excluded.
        const storedProfile = JSON.parse(revealProfileData)
        storedProfile.profiles[0].notebook = nbSecret
        const state = await runReveal({ initialSettings: {
            profileData: JSON.stringify(storedProfile),
            currentProfileID: 1,
            excludedNotebooks: 'Secret',
            excludedNotebookIds: nbSecret,
        } })
        const html = panelOf(state)
        assert.strictEqual(currentNotebookID(html), '', 'the session starts at all notebooks, not at the excluded notebook')
        assert.strictEqual(notebookLabelOf(html), 'All notebooks', 'and the label says so')
        assert.ok(listsRow(html, todoAlpha) && listsRow(html, todoBeta), 'so the panel lists everything it can show')
        assert.ok(!listsRow(html, todoSecret), 'minus the excluded notebook itself')
        // The profile is not rewritten: un-excluding the notebook must bring its stored filter straight back.
        assert.strictEqual(JSON.parse(state.settings.profileData).profiles[0].notebook, nbSecret,
            "the stored profile's own notebook must be left exactly as the user saved it")
    })

    await test('excluded filter (setting change): excluding the notebook the panel is filtered to drops the filter and repaints', async () => {
        const state = await runReveal({})
        await executeCommand(state, 'cockpit.filterByNotebook', nbSecret)
        assert.strictEqual(currentNotebookID(panelOf(state)), nbSecret, 'precondition: the panel is filtered to it')
        // The user now adds it to the Excluded notebooks setting, with the panel still pointed at it.
        await state.setSetting('excludedNotebooks', 'Secret')
        const html = panelOf(state)
        assert.strictEqual(currentNotebookID(html), '', 'the filter is dropped back to all notebooks')
        assert.strictEqual(notebookLabelOf(html), 'All notebooks', 'the label agrees')
        assert.ok(listsRow(html, todoAlpha) && listsRow(html, todoBeta), 'and the repaint lists everything again')
        assert.ok(!listsRow(html, todoSecret), 'except what was just excluded')
    })

    await test('excluded filter (deleted notebook): the filter drops when the notebook it points at is deleted elsewhere', async () => {
        // The other way a filter the user is already working in stops being showable, and it is not a write to the
        // filter either: the notebook is deleted in Joplin, not in Cockpit. The folder poll is what notices.
        const vanishOptions = {
            dataDir: path.join(tmp, 'reveal-vanish'),
            installationDir: path.join(tmp, 'desktop-install'),
            require: desktopRequire,
            versionInfo: { version: '3.7.0', platform: 'desktop' },
            todos: revealTodos,
            folders: revealFolders.map(folder => ({ ...folder })),
            notes: revealNotes,
            initialSettings: { profileData: revealProfileData, currentProfileID: 1 },
        }
        const state = await run(vanishOptions)
        const poll = state.intervals.find(interval => interval.ms === 3000)
        assert.ok(poll, 'the folder poll is armed')
        await executeCommand(state, 'cockpit.filterByNotebook', nbBeta)
        assert.strictEqual(currentNotebookID(panelOf(state)), nbBeta, 'precondition: the panel is filtered to Beta')
        await poll.fn()                                                   // baseline signature, with Beta present
        vanishOptions.folders = vanishOptions.folders.filter(folder => folder.id !== nbBeta)
        await poll.fn()                                                   // the poll notices Beta is gone
        const html = panelOf(state)
        assert.strictEqual(currentNotebookID(html), '', 'the filter must not be left on a notebook that no longer exists')
        assert.strictEqual(notebookLabelOf(html), 'All notebooks', 'and the label must agree with it')
        assert.ok(listsRow(html, todoAlpha), 'the panel lists what is left')
        // The create must ask again, rather than POSTing into the id of a deleted notebook.
        const postsBefore = state.dataPosts.length
        await state.panelMessageHandler(['newTodoClicked'])
        assert.ok(state.dialogHtml['dialog-notebookPicker'], 'New to-do opens the picker again')
        assert.strictEqual(state.dataPosts.length, postsBefore, 'and creates nothing into the notebook that went')
    })

    await test('excluded filter (defence in depth): every writer goes through the one helper, and createItem re-checks on the way out', () => {
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        const between = (from, to) => panelSource.slice(panelSource.indexOf(from), panelSource.indexOf(to))
        // The helper itself: in the map AND not excluded. getExcludedNotebookIdSet already carries descendants.
        const helper = between('function creatableNotebookID(', 'async function resolveCreatableNotebookID(')
        assert.ok(/notebooks\.has\(wanted\)/.test(helper), 'the helper must require the notebook to be in the map')
        assert.ok(/excludedSet\.has\(wanted\)/.test(helper), 'and to not be excluded')
        // Every writer of notebookFilter routes through it.
        assert.ok(between('export async function setNotebookFilter(', '/** filterByNotebook').includes('resolveCreatableNotebookID('),
            'the single state write must sanitise what it is given')
        assert.ok(between('export async function filterByNotebook(', 'function renderedRowIsListed').includes('creatableNotebookID('),
            'the command must refuse an excluded notebook')
        assert.ok(between('async function applyProfileHeaderState(', '/** onProfilesReplaced').includes('resolveCreatableNotebookID('),
            "a profile's stored notebook must be validated before it becomes the session's filter")
        assert.ok(between('export async function revealNote(', '/** refreshPanelData').includes('resolveCreatableNotebookID('),
            'a reveal must not point the filter at a notebook the panel cannot show')
        // And the read side checks AGAIN - this one is deliberately unreachable while the writers above hold, which
        // is exactly why it is pinned on the source: creating a note somewhere the user cannot see and did not
        // choose is the worst of the three symptoms, so it does not depend on every writer staying correct.
        const create = between('async function createItem(', 'async function createItemInFolder(')
        assert.ok(create.includes('await resolveCreatableNotebookID(notebookFilter)'),
            'createItem must re-check the filter rather than trust it')
        assert.ok(!/var folderID = notebookFilter\b/.test(create), 'it must not read the filter state raw')
    })

    await test('excluded filter (the invariant): the dropdown can never say "All notebooks" while a notebook filter is set', async () => {
        // The broken state has a signature: NO row in the notebook menu is marked -current (the All row is not,
        // because the filter is non-empty; no notebook row is, because the excluded one is not among them), while
        // the button reads "All notebooks". currentNotebookID answers null for exactly that, so the invariant is
        // "never null, and the label agrees with it" - asserted across every route that writes the filter.
        const check = (html, where) => {
            const id = currentNotebookID(html)
            assert.notStrictEqual(id, null, `${where}: exactly one notebook row must be -current`)
            const label = notebookLabelOf(html)
            if (label === 'All notebooks') assert.strictEqual(id, '', `${where}: the label says all notebooks, so nothing may be filtered`)
            else assert.notStrictEqual(id, '', `${where}: the label names a notebook, so one must be filtered`)
            return id
        }
        const state = await runReveal({})
        check(panelOf(state), 'startup')
        await state.setSetting('excludedNotebooks', 'Secret')
        check(panelOf(state), 'after excluding a notebook')
        await executeCommand(state, 'cockpit.filterByNotebook', nbSecret)
        check(panelOf(state), 'after a command naming the excluded notebook')
        await executeCommand(state, 'cockpit.revealNote', todoSecret)
        check(panelOf(state), 'after revealing a note inside it')
        // The dropdown's own route, with a stale id a reloaded webview could still be carrying.
        await state.panelMessageHandler(['notebookFilterChanged', nbSecret])
        check(panelOf(state), 'after the dropdown posts a stale excluded id')
        await executeCommand(state, 'cockpit.filterByNotebook', nbAlpha)
        assert.strictEqual(check(panelOf(state), 'after filtering to a kept notebook'), nbAlpha,
            'and a notebook the panel CAN show still filters normally')
        // The last route: the filtered notebook is EXCLUDED under the panel's feet, rather than named by a caller.
        await state.setSetting('excludedNotebooks', 'Secret, Alpha')
        check(panelOf(state), 'after the filtered notebook itself is excluded')
    })

    await test('cockpit.filterByNotebook: the panel dropdown and the command share ONE state write, and neither touches the profile', async () => {
        const state = await runReveal({})
        const writesBefore = state.settingWrites.length
        await executeCommand(state, 'cockpit.filterByNotebook', nbAlpha)
        // The saved profile keeps its own notebook: the filter is where the user has navigated to, not a setting.
        assert.strictEqual(state.settingWrites.length, writesBefore, 'the command must write no setting or profile')
        // ... and the command is the dropdown: both routes go through the one exported setNotebookFilter, so they
        // cannot drift apart (the dropdown's branch used to assign the state itself).
        const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.ts'), 'utf8')
        const branch = panelSource.slice(panelSource.indexOf("message[0] == 'notebookFilterChanged'"), panelSource.indexOf("message[0] == 'searchTitleSuggestions'"))
        assert.ok(branch.includes('setNotebookFilter(message[1])'), 'the notebookFilterChanged branch must call setNotebookFilter')
        assert.ok(!/notebookFilter\s*=/.test(branch), 'and must not write the filter state itself')
        const command = panelSource.slice(panelSource.indexOf('export async function filterByNotebook'), panelSource.indexOf('function renderedRowIsListed'))
        assert.ok(command.includes('setNotebookFilter(id)'), 'the command must go through the same setNotebookFilter')
        assert.ok(!/notebookFilter\s*=/.test(command), 'and must not write the filter state itself either')
    })

    await test('cockpit.revealNote: a note already in view is flashed where it is - no filter change, one reveal marker', async () => {
        const state = await runReveal({})
        const before = currentNotebookID(panelOf(state))
        await executeCommand(state, 'cockpit.revealNote', todoAlpha)
        const html = panelOf(state)
        assert.ok(listsRow(html, todoAlpha), 'the row is listed')
        assert.strictEqual(revealIDOf(html), '1', 'the render must carry the reveal marker')
        assert.ok(html.includes(`data-reveal-note="${todoAlpha}"`), 'the marker must name the note it points at')
        assert.strictEqual(currentNotebookID(html), before, 'a note already in view changes no filter')
        assert.ok(!html.includes('Revealed - outside current filters'), 'and needs no pinned peek row')
    })

    await test('cockpit.revealNote: a note in another notebook switches the filter to it and clears the typed search', async () => {
        const state = await runReveal({})
        await executeCommand(state, 'cockpit.filterByNotebook', nbAlpha)
        await state.panelMessageHandler(['searchFilterChanged', 'unrelated text'])
        assert.ok(panelOf(state).includes('value="unrelated text"'), 'precondition: a search is committed')
        await executeCommand(state, 'cockpit.revealNote', todoBeta)
        const html = panelOf(state)
        assert.strictEqual(currentNotebookID(html), nbBeta, 'the filter must switch to the note\'s OWN notebook, not clear')
        assert.ok(listsRow(html, todoBeta), 'the revealed row is now listed')
        assert.ok(html.includes('id="searchFilter"') && !html.includes('value="unrelated text"'), 'the typed search is cleared')
        assert.ok(html.includes(`data-reveal-note="${todoBeta}"`), 'the render that lists it carries the marker')
        // The live view changed; the stored profile did not.
        const stored = JSON.parse(state.settings.profileData).profiles[0]
        assert.ok(!stored.notebook, 'the profile must not be given the revealed notebook')
    })

    await test('cockpit.revealNote: a plain note under a to-dos-only profile is pinned as a "Revealed" peek row', async () => {
        const state = await runReveal({})
        await executeCommand(state, 'cockpit.revealNote', notePlain)
        const html = panelOf(state)
        // The profile hides notes, so no filter can ever list it: it is pinned below the list instead.
        assert.ok(html.includes('Revealed - outside current filters (1)'), 'the pinned peek section is missing')
        assert.ok(!html.includes('outside-results-heading -excluded'), 'a kept notebook uses the ordinary heading')
        const section = html.slice(html.lastIndexOf('<section class="outside-results">'))
        assert.ok(section.includes(`data-note-id="${notePlain}"`), 'the pinned row must be the revealed note')
        assert.strictEqual((section.match(/data-(?:todo|note)-id=/g) || []).length, 1, 'exactly one row is pinned')
        assert.ok(!section.includes('onNoteRowMouseDown('), 'the pinned row is read-only, like every peek row')
        assert.ok(html.includes(`data-reveal-note="${notePlain}"`), 'the render carries the reveal marker for it')
    })

    await test('cockpit.revealNote: a note inside an excluded notebook is pinned under the muted -excluded heading', async () => {
        const state = await runReveal({})
        await state.setSetting('excludedNotebooks', 'Secret')
        await executeCommand(state, 'cockpit.revealNote', todoSecret)
        const html = panelOf(state)
        assert.ok(html.includes('outside-results-heading -excluded'), 'an excluded notebook must use the muted heading variant')
        assert.ok(html.includes('Revealed - outside current filters (1)'), 'under the same "Revealed" wording')
        assert.ok(html.includes(`data-todo-id="${todoSecret}"`), 'the excluded note is shown as its own kind of row')
    })

    await test('cockpit.revealNote: the pin survives a background refresh', async () => {
        const state = await runReveal({})
        await executeCommand(state, 'cockpit.revealNote', notePlain)
        assert.ok(panelOf(state).includes('Revealed - outside current filters'), 'precondition: pinned')
        // A sync landing repaints the panel from scratch. The pin is host-held state re-emitted by every render,
        // so it must still be there afterwards - it goes when the USER moves on, not when the timer fires.
        await state.syncCompleteHandler({})
        assert.ok(panelOf(state).includes('Revealed - outside current filters'), 'a background refresh must not drop the pin')
        assert.ok(panelOf(state).includes(`data-note-id="${notePlain}"`), 'nor the pinned row')
    })

    await test('cockpit.revealNote: the pin is cleared by a profile switch, a notebook change, a search commit, a new reveal and opening the row', async () => {
        const pinned = async () => {
            const state = await runReveal({})
            await executeCommand(state, 'cockpit.revealNote', notePlain)
            assert.ok(panelOf(state).includes('Revealed - outside current filters'), 'precondition: pinned')
            return state
        }
        // A profile switch: a different view entirely.
        const switched = await pinned()
        await switched.panelMessageHandler(['profilesDropdownChanged', 1])
        assert.ok(!panelOf(switched).includes('Revealed - outside current filters'), 'a profile switch must clear the pin')
        // The notebook dropdown: the user has asked a different question.
        const filtered = await pinned()
        await filtered.panelMessageHandler(['notebookFilterChanged', nbBeta])
        assert.ok(!panelOf(filtered).includes('Revealed - outside current filters'), 'a notebook change must clear the pin')
        // A committed search: likewise.
        const searched = await pinned()
        await searched.panelMessageHandler(['searchFilterChanged', 'anything'])
        assert.ok(!panelOf(searched).includes('Revealed - outside current filters'), 'a search commit must clear the pin')
        // The next reveal replaces it, marker and all.
        const revealed = await pinned()
        await executeCommand(revealed, 'cockpit.revealNote', todoAlpha)
        assert.ok(!panelOf(revealed).includes('Revealed - outside current filters'), 'a new reveal must replace the pin')
        assert.strictEqual(revealIDOf(panelOf(revealed)), '2', 'and carry a NEW marker, so the flash fires again')
        // Opening the pinned row is the user acting on the reveal: it has served its purpose.
        const opened = await pinned()
        await opened.panelMessageHandler(['todoClicked', notePlain])
        assert.ok(!panelOf(opened).includes('Revealed - outside current filters'), 'opening the pinned row must clear the pin')
    })

    await test('mobile: revealNote does nothing at all, while filterByNotebook still works', async () => {
        const state = await runReveal({ versionInfo: { version: '3.7.0', platform: 'mobile' }, require: mobileRequire })
        const before = panelOf(state)
        const showsBefore = state.panelShows.length
        await executeCommand(state, 'cockpit.revealNote', todoBeta)
        const html = panelOf(state)
        // The mobile panel is a tab inside Joplin's own plugin-panel dialog, which the user opens and closes: a
        // plugin that shows or hides it there is fighting the app (the same reason togglePanelVisibility returns).
        assert.strictEqual(state.panelShows.length, showsBefore, 'no panel show/hide may happen on mobile')
        assert.strictEqual(revealIDOf(html), '', 'no reveal marker is rendered on mobile')
        assert.strictEqual(currentNotebookID(html), currentNotebookID(before), 'and no filter changes')
        assert.ok(!html.includes('Revealed - outside current filters'), 'and nothing is pinned')
        // The other half of the contract is pure state plus a refresh, so it works on both platforms.
        await executeCommand(state, 'cockpit.filterByNotebook', nbAlpha)
        assert.strictEqual(currentNotebookID(panelOf(state)), nbAlpha, 'filterByNotebook still filters on mobile')
    })

    await test('cockpit.revealNote: a hidden desktop panel is shown first, and the render then carries the marker', async () => {
        const state = await runReveal({})
        await executeCommand(state, 'togglePanelVisibility')
        assert.strictEqual(state.panelShows[state.panelShows.length - 1].visible, false, 'precondition: the panel is hidden')
        const paintsWhileHidden = state.setHtmlCalls
        await executeCommand(state, 'cockpit.revealNote', todoAlpha)
        const shown = state.panelShows[state.panelShows.length - 1]
        assert.deepStrictEqual(shown, { handle: 'panel-panel', visible: true }, 'the reveal must show the hidden panel')
        assert.ok(state.setHtmlCalls > paintsWhileHidden, 'and repaint it (refreshPanelData does no work while hidden)')
        const html = panelOf(state)
        assert.ok(listsRow(html, todoAlpha) && revealIDOf(html) === '1', 'the shown panel carries the reveal marker for the row')
    })

    await test('cockpit.revealNote: a note id that resolves to nothing changes nothing', async () => {
        const state = await runReveal({})
        const before = panelOf(state)
        const paintsBefore = state.setHtmlCalls
        await executeCommand(state, 'cockpit.revealNote', 'ffffffff'.repeat(4))
        assert.strictEqual(state.setHtmlCalls, paintsBefore, 'an unknown note id must not repaint the panel')
        assert.strictEqual(panelOf(state), before, 'nor change anything in it')
        await executeCommand(state, 'cockpit.revealNote')
        assert.strictEqual(state.setHtmlCalls, paintsBefore, 'and neither must a missing argument')
    })

    await test('the reveal marker is consumed exactly once, by the render that actually holds the row (webview source)', () => {
        const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panelWebview.js'), 'utf8')
        const at = webviewSource.indexOf('function applyPendingReveal(')
        assert.ok(at >= 0, 'the webview must have the reveal consumer')
        const body = webviewSource.slice(at, webviewSource.indexOf('\nfunction restoreTodosScroll', at))
        assert.ok(body.includes('dataset.revealId') && body.includes('dataset.revealNote'),
            'it reads the marker off the rendered markup, not off a message that would race the render')
        // The cascade paints up to three times with the SAME marker; the paints before the row exists must leave
        // it unconsumed, so the row-not-found return has to come BEFORE the marker is claimed.
        const notFound = body.indexOf('if (!row) return')
        const claim = body.indexOf('consumedRevealID = revealID')
        assert.ok(notFound >= 0 && claim > notFound, 'a render without the row must not consume the marker')
        assert.ok(body.includes("revealID === consumedRevealID"), 'and a marker already flashed is never flashed again')
        assert.ok(/scrollIntoView\(\{ block: 'center' \}\)/.test(body), 'the revealed row is scrolled into view, centered')
        assert.ok(body.includes("classList.add('-revealed')"), 'and flashed with its own class')
        assert.ok(/setTimeout\(function\(\)\{ row\.classList\.remove\('-revealed'\) \}, REVEAL_FLASH_MS\)/.test(body),
            'which a timer takes off again')
        assert.ok(/var REVEAL_FLASH_MS = 15\d\d/.test(webviewSource), 'the flash is short (~1.5s)')
        // It runs from reconcile, i.e. once per real re-render, after the scroll restore it must not be undone by.
        const reconcile = webviewSource.slice(webviewSource.indexOf('function reconcile()'), webviewSource.indexOf('function startPanelObserver'))
        const restore = reconcile.indexOf('restoreTodosScroll(el)')
        const apply = reconcile.indexOf('applyPendingReveal(el, nonce)')
        assert.ok(restore >= 0 && apply > restore, 'the reveal must be applied from reconcile, after the scroll restore')
    })

    await test('the reveal flash is a distinct, purely visual class (panel.css source)', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        const at = css.indexOf('.todo.-revealed {')
        assert.ok(at >= 0, 'panel.css must style the reveal flash')
        const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
        // Distinct from the selection highlight: the revealed note is usually ALSO the open note, so a flash that
        // reused .-selected's look would be invisible exactly when it matters most.
        assert.ok(/outline/.test(body), 'the flash must be visible on a row that is already -selected')
        assert.ok(/animation/.test(body), 'and fade rather than stay')
        // Purely visual, like every other row-state class: nothing here may change a row's box.
        assert.ok(!/(^|[\s;])(margin|padding|width|height|display|position|border-width|font-size)\s*:/.test(body),
            'the flash must not change the row box')
        assert.ok(/var\(--cockpit-/.test(body), 'and it must take its colours from the theme variables')
    })

    // ============================================ the note title bar (v2.5.0): the due date on hover, and the bell's own picker
    // Two owner-approved, desktop-only features, both OFF by default and both "after a Joplin restart" - because neither can be
    // undone while the app runs: Joplin cannot unload a chrome stylesheet, and it cannot unregister a content script.
    //  A. A chrome stylesheet hides the due-date text Joplin prints beside the alarm bell and brings it back as a hover bubble.
    //  B. An editor content script catches the bell's click in the renderer and hands it to Cockpit's own alarm dialog. Joplin's
    //     editAlarm cannot be overridden (registerDeclaration REPLACES the entry and drops its mapStateToTitle, which is what puts
    //     the due date on the button in the first place), so the DOM intercept is the only route.
    const bellTodoID = '1a'.repeat(16)
    const bellDoneID = '2b'.repeat(16)
    const bellNoteID = '3c'.repeat(16)
    const bellUnknownID = '4d'.repeat(16)
    const titleBarNotes = {
        [bellTodoID]: { id: bellTodoID, title: 'Bell task', is_todo: 1, todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: 'n'.repeat(32) },
        [bellDoneID]: { id: bellDoneID, title: 'Bell task done', is_todo: 1, todo_completed: Date.now() - 3600000, todo_due: Date.now() + 3600000, parent_id: 'n'.repeat(32) },
        [bellNoteID]: { id: bellNoteID, title: 'Bell plain note', is_todo: 0, todo_completed: 0, parent_id: 'n'.repeat(32) },
    }
    const titleBarInstall = path.join(tmp, 'title-bar-install')
    const HOVER_KEY = 'hideDueDateOnBell'
    const PICKER_KEY = 'bellOpensCockpitPicker'
    const HOVER_CSS_PATH = `${titleBarInstall}/ui/chrome/dueOnHover.css`
    let titleBarSeq = 0
    const runTitleBar = (initialSettings, platform) => run({
        dataDir: path.join(tmp, 'title-bar-' + (++titleBarSeq)),
        installationDir: titleBarInstall,
        require: platform === 'mobile' ? mobileRequire : desktopRequire,
        versionInfo: { version: '3.7.0', platform: platform || 'desktop' },
        todos: [titleBarNotes[bellTodoID]],
        notes: titleBarNotes,
        initialSettings: initialSettings || {},
    })
    const bothOn = { [HOVER_KEY]: true, [PICKER_KEY]: true }

    await test('title bar settings: two public Bool settings in the Cockpit section, both defaulting to OFF, both naming the restart', async () => {
        const state = await runTitleBar()
        const defs = state.registeredSettings
        for (const [key, label] of [
            [HOVER_KEY, 'Hide the due date next to the bell in the note title bar and show it on hover'],
            [PICKER_KEY, "Open Cockpit's date picker instead of Joplin's when the alarm bell is clicked"],
        ]){
            const def = defs[key]
            assert.ok(def, `the ${key} setting must be registered`)
            assert.strictEqual(def.label, label, `${key} label`)
            assert.strictEqual(def.value, false, `${key} must default to OFF - neither feature may appear unasked`)
            assert.strictEqual(def.type, 3, `${key} must be SettingItemType.Bool (3)`)
            assert.strictEqual(def.public, true, `${key} must be visible in Settings > Cockpit`)
            assert.strictEqual(def.section, 'section', `${key} must live in Cockpit's own section`)
            // The house style carries the caveat inline in the description (cf. showToolbarButton), because Joplin
            // gives a plugin no way to say "restart needed" in the Settings screen itself.
            assert.ok(/restart/i.test(def.description || ''), `${key}'s description must say the change needs a Joplin restart`)
            assert.ok(/desktop/i.test(def.description || ''), `${key}'s description must say it is desktop only`)
        }
        // The Markdown-editor limit belongs to the intercept alone: with the Rich Text editor no plugin JS runs in
        // the window at all, so the bell keeps Joplin's picker and the user has to be told.
        assert.ok(/markdown/i.test(defs[PICKER_KEY].description), "the picker setting must name the Markdown-editor limit")
    })

    await test('due date on hover (A): the chrome stylesheet is loaded exactly once, from the installation directory, when the setting is on', async () => {
        const state = await runTitleBar({ [HOVER_KEY]: true })
        assert.deepStrictEqual(state.chromeCssFiles, [HOVER_CSS_PATH],
            'exactly the one file, at the path the CopyPlugin ships it to inside the installed plugin')
        // The note viewer is a different surface entirely and must not be touched by a title-bar tweak.
        assert.deepStrictEqual(state.noteCssFiles, [], 'no note stylesheet may be loaded')
    })

    await test('due date on hover (A): nothing is loaded while the setting is off', async () => {
        const state = await runTitleBar({ [HOVER_KEY]: false })
        assert.deepStrictEqual(state.chromeCssFiles, [],
            'a stylesheet loaded here could never be unloaded again - the setting is the only gate there is')
    })

    await test('due date on hover (A): nothing is loaded on mobile, even with the setting on', async () => {
        const state = await runTitleBar(bothOn, 'mobile')
        assert.deepStrictEqual(state.chromeCssFiles, [], 'joplin.window is a desktop API and mobile has no note title bar')
    })

    await test('the bell intercept (B): the content script is registered as a CodeMirror plugin, with its handler, when the setting is on', async () => {
        const state = await runTitleBar({ [PICKER_KEY]: true })
        assert.deepStrictEqual(state.contentScripts, [{
            type: 'codeMirrorPlugin',
            id: 'cockpit-title-bar',
            scriptPath: './contentScripts/titleBar.js',
        }], 'the type, the id and the built path are the whole registration - and the path must be the one the archive carries')
        assert.ok(typeof state.contentScriptHandlers['cockpit-title-bar'] === 'function',
            'the same id must carry an onMessage handler, or the click has nowhere to go')
        // The built file really is in dist/, so the registered path is not a promise the build fails to keep.
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'dist', 'contentScripts', 'titleBar.js')),
            'plugin.config.json must build src/contentScripts/titleBar.ts into dist/contentScripts/titleBar.js')
    })

    await test('the bell intercept (B): nothing is registered while the setting is off', async () => {
        const state = await runTitleBar({ [PICKER_KEY]: false })
        assert.deepStrictEqual(state.contentScripts, [], 'a registered content script cannot be unregistered while Joplin runs')
        assert.deepStrictEqual(Object.keys(state.contentScriptHandlers), [], 'and no handler may be listening')
    })

    await test('the bell intercept (B): nothing is registered on mobile, even with the setting on', async () => {
        const state = await runTitleBar(bothOn, 'mobile')
        assert.deepStrictEqual(state.contentScripts, [],
            'mobile has no note title bar and no CodeMirror-hosted chrome DOM for the script to reach')
        assert.deepStrictEqual(Object.keys(state.contentScriptHandlers), [])
    })

    await test('the bell intercept (B): an uncompleted to-do opens Cockpit\'s dialog, and OK writes its due', async () => {
        const state = await runTitleBar({ [PICKER_KEY]: true })
        state.dialogResult = { id: 'ok', formData: { alarm: { date: '2027-03-04', time: '08:30' } } }
        const putsBefore = state.notePuts.length
        const answer = await state.contentScriptHandlers['cockpit-title-bar']({ type: 'openAlarm', noteId: bellTodoID })
        assert.deepStrictEqual(answer, { ok: true })
        const puts = state.notePuts.slice(putsBefore)
        assert.strictEqual(puts.length, 1, 'exactly the one to-do the bell belongs to is written')
        assert.strictEqual(puts[0].id, bellTodoID)
        assert.strictEqual(typeof puts[0].fields.todo_due, 'number', 'the due must land as a numeric timestamp')
        assert.strictEqual(puts[0].fields.todo_due, new Date(2027, 2, 4, 8, 30, 0, 0).getTime(),
            'and be exactly the datetime the dialog came back with')
    })

    await test('the bell intercept (B): a plain note is refused, and nothing is written', async () => {
        const state = await runTitleBar({ [PICKER_KEY]: true })
        state.dialogResult = { id: 'ok', formData: { alarm: { date: '2027-03-04', time: '08:30' } } }
        const putsBefore = state.notePuts.length
        const answer = await state.contentScriptHandlers['cockpit-title-bar']({ type: 'openAlarm', noteId: bellNoteID })
        assert.strictEqual(answer.ok, false, 'Joplin disables the bell on a plain note, so Cockpit must not offer an alarm for one')
        assert.strictEqual(state.notePuts.length, putsBefore, 'and no note may be written')
    })

    await test('the bell intercept (B): a completed to-do is refused, and nothing is written', async () => {
        const state = await runTitleBar({ [PICKER_KEY]: true })
        state.dialogResult = { id: 'ok', formData: { alarm: { date: '2027-03-04', time: '08:30' } } }
        const putsBefore = state.notePuts.length
        const answer = await state.contentScriptHandlers['cockpit-title-bar']({ type: 'openAlarm', noteId: bellDoneID })
        assert.strictEqual(answer.ok, false, 'a completed to-do is the other state in which Joplin disables the bell')
        assert.strictEqual(state.notePuts.length, putsBefore)
    })

    await test('the bell intercept (B): an unknown id and a malformed payload come back as { ok: false }, never as a throw', async () => {
        const state = await runTitleBar({ [PICKER_KEY]: true })
        const handler = state.contentScriptHandlers['cockpit-title-bar']
        // data.get throws 'Not Found' for an id the database does not know (the note was deleted between the render
        // and the click). A rejected promise here would reach the renderer as an unhandled rejection and do nothing
        // visible at all, so every refusal has to come back as a value the content script can log.
        const unknown = await handler({ type: 'openAlarm', noteId: bellUnknownID })
        assert.strictEqual(unknown.ok, false, 'an unknown id is a refusal, not a failure')
        for (const payload of [null, undefined, 'openAlarm', 42, { type: 'openAlarm', noteId: 17 }, { type: 'somethingElse', noteId: bellTodoID }]){
            const answer = await handler(payload)
            assert.strictEqual(answer.ok, false, `the payload ${JSON.stringify(payload)} must be refused`)
        }
        assert.deepStrictEqual(state.notePuts, [], 'and none of them may write anything')
    })

    await test('the bell intercept (B): the content script binds on .note-editor-wrapper in the CAPTURE phase, keys on the alarm icon, and reads the note id at click time', () => {
        // A SOURCE pin: this file runs in Joplin's renderer window, which this harness does not have. Each line
        // below is one of the three constraints that make the intercept work, and each is a mistake that would
        // look correct in review.
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'contentScripts', 'titleBar.ts'), 'utf8')
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        // 1. The listener goes on the stable wrapper, NEVER on the button: the bell's React key embeds the due-date
        //    text, so the button is remounted the moment an alarm changes and a listener on it would be dropped.
        assert.ok(/closest\('\.note-editor-wrapper'\)/.test(code), "the listener's host must be found with closest('.note-editor-wrapper')")
        assert.ok(/root\.addEventListener\('click', onClick, true\)/.test(code), 'and the listener must be bound to that wrapper')
        assert.ok(!/button\.addEventListener|btn\.addEventListener/.test(code), 'never to the button, which remounts on every alarm change')
        // 3. Capture phase, and the event is stopped there - React 18 delegates onClick from a BUBBLE listener on
        //    its root container, so only a capture-phase stop below that root keeps Joplin's editAlarm from running.
        const listener = code.slice(code.indexOf('var onClick = '))
        assert.ok(/root\.addEventListener\('click', onClick, true\)/.test(listener), 'the listener must be registered with capture: true')
        assert.ok(/event\.stopPropagation\(\)/.test(listener), 'and stop the event')
        assert.ok(/event\.preventDefault\(\)/.test(listener), 'and prevent its default')
        assert.ok(/stopImmediatePropagation/.test(listener), 'with stopImmediatePropagation as the belt to that braces')
        // 2. The discriminator: the title-bar row AND the bell's own icon. Never -has-title, which a to-do without
        //    an alarm does not carry; never the other title-bar buttons (spellcheck, layout, properties, the gauge).
        assert.ok(/closest\('\.note-title-info-group button\.toolbar-button'\)/.test(listener),
            'the click must be narrowed to a title-bar toolbar button')
        assert.ok(/querySelector\('span\.toolbar-icon\.icon-alarm'\)/.test(listener),
            'and then to the ALARM one by its icon - the only discriminator that holds for a to-do with no alarm yet')
        assert.ok(!/-has-title/.test(listener), '-has-title is present only once the to-do HAS an alarm, so it must not be the key')
        // The disabled bell dispatches no click at all; the early return is what makes that explicit and leaves
        // such an event untouched rather than swallowing it.
        assert.ok(/if \(button\.disabled\) return/.test(listener), 'a disabled bell must be left entirely alone')
        // 4. A listener whose editor was destroyed must stand aside. .note-editor-wrapper is created by the layout
        //    renderer AROUND <NoteEditor>, so it OUTLIVES the CodeMirror instance while plugin() runs once per editor
        //    MOUNT: a Markdown -> Rich Text -> Markdown round trip leaves an older listener bound, holding a destroyed
        //    view whose state still answers with the note it died on. It is FIRST in the capture list and stops the
        //    event, so without this guard it would win and open the picker on the WRONG note.
        assert.ok(/view\.dom\.isConnected/.test(listener), 'a stale listener must detect its destroyed view by its detached DOM')
        assert.ok(/removeEventListener\('click', onClick, true\)/.test(listener), 'and unbind itself rather than accumulate')
        const staleGuard = listener.slice(0, listener.indexOf('event.target'))
        assert.ok(/isConnected/.test(staleGuard), 'and that check must come BEFORE the event is inspected or stopped')
        // The note id is a facet read INSIDE the listener: plugin() runs once per editor MOUNT, not once per note,
        // so an id captured at mount time would be the first note the editor ever showed, forever.
        assert.ok(/noteIdFacet/.test(code), 'the note id must come from the editor\'s noteIdFacet')
        // Structural, not literal: `const`/`let` and the `{ noteId }` shorthand are the same code, and a pin that
        // failed on them would be pinning the author's typing rather than the behaviour.
        assert.ok(/(?:var|let|const)\s+noteId\s*=\s*currentNoteId\(\)/.test(listener),
            'and be read at click time, not at mount time')
        assert.ok(/postMessage\(\{\s*type:\s*'openAlarm',\s*noteId(?:\s*:\s*noteId)?\s*\}\)/.test(listener),
            'the message shape the plugin handler answers')
    })

    await test('due date on hover (A): the stylesheet is the owner\'s block, scoped to the title-bar row and to the BELL by its own icon', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'chrome', 'dueOnHover.css'), 'utf8')
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
        // Every selector is scoped to the note title bar's own row: this file is loaded into the WHOLE app window,
        // so an unscoped rule would hide text in every toolbar Joplin has.
        const selectors = rules.split('}').map(part => part.slice(0, part.indexOf('{')).trim()).filter(Boolean)
        assert.strictEqual(selectors.length, 4, 'the owner\'s block is four rules')
        // -has-title alone does NOT make the selector the bell. The row is built from
        // ["showSpellCheckerMenu", "editAlarm", "toggleVisiblePanes", "showNoteProperties"], and showSpellCheckerMenu
        // ALSO carries a mapStateToTitle (the enabled dictionary languages, "en"), which on an ordinary profile is
        // non-empty - so it too gets -has-title and a text span. Hiding that label is not what this setting promises.
        // The bell's own icon is the discriminator that holds, so EVERY rule must carry it as well as the row scope.
        for (const selector of selectors){
            assert.ok(selector.startsWith('.note-title-info-group button.toolbar-button.-has-title'),
                `every rule must be scoped to the title-bar bell, "${selector}" is not`)
            assert.ok(selector.includes(':has(span.toolbar-icon.icon-alarm)'),
                `every rule must be narrowed to the bell's own icon, "${selector}" is not - it would also catch the spell checker's language label`)
        }
        assert.ok(/> span:not\(\.toolbar-icon\) \{\s*display: none/.test(rules), 'the due-date text span is the thing hidden')
        assert.ok(/:hover > span:not\(\.toolbar-icon\)/.test(rules), 'and hover is what brings it back')
        assert.ok(/overflow: visible/.test(rules), 'the button must stop clipping, or the hover bubble is cut off')
    })

    await test('sandbox proxy: no joplin.* member is ever read without being called in the same expression', () => {
        // THE golden rule, enforced over the whole source tree. `joplin` is sandboxProxy(wrappedTarget): its
        // handler.get pushes the property onto a SHARED __joplinNamespace array and only handler.apply pops one
        // segment, so any member read that is not immediately called leaves that path permanently one segment
        // too long and every later call on it is rejected by the host. The plugin API cannot be feature-detected
        // by inspection - only called and caught. This is what broke the clipboard copy actions.
        const roots = [path.join(__dirname, '..', 'src')]
        const files = []
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) walk(full)
                else if (/\.(ts|js)$/.test(entry.name)) files.push(full)
            }
        }
        for (const root of roots) walk(root)
        assert.ok(files.length > 10, 'the audit must actually have found the source tree')

        // Comments, string/template literals and regex literals are blanked out first (newlines preserved so the
        // reported line numbers stay true): several banner comments and a few strings mention "joplin." as prose.
        // A ${...} interpolation is re-entered as code, so a call inside a template is still audited.
        const blankNonCode = (source) => {
            let out = ''
            let i = 0
            const n = source.length
            let prev = ''
            while (i < n){
                const c = source[i], next = source[i + 1]
                if (c === '/' && next === '/'){ while (i < n && source[i] !== '\n'){ out += ' '; i++ } continue }
                if (c === '/' && next === '*'){
                    while (i < n && !(source[i] === '*' && source[i + 1] === '/')){ out += source[i] === '\n' ? '\n' : ' '; i++ }
                    out += '  '; i += 2; continue
                }
                if (c === '"' || c === "'"){
                    out += ' '; i++
                    while (i < n && source[i] !== c){
                        if (source[i] === '\\'){ out += '  '; i += 2; continue }
                        out += source[i] === '\n' ? '\n' : ' '; i++
                    }
                    out += ' '; i++; prev = 'x'; continue
                }
                if (c === '`'){
                    out += ' '; i++
                    while (i < n){
                        if (source[i] === '\\'){ out += '  '; i += 2; continue }
                        if (source[i] === '`'){ out += ' '; i++; break }
                        if (source[i] === '$' && source[i + 1] === '{'){
                            out += '  '; i += 2
                            let depth = 1
                            const start = i
                            while (i < n && depth){
                                if (source[i] === '{') depth++
                                else if (source[i] === '}') depth--
                                if (!depth) break
                                i++
                            }
                            out += blankNonCode(source.slice(start, i))
                            out += ' '; i++; continue
                        }
                        out += source[i] === '\n' ? '\n' : ' '; i++
                    }
                    prev = 'x'; continue
                }
                if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(prev || '(')){
                    out += ' '; i++
                    let inClass = false
                    while (i < n){
                        if (source[i] === '\\'){ out += '  '; i += 2; continue }
                        if (source[i] === '[') inClass = true
                        else if (source[i] === ']') inClass = false
                        else if (source[i] === '/' && !inClass) break
                        else if (source[i] === '\n') break
                        out += ' '; i++
                    }
                    out += ' '; i++
                    while (i < n && /[a-z]/.test(source[i])){ out += ' '; i++ }
                    prev = 'x'; continue
                }
                out += c
                if (!/\s/.test(c)) prev = c
                i++
            }
            return out
        }

        const offenders = []
        for (const file of files){
            // `(joplin as any).x()` is the same one-get-then-call shape, so the cast is normalised away rather
            // than left to hide the expression from the audit.
            const code = blankNonCode(fs.readFileSync(file, 'utf8')).replace(/\(\s*joplin\s+as\s+any\s*\)/g, ' joplin        ')
            // A bare `joplin` identifier (the import) is not a member read and never matches: the group is +.
            // A COMPUTED member that is called at once - joplin.workspace[eventName](handler) in core/timer.ts -
            // is one get plus one apply and is correct, so the rule is about the next character, not the syntax.
            const re = /\bjoplin\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\])+/g
            let match
            while ((match = re.exec(code)) !== null){
                const after = (code.slice(match.index + match[0].length).match(/^\s*(\S)/) || [])[1]
                if (after === '(') continue
                const line = code.slice(0, match.index).split('\n').length
                offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${line} -> ${match[0].replace(/\s+/g, '')}`)
            }
        }
        assert.strictEqual(offenders.length, 0,
            'a joplin.* member was read without being called in the same expression, which corrupts the sandbox ' +
            'proxy path for every later call on it:\n        ' + offenders.join('\n        '))
    })


    // ============================================================ interval horizons (v2.2.0): the pure plan module
    // The interval view's named horizons are a shared, deterministic core module (src/core/horizons.js) - the SAME UMD
    // file the host bundles (require in formats.ts) and the harness unit-tests here - so the owner's acceptance
    // calendars are pinned once and drive the real panel. A section is the SLICE between the previous section's end and
    // its own end; a period whose slice would be EMPTY (its end already reached by the section above it) is skipped and
    // the NEXT period takes its slot - "Next Week" on a Saturday, "Next Month" at a month's end, "Next Year" in
    // December. A section's drop day is the FIRST day of its slice, not the last day of its period.
    const Horizons = require('../src/core/horizons.js')
    const isoDayOf = ts => { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

    // The owner's confirmed calendars, Monday-start weeks, the plan taken at noon. Each row carries the exact ordered
    // section names, each section's drop day (the first day of its slice) and each section's last day.
    const ownerHorizons = [
        { label: 'Sat 2026-09-05', on: [2026, 9, 5],
          names: ['Today', 'Tomorrow', 'Next Week', 'This Month', 'This Year'],
          drops: ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-14', '2026-10-01'],
          lastDays: ['2026-09-05', '2026-09-06', '2026-09-13', '2026-09-30', '2026-12-31'] },
        { label: 'Sun 2026-09-06', on: [2026, 9, 6],
          names: ['Today', 'Tomorrow', 'Next Week', 'This Month', 'This Year'],
          drops: ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-14', '2026-10-01'],
          lastDays: ['2026-09-06', '2026-09-07', '2026-09-13', '2026-09-30', '2026-12-31'] },
        { label: 'Mon 2026-09-07', on: [2026, 9, 7],
          names: ['Today', 'Tomorrow', 'This Week', 'This Month', 'This Year'],
          drops: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-14', '2026-10-01'],
          lastDays: ['2026-09-07', '2026-09-08', '2026-09-13', '2026-09-30', '2026-12-31'] },
        { label: 'Tue 2026-09-29', on: [2026, 9, 29],
          names: ['Today', 'Tomorrow', 'This Week', 'Next Month', 'This Year'],
          drops: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05', '2026-11-01'],
          lastDays: ['2026-09-29', '2026-09-30', '2026-10-04', '2026-10-31', '2026-12-31'] },
        { label: 'Thu 2026-10-01', on: [2026, 10, 1],
          names: ['Today', 'Tomorrow', 'This Week', 'This Month', 'This Year'],
          drops: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05', '2026-11-01'],
          lastDays: ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-31', '2026-12-31'] },
        { label: 'Thu 2026-12-10', on: [2026, 12, 10],
          names: ['Today', 'Tomorrow', 'This Week', 'This Month', 'Next Year'],
          drops: ['2026-12-10', '2026-12-11', '2026-12-12', '2026-12-14', '2027-01-01'],
          lastDays: ['2026-12-10', '2026-12-11', '2026-12-13', '2026-12-31', '2027-12-31'] },
        { label: 'Sat 2026-08-29', on: [2026, 8, 29],
          names: ['Today', 'Tomorrow', 'Next Week', 'Next Month', 'This Year'],
          drops: ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-07', '2026-10-01'],
          lastDays: ['2026-08-29', '2026-08-30', '2026-09-06', '2026-09-30', '2026-12-31'] },
        { label: 'Tue 2026-09-01', on: [2026, 9, 1],
          names: ['Today', 'Tomorrow', 'This Week', 'This Month', 'This Year'],
          drops: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-07', '2026-10-01'],
          lastDays: ['2026-09-01', '2026-09-02', '2026-09-06', '2026-09-30', '2026-12-31'] },
        { label: 'Thu 2026-12-31', on: [2026, 12, 31],
          names: ['Today', 'Tomorrow', 'This Week', 'Next Month', 'Next Year'],
          drops: ['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-04', '2027-02-01'],
          lastDays: ['2026-12-31', '2027-01-01', '2027-01-03', '2027-01-31', '2027-12-31'] },
        { label: 'Fri 2027-01-01', on: [2027, 1, 1],
          names: ['Today', 'Tomorrow', 'This Week', 'This Month', 'This Year'],
          drops: ['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-02-01'],
          lastDays: ['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-31', '2027-12-31'] },
        { label: 'Wed 2026-09-02', on: [2026, 9, 2],
          names: ['Today', 'Tomorrow', 'This Week', 'This Month', 'This Year'],
          drops: ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-10-01'],
          lastDays: ['2026-09-02', '2026-09-03', '2026-09-06', '2026-09-30', '2026-12-31'] },
    ]

    for (const owner of ownerHorizons) {
        await test(`horizonPlan pinned (${owner.label}): ${owner.names.join(' | ')}`, () => {
            const plan = Horizons.horizonPlan(atDate(owner.on[0], owner.on[1], owner.on[2], 12, 0).getTime(), 1)
            assert.deepStrictEqual(plan.sections.map(s => s.name), owner.names, 'the ordered section names')
            assert.deepStrictEqual(plan.sections.map(s => s.dropDate), owner.drops, 'the drop day of each section')
            assert.deepStrictEqual(plan.sections.map(s => isoDayOf(s.end)), owner.lastDays, 'the last day of each slice')
            // dropEndDateFor against the owner's own last days, not against the plan it reads: this is the value the
            // heading carries as data-drop-end, and the bottom edge of a between-row drop is derived from it, so it
            // has to be pinned to a literal or a wrong span (the drop day, the previous end, a day off) reads as true.
            assert.deepStrictEqual(plan.sections.map(s => Horizons.dropEndDateFor(s.name, plan)), owner.lastDays,
                'dropEndDateFor must name the last day of each slice')
            plan.sections.forEach((section, index) => {
                // Every end is the last MILLISECOND of its day, and every boundary is exact: that millisecond still
                // belongs to this slice, the one after it opens the next (or Future past the year slice).
                const end = new Date(section.end)
                assert.strictEqual(`${end.getHours()}:${end.getMinutes()}:${end.getSeconds()}.${end.getMilliseconds()}`, '23:59:59.999', `${section.name} must end on the last millisecond of its day`)
                assert.strictEqual(Horizons.horizonOf(section.end, plan), section.name, `the last millisecond of ${section.name}`)
                const next = index + 1 < plan.sections.length ? plan.sections[index + 1].name : 'Future'
                assert.strictEqual(Horizons.horizonOf(section.end + 1, plan), next, `the first millisecond after ${section.name}`)
            })
        })
    }

    await test('horizon names: kindOf drives the row label, dropDateFor the drop - "clear" for No Due Date, none for Overdue/Future', () => {
        // The row label follows the KIND of the section, which is why Next Week reads like This Week (a weekday) and
        // Next Month / Next Year like their This counterparts (a date).
        assert.deepStrictEqual(['Today', 'Tomorrow'].map(Horizons.kindOf), ['day', 'day'])
        assert.deepStrictEqual(['This Week', 'Next Week'].map(Horizons.kindOf), ['week', 'week'])
        assert.deepStrictEqual(['This Month', 'Next Month'].map(Horizons.kindOf), ['month', 'month'])
        assert.deepStrictEqual(['This Year', 'Next Year'].map(Horizons.kindOf), ['year', 'year'])
        assert.deepStrictEqual(['Overdue', 'Future', 'No Due Date', ''].map(Horizons.kindOf), [null, null, null, null])
        const plan = Horizons.horizonPlan(atDate(2026, 9, 2, 12, 0).getTime(), 1)
        assert.strictEqual(Horizons.dropDateFor('No Due Date', plan), 'clear')
        assert.strictEqual(Horizons.dropDateFor('Overdue', plan), null)
        assert.strictEqual(Horizons.dropDateFor('Future', plan), null)
        assert.strictEqual(Horizons.dropDateFor('This Week', plan), '2026-09-04')
        // A name that is not in THIS plan (that Wednesday has no Next Week) is not a drop target either.
        assert.strictEqual(Horizons.dropDateFor('Next Week', plan), null)
        // dropEndDateFor names a SPAN, so every heading that is not a section of this plan has none - including the
        // Next name that plan does not use. Its section values are pinned against the owner's last days above.
        assert.deepStrictEqual(['No Due Date', 'Overdue', 'Future', 'Next Week', ''].map(name => Horizons.dropEndDateFor(name, plan)),
            [null, null, null, null, null])
        assert.strictEqual(Horizons.dropEndDateFor('This Week', plan), '2026-09-06')
    })

    // The exhaustive sweep: every day of 2026, 2027 and 2028, at midnight, noon and the last millisecond of the day,
    // for both week starts - 6576 plans of pure math, no rendering. The three checks below state the invariants the
    // plan must satisfy on every one of them, so a rule that only happens to look right in September is caught here.
    // 2028 is in the range on purpose: it is the nearest leap year, so February 29 and a 29-day February go through
    // the month arithmetic (new Date(y, m + offset + 1, 0)) that a leap year is exactly the case for.
    const sweepPlans = []
    for (let day = new Date(2026, 0, 1); day.getFullYear() < 2029; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        for (const clock of [[0, 0, 0, 0], [12, 0, 0, 0], [23, 59, 59, 999]]) {
            for (const weekStartsOn of [0, 1]) {
                const now = new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock[0], clock[1], clock[2], clock[3])
                sweepPlans.push({
                    now, weekStartsOn,
                    plan: Horizons.horizonPlan(now.getTime(), weekStartsOn),
                    where: `${now.toDateString()} ${clock[0]}:${String(clock[1]).padStart(2, '0')} weekStartsOn=${weekStartsOn}`,
                })
            }
        }
    }

    await test('horizonPlan sweep (every day of 2026-2028, both week starts): five ordered slices, and a period is replaced by its Next exactly when its own end is already covered', () => {
        const endOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime()
        const periods = [['This Week', 'Next Week'], ['This Month', 'Next Month'], ['This Year', 'Next Year']]
        for (const { now, weekStartsOn, plan, where } of sweepPlans) {
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
            assert.strictEqual(plan.startOfToday, today.getTime(), `start of today at ${where}`)
            assert.strictEqual(plan.sections.length, 5, `five sections at ${where}`)
            assert.deepStrictEqual(plan.sections.slice(0, 2).map(s => s.name), ['Today', 'Tomorrow'], `the two day slices at ${where}`)
            // (a) the ends strictly increase, opened by start-of-today < end-of-today < end-of-tomorrow.
            assert.ok(plan.sections[0].end > plan.startOfToday, `today must end after it starts at ${where}`)
            for (let index = 1; index < plan.sections.length; index++) {
                assert.ok(plan.sections[index].end > plan.sections[index - 1].end,
                    `${plan.sections[index].name} must end after the slice above it at ${where}`)
            }
            // (b) exactly one section per period, and it is the Next one IFF this period's own end is already covered
            // by the section above - in which case the slice must run strictly past that end, so it cannot be empty.
            const thisEnds = [
                endOfDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() - weekStartsOn + 7) % 7) + 6)),
                endOfDay(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
                endOfDay(new Date(today.getFullYear(), 11, 31)),
            ]
            periods.forEach((pair, offset) => {
                const section = plan.sections[2 + offset]
                const absorbed = thisEnds[offset] <= plan.sections[1 + offset].end
                assert.strictEqual(section.name, absorbed ? pair[1] : pair[0], `the ${pair[0]} slot at ${where}`)
                if (absorbed) assert.ok(section.end > thisEnds[offset], `${pair[1]} must end past ${pair[0]} at ${where}`)
                else assert.strictEqual(section.end, thisEnds[offset], `${pair[0]} must end with its own period at ${where}`)
            })
        }
    })

    await test('horizonPlan sweep (2026-2028): every drop day is the FIRST day of its own slice - it buckets there, and the day before it lands in an earlier slice', () => {
        const dayAt = (iso, hour) => { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2], hour, 0, 0, 0).getTime() }
        for (const { plan, where } of sweepPlans) {
            plan.sections.forEach((section, index) => {
                // (d) the drop day is the calendar day AFTER the previous slice's last day (today, for Today itself).
                const previous = index ? new Date(plan.sections[index - 1].end) : new Date(plan.startOfToday)
                const firstDay = index ? new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1) : previous
                assert.strictEqual(section.dropDate, isoDayOf(firstDay.getTime()), `the drop day of ${section.name} at ${where}`)
                // ...and the OTHER end of the same span, which travels with the heading as data-drop-end.
                assert.strictEqual(Horizons.dropEndDateFor(section.name, plan), isoDayOf(section.end),
                    `the slice end day of ${section.name} at ${where}`)
                // (c) a to-do dropped there really lands in this slice, and the day before it does not.
                assert.strictEqual(Horizons.horizonOf(dayAt(section.dropDate, 9), plan), section.name,
                    `${section.dropDate} 09:00 must bucket into ${section.name} at ${where}`)
                if (index) {
                    const before = Horizons.horizonOf(new Date(previous.getFullYear(), previous.getMonth(), previous.getDate(), 12, 0, 0, 0).getTime(), plan)
                    const beforeIndex = plan.sections.findIndex(s => s.name === before)
                    assert.ok(beforeIndex >= 0 && beforeIndex < index,
                        `the day before ${section.name}'s drop day must be an earlier slice, was ${before} at ${where}`)
                }
            })
        }
    })

    await test('horizonPlan sweep (2026-2028): each slice owns its own last millisecond, the next owns the one after, and anything before today is Overdue', () => {
        for (const { plan, where } of sweepPlans) {
            plan.sections.forEach((section, index) => {
                // (e) the boundaries are exact in both directions.
                assert.strictEqual(Horizons.horizonOf(section.end, plan), section.name, `the last millisecond of ${section.name} at ${where}`)
                const next = index + 1 < plan.sections.length ? plan.sections[index + 1].name : 'Future'
                assert.strictEqual(Horizons.horizonOf(section.end + 1, plan), next, `the millisecond after ${section.name} at ${where}`)
            })
            // (f) the two ends of the chain.
            assert.strictEqual(Horizons.horizonOf(plan.startOfToday - 1, plan), 'Overdue', `the millisecond before today at ${where}`)
            assert.strictEqual(Horizons.horizonOf(0, plan), 'No Due Date', `a to-do with no due date at ${where}`)
        }
    })

    // ------------------------------------------------ last day of a period stays in its own horizon (issue #3)
    // getEndOfThisMonth/getEndOfThisYear (BaseFormat helpers, removed in 2.2.0 once the pure module replaced them)
    // used to return their last day at MIDNIGHT, so a to-do due later on that
    // day fell past the boundary: the last day of the month landed in "This Year", and December 31st in "Future"
    // (what Marxsal reported in issue #3). Both periods now end at 23:59:59.999. The fixtures below are built
    // from the REAL clock with local Date constructors - the harness has no fake clock - so every expected
    // heading set is written to hold on every calendar day and time of day the suite could run. That breadth has
    // a cost worth knowing about: in the closing days of a month the two positive checks stop discriminating,
    // because an earlier horizon (Tomorrow / the week slice) then catches the row with or without the fix, and the
    // same goes for the December 31st check in the closing days of December. They are never wrong, only blind on
    // those days - the mutation verification behind them was run mid-month, where both do discriminate.
    // Since v2.2.0 a period whose slice would be empty is replaced by the NEXT one, so every set below also has to
    // admit the Next X name wherever the calendar can produce it. The sets are not guessed and not an offline
    // computation either: the pure check right below sweeps these four fixtures over 2024-2040 at three times of day
    // and both week starts, and asserts that every name reachable there is in the set the rendered check uses - the
    // same constants, so widening the calendar the suite can run on cannot silently outrun them.
    const horizonFixtureSets = {
        // The fixture dues, as functions of the moment the suite runs at - exactly how the four to-dos below are built.
        lastDayOfThisMonth: {
            due: now => new Date(now.getFullYear(), now.getMonth() + 1, 0, 22, 0, 0, 0),
            names: ['Today', 'Tomorrow', 'This Week', 'Next Week', 'This Month'],
        },
        decemberThirtyFirst: {
            due: now => new Date(now.getFullYear(), 11, 31, 22, 0, 0, 0),
            names: ['Today', 'Tomorrow', 'This Week', 'Next Week', 'This Month', 'Next Month', 'This Year'],
        },
        firstDayOfNextMonth: {
            due: now => new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0, 0),
            names: ['Tomorrow', 'This Week', 'Next Week', 'Next Month', 'This Year', 'Next Year'],
        },
        januaryFirstNextYear: {
            due: now => new Date(now.getFullYear() + 1, 0, 1, 12, 0, 0, 0),
            names: ['Tomorrow', 'This Week', 'Next Week', 'Next Month', 'Next Year', 'Future'],
        },
    }

    await test('horizon fixtures: over 2024-2040, both week starts, each of the four fixtures only ever reaches the names its rendered check allows', () => {
        // The rendered checks below run on the REAL clock, so their allowed sets have to hold on every day the suite
        // could run. This sweep is where that claim is made good: the same four dues, computed the same way, bucketed
        // against a plan for every day of seventeen years at midnight, noon and the last millisecond, for both week starts.
        // Anything a set does not admit fails HERE, on a named day, instead of flaking once a year on someone's laptop.
        const reached = {}
        for (const key of Object.keys(horizonFixtureSets)) reached[key] = new Set()
        // The claim only covers the years actually swept, and the rendered checks below run on the REAL clock, so the
        // suite has to say out loud when the clock has walked past the bound rather than let the sets quietly expire.
        const sweepFromYear = 2024
        const sweepUntilYear = 2041
        const runYear = new Date().getFullYear()
        assert.ok(runYear >= sweepFromYear && runYear < sweepUntilYear,
            `this suite is running in ${runYear}, outside the ${sweepFromYear}-${sweepUntilYear - 1} the fixture sweep covers, `
            + `so the allowed sets of the rendered heading checks below are no longer justified - widen the sweep bound `
            + `here (and the years in this check's name) to include ${runYear}`)
        for (let day = new Date(sweepFromYear, 0, 1); day.getFullYear() < sweepUntilYear; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
            for (const clock of [[0, 0, 0, 0], [12, 0, 0, 0], [23, 59, 59, 999]]) {
                for (const weekStartsOn of [0, 1]) {
                    const now = new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock[0], clock[1], clock[2], clock[3])
                    const plan = Horizons.horizonPlan(now.getTime(), weekStartsOn)
                    for (const [key, fixture] of Object.entries(horizonFixtureSets)) {
                        const heading = Horizons.horizonOf(fixture.due(now).getTime(), plan)
                        reached[key].add(heading)
                        assert.ok(fixture.names.includes(heading),
                            `${key} landed under ${heading} on ${now.toDateString()} ${clock[0]}:${String(clock[1]).padStart(2, '0')} weekStartsOn=${weekStartsOn}, which its allowed set does not admit`)
                    }
                }
            }
        }
        // And no slack the other way: every name in a set is one the calendar really produces, so the sets stay a
        // statement about the rule rather than a list padded until it passed.
        for (const [key, fixture] of Object.entries(horizonFixtureSets)) {
            assert.deepStrictEqual([...reached[key]].sort(), [...fixture.names].sort(),
                `the allowed set for ${key} must be exactly the names reached`)
        }
    })
    const horizonHeadingOf = (html, title) => {
        // Document order: split on the group headings, then report the heading of the first segment whose BODY
        // (the part after </h2>, up to the next heading) carries the title.
        const escaped = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        for (const segment of html.split(/<h2\b/).slice(1)) {
            const parts = /^[^>]*>([\s\S]*?)<\/h2>([\s\S]*)$/.exec(segment)
            if (parts && parts[2].includes(escaped)) return parts[1]
        }
        return null
    }
    const horizonNow = new Date()
    const horizonDue = (date, title, index) => ({
        id: String(index).repeat(32).slice(0, 32), title, todo_completed: 0,
        parent_id: 'n'.repeat(32), user_updated_time: 1, todo_due: date.getTime(),
    })
    // Taken BEFORE the run, like the plan on the other side of it: the render below is read against both, so a
    // midnight crossing between building the fixtures and asserting on them cannot turn into a false failure.
    const horizonPlanBefore = Horizons.horizonPlan(Date.now(), Number(baseProfile.weekStartsOn))
    const horizonState = await run({
        dataDir: path.join(tmp, 'horizon-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [
            // The dues come from horizonFixtureSets, so the four rendered fixtures and the seventeen-year sweep that
            // justifies their allowed sets are built by the SAME expressions and cannot drift apart.
            // 22:00 rather than midnight: the whole point is a to-do due LATE on the last day of its period.
            horizonDue(horizonFixtureSets.lastDayOfThisMonth.due(horizonNow), 'Horizon last day of this month', 1),
            horizonDue(horizonFixtureSets.decemberThirtyFirst.due(horizonNow), 'Horizon December thirty first', 2),
            horizonDue(horizonFixtureSets.firstDayOfNextMonth.due(horizonNow), 'Horizon first day of next month', 3),
            horizonDue(horizonFixtureSets.januaryFirstNextYear.due(horizonNow), 'Horizon January first next year', 4),
        ],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...baseProfile, id: 1, name: 'Horizons', sortOrder: 0 }] }),
            currentProfileID: 1,
        },
    })

    const horizonPlanAfter = Horizons.horizonPlan(Date.now(), Number(baseProfile.weekStartsOn))

    await test('horizons: a to-do due late on the last day of this month never falls past This Month', () => {
        // The due date is in the current month and never before today, so it can only be Today (today IS the last
        // day), Tomorrow, the week slice (This or Next Week - the month ends inside it) or This Month - never
        // This Year or Future. It can never be Next Month either: that slot only exists when this month's end is
        // already covered by the week slice, which is where this fixture then lands.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon last day of this month')
        assert.ok(horizonFixtureSets.lastDayOfThisMonth.names.includes(heading),
            `the last day of the month landed under ${heading}`)
    })

    await test('horizons: a to-do due late on December 31st never falls into Future (issue #3)', () => {
        // December 31st of the CURRENT year is never before today and never past the end of this year, so it is
        // Today/Tomorrow/the week slice (only in late December), This Month (only in December), Next Month (only
        // at the end of November, whose Next Month slice runs to December 31st) or This Year - the heading varies
        // with the date, but Future is impossible on every day of every year, leap years included.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon December thirty first')
        assert.ok(horizonFixtureSets.decemberThirtyFirst.names.includes(heading),
            `December 31st landed under ${heading}`)
    })

    await test('horizons: a to-do due on the first day of next month is never This Month', () => {
        // It is past the end of THIS month by construction, so the "This Month" slot can never hold it. What
        // remains is Next Month (the slot this month's end gives up when the week slice already covers it), This
        // Year, Next Year (only in December, where the year slot rolls over), or the day-level Tomorrow / the week
        // slice when the month ends within a day or a week of today - whichever weekday the week starts on. Future
        // is now unreachable: in December the year slot is always Next Year, which covers all of next January.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon first day of next month')
        assert.ok(horizonFixtureSets.firstDayOfNextMonth.names.includes(heading),
            `the first day of next month landed under ${heading}`)
    })

    await test('horizons: a to-do due on January 1st of next year is never This Month or This Year', () => {
        // It is past both this month's and this year's end on every day of the year, so neither the "This Month"
        // nor the "This Year" slot can hold it. What remains is Future, Next Year (December, where the year slot
        // rolls over and covers the whole of next year), Next Month (only the last days of December, whose Next Month
        // slice runs into January - November's reaches December 31st and no further) and, in those same last days of
        // December, Tomorrow / the week slice.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon January first next year')
        assert.ok(horizonFixtureSets.januaryFirstNextYear.names.includes(heading),
            `January 1st of next year landed under ${heading}`)
    })

    await test('horizons: every rendered period heading carries the drop day AND the slice end day the plan names', () => {
        // Panel-to-module agreement, not the first-day rule itself - that rule is pinned by the pure checks above
        // (the eleven owner calendars and the drop-day sweep). What this adds is that the HTML the panel emits
        // carries what the plan says: data-drop (the first day of the slice) and, where the slice spans more than a
        // day, data-drop-end (its last day, which the between-row bottom edge anchors on). Each heading only renders
        // when its group is non-empty, so near a month's end the fixtures move up into Tomorrow / the week slice and
        // there is less to look at; whatever DOES render must agree.
        const html = horizonState.panelHtml['panel-panel']
        const attrsOf = heading => {
            const found = new RegExp(`<h2([^>]*)>${heading}</h2>`).exec(html)
            if (!found) return undefined
            return {
                drop: (/ data-drop="([^"]*)"/.exec(found[1]) || [])[1],
                end: (/ data-drop-end="([^"]*)"/.exec(found[1]) || [])[1],
            }
        }
        // The clock can cross midnight during the run, so a rendered heading is accepted when it matches the plan on
        // either side of it. Names that changed slot between the two are simply skipped.
        for (const plan of [horizonPlanBefore, horizonPlanAfter]) {
            for (const section of plan.sections) {
                const rendered = attrsOf(section.name)
                if (rendered === undefined) continue
                const other = (plan === horizonPlanBefore ? horizonPlanAfter : horizonPlanBefore).sections.find(s => s.name === section.name)
                if (other && other.dropDate !== section.dropDate) continue
                assert.strictEqual(rendered.drop, section.dropDate, `the ${section.name} heading must carry the plan's drop day`)
                const sliceEnd = Horizons.dropEndDateFor(section.name, plan)
                assert.strictEqual(rendered.end, sliceEnd === section.dropDate ? undefined : sliceEnd,
                    `the ${section.name} heading must carry the plan's slice end day (and none when the slice is one day)`)
            }
        }
    })

    // ------------------------------------------------ the rendered panel agrees with the plan, section by section
    // The checks above look at four fixtures and can only see the headings those happen to produce. This one puts a
    // to-do on the drop day of EVERY section of the current plan, so all five period headings render, and pins each
    // rendered heading's text AND its data-drop against the plan computed here in the test. It is the end-to-end
    // statement that the panel's grouping, its drop targets and the pure module are one thing. The clock can cross
    // midnight between building the fixtures and reading the html, so the plan is taken on both sides of the run and
    // a match against either is accepted.
    const dropPlanBefore = Horizons.horizonPlan(Date.now(), Number(baseProfile.weekStartsOn))
    const dropDayNoon = iso => { const parts = iso.split('-').map(Number); return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0) }
    const dropState = await run({
        dataDir: path.join(tmp, 'horizon-drop-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: dropPlanBefore.sections.map((section, index) =>
            horizonDue(dropDayNoon(section.dropDate), `Horizon slice fixture ${index}`, index + 1)),
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...baseProfile, id: 1, name: 'Horizon slices', sortOrder: 0 }] }),
            currentProfileID: 1,
        },
    })
    const dropPlanAfter = Horizons.horizonPlan(Date.now(), Number(baseProfile.weekStartsOn))

    await test('horizons: every rendered period heading matches the plan - its name and its first-day drop date', () => {
        // If midnight fell DURING the run, the fixtures were placed on the before-plan's days and rendered under the
        // after-plan's sections (the Today fixture becomes Overdue, adding a heading), so the shape matches neither
        // plan and there is nothing meaningful to assert. Once a night, on that one run, the check stands down.
        if (dropPlanBefore.startOfToday !== dropPlanAfter.startOfToday) return
        const rendered = []
        for (const segment of dropState.panelHtml['panel-panel'].split(/<h2\b/).slice(1)) {
            const parts = /^([^>]*)>([\s\S]*?)<\/h2>/.exec(segment)
            if (parts) rendered.push(`${parts[2]}@${(/ data-drop="([^"]*)"/.exec(parts[1]) || [])[1]}`)
        }
        const shapeOf = plan => plan.sections.map(section => `${section.name}@${section.dropDate}`).join(' | ')
        const actual = rendered.join(' | ')
        assert.ok(actual === shapeOf(dropPlanBefore) || actual === shapeOf(dropPlanAfter),
            `the rendered headings were ${actual}, the plan is ${shapeOf(dropPlanBefore)}`)
    })

    await test('horizons: every rendered ROW is labelled by its section KIND - a time under a day, a weekday under a week, a date under a month or year', () => {
        // Feature item 3, pinned end-to-end rather than only through kindOf: the same run puts one to-do at noon on
        // each section's drop day, so all five sections render a row, and each row's label prefix is compared with
        // what the profile's own formatting produces for that kind. Swap the week and month branches in
        // getFormatTodoString and this fails; kindOf alone would not notice.
        if (dropPlanBefore.startOfToday !== dropPlanAfter.startOfToday) return
        const profile = baseProfile
        const labelFor = (kind, when) => {
            if (kind === 'day') return when.toLocaleTimeString(undefined, { hour: 'numeric', minute: 'numeric', hour12: profile.timeIs12Hour })
            if (kind === 'week') return when.toLocaleDateString(undefined, { weekday: profile.weekdayFormat })
            return when.toLocaleDateString(undefined, { month: profile.monthFormat, day: profile.dayFormat })
        }
        // heading -> the labels of the rows under it.
        const rowsByHeading = new Map()
        for (const segment of dropState.panelHtml['panel-panel'].split(/<h2\b/).slice(1)) {
            const parts = /^[^>]*>([\s\S]*?)<\/h2>([\s\S]*)$/.exec(segment)
            if (!parts) continue
            rowsByHeading.set(parts[1], [...parts[2].matchAll(/<a class="todo-title"[^>]*>([\s\S]*?)<\/a>/g)].map(m => m[1]))
        }
        let checked = 0
        for (const section of dropPlanBefore.sections) {
            const rows = rowsByHeading.get(section.name)
            assert.ok(rows && rows.length === 1, `${section.name} must hold exactly the one fixture placed on its drop day`)
            const expected = `${labelFor(Horizons.kindOf(section.name), dropDayNoon(section.dropDate))} - `
            assert.ok(rows[0].startsWith(expected),
                `the row under ${section.name} (kind ${Horizons.kindOf(section.name)}) must be labelled "${expected}...", was "${rows[0]}"`)
            checked++
        }
        assert.strictEqual(checked, 5, 'all five period sections must have been label-checked')
    })

    // ============================================================ the settings note (v2.6.0): profiles and settings between devices
    // Joplin syncs notes and never plugin settings, so one note carries Cockpit's profiles and view settings between a user's devices
    // (issue 5). The format half is a pure, dependency-free module - src/core/settingsNote.js, the SAME UMD file webpack bundles into
    // the plugin - so the body, the loop-prevention key and the reference parser are unit-tested here exactly as they run in the app.
    // The runtime half (src/core/settingsSync.ts) is then driven end to end through the live bundle, one rule per scenario.
    const SettingsNote = require('../src/core/settingsNote.js')
    const {
        SETTINGS_NOTE_TITLE, SETTINGS_NOTE_SENTENCE, SYNCED_SETTING_KEYS,
        buildSettingsNoteBody, parseSettingsNoteBody, parseSettingsNoteReference, settingsContentKey, isFutureSettingsNote,
    } = SettingsNote

    const SYNC_NOTE_ID = '1'.repeat(32)
    const SYNC_OTHER_ID = '2'.repeat(32)
    // A title a user might type that is NOT the note's canonical name. Typing the canonical name is a request to create the
    // note; typing anything else can only ever mean "find this one", so it waits instead - a typo must not become a mailbox.
    const OWN_TITLE = 'Team Cockpit Settings'
    // A COMPLETE profile, as a real device writes one: baseProfile plus the six fields it leaves out.
    //
    // This used to say the completeness mattered because a device "rightly" writes the completed form back when a payload leaves
    // fields out. That was the seed of the cross-version ping-pong the review found: the read side took its content key from the
    // RAW payload while the write side took it from the normalized store, so the two never agreed and the devices rewrote the note
    // at each other forever. The read side now keys on the store as this device will hold it, so an incomplete payload is applied
    // and answered with silence - which the two cross-version checks below pin directly. Complete fixtures are kept here because
    // they are what a real device writes, not because anything depends on it.
    const syncProfile = (id, name) => ({
        ...baseProfile, id, name,
        showCompleted: false, notesPosition: 'after', notebook: '', panelSearch: '', sortField: 'title', sortDirection: 'asc',
    })
    const syncStore = (nextID, profiles) => ({ nextID, profiles })
    // ...and the complete synced-settings half, at the values the registrations default to, so an apply writes only what the
    // overrides actually change.
    const syncSettings = (overrides) => {
        const all = {}
        for (const key of SYNCED_SETTING_KEYS) all[key] = ''
        return Object.assign(all, { themeMode: 'matchJoplin', completedTodoStyle: 'asNow', dayStartTime: '09:00' }, overrides || {})
    }
    const syncBody = (profiles, settings, when) => buildSettingsNoteBody({ profiles, settings }, when || '2026-09-12T08:00:00.000Z')
    const syncNoteFixture = (body) => ({ id: SYNC_NOTE_ID, title: SETTINGS_NOTE_TITLE, body, updated_time: 10 })
    // Exactly the reads this feature makes, and nothing else: a single-note GET asking for updated_time, and the title: search that
    // asks for deleted_time. No other path in the plugin asks for either field (every other note read wants user_updated_time).
    const syncGets = (state) => state.gets.filter(g =>
        (g.path[0] === 'notes' && g.path.length === 2 && g.query && Array.isArray(g.query.fields) && g.query.fields.includes('updated_time')) ||
        (g.path[0] === 'search' && g.query && Array.isArray(g.query.fields) && g.query.fields.includes('deleted_time')))
    const syncProfileNames = (state) => JSON.parse(state.settings.profileData).profiles.map(p => p.name)
    // THE FIELD'S DISPLAY FORM (2.6.1): what the visible "Settings note" setting holds once the note behind it is known - the note's
    // title and the first eight characters of its id. Built with the pure module's own function, so a check states the rule rather
    // than a literal; the reference check below pins the literal text once, which is what a user actually reads.
    const syncDisplayed = (id, title) => SettingsNote.settingsNoteDisplay(title === undefined ? SETTINGS_NOTE_TITLE : title, id)
    // The captured 3 s write the given action armed, insisting there is exactly one. Indexed from a mark rather than taken from
    // pendingTimeouts(3000), because the reconcile lane also uses a 3 s offset and a drain point may have armed one.
    const armedSyncWrite = (state, mark) => {
        const armed = state.timeouts.filter((t, index) => index >= mark && t.ms === 3000 && !t.cleared && !t.fired)
        assert.strictEqual(armed.length, 1, 'exactly one 3 s settings-note write must have been armed')
        return armed[0]
    }
    const runSync = (name, options) => run(Object.assign({
        dataDir: path.join(tmp, `sync-${name}-data`),
        installationDir: path.join(tmp, `sync-${name}-install`),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: b1Todos,
        initialSettings: {},
    }, options))

    await test('settings note: the body is the approved sentence, a blank line and one json fence', () => {
        const body = syncBody(syncStore(1, []), {})
        assert.ok(body.startsWith(SETTINGS_NOTE_SENTENCE + '\n\n'), `the human sentence heads the body:\n${body}`)
        assert.ok(/```json\n[\s\S]*\n```\n$/.test(body), `the payload sits in a json fence and nothing follows it:\n${body}`)
        // Approved copy: one unbroken line, naming the plugin and telling a passer-by to leave it alone.
        assert.ok(!/\n/.test(SETTINGS_NOTE_SENTENCE), 'the sentence is one unbroken line')
        assert.strictEqual(SETTINGS_NOTE_SENTENCE,
            'This note is used by the Cockpit plugin to sync its profiles and settings between devices. ' +
            'Do not edit it. Change them in Cockpit itself.')
        assert.strictEqual(SETTINGS_NOTE_TITLE, 'Joplin Cockpit Plugin Settings', 'the title a second device searches for')
    })

    await test('settings note: a build/parse round trip returns the profiles and ONLY the settings that travel', () => {
        const store = syncStore(4, [syncProfile(3, 'Zeta'), syncProfile(1, 'Alpha')])
        const body = syncBody(store, { themeMode: 'nord', customCss: '.cockpit{}', showToolbarButton: 'true', customFontSize: '20', madeUp: 'x' })
        const parsed = parseSettingsNoteBody(body)
        assert.ok(parsed, 'the note we just wrote parses back')
        assert.deepStrictEqual(parsed.profiles.profiles.map(p => p.name), ['Zeta', 'Alpha'], 'profile order is content and survives')
        assert.strictEqual(parsed.profiles.nextID, 4, 'the id counter travels, so two devices cannot mint the same profile id')
        assert.deepStrictEqual(Object.keys(parsed.settings).sort(), ['customCss', 'themeMode'], 'only the synced keys came back')
        // The per-device settings are the point of the list: a phone and a 27" monitor want different sizes, and the toolbar
        // button is a property of the machine, so neither may cross even when a payload carries them.
        assert.ok(!('showToolbarButton' in parsed.settings), 'a per-device setting never travels')
        assert.ok(!('customFontSize' in parsed.settings), 'nor does a size')
        assert.ok(!('madeUp' in parsed.settings), 'and a key this build does not know is dropped rather than applied')
        // DETERMINISTIC BYTES: the same content in a different key order is the same note, which is what makes "write only
        // when there is something to say" a real no-op rather than a coin flip that re-dirties the note on every warm-up.
        const shuffled = syncStore(4, [
            Object.fromEntries(Object.entries(syncProfile(3, 'Zeta')).reverse()),
            Object.fromEntries(Object.entries(syncProfile(1, 'Alpha')).reverse()),
        ])
        assert.strictEqual(syncBody(shuffled, { customCss: '.cockpit{}', themeMode: 'nord' }), body, 'key order cannot change the bytes')
    })

    await test('settings note: a body that cannot be soundly read parses to null rather than throwing', () => {
        for (const [label, body] of [
            ['no fence at all', 'Just something a user typed.'],
            ['a fence with broken JSON', 'Hi\n\n```json\n{ not json\n```\n'],
            ['a fence holding an array', 'Hi\n\n```json\n[1,2,3]\n```\n'],
            ['a future schema version', 'Hi\n\n```json\n{"version":2,"profiles":{"nextID":1,"profiles":[]}}\n```\n'],
            ['an empty body', ''],
        ]) {
            assert.strictEqual(parseSettingsNoteBody(body), null, `${label} yields null`)
        }
        // Only the FUTURE one is refused as data rather than as damage - a build that cannot see a newer build's fields must
        // never write its truncated understanding back over them, whereas a damaged body is simply rewritten wholesale.
        assert.strictEqual(isFutureSettingsNote('Hi\n\n```json\n{"version":2}\n```\n'), true)
        assert.strictEqual(isFutureSettingsNote('Hi\n\n```json\n{"version":1}\n```\n'), false)
        assert.strictEqual(isFutureSettingsNote('Hi\n\n```json\n{ not json\n```\n'), false, 'damage is not the future')
        assert.strictEqual(isFutureSettingsNote(''), false)
    })

    await test('settings note: the loop-prevention key ignores updatedAt, version and key order, not content', () => {
        const content = { profiles: syncStore(3, [syncProfile(1, 'Alpha'), syncProfile(2, 'Beta')]), settings: { themeMode: 'nord', customCss: '' } }
        const key = settingsContentKey(content)
        // THE PING-PONG GUARD. Applying a body replaces the profile store and writes settings, each of which schedules a write;
        // if the timestamp were part of the key that write would differ from what was just applied, and two devices would
        // rewrite the note at each other every few seconds forever with the content never changing.
        const later = parseSettingsNoteBody(syncBody(content.profiles, content.settings, '2099-12-31T23:59:59.000Z'))
        assert.strictEqual(settingsContentKey(later), key, 'a different updatedAt is the SAME content')
        assert.strictEqual(settingsContentKey({ profiles: content.profiles, settings: { customCss: '', themeMode: 'nord' } }), key,
            'setting key order is not content')
        // ...and every part of the content DOES move it.
        assert.notStrictEqual(settingsContentKey({ profiles: content.profiles, settings: { themeMode: 'dark', customCss: '' } }), key,
            'a changed theme is a change')
        assert.notStrictEqual(settingsContentKey({ profiles: syncStore(3, [syncProfile(1, 'Alpha')]), settings: content.settings }), key,
            'a deleted profile is a change')
        assert.notStrictEqual(settingsContentKey({ profiles: syncStore(3, [syncProfile(1, 'Renamed'), syncProfile(2, 'Beta')]), settings: content.settings }), key,
            'a renamed profile is a change')
        assert.notStrictEqual(settingsContentKey({ profiles: syncStore(9, content.profiles.profiles), settings: content.settings }), key,
            'the id counter is content too')
    })

    await test('settings note: the reference setting reads an id in four spellings, and anything else as a title', () => {
        for (const typed of [
            SYNC_NOTE_ID,
            `:/${SYNC_NOTE_ID}`,
            `[Joplin Cockpit Plugin Settings](:/${SYNC_NOTE_ID})`,
            `joplin://x-callback-url/openNote?id=${SYNC_NOTE_ID}`,
        ]) {
            const reference = parseSettingsNoteReference(typed)
            assert.strictEqual(reference.kind, 'id', `"${typed}" names an id`)
            assert.strictEqual(reference.id, SYNC_NOTE_ID, `"${typed}" names THAT id`)
            assert.deepStrictEqual(parseSettingsNoteReference(`  ${typed}  `), reference, 'and surrounding whitespace is trimmed off')
        }
        assert.deepStrictEqual(parseSettingsNoteReference(''), { kind: 'empty', id: '', title: '' }, 'empty turns the feature off')
        assert.strictEqual(parseSettingsNoteReference('   ').kind, 'empty', 'and so does whitespace')
        const byTitle = parseSettingsNoteReference(`  ${SETTINGS_NOTE_TITLE}  `)
        assert.strictEqual(byTitle.kind, 'title', 'anything else is a title - which is how a phone connects')
        assert.strictEqual(byTitle.title, SETTINGS_NOTE_TITLE)
        // A near-miss id is a TITLE, so it fails as "no note of that name" rather than as a silent point at nothing.
        assert.strictEqual(parseSettingsNoteReference(SYNC_NOTE_ID.slice(1)).kind, 'title', 'a 31-character id is not an id')
    })

    await test('settings note: the display form is read as a display reference, and its two implementations agree', () => {
        // The sixth spelling, and the one the field holds most of the time: what Cockpit itself wrote there.
        const shown = SettingsNote.settingsNoteDisplay(SETTINGS_NOTE_TITLE, SYNC_NOTE_ID)
        assert.strictEqual(shown, `Joplin Cockpit Plugin Settings (${SYNC_NOTE_ID})`, 'name, a space, and the WHOLE id')
        assert.deepStrictEqual(parseSettingsNoteReference(shown),
            { kind: 'display', id: SYNC_NOTE_ID, title: SETTINGS_NOTE_TITLE }, 'and it reads back as both halves')
        // ...and what 2.6.1 wrote is still read back as a display form, which is what lets an existing field migrate.
        assert.deepStrictEqual(parseSettingsNoteReference('Joplin Cockpit Plugin Settings (11111111)'),
            { kind: 'display', id: '11111111', title: SETTINGS_NOTE_TITLE }, 'the short form 2.6.1 wrote still reads as both halves')
        assert.deepStrictEqual(parseSettingsNoteReference(`  ${shown}  `), parseSettingsNoteReference(shown), 'whitespace is trimmed off it too')
        // The five older spellings are untouched by it: a Markdown link ends in a bracket as well, and must still be an id.
        assert.strictEqual(parseSettingsNoteReference(`[x](:/${SYNC_NOTE_ID})`).kind, 'id', 'a Markdown link is still an id, not a display form')
        assert.strictEqual(parseSettingsNoteReference('Meeting notes (draft)').kind, 'title', 'brackets that are not hex are part of the title')
        assert.strictEqual(parseSettingsNoteReference('Meeting notes (abcd)').kind, 'title', 'and so are brackets too short to be an id')
        // A note whose TITLE ends in a hex word is the one ambiguity there is, and it resolves the same way the notebook
        // field resolves it: the bracketed group is taken as the id, and the title in front of it is what a repoint
        // searches for. There is no map of note ids to check it against, so the stored full id is the check instead.
        assert.deepStrictEqual(parseSettingsNoteReference('Budget (deadbeef)'), { kind: 'display', id: 'deadbeef', title: 'Budget' })
        // THE TWO COPIES. settingsNote.js is loaded in webviews and by the harness on its own, so it cannot require
        // displayId.js and carries its own copy of both functions. Neither may drift from the other.
        for (const id of [
            SYNC_NOTE_ID,
            'abcdef0123456789abcdef0123456789',
            'ABCDEF0123456789ABCDEF0123456789',
            '  abcdef0123456789abcdef0123456789  ',
            'abcdef',
            'f1',
            'not-hex',
            '',
        ]) {
            assert.strictEqual(SettingsNote.displayID(id), DisplayID.displayID(id), `displayID("${id}") must mean the same in both copies`)
        }
        for (const text of ['Lab / Joplin (fdfd6c06)', 'Archive (A1B2C3D4)', 'Budget (deadbeef) (c0ffee11)', 'Archive', 'Archive (v2)',
            'Archive (abcd)', '(deadbeef)', '', 'Archive(deadbeef)']) {
            assert.deepStrictEqual(SettingsNote.splitDisplayID(text), DisplayID.splitDisplayID(text),
                `splitDisplayID("${text}") must mean the same in both copies`)
        }
        // ...AND THE SAME COMPARISON OVER SHAPES NOBODY THOUGHT OF. The list above only pins what someone wrote down; a
        // duplicated function drifts in the case that was never written down. So the two copies are also run against a few
        // thousand generated ids and texts - from a SEEDED generator (an LCG in exact 32-bit arithmetic via Math.imul), so
        // this is a fixed set of cases that happens to be large, not a coin flip that fails for one person on a Tuesday.
        let lcg = 20260913 >>> 0
        const nextInt = (bound) => ((lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0) % bound)
        const HEX_CHARS = '0123456789abcdefABCDEF'
        const JUNK_CHARS = 'ghijklmnopqrstuvwxyz -_.()/'
        const pick = (alphabet, length) => {
            let out = ''
            for (let index = 0; index < length; index++) out += alphabet[nextInt(alphabet.length)]
            return out
        }
        // A generated id: mostly real-shaped (32 hex), with the near misses that decide the refusals - too short, too long,
        // exactly six, and outright junk. Retargeted at displayID when the lengthening rule went: the decision left in the
        // function is the REFUSAL (is this 6-32 hex at all?) plus the trimming and lower-casing around it.
        // Surrounding whitespace is generated on purpose: trimming and lower-casing are normalisation the two copies each do
        // for themselves, and a drift there is invisible to any case written out by hand (nobody writes " abcdef01 ").
        const padded = (text) => `${pick(' ', nextInt(2))}${text}${pick(' ', nextInt(2))}`
        const someID = () => {
            switch (nextInt(7)){
                case 0: return pick(HEX_CHARS, 32)
                case 1: return pick(HEX_CHARS, 1 + nextInt(7))
                case 2: return pick(HEX_CHARS, 6)
                case 3: return pick(HEX_CHARS, 8 + nextInt(26))
                case 4: return pick(HEX_CHARS + JUNK_CHARS, 1 + nextInt(34))
                case 5: return padded(pick(HEX_CHARS, 6 + nextInt(27)))
                default: return pick(HEX_CHARS, 32)
            }
        }
        let fuzzed = 0
        for (let round = 0; round < 3000; round++){
            const id = someID()
            assert.strictEqual(SettingsNote.displayID(id), DisplayID.displayID(id),
                `displayID(${JSON.stringify(id)}) must mean the same in both copies`)
            // The split, over names and bracketed groups built from the same alphabets, with and without the bracket.
            const name = pick(HEX_CHARS + JUNK_CHARS, nextInt(12))
            const text = padded(nextInt(2) ? `${name}${pick(' ', nextInt(3))}(${someID()})` : name)
            assert.deepStrictEqual(SettingsNote.splitDisplayID(text), DisplayID.splitDisplayID(text),
                `splitDisplayID(${JSON.stringify(text)}) must mean the same in both copies`)
            fuzzed++
        }
        assert.strictEqual(fuzzed, 3000, 'the generated cases must actually have run')
    })

    // ---- OFF: the whole feature is opt-in, and an install that never opts in must pay nothing for it ----------------
    const syncOffState = await runSync('off', {
        initialSettings: { profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])), currentProfileID: 1 },
    })

    await test('settings note OFF: startup, a profile edit and a theme change touch no note and schedule nothing', async () => {
        assert.strictEqual(syncOffState.settings.settingsNoteId, '', 'the feature ships off, and stays off until a user fills it in')
        assert.deepStrictEqual(syncOffState.workspaceEvents.slice().sort(),
            ['onNoteAlarmTrigger', 'onNoteChange', 'onNoteSelectionChange', 'onSyncComplete', 'onSyncStart'],
            'exactly the subscriptions Cockpit always had - the feature adds none')
        assert.strictEqual(syncGets(syncOffState).length, 0, 'startup reads no settings note and searches for none')
        assert.deepStrictEqual(syncOffState.pendingTimeouts(3000), [], 'and arms no debounced write')
        const mark = syncOffState.timeouts.length
        await syncOffState.panelMessageHandler(['profileSaved', 1, { ...baseProfile, name: 'Renamed' }])
        await syncOffState.withTimers(() => syncOffState.setSetting('themeMode', 'nord'))
        assert.deepStrictEqual(syncOffState.timeouts.filter((t, index) => index >= mark && t.ms === 3000), [],
            'a local change to synced state schedules nothing while there is no note to write to')
        await syncOffState.syncCompleteHandler({})
        await syncOffState.noteSelectionHandler({ value: [SYNC_NOTE_ID] })
        await syncOffState.noteChangeHandler({ id: SYNC_NOTE_ID })
        assert.strictEqual(syncGets(syncOffState).length, 0, 'and neither does a sync, a selection change or a note change')
        assert.strictEqual(syncOffState.notePuts.length, 0, 'no note is written')
        assert.deepStrictEqual(syncOffState.dataPosts, [], 'and none is created')
    })

    // ---- ON: a configured note owns the profiles and the synced settings --------------------------------------------
    const syncOnState = await runSync('on', {
        notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings({ themeMode: 'nord', customCss: '.cockpit{}' }))) },
        initialSettings: {
            settingsNoteId: SYNC_NOTE_ID,
            profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
            currentProfileID: 1,
            showToolbarButton: true,
            themeMode: 'matchJoplin',
        },
    })

    await test('settings note: a configured note replaces the profiles at startup, and writes only the settings that travel', () => {
        assert.deepStrictEqual(syncProfileNames(syncOnState), ['From the laptop'], 'the store is REPLACED wholesale, never merged')
        assert.strictEqual(syncOnState.settings.themeMode, 'nord', 'a synced setting is applied')
        assert.strictEqual(syncOnState.settings.customCss, '.cockpit{}')
        // The profile this device had selected does not exist in the incoming store, so the first one becomes current - which is
        // a PER-DEVICE choice, written here and never carried in the note.
        assert.strictEqual(syncOnState.settings.currentProfileID, 2, 'a vanished current profile falls back to the first one')
        assert.strictEqual(syncOnState.settings.showToolbarButton, true, 'a per-device setting is left exactly as it was')
        // The two reference keys are written here because this fixture is an install made BEFORE the field showed an id: its field holds a
        // bare id, which resolves, fills the hidden full id and rewrites the field to the display form. That migration has its own check.
        const allowed = new Set([...SYNCED_SETTING_KEYS, 'profileData', 'currentProfileID', 'settingsNoteId', 'settingsNoteResolvedId'])
        const strays = syncOnState.settingWrites.map(w => w.key).filter(key => !allowed.has(key))
        assert.deepStrictEqual(strays, [], 'nothing outside the synced list (plus the store and the local current profile) was written')
        assert.ok(syncOnState.panelHtml['panel-panel'].includes('From the laptop'), 'and the very first paint already shows it')
    })

    await test('settings note: the flush that follows an apply writes NOTHING - the loop-prevention proof', async () => {
        // A WRITE REALLY IS PENDING FIRST, so this cannot pass by there being nothing to flush: the apply replaced the profile
        // store, which notifies the sync module, which arms the 3 s debounce like any other local change.
        assert.strictEqual(syncOnState.pendingTimeouts(3000).length, 1, 'the apply armed a write, as every store change does')
        // The device set the applied content key before applying, so that write already sees itself as redundant. Drained here
        // through the editor-selection drain point, which performs no read of its own.
        await syncOnState.noteSelectionHandler({ value: ['9'.repeat(32)] })
        assert.strictEqual(syncOnState.notePuts.length, 0, 'this device recognised its own applied state and said nothing back')
        assert.deepStrictEqual(syncOnState.pendingTimeouts(3000), [], 'and the drained write took its timer with it')
    })

    await test('settings note: a local profile edit reaches the note after the 3 s debounce, in exactly one write', async () => {
        const mark = syncOnState.timeouts.length
        await syncOnState.panelMessageHandler(['profileSaved', 2, { ...baseProfile, name: 'Edited here' }])
        const armed = armedSyncWrite(syncOnState, mark)
        assert.strictEqual(syncOnState.notePuts.length, 0, 'and nothing is written before the debounce fires')
        await syncOnState.fireTimeout(armed)
        assert.strictEqual(syncOnState.notePuts.length, 1, 'exactly one write')
        assert.strictEqual(syncOnState.notePuts[0].id, SYNC_NOTE_ID, 'to the configured note')
        const written = parseSettingsNoteBody(syncOnState.notePuts[0].body)
        assert.ok(written, 'and what it wrote parses back as Cockpit settings')
        assert.deepStrictEqual(written.profiles.profiles.map(p => p.name), ['Edited here'], 'carrying the edited store')
        assert.strictEqual(written.settings.themeMode, 'nord', 'and the synced settings alongside it')
        assert.ok(!('showToolbarButton' in written.settings), 'still with nothing per-device in it')
    })

    await test('settings note: a change made on another device is applied when the sync completes, and answered with silence', async () => {
        syncOnState.notes[SYNC_NOTE_ID].body = syncBody(syncStore(4, [syncProfile(3, 'Made on the phone')]),
            syncSettings({ themeMode: 'oledDark', customCss: '.cockpit{}' }), '2026-09-12T10:00:00.000Z')
        syncOnState.notes[SYNC_NOTE_ID].updated_time = 99
        const putsBefore = syncOnState.notePuts.length
        await syncOnState.syncCompleteHandler({})
        assert.deepStrictEqual(syncProfileNames(syncOnState), ['Made on the phone'], 'the incoming store replaced the local one')
        assert.strictEqual(syncOnState.settings.themeMode, 'oledDark', 'and its settings came with it')
        assert.strictEqual(syncOnState.notePuts.length, putsBefore, 'an applied change is never written back at the sender')
    })

    await test('settings note: a change to the note itself takes the read lane, never the reconcile lane', async () => {
        // The note carries no to-dos, so nothing about it belongs in the panel's index-catch-up job or in the per-note external
        // -change path (which would fetch it as an ordinary note and hand it to the optimistic layer). One short-debounced read.
        syncOnState.notes[SYNC_NOTE_ID].body = syncBody(syncStore(5, [syncProfile(4, 'Third device')]),
            syncSettings({ themeMode: 'oledDark', customCss: '.cockpit{}' }), '2026-09-12T11:00:00.000Z')
        syncOnState.notes[SYNC_NOTE_ID].updated_time = 120
        const mark = syncOnState.timeouts.length
        await syncOnState.noteChangeHandler({ id: SYNC_NOTE_ID })
        const armed = syncOnState.timeouts.filter((t, index) => index >= mark && !t.cleared && !t.fired)
        assert.deepStrictEqual(armed.map(t => t.ms), [1000],
            'exactly one 1 s read - not the reconcile lane\'s five offsets, and not the overview lane\'s debounce')
        await syncOnState.fireTimeout(armed[0])
        assert.deepStrictEqual(syncProfileNames(syncOnState), ['Third device'], 'and the read applied what the note now says')
    })

    await test('settings note: the periodic tick reads ONE field while the note has not moved, and the body only when it has', async () => {
        const state = await runSync('tick', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Steady')]), syncSettings())) },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Steady')])),
                currentProfileID: 1,
            },
        })
        const tick = state.intervals.find(interval => interval.ms === 60000)
        assert.ok(tick, 'the periodic backstop is the 60 s interval')
        const noteReads = () => state.gets.filter(g => g.path[0] === 'notes' && g.path[1] === SYNC_NOTE_ID)
        const quietMark = noteReads().length
        await state.withTimers(() => tick.fn())
        const quiet = noteReads().slice(quietMark)
        assert.strictEqual(quiet.length, 1, 'a tick with nothing to do costs exactly one read of the settings note')
        assert.deepStrictEqual(quiet[0].query.fields, ['updated_time'], 'and it asks for one field, never the body')
        // Now move the note, as a sync from another device would: the same tick fetches the body and applies it.
        state.notes[SYNC_NOTE_ID].body = syncBody(syncStore(3, [syncProfile(2, 'Moved along')]), syncSettings({ themeMode: 'nord' }),
            '2026-09-12T12:00:00.000Z')
        state.notes[SYNC_NOTE_ID].updated_time = 500
        await state.withTimers(() => tick.fn())
        assert.deepStrictEqual(syncProfileNames(state), ['Moved along'], 'a moved note is read in full and applied')
        assert.strictEqual(state.settings.themeMode, 'nord')
    })

    // ---- the two write gates ---------------------------------------------------------------------------------------
    const syncGate1State = await runSync('gate1', {
        notes: {},
        initialSettings: {
            settingsNoteId: SYNC_OTHER_ID,
            profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
            currentProfileID: 1,
        },
    })

    await test('settings note gate 1: a device that has never read the note never writes over it', async () => {
        // The configured note is not in the fixtures at all, which is exactly what a note that has not synced to this device
        // yet looks like. Writing local state into it here is how a machine that has just installed Cockpit would wipe every
        // other device's profiles, so the write is deferred for as long as the read keeps failing.
        assert.strictEqual(syncGate1State.notePuts.length, 0, 'nothing is written at startup')
        const mark = syncGate1State.timeouts.length
        await syncGate1State.panelMessageHandler(['profileSaved', 1, { ...baseProfile, name: 'Changed locally' }])
        await syncGate1State.fireTimeout(armedSyncWrite(syncGate1State, mark))
        assert.strictEqual(syncGate1State.notePuts.length, 0, 'and the local change waits rather than overwriting an unread note')
    })

    const syncGate2State = await runSync('gate2', {
        notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]), syncSettings({ themeMode: 'nord' }))) },
        initialSettings: {
            settingsNoteId: SYNC_NOTE_ID,
            profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
            currentProfileID: 1,
        },
    })

    await test('settings note gate 2: no write while the note is the one open in the editor, and the selection away drains it', async () => {
        await syncGate2State.noteSelectionHandler({ value: [SYNC_NOTE_ID] })
        const putsBefore = syncGate2State.notePuts.length
        await syncGate2State.panelMessageHandler(['profileSaved', 1, { ...baseProfile, name: 'Renamed while open' }])
        // A drain point that WOULD write, if the gate were not holding: a plugin PUT evicts the mobile editor mid-edit.
        await syncGate2State.syncCompleteHandler({})
        assert.strictEqual(syncGate2State.notePuts.length, putsBefore, 'deferred, not cancelled, while the user has the note open')
        await syncGate2State.noteSelectionHandler({ value: ['9'.repeat(32)] })
        assert.strictEqual(syncGate2State.notePuts.length, putsBefore + 1, 'exactly one write the moment the editor moves off it')
        assert.deepStrictEqual(parseSettingsNoteBody(syncGate2State.notePuts[putsBefore].body).profiles.profiles.map(p => p.name),
            ['Renamed while open'], 'and it carries the change that was waiting')
    })

    // ---- the reference setting -------------------------------------------------------------------------------------
    const syncRefNotes = () => ({
        [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the note')]), syncSettings({ themeMode: 'nord' }))),
    })
    const runSyncRef = (name, notes) => runSync(name, {
        notes,
        initialSettings: { profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])), currentProfileID: 1 },
    })

    for (const [label, name, typed] of [
        ['a bare note id', 'ref-bare-id', SYNC_NOTE_ID],
        ['an internal link', 'ref-internal', `:/${SYNC_NOTE_ID}`],
        ['a Markdown link', 'ref-markdown', `[Cockpit settings](:/${SYNC_NOTE_ID})`],
        ['the note\'s exact title', 'ref-title', SETTINGS_NOTE_TITLE],
    ]) {
        await test(`settings note reference: ${label} is rewritten to the note's name and id, and that note is read once`, async () => {
            const state = await runSyncRef(name, syncRefNotes())
            await state.withTimers(() => state.setSetting('settingsNoteId', typed))
            assert.strictEqual(state.settings.settingsNoteId, `Joplin Cockpit Plugin Settings (${SYNC_NOTE_ID})`,
                'the field ends up holding the note\'s name and its WHOLE id - the literal a user reads')
            assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_NOTE_ID,
                'and the full id is kept beside it, out of sight, which is what every read and write of the note uses')
            const reads = state.gets.filter(g => g.path[0] === 'notes' && g.path[1] === SYNC_NOTE_ID &&
                g.query && Array.isArray(g.query.fields) && g.query.fields.includes('body'))
            assert.strictEqual(reads.length, 1, 'the repointed note is read exactly once, not once per rewrite of the field')
            // THE ONE-TIME MERGE, on every route in. The note wins, and the profile only this device had is folded in rather than
            // silently dropped - which is what the command used to do and the field did not.
            assert.deepStrictEqual(syncProfileNames(state), ['From the note', 'Only on this device'],
                'the note\'s profiles, plus this device\'s own, with a fresh id')
            assert.deepStrictEqual(state.dataPosts, [], 'and nothing is created when the note already exists')
            const merged = state.notePuts.filter(put => put.id === SYNC_NOTE_ID)
            assert.strictEqual(merged.length, 1, 'exactly one write: the merged store, so the other devices get the folded-in profile too')
            assert.deepStrictEqual(parseSettingsNoteBody(merged[0].body).profiles.profiles.map(p => p.name),
                ['From the note', 'Only on this device'], 'and it is the merged store that was written')
            // ...and the device is in step afterwards: the periodic tick has nothing to say and nothing to fetch.
            const tick = state.intervals.find(interval => interval.ms === 60000)
            await state.withTimers(() => tick.fn())
            assert.strictEqual(state.notePuts.length, 1, 'the next tick writes nothing - the merge settled the pair')
        })
    }

    // ---- the field shows the note's NAME and its id (2.6.1) --------------------------------------------------------
    // The same refinement as the excluded-notebook field: a setting that holds a reference must say what it points at.
    // The visible field is the user's input AND the display; the full id lives in a hidden setting beside it, because a
    // short id cannot be turned back into a note without scanning every note there is.

    await test('settings note display: an install holding a bare id migrates to name-and-id, and it is not a repoint', async () => {
        // EVERY EXISTING INSTALL IS THIS. The field holds a bare 32-hex id, which still parses as an id, so the first run
        // resolves it, fills the hidden setting and - once the read knows the note's title - rewrites the field. What it
        // must NOT do is look like a fresh connection: a repoint arms the one-time merge, and re-merging on every launch
        // would fold this device's profiles back into the note for ever.
        const state = await runSync('display-migrate', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings())) },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.settings.settingsNoteId, `Joplin Cockpit Plugin Settings (${SYNC_NOTE_ID})`, 'the field now shows the note by name and whole id')
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_NOTE_ID, 'and the full id it was pointing at is kept, out of sight')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop'],
            'the note wins WHOLESALE, as it has since this device first connected - a migration is not a first connection')
        assert.strictEqual(state.notePuts.length, 0, 'so nothing is written back to the note')
        assert.deepStrictEqual(state.dataPosts, [], 'and nothing is created')
        assert.strictEqual(state.settingWrites.filter(w => w.key === 'settingsNoteId').length, 1, 'the field is rewritten exactly once')
    })

    await test('settings note display: a field already holding the display form costs one read and re-arms nothing', async () => {
        // THE COMMON CASE - every startup of a connected device, after the migration above. The id in the field IS the
        // stored full id, so the reference is UNCHANGED: no title search, no repoint, no merge, and not one settings
        // write either.
        const state = await runSync('display-steady', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings())) },
            initialSettings: {
                settingsNoteId: syncDisplayed(SYNC_NOTE_ID),
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the field is left exactly as it stood')
        assert.deepStrictEqual(state.settingWrites.filter(w => w.key === 'settingsNoteId' || w.key === 'settingsNoteResolvedId'), [],
            'and neither half of the reference is written')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop'], 'the note wins wholesale - the merge was NOT re-armed')
        assert.strictEqual(state.notePuts.length, 0, 'nothing is published back')
        assert.deepStrictEqual(state.gets.filter(g => g.path[0] === 'search' && String(g.query && g.query.query || '').includes('title:')), [],
            'and the note is never searched for by name: the stored id already names it')
    })

    await test('settings note display: a field 2.6.1 left holding a SHORT id is the same note, and is rewritten whole', async () => {
        // THE 2.6.1 MIGRATION, and the one that would hurt most to get wrong. Every device set up under 2.6.1 has
        // "Joplin Cockpit Plugin Settings (11111111)" sitting in its field. Those eight characters are still the START of
        // the stored full id, so this is the UNCHANGED path, exactly as before: no title search, no repoint, no re-merge
        // and no PUT. Counting it as a repoint would fold every 2.6.1 user's profiles back into their note on first launch.
        const state = await runSync('display-short-migrate', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings())) },
            initialSettings: {
                settingsNoteId: 'Joplin Cockpit Plugin Settings (11111111)',
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the field is rewritten to the whole id')
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_NOTE_ID, 'and the stored id it always named is untouched')
        assert.deepStrictEqual(state.settingWrites.filter(w => w.key === 'settingsNoteResolvedId'), [],
            'the hidden half is not written at all - nothing moved')
        assert.strictEqual(state.settingWrites.filter(w => w.key === 'settingsNoteId').length, 1, 'and the visible half exactly once')
        assert.deepStrictEqual(state.gets.filter(g => g.path[0] === 'search' && String(g.query && g.query.query || '').includes('title:')), [],
            'the note is never searched for by name - it was never lost')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop'],
            'the note wins WHOLESALE: this is not a first connection, so the one-time merge did not run again')
        assert.strictEqual(state.notePuts.length, 0, 'and nothing is published back')
        assert.deepStrictEqual(state.dataPosts, [], 'nor is a second note created')
    })

    await test('settings note display: the shown name follows the note when the note is renamed', async () => {
        const state = await runSync('display-rename', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings())) },
            initialSettings: {
                settingsNoteId: syncDisplayed(SYNC_NOTE_ID),
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(3, [syncProfile(2, 'From the laptop')])),
                currentProfileID: 2,
            },
        })
        // The read already fetches the title (it is the guard that refuses to write over a note that is not ours), so the
        // rename costs nothing extra to notice.
        state.notes[SYNC_NOTE_ID].title = 'Our shared Cockpit settings'
        state.notes[SYNC_NOTE_ID].updated_time = 99
        await state.withTimers(() => state.syncCompleteHandler({}))
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID, 'Our shared Cockpit settings'), 'the shown name catches up with the note')
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_NOTE_ID, 'the id behind it is untouched - the note did not move')
        assert.strictEqual(state.notePuts.length, 0, 'a rename is not news to publish')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop'], 'nor is it a first connection')
    })

    await test('settings note display: an EDITED display form is resolved from scratch and repoints properly', async () => {
        // The other half of the rule: a short id that is not the start of the stored one means the user typed something
        // else, or pasted another device's text. Then the title in front of it is all there is to go on, and it takes the
        // ordinary title path - search, repoint, one-time merge.
        const state = await runSync('display-repoint', {
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]), syncSettings())),
                [SYNC_OTHER_ID]: { id: SYNC_OTHER_ID, title: OWN_TITLE, updated_time: 4,
                    body: syncBody(syncStore(3, [syncProfile(2, 'On the other note')]), syncSettings()) },
            },
            initialSettings: {
                settingsNoteId: syncDisplayed(SYNC_NOTE_ID),
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', `${OWN_TITLE} (22222222)`))
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_OTHER_ID, 'the reference now names the other note')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_OTHER_ID, OWN_TITLE), 'and the field shows that note by name and id')
        assert.deepStrictEqual(syncProfileNames(state), ['On the other note', 'Shared'],
            'pointing at a different note is a first connection to it, so this device\'s own profile is folded in')
    })

    await test('settings note display: another device\'s display form NEVER creates a second note - it waits for that one', async () => {
        // THE PASTE THE README INVITES. A user reads device 1's field, types "Joplin Cockpit Plugin Settings (<its id>)" into device 2
        // before the note has synced down, and the canonical title is sitting right there inside it. Creating for that would hand them a
        // second mailbox and two devices talking past each other in silence - the very outcome the typed-title guard exists to refuse.
        // A display form is text COCKPIT wrote on some device, so it always means "this note exists somewhere": it waits.
        const state = await runSync('display-no-create', {
            notes: {},
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', syncDisplayed(SYNC_NOTE_ID)))
        assert.deepStrictEqual(state.dataPosts, [], 'nothing is created for a display form, canonical title inside it or not')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the field is left exactly as pasted')
        assert.strictEqual(state.settings.settingsNoteResolvedId, '', 'and nothing is pointed at')
        assert.ok(state.panelMessages.some(m => m[0] === 'panelToast' && /no note titled/i.test(String(m[1]))),
            'the user is told it was not found - which is true, and tells them to wait for the sync')
        // ...and the promise that notice makes is kept: the retry is armed, so the note arriving with a sync connects it.
        state.notes[SYNC_NOTE_ID] = syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings()))
        await state.withTimers(() => state.syncCompleteHandler({}))
        assert.deepStrictEqual(state.dataPosts, [], 'still nothing created')
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_NOTE_ID, 'the retry found the note the paste was always naming')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'and the field now shows it')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop', 'Only on this device'],
            'connecting to it is this device\'s first connection, so its own profile is folded in - exactly once')
        const merged = state.notePuts.filter(put => put.id === SYNC_NOTE_ID)
        assert.strictEqual(merged.length, 1, 'one write, carrying the merged store')
    })

    await test('settings note display: a note whose own title ends in a hex word is still connected to by that title', async () => {
        // The price of splitting a display form on faith: there is no map of note ids to check the brackets against, so a note a
        // user really called "Cockpit Settings (20240101)" has had part of its name eaten - digits are hex. The name half finds
        // nothing, so the WHOLE text is tried once as the title it turns out to be. Same for (123456), (decade), (facade), (abc123).
        const oddTitle = 'Cockpit Settings (20240101)'
        const state = await runSync('display-hex-title', {
            notes: {
                [SYNC_NOTE_ID]: { id: SYNC_NOTE_ID, title: oddTitle, updated_time: 10,
                    body: syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings()) },
            },
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', oddTitle))
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_NOTE_ID, 'the note of that exact name is what was connected to')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID, oddTitle),
            'and the field shows it by its whole name, with its own short id added')
        assert.deepStrictEqual(state.dataPosts, [], 'nothing is created - the note was there all along')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop', 'Only on this device'], 'and it is connected to, merge and all')
    })

    await test('settings note display: the text the user TYPED wins over the guess that the brackets were an id', async () => {
        // THE ORDER OF THE TWO LOOKUPS IS THE WHOLE RULE. With both "Cockpit Settings" and "Cockpit Settings (20240101)" in
        // the vault, asking the name half first matches the PLAIN note - so a user who typed the MORE specific title was
        // connected to the LESS specific one, had their own text rewritten to it, and had this device's profiles merged into
        // a mailbox they never named. The literal text is searched first; the guess that Cockpit wrote those brackets is only
        // the fallback.
        const oddTitle = 'Cockpit Settings (20240101)'
        const state = await runSync('display-order', {
            notes: {
                [SYNC_NOTE_ID]: { id: SYNC_NOTE_ID, title: 'Cockpit Settings', updated_time: 10,
                    body: syncBody(syncStore(3, [syncProfile(2, 'The plain note')]), syncSettings()) },
                [SYNC_OTHER_ID]: { id: SYNC_OTHER_ID, title: oddTitle, updated_time: 11,
                    body: syncBody(syncStore(3, [syncProfile(2, 'The bracketed note')]), syncSettings()) },
            },
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', oddTitle))
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_OTHER_ID, 'the note the user actually named is the one connected to')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_OTHER_ID, oddTitle), 'and the field still shows that name, not the plain one')
        assert.deepStrictEqual(syncProfileNames(state), ['The bracketed note', 'Only on this device'], 'the merge went into that note')
        assert.deepStrictEqual(state.notePuts.map(put => put.id), [SYNC_OTHER_ID], 'and nothing at all was written to the note the user did not name')
        // The literal text answered, so the name half was never asked: one lookup, not two.
        const titleQueries = state.gets.filter(g => g.path[0] === 'search' && /^title:/.test(String((g.query && g.query.query) || '')))
            .map(g => String(g.query.query))
        assert.deepStrictEqual(titleQueries, [`title:"cockpit settings (20240101)"`], 'the text as typed is what was searched for')
    })

    await test('settings note display: the name half is still the fallback when the literal text names nothing', async () => {
        // The other side of the order: the bracketed group really was an id Cockpit wrote, and no note carries the whole
        // string. The name half then answers, exactly as it did before the order was fixed - two lookups, in that order.
        const state = await runSync('display-order-fallback', {
            notes: {
                [SYNC_NOTE_ID]: { id: SYNC_NOTE_ID, title: 'Cockpit Settings', updated_time: 10,
                    body: syncBody(syncStore(3, [syncProfile(2, 'The plain note')]), syncSettings()) },
            },
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', 'Cockpit Settings (20240101)'))
        assert.strictEqual(state.settings.settingsNoteResolvedId, SYNC_NOTE_ID, 'the name half found the note the brackets were hiding')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID, 'Cockpit Settings'), 'and the field shows that note')
        const titleQueries = state.gets.filter(g => g.path[0] === 'search' && /^title:/.test(String((g.query && g.query.query) || '')))
            .map(g => String(g.query.query))
        assert.deepStrictEqual(titleQueries, [`title:"cockpit settings (20240101)"`, `title:"cockpit settings"`],
            'the literal text first, the name half only because it found nothing')
        assert.deepStrictEqual(state.dataPosts, [], 'and a display form still never creates')
    })

    await test('settings note reference: an ambiguous title is left exactly as typed, and nothing is read or written', async () => {
        const notes = syncRefNotes()
        notes[SYNC_OTHER_ID] = { id: SYNC_OTHER_ID, title: SETTINGS_NOTE_TITLE, body: '', updated_time: 4 }
        const state = await runSyncRef('ref-ambiguous', notes)
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        assert.strictEqual(state.settings.settingsNoteId, SETTINGS_NOTE_TITLE, 'the user is left looking at what they typed')
        assert.deepStrictEqual(syncProfileNames(state), ['Only on this device'], 'neither candidate was applied')
        assert.strictEqual(state.notePuts.length, 0, 'and neither was written')
        // Nor is a third one made. The canonical title creates a note only when there is NO note of that name; two candidates
        // is the one case where guessing is worse than doing nothing.
        assert.deepStrictEqual(state.dataPosts, [], 'and no note is created to break the tie')
        assert.strictEqual(state.settingWrites.filter(w => w.key === 'settingsNoteId').length, 1,
            'the only write of the field is the user\'s own - the plugin does not rewrite it')
        const notices = state.panelMessages.filter(m => m[0] === 'panelToast' && /several notes/i.test(String(m[1])))
        assert.strictEqual(notices.length, 1, 'the user is told once, in the panel toast - never a blocking message box')
    })

    await test('settings note: connecting from the Settings field to a note that already holds every local profile writes nothing', async () => {
        // The quiet half of the one rule: the merge appends only names the note is missing, so a device whose profiles the note already
        // carries connects without giving it a revision for nothing. Same guarantee the command path has had since the review.
        const store = syncStore(2, [syncProfile(1, 'Shared')])
        const state = await runSync('field-quiet', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(store, syncSettings())) },
            initialSettings: { profileData: JSON.stringify(store), currentProfileID: 1 },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the field holds the note\'s name and id')
        assert.deepStrictEqual(syncProfileNames(state), ['Shared'], 'the store is the note\'s, unchanged')
        assert.strictEqual(state.notePuts.length, 0, 'and the note is not written at all')
        assert.deepStrictEqual(state.dataPosts, [], 'nor is a second one created')
    })

    await test('settings note: after the first connection the note wins wholesale - a profile deleted elsewhere disappears here', async () => {
        // The merge is ONE-TIME. If it ran on every read, a profile deleted on another device would be resurrected by this one on the
        // next sync and written straight back, and nothing could ever be deleted anywhere.
        const state = await runSyncRef('after-adoption', syncRefNotes())
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        assert.deepStrictEqual(syncProfileNames(state), ['From the note', 'Only on this device'], 'precondition: the merge ran')
        const putsAfterMerge = state.notePuts.length
        // Another device now deletes the profile this one contributed, and the note arrives saying so.
        state.notes[SYNC_NOTE_ID].body = syncBody(syncStore(3, [syncProfile(2, 'From the note')]),
            syncSettings({ themeMode: 'nord' }), '2026-09-12T12:00:00.000Z')
        state.notes[SYNC_NOTE_ID].updated_time = 400
        await state.syncCompleteHandler({})
        assert.deepStrictEqual(syncProfileNames(state), ['From the note'], 'the deletion is honoured - no second merge resurrects it')
        assert.strictEqual(state.notePuts.length, putsAfterMerge, 'and nothing is written back')
    })

    // ---- the Settings field IS the setup UI (2.6.0, owner's first live round) -----------------------------------------
    await test('settings note: typing the canonical title with no such note creates it, from the Settings field alone', async () => {
        const state = await runSync('field-create', {
            notes: {},
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        const storeBefore = state.settings.profileData
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        const posted = state.dataPosts.filter(p => p.path[0] === 'notes')
        assert.strictEqual(posted.length, 1, 'exactly one note was created - no menu item, no command, just the field')
        assert.strictEqual(posted[0].body.title, SETTINGS_NOTE_TITLE, 'titled exactly as the next device will search for it')
        assert.strictEqual(posted[0].body.parent_id, 'folder-1', 'in the notebook the user is looking at')
        const payload = parseSettingsNoteBody(posted[0].body.body)
        assert.ok(payload, 'the created note parses as Cockpit settings')
        assert.deepStrictEqual(payload.profiles.profiles.map(p => p.name), ['Only on this device'], 'seeded from this device, never empty')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed('0'.repeat(31) + '1'), 'and the field is rewritten from the title to the new note')
        // The same no-self-apply guarantee the command has: the seed's content key is remembered before the field is written, so
        // the read the repoint starts recognises this device's own handwriting instead of applying it back wholesale.
        assert.strictEqual(state.settings.profileData, storeBefore, 'the store is untouched by reading back what we just wrote')
        assert.strictEqual(state.notePuts.length, 0, 'and the seed is not written a second time')
        assert.ok(state.panelMessages.some(m => m[0] === 'panelToast' && /settings note created/i.test(String(m[1]))), 'the user is told')
    })

    await test('settings note: a title that is NOT the canonical one never creates a note, whatever else it does', async () => {
        // The guard that keeps a typo from becoming a second mailbox. "Team Cockpit Settings" matches nothing here, and the answer
        // is the same as it has always been: leave the field as typed, say so once, and try again when a sync completes.
        const state = await runSync('field-other-title', {
            notes: {},
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', OWN_TITLE))
        assert.deepStrictEqual(state.dataPosts, [], 'nothing is created for a title that is not the note\'s own name')
        assert.strictEqual(state.settings.settingsNoteId, OWN_TITLE, 'the field is left exactly as typed')
        assert.ok(state.panelMessages.some(m => m[0] === 'panelToast' && /no note titled/i.test(String(m[1]))), 'and the user is told')
        // The silent retry is unchanged: the note arrives with a sync, and THAT is what connects it.
        state.notes[SYNC_NOTE_ID] = Object.assign(syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]),
            syncSettings())), { title: OWN_TITLE })
        await state.syncCompleteHandler({})
        assert.deepStrictEqual(state.dataPosts, [], 'still nothing created')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID, OWN_TITLE), 'the retry found the note and filled the field in')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop', 'Only on this device'],
            'and connected to it - which, being this device\'s first connection to that note, folds its own profile in')
    })

    // ---- the search index is not live, and the note must be found anyway ----------------------------------------------
    // Joplin's FTS index is rebuilt by SearchEngine.syncTables() on a fixed 10s timer after notes change, and once at app
    // start. For up to ten seconds after another device's settings note syncs in - and at startup for notes changed late in
    // the previous session - a title: search answers NOTHING. `titleSearchBlind` models exactly that: the note is in the
    // fixtures, the plain ['notes'] listing serves it, and only the search is blind.
    const titleLookups = (state) => state.gets.filter(g =>
        (g.path[0] === 'search' && g.query && Array.isArray(g.query.fields) && g.query.fields.includes('deleted_time')) ||
        (g.path[0] === 'notes' && g.path.length === 1 && g.query && Array.isArray(g.query.fields) && g.query.fields.includes('deleted_time')))

    await test('settings note: a note the search index has not caught up with is connected to, not duplicated', async () => {
        const state = await runSync('blind-canonical', {
            titleSearchBlind: true,
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings())) },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        // THE DEFECT THIS PINS: the search said "no such note", so the canonical branch created a SECOND one, the field
        // pointed at the duplicate, and the two devices never converged again.
        assert.deepStrictEqual(state.dataPosts, [], 'no second settings note is created while the index is merely stale')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the field points at the note that already exists')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop', 'Only on this device'], 'and the one-time merge ran')
        const merged = state.notePuts.filter(put => put.id === SYNC_NOTE_ID)
        assert.strictEqual(merged.length, 1, 'exactly once')
    })

    await test('settings note: a non-canonical exact title is found through the stale index too, with no notice', async () => {
        const state = await runSync('blind-own-title', {
            titleSearchBlind: true,
            notes: {
                [SYNC_NOTE_ID]: Object.assign(syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]),
                    syncSettings())), { title: OWN_TITLE }),
            },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', OWN_TITLE))
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID, OWN_TITLE), 'connected at once, not left waiting for the retry')
        assert.deepStrictEqual(state.dataPosts, [], 'and nothing created - a non-canonical title never creates anyway')
        assert.ok(!state.panelMessages.some(m => m[0] === 'panelToast' && /no note titled/i.test(String(m[1]))),
            'and the user is not told the note is missing, because it is not')
    })

    await test('settings note: a trashed note carrying the title is not mistaken for the settings note', async () => {
        const state = await runSync('blind-trashed', {
            titleSearchBlind: true,
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            notes: {
                [SYNC_NOTE_ID]: Object.assign(syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Binned')]), syncSettings())),
                    { deleted_time: 1757000000000 }),
            },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        // The listing serves trashed notes (trashing even bumps updated_time, so they sort to the top); the scan has to drop
        // them itself, exactly as the search half does.
        const posted = state.dataPosts.filter(p => p.path[0] === 'notes')
        assert.strictEqual(posted.length, 1, 'a note in the trash is no note at all, so a fresh one is created')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed('0'.repeat(31) + '1'), 'and the field points at the new one, not the binned one')
        assert.deepStrictEqual(syncProfileNames(state), ['Only on this device'], 'the binned note\'s profiles are not adopted')
    })

    await test('settings note: a device that created its own note says so once when a rival arrives, and then stops looking', async () => {
        const state = await runSync('rival', {
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            notes: {},
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        assert.strictEqual(state.dataPosts.filter(p => p.path[0] === 'notes').length, 1, 'precondition: this device made its own note')
        // The other device's note finally arrives - the user typed the title before the first sync had brought it down, which is
        // the one case no search can protect against, because there was nothing here to find.
        state.notes[SYNC_NOTE_ID] = syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings()))
        const rivalNotices = () => state.panelMessages.filter(m => m[0] === 'panelToast' && /another Cockpit settings note/i.test(String(m[1])))
        for (let round = 0; round < 5; round++) await state.syncCompleteHandler({})
        assert.strictEqual(rivalNotices().length, 1, 'said exactly once across five syncs - a notice, not a nag')
        assert.ok(state.notePuts.every(put => put.id !== SYNC_NOTE_ID), 'and nothing is written to the other device\'s note')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed('0'.repeat(31) + '1'), 'nor is the field repointed - which mailbox to keep is the user\'s call')
    })

    await test('settings note: a device that ADOPTED a note never looks for a rival', async () => {
        const state = await runSync('rival-none', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]), syncSettings())) },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'precondition: connected to the note that already existed')
        const before = titleLookups(state).length
        for (let round = 0; round < 5; round++) await state.syncCompleteHandler({})
        assert.strictEqual(titleLookups(state).length, before,
            'a device that connected to an existing note has nothing to collide with, so it searches for nothing')
    })

    // ---- the command -----------------------------------------------------------------------------------------------
    await test('settings note command: with no note anywhere it creates one, seeded from this device, and connects to it', async () => {
        const state = await runSync('create', {
            notes: {},
            livePostedNotes: true,
            selectedFolder: { id: 'folder-1' },
            initialSettings: { profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])), currentProfileID: 1 },
        })
        const storeBefore = state.settings.profileData
        await state.withTimers(() => executeCommand(state, 'cockpit.connectSettingsNote'))
        const posted = state.dataPosts.filter(p => p.path[0] === 'notes')
        assert.strictEqual(posted.length, 1, 'exactly one note was created')
        assert.strictEqual(posted[0].body.title, SETTINGS_NOTE_TITLE, 'titled exactly as a second device will search for it')
        assert.strictEqual(posted[0].body.parent_id, 'folder-1', 'in the notebook the user is looking at')
        const payload = parseSettingsNoteBody(posted[0].body.body)
        assert.ok(payload, 'the created note parses as Cockpit settings')
        assert.deepStrictEqual(payload.profiles.profiles.map(p => p.name), ['Only on this device'], 'seeded from this device, never empty')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed('0'.repeat(31) + '1'), 'and the setting points at the note that was made')
        // NO SELF-APPLY. The device remembers the seed's own content key, so the read its repoint starts recognises its own
        // handwriting instead of applying it back wholesale - which would throw away anything changed since the POST.
        assert.strictEqual(state.settings.profileData, storeBefore, 'the store is untouched by reading back what we just wrote')
        assert.strictEqual(state.notePuts.length, 0, 'and the seed is not written a second time')
    })

    await test('settings note command: an existing note is adopted, and this device\'s own profiles are folded in by name once', async () => {
        const state = await runSync('adopt', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'Shared')]), syncSettings({ themeMode: 'nord' }))) },
            initialSettings: {
                profileData: JSON.stringify(syncStore(3, [syncProfile(1, 'Shared'), syncProfile(2, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => executeCommand(state, 'cockpit.connectSettingsNote'))
        assert.strictEqual(state.dataPosts.filter(p => p.path[0] === 'notes').length, 0, 'nothing is created when a note already exists')
        const puts = state.notePuts.filter(p => p.id === SYNC_NOTE_ID)
        assert.strictEqual(puts.length, 1, 'exactly one write: the merged store, put back before the setting points at it')
        const payload = parseSettingsNoteBody(puts[0].body)
        // THE ONE-TIME MERGE, and the only merge there is: ongoing sync is wholesale, so a profile deleted elsewhere can vanish.
        assert.deepStrictEqual(payload.profiles.profiles.map(p => p.name), ['Shared', 'Only on this device'],
            'a local-only profile is appended by name; a name the note already carries is not duplicated')
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the setting now points at the adopted note')
        assert.deepStrictEqual(syncProfileNames(state), ['Shared', 'Only on this device'], 'and the merge lands on this device too')
    })

    await test('settings note command: several notes with the title are refused - nothing created, written or connected', async () => {
        const state = await runSync('many', {
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'One')]), syncSettings())),
                [SYNC_OTHER_ID]: { id: SYNC_OTHER_ID, title: SETTINGS_NOTE_TITLE, body: '', updated_time: 4 },
            },
            initialSettings: { profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])), currentProfileID: 1 },
        })
        await state.withTimers(() => executeCommand(state, 'cockpit.connectSettingsNote'))
        assert.deepStrictEqual(state.dataPosts, [], 'guessing which mailbox the user meant is not a thing a plugin may do')
        assert.strictEqual(state.notePuts.length, 0, 'and neither candidate is written')
        assert.strictEqual(state.settings.settingsNoteId, '', 'the setting is left empty')
        assert.ok(state.settingWrites.every(w => w.key !== 'settingsNoteId'), 'it is not even written')
        assert.ok(state.panelMessages.some(m => m[0] === 'panelToast' && /several notes/i.test(String(m[1]))), 'the user is told, in the toast')
    })

    // ---- a payload from a newer Cockpit -----------------------------------------------------------------------------
    await test('settings note: a payload from a newer Cockpit is neither applied nor written over', async () => {
        const futureBody = 'Cockpit\n\n```json\n' + JSON.stringify({
            version: 2,
            updatedAt: '2026-09-12T08:00:00.000Z',
            profiles: { nextID: 3, profiles: [{ id: 2, name: 'From the future' }] },
            settings: { themeMode: 'nord' },
        }, null, 2) + '\n```\n'
        const state = await runSync('future', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(futureBody) },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
                themeMode: 'matchJoplin',
            },
        })
        assert.deepStrictEqual(syncProfileNames(state), ['Only on this device'], 'nothing was applied - a half-read payload is no payload')
        assert.strictEqual(state.settings.themeMode, 'matchJoplin', 'and no setting was taken from it')
        assert.strictEqual(state.notePuts.length, 0, 'nothing was written at startup')
        // ...and, unlike a merely damaged body, it is never rewritten either: this build cannot see the fields it would drop.
        const mark = state.timeouts.length
        await state.panelMessageHandler(['profileSaved', 1, { ...baseProfile, name: 'Changed here' }])
        await state.fireTimeout(armedSyncWrite(state, mark))
        assert.strictEqual(state.notePuts.length, 0, 'a newer build\'s settings are never deleted by an older one')
        assert.strictEqual(state.notes[SYNC_NOTE_ID].body, futureBody, 'the note is byte-for-byte as it was')
    })

    // ---- what the review found ---------------------------------------------------------------------------------------
    // Every check below reproduces a scenario the reviewer drove against the bundle. They are grouped here rather than
    // scattered so the next reader can see, in one place, which promises this feature has already been caught breaking.

    /** Fire the one write a fresh run has armed, insisting there is exactly one. Only valid straight after a run(). */
    const fireArmedSyncWrite = async (state) => {
        const armed = state.pendingTimeouts(3000)
        assert.strictEqual(armed.length, 1, 'the apply must have armed exactly one write')
        await state.fireTimeout(armed[0])
    }

    await test('settings note: a profile field this build does not know is applied, and answered with silence', async () => {
        // CROSS-VERSION PING-PONG, half one. The read side used to key on the RAW payload while the write side keys on the
        // store as normalizeProfileStore leaves it - which drops a field this build has no place for. The two never agreed,
        // so this device answered every payload from a newer Cockpit by writing the field back out, and the newer one put it
        // back, forever. The key is now taken from the store as this device will hold it.
        const state = await runSync('cross-newer', {
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(
                    syncStore(3, [{ ...syncProfile(2, 'From a newer Cockpit'), futureField: 7 }]),
                    syncSettings({ themeMode: 'nord' }))),
            },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        assert.deepStrictEqual(syncProfileNames(state), ['From a newer Cockpit'], 'the payload is still applied')
        assert.ok(!('futureField' in JSON.parse(state.settings.profileData).profiles[0]),
            'and the field this build has no place for is dropped, as every profile read here is')
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 0, 'but the device does not answer by stripping that field out of the note')
        await state.syncCompleteHandler({})
        assert.strictEqual(state.notePuts.length, 0, 'nor on the next sync, which is where the cycle used to restart')
    })

    await test('settings note: a profile field a payload leaves out takes this build\'s default, and is answered with silence', async () => {
        // CROSS-VERSION PING-PONG, half two: the same disagreement from the other side. The payload has no maxDotsPerDay,
        // normalizeProfileStore fills in 4, and the device used to publish that completed form straight back.
        const partial = syncProfile(2, 'From an older Cockpit')
        delete partial.maxDotsPerDay
        const state = await runSync('cross-older', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [partial]), syncSettings({ themeMode: 'nord' }))) },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [{ ...syncProfile(1, 'Only on this device'), maxDotsPerDay: 9 }])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(JSON.parse(state.settings.profileData).profiles[0].maxDotsPerDay, 4,
            'the missing field takes this build\'s default, which is what normalizeProfileStore is for')
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 0, 'and the completed form is not published back')
        await state.syncCompleteHandler({})
        assert.strictEqual(state.notePuts.length, 0, 'nor on the next sync - the pair has stopped cycling')
    })

    await test('settings note command: adoption gives an appended profile an id the adopted store does not already use', async () => {
        // A payload with NO nextID - an older or hand-made note. The merge used to start the counter at 1 and hand the
        // appended profile an id the note already carried, so the store came out as ids 1, 2, 1.
        const noCounter = 'Cockpit\n\n```json\n' + JSON.stringify({
            version: 1,
            updatedAt: '2026-09-12T08:00:00.000Z',
            profiles: { profiles: [syncProfile(1, 'Shared'), syncProfile(2, 'Also theirs')] },
            settings: syncSettings(),
        }, null, 2) + '\n```\n'
        const state = await runSync('merge-ids', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(noCounter) },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => executeCommand(state, 'cockpit.connectSettingsNote'))
        const stored = JSON.parse(state.settings.profileData).profiles
        assert.deepStrictEqual(stored.map(p => p.name), ['Shared', 'Also theirs', 'Only on this device'], 'the local-only profile is appended')
        const ids = stored.map(p => p.id)
        assert.strictEqual(new Set(ids).size, ids.length, `every profile id must be distinct, got ${JSON.stringify(ids)}`)
    })

    await test('settings note: an excluded notebook this device cannot see yet is kept, not published away', async () => {
        // The exclusion pair travels as ids AND names, and notebook ids are the same on every device. A device that has not
        // synced the notebook yet resolves the name to nothing - and publishing THAT back deletes the exclusion everywhere,
        // for good. While a settings note is connected, an id whose notebook is not in the map is now kept.
        const state = await runSync('exclusion-on', {
            folders: [{ id: 'f1', title: 'Family' }],
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]),
                    syncSettings({ excludedNotebookIds: 'f1,f2', excludedNotebooks: 'Family, Work' }))),
            },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.settings.excludedNotebookIds, 'f1,f2', 'the id of the notebook that has not arrived is kept')
        assert.strictEqual(state.settings.excludedNotebooks, 'Family, Work', 'and so is the name it came with')
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 0, 'so the pair is byte-identical to the payload and there is nothing to say back')
    })

    await test('settings note: the folder poll does not tidy away an excluded notebook that has not arrived yet', async () => {
        // The second route to the same deletion: panel.ts reconciles the visible names from the stored ids whenever a
        // notebook changes anywhere, and used to drop every id it could not see while doing it.
        const folders = [{ id: 'f1', title: 'Family' }]
        const state = await runSync('exclusion-poll-on', {
            folders,
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]),
                    syncSettings({ excludedNotebookIds: 'f1,f2', excludedNotebooks: 'Family, Work' }))),
            },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            },
        })
        const poll = state.intervals.find(interval => interval.ms === 3000)
        assert.ok(poll, 'the folder poll is the 3 s interval')
        await state.withTimers(() => poll.fn())          // the first poll only records the baseline
        folders.push({ id: 'f3', title: 'Something else' })
        await state.withTimers(() => poll.fn())          // ...and now a real notebook change
        assert.strictEqual(state.settings.excludedNotebookIds, 'f1,f2', 'the unseen id survives a notebook change')
        assert.strictEqual(state.settings.excludedNotebooks, 'Family, Work', 'and the names field is left alone with it')
        assert.strictEqual(state.notePuts.length, 0, 'nothing is published back')
    })

    await test('settings note off: a deleted excluded notebook is still tidied out of the pair, exactly as before', async () => {
        const folders = [{ id: 'f1', title: 'Family' }]
        const state = await runSync('exclusion-off', {
            folders,
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
                excludedNotebookIds: 'f1,f2',
                excludedNotebooks: 'Family, Work',
            },
        })
        const poll = state.intervals.find(interval => interval.ms === 3000)
        await state.withTimers(() => poll.fn())
        folders.push({ id: 'f3', title: 'Something else' })
        await state.withTimers(() => poll.fn())
        // With no note carrying the pair between devices, an id that resolves to nothing means what it always meant: the
        // notebook is gone. Keeping it would be hoarding.
        assert.strictEqual(state.settings.excludedNotebookIds, 'f1', 'the folder poll drops it as it always did')
        await state.withTimers(() => state.setSetting('excludedNotebooks', 'Family, Work'))
        assert.strictEqual(state.settings.excludedNotebookIds, 'f1', 'and so does the settings resolver')
    })

    await test('settings note: an excluded notebook this device cannot see yet survives the NAME-AND-ID display too', async () => {
        // The 2.6.0 data-loss rule, restated against the text 2.6.1 writes. An entry whose notebook is in the map is
        // rebuilt as "Name (id)"; an entry whose notebook is NOT - because this device has not synced it yet - has no
        // label to rebuild and no id to show, so it must come through EXACTLY as it stands rather than be regenerated
        // or dropped. Both halves of the pair therefore arrive byte-identical and there is nothing to write at all.
        const seenId = 'a1b2c3d4' + '0'.repeat(24)
        const unseenId = 'b9b9b9b9' + '0'.repeat(24)
        const state = await runSync('exclusion-display-on', {
            folders: [{ id: seenId, title: 'Family' }],
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]),
                    syncSettings({ excludedNotebookIds: `${seenId},${unseenId}`, excludedNotebooks: `Family (${seenId}), Work` }))),
            },
            initialSettings: {
                settingsNoteId: syncDisplayed(SYNC_NOTE_ID),
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.settings.excludedNotebooks, `Family (${seenId}), Work`,
            'the entry that resolves keeps its id, and the one this device cannot see is kept verbatim, with none invented for it')
        assert.strictEqual(state.settings.excludedNotebookIds, `${seenId},${unseenId}`, 'and the unseen id is still in the hidden list')
        // ONE write of each, which is the apply putting the payload in place - and not a second from the resolver that
        // the apply's own write runs. A resolve pass over Cockpit's own text has nothing to say.
        assert.strictEqual(state.settingWrites.filter(w => w.key === 'excludedNotebooks').length, 1, 'the resolver adds no write of its own')
        assert.strictEqual(state.settingWrites.filter(w => w.key === 'excludedNotebookIds').length, 1, 'nor to the id list')
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 0, 'so the pair is byte-identical to the payload and there is nothing to say back')
    })

    await test('settings note: the STARTUP pass obeys the keep-rule - a notebook this device cannot see is not dropped', async () => {
        // THE SHAPE THAT WOULD HURT MOST. 2.6.2 brings the visible exclusion text up to date once at startup, and a naive
        // version of that is exactly the thing that deletes a user's exclusion on every device: at startup a sync may not
        // have brought the notebook in yet, so an id that resolves to nothing here does NOT mean the user deleted it. The
        // pair is already in the current form and nothing else happens, so the right answer is to write nothing at all.
        const seenId = 'a1b2c3d4' + '0'.repeat(24)
        const unseenId = 'b9b9b9b9' + '0'.repeat(24)
        const pair = { excludedNotebookIds: `${seenId},${unseenId}`, excludedNotebooks: `Family (${seenId}), Work` }
        const state = await runSync('exclusion-startup-keep', {
            folders: [{ id: seenId, title: 'Family' }],
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]), syncSettings(pair))),
            },
            initialSettings: Object.assign({
                settingsNoteId: syncDisplayed(SYNC_NOTE_ID),
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            }, pair),
        })
        assert.strictEqual(state.settings.excludedNotebooks, pair.excludedNotebooks, 'the visible text comes through byte-identical')
        assert.strictEqual(state.settings.excludedNotebookIds, pair.excludedNotebookIds, 'and so does the hidden id list, unseen id included')
        assert.deepStrictEqual(state.settingWrites.filter(w => w.key === 'excludedNotebooks' || w.key === 'excludedNotebookIds'), [],
            'neither half is written: there was nothing to do')
        assert.strictEqual(state.notePuts.length, 0, 'and nothing is published back to the other devices')
        // Startup normalises the profile store, which arms a write whatever else happens; firing it is the proof that the
        // pair this device holds is still the pair the note holds, so there is nothing to say to the other devices.
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 0, 'and the armed write finds nothing to publish')
    })

    await test('settings note: the startup pass UPGRADES what it can label and keeps verbatim what it cannot', async () => {
        // The same device, one release earlier: the pair it is holding is 2.6.1's. The entry whose notebook is in the map
        // is rewritten with the id whole; the entry whose notebook is not - which has no label to rebuild and no id to
        // show - is left exactly as it stands, and ITS ID STAYS IN THE HIDDEN LIST. That is the keep-rule doing its work
        // during a rewrite rather than instead of one.
        const seenId = 'a1b2c3d4' + '0'.repeat(24)
        const unseenId = 'b9b9b9b9' + '0'.repeat(24)
        const oldPair = { excludedNotebookIds: `${seenId},${unseenId}`, excludedNotebooks: 'Family (a1b2c3d4), Work' }
        const state = await runSync('exclusion-startup-upgrade', {
            folders: [{ id: seenId, title: 'Family' }],
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]), syncSettings(oldPair))),
            },
            initialSettings: Object.assign({
                settingsNoteId: syncDisplayed(SYNC_NOTE_ID),
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            }, oldPair),
        })
        assert.strictEqual(state.settings.excludedNotebooks, `Family (${seenId}), Work`,
            'the entry that resolves is rewritten whole, and the one this device cannot see is kept exactly as it stands')
        assert.strictEqual(state.settings.excludedNotebookIds, `${seenId},${unseenId}`, 'and the unseen id is still excluded')
        assert.deepStrictEqual(state.settingWrites.filter(w => w.key === 'excludedNotebooks' || w.key === 'excludedNotebookIds').map(w => w.key),
            ['excludedNotebooks'], 'one write, of the visible half only')
        // The pair now differs from the note's, so it is published - and what is published carries BOTH ids, which is the
        // thing a device that has not synced that notebook must never be able to take away from the others.
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 1, 'the upgraded pair is published once')
        const published = parseSettingsNoteBody(state.notePuts[0].body).settings
        assert.strictEqual(published.excludedNotebookIds, `${seenId},${unseenId}`, 'with both ids intact')
        assert.strictEqual(published.excludedNotebooks, `Family (${seenId}), Work`, 'and the text in the form this build writes')
    })

    await test('settings note: a rename while the device was closed publishes the ID, never an empty exclusion', async () => {
        // THE DESTRUCTIVE SHAPE, end to end. The pair travels between devices, so a startup pass that resolved the stale
        // TEXT would not merely forget the exclusion here - it would publish the forgetting, and every other device would
        // apply it. The ids are read and never written, so what goes out carries the id it always carried.
        const archiveId = 'b0b0b0b0' + '0'.repeat(24)
        const stale = { excludedNotebookIds: archiveId, excludedNotebooks: 'Archive' }
        const state = await runSync('exclusion-startup-rename', {
            folders: [{ id: archiveId, title: 'Archived' }],       // renamed on the other device while this one was closed
            notes: {
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]), syncSettings(stale))),
            },
            initialSettings: Object.assign({
                settingsNoteId: syncDisplayed(SYNC_NOTE_ID),
                settingsNoteResolvedId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            }, stale),
        })
        assert.strictEqual(state.settings.excludedNotebookIds, archiveId, 'the exclusion survives the rename on this device')
        assert.strictEqual(state.settings.excludedNotebooks, `Archived (${archiveId})`, 'and the text catches up with the new name')
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 1, 'the refreshed pair is published once')
        const published = parseSettingsNoteBody(state.notePuts[0].body).settings
        assert.strictEqual(published.excludedNotebookIds, archiveId, 'carrying the id - NEVER an empty list, which every device would apply')
        assert.strictEqual(published.excludedNotebooks, `Archived (${archiveId})`, 'and the text the other devices will show')
    })

    await test('settings note: a note that is not a Cockpit settings note is never written over', async () => {
        // Pointing the setting at the wrong note (a mistyped title that matched something, a pasted id from the wrong note)
        // used to destroy that note one profile edit later: an unreadable body still opened the write gate.
        const diary = 'Dear diary,\n\nToday I finally wrote the thing down.\n'
        const state = await runSync('wrong-note', {
            notes: { [SYNC_NOTE_ID]: { id: SYNC_NOTE_ID, title: 'My diary', body: diary, updated_time: 10 } },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.notePuts.length, 0, 'nothing at startup')
        assert.ok(state.panelMessages.some(m => m[0] === 'panelToast' && /not a Cockpit settings note/i.test(String(m[1]))),
            'and the user is told which way to put it right')
        const mark = state.timeouts.length
        await state.panelMessageHandler(['profileSaved', 1, { ...baseProfile, name: 'Renamed here' }])
        await state.fireTimeout(armedSyncWrite(state, mark))
        assert.strictEqual(state.notePuts.length, 0, 'and a local change does not overwrite the user\'s note a moment later')
        assert.strictEqual(state.notes[SYNC_NOTE_ID].body, diary, 'the note is byte-for-byte as it was')
    })

    await test('settings note: a damaged body under the right title is still repaired by the next local change', async () => {
        // The other side of that judgement: a note carrying OUR title whose payload is mangled (a hand edit, a truncated
        // sync) is still this device's mailbox, and rewriting it wholesale is the repair.
        const state = await runSync('mangled', {
            notes: {
                [SYNC_NOTE_ID]: {
                    id: SYNC_NOTE_ID,
                    title: SETTINGS_NOTE_TITLE,
                    body: 'Cockpit\n\n```json\n{ half a payl\n```\n',
                    updated_time: 10,
                },
            },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.notePuts.length, 0, 'a damaged body is not rewritten on sight')
        const mark = state.timeouts.length
        await state.panelMessageHandler(['profileSaved', 1, { ...baseProfile, name: 'Renamed here' }])
        await state.fireTimeout(armedSyncWrite(state, mark))
        assert.strictEqual(state.notePuts.length, 1, 'the next local change rewrites the mailbox')
        assert.ok(parseSettingsNoteBody(state.notePuts[0].body), 'and what it wrote parses')
    })

    await test('settings note: a payload that failed half way through applying is never published back', async () => {
        const state = await runSync('partial-apply', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]), syncSettings())) },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            },
        })
        // A change from another device whose theme write the host refuses, once, after the profile store has already been
        // replaced - so a write is owed for a state this device only half holds.
        state.notes[SYNC_NOTE_ID].body = syncBody(syncStore(3, [syncProfile(2, 'From the phone')]),
            syncSettings({ themeMode: 'nord' }), '2026-09-12T10:00:00.000Z')
        state.notes[SYNC_NOTE_ID].updated_time = 99
        let refused = false
        state.onSettingWrite = (key) => {
            if (key !== 'themeMode' || refused) return
            refused = true
            throw new Error('the host refused this write')
        }
        await state.syncCompleteHandler({})
        state.onSettingWrite = null
        assert.ok(refused, 'the apply really did reach the refused write')
        assert.deepStrictEqual(syncProfileNames(state), ['From the phone'], 'and the store had already been replaced by then')
        for (const armed of state.pendingTimeouts(3000)) await state.fireTimeout(armed)
        assert.strictEqual(state.notePuts.length, 0, 'a device holding a half-applied payload may not write it over the note')
        const mark = state.timeouts.length
        await state.panelMessageHandler(['profileSaved', 2, { ...baseProfile, name: 'Renamed here' }])
        await state.fireTimeout(armedSyncWrite(state, mark))
        assert.strictEqual(state.notePuts.length, 0, 'and it stays shut until a read succeeds again')
    })

    await test('settings note command: adopting a note this device has nothing to add to writes nothing', async () => {
        const store = syncStore(2, [syncProfile(1, 'Shared')])
        const state = await runSync('adopt-quiet', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(store, syncSettings())) },
            initialSettings: { profileData: JSON.stringify(store), currentProfileID: 1 },
        })
        await state.withTimers(() => executeCommand(state, 'cockpit.connectSettingsNote'))
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the note is adopted')
        assert.strictEqual(state.notePuts.length, 0, 'and a note that already says exactly this is not given a revision for nothing')
    })

    await test('settings note gate 2: a device that starts up ON the settings note defers the write until the editor moves off', async () => {
        // onNoteSelectionChange does not fire for the note Joplin restored at launch, so the gate had no starting value and a
        // device reopened on the settings note wrote straight into the editor the user was looking at.
        const state = await runSync('open-at-startup', {
            selectedNoteIds: [SYNC_NOTE_ID],
            notes: { [SYNC_NOTE_ID]: { id: SYNC_NOTE_ID, title: SETTINGS_NOTE_TITLE, body: '', updated_time: 2 } },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        // An empty note is SEEDED, so a write is owed from the very first read - and the note is the one that is open.
        await fireArmedSyncWrite(state)
        assert.strictEqual(state.notePuts.length, 0, 'nothing is written into the editor the user is looking at')
        await state.noteSelectionHandler({ value: ['9'.repeat(32)] })
        assert.strictEqual(state.notePuts.length, 1, 'and the seed lands the moment they move off it')
        assert.ok(parseSettingsNoteBody(state.notePuts[0].body), 'carrying a payload that parses')
    })

    await test('settings note: a title search walks past the first page to the note it wants', async () => {
        // `title:` is a token match, so a vault with a "... Settings Backup" note answers both - and the one we want can be on
        // any page. A fixed limit silently answered "no note of that name" to anyone whose note sorted late.
        const state = await runSync('title-paged', {
            titleSearchPageSize: 1,
            notes: {
                [SYNC_OTHER_ID]: { id: SYNC_OTHER_ID, title: `${SETTINGS_NOTE_TITLE} Backup`, body: '', updated_time: 1 },
                [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the note')]), syncSettings())),
            },
            initialSettings: {
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        await state.withTimers(() => state.setSetting('settingsNoteId', SETTINGS_NOTE_TITLE))
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID), 'the exact match was on the second page and was still found')
        assert.deepStrictEqual(syncProfileNames(state), ['From the note', 'Only on this device'], 'and connected to')
    })

    await test('settings note: a title that named nothing at startup is tried again when a sync completes', async () => {
        // The notice says "wait for the note to sync to this device", so the retry has to be real: a completed sync is exactly
        // when the missing note can have arrived. A title of the user's OWN, not the canonical one - that one is a request to
        // create the note rather than to wait for it (see the setup checks below).
        const state = await runSync('title-later', {
            notes: {},
            initialSettings: {
                settingsNoteId: OWN_TITLE,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        assert.strictEqual(state.settings.settingsNoteId, OWN_TITLE, 'the field still holds what the user typed')
        assert.deepStrictEqual(syncProfileNames(state), ['Only on this device'], 'and nothing has been applied')
        state.notes[SYNC_NOTE_ID] = Object.assign(syncNoteFixture(syncBody(syncStore(3, [syncProfile(2, 'From the laptop')]),
            syncSettings({ themeMode: 'nord' }))), { title: OWN_TITLE })
        await state.syncCompleteHandler({})
        assert.strictEqual(state.settings.settingsNoteId, syncDisplayed(SYNC_NOTE_ID, OWN_TITLE), 'the retry found it and filled the field in')
        assert.deepStrictEqual(syncProfileNames(state), ['From the laptop', 'Only on this device'], 'and connected to it')
    })

    await test('settings note: a title that names nothing at startup is announced ONCE, after the panel exists', async () => {
        // The notice used to be raised before there was a panel to put it in - setupSettingsSync runs beside the profile store, well
        // ahead of setupPanel - so it went nowhere and left only a console line. Since the retries are deliberately silent, that was
        // the user's only chance to be told. It is now kept until the startup read, which runs after the panel is created.
        const state = await runSync('startup-notice', {
            notes: {},
            initialSettings: {
                settingsNoteId: OWN_TITLE,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Only on this device')])),
                currentProfileID: 1,
            },
        })
        const notices = () => state.panelMessages.filter(m => m[0] === 'panelToast' && /no note titled/i.test(String(m[1])))
        assert.strictEqual(notices().length, 1, 'the notice reached the panel, though it was raised before the panel existed')
        // ...and exactly once: the automatic retries say nothing, so a user who leaves the setting as typed is not nagged.
        await state.syncCompleteHandler({})
        await state.syncCompleteHandler({})
        assert.strictEqual(notices().length, 1, 'and is not repeated on later syncs')
    })

    await test('settings note: a tick after a refused apply re-reads the body instead of trusting the stamp', async () => {
        const state = await runSync('refused-then-tick', {
            notes: { [SYNC_NOTE_ID]: syncNoteFixture(syncBody(syncStore(2, [syncProfile(1, 'Shared')]), syncSettings())) },
            initialSettings: {
                settingsNoteId: SYNC_NOTE_ID,
                profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Shared')])),
                currentProfileID: 1,
            },
        })
        state.notes[SYNC_NOTE_ID].body = syncBody(syncStore(3, [syncProfile(2, 'From the phone')]),
            syncSettings({ customTextColor: '#123456', themeMode: 'nord' }), '2026-09-12T10:00:00.000Z')
        state.notes[SYNC_NOTE_ID].updated_time = 99
        let refused = false
        state.onSettingWrite = (key) => {
            if (key !== 'customTextColor' || refused) return
            refused = true
            throw new Error('the host refused this write')
        }
        await state.syncCompleteHandler({})
        state.onSettingWrite = null
        assert.ok(refused, 'the apply reached the refused write')
        assert.strictEqual(state.settings.themeMode, 'matchJoplin', 'and stopped there - the keys written after it never landed')
        // The read that preceded the refusal recorded the note's updated_time. A tick that trusted that stamp would answer "nothing
        // moved" for ever: the device stays out of step, its own edit unpublished, until some sync happens to complete - and the
        // wholesale apply that finally arrives throws that edit away.
        const bodyReads = () => state.gets.filter(g => g.path[0] === 'notes' && g.path[1] === SYNC_NOTE_ID &&
            g.query && Array.isArray(g.query.fields) && g.query.fields.includes('body')).length
        const before = bodyReads()
        const tick = state.intervals.find(interval => interval.ms === 60000)
        assert.ok(tick, 'the periodic backstop is the 60 s interval')
        await state.withTimers(() => tick.fn())
        assert.strictEqual(bodyReads() - before, 1, 'the tick fetched the body rather than stopping at updated_time')
        assert.strictEqual(state.settings.customTextColor, '#123456', 'and the apply completed')
        assert.strictEqual(state.settings.themeMode, 'nord', 'including the keys the refusal had cut short')
    })

    await test('settings note: the applied content key is recorded BEFORE the apply, and cleared again if the apply throws', () => {
        // Not observable from outside - every operation is serialized on one chain, so a write can never interleave with an
        // apply - but it is what makes the design correct if that chain is ever bypassed, and what Harper's sync note learned
        // the hard way. Pinned on the source, like the gesture-trace gate, because that is where the rule lives.
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'settingsSync.ts'), 'utf8')
        const refresh = source.slice(source.indexOf('async function refreshFromSettingsNoteLocked'))
        assert.ok(refresh.length > 200, 'the audit must actually have found the function')
        const assign = refresh.indexOf('lastContentKey = key')
        const apply = refresh.indexOf('await applySettingsPayload(')
        assert.ok(assign > 0 && apply > 0, 'both statements must be present')
        assert.ok(assign < apply, 'the key is recorded before the apply, so the writes the apply causes see themselves as redundant')
        assert.ok(/lastContentKey = null\s/.test(refresh.slice(apply)), 'and a failed apply clears it again, so the next read retries')
    })

    // ============================================================ large collections (the 2026-09-29 freeze)
    // Joplin's search route re-runs the whole search for every page it returns, so paging a 20,000-note collection through it froze
    // Joplin for minutes. An unfiltered view now reads its notes from the live ['notes'] listing, the Notes section stops at a cap
    // with a "show more" footer, and an unfiltered to-do search that runs past its page budget moves to the listing.
    // NOTES_BATCH in src/ui/panel/panel.ts: how many notes the section draws before its "show more" footer.
    const CAP = 1000
    const bigFolder = 'b'.repeat(31) + '1'
    const bigArchive = 'b'.repeat(31) + '2'
    const bigNotes = (count, folder, start) => Array.from({ length: count }, (_, i) => ({
        id: (start + i).toString(16).padStart(32, '0'), title: `Big note ${start + i}`, parent_id: folder,
        user_updated_time: 1000 + start + i, user_created_time: 1,
    }))
    const bigProfile = { ...baseProfile, name: 'Big', showNotes: true }
    const bigRun = async (extra) => await run(Object.assign({
        dataDir: path.join(tmp, 'big-data-' + Math.random().toString(36).slice(2)),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [],
        searchNotes: bigNotes(CAP + 50, bigFolder, 1),
        folders: [{ id: bigFolder, title: 'Box', parent_id: '' }, { id: bigArchive, title: 'Archive', parent_id: '' }],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...bigProfile, id: 1, sortOrder: 0, noteID: '' }] }),
            currentProfileID: 1,
        },
    }, extra || {}))
    const noteRows = (state) => (String(state.panelHtml['panel-panel'] || '').match(/data-note-id="/g) || []).length
    const noteSearches = (state) => state.gets.filter(g => g.path[0] === 'search' && String(g.query.query).includes('type:note'))
    const listingReads = (state) => state.gets.filter(g => g.path[0] === 'notes' && g.path.length === 1 && g.query && (g.query.fields || []).includes('todo_due'))

    await test('large collection: an unfiltered view reads its notes from the live listing, never from the search', async () => {
        const state = await bigRun()
        assert.strictEqual(noteSearches(state).length, 0, 'no type:note search runs for a view with no criteria and nothing typed')
        assert.ok(listingReads(state).length > 0, 'the live listing is read instead')
        const read = listingReads(state)[0].query
        assert.strictEqual(read.order_by, 'user_updated_time', 'newest first, so a capped read keeps the recent notes')
        assert.strictEqual(read.order_dir, 'DESC')
        assert.ok(read.limit <= 100, 'within the API page limit')
    })

    await test('large collection: the Notes section stops at 1,000 rows and says so, and "show more" adds the next batch', async () => {
        const state = await bigRun()
        assert.strictEqual(noteRows(state), CAP, 'the first render draws the most recent notes up to the cap')
        const html = state.panelHtml['panel-panel']
        assert.ok(html.includes(`Big note ${CAP + 50}<`) && !html.includes('Big note 50<'), 'the kept ones are the most recently updated')
        assert.ok(html.includes('notes-more-message') && html.includes('onShowMoreNotesClicked()'), 'the footer says the list is capped and offers more')
        assert.ok(html.includes(`Showing the ${CAP} most recently updated notes`), 'and says how many it shows')
        assert.ok(listingReads(state).every(g => g.query.page <= CAP / 100 + 1), 'the listing is read only as far as the cap needs')
        await state.panelMessageHandler(['showMoreNotes'])
        assert.strictEqual(noteRows(state), CAP + 50, 'the next batch brings the rest')
        assert.ok(!state.panelHtml['panel-panel'].includes('notes-more-message'), 'and with nothing left out, the footer goes')
    })

    await test('large collection: a section under the cap draws every note and no footer', async () => {
        const state = await bigRun({ searchNotes: bigNotes(881, bigFolder, 1) })
        assert.strictEqual(noteRows(state), 881, 'a collection of the owner\'s size is drawn whole')
        assert.ok(!state.panelHtml['panel-panel'].includes('notes-more-message'), 'no footer when nothing was left out')
    })

    await test('large collection: the listing path drops excluded notebooks and trashed notes before counting the cap', async () => {
        const trashed = { id: 'f'.repeat(32), title: 'Big trashed', parent_id: bigFolder, user_updated_time: 999999, deleted_time: 5 }
        const state = await bigRun({
            searchNotes: bigNotes(CAP - 50, bigFolder, 1).concat(bigNotes(150, bigArchive, 5001), [trashed]),
            initialSettings: {
                profileData: JSON.stringify({ nextID: 2, profiles: [{ ...bigProfile, id: 1, sortOrder: 0, noteID: '' }] }),
                currentProfileID: 1,
                excludedNotebookIds: bigArchive,
            },
        })
        const html = state.panelHtml['panel-panel']
        assert.strictEqual(noteRows(state), CAP - 50, 'every kept note fits under the cap once the excluded 150 are dropped')
        assert.ok(!html.includes('Big note 5001') && !html.includes('Big trashed'), 'no excluded or trashed note is drawn')
        assert.ok(!html.includes('notes-more-message'), 'and the excluded ones do not count as "more"')
    })

    await test('large collection: a notebook the query cannot name still narrows the capped listing, not just its result', async () => {
        // A title with a double quote cannot go into notebook:"...", so the section reads the listing - where a cap's worth of newer notes from another
        // notebook would use up the whole cap if the notebook were only filtered afterwards.
        const quoted = 'q'.repeat(32)
        const state = await bigRun({
            searchNotes: bigNotes(CAP + 50, bigFolder, 100).concat(bigNotes(5, quoted, 1)),
            folders: [{ id: bigFolder, title: 'Box', parent_id: '' }, { id: quoted, title: 'Say "hi"', parent_id: '' }],
        })
        await state.panelMessageHandler(['notebookFilterChanged', quoted])
        const html = state.panelHtml['panel-panel']
        assert.strictEqual(noteRows(state), 5, 'all five notes of the quoted notebook are shown')
        assert.ok(html.includes('Big note 1<') && html.includes('Big note 5<'))
        assert.ok(!html.includes('notes-more-message'), 'and nothing of that notebook was left out')
    })

    await test('large collection: a filtered notes search is read newest first and stops at the cap', async () => {
        const state = await bigRun()
        state.gets.length = 0
        await state.panelMessageHandler(['searchFilterChanged', 'Big'])
        const searches = noteSearches(state)
        assert.ok(searches.length > 0, 'typed text still goes to the search, which is what understands it')
        assert.ok(searches.every(g => g.query.order_by === 'user_updated_time' && g.query.order_dir === 'DESC'), 'newest first')
        assert.strictEqual(noteRows(state), CAP, 'capped like the listing path')
        assert.ok(state.panelHtml['panel-panel'].includes('notes-more-message'), 'with the same footer')
    })

    await test('large collection: an unfiltered to-do search past its page budget moves to the listing, and stays there', async () => {
        const bigTodo = { id: 'c'.repeat(32), title: 'Big open todo', is_todo: 1, todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: bigFolder, user_updated_time: 5 }
        const state = await bigRun({ todos: [bigTodo], todoSearchPages: 50 })
        const todoSearches = (s) => s.gets.filter(g => g.path[0] === 'search' && String(g.query.query).includes('type:todo'))
        assert.ok(todoSearches(state).length <= 10, `the search stops at its budget (took ${todoSearches(state).length} pages)`)
        assert.ok(state.panelHtml['panel-panel'].includes('Big open todo'), 'the listing answers the to-dos instead')
        const fullWalk = listingReads(state).filter(g => g.query.order_by === 'id')
        assert.ok(fullWalk.length > 0, 'the to-dos come from a full listing walk')
        const before = todoSearches(state).length
        await state.panelMessageHandler(['sortDirectionClicked'])
        assert.strictEqual(todoSearches(state).length, before, 'once large, the next refresh goes straight to the listing')
    })

    await test('large collection: a FILTERED to-do search is never cut short, whatever its size', async () => {
        const bigTodo = { id: 'c'.repeat(32), title: 'Big tagged todo', is_todo: 1, todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: bigFolder, user_updated_time: 5 }
        const state = await bigRun({
            todos: [bigTodo], todoSearchPages: 14,
            initialSettings: {
                profileData: JSON.stringify({ nextID: 2, profiles: [{ ...bigProfile, id: 1, sortOrder: 0, noteID: '', searchCriteria: 'tag:big' }] }),
                currentProfileID: 1,
            },
        })
        const pages = state.gets.filter(g => g.path[0] === 'search' && String(g.query.query).includes('type:todo')).map(g => g.query.page)
        assert.ok(pages.includes(14), 'a query the listing cannot answer pages the search to the end')
        assert.ok(state.panelHtml['panel-panel'].includes('Big tagged todo'))
    })

    // ============================================================ note store (2.7 phase 2): the local mirror and the change feed
    // Cockpit 2.7 keeps a mirror of every note's metadata, built once from the ['notes'] listing and kept exact by Joplin's change feed,
    // joplin.data.get(['events'], { cursor }) (docs/BRIEF-2.7-local-mirror.md). Nothing reads it yet - phase 3 switches the unfiltered views over -
    // so these checks prove the store on its own: the pure model (src/core/noteStoreModel.js, required directly), then the driver
    // (src/core/noteStore.ts) through the bundle, observed by the calls it makes and by the inspection handle it publishes (state.noteStore).
    // The harness serves the feed from a change log each test writes itself (state.pushChange), and with `listingFromNotes` the listing and the
    // fetch by id both read the one note map the test changes.
    const NoteStoreModel = require('../src/core/noteStoreModel.js')
    // listingFields in src/core/joplin.ts, plus the one field a fetch by id needs to drop a conflict copy.
    const STORE_FIELDS = ['id', 'title', 'is_todo', 'todo_completed', 'todo_due', 'parent_id', 'user_updated_time', 'user_created_time', 'deleted_time', 'is_conflict']
    // The three timers in src/core/noteStore.ts: the startup build, the follow-up poll, the note-change debounce.
    const STORE_BUILD_DELAY = 2000
    const STORE_FOLLOW_UP = 500
    const STORE_NOTE_CHANGE_DELAY = 250
    const storeFolder = 'e'.repeat(31) + '1'
    const storeId = (n) => 'e'.repeat(24) + String(n).padStart(8, '0')
    const storeNote = (n, extra) => Object.assign({
        id: storeId(n), title: `Stored ${n}`, is_todo: 0, todo_completed: 0, todo_due: 0, parent_id: storeFolder,
        user_updated_time: 1000 + n, user_created_time: 500 + n, deleted_time: 0, is_conflict: 0,
    }, extra || {})
    const storeNoteRange = (from, count) => Array.from({ length: count }, (_, i) => storeNote(from + i))
    const storeRun = async (notes, extra) => await run(Object.assign({
        dataDir: path.join(tmp, 'store-data-' + Math.random().toString(36).slice(2)),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [],
        listingFromNotes: true,
        notes: Object.fromEntries(notes.map(note => [note.id, note])),
        folders: [{ id: storeFolder, title: 'Store', parent_id: '' }],
    }, extra || {}))
    const isStoreGet = (g) => g.path[0] === 'events' || (g.path[0] === 'notes' && g.query && (g.query.fields || []).includes('is_conflict'))
    const storeGetsSince = (state, mark) => state.gets.slice(mark).filter(isStoreGet)
    const isEvents = (g) => g.path[0] === 'events'
    const isWalkPage = (g) => g.path[0] === 'notes' && g.path.length === 1 && isStoreGet(g)
    const isStoreFetch = (g) => g.path[0] === 'notes' && g.path.length === 2 && isStoreGet(g)
    const hasCursor = (g) => !!g.query && 'cursor' in g.query
    const storeModel = (state) => state.noteStore.getModel()
    const storeIds = (state) => storeModel(state).snapshot().map(record => record.id).sort()
    const buildTimeout = (state) => state.timeouts.find(t => t.ms === STORE_BUILD_DELAY)
    const buildStore = async (state) => {
        await state.fireTimeout(buildTimeout(state))
        assert.ok(state.noteStore.isReady(), 'precondition: the store built')
    }
    const storeTick = (state) => state.withTimers(() => state.intervals.find(interval => interval.ms === 60000).fn())
    // The store's own warnings, captured while fn runs: the one per session it may give, and none on a recovery.
    const storeWarnings = async (fn) => {
        const warnings = []
        const realWarn = console.warn
        console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
        try {
            await fn()
        } finally {
            console.warn = realWarn
        }
        return warnings.filter(warning => /note store|change feed/.test(warning))
    }
    const newStoreNote = (state, n, extra) => {
        const note = storeNote(n, extra)
        state.notes[note.id] = note
        return note
    }

    // ---- the model, directly -----------------------------------------------------------------------------------------------------------------
    const builtModel = (notes) => {
        const model = NoteStoreModel.createNoteStoreModel()
        model.beginBuild()
        model.addListingPage(notes)
        model.endBuild()
        return model
    }
    const modelIds = (model) => model.snapshot().map(record => record.id).sort()

    await test('note store model: a build stores each id once across pages and drops trashed and conflict rows', () => {
        const model = NoteStoreModel.createNoteStoreModel()
        model.beginBuild()
        model.addListingPage([storeNote(1), storeNote(2), storeNote(3, { deleted_time: 77 })])
        model.addListingPage([storeNote(2, { title: 'Stored 2, read again' }), storeNote(4, { is_conflict: 1 }), storeNote(5)])
        assert.strictEqual(model.size(), 0, 'nothing is visible until the build is swapped in')
        assert.strictEqual(model.endBuild(), true, 'the swap reports a change')
        assert.deepStrictEqual(modelIds(model), [storeId(1), storeId(2), storeId(5)], 'one record per id; the trashed and the conflict row are dropped')
        assert.strictEqual(model.get(storeId(2)).title, 'Stored 2, read again', 'a note read on two pages keeps the later read')
        assert.deepStrictEqual(Object.keys(model.get(storeId(1))), NoteStoreModel.RECORD_FIELDS, 'a record holds exactly the eight fields')
        assert.deepStrictEqual(NoteStoreModel.RECORD_FIELDS,
            ['id', 'title', 'is_todo', 'todo_completed', 'todo_due', 'parent_id', 'user_updated_time', 'user_created_time'])
        // A failed walk leaves what was there: a staging map is swapped in whole, or not at all.
        model.beginBuild()
        model.addListingPage([storeNote(9)])
        model.abandonBuild()
        assert.strictEqual(model.endBuild(), false, 'an abandoned build has nothing to swap in')
        assert.deepStrictEqual(modelIds(model), [storeId(1), storeId(2), storeId(5)], 'and the previous contents stand')
    })

    await test('note store model: applyFetched upserts, and removes on deleted_time, on is_conflict and on a null (Not Found) answer', () => {
        const model = builtModel([storeNote(1), storeNote(2), storeNote(3)])
        assert.strictEqual(model.applyFetched(storeNote(9), storeId(9)), 'added', 'a note the store did not have is added')
        assert.strictEqual(model.applyFetched(storeNote(1, { title: 'Renamed' }), storeId(1)), 'updated')
        assert.strictEqual(model.get(storeId(1)).title, 'Renamed')
        assert.strictEqual(model.applyFetched(storeNote(1, { title: 'Renamed' }), storeId(1)), 'unchanged', 'the same note again changes nothing')
        assert.strictEqual(model.applyFetched(storeNote(2, { deleted_time: 5 }), storeId(2)), 'removed', 'a trashed note is removed')
        assert.strictEqual(model.applyFetched(storeNote(3, { is_conflict: 1 }), storeId(3)), 'removed', 'a conflict copy is removed')
        assert.strictEqual(model.applyFetched(null, storeId(9)), 'removed', 'a Not Found answer removes the note')
        assert.strictEqual(model.applyFetched(null, storeId(9)), 'unchanged', 'and a Not Found for a note the store lacks is nothing')
        assert.strictEqual(model.applyFetched(storeNote(8, { deleted_time: 5 }), storeId(8)), 'unchanged', 'a trashed note is never added')
        assert.deepStrictEqual(modelIds(model), [storeId(1)])
    })

    await test('note store model: removing an unknown id is a no-op, and a local write merges known fields into known ids only', () => {
        const model = builtModel([storeNote(1, { is_todo: 1 }), storeNote(2)])
        const revision = model.revision
        assert.strictEqual(model.remove(storeId(7)), false, 'an unknown id')
        assert.strictEqual(model.revision, revision, 'changes nothing')
        assert.strictEqual(model.applyLocalWrite(storeId(7), { todo_completed: 5 }), false, 'a write to a note the store lacks is ignored')
        assert.strictEqual(model.get(storeId(7)), undefined, 'and does not create it: the feed will bring it')
        assert.strictEqual(model.applyLocalWrite(storeId(1), { todo_completed: 1234, body: 'text', id: 'something else' }), true)
        assert.deepStrictEqual(model.get(storeId(1)),
            { id: storeId(1), title: 'Stored 1', is_todo: 1, todo_completed: 1234, todo_due: 0, parent_id: storeFolder, user_updated_time: 1001, user_created_time: 501 },
            'only the record fields are merged, and never the id')
        assert.strictEqual(model.applyLocalWrite(storeId(1), { body: 'a body only' }), false, 'a write of fields the store does not hold changes nothing')
        assert.strictEqual(model.applyLocalWrite(storeId(2), { deleted_time: 9 }), true, 'a write that trashes the note')
        assert.deepStrictEqual(modelIds(model), [storeId(1)], 'removes it')
        assert.strictEqual(model.remove(storeId(1)), true, 'removing a known id')
        assert.strictEqual(model.size(), 0)
    })

    await test('note store model: planDrain folds create and update into one fetch, lets the later row win, ignores unknown deletes, and counts fetches for the threshold', () => {
        const K1 = storeId(1), K2 = storeId(2), N = storeId(10), Z = storeId(11), G = storeId(12), F = storeId(13)
        const model = builtModel([storeNote(1), storeNote(2)])
        const row = (id, item_id, type, item_type = 1) => ({ id, item_type, item_id, type, created_time: 1 })
        const plan = model.planDrain([
            row(1, N, 1),        // a create
            row(2, K1, 2),       // an update
            row(3, N, 2),        // an update of the note created above: still ONE fetch
            row(4, Z, 3),        // a delete of an id the store never had: nothing
            row(5, K2, 2),       // an update...
            row(6, K2, 3),       // ...and a later delete of the same note: the delete wins
            row(7, G, 3),        // a delete...
            row(8, G, 1),        // ...and a later create of the same id: the create wins
            row(9, F, 1, 2),     // not a note: skipped
        ], 200)
        assert.deepStrictEqual(plan, { fetch: [K1, N, G], remove: [K2], rebuild: false })
        const creates = (count) => Array.from({ length: count }, (_, i) => row(100 + i, storeId(1000 + i), 1))
        assert.strictEqual(model.planDrain(creates(200), 200).rebuild, false, '200 fetches stay per id')
        assert.strictEqual(model.planDrain(creates(201), 200).rebuild, true, 'more than 200 is a rebuild')
        assert.strictEqual(model.planDrain(creates(201).concat(creates(201)), 200).fetch.length, 201, 'the count is of distinct ids')
        const knownDeletes = builtModel(storeNoteRange(1, 300)).planDrain(storeNoteRange(1, 300).map((note, i) => row(i + 1, note.id, 3)), 200)
        assert.deepStrictEqual([knownDeletes.remove.length, knownDeletes.fetch.length, knownDeletes.rebuild], [300, 0, false],
            'removals are local and free, so they never count towards a rebuild')
    })

    await test('note store model: todos() and notes() split every record by is_todo, numbers are numbers, and every read hands out a copy', () => {
        const model = builtModel([
            storeNote(1), storeNote(2, { is_todo: 1 }), storeNote(3, { is_todo: '1', todo_due: '1700000000000', title: null, parent_id: null }), storeNote(4),
        ])
        assert.deepStrictEqual(model.todos().map(record => record.id).sort(), [storeId(2), storeId(3)])
        assert.deepStrictEqual(model.notes().map(record => record.id).sort(), [storeId(1), storeId(4)])
        const normalised = model.get(storeId(3))
        assert.deepStrictEqual([normalised.is_todo, normalised.todo_due, normalised.title, normalised.parent_id], [1, 1700000000000, '', ''])
        model.get(storeId(1)).title = 'changed by a caller'
        model.snapshot()[0].title = 'changed by a caller'
        model.todos()[0].title = 'changed by a caller'
        model.notes()[0].title = 'changed by a caller'
        assert.ok(model.snapshot().every(record => record.title !== 'changed by a caller'), 'no read lets a caller change the mirror')
    })

    await test('note store model: the revision rises on every change and on nothing else', () => {
        const model = NoteStoreModel.createNoteStoreModel()
        const steps = []
        const step = (label, fn) => { fn(); steps.push(`${label}:${model.revision}`) }
        step('new', () => {})
        step('staging', () => { model.beginBuild(); model.addListingPage([storeNote(1), storeNote(2)]) })
        step('swap', () => model.endBuild())
        step('same rebuild', () => { model.beginBuild(); model.addListingPage([storeNote(1), storeNote(2)]); model.endBuild() })
        step('changed rebuild', () => { model.beginBuild(); model.addListingPage([storeNote(1), storeNote(2, { title: 'x' })]); model.endBuild() })
        step('same fetch', () => model.applyFetched(storeNote(1), storeId(1)))
        step('new fetch', () => model.applyFetched(storeNote(3), storeId(3)))
        step('unknown not found', () => model.applyFetched(null, storeId(9)))
        step('unknown remove', () => model.remove(storeId(9)))
        step('remove', () => model.remove(storeId(3)))
        step('unknown write', () => model.applyLocalWrite(storeId(9), { title: 'y' }))
        step('same write', () => model.applyLocalWrite(storeId(1), { title: 'Stored 1' }))
        step('body write', () => model.applyLocalWrite(storeId(1), { body: 'z' }))
        step('write', () => model.applyLocalWrite(storeId(1), { title: 'Renamed' }))
        step('reads', () => { model.planDrain([{ id: 1, item_type: 1, item_id: storeId(1), type: 2 }], 200); model.get(storeId(1)); model.snapshot(); model.size(); model.todos(); model.notes() })
        step('abandoned build', () => { model.beginBuild(); model.addListingPage([]); model.abandonBuild() })
        assert.deepStrictEqual(steps, ['new:0', 'staging:0', 'swap:1', 'same rebuild:1', 'changed rebuild:2', 'same fetch:2', 'new fetch:3',
            'unknown not found:3', 'unknown remove:3', 'remove:4', 'unknown write:4', 'same write:4', 'body write:4', 'write:5', 'reads:5', 'abandoned build:5'])
        try { model.revision = 99 } catch (error) { /* strict mode refuses the write outright; either way it must not land */ }
        assert.strictEqual(model.revision, 5, 'and it cannot be written from outside')
    })

    // ---- the driver, through the bundle ------------------------------------------------------------------------------------------------------
    await test('note store startup: the panel paints first, the build is armed as a timeout, and nothing of the store runs before it fires', async () => {
        const state = await storeRun([storeNote(1), storeNote(2)])
        assert.ok(state.setHtmlCalls > 0, 'the panel has painted')
        assert.strictEqual(storeGetsSince(state, 0).length, 0, 'and the store has made no call at all: the first paint never waits for it')
        assert.ok(!state.callLog.includes('events'), 'not one events call before the paint, or after it')
        const kick = buildTimeout(state)
        assert.ok(kick && !kick.fired && !kick.cleared, 'the build is a timeout armed during startup')
        assert.strictEqual(state.noteStore.isReady(), false, 'and until it runs the store is not ready')
        // A trigger that comes first costs nothing and arms nothing: the build about to run reads everything anyway.
        const mark = state.timeouts.length
        await storeTick(state)
        await state.syncCompleteHandler({ withErrors: false })
        await state.noteChangeHandler({ id: storeId(1) })
        await state.panelMessageHandler(['todoChecked', storeId(1), true])
        assert.strictEqual(storeGetsSince(state, 0).length, 0, 'no trigger and no write reaches the feed before the build')
        assert.deepStrictEqual(state.timeouts.slice(mark).filter(t => t.ms === STORE_FOLLOW_UP || t.ms === STORE_NOTE_CHANGE_DELAY), [],
            'and none arms a store timer')
        const lastPaint = state.callLog.lastIndexOf('setHtml')
        await state.fireTimeout(kick)
        assert.ok(state.gets.some(isWalkPage), 'the build runs when its timeout fires')
        assert.ok(state.callLog.indexOf('events') > lastPaint, 'after every paint so far')
        assert.ok(state.noteStore.isReady(), 'and the store is ready')
        assert.deepStrictEqual(storeIds(state), [storeId(1), storeId(2)])
    })

    await test('note store build: the cursor first, the id-ordered walk, then one replay from that string cursor; ready only after it, a duplicate stored once', async () => {
        const state = await storeRun(storeNoteRange(1, 150).concat([storeNote(900, { deleted_time: 12 }), storeNote(901, { is_conflict: 1 })]), {
            changeLog: [{ item_id: storeId(3), type: 2 }, { item_id: storeId(4), type: 1 }],
        })
        let firstPageLast = null
        const readyWhile = []
        state.onListingPage = (query, items) => {
            if (query.order_by !== 'id') return items
            readyWhile.push(state.noteStore.isReady())
            if (query.page === 1){
                firstPageLast = items[items.length - 1]
                // A change while the walk runs, which only the replay can bring in.
                state.notes[storeId(5)].title = 'Renamed during the walk'
                state.pushChange({ item_id: storeId(5), type: 2 })
                return items
            }
            // Page 2 repeats page 1's last note, as a create shifting the listing between the two reads would.
            return [firstPageLast].concat(items)
        }
        state.onEventsCall = (query) => { if (query && 'cursor' in query) readyWhile.push(state.noteStore.isReady()) }
        await state.fireTimeout(buildTimeout(state))
        state.onListingPage = null
        state.onEventsCall = null
        const seq = storeGetsSince(state, 0)
        assert.strictEqual(seq.length, 5, `the no-cursor call, two pages, the replay, one fetch - got ${seq.length}`)
        assert.ok(isEvents(seq[0]) && !hasCursor(seq[0]), 'the cursor is taken first, with no cursor key at all')
        assert.deepStrictEqual(seq.slice(1, 3).map(g => g.query), [1, 2].map(page => ({ fields: STORE_FIELDS, order_by: 'id', limit: 100, page })),
            'then the listing by id, 100 a page, with the listing fields plus is_conflict')
        assert.strictEqual(state.eventsAnswers[0].cursor, '2', 'the route answers the cursor as a string')
        assert.deepStrictEqual(seq[3].query, { cursor: '2' }, 'after the last page, one replay from exactly that string')
        assert.deepStrictEqual(seq[4].path, ['notes', storeId(5)], 'which fetches the note changed during the walk')
        assert.deepStrictEqual(seq[4].query, { fields: STORE_FIELDS })
        assert.deepStrictEqual(readyWhile, [false, false, false], 'not ready during the walk, nor when the replay is asked for')
        assert.ok(state.noteStore.isReady(), 'ready once the replay is applied')
        assert.strictEqual(storeModel(state).size(), 150, 'the duplicate is stored once; the trashed and the conflict note not at all')
        assert.strictEqual(storeModel(state).get(storeId(5)).title, 'Renamed during the walk', 'and the replay brought the change in')
    })

    await test('note store idle tick: exactly one events call with the cursor as the last answer gave it, no follow-up, nothing else', async () => {
        const state = await storeRun([storeNote(1)], { changeLog: [{ item_id: storeId(1), type: 1 }] })
        await buildStore(state)
        const lastCursor = state.eventsAnswers[state.eventsAnswers.length - 1].cursor
        const revision = storeModel(state).revision
        let notified = 0
        state.noteStore.subscribe(() => notified++)
        const mark = state.gets.length
        await storeTick(state)
        assert.deepStrictEqual(storeGetsSince(state, mark).map(g => g.query), [{ cursor: lastCursor }],
            'one events call, carrying the string the route last answered - and no walk, no fetch')
        assert.strictEqual(typeof lastCursor, 'string')
        // The follow-up is for saves, whose feed row lands after the save returns; a tick is tied to none, so an idle tick is ONE data call.
        assert.strictEqual(state.pendingTimeouts(STORE_FOLLOW_UP).length, 0, 'the tick arms no follow-up poll')
        assert.strictEqual(storeModel(state).revision, revision, 'an empty drain changes nothing')
        assert.strictEqual(notified, 0, 'so no listener hears about it')
    })

    await test('note store replay: create, update, unknown update, trash, restore, conflict, delete, unknown delete, Not Found', async () => {
        const [A, B, C, D, E, T] = [1, 2, 3, 4, 5, 6].map(storeId)
        const state = await storeRun([storeNote(1, { is_todo: 1 }), storeNote(2), storeNote(3), storeNote(4), storeNote(5), storeNote(6, { deleted_time: 30 })])
        await buildStore(state)
        assert.deepStrictEqual(storeIds(state), [A, B, C, D, E], 'precondition: the trashed note is not stored')
        let notified = 0
        state.noteStore.subscribe(() => notified++)
        const N = newStoreNote(state, 20, { title: 'Created' }).id
        state.pushChange({ item_id: N, type: 1 })                                              // a create
        state.notes[A].title = 'Updated'
        state.pushChange({ item_id: A, type: 2 })                                              // an update
        const U = newStoreNote(state, 21, { title: 'Created and edited' }).id
        state.pushChange({ item_id: U, type: 2 })                                              // an update of an id the store never had
        state.notes[B].deleted_time = 99
        state.pushChange({ item_id: B, type: 2 })                                              // a trash: an update, fetched with deleted_time
        state.notes[T].deleted_time = 0
        state.pushChange({ item_id: T, type: 2 })                                              // a restore
        const X = newStoreNote(state, 22, { is_conflict: 1 }).id
        state.pushChange({ item_id: X, type: 1 })                                              // a conflict copy arriving
        delete state.notes[D]
        state.pushChange({ item_id: D, type: 3 })                                              // a permanent delete
        state.pushChange({ item_id: storeId(23), type: 3 })                                    // a delete of an id the store never had
        state.pushChange({ item_id: E, type: 2 })
        delete state.notes[E]                                                                  // gone by the time it is fetched: Not Found
        const mark = state.gets.length
        await storeTick(state)
        const fetched = storeGetsSince(state, mark).filter(isStoreFetch)
        assert.deepStrictEqual(fetched.map(g => g.path[1]), [N, A, U, B, T, X, E], 'one fetch per created or updated note, in feed order, none for a delete')
        assert.ok(fetched.every(g => JSON.stringify(g.query) === JSON.stringify({ fields: STORE_FIELDS })), 'each asking for the store fields')
        assert.deepStrictEqual(storeIds(state), [A, C, T, N, U].sort(), 'created, restored and unknown-updated in; trashed, conflict, deleted and Not Found out')
        assert.strictEqual(storeModel(state).get(A).title, 'Updated')
        assert.strictEqual(storeModel(state).get(A).is_todo, 1)
        assert.ok(state.noteStore.isReady(), 'a Not Found is an answer, not a failure')
        assert.strictEqual(notified, 1, 'one drain that changed the mirror is one notification')
    })

    await test('note store paging: 150 changes drain as two events pages inside one poll', async () => {
        const state = await storeRun([storeNote(1)])
        await buildStore(state)
        const from = state.lastChangeId
        for (let i = 0; i < 150; i++) state.pushChange({ item_id: newStoreNote(state, 1000 + i).id, type: 1 })
        const mark = state.gets.length
        await storeTick(state)
        const seq = storeGetsSince(state, mark)
        assert.deepStrictEqual(seq.filter(isEvents).map(g => g.query), [{ cursor: String(from) }, { cursor: String(from + 100) }],
            'a full page of 100, then the rest from the cursor that page answered')
        assert.strictEqual(seq.filter(isStoreFetch).length, 150, 'under the threshold, so each note is fetched')
        assert.strictEqual(storeModel(state).size(), 151)
    })

    await test('note store large drain: more than 200 notes to fetch rebuilds instead - the cursor retaken first, then the walk, no per-id fetch', async () => {
        const state = await storeRun([storeNote(1), storeNote(2)])
        await buildStore(state)
        for (let i = 0; i < 201; i++) state.pushChange({ item_id: newStoreNote(state, 1000 + i).id, type: 1 })
        const mark = state.gets.length
        await storeTick(state)
        const seq = storeGetsSince(state, mark)
        const shape = seq.map(g => isEvents(g) ? (hasCursor(g) ? 'events' : 'head') : isWalkPage(g) ? 'page' : 'fetch')
        assert.deepStrictEqual(shape, ['events', 'events', 'events', 'head', 'page', 'page', 'page', 'events'],
            'three drain pages, then a fresh cursor, then the walk, then its replay')
        assert.strictEqual(seq.filter(isStoreFetch).length, 0, 'and not one per-id fetch')
        const retaken = state.eventsAnswers[state.eventsAnswers.length - 2].cursor
        assert.deepStrictEqual(seq[seq.length - 1].query, { cursor: retaken }, 'the replay starts from the retaken cursor')
        assert.strictEqual(storeModel(state).size(), 203)
        assert.ok(state.noteStore.isReady())
    })

    await test('note store failure: a route that throws at the guard leaves the store off for good - one warning, no walk, the panel unaffected', async () => {
        const todo = { id: storeId(1), title: 'Guarded to-do', is_todo: 1, todo_completed: 0, todo_due: Date.now() + 3600000, parent_id: storeFolder }
        const state = await storeRun([storeNote(1, todo)], { eventsUnavailable: true, todos: [todo] })
        assert.ok(state.panelHtml['panel-panel'].includes('Guarded to-do'), 'precondition: the panel shows the to-do')
        const warnings = await storeWarnings(() => state.fireTimeout(buildTimeout(state)))
        assert.strictEqual(warnings.length, 1, 'one warning')
        assert.deepStrictEqual(storeGetsSince(state, 0).map(g => g.path[0]), ['events'], 'the guard is the only call: no walk')
        assert.strictEqual(state.noteStore.isAvailable(), false)
        assert.strictEqual(state.noteStore.isReady(), false)
        const paints = state.setHtmlCalls
        const later = await storeWarnings(async () => {
            await storeTick(state)
            await state.syncCompleteHandler({ withErrors: false })
            await state.noteChangeHandler({ id: storeId(1) })
            await state.panelMessageHandler(['todoChecked', storeId(1), true])
        })
        assert.strictEqual(storeGetsSince(state, 0).length, 1, 'no trigger and no write calls the route again')
        assert.strictEqual(state.pendingTimeouts(STORE_FOLLOW_UP).length + state.pendingTimeouts(STORE_NOTE_CHANGE_DELAY).length, 0, 'or arms a store timer')
        assert.deepStrictEqual(later, [], 'and it warns only once')
        assert.ok(state.setHtmlCalls > paints, 'the panel goes on painting')
        assert.ok(state.panelHtml['panel-panel'].includes('Guarded to-do'), 'what it always painted')
    })

    await test('note store failure: a build whose page throws is retried by the next trigger, at most once per trigger, never by a follow-up', async () => {
        const state = await storeRun(storeNoteRange(1, 150))
        let failuresLeft = 2
        state.onListingPage = (query, items) => {
            if (query.order_by === 'id' && query.page === 2 && failuresLeft > 0){
                failuresLeft--
                throw new Error('the page failed')
            }
            return items
        }
        const heads = () => state.gets.filter(g => isEvents(g) && !hasCursor(g)).length
        const warnings = await storeWarnings(async () => {
            await state.fireTimeout(buildTimeout(state))
            assert.ok(!state.noteStore.isReady() && state.noteStore.isAvailable(), 'a failed build leaves the store not ready, but on')
            assert.strictEqual(storeModel(state).size(), 0, 'and the half-read walk is not swapped in')
            await state.syncCompleteHandler({ withErrors: false })
            assert.strictEqual(heads(), 2, 'the next trigger builds once')
            assert.ok(!state.noteStore.isReady(), 'and that build fails too')
            const before = storeGetsSince(state, 0).length
            await state.fireTimeout(state.pendingTimeouts(STORE_FOLLOW_UP)[0])
            assert.strictEqual(storeGetsSince(state, 0).length, before, 'the follow-up never builds')
            await storeTick(state)
            assert.strictEqual(heads(), 3, 'the trigger after that builds once more')
        })
        state.onListingPage = null
        assert.ok(state.noteStore.isReady(), 'and succeeds')
        assert.strictEqual(storeModel(state).size(), 150)
        assert.deepStrictEqual(warnings, [], 'two failures and a recovery are not worth a warning')
    })

    await test('note store failure: an events call that throws mid-session makes the store stale, and the next trigger rebuilds it', async () => {
        const state = await storeRun([storeNote(1), storeNote(2)])
        await buildStore(state)
        state.eventsFailNext = 1
        const warnings = await storeWarnings(async () => {
            await state.syncCompleteHandler({ withErrors: false })
            assert.strictEqual(state.noteStore.isReady(), false, 'a failed poll leaves the store stale')
            const before = storeGetsSince(state, 0).length
            await state.fireTimeout(state.pendingTimeouts(STORE_FOLLOW_UP)[0])
            assert.strictEqual(storeGetsSince(state, 0).length, before, 'the follow-up does not rebuild it')
            state.pushChange({ item_id: newStoreNote(state, 3).id, type: 1 })
            const mark = state.gets.length
            await storeTick(state)
            const shape = storeGetsSince(state, mark).map(g => isEvents(g) ? (hasCursor(g) ? 'events' : 'head') : isWalkPage(g) ? 'page' : 'fetch')
            assert.deepStrictEqual(shape, ['head', 'page', 'events'], 'the next trigger retakes the cursor, walks, and replays')
        })
        assert.ok(state.noteStore.isReady(), 'and the store is exact again')
        assert.deepStrictEqual(storeIds(state), [storeId(1), storeId(2), storeId(3)], 'including what changed while it was stale')
        assert.deepStrictEqual(warnings, [], 'without a warning')
    })

    await test('note store failure: three failed rebuilds in a row switch the store off for the session, with one warning', async () => {
        const state = await storeRun([storeNote(1)])
        await buildStore(state)
        state.eventsFailNext = 1
        await storeTick(state)
        assert.strictEqual(state.noteStore.isReady(), false, 'precondition: stale')
        state.eventsFailNext = 99
        const events = () => state.gets.filter(isEvents).length
        const counts = []
        const warnings = await storeWarnings(async () => {
            for (let attempt = 1; attempt <= 3; attempt++){
                const before = events()
                await storeTick(state)
                counts.push(`${events() - before}:${state.noteStore.isAvailable()}`)
            }
        })
        assert.deepStrictEqual(counts, ['1:true', '1:true', '1:false'], 'each trigger makes one attempt; the third failure ends it')
        assert.strictEqual(warnings.length, 1, 'with one warning')
        state.eventsFailNext = 0
        const before = events()
        await storeTick(state)
        assert.strictEqual(events() - before, 0, 'and the route is not called again')
    })

    await test('note store own writes: a tick of the checkbox updates the record at once, arms exactly one follow-up, and the late row changes nothing', async () => {
        const todo = storeNote(1, { is_todo: 1, title: 'Stored to-do', todo_due: Date.now() + 3600000 })
        const state = await storeRun([todo, storeNote(2)], { todos: [todo] })
        await buildStore(state)
        const mark = state.gets.length
        await state.panelMessageHandler(['todoChecked', todo.id, true])
        const put = state.notePuts[state.notePuts.length - 1]
        assert.ok(put.id === todo.id && put.fields.todo_completed > 0, 'precondition: setTodoCompleted wrote a completion time')
        assert.strictEqual(storeModel(state).get(todo.id).todo_completed, put.fields.todo_completed, 'the store has the write at once')
        assert.strictEqual(storeGetsSince(state, mark).length, 0, 'without asking the feed or fetching the note')
        const followUps = state.pendingTimeouts(STORE_FOLLOW_UP)
        assert.strictEqual(followUps.length, 1, 'exactly one follow-up poll is armed')
        // The feed's row lands after the save returned; the follow-up brings it as an ordinary upsert.
        state.pushChange({ item_id: todo.id, type: 2 })
        const revision = storeModel(state).revision
        const followMark = state.gets.length
        await state.fireTimeout(followUps[0])
        const seq = storeGetsSince(state, followMark)
        assert.strictEqual(seq.filter(isEvents).length, 1, 'firing it is one events call')
        assert.deepStrictEqual(seq.filter(isStoreFetch).map(g => g.path[1]), [todo.id], 'and the fetch of the note its row names')
        assert.strictEqual(storeModel(state).revision, revision, 'which changes nothing: the store already had the write')
        assert.strictEqual(state.pendingTimeouts(STORE_FOLLOW_UP).length, 0, 'and the follow-up arms no other')
    })

    await test('note store own writes: two to-dos dropped on a day update their dues in the store at once, with ONE follow-up after the last write', async () => {
        const todos = [1, 2].map(n => storeNote(n, { is_todo: 1, title: `Dropped to-do ${n}`, todo_due: Date.now() + 3600000 }))
        const state = await storeRun(todos, { todos })
        await buildStore(state)
        const mark = state.gets.length
        const timerMark = state.timeouts.length
        await state.panelMessageHandler(['todosDropped', todos.map(todo => todo.id), '2026-10-05'])
        for (const todo of todos){
            const put = state.notePuts.filter(entry => entry.id === todo.id).pop()
            assert.ok(put && put.fields.todo_due > 0, 'precondition: setTodoDueDates wrote a due time')
            assert.strictEqual(storeModel(state).get(todo.id).todo_due, put.fields.todo_due, 'the store has the new due at once')
        }
        assert.strictEqual(storeGetsSince(state, mark).length, 0, 'without a store call')
        // Each write arms the follow-up; the second arm MOVES it rather than adding one, so it still comes half a second after the LAST write.
        const armed = state.timeouts.slice(timerMark).filter(t => t.ms === STORE_FOLLOW_UP)
        assert.deepStrictEqual(armed.map(t => t.cleared), [true, false], 'the first write\'s follow-up is replaced by the second\'s')
        assert.strictEqual(state.pendingTimeouts(STORE_FOLLOW_UP).length, 1, 'so one follow-up is armed')
    })

    await test('note store triggers: a completed sync polls once and arms one follow-up', async () => {
        const state = await storeRun([storeNote(1)])
        await buildStore(state)
        const mark = state.gets.length
        await state.syncCompleteHandler({ withErrors: false })
        assert.strictEqual(storeGetsSince(state, mark).filter(isEvents).length, 1, 'one poll')
        const followUps = state.pendingTimeouts(STORE_FOLLOW_UP)
        assert.strictEqual(followUps.length, 1, 'one follow-up')
        await state.fireTimeout(followUps[0])
        assert.strictEqual(storeGetsSince(state, mark).filter(isEvents).length, 2, 'which polls once more')
        assert.strictEqual(state.pendingTimeouts(STORE_FOLLOW_UP).length, 0)
    })

    await test('note store triggers: a burst of three note changes is one debounced poll with one follow-up, and a change during a sync waits for its end', async () => {
        const state = await storeRun([storeNote(1), storeNote(2)])
        await buildStore(state)
        const mark = state.gets.length
        for (const id of [storeId(1), storeId(2), storeId(1)]) await state.noteChangeHandler({ id })
        assert.strictEqual(storeGetsSince(state, mark).length, 0, 'nothing yet: the burst is debounced')
        const debounce = state.pendingTimeouts(STORE_NOTE_CHANGE_DELAY)
        assert.strictEqual(debounce.length, 1, 'one debounce for the whole burst')
        await state.fireTimeout(debounce[0])
        assert.strictEqual(storeGetsSince(state, mark).filter(isEvents).length, 1, 'one poll')
        const followUps = state.pendingTimeouts(STORE_FOLLOW_UP)
        assert.strictEqual(followUps.length, 1, 'one follow-up')
        await state.fireTimeout(followUps[0])
        assert.strictEqual(storeGetsSince(state, mark).filter(isEvents).length, 2)
        await state.syncStartHandler()
        const syncMark = state.gets.length
        const timerMark = state.timeouts.length
        await state.noteChangeHandler({ id: storeId(2) })
        assert.strictEqual(state.timeouts.slice(timerMark).filter(t => t.ms === STORE_NOTE_CHANGE_DELAY).length, 0, 'a change during a sync arms no poll')
        await state.syncCompleteHandler({ withErrors: false })
        assert.strictEqual(storeGetsSince(state, syncMark).filter(isEvents).length, 1, 'the sync\'s completion polls once for all of it')
    })

    await test('note store single flight: a poll asked for while one runs is ONE more run after it, and a poll asked for during a build waits for it', async () => {
        const state = await storeRun(storeNoteRange(1, 150))
        const shapeOf = (seq) => seq.map(g => isEvents(g) ? (hasCursor(g) ? 'events' : 'head') : isWalkPage(g) ? 'page' : 'fetch')
        // Bounded, so a regression fails here instead of hanging the suite.
        const waitUntil = async (condition, what) => {
            for (let turn = 0; turn < 1000 && !condition(); turn++) await new Promise(resolve => setImmediate(resolve))
            assert.ok(condition(), `never reached: ${what}`)
        }
        await state.withTimers(async () => {
            let release
            const held = new Promise(resolve => { release = resolve })
            let holding = false
            state.onListingPage = async (query, items) => {
                if (query.order_by === 'id' && query.page === 1){ holding = true; await held }
                return items
            }
            const building = state.fireTimeout(buildTimeout(state))
            await waitUntil(() => holding, 'the build holding on its first page')
            const polled = state.noteStore.pollNow()
            assert.deepStrictEqual(shapeOf(storeGetsSince(state, 0)), ['head', 'page'], 'a poll asked for during the walk does not start alongside it')
            release()
            await Promise.all([building, polled])
            state.onListingPage = null
            assert.deepStrictEqual(shapeOf(storeGetsSince(state, 0)), ['head', 'page', 'page', 'events', 'events'],
                'it runs after the build and its replay')
        })
        assert.ok(state.noteStore.isReady())
        const mark = state.gets.length
        await state.withTimers(async () => {
            let release
            const held = new Promise(resolve => { release = resolve })
            let holding = false
            state.onEventsCall = async () => {
                if (holding) return
                holding = true
                await held
            }
            const first = state.noteStore.pollNow()
            await waitUntil(() => holding, 'the poll holding on its events call')
            const second = state.noteStore.pollNow()
            const third = state.noteStore.pollNow()
            assert.strictEqual(storeGetsSince(state, mark).length, 1, 'while one poll runs, no other starts')
            release()
            await Promise.all([first, second, third])
            state.onEventsCall = null
        })
        assert.strictEqual(storeGetsSince(state, mark).filter(isEvents).length, 2, 'the two asked for meanwhile run as ONE more poll, after it')
    })

    await test('note store build: a note the walk read and then lost during it leaves the store not ready, and the next trigger walks again', async () => {
        // The listing is paged by offset, so a note leaving it after its page was read shifts every later page left by one and the walk can step
        // over the note at the next boundary - one with no feed row of its own to bring it back. (This harness keeps trashed notes in its listing,
        // so nothing shifts here; what is checked is the rule that such a build is not trusted.)
        const state = await storeRun(storeNoteRange(1, 150))
        state.onListingPage = (query, items) => {
            if (query.order_by === 'id' && query.page === 2){
                state.notes[storeId(5)].deleted_time = 42
                state.pushChange({ item_id: storeId(5), type: 2 })
            }
            return items
        }
        const warnings = await storeWarnings(() => state.fireTimeout(buildTimeout(state)))
        state.onListingPage = null
        assert.strictEqual(storeModel(state).get(storeId(5)), undefined, 'the replay removed the trashed note')
        assert.ok(!state.noteStore.isReady() && state.noteStore.isAvailable(), 'but the build is not trusted, and it is not a failure either')
        assert.deepStrictEqual(warnings, [])
        const mark = state.gets.length
        await storeTick(state)
        assert.strictEqual(storeGetsSince(state, mark).filter(g => isEvents(g) && !hasCursor(g)).length, 1, 'the next trigger walks again')
        assert.ok(state.noteStore.isReady(), 'and that walk, undisturbed, is trusted')
        assert.strictEqual(storeModel(state).size(), 149)
    })

    await test('note store failure: only CONSECUTIVE failed builds count - two, a success, then two more leave the store on', async () => {
        const state = await storeRun(storeNoteRange(1, 150))
        let failuresLeft = 2
        state.onListingPage = (query, items) => {
            if (query.order_by === 'id' && query.page === 2 && failuresLeft > 0){
                failuresLeft--
                throw new Error('the page failed')
            }
            return items
        }
        const warnings = await storeWarnings(async () => {
            await state.fireTimeout(buildTimeout(state))                 // failure 1
            await storeTick(state)                                        // failure 2
            await storeTick(state)                                        // a success resets the count
            assert.ok(state.noteStore.isReady(), 'precondition: the third build succeeded')
            state.eventsFailNext = 1
            await storeTick(state)                                        // a failed poll: stale, which is not a failed build
            failuresLeft = 2
            await storeTick(state)                                        // failure 3 in all, 1 in a row
            await storeTick(state)                                        // failure 4 in all, 2 in a row
        })
        state.onListingPage = null
        assert.strictEqual(failuresLeft, 0, 'precondition: both later builds failed')
        assert.strictEqual(state.noteStore.isAvailable(), true, 'four failures, but never three in a row: the store stays on')
        assert.deepStrictEqual(warnings, [])
        await storeTick(state)
        assert.ok(state.noteStore.isReady(), 'and the next build succeeds')
    })

    await test('note store build: more than 200 notes changing during the walk leave it not ready - one walk, no fetch, no build inside the build', async () => {
        const state = await storeRun(storeNoteRange(1, 150))
        // Once only, so a build that did recurse would show as a second walk rather than recurse for ever.
        let changed = false
        state.onListingPage = (query, items) => {
            if (query.order_by === 'id' && query.page === 1 && !changed){
                changed = true
                for (let i = 0; i < 201; i++) state.pushChange({ item_id: newStoreNote(state, 1000 + i).id, type: 1 })
            }
            return items
        }
        const warnings = await storeWarnings(() => state.fireTimeout(buildTimeout(state)))
        state.onListingPage = null
        const seq = storeGetsSince(state, 0)
        assert.strictEqual(seq.filter(g => isEvents(g) && !hasCursor(g)).length, 1, 'one cursor taken: the replay never calls build() from inside build()')
        assert.deepStrictEqual(seq.filter(isWalkPage).map(g => g.query.page), [1, 2, 3, 4], 'one walk')
        assert.strictEqual(seq.filter(isStoreFetch).length, 0, 'and not one per-id fetch for the replay it cannot finish')
        assert.ok(!state.noteStore.isReady() && state.noteStore.isAvailable(), 'the build ends not ready, which is not a failure')
        assert.deepStrictEqual(warnings, [])
        const mark = state.gets.length
        await storeTick(state)
        assert.strictEqual(storeGetsSince(state, mark).filter(g => isEvents(g) && !hasCursor(g)).length, 1, 'the next trigger walks again')
        assert.ok(state.noteStore.isReady())
        assert.strictEqual(storeModel(state).size(), 351)
    })

    await test('note store failure: a fetch by id that fails with anything but Not Found makes the store stale, silently, and the next trigger rebuilds it', async () => {
        const state = await storeRun([storeNote(1), storeNote(2)])
        await buildStore(state)
        state.notes[storeId(1)].title = 'Renamed'
        state.pushChange({ item_id: storeId(1), type: 2 })
        let failed = false
        state.onNoteGet = (id, query) => {
            if (failed || !(query && (query.fields || []).includes('is_conflict'))) return
            failed = true
            throw new Error('SQLITE_BUSY: database is locked')
        }
        const warnings = await storeWarnings(async () => {
            await storeTick(state)
            assert.ok(failed, 'precondition: the fetch failed')
            assert.strictEqual(state.noteStore.isReady(), false, 'the store is stale')
            const mark = state.gets.length
            await storeTick(state)
            const shape = storeGetsSince(state, mark).map(g => isEvents(g) ? (hasCursor(g) ? 'events' : 'head') : isWalkPage(g) ? 'page' : 'fetch')
            assert.deepStrictEqual(shape, ['head', 'page', 'events'], 'the next trigger retakes the cursor, walks, and replays')
        })
        state.onNoteGet = null
        assert.ok(state.noteStore.isReady())
        assert.strictEqual(storeModel(state).get(storeId(1)).title, 'Renamed', 'and the change the failed fetch was after is in')
        assert.deepStrictEqual(warnings, [], 'without a warning')
    })

    await test('note store triggers: a tick during a sync makes no store call, and the completed sync catches up once', async () => {
        const state = await storeRun([storeNote(1)])
        await buildStore(state)
        await state.syncStartHandler()
        const mark = state.gets.length
        await storeTick(state)
        assert.strictEqual(storeGetsSince(state, mark).length, 0, 'the tick leaves the store alone while a sync runs')
        await state.syncCompleteHandler({ withErrors: false })
        assert.strictEqual(storeGetsSince(state, mark).filter(isEvents).length, 1, 'the completion polls once')
    })

    await test('note store large drain: a drain that passes the threshold on page 3 of 5 reads exactly 3 events pages before the walk', async () => {
        // 100 rows a page and "more than 200" fetches: page 3 is the earliest a drain can pass the threshold.
        const state = await storeRun([storeNote(1)])
        await buildStore(state)
        for (let i = 0; i < 450; i++) state.pushChange({ item_id: newStoreNote(state, 1000 + i).id, type: 1 })
        const mark = state.gets.length
        await storeTick(state)
        const shape = storeGetsSince(state, mark).map(g => isEvents(g) ? (hasCursor(g) ? 'events' : 'head') : isWalkPage(g) ? 'page' : 'fetch')
        assert.deepStrictEqual(shape, ['events', 'events', 'events', 'head', 'page', 'page', 'page', 'page', 'page', 'events'],
            'three of the five feed pages, then the cursor retaken, the walk and its replay - the last two feed pages are never read')
        assert.strictEqual(storeModel(state).size(), 451)
        assert.ok(state.noteStore.isReady())
    })

    await test('note store build: over three pages of a real listing, a note trashed after page 1 read it makes the walk miss the page-2/3 boundary note, and the next walk brings it back', async () => {
        // listingExcludesGone serves the listing as the route does, without trashed notes, so the trash really shifts page 3 left by one.
        const state = await storeRun(storeNoteRange(1, 250), { listingExcludesGone: true })
        state.onListingPage = (query, items) => {
            if (query.order_by === 'id' && query.page === 2){
                state.notes[storeId(5)].deleted_time = 42
                state.pushChange({ item_id: storeId(5), type: 2 })
            }
            return items
        }
        await state.fireTimeout(buildTimeout(state))
        state.onListingPage = null
        assert.strictEqual(storeGetsSince(state, 0).filter(isWalkPage).length, 3, 'precondition: a three-page walk')
        assert.strictEqual(storeModel(state).get(storeId(201)), undefined, 'the note at the page-2/3 boundary was stepped over')
        assert.strictEqual(storeModel(state).get(storeId(5)), undefined, 'and the trashed note is gone')
        assert.ok(!state.noteStore.isReady(), 'so the build is not trusted')
        await storeTick(state)
        assert.ok(storeModel(state).get(storeId(201)), 'the next trigger\'s walk brings the missed note back')
        assert.ok(state.noteStore.isReady())
        assert.strictEqual(storeModel(state).size(), 249)
    })

    await test('note store audit: every joplin chain in noteStore.ts is a data.get, called in the same expression', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'noteStore.ts'), 'utf8')
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        const chains = code.match(/\bjoplin\s*[.[][\w.\s[\]'"]*\(?/g) || []
        assert.strictEqual(chains.length, 4, 'the guard or cursor call, the walk, the drain and the fetch by id')
        assert.ok(chains.every(chain => chain.replace(/\s+/g, '') === 'joplin.data.get('), `every one is joplin.data.get( - found ${chains.join(', ')}`)
    })

    // ============================================================ note store reads (2.7 phase 3): the unfiltered views read the mirror
    // Once the store is ready, a view with no profile criteria, nothing typed and no any:1 is computed from the mirror (readStoreTodos / readStoreNotes
    // in src/core/joplin.ts) with no search, no listing and no per-id read; a view that needs the search engine keeps it, byte for byte. A change the
    // store hears of renders through timer.ts's note store lane (one fast render per burst, a captured timeout of STORE_RENDER_DELAY), the reconcile
    // lane drains the store before its render, and the panel's own writes (panel.ts) tell the store at once. Each fixture set serves the search
    // (todos / searchNotes) and the store (the note map, listingFromNotes) from the same notes, so the two paths can be held against each other.
    const STORE_RENDER_DELAY = 0
    const readSub = 'e'.repeat(31) + '2'
    const readArchive = 'e'.repeat(31) + '3'
    const readQuoted = 'e'.repeat(31) + '4'
    const readFolders = [
        { id: storeFolder, title: 'Store', parent_id: '' },
        { id: readSub, title: 'Sub', parent_id: storeFolder },
        { id: readArchive, title: 'Archive', parent_id: '' },
        { id: readQuoted, title: 'Say "hi"', parent_id: '' },
    ]
    const HOUR = 3600000
    const DAY = 24 * HOUR
    const readTodo = (n, extra) => storeNote(n, Object.assign({ is_todo: 1, title: `Read todo ${n}`, todo_due: Date.now() + 2 * DAY + n * HOUR }, extra || {}))
    const readNote = (n, extra) => storeNote(n, Object.assign({ title: `Read note ${n}` }, extra || {}))
    const readProfileData = (profiles) => JSON.stringify({ nextID: profiles.length + 1, profiles: profiles.map((profile, index) =>
        ({ ...baseProfile, showNotes: true, id: index + 1, sortOrder: index, noteID: '', ...profile })) })
    // The search's fixtures are COPIES taken at the start: they are the index, and a check that changes a note afterwards is changing what only the
    // mirror (and the listing) can see, exactly as the index lags a real change.
    const readRun = async (items, extra) => await storeRun(items, Object.assign({
        todos: items.filter(item => item.is_todo).map(item => ({ ...item })),
        searchNotes: items.filter(item => !item.is_todo).map(item => ({ ...item })),
        folders: readFolders,
    }, extra || {}))
    // Every data call a refresh could make of the notes themselves: the search, the listing, a read by id, the change feed. The ring fill's
    // body-only reads and the notebook map's folder pages are left out - neither is what the store replaces.
    const isBodyRead = (g) => g.path[0] === 'notes' && g.path.length === 2 && g.query && Array.isArray(g.query.fields) && g.query.fields.length === 1 && g.query.fields[0] === 'body'
    const noteCallsSince = (state, mark) => state.gets.slice(mark).filter(g => g.path[0] === 'search' || g.path[0] === 'events' || (g.path[0] === 'notes' && !isBodyRead(g)))
    const searchesSince = (state, mark) => state.gets.slice(mark).filter(g => g.path[0] === 'search')
    // A truth render (the profile switch's truth refresh, a notebook-filter change) drains the store once first: one events call, which finds
    // nothing on a quiet store, so what such a render costs is exactly that many events calls and nothing else.
    const drainsOnly = (count) => Array.from({ length: count }, () => 'events')
    const countedSince = (state, before) => {
        const now = state.instrument.snapshot()
        return Object.fromEntries(Object.keys(now).map(key => [key, now[key] - before[key]]))
    }
    // The panel as a list of tokens, in order: "# heading" for every section heading, "todo <id>" / "note <id>" for every row.
    const readSections = (state) => {
        const html = String(state.panelHtml['panel-panel'] || '')
        const tokens = []
        const pattern = /<h2[^>]*>([^<]*)<\/h2>|data-(todo|note)-id="([^"]+)"/g
        let match
        while ((match = pattern.exec(html))) tokens.push(match[1] !== undefined ? `# ${match[1]}` : `${match[2]} ${match[3]}`)
        return tokens
    }
    const pendingStoreRenders = (state) => state.pendingTimeouts(STORE_RENDER_DELAY)
    const fireStoreRender = async (state) => {
        const pending = pendingStoreRenders(state)
        assert.strictEqual(pending.length, 1, `one store render is armed (found ${pending.length})`)
        await state.fireTimeout(pending[0])
    }
    const buildAndRender = async (state) => {
        await buildStore(state)
        await fireStoreRender(state)
    }
    // Counts the reads of the mirror itself, so a check can tell a result served from the cache from one computed afresh.
    const spyStoreReads = (state) => {
        const model = storeModel(state)
        const reads = { todos: 0, notes: 0 }
        const todosOf = model.todos, notesOf = model.notes
        model.todos = () => { reads.todos++; return todosOf() }
        model.notes = () => { reads.notes++; return notesOf() }
        return reads
    }
    const readMix = () => { const sameDue = Date.now() + 5 * DAY; return [
        readTodo(1, { todo_due: Date.now() - 2 * DAY }),                                   // overdue
        readTodo(2),
        readTodo(3, { todo_due: Date.now() + 9 * DAY }),
        readTodo(4, { todo_due: 0, title: 'Undated beta' }),
        readTodo(5, { todo_due: 0, title: 'Undated alpha' }),
        readTodo(6, { todo_completed: Date.now() - DAY, todo_due: Date.now() - DAY }),       // completed, past
        readTodo(7, { todo_due: sameDue, title: 'Same day beta' }),
        readTodo(8, { todo_due: sameDue, title: 'Same day alpha' }),                        // the same due as 7: title decides
        readTodo(9, { parent_id: readSub }),
        readNote(20, { user_updated_time: 9000 }), readNote(21, { user_updated_time: 9500 }), readNote(22, { user_updated_time: 8000, parent_id: readSub }),
        readNote(23, { user_updated_time: 7000, title: 'Zulu' }), readNote(24, { user_updated_time: 7100, title: 'alpha' }),
    ] }

    await test('note store reads: with the store ready an unfiltered refresh makes no search, no listing and no read by id, and draws exactly what the search path drew', async () => {
        const state = await readRun(readMix())
        const searchPath = readSections(state)
        let mark = state.gets.length
        await state.panelMessageHandler(['sortDirectionClicked'])
        assert.ok(searchesSince(state, mark).length > 0, 'precondition: before the store is ready the to-dos come from the search')
        const searchPathDesc = readSections(state)
        await state.panelMessageHandler(['sortDirectionClicked'])
        assert.deepStrictEqual(readSections(state), searchPath, 'precondition: back where it started')
        await buildAndRender(state)
        mark = state.gets.length
        const counted = state.instrument.snapshot()
        await state.panelMessageHandler(['sortDirectionClicked'])
        const storeDesc = readSections(state)
        await state.panelMessageHandler(['sortDirectionClicked'])
        const storePath = readSections(state)
        assert.deepStrictEqual(noteCallsSince(state, mark), [], 'two full refreshes read nothing but the mirror')
        const delta = countedSince(state, counted)
        assert.deepStrictEqual([delta.search, delta.listing, delta.get, delta.events], [0, 0, 0, 0], 'and the instrument counters agree')
        assert.deepStrictEqual(storePath, searchPath, 'the same sections, rows and order as the search path, ascending')
        assert.deepStrictEqual(storeDesc, searchPathDesc, 'and descending')
        assert.ok(searchPath.includes('# Notes') && searchPath.includes(`todo ${storeId(6)}`) && searchPath.includes(`note ${storeId(22)}`),
            'the comparison covers both sections, a completed to-do and a sub-notebook note')
        assert.ok(searchPath.indexOf(`todo ${storeId(8)}`) < searchPath.indexOf(`todo ${storeId(7)}`), 'a shared due date is ordered by title')
    })

    await test('note store reads: the Notes cap - 1,001 notes draw 1,000 with the footer, "show more" draws the rest from the mirror and drops it; 1,000 and 999 draw no footer', async () => {
        const capped = await readRun(Array.from({ length: 1001 }, (_, i) => readNote(i + 1)))
        await buildAndRender(capped)
        let mark = capped.gets.length
        await capped.panelMessageHandler(['sortDirectionClicked'])
        assert.strictEqual(noteRows(capped), 1000, 'the cap holds on the store path')
        assert.ok(capped.panelHtml['panel-panel'].includes('Showing the 1000 most recently updated notes'), 'with the footer')
        assert.ok(!capped.panelHtml['panel-panel'].includes('>Read note 1<'), 'the oldest note is the one left out')
        await capped.panelMessageHandler(['showMoreNotes'])
        assert.strictEqual(noteRows(capped), 1001, '"show more" brings the last one')
        assert.ok(!capped.panelHtml['panel-panel'].includes('notes-more-message'), 'and the footer goes')
        assert.deepStrictEqual(noteCallsSince(capped, mark), [], 'neither the capped read nor the next batch made a data call')
        for (const count of [1000, 999]){
            const under = await readRun(Array.from({ length: count }, (_, i) => readNote(i + 1)))
            await buildAndRender(under)
            mark = under.gets.length
            await under.panelMessageHandler(['sortDirectionClicked'])
            assert.deepStrictEqual(noteCallsSince(under, mark), [], 'precondition: store-served')
            assert.strictEqual(noteRows(under), count)
            assert.ok(!under.panelHtml['panel-panel'].includes('notes-more-message'), `${count} notes draw no footer: nothing was left out`)
        }
    })

    await test('note store reads: the cap counts only what the view shows - excluded notes and other notebooks\' notes are narrowed out before it', async () => {
        // 150 excluded notes are the newest of all, and 1,050 notes in Store are all newer than the five in the quoted notebook: a cap counted before
        // either narrowing would spend itself on notes that are never drawn.
        const items = Array.from({ length: 1050 }, (_, i) => readNote(i + 1, { user_updated_time: 2000 + i }))
            .concat(Array.from({ length: 150 }, (_, i) => readNote(2001 + i, { user_updated_time: 9000 + i, parent_id: readArchive })))
            .concat(Array.from({ length: 5 }, (_, i) => readNote(3001 + i, { user_updated_time: 100 + i, parent_id: readQuoted })))
        const state = await readRun(items, {
            initialSettings: { profileData: readProfileData([{ name: 'All' }]), currentProfileID: 1, excludedNotebookIds: readArchive },
        })
        await buildAndRender(state)
        const mark = state.gets.length
        await state.panelMessageHandler(['sortDirectionClicked'])
        assert.strictEqual(noteRows(state), 1000, 'a full cap of drawn notes: the 150 excluded ones did not use any of it')
        assert.ok(!state.panelHtml['panel-panel'].includes(storeId(2001)), 'and none of them is drawn')
        await state.panelMessageHandler(['notebookFilterChanged', readQuoted])
        assert.strictEqual(noteRows(state), 5, 'the quoted notebook\'s five notes, though 1,050 newer ones live elsewhere')
        assert.ok(!state.panelHtml['panel-panel'].includes('notes-more-message'), 'and nothing of it was left out')
        assert.deepStrictEqual(noteCallsSince(state, mark).map(g => g.path[0]), drainsOnly(1), 'all of it from the mirror: the filter change\'s one drain is the only call')
    })

    await test('note store reads: the Notes cap keeps what the listing keeps - newest first, and on a tie of user_updated_time the larger id', async () => {
        const tieLow = 'e'.repeat(24) + 'a0000001'
        const tieHigh = 'e'.repeat(24) + 'a0000002'
        const recent = Array.from({ length: 999 }, (_, i) => readNote(i + 1, { user_updated_time: 5000 + i }))
        // Listed in the fixtures with the smaller id LAST, so neither the fixture order nor the search stub can be what decides.
        const state = await readRun(recent.concat([
            storeNote(0, { id: tieHigh, title: 'Tie high', user_updated_time: 1000 }),
            storeNote(0, { id: tieLow, title: 'Tie low', user_updated_time: 1000 }),
        ]))
        await buildAndRender(state)
        await state.panelMessageHandler(['sortDirectionClicked'])
        const html = state.panelHtml['panel-panel']
        assert.strictEqual(noteRows(state), 1000)
        assert.ok(html.includes(`data-note-id="${tieHigh}"`) && !html.includes(`data-note-id="${tieLow}"`), 'ORDER BY user_updated_time DESC, id DESC keeps the larger id')
        assert.ok(html.includes('notes-more-message'), 'and the smaller one is the "more"')
    })

    await test('note store reads: to-dos sharing a due date AND a title are ordered by id on the store path', async () => {
        const due = Date.now() + 3 * DAY
        const first = 'e'.repeat(24) + 'b0000001'
        const second = 'e'.repeat(24) + 'b0000002'
        const state = await readRun([storeNote(0, { id: second, is_todo: 1, title: 'Twin', todo_due: due })])
        await buildAndRender(state)
        // The smaller id arrives through the feed AFTER the build, so the mirror holds it second: neither the walk's id order nor the order the
        // records went in can be what puts it first.
        state.notes[first] = storeNote(0, { id: first, is_todo: 1, title: 'Twin', todo_due: due })
        state.pushChange({ item_id: first, type: 1 })
        await state.withTimers(() => state.noteStore.pollNow())
        assert.deepStrictEqual(storeModel(state).todos().map(record => record.id), [second, first], 'precondition: the mirror holds them larger id first')
        await state.panelMessageHandler(['sortDirectionClicked'])
        await state.panelMessageHandler(['sortDirectionClicked'])
        const rows = readSections(state).filter(token => token.startsWith('todo '))
        assert.deepStrictEqual(rows, [`todo ${first}`, `todo ${second}`], 'todo_due, then title, then id - whatever order the fixtures came in')
    })

    await test('note store reads: excluded notebooks and the notebook filter apply on the store path - a sub-notebook, and a title the query cannot name', async () => {
        const items = [
            readTodo(1), readNote(2),                                                     // Store
            readTodo(3, { parent_id: readSub }), readNote(4, { parent_id: readSub }),     // Store / Sub
            readTodo(5, { parent_id: readArchive }), readNote(6, { parent_id: readArchive }),   // Archive, excluded
            readTodo(7, { parent_id: readQuoted }), readNote(8, { parent_id: readQuoted }),     // Say "hi"
        ]
        const state = await readRun(items, {
            initialSettings: { profileData: readProfileData([{ name: 'All' }]), currentProfileID: 1, excludedNotebookIds: readArchive },
        })
        const views = {}
        const look = async (label, filter) => {
            await state.panelMessageHandler(['notebookFilterChanged', filter])
            views[label] = readSections(state)
        }
        await look('all, search', '')
        await look('Store, search', storeFolder)
        await look('quoted, search', readQuoted)
        await state.panelMessageHandler(['notebookFilterChanged', ''])
        await buildAndRender(state)
        // A to-do outside Store changes, so its ring is stale: a Store view that narrowed only AFTER the ring fill would read its body for nothing.
        state.notes[storeId(7)].user_updated_time = 99999
        state.pushChange({ item_id: storeId(7), type: 2 })
        await state.withTimers(() => state.noteStore.pollNow())
        const mark = state.gets.length
        await look('Store, store', storeFolder)
        assert.ok(!state.gets.slice(mark).some(g => isBodyRead(g) && g.path[1] === storeId(7)), 'the notebook narrows the to-dos before their rings are filled')
        await look('quoted, store', readQuoted)
        await look('all, store', '')
        assert.deepStrictEqual(noteCallsSince(state, mark).map(g => g.path[0]), drainsOnly(3), 'every view here is read from the mirror: three filter changes, three drains, nothing else')
        const ids = (tokens) => tokens.filter(token => !token.startsWith('#')).map(token => token.split(' ')[1]).sort()
        assert.deepStrictEqual(ids(views['all, store']), [1, 2, 3, 4, 7, 8].map(storeId).sort(), 'the excluded notebook is left out')
        assert.deepStrictEqual(ids(views['Store, store']), [1, 2, 3, 4].map(storeId).sort(), 'a notebook brings its sub-notebook with it')
        assert.deepStrictEqual(ids(views['quoted, store']), [7, 8].map(storeId).sort(), 'a quoted title narrows by id like any other')
        for (const view of ['all', 'Store', 'quoted']) assert.deepStrictEqual(views[`${view}, store`], views[`${view}, search`], `${view}: exactly what the 2.6.3 path drew`)
    })

    await test('note store reads: the completed and undated switches apply on the store path', async () => {
        const items = [
            readTodo(1),                                                                      // open, dated
            readTodo(2, { todo_due: 0 }),                                                      // open, undated
            readTodo(3, { todo_completed: Date.now() - DAY, todo_due: Date.now() - 2 * DAY }),  // completed, past
            readTodo(4, { todo_completed: Date.now() - DAY, todo_due: Date.now() + 3 * DAY }),  // completed, future
            readTodo(5, { todo_completed: Date.now() - DAY, todo_due: 0 }),                     // completed, undated
        ]
        const hidden = { showCompletedPast: false, showCompletedToday: false, showCompletedFuture: false, showCompletedNoDue: false }
        const state = await readRun(items, { initialSettings: { profileData: readProfileData([
            { name: 'Open and dated', ...hidden, showNoDue: false, showNotes: false },
            { name: 'Past completed', ...hidden, showCompletedPast: true, showNoDue: true, showNotes: false },
        ]), currentProfileID: 1 } })
        await buildAndRender(state)
        const mark = state.gets.length
        const shown = () => readSections(state).filter(token => token.startsWith('todo ')).map(token => token.split(' ')[1]).sort()
        await state.panelMessageHandler(['sortDirectionClicked'])
        assert.deepStrictEqual(shown(), [storeId(1)], 'no completed and no undated to-do')
        await state.panelMessageHandler(['profilesDropdownChanged', 2])
        assert.deepStrictEqual(shown(), [1, 2, 3].map(storeId).sort(), 'undated shown, and of the completed ones only the past one')
        assert.deepStrictEqual(noteCallsSince(state, mark).map(g => g.path[0]), drainsOnly(1), 'both views and the switch between them read only the mirror: the switch\'s one drain is the only call')
    })

    await test('note store reads: a to-do whose is_todo flips in the store moves section on the next render, with no search', async () => {
        const flipTodo = readTodo(1)
        const flipNote = readNote(2)
        const state = await readRun([flipTodo, flipNote])
        await buildAndRender(state)
        assert.ok(readSections(state).includes(`todo ${flipTodo.id}`) && readSections(state).includes(`note ${flipNote.id}`), 'precondition')
        Object.assign(state.notes[flipTodo.id], { is_todo: 0 })
        Object.assign(state.notes[flipNote.id], { is_todo: 1, todo_due: Date.now() + 3 * DAY })
        state.pushChange({ item_id: flipTodo.id, type: 2 })
        state.pushChange({ item_id: flipNote.id, type: 2 })
        const mark = state.gets.length
        await storeTick(state)
        // Phase 4: with every view store-served the tick draws its own drain, once, and takes back the store render the drain armed.
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'the tick drew the drain itself: no store render is left to draw it again')
        const tokens = readSections(state)
        assert.ok(tokens.includes(`note ${flipTodo.id}`) && !tokens.includes(`todo ${flipTodo.id}`), 'the ex-to-do is a note now, once')
        assert.ok(tokens.includes(`todo ${flipNote.id}`) && !tokens.includes(`note ${flipNote.id}`), 'the ex-note a to-do, once')
        assert.strictEqual(searchesSince(state, mark).length, 0, 'and no search ran, while the stale index still files both under their old type')
    })

    await test('note store reads: readiness flips mid-session - the 2.6.3 paths until the build, the mirror after it, back to 2.6.3 while stale, the mirror again once rebuilt', async () => {
        const state = await readRun(readMix())
        const refresh = async () => {
            const mark = state.gets.length
            await state.panelMessageHandler(['sortDirectionClicked'])
            const calls = noteCallsSince(state, mark)
            return { search: calls.filter(g => g.path[0] === 'search').length, listing: calls.filter(g => g.path[0] === 'notes' && g.path.length === 1).length }
        }
        const before = await refresh()
        assert.ok(before.search > 0 && before.listing > 0, 'not ready: the to-dos come from the search and the notes from the listing')
        const mark = state.gets.length
        await buildAndRender(state)
        assert.strictEqual(searchesSince(state, mark).length, 0, 'the render the finished build arms is itself store-served')
        assert.deepStrictEqual(await refresh(), { search: 0, listing: 0 }, 'ready: neither')
        state.eventsFailNext = 1
        await state.withTimers(() => state.noteStore.pollNow())
        assert.strictEqual(state.noteStore.isReady(), false, 'precondition: a failed poll leaves the store stale')
        const stale = await refresh()
        assert.ok(stale.search > 0 && stale.listing > 0, 'stale: back on the 2.6.3 paths at once')
        await storeTick(state)
        assert.ok(state.noteStore.isReady(), 'precondition: the next trigger rebuilt it')
        assert.deepStrictEqual(await refresh(), { search: 0, listing: 0 }, 'rebuilt: the mirror again')
    })

    await test('note store reads: with the change feed missing, the 2.6.3 paths run for the whole session', async () => {
        const state = await readRun(readMix(), { eventsUnavailable: true })
        await state.fireTimeout(buildTimeout(state))
        assert.strictEqual(state.noteStore.isAvailable(), false, 'precondition: the store is off')
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'and nothing was rendered for it')
        const mark = state.gets.length
        await state.panelMessageHandler(['sortDirectionClicked'])
        await storeTick(state)
        await state.syncCompleteHandler({ withErrors: false })
        const calls = noteCallsSince(state, mark)
        assert.ok(calls.some(g => g.path[0] === 'search') && calls.some(g => g.path[0] === 'notes' && g.path.length === 1), 'the search and the listing, as in 2.6.3')
        assert.ok(!calls.some(g => g.path[0] === 'events'), 'and the feed is never asked again')
    })

    await test('note store reads: filtered, typed and any:1 views send the very same searches with the store ready as without it', async () => {
        const state = await readRun(readMix(), { initialSettings: { profileData: readProfileData([{ name: 'Work', searchCriteria: 'tag:work' }]), currentProfileID: 1 } })
        const searchesOf = async (message) => {
            const mark = state.gets.length
            await state.panelMessageHandler(message)
            return searchesSince(state, mark).map(g => JSON.stringify([g.path, g.query]))
        }
        const script = [['sortDirectionClicked'], ['searchFilterChanged', 'milk'], ['searchFilterChanged', 'tag:one tag:two any:1'], ['searchFilterChanged', '']]
        const without = []
        for (const message of script) without.push(await searchesOf(message))
        await buildStore(state)
        const reads = spyStoreReads(state)
        const withStore = []
        for (const message of script) withStore.push(await searchesOf(message))
        assert.ok(without.every(queries => queries.length > 0), 'precondition: every step searches')
        assert.deepStrictEqual(withStore, without, 'byte for byte, page for page')
        assert.deepStrictEqual(reads, { todos: 0, notes: 0 }, 'and the mirror is not read for any of them')
    })

    await test('note store reads: the overview notes and the calendar formats read the mirror when unfiltered - no search while regenerating', async () => {
        const todo = readTodo(1, { todo_due: Date.now() })
        const overview = storeNote(90, { id: 'ov'.padEnd(32, '0'), title: 'Overview', body: 'stale' })
        const state = await readRun([todo, overview], { initialSettings: { profileData: readProfileData([
            { name: 'Overview', noteID: overview.id, showNotes: false },
            { name: 'Month', displayFormat: 'month', showNotes: false },
            { name: 'Week', displayFormat: 'week', showNotes: false },
        ]), currentProfileID: 1 } })
        await buildAndRender(state)
        // A rename only the mirror knows of: the stub's search still answers the old title, so a note that shows the new one read the mirror.
        state.notes[todo.id].title = 'Renamed in the mirror'
        state.pushChange({ item_id: todo.id, type: 2 })
        await state.withTimers(() => state.noteStore.pollNow())
        const mark = state.gets.length
        await storeTick(state)
        const written = state.notePuts.filter(put => put.id === overview.id).pop()
        assert.ok(written && written.body.includes('Renamed in the mirror'), 'the overview note was regenerated from the mirror')
        assert.strictEqual(searchesSince(state, mark).length, 0, 'with no search')
        for (const [profile, label] of [[2, 'month'], [3, 'week']]){
            const switchMark = state.gets.length
            await state.panelMessageHandler(['profilesDropdownChanged', profile])
            await state.panelMessageHandler(['calendarNavigate', 1])
            await state.panelMessageHandler(['calendarNavigate', -1])
            assert.strictEqual(searchesSince(state, switchMark).length, 0, `the ${label} view makes no search either`)
        }
        assert.ok(state.panelHtml['panel-panel'].includes('Renamed in the mirror'), 'and draws what the mirror holds')
    })

    await test('note store reads: a drain that changes the mirror arms ONE render, which reads no note but the ring of the one that changed; a drain that changes nothing arms none; the ring follows the mirror\'s stamp', async () => {
        const state = await readRun([readTodo(1), readNote(2)])
        await buildAndRender(state)
        state.notes[storeId(1)].title = 'Renamed by another device'
        state.notes[storeId(1)].user_updated_time = 77777
        state.pushChange({ item_id: storeId(1), type: 2 })
        let mark = state.gets.length
        await state.withTimers(() => state.noteStore.pollNow())
        const drain = noteCallsSince(state, mark)
        assert.deepStrictEqual(drain.map(g => g.path[0]), ['events', 'notes'], 'precondition: the drain is its own two calls')
        assert.strictEqual(pendingStoreRenders(state).length, 1, 'one render is armed')
        mark = state.gets.length
        const paints = state.setHtmlCalls
        const bodies = countBodyFetches(state)
        await fireStoreRender(state)
        assert.strictEqual(state.setHtmlCalls, paints + 1, 'it paints once')
        assert.ok(state.panelHtml['panel-panel'].includes('Renamed by another device'), 'with the change')
        assert.deepStrictEqual(noteCallsSince(state, mark), [], 'reading nothing but the mirror')
        // Phase 4: every view here is store-served, so no reconcile lane follows the render to read the changed ring - the render fills it itself.
        assert.strictEqual(countBodyFetches(state), bodies + 1, 'and one note body: the fill after the fast paint reads the changed note\'s ring')
        // The follow-up pollNow armed finds nothing new, and nothing new is nothing to render.
        await state.fireTimeout(state.pendingTimeouts(STORE_FOLLOW_UP)[0])
        const tickMark = state.gets.length
        await storeTick(state)
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'an empty drain, and an idle tick, arm no render')
        // The ring's body cache is stamped with the mirror's user_updated_time: the store render's fill re-read exactly the note whose stamp moved, so
        // the tick finds every ring current and reads none.
        assert.deepStrictEqual(state.gets.slice(tickMark).filter(isBodyRead).map(g => g.path[1]), [], 'the tick reads no body: the store render already read the changed one')
    })

    await test('note store reads: a burst - a drain and the rerun asked for while it ran, both changing the mirror - is one notification and one render', async () => {
        const state = await readRun([readTodo(1), readTodo(2), readNote(3)])
        await buildAndRender(state)
        let heard = 0
        state.noteStore.subscribe(() => heard++)
        state.notes[storeId(1)].title = 'First change'
        state.pushChange({ item_id: storeId(1), type: 2 })
        await state.withTimers(async () => {
            let release
            const held = new Promise(resolve => { release = resolve })
            let holding = false
            state.onNoteGet = async (id) => { if (id === storeId(1) && !holding){ holding = true; await held } }
            const first = state.noteStore.pollNow()
            for (let turn = 0; turn < 1000 && !holding; turn++) await new Promise(resolve => setImmediate(resolve))
            assert.ok(holding, 'precondition: the first drain is held on its fetch')
            state.notes[storeId(2)].title = 'Second change'
            state.pushChange({ item_id: storeId(2), type: 2 })
            const second = state.noteStore.pollNow()
            release()
            await Promise.all([first, second])
            state.onNoteGet = null
        })
        assert.strictEqual(storeModel(state).get(storeId(2)).title, 'Second change', 'precondition: the rerun ran and changed the mirror too')
        assert.strictEqual(heard, 1, 'the store tells its listeners once for the burst')
        assert.strictEqual(pendingStoreRenders(state).length, 1, 'and one render is armed for it')
    })

    await test('note store reads: the reconcile lane drains the store before its render, so an app command\'s late write shows without a search - and it never builds', async () => {
        const moved = readTodo(1)
        const state = await readRun([moved, readNote(2)])
        await buildAndRender(state)
        const timerMark = state.timeouts.length
        // moveToFolder is not registered in the harness, as on a desktop whose dialog has not closed yet: the command returns and nothing is written.
        await state.panelMessageHandler(['moveToNotebookClicked', [moved.id]])
        const firstPoll = state.timeouts.slice(timerMark).find(t => t.ms === RECONCILE_OFFSETS[0])
        assert.ok(firstPoll, 'precondition: the command armed the reconcile lane')
        // The dialog closes: Joplin moves the note, and its row lands in the feed.
        state.notes[moved.id].parent_id = readSub
        state.pushChange({ item_id: moved.id, type: 2 })
        const mark = state.gets.length
        await state.fireTimeout(firstPoll)
        assert.deepStrictEqual(noteCallsSince(state, mark).map(g => g.path[0]), ['events', 'notes'], 'the poll drains the feed (one events call, one fetch) and searches nothing')
        assert.ok(/data-todo-id="e+00000001"[\s\S]*?data-notebook-id="e+2"/.test(state.panelHtml['panel-panel']), 'the row shows its new notebook')
        // A store that is not ready is not built by the lane: the poll leaves it to the real triggers, and to the 2.6.3 paths meanwhile.
        state.eventsFailNext = 1
        await state.withTimers(() => state.noteStore.pollNow())
        assert.strictEqual(state.noteStore.isReady(), false, 'precondition: stale')
        const staleMark = state.gets.length
        const secondPoll = state.timeouts.slice(timerMark).find(t => t.ms === RECONCILE_OFFSETS[1])
        assert.ok(secondPoll && !secondPoll.cleared && !secondPoll.fired, 'precondition: the lane is still running')
        await state.fireTimeout(secondPoll)
        assert.strictEqual(state.gets.slice(staleMark).filter(g => g.path[0] === 'events').length, 0, 'a reconcile poll never walks or polls a stale store')
        // Nor does it wait for a build in flight: its render goes ahead on the 2.6.3 paths, and the drain it queued behind the build comes after.
        await state.withTimers(async () => {
            let release
            const held = new Promise(resolve => { release = resolve })
            let holding = false
            state.onListingPage = async (query, items) => {
                if (query.order_by === 'id' && !holding){ holding = true; await held }
                return items
            }
            const rebuilding = storeTick(state)
            for (let turn = 0; turn < 1000 && !holding; turn++) await new Promise(resolve => setImmediate(resolve))
            assert.ok(holding, 'precondition: the next trigger\'s rebuild is held on its walk')
            const thirdPoll = state.timeouts.slice(timerMark).find(t => t.ms === RECONCILE_OFFSETS[2])
            assert.ok(thirdPoll && !thirdPoll.cleared && !thirdPoll.fired, 'precondition: the lane is still running')
            let finished = false
            const polled = state.fireTimeout(thirdPoll).then(() => { finished = true })
            for (let turn = 0; turn < 1000 && !finished; turn++) await new Promise(resolve => setImmediate(resolve))
            assert.ok(finished, 'the reconcile poll rendered while the build was still held')
            const drainsBefore = state.gets.filter(g => g.path[0] === 'events' && g.query && 'cursor' in g.query).length
            release()
            await Promise.all([rebuilding, polled])
            state.onListingPage = null
            const drainsAfter = state.gets.filter(g => g.path[0] === 'events' && g.query && 'cursor' in g.query).length
            assert.strictEqual(drainsAfter - drainsBefore, 2, 'the build\'s replay, then the drain the poll queued')
        })
        assert.ok(state.noteStore.isReady())
    })

    await test('note store reads: the panel\'s own move, flip, create and trash each change the mirror at once and arm one follow-up', async () => {
        const moveMe = readTodo(1), flipMe = readTodo(2), trashMe = readNote(3)
        const state = await readRun([moveMe, flipMe, trashMe], { livePostedNotes: true })
        await buildAndRender(state)
        const step = async (label, message, check) => {
            const mark = state.gets.length
            await state.panelMessageHandler(message)
            check()
            assert.strictEqual(noteCallsSince(state, mark).filter(g => g.path[0] === 'events').length, 0, `${label}: the mirror changed without asking the feed`)
            const followUps = state.pendingTimeouts(STORE_FOLLOW_UP)
            assert.strictEqual(followUps.length, 1, `${label}: exactly one follow-up is armed`)
            await state.fireTimeout(followUps[0])
        }
        state.dialogResult = { id: 'ok', formData: { picker: { folderId: readSub } } }
        await step('move', ['noteMenuActionMulti', 'moveToFolder', [moveMe.id]], () =>
            assert.strictEqual(storeModel(state).get(moveMe.id).parent_id, readSub, 'move: the record has the new notebook'))
        state.dialogResult = null
        await step('flip', ['noteMenuAction', 'toggleType', flipMe.id], () =>
            assert.strictEqual(storeModel(state).get(flipMe.id).is_todo, 0, 'flip: the record is a note'))
        const sizeBefore = storeModel(state).size()
        await state.panelMessageHandler(['notebookFilterChanged', storeFolder])
        await step('create', ['newTodoClicked'], () => {
            const post = state.dataPosts[state.dataPosts.length - 1]
            assert.ok(post && post.path[0] === 'notes', 'precondition: the panel posted a note')
            assert.strictEqual(storeModel(state).size(), sizeBefore + 1, 'create: the mirror holds one more note')
            const created = storeModel(state).snapshot().find(record => record.parent_id === storeFolder && record.is_todo === 1 && record.title === '')
            assert.ok(created, 'create: the posted to-do, from the answer')
            assert.strictEqual(rowCount(state, created.id, 'todo'), 1, 'create: and it is drawn once')
        })
        await state.panelMessageHandler(['notebookFilterChanged', ''])
        await step('trash', ['noteMenuActionMulti', 'delete', [trashMe.id]], () => {
            assert.deepStrictEqual(state.dataDeletes[state.dataDeletes.length - 1], ['notes', trashMe.id], 'precondition: the panel deleted the note')
            assert.strictEqual(storeModel(state).get(trashMe.id), undefined, 'trash: the record is gone')
        })
        assert.ok(!state.panelHtml['panel-panel'].includes(trashMe.id), 'and the trashed note is not drawn')
    })

    await test('note store reads: the panel trashing a note the walk has already read, while the build runs, leaves the build untrusted', async () => {
        // The build is held on page 2; the note trashed meanwhile sat on page 1. Its trash shifts the later pages, but the replay cannot see that:
        // the removal the panel applied has taken the note out already, so the replay's fetch finds nothing to remove. applyLocalRemoval marks it.
        const state = await readRun(storeNoteRange(1, 150))
        const victim = storeId(5)
        await state.withTimers(async () => {
            let release
            const held = new Promise(resolve => { release = resolve })
            let holding = false
            state.onListingPage = async (query, items) => {
                if (query.order_by === 'id' && query.page === 2 && !holding){ holding = true; await held }
                return items
            }
            const building = state.fireTimeout(buildTimeout(state))
            for (let turn = 0; turn < 1000 && !holding; turn++) await new Promise(resolve => setImmediate(resolve))
            assert.ok(holding, 'precondition: the walk is held on page 2')
            await state.panelMessageHandler(['noteMenuActionMulti', 'delete', [victim]])
            // What Joplin's trash does to the note and the feed.
            state.notes[victim].deleted_time = Date.now()
            state.pushChange({ item_id: victim, type: 2 })
            release()
            await building
            state.onListingPage = null
        })
        assert.strictEqual(storeModel(state).get(victim), undefined, 'the trashed note is not in the mirror')
        assert.ok(!state.noteStore.isReady() && state.noteStore.isAvailable(), 'but the build is not trusted, and it is not a failure either')
        const mark = state.gets.length
        await storeTick(state)
        assert.strictEqual(storeGetsSince(state, mark).filter(g => isEvents(g) && !hasCursor(g)).length, 1, 'the next trigger walks again')
        assert.ok(state.noteStore.isReady(), 'and that walk is trusted')
        assert.strictEqual(storeModel(state).size(), 149)
    })

    await test('note store reads: the result caches - a store answer is reused by the fill and the optimistic repaints, and is not served once the revision moves', async () => {
        const tick = readTodo(1)
        const state = await readRun([tick, readTodo(2), readNote(3)])
        await buildAndRender(state)
        const reads = spyStoreReads(state)
        let mark = state.gets.length
        await storeTick(state)
        assert.deepStrictEqual(reads, { todos: 1, notes: 1 }, 'the tick\'s fast paint reads the mirror once, and its fill reuses that answer')
        await state.panelMessageHandler(['profilesDropdownChanged', 1])
        assert.deepStrictEqual(reads, { todos: 2, notes: 2 }, 'a switch paints fast and fills from the cache; only its truth refresh reads the mirror')
        assert.deepStrictEqual(noteCallsSince(state, mark).map(g => g.path[0]), drainsOnly(2), 'and the whole of it cost two events calls: the tick\'s, and the switch\'s drain')
        assert.strictEqual(state.gets.slice(mark).filter(isBodyRead).length, 0, 'and no body: the fill and the optimistic paints reuse the rings the startup fill read')
        // A tick of the checkbox moves the revision (the store has the write at once), so the optimistic repaint must not take the old answer.
        const revision = storeModel(state).revision
        mark = state.gets.length
        await state.panelMessageHandler(['todoChecked', tick.id, true])
        assert.ok(storeModel(state).revision > revision, 'precondition: the write moved the revision')
        assert.deepStrictEqual(reads, { todos: 3, notes: 3 }, 'so the optimistic repaint reads the mirror afresh')
        assert.deepStrictEqual(noteCallsSince(state, mark), [], 'which is still no data call')
        assert.strictEqual(state.gets.slice(mark).filter(isBodyRead).length, 0, 'and not one body either: an optimistic repaint paints before any body read')
        assert.ok(/data-todo-id="e+00000001"[^>]*>\s*<input type="checkbox"[^>]*\schecked\s*>/.test(state.panelHtml['panel-panel']), 'and it draws the tick')
        const joplinSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'joplin.ts'), 'utf8')
        assert.strictEqual((joplinSource.match(/^\s+dropStaleStoreEntries\(revision\)$/gm) || []).length, 2,
            'both readers drop the older revision\'s entries before they look in the cache')
    })

    await test('note store reads: a checkbox tick\'s optimistic repaint reads no body on the store path, though the startup fill left rings unread', async () => {
        // 350 to-dos and 350 notes: the startup fill reads at most 300 bodies per list, so rings of both kinds are still unread when the tick comes,
        // and the tick's write moves the revision, so its repaint cannot be served from the cache.
        const ticked = readTodo(1)
        const state = await readRun([ticked].concat(Array.from({ length: 349 }, (_, i) => readTodo(i + 10)), Array.from({ length: 350 }, (_, i) => readNote(i + 1000))))
        await buildAndRender(state)
        assert.strictEqual(state.gets.filter(isBodyRead).length, 600, 'precondition: the startup fill read 300 rings of each list, and left 50 of each')
        const revision = storeModel(state).revision
        const mark = state.gets.length
        await state.panelMessageHandler(['todoChecked', ticked.id, true])
        assert.ok(storeModel(state).revision > revision, 'precondition: the write moved the revision')
        assert.strictEqual(state.gets.slice(mark).filter(isBodyRead).length, 0, 'the optimistic repaint paints before any body read, as on the search path')
        assert.ok(/data-todo-id="e+00000001"[^>]*>\s*<input type="checkbox"[^>]*\schecked\s*>/.test(state.panelHtml['panel-panel']), 'and it draws the tick')
    })

    await test('note store reads: the desktop Delete (Joplin\'s deleteNote command) takes the note out of the mirror once a read says it is gone - and never unverified', async () => {
        const trashed = readNote(1), purged = readNote(2), cancelled = readNote(3)
        const state = await readRun([trashed, purged, cancelled, readTodo(4)])
        await buildAndRender(state)
        // Joplin's own command, as the desktop runs it; `outcome` says what it does this time.
        let outcome = 'trash'
        state.commands.push({ name: 'deleteNote', execute: async (ids) => {
            for (const id of ids){
                if (outcome === 'trash'){ state.notes[id].deleted_time = Date.now(); state.pushChange({ item_id: id, type: 2 }) }
                if (outcome === 'purge'){ delete state.notes[id]; state.pushChange({ item_id: id, type: 3 }) }
            }
        } })
        let mark = state.gets.length
        await state.panelMessageHandler(['noteMenuAction', 'delete', trashed.id])
        const reads = state.gets.slice(mark)
        assert.deepStrictEqual(reads.filter(g => g.path[0] === 'notes' && g.path[1] === trashed.id).map(g => g.query), [{ fields: ['id', 'deleted_time'] }],
            'the note is read back once, for its deleted_time')
        assert.ok(!reads.some(isEvents), 'no drain: the read is what took it out')
        assert.strictEqual(storeModel(state).get(trashed.id), undefined, 'trashed: the mirror no longer holds it')
        assert.ok(!state.panelHtml['panel-panel'].includes(trashed.id), 'and the action\'s own repaint no longer draws it')
        assert.ok(!state.dataDeletes.some(path => path[1] === trashed.id), 'precondition: the command deleted it, not the data API fallback')
        outcome = 'purge'
        await state.panelMessageHandler(['noteMenuAction', 'delete', purged.id])
        assert.strictEqual(storeModel(state).get(purged.id), undefined, 'deleted for good: Not Found is as good as trashed')
        assert.ok(!state.panelHtml['panel-panel'].includes(purged.id))
        outcome = 'nothing'
        await state.panelMessageHandler(['noteMenuAction', 'delete', cancelled.id])
        assert.ok(storeModel(state).get(cancelled.id), 'a command that deleted nothing leaves the note in the mirror')
        assert.ok(state.panelHtml['panel-panel'].includes(cancelled.id), 'and on screen')
    })

    await test('note store reads: trashing a notebook polls the mirror before the repaint, so its notes vanish in the action\'s own render', async () => {
        const inArchive = [readTodo(1, { parent_id: readArchive }), readNote(2, { parent_id: readArchive })]
        const state = await readRun(inArchive.concat([readTodo(3), readNote(4)]))
        await buildAndRender(state)
        assert.ok(inArchive.every(note => state.panelHtml['panel-panel'].includes(note.id)), 'precondition: both are drawn')
        // What Joplin does when a notebook goes to the trash: its notes go with it, each with a feed row.
        state.onDataDelete = async (target) => {
            if (target[0] !== 'folders' || target[1] !== readArchive) return
            for (const note of inArchive){ state.notes[note.id].deleted_time = Date.now(); state.pushChange({ item_id: note.id, type: 2 }) }
        }
        const mark = state.gets.length
        await state.panelMessageHandler(['deleteNotebookClicked', readArchive])
        state.onDataDelete = null
        assert.deepStrictEqual(state.dataDeletes[state.dataDeletes.length - 1], ['folders', readArchive], 'precondition: the notebook went to the trash')
        assert.strictEqual(state.gets.slice(mark).filter(isEvents).length, 1, 'the mirror was polled once')
        for (const note of inArchive){
            assert.strictEqual(storeModel(state).get(note.id), undefined, 'the notebook\'s notes left the mirror')
            assert.ok(!state.panelHtml['panel-panel'].includes(note.id), 'and the action\'s own repaint draws neither')
        }
        assert.strictEqual(state.pendingTimeouts(STORE_FOLLOW_UP).length, 1, 'with the follow-up armed, for a row that lands late')
    })

    await test('note store reads: a duplicate made by Joplin\'s command, single or several, polls the mirror before the repaint; a row that lands late is repainted by the follow-up', async () => {
        const original = readTodo(1), other = readTodo(2)
        const state = await readRun([original, other, readNote(3)])
        await buildAndRender(state)
        const copyId = (n) => 'c'.repeat(24) + String(n).padStart(8, '0')
        let copies = 0
        let rowLandsNow = true
        const lateRows = []
        state.commands.push({ name: 'duplicateNote', execute: async (ids) => {
            for (const id of ids){
                const copy = Object.assign({}, state.notes[id], { id: copyId(++copies), title: state.notes[id].title + ' - Copy' })
                state.notes[copy.id] = copy
                if (rowLandsNow) state.pushChange({ item_id: copy.id, type: 1 })
                else lateRows.push(copy.id)
            }
        } })
        await state.panelMessageHandler(['noteMenuAction', 'duplicate', original.id])
        assert.ok(storeModel(state).get(copyId(1)), 'single: the copy is in the mirror')
        assert.strictEqual(rowCount(state, copyId(1), 'todo'), 1, 'single: and the action\'s own repaint draws it')
        await state.fireTimeout(state.pendingTimeouts(STORE_FOLLOW_UP)[0])
        await state.panelMessageHandler(['noteMenuActionMulti', 'duplicate', [original.id, other.id]])
        for (const n of [2, 3]){
            assert.ok(storeModel(state).get(copyId(n)), 'several: each copy is in the mirror')
            assert.strictEqual(rowCount(state, copyId(n), 'todo'), 1, 'several: and drawn')
        }
        await state.fireTimeout(state.pendingTimeouts(STORE_FOLLOW_UP)[0])
        // The feed's row is written after the save returns; here it misses the immediate drain.
        rowLandsNow = false
        await state.panelMessageHandler(['noteMenuAction', 'duplicate', other.id])
        assert.strictEqual(rowCount(state, copyId(4), 'todo'), 0, 'precondition: the immediate drain missed the late row')
        for (const id of lateRows) state.pushChange({ item_id: id, type: 1 })
        await state.fireTimeout(state.pendingTimeouts(STORE_FOLLOW_UP)[0])
        await fireStoreRender(state)
        assert.strictEqual(rowCount(state, copyId(4), 'todo'), 1, 'the follow-up brings it, and its notification repaints')
    })

    await test('note store reads: when readiness drops, every cached result goes with it - the 2.6.3 entry from before the store took over is never served again', async () => {
        const renamed = readTodo(1), ticked = readTodo(2)
        const items = [renamed, ticked, readNote(3)]
        // A LIVE index for this one: the search answers what the notes hold now, so a stale cached answer can be told apart from a fresh one.
        let state = null
        state = await readRun(items, { todos: () => (state ? Object.values(state.notes) : items).filter(note => note.is_todo).map(note => ({ ...note })) })
        await buildAndRender(state)
        state.notes[renamed.id].title = 'Renamed outside'
        state.pushChange({ item_id: renamed.id, type: 2 })
        await state.withTimers(() => state.noteStore.pollNow())
        await fireStoreRender(state)
        assert.ok(state.panelHtml['panel-panel'].includes('Renamed outside'), 'precondition: the store-served view shows the rename')
        state.eventsFailNext = 1
        await state.withTimers(() => state.noteStore.pollNow())
        assert.strictEqual(state.noteStore.isReady(), false, 'precondition: a failed poll dropped the readiness')
        const mark = state.gets.length
        await state.panelMessageHandler(['todoChecked', ticked.id, true])
        assert.ok(searchesSince(state, mark).length > 0, 'the optimistic repaint finds no cached answer and searches')
        assert.ok(state.panelHtml['panel-panel'].includes('Renamed outside'), 'so it draws the rename, not the title the pre-store entry held')
    })

    await test('note store reads: a profile switch\'s truth refresh drains the mirror first, so an outside write shows with one events call and no search or listing', async () => {
        const state = await readRun([readTodo(1), readNote(2)], { initialSettings: { profileData: readProfileData([{ name: 'One' }, { name: 'Two' }]), currentProfileID: 1 } })
        await buildAndRender(state)
        // A write from outside - REST, MCP, another plugin: no onNoteChange, no trigger of any kind. Only the switch's own drain can bring it.
        state.notes[storeId(1)].title = 'Renamed over REST'
        state.pushChange({ item_id: storeId(1), type: 2 })
        const mark = state.gets.length
        await state.panelMessageHandler(['profilesDropdownChanged', 2])
        const calls = noteCallsSince(state, mark)
        assert.deepStrictEqual(calls.map(g => g.path[0]), ['events', 'notes'], 'one drain: its events call and the fetch of the note it names')
        assert.ok(calls.every(g => g.path[0] !== 'search' && !(g.path[0] === 'notes' && g.path.length === 1)), 'no search, no listing')
        assert.ok(state.panelHtml['panel-panel'].includes('Renamed over REST'), 'and the switch shows the rename')
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'the drain\'s own render is dropped: the truth refresh has drawn what it brought')
    })

    await test('note store reads: a reconcile poll whose drain changes the mirror paints once - the store render the drain armed is dropped', async () => {
        const state = await readRun([readTodo(1), readNote(2)])
        await buildAndRender(state)
        const timerMark = state.timeouts.length
        await state.panelMessageHandler(['moveToNotebookClicked', [storeId(1)]])
        const firstPoll = state.timeouts.slice(timerMark).find(t => t.ms === RECONCILE_OFFSETS[0])
        assert.ok(firstPoll, 'precondition: the lane is armed')
        state.notes[storeId(1)].title = 'Changed while the lane waited'
        state.pushChange({ item_id: storeId(1), type: 2 })
        const paints = state.setHtmlCalls
        await state.fireTimeout(firstPoll)
        assert.strictEqual(state.setHtmlCalls, paints + 1, 'the reconcile render paints the change')
        assert.ok(state.panelHtml['panel-panel'].includes('Changed while the lane waited'))
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'and no fast store render is left to paint cached rings over it')
    })

    await test('note store reads: an idle tick with the store ready reads no note - one events call, plus the notebook map\'s own refresh once its 20 s cache has lapsed - as the per-tick record the perf run reads says', async () => {
        const state = await readRun(readMix())
        await buildAndRender(state)
        await storeTick(state)                        // warms whatever ring the startup fill left
        const mark = state.gets.length
        // The measured tick comes a whole interval later, as in the app: the notebook map's 20 s cache has lapsed by then (2.6.3 behaviour, kept).
        const realNow = Date.now
        Date.now = () => realNow() + 60000
        try {
            await storeTick(state)
        } finally {
            Date.now = realNow
        }
        assert.deepStrictEqual(noteCallsSince(state, mark).map(g => g.path[0]), ['events'], 'one events call, and no note read')
        assert.strictEqual(state.gets.slice(mark).filter(g => g.path[0] === 'folders').length, 1, 'and one page of the notebook map')
        const ticks = state.instrument.ticks()
        const last = ticks[ticks.length - 1]
        assert.deepStrictEqual([last.search, last.listing, last.get, last.bodies, last.put, last.post, last.del, last.events, last.folders], [0, 0, 0, 0, 0, 0, 0, 1, 1],
            'CockpitInstrument.ticks() records it the same way')
        const storeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'noteStore.ts'), 'utf8')
        assert.ok(/const walkPagePauseMs = 0\n/.test(storeSource), 'the walk\'s page pause is prepared, and off')
    })

    // ============================================================ note store triggers (2.7 phase 4): drain the feed, render once
    // Once the note store serves EVERY view - the panel's current one and each overview note's profile (allConsumersStoreServed in src/core/timer.ts,
    // published as CockpitTriggers) - the refresh machinery that exists to chase the search index stands down: a note change is the store's debounced
    // poll and nothing else that reads data, a completed sync is its fast render, the settings note's read and one poll, and the periodic tick draws
    // only when something the panel or the overview notes are drawn from has moved (the redraw stamps in timer.ts). One view that still needs the
    // search puts every trigger back on its 2.6.3 path, which the B2 budget checks and the phase 2 and 3 sections above pin in full.
    const allStoreServed = (state) => state.triggers.allConsumersStoreServed()
    const lastTick = (state) => { const ticks = state.instrument.ticks(); return ticks[ticks.length - 1] }
    const tickCost = (entry, keys) => Object.fromEntries(keys.map(key => [key, entry[key]]))
    const NOTE_READ_KEYS = ['search', 'listing', 'get', 'bodies']
    // The rungs of the reconcile ladder but its 3 s one, which the settings note's write debounce shares.
    const LADDER_RUNGS = RECONCILE_OFFSETS.filter(ms => ms !== 3000)
    const ladderSince = (state, timerMark) => state.timeouts.slice(timerMark).filter(t => LADDER_RUNGS.includes(t.ms)).length
    // Date.now alone a while later: the notebook map's and the tag list's 20 s caches lapse as they do between two real ticks, and the date does not.
    const withLaterNow = async (offsetMs, fn) => {
        const realNow = Date.now
        Date.now = () => realNow() + offsetMs
        try {
            return await fn()
        } finally {
            Date.now = realNow
        }
    }
    // The whole clock moved, `new Date()` included, which is what the horizons, the completed buckets and the calendars read the day from.
    const withShiftedClock = async (offsetMs, fn) => {
        const RealDate = Date
        class ShiftedDate extends RealDate {
            constructor(...args){
                if (args.length) super(...args)
                else super(RealDate.now() + offsetMs)
            }
            static now(){ return RealDate.now() + offsetMs }
        }
        global.Date = ShiftedDate
        try {
            return await fn()
        } finally {
            global.Date = RealDate
        }
    }
    const firePending = async (state, ms) => { for (const entry of state.pendingTimeouts(ms)) await state.fireTimeout(entry) }
    // The heading each row sits under, in order: { '<kind> <id>': '<heading>' }.
    const sectionOf = (state) => {
        const map = {}
        let heading = null
        for (const token of readSections(state)){
            if (token.startsWith('# ')) heading = token.slice(2)
            else map[token] = heading
        }
        return map
    }
    const triggerOverview = (n) => storeNote(90 + n, { id: `ov${n}`.padEnd(32, '0'), title: `Overview ${n}`, body: 'stale' })

    await test('note store triggers: allConsumersStoreServed - true only when the store is ready and the panel\'s view and every overview note\'s profile need no search', async () => {
        // The unfiltered panel alone, through the store's life: not ready, ready, stale, rebuilt.
        const state = await readRun([readTodo(1), readNote(2)])
        assert.strictEqual(await allStoreServed(state), false, 'store not ready: not all')
        await buildAndRender(state)
        assert.strictEqual(await allStoreServed(state), true, 'an unfiltered panel and no overview note: all store-served')
        await state.panelMessageHandler(['searchFilterChanged', 'milk'])
        assert.strictEqual(await allStoreServed(state), false, 'a word typed in the panel: not all')
        await state.panelMessageHandler(['searchFilterChanged', 'tag:one tag:two any:1'])
        assert.strictEqual(await allStoreServed(state), false, 'any:1 typed in the panel: not all')
        await state.panelMessageHandler(['searchFilterChanged', ''])
        await state.panelMessageHandler(['notebookFilterChanged', storeFolder])
        assert.strictEqual(await allStoreServed(state), true, 'the notebook filter is local: still all')
        state.eventsFailNext = 1
        await state.withTimers(() => state.noteStore.pollNow())
        assert.strictEqual(await allStoreServed(state), false, 'a stale store: not all')
        await storeTick(state)
        assert.ok(state.noteStore.isReady(), 'precondition: the next trigger rebuilt it')
        assert.strictEqual(await allStoreServed(state), true, 'rebuilt: all again')

        // Overview notes: each profile that writes one is a consumer, current or not.
        const filteredOverview = triggerOverview(1)
        const mixed = await readRun([readTodo(1), filteredOverview], { initialSettings: { profileData: readProfileData([
            { name: 'All' }, { name: 'Work', searchCriteria: 'tag:work', noteID: filteredOverview.id, showNotes: false },
        ]), currentProfileID: 1 } })
        await buildAndRender(mixed)
        assert.strictEqual(await allStoreServed(mixed), false, 'an unfiltered panel plus an overview note on a filtered profile: not all')
        const work = JSON.parse(mixed.settings.profileData).profiles.find(profile => profile.name === 'Work')
        await mixed.panelMessageHandler(['profileSaved', work.id, { ...work, searchCriteria: '' }])
        assert.strictEqual(await allStoreServed(mixed), true, 'the same overview note on an unfiltered profile: all')

        // The panel's own profile, and the calendar formats, which build their criteria exactly as the lists do.
        const profiled = await readRun([readTodo(1)], { initialSettings: { profileData: readProfileData([
            { name: 'Work', searchCriteria: 'tag:work' }, { name: 'Month', displayFormat: 'month' }, { name: 'Week', displayFormat: 'week' },
        ]), currentProfileID: 1 } })
        await buildAndRender(profiled)
        assert.strictEqual(await allStoreServed(profiled), false, 'a panel profile with criteria: not all')
        await profiled.panelMessageHandler(['profilesDropdownChanged', 2])
        assert.strictEqual(await allStoreServed(profiled), true, 'the month calendar, unfiltered: all')
        await profiled.panelMessageHandler(['profilesDropdownChanged', 3])
        assert.strictEqual(await allStoreServed(profiled), true, 'the week calendar, unfiltered: all')

        // No feed at all.
        const off = await readRun([readTodo(1)], { eventsUnavailable: true })
        await off.fireTimeout(buildTimeout(off))
        assert.strictEqual(off.noteStore.isAvailable(), false, 'precondition: the store is off')
        assert.strictEqual(await allStoreServed(off), false, 'unavailable: not all')

        // One decision, one string: the triggers ask storeServes about the criteria formats.ts builds every view's read from.
        const formatsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'formats.ts'), 'utf8')
        const timerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'timer.ts'), 'utf8')
        assert.strictEqual((formatsSource.match(/viewCriteria\((this\.)?profile\.searchCriteria, searchFilter\)/g) || []).length, 2,
            'the to-dos and the Notes section build their criteria with viewCriteria')
        assert.ok(!/searchFilter \? `\$\{/.test(formatsSource), 'and nowhere by hand')
        assert.strictEqual((timerSource.match(/storeServes\(viewCriteria\(/g) || []).length, 2, 'the predicate judges the panel and each overview note by storeServes(viewCriteria(...))')
    })

    await test('note store triggers: a note change with every view store-served is the debounced poll and its follow-up - no per-note read, no ladder - its render shows the change, and the overview debounce is armed once', async () => {
        const edited = readTodo(1)
        const state = await readRun([edited, readNote(2)])
        await buildAndRender(state)
        state.notes[edited.id].title = 'Edited in the editor'
        state.pushChange({ item_id: edited.id, type: 2 })
        const mark = state.gets.length
        const timerMark = state.timeouts.length
        await state.noteChangeHandler({ id: edited.id })
        assert.deepStrictEqual(state.gets.slice(mark), [], 'the event itself reads nothing: no per-note read')
        assert.deepStrictEqual(state.timeouts.slice(timerMark).map(t => t.ms).sort((a, b) => a - b), [STORE_NOTE_CHANGE_DELAY, OVERVIEW_DEBOUNCE],
            'it arms the store\'s debounced poll and the overview debounce, and not one rung of the reconcile ladder')
        await firePending(state, STORE_NOTE_CHANGE_DELAY)
        const polled = noteCallsSince(state, mark)
        assert.deepStrictEqual(polled.map(g => g.path[0]), ['events', 'notes'], 'the poll: one events call and one fetch')
        assert.ok(isStoreFetch(polled[1]) && polled[1].path[1] === edited.id, 'the fetch is the store\'s own, of the note its row names')
        const paints = state.setHtmlCalls
        await fireStoreRender(state)
        assert.strictEqual(state.setHtmlCalls, paints + 1, 'the drain\'s render paints once')
        assert.ok(state.panelHtml['panel-panel'].includes('Edited in the editor'), 'with the change')
        const followMark = state.gets.length
        assert.strictEqual(state.pendingTimeouts(STORE_FOLLOW_UP).length, 1, 'the poll armed its one follow-up')
        await firePending(state, STORE_FOLLOW_UP)
        assert.deepStrictEqual(noteCallsSince(state, followMark).map(g => g.path[0]), ['events'], 'which is one more events call, finding nothing')
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'and rendering nothing')
        assert.strictEqual(state.pendingTimeouts(OVERVIEW_DEBOUNCE).length, 1, 'the overview debounce is armed once')
        assert.strictEqual(ladderSince(state, timerMark), 0, 'and at no point was the ladder armed')
        assert.strictEqual(searchesSince(state, mark).length, 0, 'nor any search made')
    })

    await test('note store triggers: with one view on the search - an overview note of a filtered profile - a note change takes its 2.6.3 path: the per-note read, the whole ladder; and the drain\'s render stays the fast one', async () => {
        const overview = triggerOverview(2)
        const edited = readTodo(1)
        const state = await readRun([edited, readNote(2), overview], { initialSettings: { profileData: readProfileData([
            { name: 'All' }, { name: 'Work', searchCriteria: 'tag:work', noteID: overview.id, showNotes: false },
        ]), currentProfileID: 1 } })
        await buildAndRender(state)
        assert.strictEqual(await allStoreServed(state), false, 'precondition: the Work overview note needs the search')
        const mark = state.gets.length
        const timerMark = state.timeouts.length
        await state.noteChangeHandler({ id: edited.id })
        const perNote = state.gets.slice(mark).filter(g => g.path[0] === 'notes' && g.path[1] === edited.id && !isStoreGet(g))
        assert.strictEqual(perNote.length, 1, 'the external-change path reads the note, as it always has')
        const armed = state.timeouts.slice(timerMark)
        assert.deepStrictEqual(armed.filter(t => RECONCILE_OFFSETS.includes(t.ms)).map(t => t.ms), RECONCILE_OFFSETS, 'the whole reconcile ladder is armed')
        assert.strictEqual(armed.filter(t => t.ms === OVERVIEW_DEBOUNCE).length, 1, 'with one overview debounce')
        assert.strictEqual(armed.filter(t => t.ms === STORE_NOTE_CHANGE_DELAY).length, 1, 'beside the store\'s own debounced poll')
        // The store render stays the fast render alone here: the ladder's full renders are what read the changed rings.
        state.notes[edited.id].user_updated_time = 55555
        state.pushChange({ item_id: edited.id, type: 2 })
        await state.withTimers(() => state.noteStore.pollNow())
        const bodies = countBodyFetches(state)
        await fireStoreRender(state)
        assert.strictEqual(countBodyFetches(state), bodies, 'the drain\'s render reads no body: the ladder is still there to read it')
    })

    await test('note store triggers: a completed sync with every view store-served is the fast render, the settings note\'s read and one poll, whose render shows what came in - no ladder; with a view on the search, the ladder as before', async () => {
        const syncBodyText = syncBody(syncStore(2, [syncProfile(1, 'Synced view')]), syncSettings())
        const state = await readRun([readTodo(1), readNote(2), syncNoteFixture(syncBodyText)], { initialSettings: {
            settingsNoteId: SYNC_NOTE_ID, profileData: JSON.stringify(syncStore(2, [syncProfile(1, 'Synced view')])), currentProfileID: 1,
        } })
        await buildAndRender(state)
        assert.strictEqual(await allStoreServed(state), true, 'precondition: every view is store-served')
        state.notes[storeId(1)].title = 'Arrived with the sync'
        state.pushChange({ item_id: storeId(1), type: 2 })
        const mark = state.gets.length
        const timerMark = state.timeouts.length
        const settingsReads = syncGets(state).length
        const paints = state.setHtmlCalls
        await state.syncStartHandler()
        await state.syncCompleteHandler({ withErrors: false })
        assert.ok(state.setHtmlCalls > paints, 'the fast render draws the button')
        assert.strictEqual(syncGets(state).length - settingsReads, 1, 'the settings note is read once')
        assert.strictEqual(state.gets.slice(mark).filter(isEvents).length, 1, 'one poll')
        assert.strictEqual(searchesSince(state, mark).length, 0, 'no search')
        assert.strictEqual(ladderSince(state, timerMark), 0, 'no reconcile ladder')
        assert.strictEqual(state.timeouts.slice(timerMark).filter(t => t.ms === OVERVIEW_DEBOUNCE).length, 1, 'one overview pass')
        assert.ok(!state.panelHtml['panel-panel'].includes('Arrived with the sync'), 'precondition: the button\'s fast render came before the poll')
        const renderPaints = state.setHtmlCalls
        await fireStoreRender(state)
        assert.strictEqual(state.setHtmlCalls, renderPaints + 1, 'the poll\'s render paints once')
        assert.ok(state.panelHtml['panel-panel'].includes('Arrived with the sync'), 'with what the sync brought')

        const overview = triggerOverview(3)
        const mixed = await readRun([readTodo(1), overview], { initialSettings: { profileData: readProfileData([
            { name: 'All' }, { name: 'Work', searchCriteria: 'tag:work', noteID: overview.id, showNotes: false },
        ]), currentProfileID: 1 } })
        await buildAndRender(mixed)
        const mixedMark = mixed.timeouts.length
        const mixedGets = mixed.gets.length
        await mixed.syncCompleteHandler({ withErrors: false })
        assert.deepStrictEqual(mixed.timeouts.slice(mixedMark).filter(t => RECONCILE_OFFSETS.includes(t.ms)).map(t => t.ms), RECONCILE_OFFSETS,
            'a view on the search: the sync arms the whole ladder, as before')
        assert.strictEqual(mixed.gets.slice(mixedGets).filter(isEvents).length, 1, 'and still polls the store once')
    })

    await test('note store triggers: the tick - an idle minute is one events call, the notebook map\'s and the tag list\'s page, and no render; its own drain is drawn once; the day turning re-sections with no note read', async () => {
        const noon = new Date()
        noon.setHours(12, 0, 0, 0)
        const dueToday = readTodo(1, { todo_due: noon.getTime(), title: 'Due today at noon' })
        const state = await readRun([dueToday, readTodo(2), readNote(3)])
        await buildAndRender(state)
        // The first tick after the build: the overview notes were last drawn at startup, on the search paths, so it draws once.
        await storeTick(state)
        const idleKeys = NOTE_READ_KEYS.concat(['events', 'folders', 'tags', 'renders', 'paints'])
        let paints = state.setHtmlCalls
        await withLaterNow(60000, () => storeTick(state))
        assert.deepStrictEqual(tickCost(lastTick(state), idleKeys), { search: 0, listing: 0, get: 0, bodies: 0, events: 1, folders: 1, tags: 1, renders: 0, paints: 0 },
            'an idle minute: one events call, the notebook map\'s and the tag list\'s page once their caches lapsed, and not one render')
        assert.strictEqual(state.setHtmlCalls, paints, 'nothing painted')
        assert.strictEqual(pendingStoreRenders(state).length, 0)

        // A change only the tick's own poll can bring: an outside write, which no event announces.
        state.notes[storeId(2)].title = 'Renamed over REST'
        state.pushChange({ item_id: storeId(2), type: 2 })
        paints = state.setHtmlCalls
        await storeTick(state)
        assert.ok(state.panelHtml['panel-panel'].includes('Renamed over REST'), 'the tick\'s drain shows')
        assert.strictEqual(state.setHtmlCalls, paints + 1, 'painted once')
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'the store render the drain armed was taken back: the tick drew it')
        assert.deepStrictEqual(tickCost(lastTick(state), ['search', 'listing', 'bodies', 'events', 'get', 'renders', 'paints']),
            { search: 0, listing: 0, bodies: 0, events: 1, get: 1, renders: 2, paints: 1 },
            'one drain (its events call and its fetch), and one full refresh: the fast paint and its fill, one paint')
        await withLaterNow(120000, () => storeTick(state))
        assert.deepStrictEqual(tickCost(lastTick(state), ['renders', 'paints']), { renders: 0, paints: 0 }, 'and the tick after it is idle again')

        // The day turns: 30 hours on, whatever the time of day the suite runs at, today noon is yesterday.
        assert.strictEqual(sectionOf(state)[`todo ${dueToday.id}`], 'Today', 'precondition: due today, under Today')
        paints = state.setHtmlCalls
        await withShiftedClock(30 * HOUR, () => storeTick(state))
        assert.strictEqual(sectionOf(state)[`todo ${dueToday.id}`], 'Overdue', 'the day turned: the same to-do is Overdue')
        assert.strictEqual(state.setHtmlCalls, paints + 1, 'in one paint')
        assert.deepStrictEqual(tickCost(lastTick(state), NOTE_READ_KEYS.concat(['events', 'paints'])), { search: 0, listing: 0, get: 0, bodies: 0, events: 1, paints: 1 },
            'with not one note read: the poll\'s events call, and the mirror')
    })

    await test('note store triggers: the tick still draws for what moves without a feed row - a notebook renamed, a tag created, a held optimistic entry, a due time passing on the month calendar', async () => {
        const folders = readFolders.map(folder => ({ ...folder }))
        const tags = [{ id: 't'.repeat(32), title: 'existing' }]
        const soon = readTodo(1, { todo_due: Date.now() + 60000, title: 'Due in a minute' })
        const state = await readRun([soon, readTodo(2), readNote(3)], {
            folders, tags,
            initialSettings: { profileData: readProfileData([
                { name: 'List' },
                { name: 'Month', displayFormat: 'month', showNotes: false },
                { name: 'Hide done', showCompletedPast: false, showCompletedToday: false, showCompletedFuture: false, showCompletedNoDue: false },
            ]), currentProfileID: 1 },
        })
        await buildAndRender(state)
        await storeTick(state)
        let offset = 60000
        const idleTick = async () => { await withLaterNow(offset, () => storeTick(state)); offset += 60000; return tickCost(lastTick(state), ['renders', 'paints']) }
        assert.deepStrictEqual(await idleTick(), { renders: 0, paints: 0 }, 'precondition: idle')
        folders[0].title = 'Store renamed'
        assert.deepStrictEqual(await idleTick(), { renders: 2, paints: 1 }, 'a notebook renamed elsewhere: drawn (its pill)')
        assert.ok(state.panelHtml['panel-panel'].includes('Store renamed'))
        assert.deepStrictEqual(await idleTick(), { renders: 0, paints: 0 }, 'then idle')
        tags.push({ id: 'u'.repeat(32), title: 'fresh tag' })
        assert.deepStrictEqual(await idleTick(), { renders: 2, paints: 1 }, 'a tag created elsewhere: drawn (the search field\'s autocomplete)')
        assert.ok(state.panelHtml['panel-panel'].includes('fresh tag'))
        assert.deepStrictEqual(await idleTick(), { renders: 0, paints: 0 }, 'then idle')
        // A completion override the view cannot retire: the ticked to-do leaves a profile that hides completed ones, so no row agrees with it, and
        // it is held until its 60 s timeout. These ticks keep the real clock, so it is still held when they come.
        await state.panelMessageHandler(['profilesDropdownChanged', 3])
        await state.panelMessageHandler(['todoChecked', storeId(2), true])
        await storeTick(state)
        assert.ok(tickCost(lastTick(state), ['renders']).renders > 0, 'precondition: the tick after the write draws it')
        await storeTick(state)
        assert.ok(tickCost(lastTick(state), ['renders']).renders > 0, 'a held optimistic entry: the tick after that draws again, as it always did')
        assert.ok((await idleTick()).renders > 0, 'and the tick that finds it timed out draws once more, the markup it held being gone')
        assert.deepStrictEqual(await idleTick(), { renders: 0, paints: 0 }, 'then idle')
        await state.panelMessageHandler(['profilesDropdownChanged', 2])
        // The month calendar: the dot of a to-do turns overdue the moment its due time passes, the one thing in the markup the time of day decides.
        await withShiftedClock(0, () => storeTick(state))
        await withShiftedClock(0, () => storeTick(state))
        const beforeDue = tickCost(lastTick(state), ['renders'])
        assert.ok(/calendar-dot -due/.test(state.panelHtml['panel-panel']), 'precondition: the dot is not overdue yet')
        await withShiftedClock(2 * 60000, () => storeTick(state))
        assert.ok(/calendar-dot -overdue/.test(state.panelHtml['panel-panel']), 'two minutes on, the due time has passed: the dot is overdue')
        assert.deepStrictEqual(tickCost(lastTick(state), ['paints']), { paints: 1 }, 'drawn by the tick')
        assert.deepStrictEqual(beforeDue, { renders: 0 }, 'where the tick before it, with no due time passed, drew nothing')
    })

    await test('note store triggers: rings the per-refresh body cap left unread fill in on the following ticks, and only then does the tick go idle', async () => {
        // 1,000 to-dos: the startup fill reads 300; the render the finished build arms reads none (the build's news gets no fill); then each tick
        // reads 300 more until none is left.
        const state = await readRun(Array.from({ length: 1000 }, (_, i) => readTodo(i + 1)))
        await buildAndRender(state)
        assert.strictEqual(state.gets.filter(isBodyRead).length, 300, 'precondition: the startup fill alone, 300')
        await storeTick(state)
        assert.strictEqual(state.gets.filter(isBodyRead).length, 600, 'the next tick fills 300 more')
        await withLaterNow(60000, () => storeTick(state))
        assert.strictEqual(state.gets.filter(isBodyRead).length, 900, 'and the one after it 300 more, although nothing else moved')
        await withLaterNow(120000, () => storeTick(state))
        assert.strictEqual(state.gets.filter(isBodyRead).length, 1000, 'then the last 100')
        await withLaterNow(180000, () => storeTick(state))
        assert.deepStrictEqual(tickCost(lastTick(state), ['bodies', 'renders']), { bodies: 0, renders: 0 }, 'and with every ring read, the tick is idle')
    })

    await test('note store triggers: a whole store-served session - the build, ticks, a note change, a sync, the day turning - never pages the listing outside the build\'s walk, and never searches', async () => {
        const overview = triggerOverview(4)
        const state = await readRun([readTodo(1), readTodo(2, { todo_due: 0 }), readNote(3), overview], { initialSettings: { profileData: readProfileData([
            { name: 'Everything', noteID: overview.id },
        ]), currentProfileID: 1 } })
        const mark = state.gets.length
        await buildAndRender(state)
        assert.strictEqual(await allStoreServed(state), true, 'precondition: every view, the overview note included, is store-served')
        await storeTick(state)
        await withLaterNow(60000, () => storeTick(state))
        state.notes[storeId(1)].title = 'Changed during the session'
        state.pushChange({ item_id: storeId(1), type: 2 })
        await state.noteChangeHandler({ id: storeId(1) })
        await firePending(state, STORE_NOTE_CHANGE_DELAY)
        await fireStoreRender(state)
        await firePending(state, STORE_FOLLOW_UP)
        await firePending(state, OVERVIEW_DEBOUNCE)
        await state.syncStartHandler()
        state.notes[storeId(2)].todo_completed = Date.now()
        state.pushChange({ item_id: storeId(2), type: 2 })
        await state.syncCompleteHandler({ withErrors: false })
        await fireStoreRender(state)
        await firePending(state, STORE_FOLLOW_UP)
        await firePending(state, OVERVIEW_DEBOUNCE)
        await withLaterNow(120000, () => storeTick(state))
        await withShiftedClock(30 * HOUR, () => storeTick(state))
        const session = state.gets.slice(mark)
        assert.deepStrictEqual(session.filter(g => g.path[0] === 'search'), [], 'not one search')
        const pages = session.filter(g => g.path[0] === 'notes' && g.path.length === 1)
        assert.ok(pages.length > 0 && pages.every(isWalkPage), 'every listing page is the build\'s own walk: neither listAllNotes nor listRecentNotes ran')
        const written = state.notePuts.filter(put => put.id === overview.id).pop()
        assert.ok(written && written.body.includes('Changed during the session'), 'and the overview note followed, from the mirror')
    })

    await test('note store triggers: the overview notes - after a store change, their debounce regenerates them from the mirror, with no search', async () => {
        const overview = triggerOverview(5)
        const todo = readTodo(1)
        const state = await readRun([todo, overview], { initialSettings: { profileData: readProfileData([
            { name: 'Overview', noteID: overview.id, showNotes: false },
        ]), currentProfileID: 1 } })
        await buildAndRender(state)
        await storeTick(state)
        state.notes[todo.id].title = 'Renamed for the overview'
        state.pushChange({ item_id: todo.id, type: 2 })
        const mark = state.gets.length
        const putsBefore = state.notePuts.filter(put => put.id === overview.id).length
        await state.noteChangeHandler({ id: todo.id })
        await firePending(state, STORE_NOTE_CHANGE_DELAY)
        await fireStoreRender(state)
        assert.strictEqual(state.notePuts.filter(put => put.id === overview.id).length, putsBefore, 'precondition: the panel\'s render leaves the overview note to its debounce')
        await firePending(state, OVERVIEW_DEBOUNCE)
        const written = state.notePuts.filter(put => put.id === overview.id).pop()
        assert.ok(written && written.body.includes('Renamed for the overview'), 'the debounce rewrote the overview note with the change')
        assert.strictEqual(searchesSince(state, mark).length, 0, 'from the mirror: no search')
    })

    await test('note store triggers: during a sync a change to the open note takes the reconcile ladder, whose first rung drains the store - the change shows before the sync completes', async () => {
        // The store's own poll and the tick's both wait for a sync to end, so while one runs the ladder's rungs are what drain the store.
        const edited = readTodo(1)
        const state = await readRun([edited, readNote(2)])
        await buildAndRender(state)
        assert.strictEqual(await allStoreServed(state), true, 'precondition: every view is store-served')
        await state.syncStartHandler()
        state.notes[edited.id].title = 'Edited during the sync'
        state.pushChange({ item_id: edited.id, type: 2 })
        const timerMark = state.timeouts.length
        await state.noteChangeHandler({ id: edited.id })
        const armed = state.timeouts.slice(timerMark)
        assert.strictEqual(armed.filter(t => t.ms === STORE_NOTE_CHANGE_DELAY).length, 0, 'precondition: no store poll is armed while a sync runs')
        const firstRung = armed.find(t => t.ms === RECONCILE_OFFSETS[0])
        assert.ok(firstRung, 'the note change arms the reconcile ladder')
        await state.fireTimeout(firstRung)
        assert.ok(state.panelHtml['panel-panel'].includes('Edited during the sync'), 'its 1 s rung drains the store and shows the change, with the sync still running')
    })

    await test('note store triggers: the build\'s own render reads no ring, and a drain\'s render reads only the changed ones - the startup backlog is left for the tick', async () => {
        // 350 to-dos: the startup fill reads the first 300 by due date and leaves the last 50.
        const state = await readRun(Array.from({ length: 350 }, (_, i) => readTodo(i + 1)))
        const startupBodies = state.gets.filter(isBodyRead).length
        assert.strictEqual(startupBodies, 300, 'precondition: the startup fill read 300 rings')
        await buildStore(state)
        const rendersBefore = state.instrument.snapshot().renders
        await fireStoreRender(state)
        assert.strictEqual(state.instrument.snapshot().renders - rendersBefore, 1, 'the build\'s render is the fast one alone: no fill follows it')
        assert.strictEqual(state.gets.filter(isBodyRead).length, startupBodies, 'so it reads no ring: its 50 unread rings are the tick\'s')
        for (const n of [1, 340]){
            Object.assign(state.notes[storeId(n)], { title: `Changed ${n}`, user_updated_time: 90000 + n })
            state.pushChange({ item_id: storeId(n), type: 2 })
        }
        await state.withTimers(() => state.noteStore.pollNow())
        const mark = state.gets.length
        await fireStoreRender(state)
        assert.deepStrictEqual(state.gets.slice(mark).filter(isBodyRead).map(g => g.path[1]), [storeId(1), storeId(340)],
            'the drain\'s render reads the two rings it changed: the one read before, and the one of the backlog, whose note it fetched')
        const tickMark = state.gets.length
        await storeTick(state)
        const tickReads = state.gets.slice(tickMark).filter(isBodyRead).map(g => g.path[1])
        assert.strictEqual(tickReads.length, 49, 'the tick fills the rest of the backlog, the 49 no drain touched')
        assert.ok(!tickReads.includes(storeId(340)), 'and not the one the drain already read')
    })

    await test('note store triggers: a fast render - the sync button\'s - leaves the tick owing a draw', async () => {
        const state = await readRun([readTodo(1), readNote(2)])
        await buildAndRender(state)
        await storeTick(state)
        await withLaterNow(60000, () => storeTick(state))
        assert.deepStrictEqual(tickCost(lastTick(state), ['renders']), { renders: 0 }, 'precondition: idle')
        await state.syncStartHandler()
        await state.syncCompleteHandler({ withErrors: false })
        assert.strictEqual(pendingStoreRenders(state).length, 0, 'precondition: the sync brought nothing, so no store render follows the button\'s fast one')
        await withLaterNow(120000, () => storeTick(state))
        assert.ok(tickCost(lastTick(state), ['renders']).renders > 0, 'the tick draws: the last drawing took its rings from the cache')
        await withLaterNow(180000, () => storeTick(state))
        assert.deepStrictEqual(tickCost(lastTick(state), ['renders']), { renders: 0 }, 'and after that complete draw, it is idle again')
    })

    await test('note store triggers: an optimistic entry merged into a render that runs out before the render ends still leaves the tick owing a draw', async () => {
        // A profile that hides completed to-dos, so the ticked one leaves the list and no row can retire its override.
        const hidden = { showCompletedPast: false, showCompletedToday: false, showCompletedFuture: false, showCompletedNoDue: false }
        const ticked = readTodo(1)
        const state = await readRun([ticked, readNote(2)], { initialSettings: { profileData: readProfileData([{ name: 'Open only', ...hidden }]), currentProfileID: 1 } })
        await buildAndRender(state)
        await storeTick(state)
        const isChecked = () => /data-todo-id="e+00000001"[^>]*>\s*<input type="checkbox"[^>]*\schecked\s*>/.test(state.panelHtml['panel-panel'])
        // Ticked in Cockpit, then un-ticked by another device: the store has it open again, the override (60 s) still says done, and wins.
        await state.panelMessageHandler(['todoChecked', ticked.id, true])
        state.notes[ticked.id].todo_completed = 0
        state.pushChange({ item_id: ticked.id, type: 2 })
        await state.withTimers(() => state.noteStore.pollNow())
        await fireStoreRender(state)
        assert.ok(isChecked(), 'precondition: the held override draws the to-do ticked')
        const realNow = Date.now
        try {
            // A full render that merges the override, and during which it runs out: the clock passes its 60 s after the to-dos are read.
            state.onSettingRead = async (key) => {
                if (key !== 'themeMode') return
                state.onSettingRead = null
                Date.now = () => realNow() + 61000
            }
            await state.panelMessageHandler(['sortDirectionClicked'])
            assert.strictEqual(state.onSettingRead, null, 'precondition: the clock moved inside the render')
            assert.ok(isChecked(), 'precondition: the render drew the override, which has run out since')
            // The overview notes catch up after the entry ran out, so only the panel's own stamp can speak for the drawing.
            await firePending(state, OVERVIEW_DEBOUNCE)
            await storeTick(state)
            assert.ok(tickCost(lastTick(state), ['renders']).renders > 0, 'the tick draws')
            assert.ok(!isChecked(), 'and the to-do shows as the store has it, open')
        } finally {
            Date.now = realNow
            state.onSettingRead = null
        }
    })

    await test('note store triggers: a setting read that throws inside the predicate answers "not all", and the trigger takes its 2.6.3 path instead of rejecting', async () => {
        const todo = readTodo(1)
        const state = await readRun([todo, readNote(2)])
        await buildAndRender(state)
        const failNextProfileRead = () => {
            state.onSettingRead = async (key) => {
                if (key !== 'currentProfileID') return
                state.onSettingRead = null
                throw new Error('the settings read failed')
            }
        }
        failNextProfileRead()
        assert.strictEqual(await allStoreServed(state), false, 'the predicate answers false')
        assert.strictEqual(await allStoreServed(state), true, 'precondition: and true again once the read succeeds')
        failNextProfileRead()
        const timerMark = state.timeouts.length
        await state.noteChangeHandler({ id: todo.id })
        assert.strictEqual(state.timeouts.slice(timerMark).filter(t => t.ms === RECONCILE_OFFSETS[0]).length, 1, 'a note change takes the ladder')
        failNextProfileRead()
        await storeTick(state)
        assert.ok(tickCost(lastTick(state), ['renders']).renders > 0, 'and a tick runs the full refresh')
        state.onSettingRead = null
    })

    await test('note store triggers: a to-do new to the mirror - created mid-session, its ring never read - shows its checkboxes on the drain\'s render, without waiting for a tick', async () => {
        const state = await readRun([readTodo(2), readNote(3)])
        await buildAndRender(state)
        await storeTick(state)
        const created = readTodo(50, { title: 'Made mid-session', body: '- [x] a\n- [ ] b\n- [ ] c' })
        state.notes[created.id] = created
        state.pushChange({ item_id: created.id, type: 1 })
        await state.withTimers(() => state.noteStore.pollNow())
        await fireStoreRender(state)
        const row = String(state.panelHtml['panel-panel']).match(new RegExp(`data-todo-id="${created.id}"[\\s\\S]*?</div>`))
        assert.ok(row, 'the new to-do is drawn')
        assert.ok(row[0].includes('title="1/3 checkboxes done'), 'with its ring read: one of three boxes done')
    })

    await test('note store triggers: a drain of more than 200 notes rebuilds the store, and its render still fills the changed rings - no tick needed', async () => {
        const first = readTodo(1, { body: '- [ ] x\n- [ ] y' })
        const state = await readRun([first].concat(Array.from({ length: 209 }, (_, i) => readTodo(i + 2))))
        await buildAndRender(state)
        const ringOf = () => (String(state.panelHtml['panel-panel']).match(new RegExp(`data-todo-id="${first.id}"[\\s\\S]*?</div>`)) || [''])[0]
        assert.ok(ringOf().includes('title="0/2 checkboxes done'), 'precondition: the startup fill read note 1\'s ring, none done')
        Object.assign(state.notes[first.id], { body: '- [x] x\n- [ ] y', user_updated_time: 99999 })
        for (let n = 1; n <= 210; n++) state.pushChange({ item_id: storeId(n), type: 2 })
        const mark = state.gets.length
        await state.withTimers(() => state.noteStore.pollNow())
        assert.ok(state.gets.slice(mark).some(isWalkPage), 'precondition: the drain passed the threshold and rebuilt')
        await fireStoreRender(state)
        assert.ok(ringOf().includes('title="1/2 checkboxes done'), 'the rebuild\'s render fills the changed ring: one of two done')
    })

    await fs.remove(tmp)
    console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed')
    process.exit(failures ? 1 : 0)
}

main().catch(error => { console.error(error); process.exit(1) })
