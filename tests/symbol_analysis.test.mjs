import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePackage } from "../src/analyzer.mjs";
import { classifyWorldGlobals } from "../src/symbols/global_classifier.mjs";


async function withFixture(files, callback) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "rx-web-symbol-test-")
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


function getWorld(result, worldId) {
    return result.symbolAnalysis.worlds.find(world =>
        world.worldId === worldId
    );
}


function getGlobal(world, name) {
    return world.globals.find(symbol => symbol.name === name);
}


test("world symbols resolve across sources and count a repeated load once", async () => {
    await withFixture({
        "index.html": `
            <script src="a.js"></script>
            <script src="a.js"></script>
            <script src="b.js"></script>
        `,
        "a.js": "function foo() {}",
        "b.js": "foo();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const foo = getGlobal(world, "foo");
        const source = world.sources.find(item => item.sourceId === "a.js");

        assert.deepEqual(
            world.sources.map(item => item.sourceId),
            ["a.js", "b.js"]
        );
        assert.equal(source.loads.length, 2);
        assert.equal(foo.declarations.length, 1);
        assert.equal(foo.references.length, 1);
        assert.equal(foo.references[0].sourceId, "b.js");
        assert.equal(foo.references[0].resolution, "WORLD");
    });
});


test("same-name declarations merge within one world but remain isolated across worlds", async () => {
    await withFixture({
        "one.html": `
            <script src="one-a.js"></script>
            <script src="one-b.js"></script>
        `,
        "two.html": "<script src='two.js'></script>",
        "one-a.js": "var shared = 1;",
        "one-b.js": "var shared = 2;",
        "two.js": "shared();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["one.html", "two.html"]
        });
        const one = getWorld(result, "one.html");
        const two = getWorld(result, "two.html");
        const oneShared = getGlobal(one, "shared");
        const twoShared = two.unresolvedGlobals.find(symbol =>
            symbol.name === "shared"
        );

        assert.equal(oneShared.declarations.length, 2);
        assert.equal(oneShared.multipleDeclarations, true);
        assert(twoShared);
        assert.equal(getGlobal(two, "shared"), undefined);
    });
});


test("AJAX fragment and inline JavaScript join the host world", async () => {
    await withFixture({
        "index.html": `
            <script src="loader.js"></script>
            <div id="tabs"><a href="fragment.html">Remote</a></div>
            <script>inlineConsumer();</script>
        `,
        "loader.js": `
            $("#tabs").tabs({});
            function inlineConsumer() {}
        `,
        "fragment.html": `
            <script src="fragment.js"></script>
            <script>fragmentGlobal();</script>
        `,
        "fragment.js": "function fragmentGlobal() {}"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const inlineConsumer = getGlobal(world, "inlineConsumer");
        const fragmentGlobal = getGlobal(world, "fragmentGlobal");

        assert(world.sources.some(source =>
            source.sourceId.startsWith("index.html#inline-script:")
        ));
        assert(world.sources.some(source =>
            source.sourceId.startsWith("fragment.html#inline-script:")
        ));
        assert(world.sources.some(source => source.sourceId === "fragment.js"));
        assert(inlineConsumer.references.some(reference =>
            reference.resolution === "WORLD"
        ));
        assert(fragmentGlobal.references.some(reference =>
            reference.resolution === "WORLD"
        ));
    });
});


test("iframe symbols do not resolve against the parent world", async () => {
    await withFixture({
        "index.html": `
            <script>function parentOnly() {}</script>
            <iframe src="child.html"></iframe>
        `,
        "child.html": `
            <script>parentOnly(); var childOnly = 1;</script>
        `
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const parent = getWorld(result, "index.html");
        const child = result.symbolAnalysis.worlds.find(world =>
            world.document === "child.html"
        );

        assert(getGlobal(parent, "parentOnly"));
        assert.equal(getGlobal(parent, "childOnly"), undefined);
        assert(getGlobal(child, "childOnly"));
        assert(child.unresolvedGlobals.some(symbol =>
            symbol.name === "parentOnly"
        ));
    });
});


test("inline handlers allow return and keep declarations in function scope", async () => {
    await withFixture({
        "index.html": `
            <script>function submitForm() {}</script>
            <form onsubmit="var handlerLocal = 1; submitForm(); return true;"></form>
        `
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const submitForm = getGlobal(world, "submitForm");
        const handlerFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceType === "INLINE_HANDLER"
        );
        const handlerVariable = handlerFacts.scopes
            .flatMap(scope => scope.variables)
            .find(variable => variable.name === "handlerLocal");

        assert.equal(world.parseErrors.length, 0);
        assert.equal(getGlobal(world, "handlerLocal"), undefined);
        assert(handlerVariable);
        assert(submitForm.references.some(reference =>
            reference.sourceId === handlerFacts.sourceId &&
            reference.resolution === "WORLD"
        ));
    });
});


test("world symbol parse errors retain source identity without aborting analysis", async () => {
    await withFixture({
        "index.html": `
            <script src="valid.js"></script>
            <script src="broken.js"></script>
        `,
        "valid.js": "var validGlobal = 1;",
        "broken.js": "function {"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");

        assert(getGlobal(world, "validGlobal"));
        assert.equal(world.parseErrors.length, 1);
        assert.equal(world.parseErrors[0].sourceId, "broken.js");
        assert.match(world.parseErrors[0].error, /unexpected token/i);
    });
});


test("explicit window property binding resolves a free identifier in the same source", async () => {
    await withFixture({
        "index.html": "<script src='same.js'></script>",
        "same.js": `
            window.foo = 1;
            console.log(foo);
        `
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "same.js"
        );
        const foo = getGlobal(world, "foo");
        const declaration = foo.declarations[0];
        const providerWrite = foo.references.find(reference =>
            reference.referenceType === "GlobalObjectPropertyWrite"
        );
        const freeReference = foo.references.find(reference =>
            reference.referenceType === undefined
        );

        assert.deepEqual(sourceFacts.explicitGlobalBindings, [{
            name: "foo",
            type: "GlobalObjectProperty",
            object: "window",
            sourceId: "same.js",
            line: 2,
            column: 12
        }]);
        assert.equal(declaration.type, "GlobalObjectProperty");
        assert.equal(providerWrite.resolution, "SOURCE");
        assert.equal(providerWrite.write, true);
        assert.equal(freeReference.sourceId, "same.js");
        assert.equal(freeReference.resolution, "WORLD");
        assert.equal(world.unresolvedGlobals.some(symbol => symbol.name === "foo"), false);
    });
});


test("explicit window property binding resolves a free identifier across sources", async () => {
    await withFixture({
        "index.html": `
            <script src="provider.js"></script>
            <script src="consumer.js"></script>
        `,
        "provider.js": "window.foo = 123;",
        "consumer.js": "foo();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const foo = getGlobal(world, "foo");
        const freeReference = foo.references.find(reference =>
            reference.sourceId === "consumer.js"
        );

        assert.equal(foo.declarations[0].sourceId, "provider.js");
        assert.equal(foo.declarations[0].type, "GlobalObjectProperty");
        assert.equal(freeReference.resolution, "WORLD");
        assert.equal(world.unresolvedGlobals.some(symbol => symbol.name === "foo"), false);
    });
});


test("explicit window property binding does not cross entry worlds", async () => {
    await withFixture({
        "provider.html": "<script>window.foo = 1;</script>",
        "consumer.html": "<script>foo();</script>"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["provider.html", "consumer.html"]
        });
        const provider = getWorld(result, "provider.html");
        const consumer = getWorld(result, "consumer.html");

        assert(getGlobal(provider, "foo"));
        assert.equal(getGlobal(consumer, "foo"), undefined);
        assert(consumer.unresolvedGlobals.some(symbol => symbol.name === "foo"));
    });
});


test("explicit window property binding does not cross iframe boundaries", async () => {
    await withFixture({
        "index.html": `
            <script>window.foo = 1;</script>
            <iframe src="child.html"></iframe>
        `,
        "child.html": "<script>foo();</script>"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const parent = getWorld(result, "index.html");
        const child = result.symbolAnalysis.worlds.find(world =>
            world.document === "child.html"
        );

        assert(getGlobal(parent, "foo"));
        assert.equal(getGlobal(child, "foo"), undefined);
        assert(child.unresolvedGlobals.some(symbol => symbol.name === "foo"));
    });
});


test("read-only window property access does not provide a global binding", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "console.log(window.foo); foo();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.explicitGlobalBindings, []);
        assert.equal(getGlobal(world, "foo"), undefined);
        assert(world.unresolvedGlobals.some(symbol => symbol.name === "foo"));
    });
});


test("dynamic window property assignment does not provide a static global binding", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "window[name] = 1; foo();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.explicitGlobalBindings, []);
        assert.equal(getGlobal(world, "foo"), undefined);
        assert(world.unresolvedGlobals.some(symbol => symbol.name === "foo"));
    });
});


test("a locally shadowed window identifier does not provide a browser global binding", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": `
            function configure(window) { window.foo = 1; }
            foo();
        `
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.explicitGlobalBindings, []);
        assert.equal(getGlobal(world, "foo"), undefined);
        assert(world.unresolvedGlobals.some(symbol => symbol.name === "foo"));
    });
});


test("compound, update, and computed-literal window writes do not provide bindings", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": `
            window.foo += 1;
            window.bar++;
            ++window.baz;
            window["literal"] = 1;
            foo(); bar(); baz(); literal();
        `
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.explicitGlobalBindings, []);
        for (const name of ["foo", "bar", "baz", "literal"]) {
            assert.equal(getGlobal(world, name), undefined);
            assert(world.unresolvedGlobals.some(symbol => symbol.name === name));
        }
    });
});


test("sloppy simple assignment provides an implicit global in the same source", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function configure() { implicitName = 1; } implicitName();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );
        const implicitName = getGlobal(world, "implicitName");

        assert.deepEqual(sourceFacts.implicitGlobalCandidates, [{
            name: "implicitName",
            type: "ImplicitGlobalAssignment",
            sourceId: "app.js",
            operator: "=",
            line: 1,
            column: 23
        }]);
        assert.equal(implicitName.declarations[0].type, "ImplicitGlobalAssignment");
        assert.equal(implicitName.references.filter(reference => reference.write).length, 1);
        assert.equal(implicitName.references.filter(reference => reference.read).length, 1);
        assert(implicitName.references.every(reference => reference.resolution === "WORLD"));
    });
});


test("sloppy implicit global resolves across sources in the same world", async () => {
    await withFixture({
        "index.html": "<script src='provider.js'></script><script src='consumer.js'></script>",
        "provider.js": "crossSource = 1;",
        "consumer.js": "crossSource();"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const crossSource = getGlobal(world, "crossSource");

        assert.equal(crossSource.declarations[0].sourceId, "provider.js");
        assert(crossSource.references.some(reference =>
            reference.sourceId === "consumer.js" &&
            reference.resolution === "WORLD" &&
            reference.read
        ));
        assert.equal(world.unresolvedGlobals.some(symbol => symbol.name === "crossSource"), false);
    });
});


test("strict program simple assignment does not provide an implicit global", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "'use strict'; strictProgramName = 1;"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.implicitGlobalCandidates, []);
        assert.equal(getGlobal(world, "strictProgramName"), undefined);
        assert(world.unresolvedGlobals.some(symbol => symbol.name === "strictProgramName"));
    });
});


test("strict function simple assignment does not provide an implicit global", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function strictFunction() { 'use strict'; strictFunctionName = 1; }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.implicitGlobalCandidates, []);
        assert.equal(getGlobal(world, "strictFunctionName"), undefined);
        assert(world.unresolvedGlobals.some(symbol => symbol.name === "strictFunctionName"));
    });
});


test("assignment to a local variable does not provide an implicit global", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "let topLevelName; topLevelName = 1; function configure() { var localName; localName = 1; }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.implicitGlobalCandidates, []);
        assert.equal(getGlobal(world, "localName"), undefined);
        assert.equal(world.unresolvedGlobals.some(symbol => symbol.name === "localName"), false);
        assert.equal(getGlobal(world, "topLevelName").declarations[0].type, "Variable");
    });
});


test("assignment to a parameter does not provide an implicit global", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function configure(parameterName) { parameterName = 1; }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.implicitGlobalCandidates, []);
        assert.equal(getGlobal(world, "parameterName"), undefined);
        assert.equal(world.unresolvedGlobals.some(symbol => symbol.name === "parameterName"), false);
    });
});


test("direct eval taint does not turn a declared local write into an implicit global", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "function configure() { var evalLocal; eval('dynamic'); evalLocal = 1; evalImplicit = 2; }"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(
            sourceFacts.implicitGlobalCandidates.map(item => item.name),
            ["evalImplicit"]
        );
        assert.equal(getGlobal(world, "evalLocal"), undefined);
        assert(getGlobal(world, "evalImplicit"));
    });
});


test("an existing declaration wins over a cross-source implicit assignment", async () => {
    await withFixture({
        "index.html": "<script src='writer.js'></script><script src='declaration.js'></script>",
        "writer.js": "declaredName = 1;",
        "declaration.js": "var declaredName;"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const declaredName = getGlobal(world, "declaredName");

        assert.equal(declaredName.declarations.length, 1);
        assert.equal(declaredName.declarations[0].type, "Variable");
        assert.equal(declaredName.multipleDeclarations, false);
        assert(declaredName.references.some(reference =>
            reference.sourceId === "writer.js" &&
            reference.resolution === "WORLD" &&
            reference.write
        ));
    });
});


test("implicit assignment binding does not cross entry worlds", async () => {
    await withFixture({
        "provider.html": "<script>isolatedName = 1;</script>",
        "consumer.html": "<script>isolatedName();</script>"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["provider.html", "consumer.html"]
        });
        const provider = getWorld(result, "provider.html");
        const consumer = getWorld(result, "consumer.html");

        assert(getGlobal(provider, "isolatedName"));
        assert.equal(getGlobal(consumer, "isolatedName"), undefined);
        assert(consumer.unresolvedGlobals.some(symbol => symbol.name === "isolatedName"));
    });
});


test("implicit assignment binding does not cross iframe boundaries", async () => {
    await withFixture({
        "index.html": "<script>frameName = 1;</script><iframe src='child.html'></iframe>",
        "child.html": "<script>frameName();</script>"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const parent = getWorld(result, "index.html");
        const child = result.symbolAnalysis.worlds.find(world =>
            world.document === "child.html"
        );

        assert(getGlobal(parent, "frameName"));
        assert.equal(getGlobal(child, "frameName"), undefined);
        assert(child.unresolvedGlobals.some(symbol => symbol.name === "frameName"));
    });
});


test("compound and logical assignments do not provide implicit globals", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "compoundName += 1; logicalName &&= 1;"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.implicitGlobalCandidates, []);
        for (const name of ["compoundName", "logicalName"]) {
            assert.equal(getGlobal(world, name), undefined);
            assert(world.unresolvedGlobals.some(symbol => symbol.name === name));
        }
    });
});


test("update expressions do not provide implicit globals", async () => {
    await withFixture({
        "index.html": "<script src='app.js'></script>",
        "app.js": "updateName++; ++prefixUpdateName;"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const sourceFacts = result.symbolAnalysis.sourceFacts.find(source =>
            source.sourceId === "app.js"
        );

        assert.deepEqual(sourceFacts.implicitGlobalCandidates, []);
        for (const name of ["updateName", "prefixUpdateName"]) {
            assert.equal(getGlobal(world, name), undefined);
            assert(world.unresolvedGlobals.some(symbol => symbol.name === name));
        }
    });
});


test("repeated implicit assignments create one declaration and multiple writes", async () => {
    await withFixture({
        "index.html": "<script src='one.js'></script><script src='two.js'></script>",
        "one.js": "repeatedName = 1;",
        "two.js": "repeatedName = 2;"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["index.html"]
        });
        const world = getWorld(result, "index.html");
        const repeatedName = getGlobal(world, "repeatedName");

        assert.equal(repeatedName.declarations.length, 1);
        assert.equal(repeatedName.declarations[0].type, "ImplicitGlobalAssignment");
        assert.equal(repeatedName.multipleDeclarations, false);
        assert.equal(repeatedName.writes, 2);
        assert.deepEqual(
            repeatedName.references.map(reference => reference.sourceId),
            ["one.js", "two.js"]
        );
    });
});

test("classifies platform, library, and unknown globals", () => {
    const world = {
        sources: [
            {
                sourceId: "js/jquery-1.5.1.min.js",
                filePath: "js/jquery-1.5.1.min.js"
            },
            {
                sourceId: "js/app.js",
                filePath: "js/app.js"
            }
        ],

        unresolvedGlobals: [
            {
                name: "window",
                references: []
            },
            {
                name: "document",
                references: []
            },
            {
                name: "$",
                references: []
            },
            {
                name: "missingApplicationGlobal",
                references: []
            }
        ]
    };

    const unresolvedBefore = structuredClone(world.unresolvedGlobals);
    const result = classifyWorldGlobals(world);

    assert.deepEqual(world.unresolvedGlobals, unresolvedBefore);

    assert.deepEqual(
        result.platformGlobals.map(symbol => symbol.name).sort(),
        ["document", "window"]
    );

    assert.deepEqual(
        result.libraryGlobals.map(symbol => symbol.name),
        ["$"]
    );

    assert.equal(
        result.libraryGlobals[0].provider.library,
        "jQuery"
    );

    assert.deepEqual(
        result.unknownGlobals.map(symbol => symbol.name),
        ["missingApplicationGlobal"]
    );
});

test("does not assume dollar means jQuery without provider evidence", () => {
    const world = {
        sources: [
            {
                sourceId: "js/app.js",
                filePath: "js/app.js"
            }
        ],

        unresolvedGlobals: [
            {
                name: "$",
                references: []
            }
        ]
    };

    const result = classifyWorldGlobals(world);

    assert.equal(result.libraryGlobals.length, 0);

    assert.deepEqual(
        result.unknownGlobals.map(symbol => symbol.name),
        ["$"]
    );
});

test("attaches classification per world without leaking jQuery provider evidence", async () => {
    await withFixture({
        "with-jquery.html": `
            <script src="js/jquery-1.5.1.min.js"></script>
            <script src="js/with-jquery.js"></script>
        `,
        "without-jquery.html": `
            <script src="js/without-jquery.js"></script>
        `,
        "js/jquery-1.5.1.min.js": "window.jQuery = function() {};",
        "js/with-jquery.js": "$(document).ready(callbackWithProvider);",
        "js/without-jquery.js": "$(document).ready(callbackWithoutProvider);"
    }, async directory => {
        const result = await analyzePackage(directory, {
            entryDocuments: ["with-jquery.html", "without-jquery.html"]
        });
        const withProvider = getWorld(result, "with-jquery.html");
        const withoutProvider = getWorld(result, "without-jquery.html");

        assert(withProvider.unresolvedGlobals.some(symbol =>
            symbol.name === "$"
        ));
        assert(withProvider.globalClassification.libraryGlobals.some(symbol =>
            symbol.name === "$" && symbol.provider.sourceId === "js/jquery-1.5.1.min.js"
        ));
        assert(withoutProvider.unresolvedGlobals.some(symbol =>
            symbol.name === "$"
        ));
        assert(withoutProvider.globalClassification.unknownGlobals.some(symbol =>
            symbol.name === "$"
        ));
        assert.equal(
            withoutProvider.globalClassification.libraryGlobals.some(symbol =>
                symbol.name === "$"
            ),
            false
        );

        for (const world of [withProvider, withoutProvider]) {
            const classification = world.globalClassification;
            const classifiedCount =
                classification.platformGlobals.length +
                classification.libraryGlobals.length +
                classification.unknownGlobals.length;

            assert.equal(classifiedCount, world.unresolvedGlobals.length);
            assert(world.unresolvedGlobals.every(symbol =>
                !("classification" in symbol) && !("provider" in symbol)
            ));
        }
    });
});
