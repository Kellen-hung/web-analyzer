import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePackage } from "../src/analyzer.mjs";
import { renderCliReport } from "../src/report/cli_report.mjs";
import {
    renderHtmlReport,
    writeHtmlReport
} from "../src/report/html_report.mjs";


const FIXED_TIME = new Date("2026-09-02T04:05:06.000Z");
let reportResult;


async function withDirectory(callback) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "rx-web-analyzer-html-test-")
    );

    try {
        return await callback(directory);
    } finally {
        await fs.rm(directory, {
            recursive: true,
            force: true
        });
    }
}


async function buildReportFixture() {
    return withDirectory(async directory => {
        const files = {
            "index.html": `
                <script src="high.js"></script>
                <script src="medium.js"></script>
                <script src="low.js"></script>
            `,
            "high.js": `
                function highOuter() {
                    function highUnused() {}
                }
            `,
            "medium.js": `
                function mediumOuter() {
                    var mediumUnused;
                    mediumUnused = buildValue();
                }
            `,
            "low.js": `
                function lowOuter(runtimeCode) {
                    function lowUnused() {}
                    eval(runtimeCode);
                }
            `
        };

        for (const [relativePath, content] of Object.entries(files)) {
            const fullPath = path.join(directory, relativePath);
            await fs.writeFile(fullPath, content, "utf8");
        }

        return analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
    });
}


function render(mode = "verbose", overrides = {}) {
    return renderHtmlReport(reportResult, {
        root: "fixture/www",
        mode,
        generatedAt: FIXED_TIME,
        ...overrides
    });
}


test.before(async () => {
    reportResult = await buildReportFixture();
});


test("HTML report is self-contained and preserves whitespace", () => {
    const html = render();

    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<style>[\s\S]*--background:/);
    assert.match(html, /<pre aria-label="Integrated analysis report">/);
    assert.doesNotMatch(html, /<(?:script|link)\b/i);
    assert.doesNotMatch(html, /\b(?:src|href)\s*=/i);
});


test("HTML escapes report paths, filenames, and content", () => {
    const maliciousResult = structuredClone(reportResult);
    maliciousResult.fileReport.candidates = [{
        confidence: "HIGH",
        path: "bad<&\"'.js",
        type: "JS",
        note: "<danger>&\"'"
    }];
    const html = renderHtmlReport(maliciousResult, {
        root: "C:\\pkg\\<root>&\"'",
        mode: "verbose",
        generatedAt: FIXED_TIME
    });

    assert.doesNotMatch(html, /<danger>|<root>/);
    assert.match(html, /bad&lt;&amp;&quot;&#39;\.js/);
    assert.match(html, /&lt;danger&gt;&amp;&quot;&#39;/);
    assert.match(html, /&lt;root&gt;&amp;&quot;&#39;/);
});


test("HIGH, MEDIUM, and LOW use distinct semantic styles", () => {
    const html = render();

    assert.match(html, /class="s-high s-error">HIGH<\/span>/);
    assert.match(html, /class="s-medium s-warning">MEDIUM<\/span>/);
    assert.match(html, /class="s-low s-muted">LOW<\/span>/);
});


test("warning, error, and success semantic styles are retained", () => {
    const html = render();

    assert.match(html, /class="s-high s-error"/);
    assert.match(html, /class="s-medium s-warning"/);
    assert.match(html, /class="s-target s-success"/);
    assert.match(html, /\.s-target, \.s-success/);
    assert.match(html, /\.s-high, \.s-error/);
    assert.match(html, /\.s-medium, \.s-warning/);
});


test("HTML semantic colors do not depend on NO_COLOR", () => {
    const previous = process.env.NO_COLOR;

    try {
        process.env.NO_COLOR = "1";
        const html = render();

        assert.match(html, /class="s-high s-error"/);
        assert.match(html, /class="s-medium s-warning"/);
        assert.match(html, /class="s-low s-muted"/);
        assert.match(html, /class="s-target s-success"/);
    } finally {
        if (previous === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previous;
        }
    }
});


test("verbose terminal and HTML reports contain equivalent major sections", () => {
    const terminal = renderCliReport(reportResult, {
        root: "fixture/www",
        mode: "verbose",
        colorEnabled: false
    });
    const html = render("verbose");
    const headings = [
        "PACKAGE",
        "CLEANUP SUMMARY",
        "FILE CLEANUP CANDIDATES",
        "SYMBOL CLEANUP CANDIDATES",
        "SYMBOL CANDIDATE RISKS",
        "SYMBOL COVERAGE GAPS",
        "LM_PARAM CLEANUP CANDIDATES",
        "LM_PARAM CONSUMED FIELDS",
        "LM_PARAM FRONTEND-MISSING FIELDS",
        "LM_PARAM RISKS",
        "LM_PARAM COVERAGE ERRORS",
        "ANALYSIS HEALTH",
        "BROWSER WORLDS",
        "UNKNOWN GLOBALS"
    ];

    for (const heading of headings) {
        assert(terminal.includes(heading), `terminal missing ${heading}`);
        assert(html.includes(heading), `HTML missing ${heading}`);
    }
});


test("normal and verbose HTML hide not-removable observations", () => {
    for (const mode of ["default", "verbose"]) {
        const html = render(mode);

        assert.equal(
            html.includes("USED / NOT-REMOVABLE OBSERVATIONS"),
            false
        );
        assert.equal(
            html.includes("used/not-removable observations:"),
            false
        );
    }
});


test("normal HTML excludes debug-only sections", () => {
    const html = render("default");

    for (const heading of [
        "USED / NOT-REMOVABLE OBSERVATIONS",
        "WORLD DETAILS",
        "REFERENCE DIAGNOSTICS",
        "RAW SYMBOL DIAGNOSTICS",
        "LM_PARAM ACCESS SITES"
    ]) {
        assert.equal(html.includes(heading), false);
    }
});


test("debug HTML includes expected debug sections", () => {
    const html = render("debug");

    for (const heading of [
        "WORLD DETAILS",
        "HTML ROLES",
        "REFERENCE DIAGNOSTICS",
        "CORPUS FINDINGS",
        "RAW SYMBOL DIAGNOSTICS",
        "LM_PARAM ACCESS SITES"
    ]) {
        assert(html.includes(heading), `debug HTML missing ${heading}`);
    }
});


test("report header includes package, timestamp, mode, and LM_PARAM path", () => {
    const html = render("verbose", {
        root: "C:\\packages\\RX\\www",
        lmParamJsonPath: "C:\\packages\\RX\\lm_params_json"
    });

    assert.match(html, /<h1>RX Web Analyzer<\/h1>/);
    assert.match(html, /C:\\packages\\RX\\www/);
    assert.match(html, /2026-09-02T04:05:06\.000Z/);
    assert.match(html, /<dd>verbose<\/dd>/);
    assert.match(html, /C:\\packages\\RX\\lm_params_json/);
});


test("writer creates a missing parent reports directory", async () => {
    await withDirectory(async directory => {
        const outputFile = path.join(
            directory,
            "nested",
            "reports",
            "report.html"
        );

        await writeHtmlReport(outputFile, render());

        const stat = await fs.stat(path.dirname(outputFile));
        assert.equal(stat.isDirectory(), true);
    });
});


test("writer generates the configured HTML report file", async () => {
    await withDirectory(async directory => {
        const outputFile = path.join(directory, "reports", "report.html");
        const writtenPath = await writeHtmlReport(outputFile, render());
        const content = await fs.readFile(outputFile, "utf8");

        assert.equal(writtenPath, path.resolve(outputFile));
        assert.match(content, /^<!doctype html>/i);
        assert.match(content, /SYMBOL CLEANUP CANDIDATES/);
    });
});


test("HTML generation does not modify analyzed input", async () => {
    await withDirectory(async directory => {
        const inputDirectory = path.join(directory, "package", "www");
        const inputFile = path.join(inputDirectory, "index.html");
        const outputFile = path.join(directory, "reports", "report.html");
        await fs.mkdir(inputDirectory, { recursive: true });
        await fs.writeFile(inputFile, "<p>unchanged</p>", "utf8");
        const beforeFiles = await fs.readdir(inputDirectory);
        const beforeContent = await fs.readFile(inputFile, "utf8");

        const html = render("verbose", {
            root: inputDirectory
        });
        await writeHtmlReport(outputFile, html);

        assert.deepEqual(await fs.readdir(inputDirectory), beforeFiles);
        assert.equal(await fs.readFile(inputFile, "utf8"), beforeContent);
    });
});


test("HTML summary preserves current terminal counts", () => {
    const terminal = renderCliReport(reportResult, {
        root: "fixture/www",
        mode: "verbose",
        colorEnabled: false
    });
    const html = render("verbose");
    const expectedFragments = [
        `${reportResult.inventory.length} files`,
        `${reportResult.worldResolution.worlds.length} browser worlds`,
        `SYMBOL CLEANUP CANDIDATES · ${reportResult.symbolCandidates.candidates.length}`,
        `LM_PARAM CLEANUP CANDIDATES · ${reportResult.lmParamAnalysis.candidates.length}`
    ];

    for (const fragment of expectedFragments) {
        assert(terminal.includes(fragment));
        assert(html.includes(fragment));
    }
});
