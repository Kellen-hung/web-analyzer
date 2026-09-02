function renderCandidateEvidence(candidate, context) {
    const lines = [
        `  ${context.status(candidate.confidence, candidate.confidence)}` +
            ` ${context.target(candidate.name)} · ${candidate.binding}`,
        `    worlds=${candidate.worldIds?.join(",") ?? candidate.worldId}`,
        `    source=${candidate.sourceId}:${candidate.declarationLine ?? "?"}`,
        `    definition=${candidate.definitionKind}`,
        `    declarations=${candidate.declarationCount}` +
            ` reads=${candidate.readCount}` +
            ` writes=${candidate.writeCount}` +
            ` references=${candidate.referenceCount}`,
        `    classification=${candidate.classification}` +
            ` confidence=${candidate.confidence}`,
        `    removal-scope=${candidate.removalScope}`,
        `    reason=${candidate.reason}`
    ];

    if ((candidate.riskFlags ?? []).length > 0) {
        lines.push(`    risk-flags=${candidate.riskFlags.join(",")}`);
    }

    return lines;
}


export function renderSymbolCandidates(result, context) {
    const candidates = result.symbolCandidates.candidates;
    const lines = [
        context.heading(`SYMBOL CLEANUP CANDIDATES · ${candidates.length}`)
    ];

    if (candidates.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const candidate of candidates) {
        lines.push(...renderCandidateEvidence(candidate, context));
    }

    return lines;
}


export function renderSymbolRiskSummary(result, context) {
    const riskCounts = new Map();

    for (const candidate of result.symbolCandidates.candidates) {
        for (const risk of candidate.riskFlags ?? []) {
            riskCounts.set(risk, (riskCounts.get(risk) ?? 0) + 1);
        }
    }

    const lines = [context.heading("SYMBOL CANDIDATE RISKS")];

    if (riskCounts.size === 0) {
        lines.push("  none");
        return lines;
    }

    for (const [risk, count] of [...riskCounts.entries()].sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0])
    )) {
        lines.push(`  ${risk.padEnd(42)} ${count}`);
    }

    return lines;
}


export function renderNotRemovableObservations(result, context) {
    const observations =
        result.symbolCandidates.notRemovableObservations ?? [];
    const lines = [
        context.heading(`USED / NOT-REMOVABLE OBSERVATIONS · ${observations.length}`)
    ];

    if (observations.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const observation of observations) {
        const evidence = observation.reason ===
            "PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD"
            ? observation.positiveUseEvidence
                .map(item => `${item.worldId}:reads=${item.readCount}`)
                .join(",")
            : observation.positiveUseEvidence
                .map(item => `${item.dynamicSiteType}@${item.sourceId}:${item.line ?? "?"}`)
                .join(",");

        lines.push(
            `  ${context.target(observation.name)} · ${observation.binding}` +
                ` · ${observation.sourceId}:${observation.declarationLine ?? "?"}`,
            `    reason=${observation.reason}`,
            `    unused-in=${observation.unusedInWorldIds?.join(",") || "none"}`,
            `    used-in=${observation.usedInWorldIds?.join(",") || "none"}`,
            `    positive-use-evidence=${evidence}`
        );
    }

    return lines;
}


export function renderCoverageGaps(result, context) {
    const gaps = result.symbolCandidates.coverageGaps ?? [];
    const lines = [context.heading(`SYMBOL COVERAGE GAPS · ${gaps.length}`)];

    if (gaps.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const gap of gaps) {
        lines.push(
            `  ${gap.sourceId} · worlds=${gap.worldIds.join(",") || "none"}`,
            `    reason=${gap.reason}`
        );
    }

    return lines;
}


export function renderCompactWorldSummary(result, context) {
    const lines = [context.heading(`BROWSER WORLDS · ${result.symbolAnalysis.worlds.length}`)];

    for (const world of result.symbolAnalysis.worlds) {
        lines.push(
            `  ${context.colors.bold(world.worldId)}` +
            ` · ${world.kind}` +
            ` · sources ${world.sources.length}` +
            ` · globals ${world.globals.length}` +
            ` · unresolved ${world.unresolvedGlobals.length}` +
            ` · parse-errors ${world.parseErrors.length}`
        );
    }

    return lines;
}


export function renderUnknownGlobals(result, context) {
    const lines = [context.heading("UNKNOWN GLOBALS")];

    for (const world of result.symbolAnalysis.worlds) {
        const names = world.globalClassification.unknownGlobals.map(symbol =>
            symbol.name
        );
        lines.push(
            `  ${context.colors.bold(world.worldId)} (${names.length})` +
            ` ${names.join(", ") || "none"}`
        );
    }

    return lines;
}
