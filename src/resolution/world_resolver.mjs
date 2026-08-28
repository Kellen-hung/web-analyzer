import { isHtmlPath, resolveWebTarget } from "./resource_utils.mjs";
import {
    evaluateUrlExpression,
    resolveUrlExpression,
    URL_RESOLUTION_STATE
} from "./url_expression_resolver.mjs";


function pushUnique(list, seen, value) {
    const key = JSON.stringify(value);

    if (seen.has(key)) {
        return false;
    }

    seen.add(key);
    list.push(value);
    return true;
}


export function resolveWorlds({
    inventory,
    htmlFacts,
    jsFacts,
    corpusFacts,
    entryDocuments = []
}) {
    const inventoryByPath = new Map(
        inventory.map(file => [file.path, file])
    );
    const htmlByPath = new Map(
        htmlFacts.map(fact => [fact.path, fact])
    );
    const jsBySource = new Map(
        jsFacts.map(fact => [fact.source, fact])
    );

    const worlds = [];
    const entryWorldByDocument = new Map();
    const roleAssignments = new Map();
    const staticReferences = [];
    const missingReferences = [];
    const partialReferences = [];
    const unresolvedReferences = [];
    const dynamicReferenceEvidence = [];
    const dynamicSites = [];

    const staticSeen = new Set();
    const missingSeen = new Set();
    const partialSeen = new Set();
    const unresolvedSeen = new Set();
    const dynamicReferenceSeen = new Set();
    const dynamicSiteSeen = new Set();
    let iframeWorldSequence = 0;

    function assignRole(target, role, evidence) {
        if (!roleAssignments.has(target)) {
            roleAssignments.set(target, []);
        }

        pushUnique(
            roleAssignments.get(target),
            new Set(roleAssignments.get(target).map(item => JSON.stringify(item))),
            { role, evidence }
        );
    }

    function addStaticReference(reference) {
        pushUnique(staticReferences, staticSeen, reference);
    }

    function addMissingReference(reference) {
        pushUnique(missingReferences, missingSeen, reference);
    }

    function addUnresolvedReference(reference, world = null) {
        if (pushUnique(unresolvedReferences, unresolvedSeen, reference) && world) {
            world.unresolvedEvidence.push(reference);
        }
    }

    function addPartialReference(reference, world = null) {
        if (pushUnique(partialReferences, partialSeen, reference) && world) {
            world.partialEvidence.push(reference);
        }
    }

    function createEntryWorld(document, kind, evidence) {
        if (entryWorldByDocument.has(document)) {
            const existing = entryWorldByDocument.get(document);
            pushUnique(
                existing.creationEvidence,
                new Set(existing.creationEvidence.map(item => JSON.stringify(item))),
                evidence
            );
            return existing;
        }

        const world = {
            id: document,
            document,
            kind,
            parentWorldId: null,
            creationEvidence: [evidence],
            htmlMembers: [],
            scriptLoads: [],
            iframeChildren: [],
            literalBindings: [],
            urlBindings: [],
            partialEvidence: [],
            unresolvedEvidence: [],
            tabLinkKeys: new Set(),
            processedIframeKeys: new Set()
        };

        worlds.push(world);
        entryWorldByDocument.set(document, world);
        assignRole(document, "ENTRY_DOCUMENT", evidence);
        return world;
    }

    function createIframeWorld(document, parentWorld, evidence) {
        const world = {
            id: `${document}::iframe-${++iframeWorldSequence}`,
            document,
            kind: "IFRAME_DOCUMENT",
            parentWorldId: parentWorld.id,
            creationEvidence: [evidence],
            htmlMembers: [],
            scriptLoads: [],
            iframeChildren: [],
            literalBindings: [],
            urlBindings: [],
            partialEvidence: [],
            unresolvedEvidence: [],
            tabLinkKeys: new Set(),
            processedIframeKeys: new Set()
        };

        worlds.push(world);
        assignRole(document, "IFRAME_DOCUMENT", evidence);
        parentWorld.iframeChildren.push({
            document,
            worldId: world.id,
            evidence
        });
        return world;
    }

    function addHtmlReferences(world, html, runtimeBase, memberRole) {
        for (const reference of html.references) {
            const resolution = resolveWebTarget(
                reference.rawTarget,
                runtimeBase
            );
            const evidence = {
                source: html.path,
                target: resolution.target,
                rawTarget: reference.rawTarget,
                relation: reference.kind,
                evidenceType: "HTML_ATTRIBUTE_REF",
                worldId: world.id,
                runtimeBase,
                physicalCandidate: reference.physicalCandidate,
                line: reference.line
            };

            if (resolution.status === "RESOLVED") {
                if (inventoryByPath.has(resolution.target)) {
                    addStaticReference(evidence);
                } else {
                    addMissingReference({
                        ...evidence,
                        classification: "REFERENCED_BUT_NOT_PACKAGED"
                    });
                }
            } else if (resolution.status === "UNRESOLVED") {
                addUnresolvedReference({
                    ...evidence,
                    reason: resolution.reason
                }, world);
            }
        }
    }

    function addScriptLoad(world, load) {
        const key = JSON.stringify({
            sourceId: load.sourceId,
            containerPath: load.containerPath,
            containerRole: load.containerRole,
            localOrder: load.localOrder,
            kind: load.kind
        });

        if (!world._scriptLoadKeys) {
            world._scriptLoadKeys = new Set();
        }

        if (world._scriptLoadKeys.has(key)) {
            return;
        }

        world._scriptLoadKeys.add(key);
        world.scriptLoads.push(load);
    }

    function attachHtmlMember(world, htmlPath, memberRole, evidence) {
        const html = htmlByPath.get(htmlPath);

        if (!html) {
            addUnresolvedReference({
                source: evidence.source ?? world.document,
                rawTarget: htmlPath,
                target: htmlPath,
                relation: memberRole,
                evidenceType: "WORLD_MEMBERSHIP",
                worldId: world.id,
                reason: "HTML_FACTS_NOT_FOUND"
            }, world);
            return false;
        }

        const existing = world.htmlMembers.find(member =>
            member.path === htmlPath && member.role === memberRole
        );

        if (existing) {
            pushUnique(
                existing.evidence,
                new Set(existing.evidence.map(item => JSON.stringify(item))),
                evidence
            );
            return false;
        }

        const runtimeBase = world.document;
        world.htmlMembers.push({
            path: htmlPath,
            role: memberRole,
            runtimeBase,
            evidence: [evidence]
        });
        addHtmlReferences(world, html, runtimeBase, memberRole);

        for (const script of html.scripts) {
            const resolution = resolveWebTarget(
                script.rawTarget,
                runtimeBase
            );

            if (
                resolution.status === "RESOLVED" &&
                inventoryByPath.get(resolution.target)?.type === "JS"
            ) {
                addScriptLoad(world, {
                    sourceId: resolution.target,
                    filePath: resolution.target,
                    kind: "EXTERNAL_SCRIPT",
                    containerPath: htmlPath,
                    containerRole: memberRole,
                    orderScope: `${memberRole}:${htmlPath}`,
                    localOrder: script.order,
                    runtimeBase,
                    evidence: {
                        source: htmlPath,
                        rawTarget: script.rawTarget,
                        physicalCandidate: script.physicalCandidate,
                        resolvedTarget: resolution.target,
                        line: script.line
                    }
                });
            }
        }

        for (const inlineScript of html.inlineScripts) {
            addScriptLoad(world, {
                sourceId: inlineScript.sourceId,
                filePath: null,
                kind: "INLINE_SCRIPT",
                containerPath: htmlPath,
                containerRole: memberRole,
                orderScope: `${memberRole}:${htmlPath}`,
                localOrder: inlineScript.order,
                runtimeBase,
                evidence: {
                    source: htmlPath,
                    line: inlineScript.line
                }
            });
        }

        for (const handler of html.inlineHandlers) {
            addScriptLoad(world, {
                sourceId: handler.sourceId,
                filePath: null,
                kind: "INLINE_HANDLER",
                containerPath: htmlPath,
                containerRole: memberRole,
                orderScope: `EVENT_HANDLER:${htmlPath}`,
                localOrder: null,
                runtimeBase,
                evidence: {
                    source: htmlPath,
                    event: handler.event,
                    line: handler.line
                }
            });
        }

        return true;
    }

    function discoverTabFragments(world) {
        let changed = true;

        while (changed) {
            changed = false;
            const tabsFacts = world.scriptLoads.flatMap(load => {
                const js = jsBySource.get(load.sourceId);
                return (js?.worldFacts ?? [])
                    .filter(fact => fact.type === "JQUERY_TABS_INIT")
                    .map(fact => ({ load, fact }));
            });

            for (const { load, fact } of tabsFacts) {
                if (!/^#[A-Za-z][\w:-]*$/.test(fact.selector)) {
                    addUnresolvedReference({
                        source: load.sourceId,
                        rawTarget: fact.selector,
                        target: null,
                        relation: "JQUERY_TABS_INIT",
                        evidenceType: "JS_AST_WORLD_FACT",
                        worldId: world.id,
                        reason: "UNSUPPORTED_TABS_SELECTOR"
                    }, world);
                    continue;
                }

                const ancestorId = fact.selector.slice(1);

                for (const member of [...world.htmlMembers]) {
                    const html = htmlByPath.get(member.path);

                    for (const link of html.links) {
                        if (!link.ancestorIds.includes(ancestorId)) {
                            continue;
                        }

                        const linkKey = `${member.path}:${link.line}:${link.rawTarget}`;
                        world.tabLinkKeys.add(linkKey);
                        const resolution = resolveWebTarget(
                            link.rawTarget,
                            world.document
                        );

                        if (
                            resolution.status !== "RESOLVED" ||
                            inventoryByPath.get(resolution.target)?.type !== "HTML"
                        ) {
                            addUnresolvedReference({
                                source: member.path,
                                rawTarget: link.rawTarget,
                                target: resolution.target,
                                relation: "JQUERY_TABS_REMOTE_LINK",
                                evidenceType: "CROSS_FILE_TABS_EVIDENCE",
                                worldId: world.id,
                                reason: resolution.reason ?? "TARGET_NOT_PACKAGED_HTML"
                            }, world);
                            continue;
                        }

                        const roleEvidence = {
                            type: "JQUERY_TABS_REMOTE_LINK",
                            hostDocument: world.document,
                            htmlSource: member.path,
                            htmlLine: link.line,
                            selector: fact.selector,
                            jsSource: load.sourceId,
                            jsLine: fact.line,
                            rawTarget: link.rawTarget
                        };
                        assignRole(
                            resolution.target,
                            "AJAX_FRAGMENT",
                            roleEvidence
                        );

                        if (attachHtmlMember(
                            world,
                            resolution.target,
                            "AJAX_FRAGMENT",
                            roleEvidence
                        )) {
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    function discoverOrdinaryNavigationLinks(world) {
        const created = [];

        for (const member of world.htmlMembers) {
            const html = htmlByPath.get(member.path);

            for (const link of html.links) {
                const linkKey = `${member.path}:${link.line}:${link.rawTarget}`;

                if (world.tabLinkKeys.has(linkKey)) {
                    continue;
                }

                const resolution = resolveWebTarget(
                    link.rawTarget,
                    world.document
                );

                if (
                    resolution.status !== "RESOLVED" ||
                    inventoryByPath.get(resolution.target)?.type !== "HTML"
                ) {
                    continue;
                }

                const evidence = {
                    type: "ORDINARY_HTML_LINK_DOCUMENT_CANDIDATE",
                    source: member.path,
                    line: link.line,
                    rawTarget: link.rawTarget,
                    confidence: "CANDIDATE"
                };
                const isNew = !entryWorldByDocument.has(resolution.target);
                const candidate = createEntryWorld(
                    resolution.target,
                    "LINKED_DOCUMENT_CANDIDATE",
                    evidence
                );

                if (isNew) {
                    attachHtmlMember(candidate, resolution.target, "ENTRY_DOCUMENT", evidence);
                    created.push(candidate);
                }
            }
        }

        return created;
    }

    function discoverIframes(world) {
        const created = [];

        for (const member of world.htmlMembers) {
            const html = htmlByPath.get(member.path);

            for (const iframe of html.iframes) {
                const key = `${member.path}:${iframe.line}:${iframe.rawTarget}`;

                if (world.processedIframeKeys.has(key)) {
                    continue;
                }

                world.processedIframeKeys.add(key);
                const resolution = resolveWebTarget(
                    iframe.rawTarget,
                    world.document
                );

                if (
                    resolution.status !== "RESOLVED" ||
                    inventoryByPath.get(resolution.target)?.type !== "HTML"
                ) {
                    addUnresolvedReference({
                        source: member.path,
                        rawTarget: iframe.rawTarget,
                        target: resolution.target,
                        relation: "IFRAME_CHILD",
                        evidenceType: "HTML_ATTRIBUTE_REF",
                        worldId: world.id,
                        reason: resolution.reason ?? "TARGET_NOT_PACKAGED_HTML"
                    }, world);
                    continue;
                }

                const evidence = {
                    type: "IFRAME_SRC",
                    parentWorldId: world.id,
                    source: member.path,
                    line: iframe.line,
                    rawTarget: iframe.rawTarget,
                    runtimeBase: world.document,
                    physicalCandidate: iframe.physicalCandidate,
                    resolvedTarget: resolution.target
                };
                const child = createIframeWorld(
                    resolution.target,
                    world,
                    evidence
                );
                attachHtmlMember(
                    child,
                    resolution.target,
                    "IFRAME_DOCUMENT",
                    evidence
                );
                created.push(child);
            }
        }

        return created;
    }

    function processWorldStructure(initialWorlds) {
        const queue = [...initialWorlds];

        while (queue.length > 0) {
            const world = queue.shift();
            discoverTabFragments(world);
            queue.push(...discoverOrdinaryNavigationLinks(world));
            queue.push(...discoverIframes(world));
        }
    }

    function buildWorldBindings(world) {
        const bindings = new Map();
        const helpers = new Map();
        const stableLoads = world.scriptLoads
            .filter(load =>
                load.containerRole !== "AJAX_FRAGMENT" &&
                load.kind !== "INLINE_HANDLER"
            )
            .sort((a, b) => (a.localOrder ?? Number.MAX_SAFE_INTEGER) - (b.localOrder ?? Number.MAX_SAFE_INTEGER));

        for (const load of stableLoads) {
            const js = jsBySource.get(load.sourceId);

            for (const helper of js?.urlHelpers ?? []) {
                helpers.set(helper.name, helper.expression);
            }

            for (const assignment of js?.urlAssignments ?? []) {
                const evaluated = evaluateUrlExpression(
                    assignment.expression,
                    { bindings, helpers }
                );
                bindings.set(assignment.name, evaluated);
                world.urlBindings.push({
                    ...assignment,
                    source: load.sourceId,
                    components: evaluated.components,
                    unresolvedSymbols: evaluated.unresolvedSymbols,
                    method: "ORDERED_TOP_LEVEL_URL_ASSIGNMENT"
                });
            }

            for (const assignment of js?.literalAssignments ?? []) {
                world.literalBindings.push({
                    ...assignment,
                    source: load.sourceId,
                    method: "ORDERED_TOP_LEVEL_LITERAL_ASSIGNMENT"
                });
            }
        }

        return { bindings, helpers };
    }

    function processWorldJavaScript(world) {
        const { bindings, helpers } = buildWorldBindings(world);

        for (let index = 0; index < world.scriptLoads.length; index++) {
            const load = world.scriptLoads[index];
            const js = jsBySource.get(load.sourceId);

            if (!js) {
                addUnresolvedReference({
                    source: load.sourceId,
                    rawTarget: load.sourceId,
                    target: load.filePath,
                    relation: "SCRIPT_FACTS",
                    evidenceType: "WORLD_SCRIPT_LOAD",
                    worldId: world.id,
                    reason: "JS_FACTS_NOT_FOUND"
                }, world);
                continue;
            }

            for (const site of js.dynamicSites) {
                pushUnique(dynamicSites, dynamicSiteSeen, {
                    worldId: world.id,
                    source: js.source,
                    vendor: js.vendor,
                    ...site
                });
            }

            for (const hint of js.resourceHints) {
                const resolution = resolveWebTarget(
                    hint.rawTarget,
                    world.document
                );
                const evidence = {
                    source: js.source,
                    target: resolution.target,
                    rawTarget: hint.rawTarget,
                    relation: hint.type,
                    evidenceType: "JS_STRING_RESOURCE_HINT",
                    certainty: "EVIDENCE_ONLY",
                    worldId: world.id,
                    line: hint.line
                };

                if (resolution.status === "RESOLVED") {
                    if (inventoryByPath.has(resolution.target)) {
                        pushUnique(
                            dynamicReferenceEvidence,
                            dynamicReferenceSeen,
                            evidence
                        );
                    }
                }
            }

            for (const fact of js.resourceFacts) {
                const urlResolution = resolveUrlExpression(
                    fact.target.urlExpression,
                    { bindings, helpers }
                );
                const symbolicEvidence = {
                    source: js.source,
                    rawTarget: fact.target.raw,
                    relation: fact.type,
                    api: fact.api,
                    evidenceType: "JS_AST_RESOURCE_REF",
                    worldId: world.id,
                    runtimeBase: world.document,
                    line: fact.line,
                    urlResolutionState: urlResolution.state,
                    pathname: urlResolution.pathname,
                    origin: urlResolution.origin,
                    components: urlResolution.components,
                    knownPrefix: urlResolution.knownPrefix,
                    knownSuffix: urlResolution.knownSuffix,
                    unresolvedSymbols: urlResolution.unresolvedSymbols
                };

                if (urlResolution.state === URL_RESOLUTION_STATE.PARTIALLY_RESOLVED) {
                    addPartialReference({
                        ...symbolicEvidence,
                        target: null,
                        reason: urlResolution.reason
                    }, world);
                    continue;
                }

                if (urlResolution.state === URL_RESOLUTION_STATE.UNRESOLVED) {
                    addUnresolvedReference({
                        ...symbolicEvidence,
                        target: null,
                        reason: urlResolution.reason
                    }, world);
                    continue;
                }

                const resolution = resolveWebTarget(
                    urlResolution.pathname,
                    world.document
                );
                const evidence = {
                    ...symbolicEvidence,
                    target: resolution.target,
                    packagePath: resolution.target,
                    evaluatedTarget: urlResolution.pathname,
                    resolutionMethod: "SYMBOLIC_URL_PATHNAME"
                };

                if (resolution.status !== "RESOLVED") {
                    addUnresolvedReference({
                        ...evidence,
                        reason: resolution.reason
                    }, world);
                    continue;
                }

                if (!inventoryByPath.has(resolution.target)) {
                    addMissingReference({
                        ...evidence,
                        classification: "REFERENCED_BUT_NOT_PACKAGED"
                    });
                    continue;
                }

                addStaticReference(evidence);

                if (
                    fact.type === "REQUESTS" &&
                    isHtmlPath(resolution.target)
                ) {
                    assignRole(
                        resolution.target,
                        "FETCHED_RESOURCE",
                        evidence
                    );
                }

                if (
                    fact.type === "NAVIGATES_TO" &&
                    isHtmlPath(resolution.target)
                ) {
                    const isNew = !entryWorldByDocument.has(resolution.target);
                    const navigationWorld = createEntryWorld(
                        resolution.target,
                        "NAVIGATED_DOCUMENT_CANDIDATE",
                        evidence
                    );

                    if (isNew) {
                        attachHtmlMember(
                            navigationWorld,
                            resolution.target,
                            "ENTRY_DOCUMENT",
                            evidence
                        );
                        processWorldStructure([navigationWorld]);
                    }
                }

                if (
                    fact.type === "IMPORTS" &&
                    inventoryByPath.get(resolution.target)?.type === "JS"
                ) {
                    addScriptLoad(world, {
                        sourceId: resolution.target,
                        filePath: resolution.target,
                        kind: "DYNAMIC_SCRIPT_IMPORT",
                        containerPath: load.containerPath,
                        containerRole: load.containerRole,
                        orderScope: `ASYNC_IMPORT:${js.source}`,
                        localOrder: null,
                        runtimeBase: world.document,
                        evidence
                    });
                }
            }
        }
    }

    for (const document of entryDocuments) {
        if (inventoryByPath.get(document)?.type !== "HTML") {
            addUnresolvedReference({
                source: "analysis-config",
                rawTarget: document,
                target: document,
                relation: "ENTRY_DOCUMENT",
                evidenceType: "EXPLICIT_ENTRY_SEED",
                worldId: null,
                reason: "CONFIGURED_ENTRY_NOT_PACKAGED_HTML"
            });
            continue;
        }

        const evidence = {
            type: "EXPLICIT_ENTRY_SEED",
            source: "analysis-config",
            confidence: "EXPLICIT"
        };
        const world = createEntryWorld(
            document,
            "ENTRY_DOCUMENT",
            evidence
        );
        attachHtmlMember(world, document, "ENTRY_DOCUMENT", evidence);
    }

    for (const corpus of corpusFacts) {
        for (const reference of corpus.references) {
            if (
                reference.evidenceType !== "BINARY_STRING_REF" ||
                reference.classification !== "PACKAGE_RESOURCE" ||
                !isHtmlPath(reference.target) ||
                entryWorldByDocument.has(reference.target)
            ) {
                continue;
            }

            const evidence = {
                type: "BACKEND_STRING_DOCUMENT_CANDIDATE",
                source: corpus.source,
                sourceType: corpus.sourceType,
                evidenceType: reference.evidenceType,
                rawTarget: reference.rawTarget,
                confidence: "EVIDENCE_ONLY"
            };
            const world = createEntryWorld(
                reference.target,
                "BACKEND_REFERENCED_DOCUMENT_CANDIDATE",
                evidence
            );
            attachHtmlMember(world, reference.target, "ENTRY_DOCUMENT", evidence);
        }
    }

    processWorldStructure([...worlds]);

    for (let index = 0; index < worlds.length; index++) {
        processWorldJavaScript(worlds[index]);
    }

    const htmlRoles = inventory
        .filter(file => file.type === "HTML")
        .map(file => {
            const assignments = roleAssignments.get(file.path) ?? [];
            const roles = [...new Set(assignments.map(item => item.role))];

            return {
                path: file.path,
                role: roles.length === 1
                    ? roles[0]
                    : "UNKNOWN_HTML_ROLE",
                roles,
                ambiguous: roles.length > 1,
                evidence: assignments.map(item => item.evidence)
            };
        });

    for (const world of worlds) {
        delete world._scriptLoadKeys;
        world.tabLinkKeys = [...world.tabLinkKeys];
        world.processedIframeKeys = [...world.processedIframeKeys];
    }

    return {
        worlds,
        htmlRoles,
        staticReferences,
        missingReferences,
        partialReferences,
        unresolvedReferences,
        dynamicReferenceEvidence,
        dynamicSites
    };
}
