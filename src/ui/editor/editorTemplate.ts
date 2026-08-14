/** README ******************************************************************************************************************************************
 * The markup of the profile editor dialog. It is kept in a TypeScript file rather than an HTML file because reading the plugin directory needs      *
 * fs-extra, which is only available on desktop. The styles are inlined because a stylesheet added with addScript does not reliably apply to         *
 * dialogs, and Joplin sizes the dialog from the content, so the width and height are fixed and the fieldsets scroll inside.                         *
 ***************************************************************************************************************************************************/

export var editorTemplate = `
    <style>
        /* The wrapper's fixed size is what Joplin sizes the dialog from. The scroll area is then
         * pinned to the real viewport edges rather than to that size, because with application
         * zoom the dialog can come out larger than the requested pixels, which would leave dead
         * space beside the content. */
        #joplin-plugin-content {
            width: 440px;
            height: 540px;
            overflow: hidden;
        }
        #editorScroll {
            position: fixed;
            inset: 0;
            overflow-y: auto;
            box-sizing: border-box;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        #editorScroll::-webkit-scrollbar { width: 7px; }
        #editorScroll::-webkit-scrollbar-track { background: transparent; }
        #editorScroll::-webkit-scrollbar-thumb {
            border-radius: 4px;
            background: var(--joplin-scrollbar-thumb-color, rgba(127, 127, 127, 0.4));
        }
        fieldset {
            margin: 0;
            padding: 6px 10px 8px;
            border: 1px solid var(--joplin-divider-color, rgba(127, 127, 127, 0.4));
            border-radius: 6px;
            /* Fieldsets refuse to shrink below their content by default, which lets a select with
             * long options blow the whole dialog out sideways */
            min-inline-size: 0;
        }
        legend {
            padding: 0 4px;
            font-size: 0.85em;
            font-weight: 600;
            opacity: 0.75;
        }
        section {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 6px;
            margin: 4px 0;
        }
        /* Appearance of every field; the layout (block vs flex row) is set separately below */
        input[type="text"], input[type="number"], select {
            box-sizing: border-box;
            padding: 4px 6px;
            font-family: inherit;
            font-size: inherit;
            color: var(--joplin-color, inherit);
            background-color: var(--joplin-background-color, transparent);
            border: 1px solid var(--joplin-divider-color, rgba(127, 127, 127, 0.4));
            border-radius: 3px;
            outline: none;
        }
        /* Fields directly inside a fieldset span its full width */
        fieldset > input, fieldset > select {
            display: block;
            width: 100%;
        }
        /* Labelled rows: a fixed label column, the control takes the rest. The zero flex basis
         * matters: with basis auto, a select with long options would widen the row past the
         * dialog instead of shrinking to fit. */
        section > label:first-child {
            flex: 0 0 90px;
        }
        section input[type="text"], section select {
            flex: 1 1 0;
            min-width: 0;
            width: auto;
        }
        input:focus, select:focus {
            border-color: var(--joplin-focus-outline-color, var(--joplin-url-color, #2D6BDC));
        }
        /* Explicit option colours, because the dropdown list otherwise mixes the theme's light text
         * with the platform's white popup background and becomes unreadable */
        option {
            background-color: var(--joplin-background-color, #ffffff);
            color: var(--joplin-color, #000000);
        }
        input[type="checkbox"] {
            flex: 0 0 auto;
            width: 15px;
            height: 15px;
            margin: 0;
        }
        section > input[type="checkbox"] + label {
            flex: 1 1 auto;
        }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 2px 4px 2px 0; }
        td select { width: 100%; }
    </style>
    <div id="editorScroll">
    <fieldset>
        <legend>Name</legend>
        <input type="text" id="nameInput" name="name" value="New Profile">
    </fieldset>
    <fieldset>
        <legend>Panel View (applied when this profile is selected)</legend>
        <section>
            <label for="notebookSelect">Notebook</label>
            <select id="notebookSelect" name="notebook"><<NOTEBOOK_OPTIONS>></select>
        </section>
        <section>
            <label for="panelSearchInput">Search</label>
            <input type="text" id="panelSearchInput" name="panelSearch">
        </section>
        <section>
            <label for="sortFieldSelect">Sort ties by</label>
            <select id="sortFieldSelect" name="sortField">
                <option value="title">Title</option>
                <option value="updated">Updated date</option>
                <option value="created">Created date</option>
            </select>
        </section>
        <section>
            <label for="sortDirectionSelect">Direction</label>
            <select id="sortDirectionSelect" name="sortDirection">
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
            </select>
        </section>
    </fieldset>
    <fieldset>
        <legend>Sort Order</legend>
        <input type="number" id="sortOrderInput" name="sortOrder" value="0">
    </fieldset>
    <fieldset>
        <legend>Search Criteria</legend>
        <input type="text" id="searchCriteriaInput" name="searchCriteria">
    </fieldset>
    <fieldset>
        <legend>Overview Note ID</legend>
        <input type="text" id="noteIDInput" name="noteID">
    </fieldset>
    <fieldset>
        <legend>Show Completed</legend>
        <section>
            <input type="checkbox" id="showCompletedPastCheckbox" name="showCompletedPast">
            <label for="showCompletedPastCheckbox">Completed todos from the past</label>
        </section>
        <section>
            <input type="checkbox" id="showCompletedTodayCheckbox" name="showCompletedToday">
            <label for="showCompletedTodayCheckbox">Completed todos from today</label>
        </section>
        <section>
            <input type="checkbox" id="showCompletedFutureCheckbox" name="showCompletedFuture">
            <label for="showCompletedFutureCheckbox">Completed todos from the future</label>
        </section>
        <section>
            <input type="checkbox" id="showCompletedNoDueCheckbox" name="showCompletedNoDue">
            <label for="showCompletedNoDueCheckbox">Completed todos with no due date</label>
        </section>
    </fieldset>
    <fieldset>
        <legend>Notes</legend>
        <section>
            <input type="checkbox" id="showNotesCheckbox" name="showNotes">
            <label for="showNotesCheckbox">Show regular notes matching the search criteria</label>
        </section>
        <section>
            <label for="notesPositionSelect">Show notes</label>
            <select id="notesPositionSelect" name="notesPosition">
                <option value="after">After todos</option>
                <option value="before">Before todos</option>
            </select>
        </section>
    </fieldset>
    <fieldset>
        <legend>Show No Due Dates</legend>
        <section>
            <input type="checkbox" id="showNoDueCheckbox" name="showNoDue">
            <label for="showNoDueCheckbox">Show todos with no due date</label>
        </section>
    </fieldset>
    <fieldset>
        <legend>Move No Due Dates To End</legend>
        <section>
            <input type="checkbox" id="noDueDatesAtEndCheckbox" name="noDueDatesAtEnd">
            <label for="noDueDatesAtEndCheckbox">Sort todos with no due dates to the end of list</label>
        </section>
    </fieldset>
    <fieldset>
        <legend>Display Format</legend>
        <select id="displayFormatSelect" name="displayFormat">
            <option value="basic">Basic</option>
            <option value="interval" selected>Interval</option>
            <option value="date">Date</option>
            <option value="month">Month Calendar</option>
            <option value="week">Week Planner</option>
        </select>
    </fieldset>
    <fieldset>
        <legend>Week Starts On</legend>
        <select id="weekStartsOnSelect" name="weekStartsOn">
            <option value="1">Monday</option>
            <option value="0">Sunday</option>
        </select>
    </fieldset>
    <fieldset>
        <legend>Dots Per Day</legend>
        <input type="number" id="maxDotsPerDayInput" name="maxDotsPerDay" min="1" max="10" value="4">
    </fieldset>
    <fieldset>
        <legend>Date Format</legend>
        <table>
            <tr>
                <td>Year</td>
                <td>Month</td>
                <td>Day</td>
            </tr>
            <tr>
                <td>
                    <select id="yearFormatSelect" name="yearFormat">
                        <option value="numeric">2022</option>
                        <option value="2-digit">22</option>
                    </select>
                </td>
                <td>
                    <select id="monthFormatSelect" name="monthFormat">
                        <option value="long">January</option>
                        <option value="short">Jan</option>
                        <option value="narrow">J</option>
                        <option value="2-digit">01</option>
                    </select>
                </td>
                <td>
                    <select id="dayFormatSelect" name="dayFormat">
                        <option value="numeric">9</option>
                        <option value="2-digit">09</option>
                    </select>
                </td>
            </tr>
        </table>
    </fieldset>
    <fieldset>
        <legend>Weekday Format</legend>
        <select id="weekdayFormatSelect" name="weekdayFormat">
            <option value="long">Monday</option>
            <option value="short">Mon</option>
            <option value="narrow">M</option>
        </select>
    </fieldset>
    <fieldset>
        <legend>Time Format</legend>
        <section>
            <input type="checkbox" id="timeIs12HourCheckbox" name="timeIs12Hour">
            <label for="timeIs12HourCheckbox">Use AM/PM Format</label>
        </section>
    </fieldset>
    <form name="profileDataForm">
        <input type="hidden" id="profileDataInput" name="profileData" value="<<PROFILE_DATA>>">
    </form>
    </div>
`
