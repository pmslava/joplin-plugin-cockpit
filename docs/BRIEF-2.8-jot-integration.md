# Cockpit 2.8: calling Jot (orchestration brief)

Written 2026-10-11. The quick-capture form that xiaofeng's request (post 19 of the forum thread) and Slava's candidate implementations asked for is a plugin of its own, **Jot** (`/home/mrsir/Lab/joplin-plugin-jot`, `docs/BRIEF-1.0-jot.md`, which also carries the reasoning for the split). Cockpit 2.8 only calls it, and only on desktop. This brief is the Cockpit side; Jot 0.1.0 shipped on 2026-10-11 with the contract below, so it can be built now, in the shape of `docs/BRIEF-2.7-local-mirror.md` (its sections 4 and 8 still hold). The shelved virtualised-list brief keeps its file name and takes whatever number is free when it is revived.

## 1. What the code does today (facts from the survey at d5c2767)

The two buttons are drawn by `getControlsHTML` in `src/ui/panel/panel.ts` (near line 1585) with `onclick="onNewNoteClicked()"` / `onNewTodoClicked()` and no right-click handler. The webview handlers (`src/ui/panel/panelWebview.js` near line 2506) post `newNoteClicked` / `newTodoClicked`; the host's `createItem(isTodo)` resolves the notebook filter, asks with the native picker under "All notebooks", and `createItemInFolder` POSTs an empty note, `applyLocalCreate`s it, opens it (`openTodo`), applies Joplin's title-or-body focus setting (`focusNewItemEditor`) and shows the row from the store. A double-click on a row's title already posts `openInNewWindow`, and the host runs `openNoteInNewWindow` through `runAppCommand` (near line 520), which shows "is not available here" when the app lacks the command. The row menu is the pure module `src/ui/panel/noteMenu.js` (an ordered item list, `SINGLE_ONLY` with only `open`, counted labels), dispatched by `showNoteContextMenu` on `data-action`. Settings are enums with `isEnum` and `options` in `src/core/settings.ts`; the two new ones are per device, like the toolbar and title-bar options.

## 2. The contract Jot provides (from 1.0.0, kept)

`joplin.commands.execute('jot.open', args)`:
- `{ mode: 'new', type: 'todo' | 'note', title?, body?, notebookId? }` opens create mode with those presets; resolves `{ id, opened }`, or `null` on Cancel.
- `{ mode: 'edit', noteId }` opens edit mode (title, type, notebook, tags, due; never the body); resolves `{ id, changed: string[] }`, or `null`.
On an app without Jot the call throws "command not found".

## 3. What 2.8 adds

- **Two settings**, per device: "New note and New to-do: click" (default *Create and open in the editor*, today's behaviour) and "New note and New to-do: right-click" (default *Jot*), each with *Create and open in the editor* / *Create and open in a new window* / *Jot*. The new-window value is today's create followed by `openNoteInNewWindow`, with the focus step skipped and a silent fallback to the editor when the command is missing. The Jot value calls `jot.open` with `mode: 'new'`, the button's type and the panel's filtered notebook as `notebookId` (none under "All notebooks": Jot's own default applies), and never asks with the picker. The right-click is an `oncontextmenu` handler on each button (`preventDefault`); nothing changes on mobile, where the long press keeps its meaning and the typed trigger is the way into Jot.
- **Quick edit…** in the row menu, second after Open, single-only (greyed in a multi-selection), calling `mode: 'edit'` with the row's id.
- **After the call resolves with an id**, Cockpit drains its change feed at once (the follow-up poll its own writes arm), so the row appears or updates without waiting for the idle poll; Jot's writes reach the store through the feed like any outside edit.
- **Absence:** when the command throws "not found", one message box per session names the Jot plugin, and the click falls back to today's create-and-open.

## 4. Phases and gates

One worker per phase, Opus-class, in Cockpit's worktree; harness green and a local commit per phase; the e2e gate under the machine-wide lock.

- **Phase 1 — settings and buttons.** The two settings, the click and right-click dispatch, the new-window route, the markup pins (the handler on both buttons; mobile markup byte-identical to today). Gate: harness checks for each value and the fallbacks; an e2e spec setting each value through the settings API and checking the editor's note after a click (a second window for the new-window value).
- **Phase 2 — the Jot calls.** The `jot.open` calls, the feed drain after them, the absence message, Quick edit… in `noteMenu.js` with its multi-select pin. Gate: harness checks with a stubbed command (the arguments passed, the drain, the one-per-session message); an e2e spec with Jot installed beside Cockpit in the launcher's profile (a right-click creates without changing the editor's note; Quick edit… renames a row).
- **Phase 3 — docs and release.** README ("Notebooks and notes", "Selecting rows, and the row menu", "Settings", "Works with Jot" beside "Works with Whereabouts"), `docs/DEVLOG.md`, the version quadruple, the release procedure, the thread post with Jot's.

## 5. Standing rules

Cockpit's 2.7 brief section 8, the sandbox proxy rule, the own-write bracket around every write Cockpit itself makes, plain-text reviewer reports, no `#` suffix in commit subjects, commit locally after review, push and publish only on Slava's approval.
