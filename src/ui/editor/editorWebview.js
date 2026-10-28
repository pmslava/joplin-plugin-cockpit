
// Get Form Elements
let nameInput = document.getElementById("nameInput")
let sortOrderInput = document.getElementById("sortOrderInput")
let searchCriteriaInput = document.getElementById("searchCriteriaInput")
let noteIDInput = document.getElementById("noteIDInput")
let showCompletedPastCheckbox = document.getElementById("showCompletedPastCheckbox")
let showCompletedTodayCheckbox = document.getElementById("showCompletedTodayCheckbox")
let showCompletedFutureCheckbox = document.getElementById("showCompletedFutureCheckbox")
let showCompletedNoDueCheckbox = document.getElementById("showCompletedNoDueCheckbox")
let showOpenCheckboxesCheckbox = document.getElementById("showOpenCheckboxesCheckbox")
let showDoneCheckboxesCheckbox = document.getElementById("showDoneCheckboxesCheckbox")
let showNoCheckboxesCheckbox = document.getElementById("showNoCheckboxesCheckbox")
let showNotesCheckbox = document.getElementById("showNotesCheckbox")
let notesPositionSelect = document.getElementById("notesPositionSelect")
let notebookSelect = document.getElementById("notebookSelect")
let panelSearchInput = document.getElementById("panelSearchInput")
let sortFieldSelect = document.getElementById("sortFieldSelect")
let sortDirectionSelect = document.getElementById("sortDirectionSelect")
let showNoDueCheckbox = document.getElementById("showNoDueCheckbox")
let displayFormatSelect = document.getElementById("displayFormatSelect")
let yearFormatSelect = document.getElementById("yearFormatSelect")
let monthFormatSelect = document.getElementById("monthFormatSelect")
let dayFormatSelect = document.getElementById("dayFormatSelect")
let weekdayFormatSelect = document.getElementById("weekdayFormatSelect")
let timeIs12HourCheckbox = document.getElementById("timeIs12HourCheckbox")
let profileDataInput = document.getElementById("profileDataInput")
let noDueDatesAtEndCheckbox = document.getElementById("noDueDatesAtEndCheckbox")
let weekStartsOnSelect = document.getElementById("weekStartsOnSelect")
let maxDotsPerDayInput = document.getElementById("maxDotsPerDayInput")

// Connect Event Handlers
nameInput.addEventListener("change", saveProfileData)
sortOrderInput.addEventListener("change", saveProfileData)
searchCriteriaInput.addEventListener("change", saveProfileData)
noteIDInput.addEventListener("change", saveProfileData)
showCompletedPastCheckbox.addEventListener("change", saveProfileData)
showCompletedTodayCheckbox.addEventListener("change", saveProfileData)
showCompletedFutureCheckbox.addEventListener("change", saveProfileData)
showCompletedNoDueCheckbox.addEventListener("change", saveProfileData)
showOpenCheckboxesCheckbox.addEventListener("change", saveProfileData)
showDoneCheckboxesCheckbox.addEventListener("change", saveProfileData)
showNoCheckboxesCheckbox.addEventListener("change", saveProfileData)
showNotesCheckbox.addEventListener("change", saveProfileData)
notesPositionSelect.addEventListener("change", saveProfileData)
notebookSelect.addEventListener("change", saveProfileData)
panelSearchInput.addEventListener("change", saveProfileData)
sortFieldSelect.addEventListener("change", saveProfileData)
sortDirectionSelect.addEventListener("change", saveProfileData)
showNoDueCheckbox.addEventListener("change", saveProfileData)
displayFormatSelect.addEventListener("change", saveProfileData)
yearFormatSelect.addEventListener("change", saveProfileData)
monthFormatSelect.addEventListener("change", saveProfileData)
dayFormatSelect.addEventListener("change", saveProfileData)
weekdayFormatSelect.addEventListener("change", saveProfileData)
timeIs12HourCheckbox.addEventListener("change", saveProfileData)
noDueDatesAtEndCheckbox.addEventListener("change", saveProfileData)
weekStartsOnSelect.addEventListener("change", saveProfileData)
maxDotsPerDayInput.addEventListener("change", saveProfileData)
// The name also saves on every keystroke. Naming a new profile is typing and pressing Enter, and Enter in a text field
// submits the dialog from the host's own keydown listener (Joplin's UserWebviewIndex.js), so the hidden field must not
// depend on the change event to hold the typed name by the time the host reads the form.
nameInput.addEventListener("input", saveProfileData)

// Load Profile Data
function loadProfileData() {
    if (profileDataInput.value != "<<PROFILE_DATA>>"){
        var profileObject = JSON.parse(decodeURI(atob(profileDataInput.value)))
        nameInput.value = profileObject["name"]
        sortOrderInput.value = profileObject["sortOrder"]
        searchCriteriaInput.value = profileObject["searchCriteria"]
        noteIDInput.value = profileObject["noteID"]
        showCompletedPastCheckbox.checked = profileObject["showCompletedPast"]
        showCompletedTodayCheckbox.checked = profileObject["showCompletedToday"]
        showCompletedFutureCheckbox.checked = profileObject["showCompletedFuture"]
        showCompletedNoDueCheckbox.checked = profileObject["showCompletedNoDue"]
        // The checkbox filters (2.10) default to shown, so a profile object without them - one written before they existed - reads as shown.
        showOpenCheckboxesCheckbox.checked = profileObject["showOpenCheckboxes"] !== false
        showDoneCheckboxesCheckbox.checked = profileObject["showDoneCheckboxes"] !== false
        showNoCheckboxesCheckbox.checked = profileObject["showNoCheckboxes"] !== false
        showNotesCheckbox.checked = profileObject["showNotes"]
        notesPositionSelect.value = profileObject["notesPosition"] || "after"
        notebookSelect.value = profileObject["notebook"] || ""
        panelSearchInput.value = profileObject["panelSearch"] || ""
        sortFieldSelect.value = profileObject["sortField"] || "title"
        sortDirectionSelect.value = profileObject["sortDirection"] || "asc"
        showNoDueCheckbox.checked = profileObject["showNoDue"]
        displayFormatSelect.value = profileObject["displayFormat"]
        yearFormatSelect.value = profileObject["yearFormat"]
        monthFormatSelect.value = profileObject["monthFormat"]
        dayFormatSelect.value = profileObject["dayFormat"]
        weekdayFormatSelect.value = profileObject["weekdayFormat"]
        timeIs12HourCheckbox.checked = profileObject["timeIs12Hour"]
        noDueDatesAtEndCheckbox.checked = profileObject["noDueDatesAtEnd"]
        weekStartsOnSelect.value = String(profileObject["weekStartsOn"])
        maxDotsPerDayInput.value = profileObject["maxDotsPerDay"]
    }
}

// Save Profile Data
function saveProfileData(){
    var profileObject = {
        "name": nameInput.value,
        "sortOrder": sortOrderInput.value,
        "searchCriteria": searchCriteriaInput.value,
        "noteID": noteIDInput.value,
        "showCompletedPast": showCompletedPastCheckbox.checked,
        "showCompletedToday": showCompletedTodayCheckbox.checked,
        "showCompletedFuture": showCompletedFutureCheckbox.checked,
        "showCompletedNoDue": showCompletedNoDueCheckbox.checked,
        "showOpenCheckboxes": showOpenCheckboxesCheckbox.checked,
        "showDoneCheckboxes": showDoneCheckboxesCheckbox.checked,
        "showNoCheckboxes": showNoCheckboxesCheckbox.checked,
        "showNotes": showNotesCheckbox.checked,
        "notesPosition": notesPositionSelect.value,
        "notebook": notebookSelect.value,
        "panelSearch": panelSearchInput.value,
        "sortField": sortFieldSelect.value,
        "sortDirection": sortDirectionSelect.value,
        "showNoDue": showNoDueCheckbox.checked,
        "displayFormat": displayFormatSelect.value,
        "yearFormat": yearFormatSelect.value,
        "monthFormat": monthFormatSelect.value,
        "dayFormat": dayFormatSelect.value,
        "weekdayFormat": weekdayFormatSelect.value,
        "timeIs12Hour": timeIs12HourCheckbox.checked,
        "noDueDatesAtEnd": noDueDatesAtEndCheckbox.checked,
        "weekStartsOn": weekStartsOnSelect.value,
        "maxDotsPerDay": maxDotsPerDayInput.value
    }
    profileDataInput.value = btoa(encodeURI(JSON.stringify(profileObject)))
}

loadProfileData()
saveProfileData()
// Create mode ("+ New profile…"): the form arrives filled with the view on screen (profileSeedFromCurrentView in
// panel.ts), so naming it is all that is left to do. The name field takes the focus with its text selected, so typing
// replaces "New Profile" at once. An edit focuses nothing, as it never has. openEditor writes the mode into the markup.
// The host focuses the dialog's frame when the page reports ready, before this script has loaded, so the focus set
// here is the one that stays.
if (document.getElementById("editorScroll").getAttribute("data-mode") == "create"){
    nameInput.focus()
    nameInput.select()
}
// Fit the dialog: Joplin sizes the dialog frame from the wrapper element, but the frame the
// webview actually gets can differ from the requested pixels (stale measurements, application
// zoom). This nudges the wrapper until the visible viewport is the intended size, converging in
// one or two resize rounds. It is a no-op when the size is already right.
function fitEditorDialog() {
    var wrapper = document.getElementById("joplin-plugin-content")
    if (!wrapper) return
    var targetWidth = 440, targetHeight = 540
    if (window.innerWidth > 0 && Math.abs(window.innerWidth - targetWidth) > 4) {
        wrapper.style.width = `${Math.round(wrapper.offsetWidth * targetWidth / window.innerWidth)}px`
    }
    if (window.innerHeight > 0 && Math.abs(window.innerHeight - targetHeight) > 4) {
        wrapper.style.height = `${Math.round(wrapper.offsetHeight * targetHeight / window.innerHeight)}px`
    }
}
window.addEventListener("resize", fitEditorDialog)
fitEditorDialog()
