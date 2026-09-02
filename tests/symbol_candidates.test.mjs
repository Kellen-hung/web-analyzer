import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePackage } from "../src/analyzer.mjs";


async function withFixture(files, callback) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "rx-web-symbol-candidate-test-")
    );

    try {
        for (const [relativePath, content] of Object.entries(files)) {
            const fullPath = path.join(directory, ...relativePath.split("/"));
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);
        }

        return await callback(directory);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}


function candidatesFor(result, name) {
    return result.symbolCandidates.candidates.filter(candidate =>
        candidate.name === name
    );
}


function getWorld(result, worldId) {
    return result.symbolAnalysis.worlds.find(world =>
        world.worldId === worldId
    );
}


test("unused local function is a high-confidence cleanup candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function outer() { function localUnused() {} return 1; }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "localUnused").find(item =>
            item.binding === "LOCAL"
        );

        assert(candidate);
        assert.equal(candidate.classification, "UNUSED_SYMBOL_CANDIDATE");
        assert.equal(candidate.confidence, "HIGH");
        assert.equal(candidate.definitionKind, "FunctionDeclaration");
        assert.equal(candidate.readCount, 0);
        assert.equal(candidate.referenceCount, 0);
    });
});


test("used local function is not a cleanup candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function outer() { function localUsed() {} localUsed(); }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });

        assert.equal(candidatesFor(result, "localUsed").length, 0);
    });
});


test("unused world function is a high-confidence cleanup candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function worldUnused() {}"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "worldUnused")[0];

        assert.equal(candidate.binding, "WORLD_GLOBAL");
        assert.equal(candidate.worldId, "index.html");
        assert.equal(candidate.confidence, "HIGH");
        assert.equal(candidate.declarationCount, 1);
        assert.equal(candidate.declarationLine, 1);
    });
});


test("same-world cross-file consumer prevents a world cleanup candidate", async () => {
    await withFixture({
        "index.html": "<script src='provider.js'></script><script src='consumer.js'></script>",
        "provider.js": "function crossFileUsed() {}",
        "consumer.js": "crossFileUsed();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });

        assert.equal(candidatesFor(result, "crossFileUsed").length, 0);
        assert.equal(
            getWorld(result, "index.html").globals.find(symbol =>
                symbol.name === "crossFileUsed"
            ).reads,
            1
        );
    });
});


test("iframe consumer does not consume a parent-world symbol", async () => {
    await withFixture({
        "index.html": "<script>function parentUnused() {}</script><iframe src='child.html'></iframe>",
        "child.html": "<script>parentUnused();</script>"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "parentUnused").find(item =>
            item.worldId === "index.html"
        );
        const child = result.symbolAnalysis.worlds.find(world =>
            world.document === "child.html"
        );

        assert(candidate);
        assert.equal(candidate.readCount, 0);
        assert(child.unresolvedGlobals.some(symbol =>
            symbol.name === "parentUnused"
        ));
    });
});


test("shared source usage in another world becomes positive-use evidence", async () => {
    await withFixture({
        "unused.html": "<script src='shared.js'></script>",
        "used.html": "<script src='shared.js'></script><script>sharedAcrossWorlds();</script>",
        "shared.js": "function sharedAcrossWorlds() {}"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["unused.html", "used.html"]
        });
        const observation = result.symbolCandidates.notRemovableObservations.find(item =>
            item.name === "sharedAcrossWorlds" &&
            item.worldId === "unused.html"
        );

        assert.equal(candidatesFor(result, "sharedAcrossWorlds").length, 0);
        assert.equal(observation.classification, "NOT_REMOVABLE_OBSERVATION");
        assert.equal(
            observation.reason,
            "PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD"
        );
        assert.equal(
            observation.evidenceType,
            "SHARED_SOURCE_USED_IN_OTHER_WORLD"
        );
        assert.deepEqual(observation.unusedInWorldIds, ["unused.html"]);
        assert.deepEqual(observation.usedInWorldIds, ["used.html"]);
        assert(observation.positiveUseEvidence.some(usage =>
            usage.worldId === "used.html"
        ));
    });
});


test("shared physical declaration unused in every world is one candidate", async () => {
    await withFixture({
        "one.html": "<script src='shared.js'></script>",
        "two.html": "<script src='shared.js'></script>",
        "shared.js": "function sharedUnusedEverywhere() {}"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["one.html", "two.html"]
        });
        const candidates = candidatesFor(result, "sharedUnusedEverywhere");

        assert.equal(candidates.length, 1);
        assert.deepEqual(
            candidates[0].worldIds,
            ["one.html", "two.html"]
        );
        assert.deepEqual(
            candidates[0].sharedSourceWorlds,
            ["one.html", "two.html"]
        );
    });
});


test("iframe isolation does not permit deleting a shared source used in the iframe", async () => {
    await withFixture({
        "index.html": "<script src='shared.js'></script><iframe src='child.html'></iframe>",
        "child.html": "<script src='shared.js'></script><script>usedInIframe();</script>",
        "shared.js": "function usedInIframe() {}"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const childWorld = result.symbolAnalysis.worlds.find(world =>
            world.document === "child.html"
        );
        const observation = result.symbolCandidates.notRemovableObservations
            .find(item => item.name === "usedInIframe");

        assert.equal(candidatesFor(result, "usedInIframe").length, 0);
        assert.deepEqual(observation.unusedInWorldIds, ["index.html"]);
        assert.deepEqual(observation.usedInWorldIds, [childWorld.worldId]);
        assert.equal(
            observation.reason,
            "PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD"
        );
    });
});


test("AJAX fragment consumer consumes a host-world symbol", async () => {
    await withFixture({
        "index.html": `
            <script src="app.js"></script>
            <div id="tabs"><a href="fragment.html">Remote</a></div>
        `,
        "app.js": `
            $("#tabs").tabs({});
            function fragmentUsed() {}
        `,
        "fragment.html": "<script>fragmentUsed();</script>"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });

        assert.equal(candidatesFor(result, "fragmentUsed").length, 0);
        assert.equal(
            getWorld(result, "index.html").globals.find(symbol =>
                symbol.name === "fragmentUsed"
            ).reads,
            1
        );
    });
});


test("multiple declarations lower candidate confidence", async () => {
    await withFixture({
        "index.html": "<script src='one.js'></script><script src='two.js'></script>",
        "one.js": "function repeatedUnused() {}",
        "two.js": "function repeatedUnused() {}"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "repeatedUnused")[0];
        const candidates = candidatesFor(result, "repeatedUnused");

        assert.equal(candidates.length, 2);
        assert.deepEqual(
            candidates.map(item => item.sourceId).sort(),
            ["one.js", "two.js"]
        );
        assert.equal(candidate.confidence, "MEDIUM");
        assert.equal(candidate.declarationCount, 2);
        assert(candidate.confidenceFactors.includes("MULTIPLE_DECLARATIONS"));
        assert.equal(candidate.declarationSites.length, 2);
    });
});


test("write-only variable is distinguished from a read variable", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": `
            function outer() {
                var writeOnly;
                writeOnly = 1;
                var actuallyRead = 2;
                console.log(actuallyRead);
            }
        `
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const writeOnly = candidatesFor(result, "writeOnly")[0];

        assert.equal(writeOnly.confidence, "MEDIUM");
        assert.equal(writeOnly.readCount, 0);
        assert.equal(writeOnly.writeCount, 1);
        assert.equal(writeOnly.referenceCount, 1);
        assert(writeOnly.confidenceFactors.includes("WRITE_ONLY_SYMBOL"));
        assert.equal(candidatesFor(result, "actuallyRead").length, 0);
    });
});


test("vendor declaration stays outside the main application queue", async () => {
    await withFixture({
        "index.html": "<script src='jquery-plugin.min.js'></script>",
        "jquery-plugin.min.js": "function vendorUnused() {}"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        assert.equal(candidatesFor(result, "vendorUnused").length, 0);
        assert.equal(result.symbolCandidates.vendorExcludedCount, 1);
        assert(result.symbolCandidates.vendorExcluded.some(item =>
            item.name === "vendorUnused" && item.reason === "VENDOR_SOURCE"
        ));
    });
});


test("runtime eval lowers confidence but keeps the local candidate visible", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function outer(code) { function evalHidden() {} eval(code); }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "evalHidden")[0];
        assert.equal(candidate.classification, "UNUSED_SYMBOL_CANDIDATE");
        assert.equal(candidate.confidence, "LOW");
        assert(candidate.riskFlags.includes("RUNTIME_DYNAMIC_CODE_IN_SOURCE"));
    });
});


test("direct eval does not erase a local binding's static reads", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": `
            function update(responseText) {
                eval(responseText);

                if (cond) {
                    var realDone = total - remain;

                    if (realDone > current) {
                        current = realDone;
                    }
                }
            }
        `
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );
        const realDone = sourceFacts.scopes
            .flatMap(scope => scope.variables)
            .find(variable => variable.name === "realDone");

        assert.equal(realDone.reads, 2);
        assert.equal(realDone.writes, 0);
        assert.equal(realDone.references.length, 2);
        assert.equal(candidatesFor(result, "realDone").length, 0);
    });
});


test("unrelated application eval does not hide a local candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script><script src='dynamic.js'></script>",
        "app.js": "function outer() { function unrelatedToEval() {} }",
        "dynamic.js": "eval(runtimeCode);"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "unrelatedToEval")[0];

        assert.equal(candidate.confidence, "HIGH");
        assert.deepEqual(candidate.riskFlags, []);
    });
});


test("vendor eval does not taint an application global candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script><script src='jquery-plugin.min.js'></script>",
        "app.js": "function applicationUnused() {}",
        "jquery-plugin.min.js": "eval(runtimeCode);"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "applicationUnused")[0];

        assert.equal(candidate.confidence, "HIGH");
        assert.deepEqual(candidate.riskFlags, []);
    });
});


test("static eval reference is positive use rather than a candidate risk", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function evalReferenced() {} eval('evalReferenced()');"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const observation = result.symbolCandidates.notRemovableObservations
            .find(item => item.name === "evalReferenced");

        assert.equal(candidatesFor(result, "evalReferenced").length, 0);
        assert.equal(observation.reason, "STATIC_DYNAMIC_CODE_REFERENCE");
        assert.equal(
            observation.positiveUseEvidence[0].dynamicSiteType,
            "EVAL"
        );
    });
});


test("static string timeout reference is positive use evidence", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function timeoutReferenced() {} setTimeout('timeoutReferenced()', 10);"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const observation = result.symbolCandidates.notRemovableObservations
            .find(item => item.name === "timeoutReferenced");

        assert.equal(candidatesFor(result, "timeoutReferenced").length, 0);
        assert.equal(observation.reason, "STATIC_DYNAMIC_CODE_REFERENCE");
        assert.equal(
            observation.positiveUseEvidence[0].dynamicSiteType,
            "STRING_SETTIMEOUT"
        );
    });
});


test("dynamic operation inside an unused function body is only a risk", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function load_scripts() { $.getScript(runtimePath); }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "load_scripts")[0];

        assert.equal(candidate.classification, "UNUSED_SYMBOL_CANDIDATE");
        assert(candidate.riskFlags.includes(
            "DYNAMIC_BEHAVIOR_IN_CANDIDATE_BODY"
        ));
        assert(candidate.riskFlags.includes("DYNAMIC_SCRIPT_LOAD_PRESENT"));
    });
});


test("generic window property access lowers confidence without blocking", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function maybeDynamicGlobal() {} console.log(window[runtimeName]);"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "maybeDynamicGlobal")[0];

        assert.equal(candidate.classification, "UNUSED_SYMBOL_CANDIDATE");
        assert.equal(candidate.confidence, "MEDIUM");
        assert(candidate.riskFlags.includes("DYNAMIC_GLOBAL_PROPERTY_ACCESS"));
    });
});


test("static window dot property access counts as a direct consumer", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function dotReferenced() {} window.dotReferenced();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const symbol = getWorld(result, "index.html").globals.find(item =>
            item.name === "dotReferenced"
        );

        assert.equal(candidatesFor(result, "dotReferenced").length, 0);
        assert.equal(symbol.reads, 1);
    });
});


test("static window literal property access counts as a direct consumer", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function bracketReferenced() {} window['bracketReferenced']();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const symbol = getWorld(result, "index.html").globals.find(item =>
            item.name === "bracketReferenced"
        );

        assert.equal(candidatesFor(result, "bracketReferenced").length, 0);
        assert.equal(symbol.reads, 1);
    });
});


test("effectful initializer keeps binding candidate visible with statement risk", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function outer() { var response = performRequest(); }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "response")[0];

        assert.equal(candidate.classification, "UNUSED_SYMBOL_CANDIDATE");
        assert.equal(candidate.initializerSideEffectRisk, true);
        assert.equal(candidate.removalScope, "BINDING_REVIEW");
        assert(candidate.riskFlags.includes(
            "INITIALIZER_MAY_HAVE_SIDE_EFFECTS"
        ));
    });
});


test("parse error is reported as a coverage gap without candidates", async () => {
    await withFixture({
        "index.html": "<script src='broken.js'></script>",
        "broken.js": "function broken( {"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const gap = result.symbolCandidates.coverageGaps.find(item =>
            item.sourceId === "broken.js"
        );

        assert.equal(result.symbolCandidates.candidates.length, 0);
        assert.equal(gap.classification, "COVERAGE_GAP");
        assert.deepEqual(gap.worldIds, ["index.html"]);
    });
});


test("unknown globals do not taint an unrelated declared candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function unrelatedDeclared() {} missingRuntimeGlobal();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const candidate = candidatesFor(result, "unrelatedDeclared")[0];

        assert.equal(candidate.confidence, "HIGH");
        assert.deepEqual(candidate.riskFlags, []);
    });
});


test("explicit window binding resolution remains unchanged and is not a declared-symbol candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "window.explicitName = 1; explicitName();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const symbol = getWorld(result, "index.html").globals.find(item =>
            item.name === "explicitName"
        );

        assert.equal(symbol.declarations[0].type, "GlobalObjectProperty");
        assert.equal(symbol.reads, 1);
        assert.equal(candidatesFor(result, "explicitName").length, 0);
    });
});


test("sloppy implicit-global resolution remains unchanged and is not a declared-symbol candidate", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "implicitName = 1; implicitName();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const symbol = getWorld(result, "index.html").globals.find(item =>
            item.name === "implicitName"
        );

        assert.equal(symbol.declarations[0].type, "ImplicitGlobalAssignment");
        assert.equal(symbol.reads, 1);
        assert.equal(symbol.writes, 1);
        assert.equal(candidatesFor(result, "implicitName").length, 0);
    });
});
