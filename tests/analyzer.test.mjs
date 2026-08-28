import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePackage } from "../src/analyzer.mjs";
import { inspectJavaScript } from "../src/facts/js_facts.mjs";
import {
    resolveUrlExpression,
    URL_RESOLUTION_STATE
} from "../src/resolution/url_expression_resolver.mjs";


async function withFixture(files, callback) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "rx-web-analyzer-test-")
    );

    try {
        for (const [relativePath, content] of Object.entries(files)) {
            const fullPath = path.join(directory, ...relativePath.split("/"));
            await fs.mkdir(path.dirname(fullPath), {
                recursive: true
            });
            await fs.writeFile(fullPath, content);
        }

        return await callback(directory);
    } finally {
        await fs.rm(directory, {
            recursive: true,
            force: true
        });
    }
}


function syntheticElf(...strings) {
    return Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]),
        ...strings.flatMap(value => [
            Buffer.from(value, "ascii"),
            Buffer.from([0])
        ])
    ]);
}


test("JS facts keep only a contiguous static prefix and identify tabs initialization", () => {
    const facts = inspectJavaScript(`
        $.get("a" + runtimeValue + "b");
        $("#tabs").tabs("option", "selected");
        $("#tabs").tabs({ load: onLoad });
    `, "app.js");

    assert.equal(facts.parseError, null);
    assert.equal(facts.resourceFacts[0].target.staticPrefix, "a");
    assert.deepEqual(
        facts.worldFacts.map(fact => fact.type),
        ["JQUERY_TABS_INIT"]
    );
    assert.equal(facts.dynamicSites.length, 0);
    assert.equal("dynamicRisks" in facts, false);
});


test("inline handlers allow function-body return without relaxing normal scripts", () => {
    const normal = inspectJavaScript(
        "x=1; return true;",
        "normal.js"
    );
    const handler = inspectJavaScript(
        "x=1; return true;",
        "index.html#onsubmit:1",
        { allowReturnOutsideFunction: true }
    );

    assert.match(normal.parseError, /return.*outside of function/i);
    assert.equal(handler.parseError, null);
});


test("URL expressions distinguish dynamic pathnames from query-only dynamics", () => {
    const facts = inspectJavaScript(`
        $.get("images/" + theme + ".png");
        $.get("version.html?_=" + Date.now());
    `, "app.js");
    const dynamicPath = resolveUrlExpression(
        facts.resourceFacts[0].target.urlExpression
    );
    const dynamicQuery = resolveUrlExpression(
        facts.resourceFacts[1].target.urlExpression
    );

    assert.equal(dynamicPath.state, URL_RESOLUTION_STATE.PARTIALLY_RESOLVED);
    assert.equal(dynamicPath.pathname, null);
    assert.equal(dynamicQuery.state, URL_RESOLUTION_STATE.RESOLVED);
    assert.equal(dynamicQuery.pathname, "version.html");
    assert(dynamicQuery.unresolvedSymbols.includes("Date.now()"));
});


test("symbolic URL bindings resolve direct CGI, current origin, helpers, and VW parent paths", async () => {
    await withFixture({
        "index.html": `
            <script src="js/base.js"></script>
            <script src="js/app.js"></script>
        `,
        "vw/index.html": `
            <script src="../js/base.js"></script>
            <script src="../js/vw.js"></script>
        `,
        "js/base.js": `
            var CGI_PATH = "/cgi-bin/";
            var currentOrigin = location.protocol + "//" + location.host;
            function currentHostname() { return window.location.hostname; }
        `,
        "js/app.js": `
            $.get(CGI_PATH + "query.cgi");
            $.get(currentOrigin + CGI_PATH + "e_jsonp.cgi");
            $.get("http://" + currentHostname() + CGI_PATH + "helper.cgi");
            $.get("images/" + theme + ".png");
            $.get("version.html?_=" + Date.now());
            var evidenceOnly = "ghost.png";
        `,
        "js/vw.js": `
            CGI_PATH = "../cgi-bin/";
            $.get(CGI_PATH + "sh.cgi");
        `,
        "cgi-bin/query.cgi": "#!/bin/sh",
        "cgi-bin/e_jsonp.cgi": "#!/bin/sh",
        "cgi-bin/helper.cgi": "#!/bin/sh",
        "cgi-bin/sh.cgi": "#!/bin/sh",
        "version.html": "version"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html", "vw/index.html"]
        });
        const staticTargets = new Set(
            result.worldResolution.staticReferences.map(reference => reference.target)
        );
        const missingTargets = new Set(
            result.fileReport.referencedButNotPackaged.map(item => item.target)
        );

        for (const target of [
            "cgi-bin/query.cgi",
            "cgi-bin/e_jsonp.cgi",
            "cgi-bin/helper.cgi",
            "cgi-bin/sh.cgi",
            "version.html"
        ]) {
            assert(staticTargets.has(target), `${target} should resolve as packaged`);
            assert.equal(missingTargets.has(target), false);
        }
        const directQuery = result.worldResolution.staticReferences.find(reference =>
            reference.rawTarget === 'CGI_PATH + "query.cgi"'
        );
        assert.equal(directQuery.pathname, "/cgi-bin/query.cgi");
        assert.equal(directQuery.packagePath, "cgi-bin/query.cgi");
        assert.equal(directQuery.urlResolutionState, URL_RESOLUTION_STATE.RESOLVED);
        assert.equal(missingTargets.has("images"), false);
        assert.equal(missingTargets.has("ghost.png"), false);
        assert(result.fileReport.partialReferences.some(reference =>
            reference.rawTarget === '"images/" + theme + ".png"' &&
            reference.urlResolutionState === URL_RESOLUTION_STATE.PARTIALLY_RESOLVED
        ));

        const roles = new Map(
            result.worldResolution.htmlRoles.map(role => [role.path, role.role])
        );
        assert.equal(roles.get("version.html"), "FETCHED_RESOURCE");
        const vw = result.worldResolution.worlds.find(world =>
            world.id === "vw/index.html"
        );
        assert.equal(vw.literalBindings.at(-1).value, "../cgi-bin/");
    });
});


test("world resolution merges tab fragments, keeps iframe scope separate, and uses host runtime base", async () => {
    await withFixture({
        "index.html": `
            <link rel="stylesheet" href="css/main.css">
            <script src="js/app.js"></script>
            <div id="tabs"><a href="html/fragment.html">Remote</a></div>
            <a href="other.html">Ordinary</a>
            <form onsubmit="x=1; return true;"></form>
        `,
        "js/app.js": `
            $("#tabs").tabs({});
            $.get("version.html?_=" + Date.now());
        `,
        "html/fragment.html": `
            <script src="js/foo.js"></script>
            <iframe src="child.html"></iframe>
        `,
        "js/foo.js": "window.fragmentCode = true;",
        "child.html": "<script>window.childOnly = true;</script>",
        "other.html": "<p>ordinary navigation</p>",
        "version.html": "version data",
        "css/main.css": "body { color: black; }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const parent = result.worldResolution.worlds.find(world =>
            world.id === "index.html"
        );
        const child = result.worldResolution.worlds.find(world =>
            world.document === "child.html"
        );

        assert(parent.htmlMembers.some(member =>
            member.path === "html/fragment.html" &&
            member.role === "AJAX_FRAGMENT"
        ));
        assert(parent.scriptLoads.some(load =>
            load.filePath === "js/foo.js" &&
            load.containerPath === "html/fragment.html" &&
            load.runtimeBase === "index.html"
        ));
        assert(child);
        assert.equal(child.parentWorldId, parent.id);
        assert.equal(
            parent.scriptLoads.some(load => load.sourceId.startsWith("child.html#")),
            false
        );

        const roles = new Map(
            result.worldResolution.htmlRoles.map(role => [role.path, role.role])
        );
        assert.equal(roles.get("html/fragment.html"), "AJAX_FRAGMENT");
        assert.equal(roles.get("other.html"), "ENTRY_DOCUMENT");
        assert.equal(roles.get("child.html"), "IFRAME_DOCUMENT");
        assert.equal(roles.get("version.html"), "FETCHED_RESOURCE");
        assert.equal(
            result.jsFacts.filter(fact => fact.source.includes("#onsubmit"))[0].parseError,
            null
        );
    });
});


test("literal globals are resolved per world in script order", async () => {
    await withFixture({
        "one.html": `
            <script src="js/shared.js"></script>
            <script src="js/one.js"></script>
        `,
        "two/index.html": `
            <script src="../js/shared.js"></script>
            <script src="../js/two.js"></script>
        `,
        "js/shared.js": "var CGI_PATH='/initial/';",
        "js/one.js": "CGI_PATH='/one/'; $.get(CGI_PATH+'ping.cgi');",
        "js/two.js": "CGI_PATH='../two-api/'; $.get(CGI_PATH+'ping.cgi');"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["one.html", "two/index.html"]
        });
        const missingTargets = new Set(
            result.fileReport.referencedButNotPackaged.map(item => item.target)
        );

        assert(missingTargets.has("one/ping.cgi"));
        assert(missingTargets.has("two-api/ping.cgi"));
        const one = result.worldResolution.worlds.find(world => world.id === "one.html");
        const two = result.worldResolution.worlds.find(world => world.id === "two/index.html");
        assert.equal(one.literalBindings.at(-1).value, "/one/");
        assert.equal(two.literalBindings.at(-1).value, "../two-api/");
    });
});


test("corpus evidence classifies package, missing web, device, and extensionless resources", async () => {
    await withFixture({
        "index.html": "<p>entry</p>",
        "update_fw.html": "<p>firmware result</p>",
        "orphan.js": "function unused() {}",
        "broken.js": "function {",
        "cgi-bin/backend.cgi": syntheticElf(
            "/update_fw.html",
            "/www/generated.js",
            "/share/temp.png"
        ),
        "cgi-bin/query.cgi": "#!/bin/sh\n. /www/cgi-bin/bashlib\n",
        "cgi-bin/bashlib": "#!/bin/sh\necho helper\n"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const references = result.corpusFacts.flatMap(source => source.references);
        const classification = rawTarget =>
            references.find(reference => reference.rawTarget === rawTarget)?.classification;

        assert.equal(classification("/update_fw.html"), "PACKAGE_RESOURCE");
        assert.equal(classification("/www/generated.js"), "MISSING_WEB_RESOURCE");
        assert.equal(classification("/share/temp.png"), "DEVICE_PATH");
        assert.equal(classification("/www/cgi-bin/bashlib"), "PACKAGE_RESOURCE");

        const candidatePaths = new Set(
            result.fileReport.candidates.map(candidate => candidate.path)
        );
        assert.equal(candidatePaths.has("update_fw.html"), false);
        assert.equal(candidatePaths.has("orphan.js"), true);
        assert.equal(candidatePaths.has("broken.js"), false);

        const updateRecord = result.fileReport.files.find(file =>
            file.path === "update_fw.html"
        );
        assert(updateRecord.corpusIncomingReferences.some(reference =>
            reference.evidenceType === "BINARY_STRING_REF"
        ));
        const brokenRecord = result.fileReport.files.find(file =>
            file.path === "broken.js"
        );
        assert(brokenRecord.unresolvedEvidence.some(reference =>
            reference.evidenceType === "JS_PARSE_ERROR"
        ));
    });
});


test("PostCSS facts resolve imports and url resources without CSS rule analysis", async () => {
    await withFixture({
        "index.html": "<link rel='stylesheet' href='css/main.css'>",
        "css/main.css": "@import 'nested.css'; body { background: url('../images/p.png'); }",
        "css/nested.css": "p { color: blue; }",
        "images/p.png": Buffer.from([0x89, 0x50, 0x4e, 0x47])
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const mainCss = result.cssFacts.find(fact => fact.path === "css/main.css");

        assert.deepEqual(
            mainCss.references.map(reference => reference.kind).sort(),
            ["CSS_IMPORT", "CSS_URL"]
        );
        assert(result.fileReport.staticReferences.some(reference =>
            reference.source === "css/main.css" &&
            reference.target === "css/nested.css"
        ));
        assert(result.fileReport.staticReferences.some(reference =>
            reference.source === "css/main.css" &&
            reference.target === "images/p.png"
        ));
    });
});
