import fs from "node:fs/promises";
import path from "node:path";
import { buildSymbolFacts } from "./symbol_facts.mjs";
import { buildWorldSymbolFacts } from "./world_symbols.mjs";
import { classifyWorldGlobals } from "./global_classifier.mjs";


function collectInlineSources(htmlFacts) {
    const sources = new Map();
    const collisions = new Set();

    function add(sourceId, source) {
        if (sources.has(sourceId)) {
            collisions.add(sourceId);
            return;
        }

        sources.set(sourceId, source);
    }

    for (const html of htmlFacts) {
        for (const inlineScript of html.inlineScripts) {
            add(inlineScript.sourceId, {
                code: inlineScript.code,
                sourceType: "INLINE_SCRIPT",
                filePath: null,
                lineOffset: Math.max(0, (inlineScript.line ?? 1) - 1),
                functionBody: false
            });
        }

        for (const handler of html.inlineHandlers) {
            add(handler.sourceId, {
                code: handler.code,
                sourceType: "INLINE_HANDLER",
                filePath: null,
                lineOffset: Math.max(0, (handler.line ?? 1) - 1),
                functionBody: true
            });
        }
    }

    return { sources, collisions };
}


function groupWorldSources(world) {
    const bySourceId = new Map();

    for (const load of world.scriptLoads) {
        let source = bySourceId.get(load.sourceId);

        if (!source) {
            source = {
                sourceId: load.sourceId,
                filePath: load.filePath,
                kinds: [],
                loads: []
            };
            bySourceId.set(load.sourceId, source);
        }

        if (!source.kinds.includes(load.kind)) {
            source.kinds.push(load.kind);
        }

        source.loads.push({ ...load });
    }

    return [...bySourceId.values()];
}


function unavailableSourceFacts(sourceId, error) {
    return {
        sourceId,
        parseError: error,
        scopes: [],
        globalThrough: [],
        explicitGlobalBindings: [],
        implicitGlobalCandidates: [],
        globalObjectReferences: []
    };
}


async function buildSourceFacts(
    wwwDirectory,
    source,
    inlineSources,
    inlineCollisions
) {
    if (inlineCollisions.has(source.sourceId)) {
        return {
            sourceId: source.sourceId,
            sourceType: source.kinds[0] ?? "UNKNOWN",
            filePath: source.filePath,
            ...unavailableSourceFacts(
                source.sourceId,
                `AMBIGUOUS_SOURCE_ID: ${source.sourceId}`
            )
        };
    }

    let code;
    let sourceType;
    let filePath = source.filePath;
    let lineOffset = 0;
    let functionBody = false;

    if (filePath) {
        sourceType = source.kinds.includes("DYNAMIC_SCRIPT_IMPORT")
            ? "EXTERNAL_SCRIPT"
            : source.kinds[0] ?? "EXTERNAL_SCRIPT";

        try {
            code = await fs.readFile(
                path.join(wwwDirectory, ...filePath.split("/")),
                "utf8"
            );
        } catch (error) {
            return {
                sourceId: source.sourceId,
                sourceType,
                filePath,
                ...unavailableSourceFacts(
                    source.sourceId,
                    `SOURCE_READ_ERROR: ${error.message}`
                )
            };
        }
    } else {
        const inline = inlineSources.get(source.sourceId);

        if (!inline) {
            return {
                sourceId: source.sourceId,
                sourceType: source.kinds[0] ?? "UNKNOWN",
                filePath: null,
                ...unavailableSourceFacts(
                    source.sourceId,
                    `SOURCE_TEXT_NOT_FOUND: ${source.sourceId}`
                )
            };
        }

        ({
            code,
            sourceType,
            filePath,
            lineOffset,
            functionBody
        } = inline);
    }

    return {
        sourceType,
        filePath,
        ...buildSymbolFacts(code, source.sourceId, {
            allowReturnOutsideFunction: functionBody,
            functionBody,
            lineOffset
        })
    };
}


export async function buildWorldSymbolAnalysis({
    wwwDirectory,
    worldResolution,
    htmlFacts,
    libraryGlobals
}) {
    const { sources: inlineSources, collisions: inlineCollisions } =
        collectInlineSources(htmlFacts);
    const worldSources = new Map();
    const sourceDescriptors = new Map();

    for (const world of worldResolution.worlds) {
        const sources = groupWorldSources(world);
        worldSources.set(world.id, sources);

        for (const source of sources) {
            if (!sourceDescriptors.has(source.sourceId)) {
                sourceDescriptors.set(source.sourceId, source);
            }
        }
    }

    const sourceFacts = [];

    for (const source of sourceDescriptors.values()) {
        sourceFacts.push(await buildSourceFacts(
            wwwDirectory,
            source,
            inlineSources,
            inlineCollisions
        ));
    }

    const sourceFactsById = new Map(
        sourceFacts.map(facts => [facts.sourceId, facts])
    );
    const worlds = worldResolution.worlds.map(world => {
        const sources = worldSources.get(world.id) ?? [];
        const sourceIds = sources.map(source => source.sourceId);
        const facts = sourceIds
            .map(sourceId => sourceFactsById.get(sourceId))
            .filter(Boolean);
        const worldFacts = buildWorldSymbolFacts(
            world.id,
            sourceIds,
            facts
        );

        const symbolWorld = {
            worldId: world.id,
            document: world.document,
            kind: world.kind,
            parentWorldId: world.parentWorldId,
            sources,
            globals: worldFacts.globals,
            unresolvedGlobals: worldFacts.unresolvedGlobals,
            parseErrors: worldFacts.parseErrors,
            localScopeCount: facts.reduce((count, source) =>
                count + source.scopes.filter(scope => scope.type !== "global").length,
            0)
        };

        return {
            ...symbolWorld,
            globalClassification: classifyWorldGlobals(symbolWorld, {
                libraryGlobals
            })
        };
    });

    return {
        sourceFacts,
        worlds
    };
}
