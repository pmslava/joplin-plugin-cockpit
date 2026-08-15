// Runs the compiled Agenda bundle against a stubbed Joplin plugin API.
// The bundle refers to `joplin` as a free global, so it can be driven from Node.

const path = require('path')

const bundlePath = path.resolve(__dirname, '../dist/index.js')

function makeJoplin(options) {
    const settings = Object.assign({}, options.initialSettings)
    const state = {
        settings,
        registeredSettings: null,
        panels: [],
        dialogs: [],
        panelHtml: {},
        panelScripts: [],
        toolbarButtons: [],
        menus: [],
        commands: [],
        workspaceEvents: [],
        messageBoxes: [],
        notePuts: [],
        dataPosts: [],
        dataDeletes: [],
        onStart: null,
        panelMessageHandler: null,
        setHtmlCalls: 0,
        // Every data.get, recorded as { path, query }, so tests can count search round-trips, single-note
        // reads (the removed GET-before-PUT), and the folder poll's request.
        gets: [],
        // setInterval callbacks captured during startup (the periodic timer + the folder poll) so the suite
        // can drive them by hand rather than on a real clock. Each is { fn, ms, cleared }.
        intervals: [],
        // Set to a DialogResult to make the next dialogs.open() return it instead of a cancel.
        dialogResult: null,
    }

    const notes = options.notes || {}

    const joplin = {
        plugins: {
            register: (script) => { state.onStart = script.onStart },
            dataDir: async () => options.dataDir,
            installationDir: async () => options.installationDir,
        },
        require: (moduleName) => options.require(moduleName),
        versionInfo: async () => options.versionInfo,
        settings: {
            registerSection: async () => {},
            registerSettings: async (defs) => {
                state.registeredSettings = defs
                for (const key of Object.keys(defs)) {
                    if (!(key in settings)) settings[key] = defs[key].value
                }
            },
            value: async (key) => settings[key],
            setValue: async (key, value) => {
                settings[key] = value
                for (const handler of state.settingHandlers) await handler({ keys: [key] })
            },
            onChange: async (handler) => { state.settingHandlers.push(handler) },
        },
        commands: {
            register: async (command) => { state.commands.push(command) },
            execute: async (name, ...args) => {
                const command = state.commands.find(c => c.name === name)
                if (command) return await command.execute(...args)
            },
        },
        views: {
            panels: {
                create: async (id) => { state.panels.push(id); return `panel-${id}` },
                addScript: async (handle, script) => { state.panelScripts.push(script) },
                onMessage: async (handle, handler) => { state.panelMessageHandler = handler },
                setHtml: async (handle, html) => { state.setHtmlCalls++; state.panelHtml[handle] = html },
                show: async () => {},
                visible: async () => true,
            },
            dialogs: {
                create: async (id) => { state.dialogs.push(id); return `dialog-${id}` },
                addScript: async () => {},
                setHtml: async () => {},
                setButtons: async () => {},
                open: async () => state.dialogResult || { id: 'cancel' },
                showMessageBox: async (message) => { state.messageBoxes.push(message); return 0 },
            },
            toolbarButtons: {
                create: async (id, command, location) => { state.toolbarButtons.push({ id, command, location }) },
            },
            menus: {
                create: async (id, label, items, location) => { state.menus.push({ id, label, location }) },
            },
        },
        workspace: {
            onNoteChange: async (h) => { state.workspaceEvents.push('onNoteChange'); state.noteChangeHandler = h },
            onSyncStart: async () => { state.workspaceEvents.push('onSyncStart') },
            onSyncComplete: async () => { state.workspaceEvents.push('onSyncComplete') },
            onNoteAlarmTrigger: async () => { state.workspaceEvents.push('onNoteAlarmTrigger') },
        },
        data: {
            get: async (pathParts, query) => {
                state.gets.push({ path: pathParts.slice(), query })
                if (pathParts[0] === 'search') {
                    // getTodos queries "type:todo ...", getNotes queries "type:note ...". Serve the
                    // regular-note list only to the type:note query so a showNotes profile does not
                    // list the to-do fixtures a second time as notes.
                    const q = (query && query.query) || ''
                    if (q.includes('type:note') && !q.includes('type:todo')) {
                        return { items: options.searchNotes || [], has_more: false }
                    }
                    return { items: options.todos || [], has_more: false }
                }
                // The notebook map and the tag autocomplete page through these endpoints.
                if (pathParts[0] === 'folders') {
                    return { items: options.folders || [], has_more: false }
                }
                if (pathParts[0] === 'tags') {
                    return { items: options.tags || [], has_more: false }
                }
                if (pathParts[0] === 'notes') {
                    // Bare ['notes'] is the search field's "recent notes" suggestion fetch.
                    if (pathParts.length === 1) return { items: options.recentNotes || [], has_more: false }
                    const note = notes[pathParts[1]]
                    if (!note) throw new Error('Not Found')
                    // ['notes', id, 'tags'] lists the tags currently on a note (tag picker).
                    if (pathParts[2] === 'tags') return { items: note.tags || [] }
                    return note
                }
                throw new Error(`Unexpected data.get: ${pathParts}`)
            },
            put: async (pathParts, _q, body) => {
                // `fields` keeps the whole PUT body so a test can assert the exact shape (e.g. that a tick
                // writes a numeric todo_completed); `body` stays the note-body string the older checks read.
                state.notePuts.push({ id: pathParts[1], body: body.body, fields: body })
                if (notes[pathParts[1]]) Object.assign(notes[pathParts[1]], body)
            },
            post: async (pathParts, _q, body) => {
                state.dataPosts.push({ path: pathParts, body })
                return Object.assign({ id: `created-${state.dataPosts.length}` }, body)
            },
            delete: async (pathParts) => { state.dataDeletes.push(pathParts) },
        },
    }

    state.settingHandlers = []
    state.notes = notes
    return { joplin, state }
}

async function run(options) {
    const { joplin, state } = makeJoplin(options)
    global.joplin = joplin
    delete require.cache[require.resolve(bundlePath)]
    require(bundlePath)
    if (!state.onStart) throw new Error('Plugin did not register an onStart handler')
    // Capture the intervals the plugin arms at startup (the periodic refresh timer and the folder poll)
    // instead of scheduling them on a real clock: the suite invokes them by hand, and leaving many run()s'
    // worth of live intervals ticking would otherwise pollute later tests. Restored right after onStart, so
    // the test's own timers are unaffected.
    const realSetInterval = global.setInterval
    const realClearInterval = global.clearInterval
    global.setInterval = (fn, ms) => { const id = state.intervals.length; state.intervals.push({ fn, ms, cleared: false }); return id }
    global.clearInterval = (id) => { if (typeof id === 'number' && state.intervals[id]) state.intervals[id].cleared = true }
    try {
        await state.onStart({})
    } finally {
        global.setInterval = realSetInterval
        global.clearInterval = realClearInterval
    }
    return state
}

module.exports = { run }
