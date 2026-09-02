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
    const K = 'c'.repeat(32), P = 'p'.repeat(32), AC = 'a'.repeat(32), AP = 'b'.repeat(32), T = 't'.repeat(32), S = 's'.repeat(32)
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
        assert.strictEqual(ex.settings.excludedNotebooks, 'Client / Archive, Trash', 'the visible text is rewritten to canonical labels (path form where the title is ambiguous)')
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
        assert.strictEqual(ex.settings.excludedNotebooks, 'ArchivedFolder, Trash', 'the visible text is refreshed to the new (now unique) title')
        // No onChange loop: another poll with the same folders changes nothing further.
        const textBefore = ex.settings.excludedNotebooks
        await pollEntry.fn()
        assert.strictEqual(ex.settings.excludedNotebooks, textBefore, 'the reconcile settles - no oscillation')
        // Still excluded from the rows after the rename.
        await ex.panelMessageHandler(['sortDirectionClicked'])
        assert.ok(!ex.panelHtml['panel-panel'].includes('ArchivedC'), 'the renamed notebook\'s to-do stays excluded')
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
        assert.ok(webviewSource.includes("['todosDroppedBetween', ids, prevId, nextId, target.groupDate]"), 'the between drop must post todosDroppedBetween with prev/next/groupDate')
        assert.ok(/getAttribute\('data-drop'\)/.test(webviewSource) && /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(webviewSource), 'the group date must be read from the existing heading data-drop (a YYYY-MM-DD)')
        assert.ok(/parentElement\.classList\.contains\('todos'\)/.test(webviewSource), 'eligibility must be limited to rows that are direct children of .todos (list views only)')
        // Desktop-gated: both drag handlers bail immediately on mobile (drag does not exist there anyway).
        assert.ok(/function onBetweenDragOver\(event\)\{\s*if \(IS_MOBILE\) return/.test(webviewSource), 'onBetweenDragOver must be desktop-gated (IS_MOBILE)')
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
        assert.ok(/return \{ groupDate: null \}/.test(webviewSource), 'a dateless group (Overdue/Future) must be eligible with a null groupDate')
        assert.ok(/return \{ groupDate: drop \}/.test(webviewSource), 'a dated group must still carry its YYYY-MM-DD date')
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

    // Version lockstep: the four version fields (package.json, src/manifest.json, and BOTH package-lock fields)
    // drifted once when the lockfile was left stale. This cheap read-and-compare keeps all four pinned together.
    await test('version: package.json, manifest, and both package-lock fields are all 2.1.3', () => {
        const root = path.join(__dirname, '..')
        const readJSON = (...rel) => JSON.parse(fs.readFileSync(path.join(root, ...rel), 'utf8'))
        const pkg = readJSON('package.json')
        const manifest = readJSON('src', 'manifest.json')
        const lock = readJSON('package-lock.json')
        const expected = '2.1.3'
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

    await test('type flip (stale index row): a search row whose own is_todo contradicts its list is dropped, on the ordinary path too', () => {
        const html = contradict.panelHtml['panel-panel']
        assert.ok(html.includes('RealTodo') && html.includes('RealNote'), 'the rows that agree with their list are kept')
        assert.ok(!html.includes('NotATodoAnyMore'), 'a type:todo row that is no longer a to-do is dropped')
        assert.ok(!html.includes('NotANoteAnyMore'), 'a type:note row that is no longer a note is dropped')
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
        assert.ok(webviewSource.includes("document.addEventListener('scroll', hideNoteContextMenu, true)"), 'the scroll dismissal must stay')
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

        // (c) contextmenu inside the list is suppressed on mobile - the belt to the CSS braces - and left alone
        // on desktop, where a right-click in the list is unchanged.
        const menuBlock = /document\.addEventListener\('contextmenu', function\(event\)\{([\s\S]*?)\}, true\)/.exec(webviewSource)
        assert.ok(menuBlock, 'contextmenu inside the suggestion list must be handled')
        assert.ok(menuBlock[1].includes('if (!IS_MOBILE) return'), 'and only on mobile - desktop right-click is untouched')
        assert.ok(menuBlock[1].includes("closest('#searchSuggestions')") && menuBlock[1].includes('preventDefault()'),
            'the native menu must be prevented inside the list')
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

    await test('mobile diagnostic: the gesture trace is a mobile-only, default-off setting (1.9.10)', () => {
        // After two device rounds spent guessing, the next one can report what actually fired.
        const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'settings.ts'), 'utf8')
        assert.ok(/gestureTraceSettingKey = "gestureTrace"/.test(settingsSource), 'the setting must exist')
        const block = /\[gestureTraceSettingKey\]: \{([\s\S]*?)\},/.exec(settingsSource)
        assert.ok(block, 'the setting must be registered')
        assert.ok(/value: false/.test(block[1]), 'and default to OFF')
        assert.ok(/type: SettingItemType\.Bool/.test(block[1]), 'as a Bool')
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
        assert.ok(cacheSource.includes('var cacheKey = anyMode ? `any|x${excluded.clauses}|${query}` : query'),
            'and the notes key its own')
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


    // ------------------------------------------------ last day of a period stays in its own horizon (issue #3)
    // getEndOfThisMonth/getEndOfThisYear used to return their last day at MIDNIGHT, so a to-do due later on that
    // day fell past the boundary: the last day of the month landed in "This Year", and December 31st in "Future"
    // (what Marxsal reported in issue #3). Both helpers now end at 23:59:59.999. The fixtures below are built
    // from the REAL clock with local Date constructors - the harness has no fake clock - so every expected
    // heading set is written to hold on every calendar day and time of day the suite could run. That breadth has
    // a cost worth knowing about: in the closing days of a month the two positive checks stop discriminating,
    // because an earlier horizon (Tomorrow / This Week) then catches the row with or without the fix, and the
    // same goes for the December 31st check in the closing days of December. They are never wrong, only blind on
    // those days - the mutation verification behind them was run mid-month, where both do discriminate.
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
    const horizonYear = horizonNow.getFullYear()
    const horizonMonth = horizonNow.getMonth()
    const horizonDue = (date, title, index) => ({
        id: String(index).repeat(32).slice(0, 32), title, todo_completed: 0,
        parent_id: 'n'.repeat(32), user_updated_time: 1, todo_due: date.getTime(),
    })
    const horizonState = await run({
        dataDir: path.join(tmp, 'horizon-data'),
        installationDir: path.join(tmp, 'desktop-install'),
        require: desktopRequire,
        versionInfo: { version: '3.7.0', platform: 'desktop' },
        todos: [
            // 22:00 rather than midnight: the whole point is a to-do due LATE on the last day of its period.
            horizonDue(new Date(horizonYear, horizonMonth + 1, 0, 22, 0, 0, 0), 'Horizon last day of this month', 1),
            horizonDue(new Date(horizonYear, 11, 31, 22, 0, 0, 0), 'Horizon December thirty first', 2),
            horizonDue(new Date(horizonYear, horizonMonth + 1, 1, 12, 0, 0, 0), 'Horizon first day of next month', 3),
            horizonDue(new Date(horizonYear + 1, 0, 1, 12, 0, 0, 0), 'Horizon January first next year', 4),
        ],
        initialSettings: {
            profileData: JSON.stringify({ nextID: 2, profiles: [{ ...baseProfile, id: 1, name: 'Horizons', sortOrder: 0 }] }),
            currentProfileID: 1,
        },
    })

    await test('horizons: a to-do due late on the last day of this month never falls past This Month', () => {
        // The due date is in the current month and never before today, so it can only be Today (today IS the last
        // day), Tomorrow, This Week (the month ends inside this week) or This Month - never This Year or Future.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon last day of this month')
        assert.ok(['Today', 'Tomorrow', 'This Week', 'This Month'].includes(heading),
            `the last day of the month landed under ${heading}`)
    })

    await test('horizons: a to-do due late on December 31st never falls into Future (issue #3)', () => {
        // December 31st of the CURRENT year is never before today and never past the end of this year, so it is
        // Today/Tomorrow/This Week (only in late December), This Month (only in December) or This Year - the
        // heading varies with the date, but Future is impossible on every day of every year, leap years included.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon December thirty first')
        assert.ok(['Today', 'Tomorrow', 'This Week', 'This Month', 'This Year'].includes(heading),
            `December 31st landed under ${heading}`)
    })

    await test('horizons: a to-do due on the first day of next month is never This Month', () => {
        // It is past the end of this month by construction, so only the horizons BEYOND the month remain: This
        // Year (next month is still this year), Future (next month is January), or the day-level Tomorrow / This
        // Week when the month ends within a day or a week of today - whichever weekday the week starts on.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon first day of next month')
        assert.ok(['Tomorrow', 'This Week', 'This Year', 'Future'].includes(heading),
            `the first day of next month landed under ${heading}`)
    })

    await test('horizons: a to-do due on January 1st of next year is never This Month or This Year', () => {
        // It is past both this month's and this year's end on every day of the year, leaving only Future and -
        // in the last days of December, for either week start - the day-level Tomorrow / This Week.
        const heading = horizonHeadingOf(horizonState.panelHtml['panel-panel'], 'Horizon January first next year')
        assert.ok(['Tomorrow', 'This Week', 'Future'].includes(heading),
            `January 1st of next year landed under ${heading}`)
    })

    await test('horizons: the This Month and This Year headings still drop onto their own last day', () => {
        // getHeadingDropTarget passes both widened helpers through toISODate(), which reads only year, month and
        // day, so ending them at 23:59:59.999 must leave the drop date exactly where it was. Each heading only
        // renders when its group is non-empty: near a month's end the fixtures move up into Tomorrow/This Week,
        // and in December nothing can be This Year without also being This Month, so on those days there is
        // nothing to look at - on the rest of the calendar this pins the claim instead of arguing it.
        const html = horizonState.panelHtml['panel-panel']
        const pad = value => String(value).padStart(2, '0')
        const lastOfMonth = new Date(horizonYear, horizonMonth + 1, 0)
        const dropOf = heading => {
            const found = new RegExp(`<h2([^>]*)>${heading}</h2>`).exec(html)
            return found ? (/ data-drop="([^"]*)"/.exec(found[1]) || [])[1] : undefined
        }
        const monthDrop = dropOf('This Month')
        if (monthDrop !== undefined) assert.strictEqual(monthDrop,
            `${lastOfMonth.getFullYear()}-${pad(lastOfMonth.getMonth() + 1)}-${pad(lastOfMonth.getDate())}`,
            'the This Month heading no longer drops onto the last day of the month')
        const yearDrop = dropOf('This Year')
        if (yearDrop !== undefined) assert.strictEqual(yearDrop, `${horizonYear}-12-31`,
            'the This Year heading no longer drops onto December 31st')
    })

    await fs.remove(tmp)
    console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed')
    process.exit(failures ? 1 : 0)
}

main().catch(error => { console.error(error); process.exit(1) })
