import { countBy } from "./report_format.mjs";


export function renderWorldDetails(result, context) {
    const lines = [context.heading("WORLD DETAILS")];

    for (const world of result.worldResolution.worlds) {
        lines.push(`  ${context.colors.bold(world.id)} document=${world.document} kind=${world.kind}`);
        if (world.parentWorldId) {
            lines.push(`    parent=${world.parentWorldId}`);
        }
        for (const member of world.htmlMembers) {
            lines.push(`    HTML ${member.role} ${member.path} base=${member.runtimeBase}`);
        }
        for (const load of world.scriptLoads) {
            lines.push(
                `    JS ${load.kind} ${load.sourceId}` +
                ` scope=${load.orderScope}` +
                ` order=${load.localOrder ?? "event/async"}`
            );
        }
        for (const binding of world.literalBindings) {
            lines.push(
                `    BIND ${binding.name}=${JSON.stringify(binding.value)}` +
                ` source=${binding.source}`
            );
        }
    }

    return lines;
}


export function renderHtmlRoles(result, context) {
    const roles = result.worldResolution.htmlRoles;
    const lines = [
        context.heading("HTML ROLES"),
        `  ${countBy(roles, role => role.role)
            .map(([role, count]) => `${role} ${count}`)
            .join(" · ")}`
    ];

    for (const role of roles) {
        const contextual = role.ambiguous
            ? ` contextual=${role.roles.join(",")}`
            : "";
        lines.push(`  ${role.role} ${role.path}${contextual}`);
    }

    return lines;
}


export function renderResourceDiagnostics(result, context) {
    const references = result.fileReport.referencedButNotPackaged;
    const lines = [
        context.heading(`REFERENCED BUT NOT PACKAGED · ${references.length}`)
    ];

    if (references.length === 0) {
        lines.push("  none");
    }

    for (const reference of references) {
        const evidenceTypes = [...new Set(
            reference.evidence.map(item => item.evidenceType)
        )].join(",");
        lines.push(
            `  ${context.status("missing", reference.target)}` +
            ` · evidence ${reference.evidence.length}` +
            ` · ${evidenceTypes}`
        );
    }

    return lines;
}


export function renderReferenceDiagnostics(result, context) {
    const partial = result.fileReport.partialReferences;
    const unresolved = result.fileReport.unresolvedReferences;
    const lines = [
        context.heading(
            `REFERENCE DIAGNOSTICS · partial ${partial.length} · unresolved ${unresolved.length}`
        )
    ];

    for (const reference of [...partial, ...unresolved]) {
        const state = reference.urlResolutionState ?? "UNRESOLVED";
        lines.push(
            `  ${context.status(state, state)}` +
            ` ${reference.source}:${reference.line ?? "?"}` +
            ` api=${reference.api ?? reference.relation}` +
            ` raw=${JSON.stringify(reference.rawTarget)}` +
            ` reason=${reference.reason}`
        );
    }

    return lines;
}


export function renderCorpusDiagnostics(result, context) {
    const lines = [context.heading("CORPUS FINDINGS")];

    for (const source of result.corpusFacts) {
        lines.push(`  ${source.source} · ${source.evidenceType}`);
        for (const reference of source.references) {
            const first = reference.occurrences[0];
            const location = first.line !== null
                ? `line=${first.line}`
                : `offset=${first.offset}`;
            lines.push(
                `    ${reference.classification}` +
                ` raw=${JSON.stringify(reference.rawTarget)}` +
                ` target=${reference.target} ${location}`
            );
        }
    }

    if (result.corpusFacts.length === 0) {
        lines.push("  none");
    }

    return lines;
}


export function renderRawSymbolDiagnostics(result, context) {
    const lines = [context.heading("RAW SYMBOL DIAGNOSTICS")];

    for (const world of result.symbolAnalysis.worlds) {
        lines.push(`  ${context.colors.bold(world.worldId)}`);
        for (const symbol of world.globals) {
            lines.push(
                `    ${symbol.name}` +
                ` declarations=${symbol.declarations.length}` +
                ` reads=${symbol.reads}` +
                ` writes=${symbol.writes}` +
                ` references=${symbol.references.length}` +
                ` multiple=${symbol.multipleDeclarations}`
            );
            for (const declaration of symbol.declarations) {
                lines.push(
                    `      declaration=${declaration.sourceId}` +
                    `:${declaration.line ?? "?"}` +
                    ` type=${declaration.type}`
                );
            }
        }
        for (const unresolved of world.unresolvedGlobals) {
            lines.push(
                `    unresolved=${unresolved.name}` +
                ` reads=${unresolved.reads}` +
                ` writes=${unresolved.writes}` +
                ` references=${unresolved.references.length}`
            );
        }
        for (const error of world.parseErrors) {
            lines.push(
                `    parse-error source=${error.sourceId} error=${error.error}`
            );
        }
    }

    return lines;
}
