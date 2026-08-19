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
        assert.deepStrictEqual(mobile.workspaceEvents.sort(), ['onNoteAlarmTrigger', 'onNoteChange', 'onSyncComplete', 'onSyncStart'])
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
        assert.ok(body.includes('onTodoClicked(todoID)'), 'the row must still open the to-do')
        assert.ok(!body.includes("classList.contains('todo-title')"), 'opening must NOT be gated on the title zone - a dead-zone click must open too')
    })
    await test('row click: onNoteRowClicked opens beyond the title (a note row has no checkbox to guard)', () => {
        const body = handlerBody('onNoteRowClicked')
        assert.ok(body.includes("classList.contains('todo-notebook')"), 'the notebook-pill guard must stay')
        assert.ok(body.includes('onTodoClicked(noteID)'), 'the row must still open the note')
        assert.ok(!body.includes("classList.contains('todo-title')"), 'opening must NOT be gated on the title zone')
    })
    await test('row dblclick: onRowDoubleClicked stays title-scoped and desktop-only', () => {
        // Double-click-to-new-window is a title-only, desktop-only affordance; the dead-zone open fix must not
        // spread it to the whole row.
        const body = handlerBody('onRowDoubleClicked')
        assert.ok(body.includes("classList.contains('todo-title')"), 'dblclick-to-new-window must stay gated on the title zone')
        assert.ok(body.includes('IS_MOBILE'), 'dblclick-to-new-window must stay desktop-only')
        assert.ok(body.includes('openInNewWindow'), 'dblclick must still open a new window')
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

    // Version lockstep: the four version fields (package.json, src/manifest.json, and BOTH package-lock fields)
    // drifted once when the lockfile was left stale. This cheap read-and-compare keeps all four pinned together.
    await test('version: package.json, manifest, and both package-lock fields are all 1.8.7', () => {
        const root = path.join(__dirname, '..')
        const readJSON = (...rel) => JSON.parse(fs.readFileSync(path.join(root, ...rel), 'utf8'))
        const pkg = readJSON('package.json')
        const manifest = readJSON('src', 'manifest.json')
        const lock = readJSON('package-lock.json')
        const expected = '1.8.7'
        assert.strictEqual(pkg.version, expected, 'package.json version')
        assert.strictEqual(manifest.version, expected, 'src/manifest.json version')
        assert.strictEqual(lock.version, expected, 'package-lock.json top-level version')
        assert.strictEqual(lock.packages[''].version, expected, 'package-lock.json root package entry version')
    })

    // The plain to-do disc (a to-do with no checkbox ring, and the count-pending fast-paint row that shares the
    // same .-plain class) gets a border so it reads clearly on the panel background. The border must derive from
    // the --cockpit-color-faded muted-foreground variable (with its established fallback) - never a new colour
    // literal - and it must NOT disturb the circle geometry (the 18px --cockpit-circle-size box, the 3px ring
    // inset, the 4px disc inset). Read panel.css as source text, the same way the other markup/CSS checks do.
    await test('plain disc: bordered in the muted foreground variable, circle geometry untouched', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'panel', 'panel.css'), 'utf8')
        const ruleBody = (selector) => {
            const at = css.indexOf(selector)
            assert.ok(at >= 0, `panel.css is missing the ${selector} rule`)
            const open = css.indexOf('{', at)
            const close = css.indexOf('}', open)
            assert.ok(open >= 0 && close > open, `panel.css ${selector} rule is malformed`)
            return css.slice(open + 1, close)
        }
        // The plain disc carries a border in --cockpit-color-faded, the muted foreground the panel already uses
        // for headings and faded text. Unlike --cockpit-divider-color (which equals the disc fill, and on
        // aritimDark equals the panel background), this contrasts against both fill and background, so the disc
        // reads as a defined circle in every theme. It uses that variable's established #999999 fallback - the
        // same fallback used elsewhere in panel.css - so no NEW colour literal is introduced.
        const plainBefore = ruleBody('.todo-checkbox.-plain::before')
        assert.ok(/border:\s*[^;]*var\(--cockpit-color-faded,\s*#999999\)/.test(plainBefore),
            'the .-plain disc must get a border in --cockpit-color-faded with its established #999999 fallback')
        assert.ok(!/#(?!999999\b)[0-9a-fA-F]{3,8}\b/.test(plainBefore),
            'the plain-disc border must not introduce a new hex colour literal beyond the established #999999 fallback')
        // Geometry is untouched: the circle-size default and the two fixed insets that the "circles saga" depends
        // on are all still exactly what they were, and the plain-disc border rule did not touch any of them.
        assert.ok(/--cockpit-circle-size:\s*18px/.test(css), 'the 18px --cockpit-circle-size default must be intact')
        assert.ok(/inset:\s*3px/.test(ruleBody('.todo-checkbox::after')), 'the 3px ring inset must be intact')
        assert.ok(/inset:\s*4px/.test(ruleBody('.todo-checkbox::before')), 'the 4px disc inset must be intact')
        assert.ok(!/inset|width|height|margin/.test(plainBefore),
            'the plain-disc border rule must add only a border - never an inset/size/margin that would move the outer box')
    })

    await fs.remove(tmp)
    console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed')
    process.exit(failures ? 1 : 0)
}

main().catch(error => { console.error(error); process.exit(1) })
