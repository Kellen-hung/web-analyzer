import fs from "node:fs/promises";
import path from "node:path";
import {
    buildIntegratedReport,
    normalizeReportMode
} from "./integrated_report.mjs";
import { escapeHtml, renderSemanticText } from "./report_format.mjs";


const REPORT_STYLES = `
:root {
    color-scheme: dark;
    --background: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --heading: #58a6ff;
    --success: #3fb950;
    --warning: #d29922;
    --error: #ff7b72;
}

* { box-sizing: border-box; }

body {
    margin: 0;
    background: var(--background);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 14px;
    line-height: 1.5;
}

.report-shell {
    min-width: min-content;
    padding: 28px 32px 48px;
}

.report-header {
    margin: 0 0 24px;
    padding: 0 0 18px;
    border-bottom: 1px solid var(--border);
}

.report-header h1 {
    margin: 0 0 10px;
    color: var(--heading);
    font-size: 20px;
    line-height: 1.3;
}

.report-meta {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 3px 14px;
    margin: 0;
}

.report-meta dt { color: var(--muted); }
.report-meta dd { margin: 0; overflow-wrap: anywhere; }

pre {
    margin: 0;
    white-space: pre;
    tab-size: 4;
    font: inherit;
}

.s-heading { color: var(--heading); font-weight: 700; }
.s-target, .s-success { color: var(--success); }
.s-high, .s-error { color: var(--error); font-weight: 600; }
.s-medium, .s-warning { color: var(--warning); font-weight: 600; }
.s-low, .s-muted, .s-path { color: var(--muted); }
.s-bold { color: #f0f6fc; font-weight: 700; }
.s-label { color: var(--heading); }
.s-value { color: var(--text); }
`;


function timestampOf(value) {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid generated timestamp for HTML report");
    }

    return date.toISOString();
}


export function renderHtmlReport(
    result,
    {
        root = "",
        lmParamJsonPath = null,
        mode = "default",
        generatedAt = new Date()
    } = {}
) {
    const effectiveMode = normalizeReportMode(mode);
    const semanticReport = buildIntegratedReport(result, {
        root,
        mode: effectiveMode,
        includeBanner: false
    });
    const reportBody = renderSemanticText(semanticReport, {
        format: "html"
    });
    const displayMode = effectiveMode === "default"
        ? "normal"
        : effectiveMode;
    const lmMetadata = lmParamJsonPath
        ? `\n                <dt>LM_PARAM snapshot</dt>\n                <dd>${escapeHtml(lmParamJsonPath)}</dd>`
        : "";

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>RX Web Analyzer Report</title>
    <style>${REPORT_STYLES}</style>
</head>
<body>
    <main class="report-shell">
        <header class="report-header">
            <h1>RX Web Analyzer</h1>
            <dl class="report-meta">
                <dt>Analyzed package</dt>
                <dd>${escapeHtml(root)}</dd>
                <dt>Generated</dt>
                <dd>${escapeHtml(timestampOf(generatedAt))}</dd>
                <dt>Mode</dt>
                <dd>${escapeHtml(displayMode)}</dd>${lmMetadata}
            </dl>
        </header>
        <pre aria-label="Integrated analysis report">${reportBody}</pre>
    </main>
</body>
</html>
`;
}


export async function writeHtmlReport(outputFile, html) {
    const absoluteOutputFile = path.resolve(outputFile);

    try {
        await fs.mkdir(path.dirname(absoluteOutputFile), {
            recursive: true
        });
        await fs.writeFile(absoluteOutputFile, html, "utf8");
    } catch (error) {
        throw new Error(
            `Unable to write HTML report to ${absoluteOutputFile}: ${error.message}`
        );
    }

    return absoluteOutputFile;
}
