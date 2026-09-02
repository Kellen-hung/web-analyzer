const SUPPORTED_DEFINITION_KINDS = new Map([
    ["FunctionName", "FunctionDeclaration"],
    ["Variable", "VariableDeclarator"]
]);


const CONFIDENCE_ORDER = new Map([
    ["HIGH", 0],
    ["MEDIUM", 1],
    ["LOW", 2]
]);


const RUNTIME_DYNAMIC_TYPES = new Set([
    "EVAL",
    "NEW_FUNCTION",
    "STRING_SETTIMEOUT",
    "DOCUMENT_WRITE"
]);


const SCRIPT_LOAD_TYPES = new Set([
    "DYNAMIC_SCRIPT_LOAD",
    "CUSTOM_SCRIPT_LOADER"
]);


function getSourcePath(sourceId, sourceFactsById, worldSourcesById) {
    return sourceFactsById.get(sourceId)?.filePath ??
        worldSourcesById.get(sourceId)?.filePath ??
        null;
}


function getDefinitionKinds(declarations) {
    return [...new Set(
        declarations
            .map(declaration => SUPPORTED_DEFINITION_KINDS.get(declaration.type))
            .filter(Boolean)
    )];
}


function findOtherWorldUsage({ worldId, name, declarations, worlds }) {
    const declaringSources = new Set(
        declarations.map(declaration => declaration.sourceId)
    );
    const usages = [];

    for (const world of worlds) {
        if (world.worldId === worldId) {
            continue;
        }

        const symbol = world.globals.find(item =>
            item.name === name &&
            item.reads > 0 &&
            item.declarations.some(declaration =>
                declaringSources.has(declaration.sourceId)
            )
        );

        if (symbol) {
            usages.push({
                worldId: world.worldId,
                readCount: symbol.reads,
                referenceCount: symbol.references.length
            });
        }
    }

    return usages;
}


function findStaticDynamicUse({ name, binding, sourceIds, dynamicSites }) {
    return dynamicSites
        .filter(site =>
            (binding === "WORLD_GLOBAL" || sourceIds.has(site.source)) &&
            site.staticReferences?.some(reference =>
                reference.name === name && reference.read
            )
        )
        .map(site => ({
            type: "STATIC_DYNAMIC_CODE_REFERENCE",
            dynamicSiteType: site.type,
            worldId: site.worldId,
            sourceId: site.source,
            line: site.line ?? null
        }));
}


function physicalIdentity(record) {
    return [
        record.sourceId,
        record.declarationLine ?? "?",
        record.declarationColumn ?? "?",
        record.name,
        record.binding,
        record.declarationType ?? record.definitionKind ?? "?"
    ].join(":");
}


function uniqueByJson(items) {
    const seen = new Set();

    return items.filter(item => {
        const key = JSON.stringify(item);

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}


function aggregatePhysicalCandidates(candidates) {
    const byPhysicalDeclaration = new Map();

    for (const candidate of candidates) {
        const key = physicalIdentity(candidate);
        const existing = byPhysicalDeclaration.get(key);
        const worldEvidence = {
            worldId: candidate.worldId,
            readCount: candidate.readCount,
            writeCount: candidate.writeCount,
            referenceCount: candidate.referenceCount
        };

        if (!existing) {
            const worldIds = [...new Set(candidate.sharedSourceWorlds)].sort();

            byPhysicalDeclaration.set(key, {
                ...candidate,
                physicalDeclarationId: key,
                worldIds,
                worldEvidence: [worldEvidence]
            });
            continue;
        }

        existing.worldIds = [...new Set([
            ...existing.worldIds,
            ...candidate.sharedSourceWorlds
        ])].sort();
        existing.worldEvidence = uniqueByJson([
            ...existing.worldEvidence,
            worldEvidence
        ]).sort((left, right) => left.worldId.localeCompare(right.worldId));
        existing.riskFlags = [...new Set([
            ...existing.riskFlags,
            ...candidate.riskFlags
        ])];
        existing.confidenceFactors = existing.riskFlags;
        existing.confidence = getConfidence(existing.riskFlags);
    }

    return [...byPhysicalDeclaration.values()].map(candidate => ({
        ...candidate,
        worldId: candidate.worldIds[0] ?? candidate.worldId,
        sharedSourceWorlds: candidate.worldIds
    }));
}


function aggregatePhysicalObservations(observations) {
    const byPhysicalDeclaration = new Map();

    for (const observation of observations) {
        const key = `${physicalIdentity(observation)}:${observation.reason}`;
        const existing = byPhysicalDeclaration.get(key);

        if (!existing) {
            byPhysicalDeclaration.set(key, {
                ...observation,
                physicalDeclarationId: physicalIdentity(observation),
                unusedInWorldIds: [observation.worldId],
                usedInWorldIds: observation.positiveUseEvidence
                    .map(item => item.worldId)
                    .filter(Boolean)
            });
            continue;
        }

        existing.unusedInWorldIds.push(observation.worldId);
        existing.usedInWorldIds.push(
            ...observation.positiveUseEvidence
                .map(item => item.worldId)
                .filter(Boolean)
        );
        existing.positiveUseEvidence.push(
            ...observation.positiveUseEvidence
        );
    }

    return [...byPhysicalDeclaration.values()].map(observation => {
        const usedInWorldIds = [...new Set(observation.usedInWorldIds)].sort();
        const usedWorldSet = new Set(usedInWorldIds);

        return {
            ...observation,
            worldId: [...new Set(observation.unusedInWorldIds)]
                .sort()[0] ?? observation.worldId,
            unusedInWorldIds: [...new Set(observation.unusedInWorldIds)]
                .filter(worldId => !usedWorldSet.has(worldId))
                .sort(),
            usedInWorldIds,
            positiveUseEvidence: uniqueByJson(
                observation.positiveUseEvidence
            ),
            sharedSourceWorlds: [...new Set([
                ...observation.unusedInWorldIds,
                ...usedInWorldIds
            ])].sort()
        };
    });
}


function aggregateVendorExclusions(records) {
    return [...new Map(records.map(record => [
        physicalIdentity(record),
        {
            ...record,
            physicalDeclarationId: physicalIdentity(record)
        }
    ])).values()];
}


function buildRiskFlags({
    name,
    binding,
    declarations,
    primaryDeclaration,
    writes,
    dynamicSites
}) {
    const flags = [];
    const sourceIds = new Set([primaryDeclaration.sourceId]);
    const applicationSites = dynamicSites.filter(site =>
        site.vendor !== true &&
        (binding === "WORLD_GLOBAL" || sourceIds.has(site.source))
    );

    if (declarations.length > 1) {
        flags.push("MULTIPLE_DECLARATIONS");
    }

    if (writes > 0) {
        flags.push("WRITE_ONLY_SYMBOL");
    }

    if (primaryDeclaration.initializerSideEffectRisk) {
        flags.push("INITIALIZER_MAY_HAVE_SIDE_EFFECTS");
    }

    if (applicationSites.some(site =>
        sourceIds.has(site.source) &&
        site.enclosingFunctionNames?.includes(name)
    )) {
        flags.push("DYNAMIC_BEHAVIOR_IN_CANDIDATE_BODY");
    }

    if (applicationSites.some(site =>
        site.type === "DYNAMIC_WINDOW_PROPERTY"
    )) {
        flags.push("DYNAMIC_GLOBAL_PROPERTY_ACCESS");
    }

    if (applicationSites.some(site => SCRIPT_LOAD_TYPES.has(site.type))) {
        flags.push("DYNAMIC_SCRIPT_LOAD_PRESENT");
    }

    const ambiguousRuntimeSites = applicationSites.filter(site =>
        RUNTIME_DYNAMIC_TYPES.has(site.type) &&
        !Array.isArray(site.staticReferences)
    );

    if (ambiguousRuntimeSites.some(site => sourceIds.has(site.source))) {
        flags.push("RUNTIME_DYNAMIC_CODE_IN_SOURCE");
    } else if (
        binding === "WORLD_GLOBAL" &&
        ambiguousRuntimeSites.length > 0
    ) {
        flags.push("RUNTIME_DYNAMIC_CODE_IN_WORLD");
    }

    return [...new Set(flags)];
}


function getConfidence(riskFlags) {
    if (riskFlags.includes("RUNTIME_DYNAMIC_CODE_IN_SOURCE")) {
        return "LOW";
    }

    return riskFlags.length > 0 ? "MEDIUM" : "HIGH";
}


function buildCandidate({
    worldId,
    name,
    binding,
    scopeId,
    declarations,
    primaryDeclaration,
    reads,
    writes,
    references,
    sourceFactsById,
    worldSourcesById,
    dynamicSites,
    sharedSourceWorlds
}) {
    const ordinaryDeclarations = declarations.filter(declaration =>
        SUPPORTED_DEFINITION_KINDS.has(declaration.type)
    );

    if (ordinaryDeclarations.length === 0 || reads !== 0) {
        return null;
    }

    const primary = primaryDeclaration ?? ordinaryDeclarations[0];
    const definitionKinds = getDefinitionKinds(ordinaryDeclarations);
    const riskFlags = buildRiskFlags({
        name,
        binding,
        declarations: ordinaryDeclarations,
        primaryDeclaration: primary,
        writes,
        dynamicSites
    });
    const initializerSideEffectRisk =
        primary.initializerSideEffectRisk === true;
    const confidence = getConfidence(riskFlags);
    const declarationSites = declarations.map(declaration => ({
        sourceId: declaration.sourceId,
        line: declaration.line ?? null,
        column: declaration.column ?? null,
        type: declaration.type,
        initializerSideEffectRisk:
            declaration.initializerSideEffectRisk === true
    }));
    const reason = initializerSideEffectRisk
        ? "The binding has zero observed consumers; review the binding separately from its potentially effectful initializer statement."
        : writes > 0
            ? "The binding has zero observed consumers; write evidence is preserved for human review."
            : riskFlags.length > 0
                ? "The binding has zero observed consumers and remains visible with uncertainty recorded as risk."
                : "No observed references or consumers were found in the resolved binding scope.";

    return {
        classification: "UNUSED_SYMBOL_CANDIDATE",
        confidence,
        name,
        worldId,
        binding,
        bindingScope: binding,
        scopeId,
        sourceId: primary.sourceId,
        sourcePath: getSourcePath(
            primary.sourceId,
            sourceFactsById,
            worldSourcesById
        ),
        declarationLine: primary.line ?? null,
        declarationColumn: primary.column ?? null,
        declarationType: primary.type,
        definitionKind: definitionKinds.length === 1
            ? definitionKinds[0]
            : "Multiple",
        definitionKinds,
        declarationCount: declarations.length,
        readCount: reads,
        writeCount: writes,
        referenceCount: references.length,
        counts: {
            declarations: declarations.length,
            reads,
            writes,
            references: references.length
        },
        declarationSites,
        definitions: declarationSites,
        riskFlags,
        confidenceFactors: riskFlags,
        positiveUseEvidence: [],
        initializerSideEffectRisk,
        removalScope: initializerSideEffectRisk || writes > 0
            ? "BINDING_REVIEW"
            : "DECLARATION_REVIEW",
        sharedSourceWorlds,
        reason,
        reviewReason: reason
    };
}


function buildObservation({
    reason,
    worldId,
    name,
    binding,
    declarations,
    evidence,
    sourceFactsById,
    worldSourcesById
}) {
    const primary = declarations[0];

    return {
        classification: "NOT_REMOVABLE_OBSERVATION",
        reason,
        name,
        worldId,
        binding,
        sourceId: primary.sourceId,
        sourcePath: getSourcePath(
            primary.sourceId,
            sourceFactsById,
            worldSourcesById
        ),
        declarationLine: primary.line ?? null,
        declarationColumn: primary.column ?? null,
        declarationType: primary.type,
        evidenceType: reason ===
            "PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD"
            ? "SHARED_SOURCE_USED_IN_OTHER_WORLD"
            : reason,
        positiveUseEvidence: evidence,
        sharedSourceWorlds: reason ===
            "PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD"
            ? evidence.map(item => item.worldId)
            : []
    };
}


function sortByLocation(records) {
    return records.sort((left, right) =>
        left.worldId.localeCompare(right.worldId) ||
        left.sourceId.localeCompare(right.sourceId) ||
        (left.declarationLine ?? Number.MAX_SAFE_INTEGER) -
            (right.declarationLine ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name)
    );
}


function sortCandidates(candidates) {
    return candidates.sort((left, right) =>
        CONFIDENCE_ORDER.get(left.confidence) -
            CONFIDENCE_ORDER.get(right.confidence) ||
        left.worldId.localeCompare(right.worldId) ||
        left.sourceId.localeCompare(right.sourceId) ||
        (left.declarationLine ?? Number.MAX_SAFE_INTEGER) -
            (right.declarationLine ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name)
    );
}


export function buildSymbolCleanupCandidates({
    symbolAnalysis,
    worldResolution,
    jsFacts
}) {
    const sourceFactsById = new Map(
        symbolAnalysis.sourceFacts.map(source => [source.sourceId, source])
    );
    const vendorBySourceId = new Map(
        jsFacts.map(source => [source.source, source.vendor === true])
    );
    const candidates = [];
    const notRemovableObservations = [];
    const vendorExcluded = [];
    const coverageGaps = [];

    for (const source of symbolAnalysis.sourceFacts) {
        if (!source.parseError) {
            continue;
        }

        const worldIds = symbolAnalysis.worlds
            .filter(world => world.sources.some(item =>
                item.sourceId === source.sourceId
            ))
            .map(world => world.worldId);

        coverageGaps.push({
            classification: "COVERAGE_GAP",
            sourceId: source.sourceId,
            sourcePath: source.filePath ?? null,
            worldIds,
            reason: source.parseError
        });
    }

    function considerCandidate({
        world,
        worldSourcesById,
        dynamicSites,
        name,
        binding,
        scopeId,
        declarations,
        reads,
        writes,
        references
    }) {
        const ordinaryDeclarations = declarations.filter(declaration =>
            SUPPORTED_DEFINITION_KINDS.has(declaration.type)
        );

        if (ordinaryDeclarations.length === 0 || reads !== 0) {
            return;
        }

        for (const primaryDeclaration of ordinaryDeclarations) {
            if (vendorBySourceId.get(primaryDeclaration.sourceId) === true) {
                vendorExcluded.push({
                    classification: "VENDOR_INTERNAL_EXCLUDED",
                    name,
                    worldId: world.worldId,
                    binding,
                    sourceId: primaryDeclaration.sourceId,
                    declarationLine: primaryDeclaration.line ?? null,
                    declarationColumn: primaryDeclaration.column ?? null,
                    declarationType: primaryDeclaration.type,
                    reason: "VENDOR_SOURCE"
                });
                continue;
            }

            const sourceIds = new Set([primaryDeclaration.sourceId]);
            const sharedSourceWorlds = symbolAnalysis.worlds
                .filter(otherWorld => otherWorld.sources.some(source =>
                    sourceIds.has(source.sourceId)
                ))
                .map(otherWorld => otherWorld.worldId);
            const sharedSourceWorldSet = new Set(sharedSourceWorlds);
            const physicalDynamicSites =
                worldResolution.dynamicSites.filter(site =>
                    sharedSourceWorldSet.has(site.worldId)
                );
            const otherWorldUsage = binding === "WORLD_GLOBAL"
                ? findOtherWorldUsage({
                    worldId: world.worldId,
                    name,
                    declarations: [primaryDeclaration],
                    worlds: symbolAnalysis.worlds
                })
                : [];

            if (otherWorldUsage.length > 0) {
                notRemovableObservations.push(buildObservation({
                    reason: "PHYSICAL_DECLARATION_USED_IN_OTHER_WORLD",
                    worldId: world.worldId,
                    name,
                    binding,
                    declarations: [primaryDeclaration],
                    evidence: otherWorldUsage,
                    sourceFactsById,
                    worldSourcesById
                }));
                continue;
            }

            const staticDynamicUse = findStaticDynamicUse({
                name,
                binding,
                sourceIds,
                dynamicSites: physicalDynamicSites
            });

            if (staticDynamicUse.length > 0) {
                notRemovableObservations.push(buildObservation({
                    reason: "STATIC_DYNAMIC_CODE_REFERENCE",
                    worldId: world.worldId,
                    name,
                    binding,
                    declarations: [primaryDeclaration],
                    evidence: staticDynamicUse,
                    sourceFactsById,
                    worldSourcesById
                }));
                continue;
            }

            const candidate = buildCandidate({
                worldId: world.worldId,
                name,
                binding,
                scopeId,
                declarations,
                primaryDeclaration,
                reads,
                writes,
                references,
                sourceFactsById,
                worldSourcesById,
                dynamicSites: physicalDynamicSites,
                sharedSourceWorlds
            });

            if (candidate) {
                candidates.push(candidate);
            }
        }
    }

    for (const world of symbolAnalysis.worlds) {
        const worldSourcesById = new Map(
            world.sources.map(source => [source.sourceId, source])
        );
        const dynamicSites = worldResolution.dynamicSites.filter(site =>
            site.worldId === world.worldId
        );

        for (const symbol of world.globals) {
            considerCandidate({
                world,
                worldSourcesById,
                dynamicSites,
                name: symbol.name,
                binding: "WORLD_GLOBAL",
                scopeId: null,
                declarations: symbol.declarations,
                reads: symbol.reads,
                writes: symbol.writes,
                references: symbol.references
            });
        }

        for (const source of world.sources) {
            const sourceFacts = sourceFactsById.get(source.sourceId);

            if (!sourceFacts || sourceFacts.parseError) {
                continue;
            }

            for (const scope of sourceFacts.scopes) {
                if (
                    (scope.type === "global" && scope.upperScopeId === null) ||
                    scope.type === "function-expression-name"
                ) {
                    continue;
                }

                for (const variable of scope.variables) {
                    considerCandidate({
                        world,
                        worldSourcesById,
                        dynamicSites,
                        name: variable.name,
                        binding: "LOCAL",
                        scopeId: scope.id,
                        declarations: variable.definitions.map(definition => ({
                            sourceId: source.sourceId,
                            ...definition
                        })),
                        reads: variable.reads,
                        writes: variable.writes,
                        references: variable.references
                    });
                }
            }
        }
    }

    const physicalCandidates = aggregatePhysicalCandidates(candidates);
    const physicalObservations = aggregatePhysicalObservations(
        notRemovableObservations
    );
    const physicalVendorExclusions = aggregateVendorExclusions(vendorExcluded);

    sortCandidates(physicalCandidates);
    sortByLocation(physicalObservations);
    sortByLocation(physicalVendorExclusions);

    return {
        candidates: physicalCandidates,
        countsByConfidence: Object.fromEntries(
            ["HIGH", "MEDIUM", "LOW"].map(confidence => [
                confidence,
                physicalCandidates.filter(candidate =>
                    candidate.confidence === confidence
                ).length
            ])
        ),
        notRemovableObservations: physicalObservations,
        coverageGaps,
        vendorExcludedCount: physicalVendorExclusions.length,
        vendorExcluded: physicalVendorExclusions
    };
}
