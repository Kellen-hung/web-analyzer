import { createReportContext, joinSections } from "./report_format.mjs";
import {
    renderAnalysisHealth,
    renderCleanupSummary,
    renderPackageSummary,
    renderTopFileCandidates,
    renderTopSymbolCandidates
} from "./summary_report.mjs";
import {
    renderCompactWorldSummary,
    renderCoverageGaps,
    renderNotRemovableObservations,
    renderSymbolCandidates,
    renderSymbolRiskSummary,
    renderUnknownGlobals
} from "./symbol_report.mjs";
import {
    renderCorpusDiagnostics,
    renderHtmlRoles,
    renderRawSymbolDiagnostics,
    renderReferenceDiagnostics,
    renderResourceDiagnostics,
    renderWorldDetails
} from "./diagnostic_report.mjs";
import {
    renderLmParamCandidates,
    renderLmParamConsumed,
    renderLmParamCoverageErrors,
    renderLmParamDebugAccesses,
    renderLmParamMissing,
    renderLmParamRisks
} from "./lm_param_report.mjs";


function renderFileCandidates(result, context) {
    const lines = [
        context.heading(`FILE CLEANUP CANDIDATES · ${result.fileReport.candidates.length}`)
    ];

    if (result.fileReport.candidates.length === 0) {
        lines.push("  none");
        return lines;
    }

    for (const candidate of result.fileReport.candidates) {
        lines.push(
            `  ${context.status(candidate.confidence, candidate.confidence)}` +
            ` ${candidate.path} (${candidate.type})`,
            `    reason=${candidate.note}`
        );
    }

    return lines;
}


export function normalizeReportMode(mode) {
    return mode === "debug" ? "debug" :
        mode === "verbose" ? "verbose" : "default";
}


export function buildIntegratedReport(
    result,
    {
        root,
        mode = "default",
        includeBanner = true
    } = {}
) {
    const context = createReportContext();
    const effectiveMode = normalizeReportMode(mode);
    const sections = [];

    if (includeBanner) {
        sections.push([
            context.colors.bold("Web Analyzer"),
            context.path(root ?? "")
        ]);
    }

    sections.push(
        renderPackageSummary(result, context),
        renderCleanupSummary(result, context)
    );

    if (effectiveMode === "default") {
        sections.push(
            renderTopFileCandidates(result, context),
            renderTopSymbolCandidates(result, context),
            renderAnalysisHealth(result, context),
            [
                "Use --verbose for candidate evidence.",
                "Use --debug for internal analysis details."
            ]
        );
    } else {
        sections.push(
            renderFileCandidates(result, context),
            renderSymbolCandidates(result, context),
            renderSymbolRiskSummary(result, context),
            ...(effectiveMode === "debug"
                ? [renderNotRemovableObservations(result, context)]
                : []),
            renderCoverageGaps(result, context),
            renderLmParamCandidates(result, context),
            renderLmParamConsumed(result, context),
            renderLmParamMissing(result, context),
            renderLmParamRisks(result, context),
            renderLmParamCoverageErrors(result, context),
            renderAnalysisHealth(result, context),
            renderCompactWorldSummary(result, context),
            renderUnknownGlobals(result, context)
        );
    }

    if (effectiveMode === "debug") {
        sections.push(
            renderWorldDetails(result, context),
            renderHtmlRoles(result, context),
            renderResourceDiagnostics(result, context),
            renderReferenceDiagnostics(result, context),
            renderCorpusDiagnostics(result, context),
            renderRawSymbolDiagnostics(result, context),
            renderLmParamDebugAccesses(result, context)
        );
    } else if (effectiveMode === "verbose") {
        sections.push(["Use --debug for internal world/reference/corpus details."]);
    }

    return `${joinSections(sections)}\n`;
}
