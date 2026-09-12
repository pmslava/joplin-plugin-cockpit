/** README ******************************************************************************************************************************************
 * The notebook-picker dialog's DOM glue. The dialog itself is markup the host writes with dialogs.setHtml on every open (see pickNotebook in        *
 * panel.ts): a filter box, a list of .picker-row divs - one per notebook, already sorted, already excluded-filtered, one of them pre-selected - and  *
 * a hidden folderId input that carries the answer back in formData.picker.folderId. This file only wires them together; every DECISION (which rows   *
 * a filter leaves, where an arrow key lands, what Enter commits, what Escape means) is made by the pure window.NotebookPickerModel, which the Node    *
 * harness drives directly.                                                                                                                          *
 *                                                                                                                                                    *
 * WHY THE ROWS ARE NOT BUILT HERE. Joplin measures a fit-to-content dialog ONCE, from the markup, before any of its scripts run, and never measures   *
 * again. A list built from script would therefore be laid out inside a dialog sized for an empty one. So the host emits every row, and this file only *
 * shows and hides them.                                                                                                                              *
 *                                                                                                                                                     *
 * WHY THERE IS A MutationObserver. A dialog's scripts are injected once, after the document is already parsed, and the same document is then REUSED   *
 * for every later open with fresh setHtml markup. So init must run neither on DOMContentLoaded (long past) nor only once (the second open would get   *
 * a dead form): the observer catches each new form as it is written, and the readyState branch covers the first open. Exactly the bootstrap           *
 * alarmWebview.js uses, for exactly the same reason.                                                                                                 *
 ***************************************************************************************************************************************************/

// The rows of the CURRENT open, as { id, path, el }, in markup order - the array every model call is asked about.
var pickerRows = []

// The index of the selected row in pickerRows, or -1 when the list is empty. This is BOTH the keyboard highlight and
// the committed answer: whatever it points at is mirrored into the hidden folderId input, so OK always commits what
// the user can see is selected.
var pickerSelectedIndex = -1

function pickerForm(){
    return document.querySelector('form[name="picker"]')
}

/** applyPickerFilter *******************************************************************************************************************************
 * Shows or hides every row by whether it survives `text`, through the shared, tested matcher. A hidden row keeps its place in pickerRows, so the     *
 * arrow keys step over it rather than renumbering anything.                                                                                          *
 ***************************************************************************************************************************************************/
function applyPickerFilter(text){
    var visible = window.NotebookPickerModel.visibleIndexes(pickerRows, text)
    var shown = {}
    for (var index = 0; index < visible.length; index++) shown[visible[index]] = true
    for (var row = 0; row < pickerRows.length; row++){
        if (shown[row]) pickerRows[row].el.removeAttribute('hidden')
        else pickerRows[row].el.setAttribute('hidden', '')
    }
}

/** selectPickerRow *********************************************************************************************************************************
 * Moves the selection to one row: the -selected class follows it, and the hidden folderId input is rewritten at the same moment, so the form's value *
 * can never disagree with what is highlighted. With `scroll` the row is brought into view inside the scrolling list (block:'nearest' leaves the list  *
 * alone when the row is already on screen).                                                                                                          *
 ***************************************************************************************************************************************************/
function selectPickerRow(index, scroll){
    if (index < 0 || index >= pickerRows.length) return
    pickerSelectedIndex = index
    for (var row = 0; row < pickerRows.length; row++){
        if (row === index) pickerRows[row].el.classList.add('-selected')
        else pickerRows[row].el.classList.remove('-selected')
    }
    var form = pickerForm()
    var hidden = form ? form.querySelector('input[name="folderId"]') : null
    if (hidden) hidden.value = pickerRows[index].id
    if (scroll && pickerRows[index].el.scrollIntoView) pickerRows[index].el.scrollIntoView({ block: 'nearest' })
}

/** submitPicker ************************************************************************************************************************************
 * Accepts the dialog from script. Joplin's injected UserWebviewIndex.js listens for a SUBMIT event on the dialog DOCUMENT and answers it by running   *
 * the OK button's own handler (serialize the forms, close with that result), so a submit event bubbling out of the form is exactly the OK button.     *
 * The event is DISPATCHED rather than raised with form.submit() / requestSubmit(): a synthetic submit event never triggers the browser's own form     *
 * submission, so a host that did not listen would simply ignore it - where a real submission, on a form with no action, would navigate this iframe    *
 * away and leave an empty dialog on screen. Used by the double click; Enter needs nothing here (see below).                                           *
 ***************************************************************************************************************************************************/
function submitPicker(){
    var form = pickerForm()
    if (!form) return
    try {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    } catch (error){
        // A build without the Event constructor in the dialog document: nothing to do, OK still works.
    }
}

/** onPickerFilterKeyDown ***************************************************************************************************************************
 * The dialog's whole keyboard: ArrowDown/ArrowUp move the selection over the still-visible rows (wrapping), Enter commits the selection - the first  *
 * visible row when the filter has hidden it - and accepts the dialog, and Escape clears a filter that has text while an EMPTY box is left to Joplin,  *
 * which cancels the dialog. The same two-step Escape the panel's notebook dropdown has.                                                               *
 *                                                                                                                                                     *
 * ENTER IS THE HOST'S, NOT OURS. Joplin's injected script has its own document-level keydown handler that treats Enter in a text input as a submit,    *
 * and it listens in the BUBBLE phase without looking at defaultPrevented - so it fires after this handler whatever this handler does. That ordering is *
 * exactly what is wanted: the row is committed into the hidden input here, then the host serializes the form and closes with it. preventDefault is     *
 * still called, but for the OTHER Enter path: the browser's own implicit submission (this form has a single field that blocks it), which would         *
 * navigate the iframe and would ALSO reach the host's submit listener, closing the dialog a second time. Prevented, exactly one accept happens.        *
 * With nothing visible to commit the press is swallowed outright, so an Enter on a filter that matches no notebook does nothing at all.                *
 ***************************************************************************************************************************************************/
function onPickerFilterKeyDown(event){
    var text = event.currentTarget.value
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp'){
        event.preventDefault()
        var next = window.NotebookPickerModel.moveHighlight(pickerRows, text, pickerSelectedIndex, event.key === 'ArrowDown' ? 1 : -1)
        if (next >= 0) selectPickerRow(next, true)
        return
    }
    if (event.key === 'Enter'){
        event.preventDefault()
        var target = window.NotebookPickerModel.enterTarget(pickerRows, text, pickerSelectedIndex)
        if (target < 0){ event.stopPropagation(); return }
        selectPickerRow(target, true)
        return
    }
    if (event.key === 'Escape'){
        // With text in the box the press is swallowed - both from the host's document-level dismiss handler
        // (stopPropagation) and from the window manager's own close request on the modal (preventDefault) - so
        // the first Escape only clears the filter. An empty box is left alone and Joplin cancels the dialog.
        if (window.NotebookPickerModel.escapeAction(text) !== 'clear') return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.value = ''
        applyPickerFilter('')
    }
}

/** onPickerListClick / onPickerListDoubleClick *****************************************************************************************************
 * One delegated listener each for the whole list, so a hundred-row dialog carries two listeners rather than two hundred. A click selects the row; a  *
 * double click selects it and commits, the way a double click in a file list opens what it lands on.                                                 *
 ***************************************************************************************************************************************************/
function pickerRowIndexOf(target){
    var el = target && target.closest ? target.closest('.picker-row') : null
    if (!el) return -1
    for (var row = 0; row < pickerRows.length; row++) if (pickerRows[row].el === el) return row
    return -1
}

function onPickerListClick(event){
    var index = pickerRowIndexOf(event.target)
    if (index >= 0) selectPickerRow(index, false)
}

function onPickerListDoubleClick(event){
    var index = pickerRowIndexOf(event.target)
    if (index < 0) return
    selectPickerRow(index, false)
    submitPicker()
}

/** initNotebookPickerIfNeeded **********************************************************************************************************************
 * Wires one freshly written picker form. Idempotent through a marker on the form itself, so the observer below can fire as often as it likes and a   *
 * re-open (a NEW form element) is wired exactly once.                                                                                                *
 ***************************************************************************************************************************************************/
function initNotebookPickerIfNeeded(){
    var form = pickerForm()
    if (!form || form.getAttribute('data-picker-ready') === '1') return
    form.setAttribute('data-picker-ready', '1')

    var list = form.querySelector('.picker-list')
    var filter = form.querySelector('.picker-filter')

    pickerRows = []
    pickerSelectedIndex = -1
    var elements = list ? list.querySelectorAll('.picker-row') : []
    for (var index = 0; index < elements.length; index++){
        pickerRows.push({
            id: elements[index].getAttribute('data-id') || '',
            path: (elements[index].textContent || '').trim(),
            el: elements[index],
        })
        if (elements[index].classList.contains('-selected')) pickerSelectedIndex = index
    }
    // The host marks the notebook the app is showing; with none of them marked (it is excluded, or there is no
    // selected notebook at all) the first row is the answer, exactly as the old <select> defaulted to its first option.
    if (pickerSelectedIndex < 0 && pickerRows.length) pickerSelectedIndex = 0
    if (pickerSelectedIndex >= 0) selectPickerRow(pickerSelectedIndex, true)

    if (list){
        list.addEventListener('click', onPickerListClick)
        list.addEventListener('dblclick', onPickerListDoubleClick)
    }
    if (filter){
        filter.addEventListener('input', function(event){ applyPickerFilter(event.target.value) })
        filter.addEventListener('keydown', onPickerFilterKeyDown)
        // autofocus in the markup is honoured only while the document is parsing, and this script runs long
        // after that, so the box is focused here. Desktop-only dialog: there is no soft keyboard to pop.
        filter.focus()
    }
}

new MutationObserver(initNotebookPickerIfNeeded).observe(document.documentElement, { childList: true, subtree: true })
if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initNotebookPickerIfNeeded)
} else {
    initNotebookPickerIfNeeded()
}
