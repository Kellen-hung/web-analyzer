import fs from "node:fs/promises";
import path from "node:path";
import { inspectLmParamSource } from "./lm_param_facts.mjs";


const LOW_RISK_TYPES = new Set([
    "UNPARSEABLE_STATIC_DYNAMIC_CODE",
    "UNSUPPORTED_LM_PARAM_DESTRUCTURING",
    "LM_PARAM_SOURCE_COVERAGE_GAP"
]);


function countAccessModes(accesses) {
    return {
        reads: accesses.filter(item => item.accessMode === "READ").length,
        writes: accesses.filter(item => item.accessMode === "WRITE").length,
        readWrites: accesses.filter(item =>
            item.accessMode === "READ_WRITE"
        ).length
    };
}


function confidenceFor(riskFlags) {
    return riskFlags.some(risk => LOW_RISK_TYPES.has(risk))
        ? "LOW"
        : riskFlags.length > 0
            ? "MEDIUM"
            : "HIGH";
}


function buildInlineSourceMap(htmlFacts) {
    const sources = new Map();

    for (const html of htmlFacts) {
        for (const script of html.inlineScripts) {
            sources.set(script.sourceId, {
                sourceId: script.sourceId,
                code: script.code,
                filePath: null,
                lineOffset: Math.max(0, (script.line ?? 1) - 1),
                functionBody: false
            });
        }

        for (const handler of html.inlineHandlers) {
            sources.set(handler.sourceId, {
                sourceId: handler.sourceId,
                code: handler.code,
                filePath: null,
                lineOffset: Math.max(0, (handler.line ?? 1) - 1),
                functionBody: true
            });
        }
    }

    return sources;
}


async function loadJsonInput(wwwDirectory, lmParamJsonPath) {
    if (!lmParamJsonPath) {
        return {
            configured: false,
            available: false,
            path: null,
            data: null,
            error: {
                type: "LM_PARAM_INPUT_NOT_CONFIGURED",
                message: "Configure input.lmParamsJson to analyze backend fields."
            }
        };
    }

    const resolvedPath = path.isAbsolute(lmParamJsonPath)
        ? lmParamJsonPath
        : path.resolve(wwwDirectory, lmParamJsonPath);

    try {
        const source = await fs.readFile(resolvedPath, "utf8");
        const data = JSON.parse(source);

        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("LM_PARAM input must be a top-level JSON object.");
        }

        return {
            configured: true,
            available: true,
            path: resolvedPath,
            data,
            error: null
        };
    } catch (error) {
        return {
            configured: true,
            available: false,
            path: resolvedPath,
            data: null,
            error: {
                type: error instanceof SyntaxError
                    ? "LM_PARAM_JSON_PARSE_ERROR"
                    : "LM_PARAM_INPUT_ERROR",
                message: error.message
            }
        };
    }
}


async function loadSourceFacts({
    wwwDirectory,
    descriptor,
    sourceFactCache
}) {
    if (sourceFactCache.has(descriptor.sourceId)) {
        return sourceFactCache.get(descriptor.sourceId);
    }

    let code = descriptor.code;

    if (code === undefined) {
        try {
            code = await fs.readFile(
                path.join(
                    wwwDirectory,
                    ...descriptor.filePath.split("/")
                ),
                "utf8"
            );
        } catch (error) {
            const facts = {
                sourceId: descriptor.sourceId,
                parseError: `SOURCE_READ_ERROR: ${error.message}`,
                accesses: [],
                riskSites: []
            };
            sourceFactCache.set(descriptor.sourceId, facts);
            return facts;
        }
    }

    const facts = inspectLmParamSource(code, descriptor.sourceId, {
        allowReturnOutsideFunction: descriptor.functionBody,
        functionBody: descriptor.functionBody,
        lineOffset: descriptor.lineOffset ?? 0
    });
    sourceFactCache.set(descriptor.sourceId, facts);
    return facts;
}


async function collectRuntimeFacts({
    wwwDirectory,
    worldResolution,
    htmlFacts,
    jsFacts
}) {
    const inlineSources = buildInlineSourceMap(htmlFacts);
    const vendorBySource = new Map(
        jsFacts.map(fact => [fact.source, fact.vendor === true])
    );
    const sourceFactCache = new Map();
    const memberships = new Set();
    const accesses = [];
    const riskSites = [];
    const coverageErrors = [];

    for (const world of worldResolution.worlds) {
        for (const load of world.scriptLoads) {
            const membershipKey = `${world.id}:${load.sourceId}`;

            if (memberships.has(membershipKey)) {
                continue;
            }

            memberships.add(membershipKey);
            const inline = inlineSources.get(load.sourceId);
            const descriptor = inline ?? {
                sourceId: load.sourceId,
                filePath: load.filePath ?? load.sourceId,
                lineOffset: 0,
                functionBody: false
            };
            const facts = await loadSourceFacts({
                wwwDirectory,
                descriptor,
                sourceFactCache
            });

            if (facts.parseError) {
                coverageErrors.push({
                    type: "LM_PARAM_SOURCE_COVERAGE_GAP",
                    worldId: world.id,
                    sourceId: load.sourceId,
                    filePath: descriptor.filePath,
                    message: facts.parseError
                });
                continue;
            }

            for (const access of facts.accesses) {
                accesses.push({
                    ...access,
                    worldId: world.id,
                    filePath: descriptor.filePath
                });
            }

            for (const risk of facts.riskSites) {
                if (
                    risk.type === "RUNTIME_DYNAMIC_CODE" &&
                    vendorBySource.get(load.sourceId) === true
                ) {
                    continue;
                }

                riskSites.push({
                    ...risk,
                    worldId: world.id,
                    filePath: descriptor.filePath
                });
            }
        }
    }

    return {
        accesses,
        riskSites,
        coverageErrors
    };
}


function buildFieldRecord(field, jsonPresent, accesses, packageRiskFlags) {
    const counts = countAccessModes(accesses);
    const confirmedConsumed = counts.reads > 0 || counts.readWrites > 0;
    const writeOnly = !confirmedConsumed && counts.writes > 0;
    const riskFlags = confirmedConsumed
        ? []
        : [...new Set([
            ...packageRiskFlags,
            ...(writeOnly ? ["WRITE_ONLY_FRONTEND_ACCESS"] : [])
        ])];
    const classification = jsonPresent
        ? confirmedConsumed
            ? "FRONTEND_CONSUMED"
            : "NO_FRONTEND_CONSUMER_CANDIDATE"
        : confirmedConsumed
            ? "FRONTEND_FIELD_MISSING_FROM_JSON"
            : "FRONTEND_WRITE_MISSING_FROM_JSON";
    const confidence = classification ===
        "NO_FRONTEND_CONSUMER_CANDIDATE"
        ? confidenceFor(riskFlags)
        : null;

    return {
        field,
        jsonPresent,
        ...counts,
        consumers: accesses.filter(item =>
            item.accessMode === "READ" ||
            item.accessMode === "READ_WRITE"
        ),
        accesses,
        classification,
        confidence,
        riskFlags,
        reason: classification === "FRONTEND_CONSUMED"
            ? "At least one resolved frontend world has a confirmed field read."
            : classification === "FRONTEND_FIELD_MISSING_FROM_JSON"
                ? "Resolved frontend code reads a field absent from the captured JSON."
                : writeOnly
                    ? "No backend-value read was observed; frontend access is write-only."
                    : riskFlags.length > 0
                        ? "No static frontend read was observed; uncertainty is retained as risk."
                        : "No observed frontend consumer."
    };
}


export async function analyzeLmParams({
    wwwDirectory,
    lmParamJsonPath,
    worldResolution,
    htmlFacts,
    jsFacts
}) {
    const input = await loadJsonInput(wwwDirectory, lmParamJsonPath);
    const runtime = await collectRuntimeFacts({
        wwwDirectory,
        worldResolution,
        htmlFacts,
        jsFacts
    });
    const coverageErrors = [
        ...(input.error ? [input.error] : []),
        ...runtime.coverageErrors
    ];
    const packageRiskFlags = [...new Set([
        ...runtime.riskSites
            .filter(site => site.type !== "RUNTIME_DYNAMIC_CODE")
            .map(site => site.type),
        ...(runtime.coverageErrors.length > 0
            ? ["LM_PARAM_SOURCE_COVERAGE_GAP"]
            : [])
    ])];

    if (!input.available) {
        return {
            input: {
                configured: input.configured,
                available: false,
                path: input.path
            },
            fields: [],
            candidates: [],
            consumedFields: [],
            frontendMissingFields: [],
            runtimeAccesses: runtime.accesses,
            riskSites: runtime.riskSites,
            coverageErrors,
            counts: {
                jsonFields: 0,
                staticallyFrontendReadFields: 0,
                frontendConsumed: 0,
                writeOnlyFields: 0,
                noConsumerCandidates: 0,
                frontendMissingFromJson: 0,
                dynamicAccessSites: runtime.riskSites.filter(site =>
                    site.type === "DYNAMIC_LM_PARAM_PROPERTY_ACCESS"
                ).length,
                genericRuntimeCodeSites: runtime.riskSites.filter(site =>
                    site.type === "RUNTIME_DYNAMIC_CODE"
                ).length,
                wholeObjectRiskSites: runtime.riskSites.filter(site =>
                    [
                        "LM_PARAM_OBJECT_ESCAPE",
                        "LM_PARAM_ENUMERATION",
                        "LM_PARAM_SERIALIZATION"
                    ].includes(site.type)
                ).length,
                byConfidence: { HIGH: 0, MEDIUM: 0, LOW: 0 }
            }
        };
    }

    const jsonFields = Object.keys(input.data);
    const accessesByField = new Map();

    for (const access of runtime.accesses) {
        if (!accessesByField.has(access.field)) {
            accessesByField.set(access.field, []);
        }

        accessesByField.get(access.field).push(access);
    }

    const allFields = [...new Set([
        ...jsonFields,
        ...accessesByField.keys()
    ])];
    const jsonFieldSet = new Set(jsonFields);
    const fields = allFields.map(field => buildFieldRecord(
        field,
        jsonFieldSet.has(field),
        accessesByField.get(field) ?? [],
        packageRiskFlags
    ));
    const candidates = fields.filter(field =>
        field.classification === "NO_FRONTEND_CONSUMER_CANDIDATE"
    ).sort((left, right) =>
        ["HIGH", "MEDIUM", "LOW"].indexOf(left.confidence) -
            ["HIGH", "MEDIUM", "LOW"].indexOf(right.confidence) ||
        left.field.localeCompare(right.field)
    );
    const consumedFields = fields.filter(field =>
        field.classification === "FRONTEND_CONSUMED"
    ).sort((left, right) => left.field.localeCompare(right.field));
    const frontendMissingFields = fields.filter(field =>
        field.classification === "FRONTEND_FIELD_MISSING_FROM_JSON"
    ).sort((left, right) => left.field.localeCompare(right.field));
    const byConfidence = Object.fromEntries(
        ["HIGH", "MEDIUM", "LOW"].map(confidence => [
            confidence,
            candidates.filter(field => field.confidence === confidence).length
        ])
    );

    return {
        input: {
            configured: true,
            available: true,
            path: input.path
        },
        fields,
        candidates,
        consumedFields,
        frontendMissingFields,
        runtimeAccesses: runtime.accesses,
        riskSites: runtime.riskSites,
        coverageErrors,
        counts: {
            jsonFields: jsonFields.length,
            staticallyFrontendReadFields: fields.filter(field =>
                field.reads > 0 || field.readWrites > 0
            ).length,
            frontendConsumed: consumedFields.length,
            writeOnlyFields: fields.filter(field =>
                field.jsonPresent &&
                field.reads === 0 &&
                field.readWrites === 0 &&
                field.writes > 0
            ).length,
            noConsumerCandidates: candidates.length,
            frontendMissingFromJson: frontendMissingFields.length,
            dynamicAccessSites: runtime.riskSites.filter(site =>
                site.type === "DYNAMIC_LM_PARAM_PROPERTY_ACCESS"
            ).length,
            genericRuntimeCodeSites: runtime.riskSites.filter(site =>
                site.type === "RUNTIME_DYNAMIC_CODE"
            ).length,
            wholeObjectRiskSites: runtime.riskSites.filter(site =>
                [
                    "LM_PARAM_OBJECT_ESCAPE",
                    "LM_PARAM_ENUMERATION",
                    "LM_PARAM_SERIALIZATION"
                ].includes(site.type)
            ).length,
            byConfidence
        }
    };
}
