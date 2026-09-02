import fs from "node:fs/promises";
import path from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import * as eslintScope from "eslint-scope";
import { DEFAULT_VENDOR_JS_PATTERNS } from "../config/analyzer_config.mjs";


const RESOURCE_HINT_PATTERN =
    /(?:\/www\/|\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:html?|js|css|png|jpe?g|gif|webp|ico|svg|cgi|json|txt)(?:\?[^?\s"'<>]+)?/gi;


function getPropertyName(node) {
    if (!node || node.type !== "MemberExpression") {
        return null;
    }

    if (!node.computed && node.property.type === "Identifier") {
        return node.property.name;
    }

    if (node.computed && node.property.type === "Literal") {
        return String(node.property.value);
    }

    return null;
}


function isIdentifier(node, name) {
    return node?.type === "Identifier" && node.name === name;
}


function isDollar(node) {
    return isIdentifier(node, "$") || isIdentifier(node, "jQuery");
}


function getSourceText(source, node) {
    if (!node) {
        return null;
    }

    return source.slice(node.start, node.end);
}


function getLiteralString(node) {
    if (
        node?.type === "Literal" &&
        typeof node.value === "string"
    ) {
        return node.value;
    }

    return null;
}


/*
 * Example:
 *
 * "version.html?_=" + timestamp
 *
 * returns:
 *
 * "version.html?_="
 *
 * This is NOT a fully resolved value.
 * It is only a statically-known prefix.
 */
function getStaticStringPrefix(node) {
    function inspectPrefix(current) {
        if (!current) {
            return null;
        }

        const literal = getLiteralString(current);

        if (literal !== null) {
            return {
                value: literal,
                complete: true
            };
        }

        if (
            current.type !== "BinaryExpression" ||
            current.operator !== "+"
        ) {
            return null;
        }

        const left = inspectPrefix(current.left);

        if (!left) {
            return null;
        }

        // Once an unknown value interrupts the expression, later literals
        // are suffixes, not part of the contiguous static prefix.
        if (!left.complete) {
            return left;
        }

        const right = inspectPrefix(current.right);

        if (!right) {
            return {
                value: left.value,
                complete: false
            };
        }

        return {
            value: left.value + right.value,
            complete: right.complete
        };
    }

    return inspectPrefix(node)?.value ?? null;
}


function inspectStaticCodeReferences(code) {
    if (typeof code !== "string") {
        return [];
    }

    try {
        const ast = acorn.parse(code, {
            ecmaVersion: "latest",
            sourceType: "script",
            locations: true
        });
        const scopeManager = eslintScope.analyze(ast, {
            ecmaVersion: 2022,
            sourceType: "script"
        });

        return scopeManager.globalScope.through.map(reference => ({
            name: reference.identifier.name,
            read: reference.isRead(),
            write: reference.isWrite(),
            line: reference.identifier.loc?.start.line ?? null
        }));
    } catch {
        return [];
    }
}


function getEnclosingFunctionNames(ancestors) {
    const names = [];

    for (let index = 0; index < ancestors.length - 1; index++) {
        const ancestor = ancestors[index];

        if (ancestor.type === "FunctionDeclaration" && ancestor.id?.name) {
            names.push(ancestor.id.name);
            continue;
        }

        if (
            ["FunctionExpression", "ArrowFunctionExpression"].includes(
                ancestor.type
            )
        ) {
            if (ancestor.id?.name) {
                names.push(ancestor.id.name);
                continue;
            }

            const parent = index > 0 ? ancestors[index - 1] : null;

            if (
                parent?.type === "VariableDeclarator" &&
                parent.init === ancestor &&
                parent.id.type === "Identifier"
            ) {
                names.push(parent.id.name);
            }
        }
    }

    return [...new Set(names)];
}


function getSimpleStringExpression(node) {
    if (!node) {
        return null;
    }

    if (node.type === "Literal" && typeof node.value === "string") {
        return [{
            kind: "LITERAL",
            value: node.value
        }];
    }

    if (node.type === "Identifier") {
        return [{
            kind: "IDENTIFIER",
            name: node.name
        }];
    }

    if (node.type !== "BinaryExpression" || node.operator !== "+") {
        return null;
    }

    const left = getSimpleStringExpression(node.left);
    const right = getSimpleStringExpression(node.right);

    if (!left || !right) {
        return null;
    }

    return [...left, ...right];
}


function getLocationValueType(node) {
    if (node?.type !== "MemberExpression") {
        return null;
    }

    const property = getPropertyName(node);
    const valueTypes = new Map([
        ["host", "CURRENT_HOST"],
        ["hostname", "CURRENT_HOSTNAME"],
        ["protocol", "CURRENT_PROTOCOL"],
        ["origin", "CURRENT_ORIGIN"]
    ]);

    return isLocationObject(node.object)
        ? valueTypes.get(property) ?? null
        : null;
}


function describeUrlExpression(source, node) {
    const literal = getLiteralString(node);

    if (literal !== null) {
        return {
            type: "STRING",
            value: literal
        };
    }

    const locationValueType = getLocationValueType(node);

    if (locationValueType) {
        return {
            type: "LOCATION_VALUE",
            valueType: locationValueType
        };
    }

    if (node?.type === "Identifier") {
        return {
            type: "IDENTIFIER",
            name: node.name
        };
    }

    if (node?.type === "BinaryExpression" && node.operator === "+") {
        const left = describeUrlExpression(source, node.left);
        const right = describeUrlExpression(source, node.right);
        const parts = [];

        for (const part of [left, right]) {
            if (part.type === "CONCAT") {
                parts.push(...part.parts);
            } else {
                parts.push(part);
            }
        }

        return {
            type: "CONCAT",
            parts
        };
    }

    if (
        node?.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.arguments.length === 0
    ) {
        return {
            type: "CALL",
            name: node.callee.name
        };
    }

    return {
        type: "UNKNOWN",
        raw: getSourceText(source, node) ?? "missing-expression"
    };
}


function describeTarget(source, node) {
    if (!node) {
        return {
            raw: null,
            literal: null,
            staticPrefix: null,
            simpleExpression: null,
            urlExpression: null
        };
    }

    return {
        raw: getSourceText(source, node),
        literal: getLiteralString(node),
        staticPrefix: getStaticStringPrefix(node),
        simpleExpression: getSimpleStringExpression(node),
        urlExpression: describeUrlExpression(source, node)
    };
}


function isJQueryMethodCall(node, methodName) {
    if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression"
    ) {
        return false;
    }

    if (getPropertyName(node.callee) !== methodName) {
        return false;
    }

    return isDollar(node.callee.object);
}


function getJQuerySelector(node) {
    /*
     * $('#tabs').tabs(...)
     *
     * node.callee.object:
     *
     * CallExpression
     *   callee: $
     *   arguments: ["#tabs"]
     */

    if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression"
    ) {
        return null;
    }

    const object = node.callee.object;

    if (
        object.type !== "CallExpression" ||
        !isDollar(object.callee)
    ) {
        return null;
    }

    return getLiteralString(object.arguments[0]);
}


function isLocationObject(node) {
    if (!node) {
        return false;
    }

    // location
    if (isIdentifier(node, "location")) {
        return true;
    }

    if (node.type !== "MemberExpression") {
        return false;
    }

    const property = getPropertyName(node);

    // window.location
    if (
        property === "location" &&
        isIdentifier(node.object, "window")
    ) {
        return true;
    }

    // window.top.location
    if (
        property === "location" &&
        node.object.type === "MemberExpression" &&
        getPropertyName(node.object) === "top" &&
        isIdentifier(node.object.object, "window")
    ) {
        return true;
    }

    return false;
}


function addFact(list, seen, fact) {
    const key = JSON.stringify(fact);

    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    list.push(fact);
}


function isXhrConstruction(node) {
    if (node?.type !== "NewExpression") {
        return false;
    }

    if (isIdentifier(node.callee, "XMLHttpRequest")) {
        return true;
    }

    return (
        isIdentifier(node.callee, "ActiveXObject") &&
        getLiteralString(node.arguments[0]) === "Microsoft.XMLHTTP"
    );
}


function collectXhrReceivers(ast, source) {
    const receivers = new Set();

    walk.simple(ast, {
        VariableDeclarator(node) {
            if (isXhrConstruction(node.init) && node.id.type === "Identifier") {
                receivers.add(node.id.name);
            }
        },
        AssignmentExpression(node) {
            if (isXhrConstruction(node.right)) {
                receivers.add(getSourceText(source, node.left));
            }
        }
    });

    return receivers;
}


function getTopLevelAssignments(ast, source) {
    const assignments = [];

    for (const statement of ast.body) {
        if (statement.type === "VariableDeclaration") {
            for (const declaration of statement.declarations) {
                if (declaration.id.type === "Identifier" && declaration.init) {
                    assignments.push({
                        name: declaration.id.name,
                        expression: describeUrlExpression(source, declaration.init),
                        raw: getSourceText(source, declaration.init),
                        kind: statement.kind.toUpperCase(),
                        line: declaration.loc?.start.line ?? null
                    });
                }
            }
            continue;
        }

        const expression = statement.type === "ExpressionStatement"
            ? statement.expression
            : null;

        if (
            expression?.type === "AssignmentExpression" &&
            expression.operator === "=" &&
            expression.left.type === "Identifier"
        ) {
            assignments.push({
                name: expression.left.name,
                expression: describeUrlExpression(source, expression.right),
                raw: getSourceText(source, expression.right),
                kind: "ASSIGNMENT",
                line: expression.loc?.start.line ?? null
            });
        }
    }

    return assignments;
}


function getSimpleUrlHelpers(ast, source) {
    const helpers = [];

    for (const statement of ast.body) {
        if (
            statement.type !== "FunctionDeclaration" ||
            !statement.id ||
            statement.params.length !== 0 ||
            statement.body.body.length !== 1 ||
            statement.body.body[0].type !== "ReturnStatement" ||
            !statement.body.body[0].argument
        ) {
            continue;
        }

        helpers.push({
            name: statement.id.name,
            expression: describeUrlExpression(
                source,
                statement.body.body[0].argument
            ),
            raw: getSourceText(source, statement.body.body[0].argument),
            line: statement.loc?.start.line ?? null
        });
    }

    return helpers;
}


function matchesAnyPattern(sourceId, patterns) {
    return patterns.some(pattern => pattern.test(sourceId));
}


function isLikelyVendorSource(
    sourceId,
    patterns = DEFAULT_VENDOR_JS_PATTERNS
) {
    return matchesAnyPattern(sourceId, patterns);
}


export function inspectJavaScript(
    source,
    sourceId,
    {
        allowReturnOutsideFunction = false,
        lineOffset = 0,
        vendor = isLikelyVendorSource(sourceId)
    } = {}
) {
    let ast;

    try {
        ast = acorn.parse(source, {
            ecmaVersion: "latest",
            sourceType: "script",
            locations: true,
            allowHashBang: true,
            allowReturnOutsideFunction
        });
    } catch (error) {
        return {
            source: sourceId,
            parseError: error.message,
            resourceFacts: [],
            worldFacts: [],
            dynamicSites: [],
            resourceHints: [],
            literalAssignments: [],
            urlAssignments: [],
            urlHelpers: [],
            vendor
        };
    }

    const resourceFacts = [];
    const worldFacts = [];
    const dynamicSites = [];
    const resourceHints = [];

    const resourceSeen = new Set();
    const worldSeen = new Set();
    const dynamicSeen = new Set();
    const hintSeen = new Set();
    const xhrReceivers = collectXhrReceivers(ast, source);
    const enclosingFunctionNamesByNode = new WeakMap();
    const lineFor = node => (
        node.loc?.start.line === undefined
            ? null
            : node.loc.start.line + lineOffset
    );

    walk.ancestor(ast, {
        CallExpression(node, ancestors) {
            enclosingFunctionNamesByNode.set(
                node,
                getEnclosingFunctionNames(ancestors)
            );
        },
        NewExpression(node, ancestors) {
            enclosingFunctionNamesByNode.set(
                node,
                getEnclosingFunctionNames(ancestors)
            );
        },
        MemberExpression(node, ancestors) {
            enclosingFunctionNamesByNode.set(
                node,
                getEnclosingFunctionNames(ancestors)
            );
        }
    });

    const dynamicContextFor = node => ({
        enclosingFunctionNames:
            enclosingFunctionNamesByNode.get(node) ?? []
    });

    walk.simple(ast, {
        CallExpression(node) {
            const line = lineFor(node);

            /*
             * $.getJSON(target, ...)
             */
            if (isJQueryMethodCall(node, "getJSON")) {
                addFact(
                    resourceFacts,
                    resourceSeen,
                    {
                        type: "REQUESTS",
                        api: "$.getJSON",
                        target: describeTarget(source, node.arguments[0]),
                        line
                    }
                );
            }

            /*
             * $.get(target, ...)
             */
            if (isJQueryMethodCall(node, "get")) {
                addFact(
                    resourceFacts,
                    resourceSeen,
                    {
                        type: "REQUESTS",
                        api: "$.get",
                        target: describeTarget(source, node.arguments[0]),
                        line
                    }
                );
            }

            /*
             * $.getScript(target, ...)
             */
            if (isJQueryMethodCall(node, "getScript")) {
                addFact(
                    resourceFacts,
                    resourceSeen,
                    {
                        type: "IMPORTS",
                        api: "$.getScript",
                        target: describeTarget(source, node.arguments[0]),
                        line
                    }
                );

                addFact(
                    dynamicSites,
                    dynamicSeen,
                    {
                        type: "DYNAMIC_SCRIPT_LOAD",
                        api: "$.getScript",
                        line,
                        ...dynamicContextFor(node)
                    }
                );
            }

            /*
             * xhr.open("GET", target, ...)
             *
             * We intentionally require the first argument to be
             * a known HTTP method to reduce false positives from
             * unrelated objects that also have an open() method.
             */
            if (
                node.callee.type === "MemberExpression" &&
                getPropertyName(node.callee) === "open" &&
                xhrReceivers.has(getSourceText(source, node.callee.object))
            ) {
                const method = getLiteralString(node.arguments[0]);

                if (
                    method &&
                    [
                        "GET",
                        "POST",
                        "PUT",
                        "DELETE",
                        "PATCH",
                        "HEAD",
                        "OPTIONS"
                    ].includes(method.toUpperCase())
                ) {
                    addFact(
                        resourceFacts,
                        resourceSeen,
                        {
                            type: "REQUESTS",
                            api: "XMLHttpRequest.open",
                            method: method.toUpperCase(),
                            target: describeTarget(source, node.arguments[1]),
                            line
                        }
                    );
                }
            }

            /*
             * location.replace(...)
             * window.location.replace(...)
             * window.top.location.replace(...)
             */
            if (
                node.callee.type === "MemberExpression" &&
                getPropertyName(node.callee) === "replace" &&
                isLocationObject(node.callee.object)
            ) {
                addFact(
                    resourceFacts,
                    resourceSeen,
                    {
                        type: "NAVIGATES_TO",
                        api: "location.replace",
                        target: describeTarget(source, node.arguments[0]),
                        line
                    }
                );
            }

            /*
             * $('#tabs').tabs(...)
             *
             * Do NOT immediately classify HTML links as AJAX fragments.
             * We only record that jQuery UI Tabs is initialized on
             * this selector.
             */
            if (
                node.callee.type === "MemberExpression" &&
                getPropertyName(node.callee) === "tabs" &&
                (
                    node.arguments.length === 0 ||
                    node.arguments[0]?.type === "ObjectExpression"
                )
            ) {
                const selector = getJQuerySelector(node);

                if (selector !== null) {
                    addFact(
                        worldFacts,
                        worldSeen,
                        {
                            type: "JQUERY_TABS_INIT",
                            selector,
                            line
                        }
                    );
                }
            }

            /*
             * eval(...)
             */
            if (isIdentifier(node.callee, "eval")) {
                const staticCode = getLiteralString(node.arguments[0]);
                addFact(
                    dynamicSites,
                    dynamicSeen,
                    {
                        type: "EVAL",
                        line,
                        ...(staticCode === null ? {} : {
                            staticCode,
                            staticReferences:
                                inspectStaticCodeReferences(staticCode)
                        }),
                        ...dynamicContextFor(node)
                    }
                );
            }

            /*
             * document.write(...)
             */
            if (
                node.callee.type === "MemberExpression" &&
                isIdentifier(node.callee.object, "document") &&
                getPropertyName(node.callee) === "write"
            ) {
                addFact(
                    dynamicSites,
                    dynamicSeen,
                    {
                        type: "DOCUMENT_WRITE",
                        line,
                        ...dynamicContextFor(node)
                    }
                );
            }

            /*
             * setTimeout("some code", ...)
             *
             * Function callbacks are not recorded as dynamic-code sites.
             */
            if (
                isIdentifier(node.callee, "setTimeout") &&
                getLiteralString(node.arguments[0]) !== null
            ) {
                const staticCode = getLiteralString(node.arguments[0]);
                addFact(
                    dynamicSites,
                    dynamicSeen,
                    {
                        type: "STRING_SETTIMEOUT",
                        line,
                        staticCode,
                        staticReferences: inspectStaticCodeReferences(staticCode),
                        ...dynamicContextFor(node)
                    }
                );
            }

            /*
             * Custom loader observed in this package.
             */
            if (isIdentifier(node.callee, "load_scripts")) {
                addFact(
                    dynamicSites,
                    dynamicSeen,
                    {
                        type: "CUSTOM_SCRIPT_LOADER",
                        line,
                        ...dynamicContextFor(node)
                    }
                );
            }
        },


        NewExpression(node) {
            if (isIdentifier(node.callee, "Function")) {
                addFact(
                    dynamicSites,
                    dynamicSeen,
                    {
                        type: "NEW_FUNCTION",
                        line: lineFor(node),
                        ...dynamicContextFor(node)
                    }
                );
            }
        },


        MemberExpression(node) {
            /*
             * window[something]
             *
             * window["foo"] is statically known and therefore is
             * not considered dynamic here.
             */
            if (
                node.computed &&
                isIdentifier(node.object, "window") &&
                getLiteralString(node.property) === null
            ) {
                addFact(
                    dynamicSites,
                    dynamicSeen,
                    {
                        type: "DYNAMIC_WINDOW_PROPERTY",
                        expression: getSourceText(source, node),
                        line: lineFor(node),
                        ...dynamicContextFor(node)
                    }
                );
            }
        },


        Literal(node) {
            if (typeof node.value !== "string") {
                return;
            }

            for (const match of node.value.matchAll(RESOURCE_HINT_PATTERN)) {
                addFact(
                    resourceHints,
                    hintSeen,
                    {
                        type: "STRING_RESOURCE_HINT",
                        rawTarget: match[0],
                        line: lineFor(node)
                    }
                );
            }
        }
    });

    return {
        source: sourceId,
        parseError: null,
        resourceFacts,
        worldFacts,
        dynamicSites,
        resourceHints,
        literalAssignments: getTopLevelAssignments(ast, source)
            .filter(fact => fact.expression.type === "STRING")
            .map(fact => ({
            name: fact.name,
            value: fact.expression.value,
            kind: fact.kind,
            line: fact.line === null ? null : fact.line + lineOffset
        })),
        urlAssignments: getTopLevelAssignments(ast, source).map(fact => ({
            ...fact,
            line: fact.line === null ? null : fact.line + lineOffset
        })),
        urlHelpers: getSimpleUrlHelpers(ast, source).map(fact => ({
            ...fact,
            line: fact.line === null ? null : fact.line + lineOffset
        })),
        vendor
    };
}


async function inspectJsFile(wwwDirectory, file, vendorPatterns) {
    const fullPath = path.join(
        wwwDirectory,
        ...file.path.split("/")
    );

    const source = await fs.readFile(fullPath, "utf8");

    return inspectJavaScript(source, file.path, {
        vendor: isLikelyVendorSource(file.path, vendorPatterns)
    });
}


export async function buildJsFacts(
    wwwDirectory,
    inventory,
    htmlFacts,
    {
        vendorPatterns
    } = {}
) {
    const results = [];

    /*
     * External .js files
     */
    for (const file of inventory) {
        if (file.type !== "JS") {
            continue;
        }

        results.push(
            await inspectJsFile(wwwDirectory, file, vendorPatterns)
        );
    }

    /*
     * Inline <script> blocks
     */
    for (const html of htmlFacts) {
        for (const inlineScript of html.inlineScripts) {
            const sourceId = inlineScript.sourceId;

            results.push(
                inspectJavaScript(
                    inlineScript.code,
                    sourceId,
                    {
                        lineOffset: Math.max(0, (inlineScript.line ?? 1) - 1),
                        vendor: isLikelyVendorSource(sourceId, vendorPatterns)
                    }
                )
            );
        }

        /*
         * onclick="", onchange="", ...
         *
         * These are JavaScript too.
         */
        for (const handler of html.inlineHandlers) {
            const sourceId = handler.sourceId;

            results.push(
                inspectJavaScript(
                    handler.code,
                    sourceId,
                    {
                        allowReturnOutsideFunction: true,
                        lineOffset: Math.max(0, (handler.line ?? 1) - 1),
                        vendor: isLikelyVendorSource(sourceId, vendorPatterns)
                    }
                )
            );
        }
    }

    return results;
}
