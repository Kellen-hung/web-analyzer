function analysisOrEmpty(result) {
    return result.lmParamAnalysis ?? {
        input: { configured: false, available: false, path: null },
        candidates: [],
        consumedFields: [],
        frontendMissingFields: [],
        runtimeAccesses: [],
        riskSites: [],
        coverageErrors: [],
        counts: {
            jsonFields: 0,
            staticallyFrontendReadFields: 0,
            frontendConsumed: 0,
            writeOnlyFields: 0,
            noConsumerCandidates: 0,
            frontendMissingFromJson: 0,
            dynamicAccessSites: 0,
            genericRuntimeCodeSites: 0,
            wholeObjectRiskSites: 0,
            byConfidence: { HIGH: 0, MEDIUM: 0, LOW: 0 }
        }
    };
}


export function renderLmParamSummary(result) {
    const analysis = analysisOrEmpty(result);
    const counts = analysis.counts;

    return [
        "  LM_PARAM",
        `    JSON fields                 ${counts.jsonFields}`,
        `    statically-read fields      ${counts.staticallyFrontendReadFields ?? counts.frontendConsumed}`,
        `    frontend-consumed           ${counts.frontendConsumed}`,
        `    no-consumer candidates      ${counts.noConsumerCandidates}`,
        `      HIGH ${counts.byConfidence.HIGH}`,
        `      MEDIUM ${counts.byConfidence.MEDIUM}`,
        `      LOW ${counts.byConfidence.LOW}`,
        `    frontend-missing-from-JSON  ${counts.frontendMissingFromJson}`,
        `    write-only fields           ${counts.writeOnlyFields}`,
        `    dynamic access sites        ${counts.dynamicAccessSites}`,
        `    generic runtime-code sites  ${counts.genericRuntimeCodeSites ?? 0}`,
        `    whole-object risk sites     ${counts.wholeObjectRiskSites}`,
        `    coverage errors             ${analysis.coverageErrors.length}`
    ];
}


export function renderLmParamCandidates(result, context) {
    const analysis = analysisOrEmpty(result);
    const lines = [
        context.heading(
            `LM_PARAM CLEANUP CANDIDATES · ${analysis.candidates.length}`
        )
    ];

    if (!analysis.input.available) {
        lines.push("  unavailable · see LM_PARAM COVERAGE ERRORS");
        return lines;
    }

    if (analysis.candidates.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const field of analysis.candidates) {
        lines.push(
            `  ${context.status(field.confidence, field.confidence)}` +
                ` ${context.target(field.field)}`,
            `    reads=${field.reads}` +
                ` writes=${field.writes}` +
                ` read-writes=${field.readWrites}`,
            `    reason=${field.reason}`
        );

        if (field.riskFlags.length > 0) {
            lines.push(`    risk=${field.riskFlags.join(",")}`);
        }
    }

    return lines;
}


export function renderLmParamConsumed(result, context) {
    const fields = analysisOrEmpty(result).consumedFields;
    const lines = [
        context.heading(`LM_PARAM CONSUMED FIELDS · ${fields.length}`)
    ];

    if (fields.length === 0) {
        lines.push("  none");
        return lines;
    }

    lines.push(`  ${fields.map(field => field.field).join(", ")}`);
    return lines;
}


export function renderLmParamMissing(result, context) {
    const fields = analysisOrEmpty(result).frontendMissingFields;
    const lines = [
        context.heading(`LM_PARAM FRONTEND-MISSING FIELDS · ${fields.length}`)
    ];

    if (fields.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const field of fields) {
        const consumers = field.consumers.map(consumer =>
            `${consumer.worldId}:${consumer.sourceId}:${consumer.line ?? "?"}`
        );
        lines.push(
            `  ${context.target(field.field)}`,
            `    reads=${field.reads} consumers=${consumers.join(",")}`
        );
    }

    return lines;
}


export function renderLmParamRisks(result, context) {
    const analysis = analysisOrEmpty(result);
    const counts = new Map();

    for (const site of analysis.riskSites) {
        counts.set(site.type, (counts.get(site.type) ?? 0) + 1);
    }

    const lines = [context.heading(`LM_PARAM RISKS · ${analysis.riskSites.length}`)];

    if (counts.size === 0) {
        lines.push("  none");
        return lines;
    }

    for (const [risk, count] of [...counts.entries()].sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0])
    )) {
        lines.push(`  ${risk.padEnd(42)} ${count}`);
    }

    return lines;
}


export function renderLmParamCoverageErrors(result, context) {
    const errors = analysisOrEmpty(result).coverageErrors;
    const lines = [context.heading(`LM_PARAM COVERAGE ERRORS · ${errors.length}`)];

    if (errors.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const error of errors) {
        lines.push(
            `  ${error.type}` +
                `${error.sourceId ? ` · ${error.sourceId}` : ""}`,
            `    ${error.message}`
        );
    }

    return lines;
}


export function renderLmParamDebugAccesses(result, context) {
    const analysis = analysisOrEmpty(result);
    const lines = [
        context.heading(
            `LM_PARAM ACCESS SITES · ${analysis.runtimeAccesses.length}`
        )
    ];

    if (analysis.runtimeAccesses.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const access of analysis.runtimeAccesses) {
        lines.push(
            `  ${context.target(access.field)} · ${access.accessMode}` +
                ` · ${access.worldId}` +
                ` · ${access.sourceId}:${access.line ?? "?"}` +
                ` · ${access.accessForm}`
        );
    }

    return lines;
}
