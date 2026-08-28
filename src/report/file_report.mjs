import { resolveWebTarget } from "../resolution/resource_utils.mjs";


const EXTERNAL_RUNTIME_TYPES = new Set([
    "ELF",
    "SHELL",
    "CGI",
    "BACKEND",
    "SCRIPT"
]);

const HIGH_CONFIDENCE_SOURCE_TYPES = new Set([
    "HTML",
    "JS",
    "CSS"
]);


function pushUnique(list, seen, value) {
    const key = JSON.stringify(value);

    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    list.push(value);
}


function sourceFilePath(source, inventoryPaths) {
    if (inventoryPaths.has(source)) {
        return source;
    }

    const hashIndex = source.indexOf("#");
    const candidate = hashIndex >= 0
        ? source.slice(0, hashIndex)
        : source;

    return inventoryPaths.has(candidate)
        ? candidate
        : null;
}


export function buildFileReport({
    inventory,
    cssFacts,
    jsFacts,
    corpusFacts,
    worldResolution
}) {
    const inventoryPaths = new Set(
        inventory.map(file => file.path)
    );
    const staticReferences = [...worldResolution.staticReferences];
    const missingReferences = [...worldResolution.missingReferences];
    const partialReferences = [...worldResolution.partialReferences];
    const unresolvedReferences = [...worldResolution.unresolvedReferences];
    const staticSeen = new Set(staticReferences.map(item => JSON.stringify(item)));
    const missingSeen = new Set(missingReferences.map(item => JSON.stringify(item)));
    const unresolvedSeen = new Set(unresolvedReferences.map(item => JSON.stringify(item)));

    for (const css of cssFacts) {
        if (css.parseError) {
            pushUnique(unresolvedReferences, unresolvedSeen, {
                source: css.path,
                rawTarget: null,
                target: null,
                relation: "CSS_PARSE",
                evidenceType: "CSS_PARSE_ERROR",
                reason: css.parseError
            });
            continue;
        }

        for (const reference of css.references) {
            const resolution = resolveWebTarget(
                reference.rawTarget,
                css.path
            );
            const evidence = {
                source: css.path,
                target: resolution.target,
                rawTarget: reference.rawTarget,
                relation: reference.kind,
                evidenceType: "CSS_AST_RESOURCE_REF",
                property: reference.property,
                line: reference.line
            };

            if (resolution.status === "RESOLVED") {
                if (inventoryPaths.has(resolution.target)) {
                    pushUnique(staticReferences, staticSeen, evidence);
                } else {
                    pushUnique(missingReferences, missingSeen, {
                        ...evidence,
                        classification: "REFERENCED_BUT_NOT_PACKAGED"
                    });
                }
            } else if (resolution.status === "UNRESOLVED") {
                pushUnique(unresolvedReferences, unresolvedSeen, {
                    ...evidence,
                    reason: resolution.reason
                });
            }
        }
    }

    const corpusIncoming = [];
    const corpusIncomingSeen = new Set();

    for (const corpus of corpusFacts) {
        for (const reference of corpus.references) {
            const evidence = {
                source: corpus.source,
                sourceType: corpus.sourceType,
                target: reference.target,
                rawTarget: reference.rawTarget,
                relation: reference.evidenceType,
                evidenceType: reference.evidenceType,
                classification: reference.classification,
                occurrences: reference.occurrences
            };

            if (reference.classification === "PACKAGE_RESOURCE") {
                pushUnique(corpusIncoming, corpusIncomingSeen, evidence);
            } else if (reference.classification === "MISSING_WEB_RESOURCE") {
                pushUnique(missingReferences, missingSeen, {
                    ...evidence,
                    classification: "REFERENCED_BUT_NOT_PACKAGED",
                    sourceClassification: "MISSING_WEB_RESOURCE"
                });
            } else if (reference.classification === "RELATIVE_REFERENCE") {
                pushUnique(unresolvedReferences, unresolvedSeen, {
                    ...evidence,
                    reason: "CORPUS_RELATIVE_REFERENCE_WITHOUT_RUNTIME_BASE"
                });
            }
        }
    }

    for (const js of jsFacts) {
        if (!js.parseError) {
            continue;
        }

        pushUnique(unresolvedReferences, unresolvedSeen, {
            source: js.source,
            rawTarget: null,
            target: null,
            relation: "JS_PARSE",
            evidenceType: "JS_PARSE_ERROR",
            reason: js.parseError
        });
    }

    const files = inventory.map(file => {
        const worldMembership = [];
        const membershipSeen = new Set();

        for (const world of worldResolution.worlds) {
            for (const member of world.htmlMembers) {
                if (member.path === file.path) {
                    pushUnique(worldMembership, membershipSeen, {
                        worldId: world.id,
                        kind: member.role,
                        container: member.path
                    });
                }
            }

            for (const load of world.scriptLoads) {
                if (load.filePath === file.path) {
                    pushUnique(worldMembership, membershipSeen, {
                        worldId: world.id,
                        kind: load.kind,
                        container: load.containerPath,
                        orderScope: load.orderScope,
                        localOrder: load.localOrder
                    });
                }
            }
        }

        const incomingStatic = staticReferences.filter(reference =>
            reference.target === file.path && reference.source !== file.path
        );
        const incomingCorpus = corpusIncoming.filter(reference =>
            reference.target === file.path && reference.source !== file.path
        );
        const dynamicReferenceEvidence = worldResolution.dynamicReferenceEvidence.filter(reference =>
            reference.target === file.path
        );
        const unresolvedIncomingBlockers = unresolvedReferences.filter(reference =>
            reference.target === file.path && reference.source !== file.path
        );
        const partialIncomingBlockers = partialReferences.filter(reference =>
            reference.target === file.path && reference.source !== file.path
        );
        const outgoingUnresolvedEvidence = unresolvedReferences.filter(reference =>
            sourceFilePath(reference.source, inventoryPaths) === file.path
        );
        const outgoingPartialEvidence = partialReferences.filter(reference =>
            sourceFilePath(reference.source, inventoryPaths) === file.path
        );
        const analysisBlockers = outgoingUnresolvedEvidence.filter(reference =>
            reference.evidenceType === "JS_PARSE_ERROR" ||
            reference.evidenceType === "CSS_PARSE_ERROR"
        );
        const fileSpecificUnresolved = [
            ...unresolvedIncomingBlockers,
            ...partialIncomingBlockers,
            ...analysisBlockers
        ];
        const sourceDynamicSites = jsFacts
            .filter(js => sourceFilePath(js.source, inventoryPaths) === file.path)
            .flatMap(js => js.dynamicSites.map(site => ({
                source: js.source,
                vendor: js.vendor,
                ...site
            })));

        return {
            path: file.path,
            type: file.type,
            size: file.size,
            worldMembership,
            staticIncomingReferences: incomingStatic,
            corpusIncomingReferences: incomingCorpus,
            dynamicReferenceEvidence,
            unresolvedEvidence: fileSpecificUnresolved,
            outgoingPartialEvidence,
            outgoingUnresolvedEvidence,
            dynamicSites: sourceDynamicSites
        };
    });

    const candidates = [];

    for (const file of files) {
        if (EXTERNAL_RUNTIME_TYPES.has(file.type)) {
            continue;
        }

        if (
            file.worldMembership.length > 0 ||
            file.staticIncomingReferences.length > 0 ||
            file.corpusIncomingReferences.length > 0 ||
            file.dynamicReferenceEvidence.length > 0 ||
            file.unresolvedEvidence.length > 0
        ) {
            continue;
        }

        const confidence = HIGH_CONFIDENCE_SOURCE_TYPES.has(file.type)
            ? "HIGH"
            : "MEDIUM";

        candidates.push({
            confidence,
            path: file.path,
            type: file.type,
            worldMembership: file.worldMembership,
            staticIncomingReferences: file.staticIncomingReferences,
            corpusIncomingReferences: file.corpusIncomingReferences,
            dynamicReferenceEvidence: file.dynamicReferenceEvidence,
            unresolvedEvidence: file.unresolvedEvidence,
            note: confidence === "HIGH"
                ? "No world membership or file-specific incoming evidence was found. Human review is still required."
                : "Asset has no incoming evidence, but dynamic asset naming remains a broader false-positive risk."
        });
    }

    const confidenceOrder = new Map([
        ["HIGH", 0],
        ["MEDIUM", 1]
    ]);
    candidates.sort((a, b) =>
        confidenceOrder.get(a.confidence) - confidenceOrder.get(b.confidence) ||
        a.path.localeCompare(b.path)
    );

    const referencedButNotPackaged = [];
    const missingGroup = new Map();

    for (const reference of missingReferences) {
        const key = reference.target ?? reference.rawTarget;

        if (!missingGroup.has(key)) {
            missingGroup.set(key, []);
        }
        missingGroup.get(key).push(reference);
    }

    for (const [target, evidence] of missingGroup) {
        referencedButNotPackaged.push({
            target,
            classification: "REFERENCED_BUT_NOT_PACKAGED",
            interpretation: "EXTERNAL_OR_RUNTIME_GENERATED_OR_MISSING",
            evidence
        });
    }
    referencedButNotPackaged.sort((a, b) => a.target.localeCompare(b.target));

    return {
        files,
        candidates,
        staticReferences,
        corpusIncomingReferences: corpusIncoming,
        partialReferences,
        unresolvedReferences,
        referencedButNotPackaged
    };
}
