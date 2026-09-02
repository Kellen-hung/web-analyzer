import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzePackage } from "../src/analyzer.mjs";
import { inspectLmParamSource } from "../src/lm_params/lm_param_facts.mjs";


async function withFixture(files, callback) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "rx-web-lm-param-test-")
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


async function analyzeFixture(
    directory,
    {
        entryDocuments = ["index.html"],
        lmParamJsonPath = "../lm_params.json"
    } = {}
) {
    return analyzePackage(path.join(directory, "www"), {
        entryDocuments,
        lmParamJsonPath
    });
}


function json(fields) {
    return JSON.stringify(Object.fromEntries(fields.map(field => [field, "x"])));
}


function field(result, name) {
    return result.lmParamAnalysis.fields.find(item => item.field === name);
}


test("LM_PARAM.FOO read consumes FOO", async () => {
    await withFixture({
        "www/index.html": "<script src='app.js'></script>",
        "www/app.js": "use(LM_PARAM.FOO);",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(field(result, "FOO").classification, "FRONTEND_CONSUMED");
        assert.equal(field(result, "FOO").reads, 1);
    });
});


test("LM_PARAM bracket literal read consumes the static field", async () => {
    await withFixture({
        "www/index.html": "<script>use(LM_PARAM['FOO']);</script>",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(field(result, "FOO").reads, 1);
        assert.match(field(result, "FOO").consumers[0].accessForm, /BRACKET/);
    });
});


test("LM_PARAM field assignment is WRITE only", async () => {
    const facts = inspectLmParamSource("LM_PARAM.FOO = value;", "app.js");
    assert.equal(facts.accesses[0].accessMode, "WRITE");
});


test("compound LM_PARAM assignment is READ_WRITE and consumed", async () => {
    await withFixture({
        "www/index.html": "<script>LM_PARAM.FOO += 1;</script>",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(field(result, "FOO").readWrites, 1);
        assert.equal(field(result, "FOO").classification, "FRONTEND_CONSUMED");
    });
});


test("update LM_PARAM access is READ_WRITE and consumed", () => {
    const facts = inspectLmParamSource("++LM_PARAM.FOO;", "app.js");
    assert.equal(facts.accesses[0].accessMode, "READ_WRITE");
});


test("multiple reads aggregate into one field record", async () => {
    await withFixture({
        "www/index.html": "<script>use(LM_PARAM.FOO); use(LM_PARAM.FOO);</script>",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(result.lmParamAnalysis.fields.length, 1);
        assert.equal(field(result, "FOO").reads, 2);
    });
});


test("reads from multiple runtime JS sources aggregate", async () => {
    await withFixture({
        "www/index.html": "<script src='a.js'></script><script src='b.js'></script>",
        "www/a.js": "use(LM_PARAM.FOO);",
        "www/b.js": "use(LM_PARAM.FOO);",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(field(result, "FOO").reads, 2);
        assert.deepEqual(
            field(result, "FOO").consumers.map(item => item.sourceId),
            ["a.js", "b.js"]
        );
    });
});


test("AJAX fragment LM_PARAM read consumes the field package-wide", async () => {
    await withFixture({
        "www/index.html": "<script>$('#tabs').tabs({});</script><div id='tabs'><a href='fragment.html'>F</a></div>",
        "www/fragment.html": "<script>use(LM_PARAM.FOO);</script>",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(field(result, "FOO").classification, "FRONTEND_CONSUMED");
        assert.equal(field(result, "FOO").consumers[0].worldId, "index.html");
    });
});


test("iframe-only LM_PARAM read still consumes the backend field package-wide", async () => {
    await withFixture({
        "www/index.html": "<iframe src='child.html'></iframe>",
        "www/child.html": "<script>use(LM_PARAM.FOO);</script>",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        const consumer = field(result, "FOO").consumers[0];
        assert.equal(field(result, "FOO").classification, "FRONTEND_CONSUMED");
        assert.match(consumer.worldId, /iframe/);
    });
});


test("LM_PARAM reference in JS without world membership is not a live consumer", async () => {
    await withFixture({
        "www/index.html": "<p>No scripts</p>",
        "www/unloaded.js": "use(LM_PARAM.FOO);",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(
            field(result, "FOO").classification,
            "NO_FRONTEND_CONSUMER_CANDIDATE"
        );
        assert.equal(field(result, "FOO").reads, 0);
    });
});


test("LM_PARAM[field] records dynamic risk without guessing a field", () => {
    const facts = inspectLmParamSource("use(LM_PARAM[field]);", "app.js");
    assert.equal(facts.accesses.length, 0);
    assert.equal(facts.riskSites[0].type, "DYNAMIC_LM_PARAM_PROPERTY_ACCESS");
    assert.equal(facts.riskSites[0].propertyExpression, "field");
});


test("LM_PARAM[getName()] records dynamic risk", () => {
    const facts = inspectLmParamSource("use(LM_PARAM[getName()]);", "app.js");
    assert.equal(facts.accesses.length, 0);
    assert.equal(facts.riskSites[0].type, "DYNAMIC_LM_PARAM_PROPERTY_ACCESS");
});


test("unrelated object property is ignored", () => {
    const facts = inspectLmParamSource(
        "use(other.FOO); use(obj['FOO']); use(other.LM_PARAM.FOO);",
        "app.js"
    );
    assert.deepEqual(facts.accesses, []);
    assert.deepEqual(facts.riskSites, []);
});


test("LM_PARAM function parameter shadows the device global", () => {
    const facts = inspectLmParamSource(
        "function f(LM_PARAM) { return LM_PARAM.FOO; }",
        "app.js"
    );
    assert.deepEqual(facts.accesses, []);
});


test("static LM_PARAM destructuring consumes the top-level field", () => {
    const facts = inspectLmParamSource(
        "const { FOO, BAR: bar } = LM_PARAM;",
        "app.js"
    );
    assert.deepEqual(facts.accesses.map(item => item.field), ["FOO", "BAR"]);
    assert(facts.accesses.every(item => item.accessMode === "READ"));
    assert.deepEqual(facts.riskSites, []);
});


test("passing LM_PARAM as an argument records object escape risk", () => {
    const facts = inspectLmParamSource("consume(LM_PARAM);", "app.js");
    assert.equal(facts.riskSites[0].type, "LM_PARAM_OBJECT_ESCAPE");
});


test("Object.keys LM_PARAM records enumeration risk", () => {
    const facts = inspectLmParamSource("Object.keys(LM_PARAM);", "app.js");
    assert.equal(facts.riskSites[0].type, "LM_PARAM_ENUMERATION");
});


test("JSON.stringify LM_PARAM records serialization risk", () => {
    const facts = inspectLmParamSource("JSON.stringify(LM_PARAM);", "app.js");
    assert.equal(facts.riskSites[0].type, "LM_PARAM_SERIALIZATION");
});


test("JSON field with no reads remains a visible cleanup candidate", async () => {
    await withFixture({
        "www/index.html": "<p>No scripts</p>",
        "lm_params.json": json(["UNUSED"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        const candidate = field(result, "UNUSED");
        assert.equal(candidate.classification, "NO_FRONTEND_CONSUMER_CANDIDATE");
        assert.equal(candidate.confidence, "HIGH");
    });
});


test("write-only JSON field remains visible with write-only risk", async () => {
    await withFixture({
        "www/index.html": "<script>LM_PARAM.FOO = value;</script>",
        "lm_params.json": json(["FOO"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        const candidate = field(result, "FOO");
        assert.equal(candidate.classification, "NO_FRONTEND_CONSUMER_CANDIDATE");
        assert.equal(candidate.confidence, "MEDIUM");
        assert(candidate.riskFlags.includes("WRITE_ONLY_FRONTEND_ACCESS"));
    });
});


test("frontend read absent from JSON is a consistency finding", async () => {
    await withFixture({
        "www/index.html": "<script>use(LM_PARAM.MISSING);</script>",
        "lm_params.json": json(["PRESENT"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        const missing = field(result, "MISSING");
        assert.equal(missing.classification, "FRONTEND_FIELD_MISSING_FROM_JSON");
        assert.equal(result.lmParamAnalysis.frontendMissingFields.length, 1);
    });
});


test("dynamic LM_PARAM access lowers confidence without hiding zero-read fields", async () => {
    await withFixture({
        "www/index.html": "<script>use(LM_PARAM[field]);</script>",
        "lm_params.json": json(["A", "B", "C"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(result.lmParamAnalysis.candidates.length, 3);
        assert(result.lmParamAnalysis.candidates.every(item =>
            item.confidence === "MEDIUM" &&
            item.riskFlags.includes("DYNAMIC_LM_PARAM_PROPERTY_ACCESS")
        ));
    });
});


test("missing or malformed LM_PARAM JSON reports input error without crashing", async () => {
    await withFixture({
        "www/index.html": "<script>use(LM_PARAM.FOO);</script>",
        "bad.json": "{not-json"
    }, async directory => {
        const missing = await analyzeFixture(directory, {
            lmParamJsonPath: "../missing.json"
        });
        const malformed = await analyzeFixture(directory, {
            lmParamJsonPath: "../bad.json"
        });

        assert.equal(missing.lmParamAnalysis.candidates.length, 0);
        assert.equal(malformed.lmParamAnalysis.candidates.length, 0);
        assert.equal(missing.lmParamAnalysis.coverageErrors.length, 1);
        assert.equal(
            malformed.lmParamAnalysis.coverageErrors[0].type,
            "LM_PARAM_JSON_PARSE_ERROR"
        );
    });
});


test("static window LM_PARAM dot and bracket forms are recognized", () => {
    const facts = inspectLmParamSource(
        "use(window.LM_PARAM.FOO); use(window['LM_PARAM']['BAR']);",
        "app.js"
    );
    assert.deepEqual(facts.accesses.map(item => item.field), ["FOO", "BAR"]);
    assert(facts.accesses.every(item => item.accessMode === "READ"));
});


test("local variable named LM_PARAM prevents false global consumers", () => {
    const facts = inspectLmParamSource(
        "function f() { const LM_PARAM = other; return LM_PARAM.FOO; }",
        "app.js"
    );
    assert.deepEqual(facts.accesses, []);
});


test("static dynamic code containing LM_PARAM field is positive evidence", async () => {
    await withFixture({
        "www/index.html": "<script>setTimeout('consume(LM_PARAM.STATE)', 100);</script>",
        "lm_params.json": json(["STATE"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        const state = field(result, "STATE");

        assert.equal(state.classification, "FRONTEND_CONSUMED");
        assert.equal(state.consumers[0].dynamicCodeType, "STRING_SETTIMEOUT");
    });
});


test("unsupported destructuring remains visible as explicit risk", async () => {
    await withFixture({
        "www/index.html": "<script>const { ...rest } = LM_PARAM;</script>",
        "lm_params.json": json(["A"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        assert.equal(field(result, "A").confidence, "LOW");
        assert(field(result, "A").riskFlags.includes(
            "UNSUPPORTED_LM_PARAM_DESTRUCTURING"
        ));
    });
});


test("LM_PARAM existence guard is not misclassified as object escape", () => {
    const facts = inspectLmParamSource(
        "LM_PARAM || (LM_PARAM = {});",
        "app.js"
    );
    assert.deepEqual(facts.riskSites, []);
});


test("runtime source parse error reports coverage gap and prevents HIGH conclusions", async () => {
    await withFixture({
        "www/index.html": "<script src='broken.js'></script>",
        "www/broken.js": "function broken( {",
        "lm_params.json": json(["A"])
    }, async directory => {
        const result = await analyzeFixture(directory);
        const candidate = field(result, "A");

        assert.equal(result.lmParamAnalysis.coverageErrors.length, 1);
        assert.equal(candidate.confidence, "LOW");
        assert(candidate.riskFlags.includes("LM_PARAM_SOURCE_COVERAGE_GAP"));
    });
});


test("unrelated runtime eval stays diagnostic without downgrading every field", async () => {
    await withFixture({
        "www/index.html": "<script>eval(runtimeCode);</script>",
        "lm_params.json": json(["A", "B"])
    }, async directory => {
        const result = await analyzeFixture(directory);

        assert.equal(result.lmParamAnalysis.candidates.length, 2);
        assert(result.lmParamAnalysis.candidates.every(candidate =>
            candidate.confidence === "HIGH" &&
            !candidate.riskFlags.includes("RUNTIME_DYNAMIC_CODE")
        ));
        assert.equal(result.lmParamAnalysis.consumedFields.length, 0);
        assert.equal(result.lmParamAnalysis.counts.genericRuntimeCodeSites, 1);
        assert.equal(result.lmParamAnalysis.riskSites[0].type, "RUNTIME_DYNAMIC_CODE");
    });
});


test("Object.keys LM_PARAM lowers zero-read field confidence", async () => {
    await withFixture({
        "www/index.html": "<script>Object.keys(LM_PARAM);</script>",
        "lm_params.json": json(["A", "B"])
    }, async directory => {
        const result = await analyzeFixture(directory);

        assert(result.lmParamAnalysis.candidates.every(candidate =>
            candidate.confidence === "MEDIUM" &&
            candidate.riskFlags.includes("LM_PARAM_ENUMERATION")
        ));
        assert.equal(result.lmParamAnalysis.consumedFields.length, 0);
    });
});
