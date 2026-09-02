import * as acorn from "acorn";
import * as walk from "acorn-walk";
import * as eslintScope from "eslint-scope";


function getStaticPropertyName(node) {
    if (!node || node.type !== "MemberExpression") {
        return null;
    }

    if (!node.computed && node.property.type === "Identifier") {
        return node.property.name;
    }

    if (
        node.computed &&
        node.property.type === "Literal" &&
        typeof node.property.value === "string"
    ) {
        return node.property.value;
    }

    return null;
}


function getLiteralString(node) {
    return node?.type === "Literal" && typeof node.value === "string"
        ? node.value
        : null;
}


function accessModeFor(node, parent) {
    if (parent?.type === "AssignmentExpression" && parent.left === node) {
        return parent.operator === "=" ? "WRITE" : "READ_WRITE";
    }

    if (parent?.type === "UpdateExpression" && parent.argument === node) {
        return "READ_WRITE";
    }

    if (
        parent?.type === "UnaryExpression" &&
        parent.operator === "delete" &&
        parent.argument === node
    ) {
        return "WRITE";
    }

    return "READ";
}


function isNamedMemberCall(node, objectName, propertyName) {
    return node?.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        getStaticPropertyName(node.callee) === propertyName &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === objectName;
}


function inspectParsedSource(
    source,
    sourceId,
    {
        allowReturnOutsideFunction = false,
        functionBody = false,
        lineOffset = 0,
        inspectStringCode = true
    } = {}
) {
    let ast;
    let scopeManager;

    try {
        ast = acorn.parse(source, {
            ecmaVersion: "latest",
            sourceType: "script",
            locations: true,
            ranges: true,
            allowHashBang: true,
            allowReturnOutsideFunction
        });
        scopeManager = eslintScope.analyze(ast, {
            ecmaVersion: 2022,
            sourceType: "script",
            nodejsScope: functionBody
        });
    } catch (error) {
        return {
            sourceId,
            parseError: error.message,
            accesses: [],
            riskSites: []
        };
    }

    const resolvedIdentifiers = new Set(
        scopeManager.scopes.flatMap(scope =>
            scope.references
                .filter(reference => reference.resolved)
                .map(reference => reference.identifier)
        )
    );
    const accesses = [];
    const riskSites = [];
    const lineFor = node => node.loc?.start.line === undefined
        ? null
        : node.loc.start.line + lineOffset;
    const rawFor = node => source.slice(node.start, node.end);

    function isUnshadowedIdentifier(node, name) {
        return node?.type === "Identifier" &&
            node.name === name &&
            !resolvedIdentifiers.has(node);
    }

    function getLmParamRoot(node) {
        if (isUnshadowedIdentifier(node, "LM_PARAM")) {
            return {
                form: "GLOBAL_IDENTIFIER",
                node
            };
        }

        if (
            node?.type === "MemberExpression" &&
            getStaticPropertyName(node) === "LM_PARAM" &&
            isUnshadowedIdentifier(node.object, "window")
        ) {
            return {
                form: node.computed
                    ? "WINDOW_BRACKET"
                    : "WINDOW_DOT",
                node
            };
        }

        return null;
    }

    function addAccess(field, node, accessMode, accessForm, extra = {}) {
        accesses.push({
            field,
            sourceId,
            line: lineFor(node),
            accessMode,
            accessForm,
            raw: rawFor(node),
            ...extra
        });
    }

    function addRisk(type, node, extra = {}) {
        riskSites.push({
            type,
            sourceId,
            line: lineFor(node),
            raw: rawFor(node),
            ...extra
        });
    }

    function inspectDestructuring(pattern, rootNode) {
        for (const property of pattern.properties) {
            if (property.type === "RestElement") {
                addRisk("UNSUPPORTED_LM_PARAM_DESTRUCTURING", property);
                continue;
            }

            const field = !property.computed &&
                property.key.type === "Identifier"
                ? property.key.name
                : property.key.type === "Literal" &&
                    typeof property.key.value === "string"
                    ? property.key.value
                    : null;

            if (field === null) {
                addRisk("UNSUPPORTED_LM_PARAM_DESTRUCTURING", property);
                continue;
            }

            addAccess(
                field,
                property,
                "READ",
                "DESTRUCTURING",
                { rawRoot: rawFor(rootNode) }
            );
        }
    }

    function inspectWholeObject(rootNode, parent) {
        if (
            parent?.type === "VariableDeclarator" &&
            parent.init === rootNode &&
            parent.id.type === "ObjectPattern"
        ) {
            inspectDestructuring(parent.id, rootNode);
            return;
        }

        if (
            parent?.type === "AssignmentExpression" &&
            parent.right === rootNode &&
            parent.left.type === "ObjectPattern"
        ) {
            inspectDestructuring(parent.left, rootNode);
            return;
        }

        if (parent?.type === "ForInStatement" && parent.right === rootNode) {
            addRisk("LM_PARAM_ENUMERATION", rootNode);
            return;
        }

        if (parent?.type === "CallExpression") {
            if (
                ["keys", "entries", "values"].some(method =>
                    isNamedMemberCall(parent, "Object", method)
                )
            ) {
                addRisk("LM_PARAM_ENUMERATION", rootNode);
                return;
            }

            if (isNamedMemberCall(parent, "JSON", "stringify")) {
                addRisk("LM_PARAM_SERIALIZATION", rootNode);
                return;
            }
        }

        if (
            parent?.type === "UnaryExpression" &&
            parent.operator === "typeof"
        ) {
            return;
        }

        /*
         * Legacy initialization guards such as
         * `LM_PARAM || (LM_PARAM = {})` test object existence only; they do
         * not enumerate, serialize, or pass backend fields elsewhere.
         */
        if (parent?.type === "LogicalExpression") {
            return;
        }

        if (
            parent?.type === "AssignmentExpression" &&
            parent.left === rootNode
        ) {
            return;
        }

        addRisk("LM_PARAM_OBJECT_ESCAPE", rootNode);
    }

    walk.ancestor(ast, {
        MemberExpression(node, ancestors) {
            const root = getLmParamRoot(node.object);

            if (!root) {
                return;
            }

            const parent = ancestors.at(-2);
            const field = getStaticPropertyName(node);

            if (field === null) {
                addRisk("DYNAMIC_LM_PARAM_PROPERTY_ACCESS", node, {
                    propertyExpression: rawFor(node.property)
                });
                return;
            }

            addAccess(
                field,
                node,
                accessModeFor(node, parent),
                `${root.form}_${node.computed ? "BRACKET" : "DOT"}`
            );
        },

        Identifier(node, ancestors) {
            if (!isUnshadowedIdentifier(node, "LM_PARAM")) {
                return;
            }

            const parent = ancestors.at(-2);

            if (parent?.type === "MemberExpression") {
                if (parent.object === node) {
                    return;
                }

                /* Non-computed property identifiers are property names. */
                if (!parent.computed && parent.property === node) {
                    return;
                }
            }

            inspectWholeObject(node, parent);
        },

        CallExpression(node) {
            if (!inspectStringCode) {
                return;
            }

            const isEval = node.callee.type === "Identifier" &&
                node.callee.name === "eval";
            const isStringTimeout = node.callee.type === "Identifier" &&
                node.callee.name === "setTimeout";

            if (!isEval && !isStringTimeout) {
                return;
            }

            const code = getLiteralString(node.arguments[0]);

            if (code === null) {
                if (isEval) {
                    addRisk("RUNTIME_DYNAMIC_CODE", node);
                }
                return;
            }

            const nested = inspectParsedSource(code, sourceId, {
                inspectStringCode: false
            });

            if (nested.parseError) {
                if (code.includes("LM_PARAM")) {
                    addRisk("UNPARSEABLE_STATIC_DYNAMIC_CODE", node);
                }
                return;
            }

            for (const access of nested.accesses) {
                accesses.push({
                    ...access,
                    line: lineFor(node),
                    accessForm: `STATIC_DYNAMIC_CODE_${access.accessForm}`,
                    dynamicCodeType: isEval ? "EVAL" : "STRING_SETTIMEOUT"
                });
            }

            for (const risk of nested.riskSites) {
                riskSites.push({
                    ...risk,
                    line: lineFor(node),
                    dynamicCodeType: isEval ? "EVAL" : "STRING_SETTIMEOUT"
                });
            }
        },

        NewExpression(node) {
            if (
                node.callee.type === "Identifier" &&
                node.callee.name === "Function"
            ) {
                addRisk("RUNTIME_DYNAMIC_CODE", node);
            }
        }
    });

    /*
     * `window.LM_PARAM` is represented by a MemberExpression rather than an
     * Identifier named LM_PARAM. Inspect standalone whole-object uses in a
     * second narrow pass, while skipping the object of a field access.
     */
    walk.ancestor(ast, {
        MemberExpression(node, ancestors) {
            if (!getLmParamRoot(node) || node.object.type !== "Identifier") {
                return;
            }

            const parent = ancestors.at(-2);

            if (parent?.type === "MemberExpression" && parent.object === node) {
                return;
            }

            inspectWholeObject(node, parent);
        }
    });

    return {
        sourceId,
        parseError: null,
        accesses,
        riskSites
    };
}


export function inspectLmParamSource(source, sourceId, options = {}) {
    return inspectParsedSource(source, sourceId, options);
}
