import * as acorn from "acorn";
import * as walk from "acorn-walk";
import * as eslintScope from "eslint-scope";


function getLocation(node, lineOffset = 0) {
    if (!node?.loc) {
        return {
            line: null,
            column: null
        };
    }

    return {
        line: node.loc.start.line + lineOffset,
        column: node.loc.start.column
    };
}


function getDefinitionLocation(definition, lineOffset) {
    if (definition.name) {
        return getLocation(definition.name, lineOffset);
    }

    return getLocation(definition.node, lineOffset);
}


function buildDefinitionFact(definition, lineOffset) {
    const initializer = definition.type === "Variable"
        ? definition.node?.init
        : null;
    const initializerSideEffectRisk = Boolean(
        initializer &&
        ![
            "Literal",
            "Identifier",
            "FunctionExpression",
            "ArrowFunctionExpression"
        ].includes(initializer.type)
    );

    return {
        type: definition.type,
        initializerSideEffectRisk,
        ...getDefinitionLocation(definition, lineOffset)
    };
}


function buildReferenceFact(reference, lineOffset) {
    return {
        name: reference.identifier.name,
        read: reference.isRead(),
        write: reference.isWrite(),
        ...getLocation(reference.identifier, lineOffset)
    };
}


function collectResolvedReferencesByVariable(scopeManager) {
    const referencesByVariable = new Map();

    for (const scope of scopeManager.scopes) {
        for (const reference of scope.references) {
            if (!reference.resolved || reference.init === true) {
                continue;
            }

            if (!referencesByVariable.has(reference.resolved)) {
                referencesByVariable.set(reference.resolved, []);
            }

            referencesByVariable.get(reference.resolved).push(reference);
        }
    }

    return referencesByVariable;
}


function buildVariableFact(variable, resolvedReferences, lineOffset) {
    const definitions = variable.defs.map(definition =>
        buildDefinitionFact(definition, lineOffset)
    );
    const references = resolvedReferences.map(reference =>
        buildReferenceFact(reference, lineOffset)
    );

    return {
        name: variable.name,

        definitions,

        declarationTypes: [
            ...new Set(definitions.map(definition => definition.type))
        ],

        reads: references.filter(reference => reference.read).length,
        writes: references.filter(reference => reference.write).length,

        references,

        /*
         * Example:
         *   arguments
         *
         * eslint-scope creates it automatically even though
         * the source does not explicitly declare it.
         */
        implicit:
            variable.defs.length === 0 &&
            variable.identifiers.length === 0
    };
}


function collectExplicitGlobalBindings(
    ast,
    scopeManager,
    sourceId,
    lineOffset
) {
    const bindings = [];
    const locallyResolvedIdentifiers = new Set(
        scopeManager.scopes.flatMap(scope =>
            scope.references
                .filter(reference => reference.resolved)
                .map(reference => reference.identifier)
        )
    );

    walk.simple(ast, {
        AssignmentExpression(node) {
            if (
                node.operator !== "=" ||
                node.left.type !== "MemberExpression" ||
                node.left.computed ||
                node.left.object.type !== "Identifier" ||
                node.left.object.name !== "window" ||
                node.left.property.type !== "Identifier" ||
                locallyResolvedIdentifiers.has(node.left.object)
            ) {
                return;
            }

            bindings.push({
                name: node.left.property.name,
                type: "GlobalObjectProperty",
                object: "window",
                sourceId,
                ...getLocation(node.left, lineOffset)
            });
        }
    });

    return bindings;
}


function collectGlobalObjectReferences(
    ast,
    scopeManager,
    sourceId,
    lineOffset
) {
    const references = [];
    const locallyResolvedIdentifiers = new Set(
        scopeManager.scopes.flatMap(scope =>
            scope.references
                .filter(reference => reference.resolved)
                .map(reference => reference.identifier)
        )
    );

    walk.ancestor(ast, {
        MemberExpression(node, ancestors) {
            if (
                node.object.type !== "Identifier" ||
                node.object.name !== "window" ||
                locallyResolvedIdentifiers.has(node.object)
            ) {
                return;
            }

            const name = !node.computed && node.property.type === "Identifier"
                ? node.property.name
                : node.computed &&
                    node.property.type === "Literal" &&
                    typeof node.property.value === "string"
                    ? node.property.value
                    : null;

            if (name === null) {
                return;
            }

            const parent = ancestors.at(-2);
            let read = true;
            let write = false;

            if (
                parent?.type === "AssignmentExpression" &&
                parent.left === node
            ) {
                read = parent.operator !== "=";
                write = true;

                /*
                 * Non-computed `window.foo = value` is already represented
                 * by explicitGlobalBindings and its provider write.
                 */
                if (parent.operator === "=" && !node.computed) {
                    return;
                }
            } else if (
                parent?.type === "UpdateExpression" &&
                parent.argument === node
            ) {
                read = true;
                write = true;
            }

            references.push({
                name,
                object: "window",
                sourceId,
                read,
                write,
                referenceType: "GlobalObjectPropertyReference",
                ...getLocation(node, lineOffset)
            });
        }
    });

    return references;
}


function collectImplicitGlobalCandidates(
    ast,
    scopeManager,
    sourceId,
    lineOffset
) {
    const candidates = [];
    const referencesByIdentifier = new Map();

    function hasDefinitionInScopeChain(scope, name) {
        for (let current = scope; current; current = current.upper) {
            const variable = current.variables.find(item =>
                item.name === name && item.defs.length > 0
            );

            if (variable) {
                return true;
            }
        }

        return false;
    }

    /*
     * AST shape alone is not enough here. A simple identifier assignment
     * creates a sloppy-mode global only when lexical resolution did not find
     * a local, parameter, or declared global binding.
     */
    for (const scope of scopeManager.scopes) {
        for (const reference of scope.references) {
            referencesByIdentifier.set(reference.identifier, {
                reference,
                scope
            });
        }
    }

    walk.simple(ast, {
        AssignmentExpression(node) {
            if (
                node.operator !== "=" ||
                node.left.type !== "Identifier"
            ) {
                return;
            }

            const resolvedReference = referencesByIdentifier.get(node.left);

            if (
                !resolvedReference ||
                resolvedReference.reference.resolved ||
                !resolvedReference.reference.isWrite() ||
                resolvedReference.scope.isStrict ||
                hasDefinitionInScopeChain(
                    resolvedReference.scope,
                    node.left.name
                )
            ) {
                return;
            }

            candidates.push({
                name: node.left.name,
                type: "ImplicitGlobalAssignment",
                sourceId,
                operator: node.operator,
                ...getLocation(node.left, lineOffset)
            });
        }
    });

    return candidates;
}


export function buildSymbolFacts(
    source,
    sourceId,
    {
        allowReturnOutsideFunction = false,
        functionBody = false,
        lineOffset = 0
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
            /*
             * Direct eval remains dynamic-risk evidence in the JavaScript
             * facts layer, but it must not erase statically resolvable lexical
             * references in this layer. Without ignoreEval, eslint-scope marks
             * the containing scope dynamic and leaves ordinary identifiers
             * unresolved even when their binding is unambiguous in the AST.
             */
            ignoreEval: true,

            /*
             * Inline event handlers execute as browser-created functions.
             * eslint-scope's Node.js wrapper option provides the same relevant
             * scope boundary without changing source text or source locations:
             * top-level `var`/function declarations stay local to the handler,
             * while free identifiers still flow through the global scope for
             * later world-level resolution.
             */
            nodejsScope: functionBody
        });
    } catch (error) {
        return {
            sourceId,
            parseError: error.message,
            scopes: [],
            globalThrough: [],
            explicitGlobalBindings: [],
            implicitGlobalCandidates: [],
            globalObjectReferences: []
        };
    }

    const scopeIds = new Map();

    scopeManager.scopes.forEach((scope, index) => {
        scopeIds.set(
            scope,
            `${sourceId}#scope:${index}`
        );
    });

    const resolvedReferencesByVariable =
        collectResolvedReferencesByVariable(scopeManager);

    const scopes = scopeManager.scopes.map(scope => {
        const variables = scope.variables.map(variable =>
            buildVariableFact(
                variable,
                resolvedReferencesByVariable.get(variable) ?? [],
                lineOffset
            )
        );

        const through = scope.through.map(reference =>
            buildReferenceFact(reference, lineOffset)
        );

        return {
            id: scopeIds.get(scope),
            type: scope.type,

            upperScopeId:
                scope.upper
                    ? scopeIds.get(scope.upper)
                    : null,

            variables,
            through
        };
    });

    /*
     * Important:
     *
     * through on a FUNCTION scope does not necessarily mean
     * globally unresolved.
     *
     * Example:
     *
     *   var x;
     *
     *   function foo() {
     *       return x;
     *   }
     *
     * x is "through" foo's scope, but resolves in the
     * outer global scope.
     *
     * Only globalScope.through means this individual source
     * cannot resolve the identifier.
     *
     * Later World-level analysis will try to resolve these
     * against declarations from other scripts in the same world.
     */
    const globalThrough =
        scopeManager.globalScope?.through.map(reference =>
            buildReferenceFact(reference, lineOffset)
        ) ?? [];

    /*
     * This is existence-of-binding evidence for a browser world, not a
     * temporal definite-assignment claim. Script order, reachability, and
     * whether a read occurs before the write remain outside this layer.
     */
    const explicitGlobalBindings = collectExplicitGlobalBindings(
        ast,
        scopeManager,
        sourceId,
        lineOffset
    );

    const implicitGlobalCandidates = collectImplicitGlobalCandidates(
        ast,
        scopeManager,
        sourceId,
        lineOffset
    );

    const globalObjectReferences = collectGlobalObjectReferences(
        ast,
        scopeManager,
        sourceId,
        lineOffset
    );

    return {
        sourceId,
        parseError: null,
        scopes,
        globalThrough,
        explicitGlobalBindings,
        implicitGlobalCandidates,
        globalObjectReferences
    };
}
