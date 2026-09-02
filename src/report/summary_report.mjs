import { countBy } from "./report_format.mjs";
import { renderLmParamSummary } from "./lm_param_report.mjs";
import { orderSymbolCandidatesForReport } from "./symbol_report.mjs";


export function renderPackageSummary(result, context) {
    const typeCounts = countBy(result.inventory, file => file.type);

    return [
        context.heading("PACKAGE"),
        `  ${result.inventory.length} files`,
        `  ${result.worldResolution.worlds.length} browser worlds`,
        `  ${typeCounts.map(([type, count]) => `${type} ${count}`).join(" · ")}`
    ];
}


export function renderCleanupSummary(result, context) {
    const fileCounts = Object.fromEntries(
        ["HIGH", "MEDIUM"].map(confidence => [
            confidence,
            result.fileReport.candidates.filter(candidate =>
                candidate.confidence === confidence
            ).length
        ])
    );
    const symbolCounts = result.symbolCandidates.countsByConfidence;

    return [
        context.heading("CLEANUP SUMMARY"),
        "  Files",
        `    HIGH ${fileCounts.HIGH}`,
        `    MEDIUM ${fileCounts.MEDIUM}`,
        "  Symbols",
        `    HIGH ${symbolCounts.HIGH}`,
        `    MEDIUM ${symbolCounts.MEDIUM}`,
        `    LOW ${symbolCounts.LOW}`,
        ...renderLmParamSummary(result)
    ];
}


export function renderTopFileCandidates(result, context, limit = 10) {
    const lines = [context.heading("TOP FILE CANDIDATES")];
    const candidates = result.fileReport.candidates.slice(0, limit);

    if (candidates.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const candidate of candidates) {
        lines.push(
            `  ${context.status(candidate.confidence, candidate.confidence)}` +
            ` ${candidate.path} (${candidate.type})`
        );
    }

    return lines;
}


export function renderTopSymbolCandidates(result, context, limit = 10) {
    const lines = [context.heading("TOP SYMBOL CANDIDATES")];
    const candidates = orderSymbolCandidatesForReport(
        result.symbolCandidates.candidates.filter(candidate =>
            candidate.classification === "UNUSED_SYMBOL_CANDIDATE"
        )
    ).slice(0, limit);

    if (candidates.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const candidate of candidates) {
        lines.push(
            `  ${context.status(candidate.confidence, candidate.confidence)}` +
            ` ${context.target(candidate.name)} · ${candidate.binding}` +
            ` · ${candidate.sourceId}:${candidate.declarationLine ?? "?"}` +
            ` · worlds=${candidate.worldIds?.join(",") ?? candidate.worldId}`
        );
    }

    return lines;
}


export function renderAnalysisHealth(result, context) {
    const parseErrors = result.symbolAnalysis.worlds.reduce(
        (count, world) => count + world.parseErrors.length,
        0
    );
    const unknownGlobals = result.symbolAnalysis.worlds.reduce(
        (count, world) =>
            count + world.globalClassification.unknownGlobals.length,
        0
    );
    const dynamicRiskCandidates = result.symbolCandidates.candidates.filter(
        candidate => (candidate.riskFlags ?? []).some(risk =>
            risk.includes("DYNAMIC") || risk.includes("RUNTIME")
        )
    ).length;

    return [
        context.heading("ANALYSIS HEALTH"),
        `  parse errors: ${parseErrors}`,
        `  partial references: ${result.fileReport.partialReferences.length}`,
        `  unresolved references: ${result.fileReport.unresolvedReferences.length}`,
        `  referenced but not packaged: ${result.fileReport.referencedButNotPackaged.length}`,
        `  unknown globals: ${unknownGlobals}`,
        `  dynamic-risk candidates: ${dynamicRiskCandidates}`,
        `  symbol coverage gaps: ${result.symbolCandidates.coverageGaps?.length ?? 0}`,
        `  vendor internals outside queue: ${result.symbolCandidates.vendorExcludedCount ?? 0}`,
        `  generic LM_PARAM runtime-code sites: ${result.lmParamAnalysis?.counts?.genericRuntimeCodeSites ?? 0}`
    ];
}
