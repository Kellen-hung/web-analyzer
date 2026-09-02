import pc from "picocolors";


const STYLE_OPEN = "\u0000RX_STYLE:";
const STYLE_CLOSE = "\u0000RX_STYLE_END\u0000";
const STYLE_PATTERN = /\u0000RX_STYLE:([a-z-]+)\u0000([\s\S]*?)\u0000RX_STYLE_END\u0000/g;


function semanticStyle(style, value) {
    const safeValue = String(value).replaceAll("\u0000", "�");
    return `${STYLE_OPEN}${style}\u0000${safeValue}${STYLE_CLOSE}`;
}


export function createReportContext() {
    const semanticColors = {
        bold: value => semanticStyle("bold", value),
        dim: value => semanticStyle("muted", value)
    };

    return {
        colors: semanticColors,
        heading(label) {
            return semanticStyle("heading", label);
        },
        target(label) {
            return semanticStyle("target", label);
        },
        status(label, value) {
            const style = {
                high: "high",
                medium: "medium",
                low: "low",
                suppressed: "muted",
                missing: "warning",
                partial: "warning",
                unresolved: "warning"
            }[label.toLowerCase()];

            return style ? semanticStyle(style, value) : String(value);
        },
        warning(value) {
            return semanticStyle("warning", value);
        },
        error(value) {
            return semanticStyle("error", value);
        },
        success(value) {
            return semanticStyle("success", value);
        },
        path(value) {
            return semanticStyle("path", value);
        },
        label(value) {
            return semanticStyle("label", value);
        },
        value(value) {
            return semanticStyle("value", value);
        }
    };
}


export function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}


function renderStyledValue(style, value, format, colors) {
    if (format === "html") {
        const aliases = {
            target: ["success"],
            high: ["error"],
            medium: ["warning"],
            low: ["muted"]
        }[style] ?? [];
        const classes = [style, ...aliases]
            .map(name => `s-${name}`)
            .join(" ");

        return `<span class="${classes}">${escapeHtml(value)}</span>`;
    }

    if (format === "plain") {
        return value;
    }

    const paint = {
        heading: text => colors.bold(colors.cyan(text)),
        target: colors.green,
        high: colors.red,
        medium: colors.yellow,
        low: colors.dim,
        warning: colors.yellow,
        error: colors.red,
        success: colors.green,
        muted: colors.dim,
        bold: colors.bold,
        path: colors.dim,
        label: colors.cyan,
        value: text => text
    }[style] ?? (text => text);

    return paint(value);
}


export function renderSemanticText(
    semanticText,
    {
        format = "plain",
        colorEnabled = false
    } = {}
) {
    const colors = pc.createColors(format === "ansi" && colorEnabled);
    let cursor = 0;
    let rendered = "";

    for (const match of semanticText.matchAll(STYLE_PATTERN)) {
        const rawText = semanticText.slice(cursor, match.index);
        rendered += format === "html" ? escapeHtml(rawText) : rawText;
        rendered += renderStyledValue(
            match[1],
            match[2],
            format,
            colors
        );
        cursor = match.index + match[0].length;
    }

    const remainder = semanticText.slice(cursor);
    rendered += format === "html" ? escapeHtml(remainder) : remainder;
    return rendered;
}


export function countBy(items, getKey) {
    const counts = new Map();

    for (const item of items) {
        const key = getKey(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right));
}


export function joinSections(sections) {
    return sections
        .filter(section => section.length > 0)
        .map(section => section.join("\n"))
        .join("\n\n");
}
