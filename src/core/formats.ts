/** README ******************************************************************************************************************************************
 *  This file contains the base format abstract class that forms the basis of the customizable formatting system. All custom formats must implement *
 *  this class                                                                                                                                      *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { getTodos, getNotes, getNotebookMap, notebookWithDescendants } from "./joplin";
import { escapeHtml, dropTargetAttributes, headingContextAttributes } from "./html";
import {
    CalendarViewState,
    addDays,
    addMonths,
    buildMonthGrid,
    buildWeek,
    dayState,
    endOfWeek,
    fromISODate,
    groupTodosByDate,
    renderNavigation,
    renderUndated,
    startOfDay,
    startOfWeek,
    toISODate,
    weekdayLabels,
} from "./calendar";

export { escapeHtml } from "./html";

/** BaseFormat **************************************************************************************************************************************
 * This is the abstract class that all other formats must inherit from.                                                                             *
 ***************************************************************************************************************************************************/
abstract class BaseFormat {

    /** constructor *********************************************************************************************************************************
     * This constructor takes and stores the profile that contains customizations as well as the output format, whether it be "html" or "markdown"  *
     ***********************************************************************************************************************************************/
    constructor(profile, outputFormat, viewState?) {
        this.profile = profile
        this.outputFormat = outputFormat
        this.viewState = viewState
    }

    /** viewState ***********************************************************************************************************************************
     * Which part of the calendar is on screen. Only the calendar formats use it, and only when rendering HTML.                                     *
     ***********************************************************************************************************************************************/
    protected viewState: CalendarViewState = null

    /** profile *************************************************************************************************************************************
     * This stores the current profile data used to customize the formatting of the todos                                                           *
     ***********************************************************************************************************************************************/
    protected profile = null

    /** outputFormat ********************************************************************************************************************************
     * This stores the output format that the todos are requested in. Valid values are "html" and "markdown"                                        *
     ***********************************************************************************************************************************************/
    private outputFormat = null


    /** getFormattedHeadingString *******************************************************************************************************************
     * This method should return the heading string that the given todo would fall under. All formats must implement this method.                   *
     ***********************************************************************************************************************************************/
    protected abstract getFormatHeadingString(todo): string
    
    /** getFormattedTodoString **********************************************************************************************************************
     * This method should return the string representation of the given todo and heading. All formats must implement this method                    *
     ***********************************************************************************************************************************************/
    protected abstract getFormatTodoString(todo, heading): string
    
    /** getTodos ************************************************************************************************************************************
     * This is the main method of this class. It returns the formatted list of todos according to the profile parameters and output format passed   *
     * at class initialization,                                                                                                                     *
     ***********************************************************************************************************************************************/
    public async getTodos(){
        var todoString = ""
        var todoList = await this.fetchTodos()
        var todoMap = this.groupBy(todoList)
        if (this.profile.noDueDatesAtEnd){
            var noDueDates = todoMap.get("No Due Date")
            if (noDueDates){
                todoMap.delete("No Due Date");
                todoMap.set("No Due Date", noDueDates);
            }
        }
        for (var headingGroup of todoMap){
            var heading = headingGroup[0]
            todoString += this.getHeadingString(heading, this.getHeadingDropTarget(heading, headingGroup[1]), headingGroup[1].map(todo => todo.id))
            for (var todo of headingGroup[1]){
                todoString += this.getTodoString(todo, heading)
            }
        }
        return todoString
    }

    /** renderHtml **********************************************************************************************************************************
     * Returns the markup shown in the panel. By default this is the same grouped list that is written to the overview notes; the calendar formats   *
     * override it to draw a grid instead, while still inheriting the list for the notes.                                                            *
     ***********************************************************************************************************************************************/
    public async renderHtml(): Promise<string>{
        return await this.getTodos()
    }

    /** fetchTodos **********************************************************************************************************************************
     * The to-dos matching this profile, unformatted, each labelled with the notebook it lives in. Provided so that a format can lay them out       *
     * itself instead of as a list. When the view state carries a notebook filter, the query is narrowed to that notebook (and its sub-notebooks)   *
     * server side, then filtered precisely below.                                                                                                  *
     ***********************************************************************************************************************************************/
    protected async fetchTodos(){
        var notebooks = await getNotebookMap()
        var searchFilter = this.viewState ? (this.viewState as any).searchFilter : null
        var searchCriteria = searchFilter ? `${this.profile.searchCriteria} ${searchFilter}` : this.profile.searchCriteria
        var notebookFilter = this.viewState ? (this.viewState as any).notebookFilter : null
        // The notebook filter is also pushed into the query (Joplin's notebook: filter is
        // recursive), so the server does not return the whole vault only for most of it to be
        // thrown away below. The precise filtering still happens client side, because notebook
        // titles are not necessarily unique.
        var filterNotebook = notebookFilter ? notebooks.get(notebookFilter) : null
        if (filterNotebook && filterNotebook.title && !filterNotebook.title.includes('"')){
            searchCriteria = `${searchCriteria} notebook:"${filterNotebook.title}"`
        }
        var showAnyCompleted = this.profile.showCompletedPast || this.profile.showCompletedToday || this.profile.showCompletedFuture || this.profile.showCompletedNoDue
        var todos = await getTodos(showAnyCompleted, this.profile.showNoDue, searchCriteria)
        if (showAnyCompleted){
            todos = todos.filter(todo => {
                if (!todo.todo_completed) return true
                var bucket = this.getCompletedBucket(todo)
                if (bucket == "nodue") return this.profile.showCompletedNoDue
                if (bucket == "past") return this.profile.showCompletedPast
                if (bucket == "today") return this.profile.showCompletedToday
                return this.profile.showCompletedFuture
            })
        }
        for (var todo of todos){
            var notebook = notebooks.get(todo.parent_id)
            todo.notebookTitle = notebook ? notebook.title : ""
            todo.notebookPath = notebook ? notebook.path : ""
        }
        if (notebookFilter){
            var allowedNotebooks = notebookWithDescendants(notebooks, notebookFilter)
            todos = todos.filter(todo => allowedNotebooks.has(todo.parent_id))
        }
        var sort = this.viewState ? (this.viewState as any).sort : null
        if (sort){
            var compare = itemComparator(sort)
            todos.sort((first, second) => (first.todo_due - second.todo_due) || compare(first, second))
        }
        return todos
    }

    /** renderTodoRow *******************************************************************************************************************************
     * A single to-do as it appears in the panel: a checkbox that completes it and a link that opens it                                              *
     ***********************************************************************************************************************************************/
    protected renderTodoRow(todo, label){
        var checkedString = todo.todo_completed ? "checked" : ""
        var notebookString = todo.notebookTitle
            ? `<span class="todo-notebook" title="${escapeHtml(todo.notebookPath)}">${escapeHtml(todo.notebookTitle)}</span>`
            : ""
        // The ring around the checkbox shows how many of the checkboxes inside the note are ticked.
        // It is display only: filling it does not complete the to-do, and completing the to-do does
        // not fill it.
        var total = Number(todo.checkboxTotal) || 0
        var percent = total ? Math.round((Number(todo.checkboxDone) || 0) / total * 100) : 0
        var progressTitle = total ? `${todo.checkboxDone}/${total} checkboxes done` : "No checkboxes inside"
        return `
                <div class="todo${todo.todo_completed ? " -completed" : ""}" data-todo-id="${todo.id}" draggable="true"
                    onmousedown="onTodoRowMouseDown(event, '${todo.id}')"
                    onclick="onTodoRowClicked(event, '${todo.id}')"
                    ondblclick="onRowDoubleClicked(event, '${todo.id}')"
                    oncontextmenu="onTodoContextMenu(event, '${todo.id}')"
                    ondragstart="onTodoDragStart(event, '${todo.id}')"
                    ondragend="onTodoDragEnd(event)">
                    <input type="checkbox" class="todo-checkbox${total ? "" : " -plain"}" style="--percent: ${percent};" title="${escapeHtml(progressTitle)}"
                        onchange="onTodoChecked('${todo.id}')" ${checkedString}>
                    <a class="todo-title">${escapeHtml(label)}</a>
                    ${notebookString}
                </div>
            `
    }

    /** getHeadingDropTarget ************************************************************************************************************************
     * What dropping a to-do onto the given heading should do: a YYYY-MM-DD date the to-do becomes due on, "clear" to remove its due date, or null    *
     * when the heading is not a meaningful drop target. Formats whose headings map to dates override this.                                          *
     ***********************************************************************************************************************************************/
    protected getHeadingDropTarget(heading, todos){
        return null
    }

    /** getCompletedBucket **************************************************************************************************************************
     * Whether a completed to-do belongs to the past, to today or to the future, judged by its due date. One without a due date is its own bucket,    *
     * with its own switch in the profile.                                                                                                           *
     ***********************************************************************************************************************************************/
    private getCompletedBucket(todo){
        if (!todo.todo_due || todo.todo_due <= 0) return "nodue"
        if (todo.todo_due < this.getStartOfToday().getTime()) return "past"
        if (todo.todo_due <= this.getEndOfToday().getTime()) return "today"
        return "future"
    }

    /** getWeekStartsOn *****************************************************************************************************************************
     * The first day of the week for this profile, 0 for Sunday and 1 for Monday                                                                     *
     ***********************************************************************************************************************************************/
    protected getWeekStartsOn(){
        return Number(this.profile.weekStartsOn) === 0 ? 0 : 1
    }

    /** getHeadingString ****************************************************************************************************************************
     * This returns the given heading string with the proper output format(i.e html or markdown)                                                    *
     ***********************************************************************************************************************************************/
    private getHeadingString(headingString, dropTarget?, todoIDs?){
        if (headingString){
            if (this.outputFormat == "markdown"){
                return `## ${headingString}\n`
            } else if (this.outputFormat == "html") {
                return `<h2${dropTargetAttributes(dropTarget)}${headingContextAttributes(todoIDs)}>${escapeHtml(headingString)}</h2>`;
            }
        } else {
            return ""
        }
    }
    
    /** getTodoString *******************************************************************************************************************************
     * This returns the given todo as a string, with the proper output format (i.e html or markdown.)                                               *
     ***********************************************************************************************************************************************/
    private getTodoString(todo, heading){
        var todoString = this.getFormatTodoString(todo, heading)
        if (this.outputFormat == "markdown"){
            var checkedString = todo.todo_completed ? "x" : " "
            return `- [${checkedString}] [${todoString}](:/${todo.id})\n`    
        } else if (this.outputFormat == "html") {
            return this.renderTodoRow(todo, todoString)
        }
    }
    
    /** groupBy *****************************************************************************************************************************************
     * Takes an array, and a grouping function, and returns a Map of the array grouped by the grouping function.                                        *
     * Source: https://stackoverflow.com/a/38327540                                                                                                     *
     ***************************************************************************************************************************************************/
    private groupBy(todoList) {
        const map = new Map();
        todoList.forEach((todo) => {
            const heading =  this.getFormatHeadingString(todo);
            const headingGroup = map.get(heading);
            if (!headingGroup) {
                map.set(heading, [todo]);
            } else {
                headingGroup.push(todo);
            }
        });
        return map;
    }

    /** getWeekdayString ********************************************************************************************************************************
     * Takes the given date and returns a string representing the weekday the date falls on.                                                            *
     * Provided as convenience for use in custom formats                                                                                                *
     ***************************************************************************************************************************************************/
    protected getWeekdayString(date){
        return new Date(date).toLocaleDateString(undefined, {
            weekday: this.profile.weekdayFormat
        })
    }

    /** getFullDateString *******************************************************************************************************************************
     * Takes the given date and returns a string representing the full date, including year, month and day.                                             *
     * Provided as convenience for use in custom formats                                                                                                *
     ***************************************************************************************************************************************************/
    protected getFullDateString(date){
        return new Date(date).toLocaleDateString(undefined, {
            year: this.profile.yearFormat, 
            month: this.profile.monthFormat,  
            day: this.profile.dayFormat
        })
    }

    /** getDateString ***********************************************************************************************************************************
     * Takes the given date and returns a string representing the date without the year                                                                 *
     * Provided as convenience for use in custom formats                                                                                                *
     ***************************************************************************************************************************************************/
    protected getDateString(date){
        return new Date(date).toLocaleDateString(undefined, {
            month: this.profile.monthFormat,  
            day: this.profile.dayFormat
        })
    }

    /** getTimeString ***********************************************************************************************************************************
     * Takes the given date and returns a string representing the time                                                                                  *
     * Provided as convenience for use in custom formats                                                                                                *
     ***************************************************************************************************************************************************/
    protected getTimeString(date){
        return new Date(date).toLocaleTimeString(undefined, {
            hour: 'numeric', 
            minute: 'numeric', 
            hour12: this.profile.timeIs12Hour
        })
    }

    /** getStartOfToday *********************************************************************************************************************************
     * Gets the date representing the start of the current day. Provided as convenience for use in custom formats.                                      *                                                                    *
     ***************************************************************************************************************************************************/
    protected getStartOfToday(){
        var startOfToday = new Date();
        startOfToday.setHours(0,0,0,0);
        return startOfToday;
    }

    /** getEndOfToday ***********************************************************************************************************************************
     * Gets the date representing the end of the current day. Provided as convenience for use in custom formats                                         *                            *
     ***************************************************************************************************************************************************/
    protected getEndOfToday(){
        var endOfToday = new Date();
        endOfToday.setHours(23,59,59,999);
        return endOfToday   
    }

    /** getStartOfTomorrow ******************************************************************************************************************************
     * Gets the date representing the start of the next day. Provided as convenience for use in custom formats.                                         *                                                                    *
     ***************************************************************************************************************************************************/
     protected getStartOfTomorrow(){
        var startOfTomorrow = new Date();
        startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)
        startOfTomorrow.setHours(0,0,0,0);
        return startOfTomorrow;
    }

    /** getEndOfTomorrow *****************************************************************************************************************************
     * Gets the date representing the end of the next day. Provided as convenience for use in custom formats.                                        *                                                                    *
     ************************************************************************************************************************************************/
     protected getEndOfTomorrow(){
        var endOfTomorrow = new Date();
        endOfTomorrow.setDate(endOfTomorrow.getDate() + 1)
        endOfTomorrow.setHours(23,59,59,999);
        return endOfTomorrow;
    }

    /** getEndOfThisWeek ********************************************************************************************************************************
     * Gets the date representing the end of the current week, according to the profile's first day of the week.                                        *
     * The previous implementation subtracted the weekday number directly, which on a Sunday returned the Sunday a week later and so let the "This Week" *
     * group run seven days too long.                                                                                                                   *
     ***************************************************************************************************************************************************/
    protected getEndOfThisWeek(){
        return endOfWeek(new Date(), this.getWeekStartsOn())
    }

    /** getEndOfThisMonth *******************************************************************************************************************************
     * Gets the date representing the end of the current month. Provided as convenience for use in custom formats                                       *                            *
     ***************************************************************************************************************************************************/
    protected getEndOfThisMonth(){
        var endOfMonth = new Date()
        endOfMonth = new Date(endOfMonth.getFullYear(), endOfMonth.getMonth() + 1, 0);
        return endOfMonth    
    }

    /** getEndOfThisYear ********************************************************************************************************************************
     * Gets the date representing the end of the current year. Provided as convenience for use in custom formats                                        *                            *
     ***************************************************************************************************************************************************/
    protected getEndOfThisYear(){
        var endOfYear = new Date(new Date().getFullYear(), 11, 31) 
        return endOfYear
    }
}

/** BasicFormat **************************************************************************************************************************************
 * This format groups doesnt group tasks at all.                                                                                                     *
 ***************************************************************************************************************************************************/
 class BasicFormat extends BaseFormat {

    /** getFormatHeadingString **********************************************************************************************************************
     * Sets the heading according to the built in full date string creation method if the task has a due date or otherwise sets it to "No Due Date" *
     ***********************************************************************************************************************************************/
    protected getFormatHeadingString(todo){
        return ""
    }

    /** getFormatTodoString *************************************************************************************************************************
     * Formats the todo by prepending it with the time it should be done                                                                            *
    ************************************************************************************************************************************************/
    protected getFormatTodoString(todo, heading){
        return todo.title
    }
}


/** DateFormat **************************************************************************************************************************************
 * This format groups tasks by date and sorts them by time.                                                                                         *
 ***************************************************************************************************************************************************/
class DateFormat extends BaseFormat {

    /** getFormatHeadingString **********************************************************************************************************************
     * Sets the heading according to the built in full date string creation method if the task has a due date or otherwise sets it to "No Due Date" *
     ***********************************************************************************************************************************************/
    protected getFormatHeadingString(todo){
        if (todo.todo_due != 0) {
            return this.getFullDateString(todo.todo_due)
        } else {
            return "No Due Date"
        } 
    }

    /** getFormatTodoString *************************************************************************************************************************
     * Formats the todo by prepending it with the time it should be done                                                                            *
    ************************************************************************************************************************************************/
    protected getFormatTodoString(todo, heading){
        var dueTime = todo.todo_due != 0 ? `${this.getTimeString(todo.todo_due)} - ` : ""
        return `${dueTime}${todo.title}`
    }

    /** getHeadingDropTarget ************************************************************************************************************************
     * Every heading of this format is a single day, so dropping onto it makes the to-do due that day. The date is read from the group's first to-do  *
     * rather than re-parsed from the heading text.                                                                                                  *
     ***********************************************************************************************************************************************/
    protected getHeadingDropTarget(heading, todos){
        if (heading == "No Due Date") return "clear"
        var first = todos && todos.length ? todos[0] : null
        return first && first.todo_due ? toISODate(new Date(first.todo_due)) : null
    }
}

/** IntervalFormat **********************************************************************************************************************************
 * This format groups todos by specific dates then names the todo according to the due time on that date                                            *
 ***************************************************************************************************************************************************/
class IntervalFormat extends BaseFormat {

    protected getFormatHeadingString(todo){
        var heading = ""
        var todoDate =  new Date(todo.todo_due)
        if (todo.todo_due == 0){
            heading = "No Due Date"
        } else if (todoDate < this.getStartOfToday()){
            heading = "Overdue"
        } else if (todoDate < this.getEndOfToday()){
            heading = "Today"
        } else if (todoDate < this.getEndOfTomorrow()){
            heading = "Tomorrow"
        } else if (todoDate < this.getEndOfThisWeek()){
            heading = "This Week"
        } else if (todoDate < this.getEndOfThisMonth()){
            heading = "This Month"
        } else if (todoDate < this.getEndOfThisYear()){
            heading = "This Year"
        } else {
            heading = "Future"
        }
        return heading
    }

    protected getFormatTodoString(todo, heading){
        var dueDate = ""
        if (heading == "Overdue") {
            dueDate = `${this.getFullDateString(todo.todo_due)} - `
        } else if (heading == "Today") {
            dueDate = `${this.getTimeString(todo.todo_due)} - `
        } else if (heading == "Tomorrow") {
            dueDate = `${this.getTimeString(todo.todo_due)} - `
        } else if (heading == "This Week") {
            dueDate = `${this.getWeekdayString(todo.todo_due)} - `
        } else if (heading == "This Month"){
            dueDate =  `${this.getDateString(todo.todo_due)} - `
        } else if (heading == "This Year"){
            dueDate = `${this.getDateString(todo.todo_due)} - `
        } else if (heading == "Future") {
            dueDate = `${this.getFullDateString(todo.todo_due)} - `
        }
        return `${dueDate}${todo.title}`
    }

    /** getHeadingDropTarget ************************************************************************************************************************
     * A to-do dropped onto an interval becomes due on that interval's last day - "due by the end of this week/month/year" - except for Today and     *
     * Tomorrow, which are days already. Overdue and Future have no meaningful date, so they accept no drops.                                        *
     ***********************************************************************************************************************************************/
    protected getHeadingDropTarget(heading, todos){
        if (heading == "No Due Date") return "clear"
        if (heading == "Today") return toISODate(new Date())
        if (heading == "Tomorrow") return toISODate(this.getStartOfTomorrow())
        if (heading == "This Week") return toISODate(this.getEndOfThisWeek())
        if (heading == "This Month") return toISODate(this.getEndOfThisMonth())
        if (heading == "This Year") return toISODate(this.getEndOfThisYear())
        return null
    }
}

/** MonthFormat *************************************************************************************************************************************
 * Shows a month at a glance: a grid of days, each marked with a dot per to-do due on it. Selecting a day lists its to-dos underneath.               *
 * In a note it falls back to the date grouped list it inherits, which stays readable and clickable where a grid would not.                          *
 ***************************************************************************************************************************************************/
class MonthFormat extends DateFormat {

    public async renderHtml(){
        var todoList = await this.fetchTodos()
        var grouped = groupTodosByDate(todoList)
        var weekStartsOn = this.getWeekStartsOn()
        var anchor = fromISODate(this.viewState ? this.viewState.anchor : toISODate(new Date()))
        var today = new Date()
        var todayKey = toISODate(today)
        var selectedKey = this.viewState ? this.viewState.selectedDate : null

        // The grid gets abbreviated headings whatever the profile says, because seven columns of
        // "Wednesday" do not fit a narrow panel or a phone. A profile asking for single letters is
        // honoured, since that is narrower still.
        var headingFormat = this.profile.weekdayFormat === "narrow" ? "narrow" : "short"
        var headerCells = weekdayLabels(weekStartsOn, headingFormat).map(label => {
            return `<th scope="col">${escapeHtml(label)}</th>`
        }).join("")

        var days = buildMonthGrid(anchor, weekStartsOn)
        var rows = ""
        for (var index = 0; index < days.length; index += 7){
            rows += `<tr>${days.slice(index, index + 7).map(day => this.renderDayCell(day, grouped.byDate, anchor, todayKey, selectedKey, today)).join("")}</tr>`
        }

        var title = anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
        return `
            ${renderNavigation(title)}
            <table class="calendar-grid">
                <thead><tr>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
            ${this.renderSelectedDay(grouped.byDate, selectedKey)}
            ${renderUndated(grouped.undated, (todo, label) => this.renderTodoRow(todo, label))}
        `
    }

    /** renderDayCell *******************************************************************************************************************************
     * One day of the grid: its number, and a dot for each to-do due on it. The dots are capped so that a busy day cannot push the grid out of shape. *
     ***********************************************************************************************************************************************/
    private renderDayCell(day, byDate, anchor, todayKey, selectedKey, now){
        var key = toISODate(day)
        var todos = byDate.get(key) || []
        var classes = ["calendar-day", `-${dayState(todos, now)}`]
        if (day.getMonth() !== anchor.getMonth()) classes.push("-outside")
        if (key === todayKey) classes.push("-today")
        if (key === selectedKey) classes.push("-selected")

        var maxDots = Number(this.profile.maxDotsPerDay)
        if (!Number.isFinite(maxDots) || maxDots < 1) maxDots = 4
        var dots = todos.slice(0, maxDots).map(todo => {
            var state = todo.todo_completed ? "done" : (todo.todo_due < now.getTime() ? "overdue" : "due")
            return `<span class="calendar-dot -${state}"></span>`
        }).join("")
        var overflow = todos.length > maxDots ? `<span class="calendar-more">+${todos.length - maxDots}</span>` : ""

        var outstanding = todos.filter(todo => !todo.todo_completed).length
        var label = `${day.toLocaleDateString(undefined, { day: "numeric", month: "long" })}, ${todos.length} to-do${todos.length === 1 ? "" : "s"}, ${outstanding} outstanding`

        return `
            <td class="${classes.join(" ")}"${dropTargetAttributes(key)}>
                <button type="button" class="calendar-day-button" aria-label="${escapeHtml(label)}" onclick="onCalendarDaySelected('${key}')">
                    <span class="calendar-day-number">${day.getDate()}</span>
                    <span class="calendar-dots">${dots}${overflow}</span>
                </button>
            </td>
        `
    }

    /** renderSelectedDay ***************************************************************************************************************************
     * The to-dos of the day the user picked, listed under the grid                                                                                  *
     ***********************************************************************************************************************************************/
    private renderSelectedDay(byDate, selectedKey){
        if (!selectedKey) return ""
        var day = fromISODate(selectedKey)
        var todos = byDate.get(selectedKey) || []
        var rows = todos.length
            ? todos.map(todo => this.renderTodoRow(todo, `${this.getTimeString(todo.todo_due)} - ${todo.title}`)).join("")
            : `<p class="calendar-empty">Nothing due</p>`
        return `
            <section class="calendar-selected">
                <h2${headingContextAttributes(todos.map(todo => todo.id))}>${escapeHtml(this.getFullDateString(day))}</h2>
                ${rows}
            </section>
        `
    }
}

/** WeekFormat **************************************************************************************************************************************
 * A week planner: one section per day, each listing that day's to-dos so they can be read and ticked off in place.                                  *
 ***************************************************************************************************************************************************/
class WeekFormat extends DateFormat {

    public async renderHtml(){
        var todoList = await this.fetchTodos()
        var grouped = groupTodosByDate(todoList)
        var weekStartsOn = this.getWeekStartsOn()
        var anchor = fromISODate(this.viewState ? this.viewState.anchor : toISODate(new Date()))
        var todayKey = toISODate(new Date())

        var days = buildWeek(anchor, weekStartsOn)
        var sections = days.map(day => {
            var key = toISODate(day)
            var todos = grouped.byDate.get(key) || []
            var rows = todos.length
                ? todos.map(todo => this.renderTodoRow(todo, `${this.getTimeString(todo.todo_due)} - ${todo.title}`)).join("")
                : `<p class="calendar-empty">Nothing due</p>`
            var heading = day.toLocaleDateString(undefined, { weekday: this.profile.weekdayFormat || "long", day: "numeric", month: "short" })
            return `
                <section class="week-day${key === todayKey ? " -today" : ""}"${dropTargetAttributes(key)}>
                    <h2${headingContextAttributes(todos.map(todo => todo.id))}>${escapeHtml(heading)}</h2>
                    ${rows}
                </section>
            `
        }).join("")

        var first = days[0]
        var last = days[days.length - 1]
        var title = `${this.getDateString(first)} - ${this.getDateString(last)}`
        return `
            ${renderNavigation(title)}
            <section class="week-planner">${sections}</section>
            ${renderUndated(grouped.undated, (todo, label) => this.renderTodoRow(todo, label))}
        `
    }
}

/** itemComparator **********************************************************************************************************************************
 * The comparator behind the panel's sort button. It orders items sharing a due time - and the notes group - by title, updated time or created time, *
 * ascending or descending.                                                                                                                         *
 ***************************************************************************************************************************************************/
export function itemComparator(sort){
    var field = sort && sort.field ? sort.field : "title"
    var directionFactor = sort && sort.direction === "desc" ? -1 : 1
    return (first, second) => {
        var result = 0
        if (field === "updated"){
            result = (Number(first.user_updated_time) || 0) - (Number(second.user_updated_time) || 0)
        } else if (field === "created"){
            result = (Number(first.user_created_time) || 0) - (Number(second.user_created_time) || 0)
        } else {
            result = String(first.title).localeCompare(String(second.title), undefined, { numeric: true, sensitivity: "base" })
        }
        return result * directionFactor
    }
}

/** renderNotesSection ******************************************************************************************************************************
 * The regular notes matching the profile, as their own group in the panel. Notes have no due date or completion, so the circle only shows the       *
 * checkbox progress of the note and cannot be ticked.                                                                                              *
 ***************************************************************************************************************************************************/
export async function renderNotesSection(profile, viewState){
    var notebooks = await getNotebookMap()
    var searchFilter = viewState ? viewState.searchFilter : null
    var searchCriteria = searchFilter ? `${profile.searchCriteria} ${searchFilter}` : profile.searchCriteria
    // Same server side notebook narrowing as fetchTodos, so showing notes does not pull the vault
    var sectionFilterNotebook = viewState && viewState.notebookFilter ? notebooks.get(viewState.notebookFilter) : null
    if (sectionFilterNotebook && sectionFilterNotebook.title && !sectionFilterNotebook.title.includes('"')){
        searchCriteria = `${searchCriteria} notebook:"${sectionFilterNotebook.title}"`
    }
    var notes = await getNotes(searchCriteria)
    for (var note of notes){
        var notebook = notebooks.get(note.parent_id)
        note.notebookTitle = notebook ? notebook.title : ""
        note.notebookPath = notebook ? notebook.path : ""
    }
    var notebookFilter = viewState ? viewState.notebookFilter : null
    if (notebookFilter){
        var allowedNotebooks = notebookWithDescendants(notebooks, notebookFilter)
        notes = notes.filter(note => allowedNotebooks.has(note.parent_id))
    }
    if (viewState && viewState.sort){
        notes.sort(itemComparator(viewState.sort))
    }
    if (!notes.length) return ""
    var rows = notes.map(note => {
        var total = Number(note.checkboxTotal) || 0
        var percent = total ? Math.round((Number(note.checkboxDone) || 0) / total * 100) : 0
        var progressTitle = total ? `${note.checkboxDone}/${total} checkboxes done` : "No checkboxes inside"
        var notebookString = note.notebookTitle
            ? `<span class="todo-notebook" title="${escapeHtml(note.notebookPath)}">${escapeHtml(note.notebookTitle)}</span>`
            : ""
        return `
            <div class="todo -note" data-note-id="${note.id}"
                onmousedown="onNoteRowMouseDown(event, '${note.id}')"
                onclick="onNoteRowClicked(event, '${note.id}')"
                ondblclick="onRowDoubleClicked(event, '${note.id}')"
                oncontextmenu="onNoteContextMenu(event, '${note.id}')">
                <span class="note-progress${total ? "" : " -empty"}" style="--percent: ${percent};" title="${escapeHtml(progressTitle)}"></span>
                <a class="todo-title">${escapeHtml(note.title)}</a>
                ${notebookString}
            </div>
        `
    }).join("")
    return `
        <section class="notes-section">
            <h2>Notes</h2>
            ${rows}
        </section>
    `
}

/** formats *****************************************************************************************************************************************
 * This convenience dict stores all formats using their names as keys                                                                               *
 ***************************************************************************************************************************************************/
export var formats = {
    'basic': BasicFormat,
    'interval': IntervalFormat,
    'date': DateFormat,
    'month': MonthFormat,
    'week': WeekFormat,
}

/** calendarFormats *********************************************************************************************************************************
 * The formats that show a calendar, and so need to be told which month or week is on screen and can be navigated                                    *
 ***************************************************************************************************************************************************/
export var calendarFormats = {
    'month': 'month',
    'week': 'week',
}

/** isCalendarFormat ********************************************************************************************************************************
 * Whether the given profile is showing one of the calendar views                                                                                   *
 ***************************************************************************************************************************************************/
export function isCalendarFormat(profile){
    return !!calendarFormats[profile ? profile.displayFormat : null]
}

/** stepCalendarAnchor ******************************************************************************************************************************
 * Moves the anchor by whole months or whole weeks, depending on which calendar the profile is showing                                               *
 ***************************************************************************************************************************************************/
export function stepCalendarAnchor(profile, anchorISO, delta){
    var anchor = fromISODate(anchorISO)
    if (profile && profile.displayFormat === 'week'){
        return toISODate(addDays(anchor, 7 * delta))
    }
    return toISODate(addMonths(anchor, delta))
}

/** defaultFormatName *******************************************************************************************************************************
 * The format used when a profile asks for a format that does not exist                                                                             *
 ***************************************************************************************************************************************************/
const defaultFormatName = 'interval'

/** getFormatter ************************************************************************************************************************************
 * Returns the formatter for the given profile and output format. Profiles are stored as free form JSON, so an unknown format name falls back to the *
 * default rather than crashing the refresh.                                                                                                        *
 ***************************************************************************************************************************************************/
export function getFormatter(profile, outputFormat, viewState?){
    var format = formats[profile.displayFormat] || formats[defaultFormatName]
    return new format(profile, outputFormat, viewState)
}

