import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReport } from "../src/report/cli_report.mjs";


function candidate(overrides = {}) {
    return {
        classification: "UNUSED_SYMBOL_CANDIDATE",
        confidence: "HIGH",
        name: "unusedLocal",
        worldId: "index.html",
        binding: "LOCAL",
        scopeId: "app.js#scope:1",
        sourceId: "app.js",
        sourcePath: "app.js",
        declarationLine: 4,
        definitionKind: "FunctionDeclaration",
        definitionKinds: ["FunctionDeclaration"],
        declarationCount: 1,
        readCount: 0,
        writeCount: 0,
        referenceCount: 0,
        declarationSites: [{
            sourceId: "app.js",
            line: 4,
            type: "FunctionName"
        }],
        reason: "No observed references or consumers were found.",
        confidenceFactors: [],
        riskFlags: [],
        positiveUseEvidence: [],
        initializerSideEffectRisk: false,
        removalScope: "DECLARATION_REVIEW",
        ...overrides
    };
}


function makeResult() {
    const high = candidate();
    const medium = candidate({
        confidence: "MEDIUM",
        name: "writeOnly",
        declarationLine: 8,
        definitionKind: "VariableDeclarator",
        definitionKinds: ["VariableDeclarator"],
        writeCount: 1,
        referenceCount: 1,
        reason: "No observed reads; write evidence is preserved for human review.",
        confidenceFactors: ["WRITE_ONLY_SYMBOL"],
        riskFlags: ["WRITE_ONLY_SYMBOL"],
        removalScope: "BINDING_REVIEW"
    });
    const low = candidate({
        confidence: "LOW",
        name: "runtimeRiskCandidate",
        binding: "WORLD_GLOBAL",
        scopeId: null,
        declarationLine: 12,
        reason: "The binding remains visible with uncertainty recorded as risk.",
        riskFlags: ["RUNTIME_DYNAMIC_CODE_IN_SOURCE"],
        confidenceFactors: ["RUNTIME_DYNAMIC_CODE_IN_SOURCE"]
    });
    const worldSymbol = {
        name: "unusedLocal",
        declarations: [{
            sourceId: "app.js",
            line: 4,
            type: "FunctionName"
        }],
        references: [],
        reads: 0,
        writes: 0,
        multipleDeclarations: false
    };
    const unresolved = {
        name: "missingGlobal",
        references: [{ sourceId: "app.js" }],
        reads: 1,
        writes: 0
    };

    return {
        inventory: [
            { path: "index.html", type: "HTML" },
            { path: "app.js", type: "JS" }
        ],
        worldResolution: {
            worlds: [{
                id: "index.html",
                document: "index.html",
                kind: "ENTRY_DOCUMENT",
                parentWorldId: null,
                htmlMembers: [{
                    role: "ENTRY_DOCUMENT",
                    path: "index.html",
                    runtimeBase: "index.html"
                }],
                scriptLoads: [{
                    kind: "EXTERNAL_SCRIPT",
                    sourceId: "app.js",
                    orderScope: "ENTRY_DOCUMENT:index.html",
                    localOrder: 0
                }],
                literalBindings: [{
                    name: "API_PATH",
                    value: "/api/",
                    source: "app.js"
                }]
            }],
            htmlRoles: [{
                path: "index.html",
                role: "ENTRY_DOCUMENT",
                roles: ["ENTRY_DOCUMENT"],
                ambiguous: false
            }]
        },
        symbolAnalysis: {
            worlds: [{
                worldId: "index.html",
                kind: "ENTRY_DOCUMENT",
                sources: [{ sourceId: "app.js" }],
                globals: [worldSymbol],
                unresolvedGlobals: [unresolved],
                parseErrors: [],
                globalClassification: {
                    platformGlobals: [],
                    libraryGlobals: [],
                    unknownGlobals: [unresolved]
                }
            }]
        },
        symbolCandidates: {
            candidates: [high, medium, low],
            countsByConfidence: {
                HIGH: 1,
                MEDIUM: 1,
                LOW: 1
            },
            notRemovableObservations: [{
                classification: "NOT_REMOVABLE_OBSERVATION",
                reason: "PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD",
                evidenceType: "SHARED_SOURCE_USED_IN_OTHER_WORLD",
                name: "sharedUsed",
                worldId: "index.html",
                binding: "WORLD_GLOBAL",
                sourceId: "shared.js",
                declarationLine: 2,
                positiveUseEvidence: [{
                    worldId: "other.html",
                    readCount: 1,
                    referenceCount: 1
                }],
                unusedInWorldIds: ["index.html"],
                usedInWorldIds: ["other.html"]
            }],
            coverageGaps: [{
                classification: "COVERAGE_GAP",
                sourceId: "broken.js",
                worldIds: ["index.html"],
                reason: "Unexpected token"
            }],
            vendorExcludedCount: 2
        },
        fileReport: {
            candidates: [{
                confidence: "HIGH",
                path: "unused.js",
                type: "JS",
                note: "No incoming evidence; human review is required."
            }],
            partialReferences: [{
                source: "app.js",
                line: 30,
                api: "$.get",
                rawTarget: '"partial/" + runtimeName',
                reason: "RUNTIME_VALUE_AFFECTS_PATHNAME",
                urlResolutionState: "PARTIALLY_RESOLVED"
            }],
            unresolvedReferences: [{
                source: "app.js",
                line: 31,
                relation: "IMPORTS",
                rawTarget: "runtimeScript",
                reason: "PATHNAME_NOT_STATICALLY_KNOWN"
            }],
            referencedButNotPackaged: [{
                target: "missing.js",
                evidence: [{ evidenceType: "JS_AST_RESOURCE_REF" }]
            }]
        },
        corpusFacts: [{
            source: "firmware.bin",
            evidenceType: "BINARY_STRING_REF",
            references: [{
                classification: "PACKAGE_RESOURCE",
                rawTarget: "/index.html",
                target: "index.html",
                occurrences: [{ line: null, offset: 42 }]
            }]
        }]
    };
}


function withLmParamAnalysis(result = makeResult()) {
    const candidateField = {
        field: "UNUSED_FIELD",
        jsonPresent: true,
        reads: 0,
        writes: 1,
        readWrites: 0,
        consumers: [],
        accesses: [],
        classification: "NO_FRONTEND_CONSUMER_CANDIDATE",
        confidence: "MEDIUM",
        riskFlags: ["WRITE_ONLY_FRONTEND_ACCESS"],
        reason: "No backend-value read was observed; frontend access is write-only."
    };
    const consumedField = {
        field: "USED_FIELD",
        reads: 1,
        writes: 0,
        readWrites: 0
    };
    const missingField = {
        field: "MISSING_FIELD",
        reads: 1,
        consumers: [{
            worldId: "index.html",
            sourceId: "app.js",
            line: 20
        }]
    };

    return {
        ...result,
        lmParamAnalysis: {
            input: { configured: true, available: true, path: "lm.json" },
            fields: [candidateField, consumedField, missingField],
            candidates: [candidateField],
            consumedFields: [consumedField],
            frontendMissingFields: [missingField],
            runtimeAccesses: [{
                field: "USED_FIELD",
                accessMode: "READ",
                accessForm: "GLOBAL_IDENTIFIER_DOT",
                worldId: "index.html",
                sourceId: "app.js",
                line: 10
            }],
            riskSites: [{ type: "DYNAMIC_LM_PARAM_PROPERTY_ACCESS" }],
            coverageErrors: [],
            counts: {
                jsonFields: 2,
                staticallyFrontendReadFields: 2,
                frontendConsumed: 1,
                writeOnlyFields: 1,
                noConsumerCandidates: 1,
                frontendMissingFromJson: 1,
                dynamicAccessSites: 1,
                genericRuntimeCodeSites: 1,
                wholeObjectRiskSites: 0,
                byConfidence: { HIGH: 0, MEDIUM: 1, LOW: 0 }
            }
        }
    };
}


test("default report omits individual partial and unresolved references", () => {
    const output = renderCliReport(makeResult(), {
        root: "fixture/www"
    });

    assert.equal(output.includes('"partial/" + runtimeName'), false);
    assert.equal(output.includes("runtimeScript"), false);
    assert.equal(output.includes("REFERENCE DIAGNOSTICS"), false);
    assert.match(output, /partial references: 1/);
});


test("default report shows file and symbol cleanup counts", () => {
    const output = renderCliReport(makeResult(), {
        root: "fixture/www"
    });

    assert.match(output, /CLEANUP SUMMARY/);
    assert.match(output, /Symbols\s+HIGH 1\s+MEDIUM 1\s+LOW 1/);
    assert.match(output, /TOP FILE CANDIDATES/);
    assert.match(output, /TOP SYMBOL CANDIDATES/);
});


test("verbose report shows high and medium candidate evidence", () => {
    const output = renderCliReport(makeResult(), {
        root: "fixture/www",
        mode: "verbose"
    });

    assert.match(output, /HIGH unusedLocal · LOCAL/);
    assert.match(output, /source=app\.js:4/);
    assert.match(output, /MEDIUM writeOnly · LOCAL/);
    assert.match(output, /risk-flags=WRITE_ONLY_SYMBOL/);
    assert.match(output, /classification=UNUSED_SYMBOL_CANDIDATE/);
});


test("verbose report keeps low-confidence candidates in the main queue", () => {
    const output = renderCliReport(makeResult(), {
        root: "fixture/www",
        mode: "verbose"
    });

    assert.match(output, /LOW runtimeRiskCandidate · WORLD_GLOBAL/);
    assert.match(output, /SYMBOL CANDIDATE RISKS/);
    assert.match(output, /RUNTIME_DYNAMIC_CODE_IN_SOURCE\s+1/);
    assert.equal(output.includes("SUPPRESSED SYMBOLS"), false);
});


test("normal and verbose reports hide not-removable observations", () => {
    const result = makeResult();

    assert.equal(result.symbolCandidates.notRemovableObservations.length, 1);

    for (const mode of ["default", "verbose"]) {
        const output = renderCliReport(result, {
            root: "fixture/www",
            mode
        });

        assert.equal(
            output.includes("USED / NOT-REMOVABLE OBSERVATIONS"),
            false
        );
        assert.equal(output.includes("sharedUsed"), false);
        assert.equal(
            output.includes("used/not-removable observations:"),
            false
        );
    }
});


test("debug report exposes full not-removable observations", () => {
    const output = renderCliReport(makeResult(), {
        root: "fixture/www",
        mode: "debug"
    });

    assert.match(output, /USED \/ NOT-REMOVABLE OBSERVATIONS · 1/);
    assert.match(output, /sharedUsed/);
    assert.match(output, /PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD/);
    assert.match(output, /positive-use-evidence=other\.html:reads=1/);
    assert.equal(
        output.includes("used/not-removable observations:"),
        false
    );
    assert.match(output, /SYMBOL COVERAGE GAPS · 1/);
    assert.match(output, /broken\.js/);
});


test("debug report includes deep world, reference, corpus, and symbol details", () => {
    const output = renderCliReport(makeResult(), {
        root: "fixture/www",
        mode: "debug"
    });

    for (const heading of [
        "WORLD DETAILS",
        "HTML ROLES",
        "REFERENCE DIAGNOSTICS",
        "CORPUS FINDINGS",
        "RAW SYMBOL DIAGNOSTICS"
    ]) {
        assert(output.includes(heading), `${heading} should be present`);
    }
    assert.match(output, /runtimeScript/);
    assert.match(output, /firmware\.bin/);
});


test("NO_COLOR-compatible rendering contains no terminal escapes", () => {
    const plain = renderCliReport(makeResult(), {
        root: "fixture/www",
        mode: "verbose",
        colorEnabled: false
    });
    const colored = renderCliReport(makeResult(), {
        root: "fixture/www",
        mode: "verbose",
        colorEnabled: true
    });

    assert.equal(/\u001b\[[0-9;]*m/.test(plain), false);
    assert.equal(/\u001b\[[0-9;]*m/.test(colored), true);
    assert.match(colored, /\u001b\[32munusedLocal\u001b\[39m/);
    assert.equal(colored.includes("sharedUsed"), false);
    assert.match(plain, /HIGH unusedLocal · LOCAL/);
});


test("default report includes concise LM_PARAM counts", () => {
    const output = renderCliReport(withLmParamAnalysis(), {
        root: "fixture/www"
    });

    assert.match(output, /LM_PARAM\s+JSON fields\s+2/);
    assert.match(output, /statically-read fields\s+2/);
    assert.match(output, /frontend-consumed\s+1/);
    assert.match(output, /no-consumer candidates\s+1/);
    assert.match(output, /dynamic access sites\s+1/);
    assert.match(output, /generic runtime-code sites\s+1/);
    assert.match(output, /generic LM_PARAM runtime-code sites: 1/);
});


test("verbose report includes LM_PARAM candidate, missing, and risk sections", () => {
    const output = renderCliReport(withLmParamAnalysis(), {
        root: "fixture/www",
        mode: "verbose"
    });

    assert.match(output, /LM_PARAM CLEANUP CANDIDATES · 1/);
    assert.match(output, /MEDIUM UNUSED_FIELD/);
    assert.match(output, /risk=WRITE_ONLY_FRONTEND_ACCESS/);
    assert.match(output, /LM_PARAM FRONTEND-MISSING FIELDS · 1/);
    assert.match(output, /MISSING_FIELD/);
    assert.match(output, /DYNAMIC_LM_PARAM_PROPERTY_ACCESS\s+1/);
});


test("debug report includes detailed LM_PARAM access sites", () => {
    const output = renderCliReport(withLmParamAnalysis(), {
        root: "fixture/www",
        mode: "debug"
    });

    assert.match(output, /LM_PARAM ACCESS SITES · 1/);
    assert.match(output, /USED_FIELD · READ · index\.html · app\.js:10/);
});
