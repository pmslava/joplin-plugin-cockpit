/** README ******************************************************************************************************************************************
 * The Cockpit panel's themes feature. panel.css defines a set of --cockpit-* CSS variables that, by default, alias the live --joplin-* theme        *
 * variables (see the base :root block at the top of panel.css), so with no theme chosen the panel matches Joplin exactly. buildThemeCss() returns a  *
 * second :root block that overrides individual --cockpit-* variables for the chosen preset or for the user's custom colours, plus the font size and  *
 * the completed-to-do appearance. That block is injected right before the user's custom CSS (which is injected last and still wins), so the cascade  *
 * is: panel.css base :root (match Joplin) -> theme :root override -> custom CSS. Themes apply to the Cockpit panel only.                             *
 *                                                                                                                                                  *
 * There is no colour picker in the Joplin settings API, so the custom colours are plain text fields holding any CSS colour string. They are injected *
 * verbatim into a CSS custom property, so the values are sanitised here to the character set a colour can legitimately use, which also prevents a     *
 * stray ";", "}" or "<" from breaking out of the declaration or the surrounding <style> element.                                                    *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import {
    themeModeSettingKey,
    completedTodoStyleSettingKey,
    customFontSizeSettingKey,
    customCircleSizeSettingKey,
    customTextColorSettingKey,
    customPanelBackgroundSettingKey,
    customContentBackgroundSettingKey,
    customCheckboxColorSettingKey,
    customProgressColorSettingKey,
    customDividerColorSettingKey,
} from "./settings"

/** THEME_PRESETS ***********************************************************************************************************************************
 * The colours of Joplin's own built-in themes, resolved after Joplin's theme inheritance and derived-colour computation, keyed by the same camelCase *
 * names Joplin's theme objects use. colorCorrect drives both the checked disc and the progress ring (mapped to two --cockpit-* variables below), and *
 * the alpha-derived values (backgroundColorHoverDim3, scrollbarThumbColor*) are the pre-computed rgba() strings. Font size and family are the same    *
 * for every theme, so presets pin colours only.                                                                                                     *
 ***************************************************************************************************************************************************/
export const THEME_PRESETS: Record<string, Record<string, string>> = {
    light: { color: "#32373F", color2: "#ffffff", colorFaded: "#627184", colorCorrect: "green", colorWarn: "rgb(228,86,0)", colorError: "red", dividerColor: "#dddddd", urlColor: "#155BDA", selectedColor: "#e5e5e5", selectedColor2: "#131313", destructiveColor: "#D00707", backgroundColor: "#ffffff", backgroundColor2: "#313640", backgroundColor3: "#F4F5F6", backgroundColor4: "#ffffff", backgroundColorHover3: "#CBDAF1", backgroundColorHoverDim3: "rgba(203, 218, 241, 0.3)", focusOutlineColor: "rgb(228,86,0)", scrollbarThumbColor: "rgba(50, 55, 63, 0.54)", scrollbarThumbColorHover: "rgba(50, 55, 63, 0.63)" },
    dark: { color: "#dddddd", color2: "#ffffff", colorFaded: "#999999", colorCorrect: "#72b972", colorWarn: "#9A5B00", colorError: "#ff4444", dividerColor: "#555555", urlColor: "rgb(166,166,255)", selectedColor: "#616161", selectedColor2: "#013F74", destructiveColor: "#F07777", backgroundColor: "#1D2024", backgroundColor2: "#181A1D", backgroundColor3: "#2E3138", backgroundColor4: "#1D2024", backgroundColorHover3: "#4E4E4E", backgroundColorHoverDim3: "rgba(78, 78, 78, 0.3)", focusOutlineColor: "#9A5B00", scrollbarThumbColor: "rgba(221, 221, 221, 0.54)", scrollbarThumbColorHover: "rgba(221, 221, 221, 0.63)" },
    solarizedLight: { color: "#657b83", color2: "#eee8d5", colorFaded: "#839496", colorCorrect: "green", colorWarn: "#cb4b16", colorError: "#dc322f", dividerColor: "#eee8d5", urlColor: "#268bd2", selectedColor: "#eee8d5", selectedColor2: "#6c71c4", destructiveColor: "#D00707", backgroundColor: "#fdf6e3", backgroundColor2: "#002b36", backgroundColor3: "#F4F5F6", backgroundColor4: "#ffffff", backgroundColorHover3: "#CBDAF1", backgroundColorHoverDim3: "rgba(203, 218, 241, 0.3)", focusOutlineColor: "#cb4b16", scrollbarThumbColor: "rgba(101, 123, 131, 0.54)", scrollbarThumbColorHover: "rgba(101, 123, 131, 0.63)" },
    solarizedDark: { color: "#839496", color2: "#eee8d5", colorFaded: "#657b83", colorCorrect: "#72b972", colorWarn: "#cb4b16", colorError: "#dc322f", dividerColor: "#586e75", urlColor: "#268bd2", selectedColor: "#073642", selectedColor2: "#586e75", destructiveColor: "#F07777", backgroundColor: "#002b36", backgroundColor2: "#073642", backgroundColor3: "#012732", backgroundColor4: "#073642", backgroundColorHover3: "#2aa19870", backgroundColorHoverDim3: "rgba(42, 161, 152, 0.3)", focusOutlineColor: "#cb4b16", scrollbarThumbColor: "rgba(131, 148, 150, 0.54)", scrollbarThumbColorHover: "rgba(131, 148, 150, 0.63)" },
    nord: { color: "#e5e9f0", color2: "#88c0d0", colorFaded: "#d8dee9", colorCorrect: "#72b972", colorWarn: "#d08770", colorError: "#bf616a", dividerColor: "#5e81ac", urlColor: "#88c0d0", selectedColor: "#81a1c1", selectedColor2: "#5e81ac", destructiveColor: "#F07777", backgroundColor: "#2e3440", backgroundColor2: "#434c5e", backgroundColor3: "#2E3138", backgroundColor4: "#1D2024", backgroundColorHover3: "#4E4E4E", backgroundColorHoverDim3: "rgba(78, 78, 78, 0.3)", focusOutlineColor: "#d08770", scrollbarThumbColor: "rgba(229, 233, 240, 0.54)", scrollbarThumbColorHover: "rgba(229, 233, 240, 0.63)" },
    aritimDark: { color: "#d3dae3", color2: "#d3dae3", colorFaded: "#666a73", colorCorrect: "#72b972", colorWarn: "#d66500", colorError: "#4a2608", dividerColor: "#141a21", urlColor: "#5a95c5", selectedColor: "#2b5278", selectedColor2: "#10151a", destructiveColor: "#F07777", backgroundColor: "#10151a", backgroundColor2: "#141a21", backgroundColor3: "#2E3138", backgroundColor4: "#1D2024", backgroundColorHover3: "#4E4E4E", backgroundColorHoverDim3: "rgba(78, 78, 78, 0.3)", focusOutlineColor: "#d66500", scrollbarThumbColor: "rgba(211, 218, 227, 0.54)", scrollbarThumbColorHover: "rgba(211, 218, 227, 0.63)" },
    oledDark: { color: "#dddddd", color2: "#ffffff", colorFaded: "#777777", colorCorrect: "#72b972", colorWarn: "#9A5B00", colorError: "#ff4444", dividerColor: "#3D444E", urlColor: "rgb(166,166,255)", selectedColor: "#616161", selectedColor2: "#013F74", destructiveColor: "#F07777", backgroundColor: "#000000", backgroundColor2: "#181A1D", backgroundColor3: "#2E3138", backgroundColor4: "#1D2024", backgroundColorHover3: "#4E4E4E", backgroundColorHoverDim3: "rgba(78, 78, 78, 0.3)", focusOutlineColor: "#9A5B00", scrollbarThumbColor: "rgba(221, 221, 221, 0.54)", scrollbarThumbColorHover: "rgba(221, 221, 221, 0.63)" },
}

/** PRESET_VAR_MAP **********************************************************************************************************************************
 * Maps each THEME_PRESETS colour key onto the --cockpit-* variable(s) it sets (colorCorrect feeds both the checkbox and the progress ring). Every    *
 * key the base :root alias block defines is covered here, so a preset restyles the whole panel.                                                     *
 ***************************************************************************************************************************************************/
const PRESET_VAR_MAP: Record<string, string | string[]> = {
    color: "color",
    color2: "color2",
    colorFaded: "color-faded",
    colorCorrect: ["checkbox-color", "progress-color"],
    colorWarn: "color-warn",
    colorError: "color-error",
    dividerColor: "divider-color",
    urlColor: "url-color",
    selectedColor: "selected-color",
    selectedColor2: "selected-color2",
    destructiveColor: "destructive-color",
    backgroundColor: "background-color",
    backgroundColor2: "background-color2",
    backgroundColor3: "background-color3",
    backgroundColor4: "background-color4",
    backgroundColorHover3: "background-color-hover3",
    backgroundColorHoverDim3: "background-color-hover-dim3",
    focusOutlineColor: "focus-outline-color",
    scrollbarThumbColor: "scrollbar-thumb-color",
    scrollbarThumbColorHover: "scrollbar-thumb-color-hover",
}

/** sanitizeColor ***********************************************************************************************************************************
 * Reduces a user-entered colour string to the characters a CSS colour can legitimately contain (#, letters, digits, parentheses, commas, dots,      *
 * percent, spaces, hyphen). This neutralises ";", "{", "}", "<", ">", quotes and backslashes, so a stray or hostile value cannot break out of the    *
 * declaration or the <style> element. An invalid-but-safe value simply makes that one variable fall back to the theme default at paint time.        *
 ***************************************************************************************************************************************************/
function sanitizeColor(value: string): string {
    return String(value || "").replace(/[^#a-zA-Z0-9(),.%\s-]/g, "").trim()
}

/** buildThemeCss ***********************************************************************************************************************************
 * The generated :root override block for the current theme settings, or "" when nothing needs overriding (Match Joplin with default font size and    *
 * completed style). It must be rebuilt on every render so that a settings change actually changes the panel markup and gets past the panel's         *
 * equality guard; it is never memoised.                                                                                                            *
 ***************************************************************************************************************************************************/
export async function buildThemeCss(): Promise<string> {
    var mode = String(await joplin.settings.value(themeModeSettingKey) || "matchJoplin")
    var decls: string[] = []

    // Font size applies in every mode: 0 keeps the "match Joplin" calc default in panel.css; any
    // positive value pins the panel's base font size.
    var fontSize = Number(await joplin.settings.value(customFontSizeSettingKey)) || 0
    if (fontSize > 0) decls.push(`--cockpit-font-size:${Math.round(fontSize)}px`)

    // The to-do circle size applies in every mode. Its setting default (18) is always > 0, so this is
    // always emitted; the base :root --cockpit-circle-size in panel.css (also 18) is the
    // paint-before-emit fallback that keeps the glyph geometry valid.
    var circleSize = Number(await joplin.settings.value(customCircleSizeSettingKey)) || 0
    if (circleSize > 0) decls.push(`--cockpit-circle-size:${Math.round(circleSize)}px`)

    if (mode === "custom") {
        // Only the variables the user filled in are emitted; an empty field is left to the base
        // alias so it keeps following the Joplin theme.
        var customColors: Array<[string | string[], string]> = [
            [["color", "color2"], String(await joplin.settings.value(customTextColorSettingKey) || "")],
            ["background-color2", String(await joplin.settings.value(customPanelBackgroundSettingKey) || "")],
            ["background-color", String(await joplin.settings.value(customContentBackgroundSettingKey) || "")],
            ["checkbox-color", String(await joplin.settings.value(customCheckboxColorSettingKey) || "")],
            ["progress-color", String(await joplin.settings.value(customProgressColorSettingKey) || "")],
            ["divider-color", String(await joplin.settings.value(customDividerColorSettingKey) || "")],
        ]
        for (var pair of customColors) {
            var safe = sanitizeColor(pair[1])
            if (!safe) continue
            for (var target of (Array.isArray(pair[0]) ? pair[0] : [pair[0]])) {
                decls.push(`--cockpit-${target}:${safe}`)
            }
        }
    } else if (mode !== "matchJoplin" && THEME_PRESETS[mode]) {
        var preset = THEME_PRESETS[mode]
        for (var key of Object.keys(PRESET_VAR_MAP)) {
            var value = preset[key]
            if (!value) continue
            var targets = PRESET_VAR_MAP[key]
            for (var target of (Array.isArray(targets) ? targets : [targets])) {
                decls.push(`--cockpit-${target}:${value}`)
            }
        }
    }

    // The completed-to-do appearance applies in every mode. The "Normal" option (enum key asNow)
    // leaves the base defaults (no decoration, full opacity) untouched.
    var completedStyle = String(await joplin.settings.value(completedTodoStyleSettingKey) || "asNow")
    if (completedStyle === "grayed") {
        decls.push("--cockpit-completed-opacity:0.5")
    } else if (completedStyle === "strikethrough") {
        decls.push("--cockpit-completed-decoration:line-through")
    } else if (completedStyle === "grayedStrikethrough") {
        decls.push("--cockpit-completed-opacity:0.5")
        decls.push("--cockpit-completed-decoration:line-through")
    }

    if (!decls.length) return ""
    return `:root{${decls.join(";")}}`
}
