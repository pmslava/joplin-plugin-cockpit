/*
 * Events probe: a throwaway dev plugin for e2e/events-probe.spec.ts (Cockpit 2.7, phase 1). Never shipped.
 *
 * Joplin loads a dev plugin straight from a directory holding manifest.json and index.js, so this file is the
 * whole plugin: no build step. It registers ONE command, `eventsProbe.call`, that the spec executes through the
 * app's CommandService (`--env dev`) with a plain object argument, and answers with a plain JSON envelope:
 *
 *   { ok: true, result, seq }  or  { ok: false, error: String(error), seq }
 *
 * Ops:
 *   { op: 'events', cursor?, fields?, limit? }  one raw call of joplin.data.get(['events'], query). The query holds
 *                                               only the keys given: without a cursor there is NO cursor key at all
 *                                               (the route tests `'cursor' in query`).
 *   { op: 'note', id, fields? }                 joplin.data.get(['notes', id], { fields }), read from inside the sandbox.
 *   { op: 'sync' }                              joplin.commands.execute('synchronize', false). The command is a TOGGLE
 *                                               on the app's syncStarted state; its first argument overrides that
 *                                               state, and `false` always means "start", so the probe can never
 *                                               cancel a sync that is already running.
 *   { op: 'version' }                           joplin.versionInfo().
 *   { op: 'resultNoteId' }                      the id of the fallback result note (found or created).
 *   { op: 'fallback', enabled }                 switch the fallback channel (below) on or off.
 *   { op: 'syncState' }                         counters of onSyncStart / onSyncComplete, and the armed polls.
 *   { op: 'armSyncPoll', cursor }               from now on, every onSyncComplete polls the feed from `cursor` (all
 *                                               pages) at once and keeps what it saw: are a sync's rows already in
 *                                               the feed when the plugin is told the sync is complete?
 *   { op: 'disarmSyncPoll' }                    stop doing that.
 *   { op: 'putThenPoll', id, title }            the plugin's OWN write: take a cursor, joplin.data.put the note's
 *                                               title, and poll the feed from that cursor the instant the put returns.
 *
 * The result channel. The primary channel is the command's return value, which CommandService hands back to the
 * spec's page.evaluate. So that a run cannot be lost to a channel problem, the probe also writes each envelope as
 * JSON into the body of a note titled `events-probe-result` (the fallback channel), which the spec reads over REST
 * when a return value comes back undefined. That note's writes produce change rows of their own; the spec excludes
 * them by id, and switches the fallback off once it has seen the primary channel work.
 *
 * THE SANDBOX RULE: `joplin` is a proxy that records every member read on a shared path and only pops it on a call,
 * so every joplin.* chain below is ONE uninterrupted read-and-call expression. Nothing here stores a joplin member
 * in a variable, tests one with typeof, or reads one without calling it.
 */

const RESULT_TITLE = 'events-probe-result';
const RESULT_FOLDER_TITLE = 'events-probe';
const MAX_PAGES = 200;

let resultNoteId = null;
let fallbackEnabled = true;

const syncState = {
	started: 0,
	completed: 0,
	lastStartedAt: 0,
	lastCompletedAt: 0,
	lastCompleteEvent: null,
	armedCursor: null,
	// One entry per onSyncComplete while armed: { completedCount, at, pages, rows, error }.
	armedPolls: [],
};

/** A string for any error, including an Error that crossed the IPC boundary as a plain object. */
function describeError(error) {
	if (error === null || error === undefined) return String(error);
	let text = String(error);
	if (text === '[object Object]') {
		if (error.message) text = String(error.message);
		else {
			try {
				text = JSON.stringify(error);
			} catch (_) {
				/* keep the default text */
			}
		}
	}
	return text;
}

/** A listing response is `{ items, has_more }`; tolerate a bare array too. */
function itemsOf(response) {
	if (Array.isArray(response)) return response;
	return response && Array.isArray(response.items) ? response.items : [];
}

function hasMore(response) {
	return !!(response && !Array.isArray(response) && response.has_more);
}

/** Every page of the feed from `cursor` on. */
async function pollAll(cursor) {
	const pages = [];
	const rows = [];
	let next = String(cursor);
	for (let page = 0; page < MAX_PAGES; page++) {
		const answer = await joplin.data.get(['events'], { cursor: next });
		const items = itemsOf(answer);
		for (const row of items) rows.push(row);
		pages.push({ count: items.length, has_more: !!answer.has_more, cursor: answer.cursor });
		next = answer.cursor;
		if (!answer.has_more) break;
	}
	return { pages: pages, rows: rows };
}

async function findOrCreateFolder() {
	for (let page = 1; page <= MAX_PAGES; page++) {
		const listing = await joplin.data.get(['folders'], { fields: ['id', 'title'], limit: 100, page: page });
		const hit = itemsOf(listing).find((folder) => folder.title === RESULT_FOLDER_TITLE);
		if (hit) return hit.id;
		if (!hasMore(listing)) break;
	}
	const made = await joplin.data.post(['folders'], null, { title: RESULT_FOLDER_TITLE });
	return made.id;
}

/** The fallback note: found by title in the live listing (a relaunch forgets the module variable), else created. */
async function findOrCreateResultNote() {
	if (resultNoteId) return resultNoteId;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const listing = await joplin.data.get(['notes'], { fields: ['id', 'title'], order_by: 'id', limit: 100, page: page });
		const hit = itemsOf(listing).find((note) => note.title === RESULT_TITLE);
		if (hit) {
			resultNoteId = hit.id;
			return resultNoteId;
		}
		if (!hasMore(listing)) break;
	}
	const parentId = await findOrCreateFolder();
	const made = await joplin.data.post(['notes'], null, { title: RESULT_TITLE, body: '{}', parent_id: parentId });
	resultNoteId = made.id;
	return resultNoteId;
}

/** Write the envelope into the fallback note, when the fallback is on. Never throws: the return value still goes out. */
async function writeFallback(envelope) {
	if (!fallbackEnabled) return;
	try {
		const id = await findOrCreateResultNote();
		await joplin.data.put(['notes', id], null, { body: JSON.stringify({ seq: envelope.seq, at: Date.now(), envelope: envelope }) });
	} catch (error) {
		console.error('events probe: could not write the fallback result note:', error);
	}
}

async function runOp(args) {
	const op = args && args.op;
	if (op === 'events') {
		const query = {};
		if (args.cursor !== undefined && args.cursor !== null) query.cursor = args.cursor;
		if (args.fields !== undefined && args.fields !== null) query.fields = args.fields;
		if (args.limit !== undefined && args.limit !== null) query.limit = args.limit;
		return await joplin.data.get(['events'], query);
	}
	if (op === 'note') {
		const query = {};
		if (args.fields !== undefined && args.fields !== null) query.fields = args.fields;
		return await joplin.data.get(['notes', String(args.id)], query);
	}
	if (op === 'sync') {
		return await joplin.commands.execute('synchronize', false);
	}
	if (op === 'version') {
		return await joplin.versionInfo();
	}
	if (op === 'resultNoteId') {
		return await findOrCreateResultNote();
	}
	if (op === 'fallback') {
		fallbackEnabled = !!args.enabled;
		return { fallbackEnabled: fallbackEnabled };
	}
	if (op === 'syncState') {
		return JSON.parse(JSON.stringify(syncState));
	}
	if (op === 'armSyncPoll') {
		syncState.armedCursor = String(args.cursor);
		syncState.armedPolls = [];
		return { armedCursor: syncState.armedCursor };
	}
	if (op === 'disarmSyncPoll') {
		syncState.armedCursor = null;
		return { armedCursor: null };
	}
	if (op === 'putThenPoll') {
		const before = await joplin.data.get(['events'], {});
		const startedAt = Date.now();
		await joplin.data.put(['notes', String(args.id)], null, { title: String(args.title) });
		const putDoneAt = Date.now();
		const immediate = await joplin.data.get(['events'], { cursor: before.cursor });
		const polledAt = Date.now();
		return { cursor: before.cursor, immediate: immediate, putMs: putDoneAt - startedAt, pollMs: polledAt - putDoneAt };
	}
	throw new Error(`events probe: unknown op ${JSON.stringify(op)}`);
}

async function handle(args) {
	const seq = args && args.seq !== undefined ? args.seq : null;
	let envelope;
	try {
		envelope = { ok: true, result: await runOp(args), seq: seq };
	} catch (error) {
		envelope = { ok: false, error: describeError(error), seq: seq };
	}
	// Make sure what goes back is plain JSON, whatever the route handed over.
	try {
		envelope = JSON.parse(JSON.stringify(envelope));
	} catch (error) {
		envelope = { ok: false, error: `events probe: the result could not be serialised: ${describeError(error)}`, seq: seq };
	}
	await writeFallback(envelope);
	return envelope;
}

async function onSyncComplete(event) {
	syncState.completed++;
	syncState.lastCompletedAt = Date.now();
	try {
		syncState.lastCompleteEvent = event ? JSON.parse(JSON.stringify(event)) : null;
	} catch (_) {
		syncState.lastCompleteEvent = String(event);
	}
	if (syncState.armedCursor === null) return;
	const entry = { completedCount: syncState.completed, at: Date.now() };
	try {
		const polled = await pollAll(syncState.armedCursor);
		entry.pages = polled.pages;
		entry.rows = polled.rows;
		entry.polledMs = Date.now() - entry.at;
	} catch (error) {
		entry.error = describeError(error);
	}
	syncState.armedPolls.push(entry);
	if (syncState.armedPolls.length > 10) syncState.armedPolls.shift();
}

joplin.plugins.register({
	onStart: async function () {
		await joplin.commands.register({
			name: 'eventsProbe.call',
			label: 'Events probe: call',
			execute: async (args) => handle(args),
		});
		await joplin.workspace.onSyncStart(() => {
			syncState.started++;
			syncState.lastStartedAt = Date.now();
		});
		await joplin.workspace.onSyncComplete((event) => onSyncComplete(event));
	},
});
