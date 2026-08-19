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

    await fs.remove(tmp)
    console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed')
    process.exit(failures ? 1 : 0)
}

main().catch(error => { console.error(error); process.exit(1) })
