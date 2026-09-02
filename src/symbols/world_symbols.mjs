function getGlobalScope(sourceFacts) {
    return sourceFacts.scopes.find(scope => scope.type === "global" && scope.upperScopeId === null) ?? null;
}


function createWorldGlobal(name) {
    return {
        name,
        declarations: [],
        references: [],
        reads: 0,
        writes: 0,
        multipleDeclarations: false
    };
}


function createUnresolvedGlobal(name) {
    return {
        name,
        references: [],
        reads: 0,
        writes: 0
    };
}


function addReference(target, sourceId, reference, resolution) {
    target.references.push({
        sourceId,
        resolution,
        ...reference
    });

    if (reference.read) {
        target.reads++;
    }

    if (reference.write) {
        target.writes++;
    }
}


export function buildWorldSymbolFacts(worldId, sourceIds, sourceFactsList) {
    const uniqueSourceIds = [...new Set(sourceIds)];
    const sourceFactsMap = new Map(
        sourceFactsList.map(sourceFacts => [
            sourceFacts.sourceId,
            sourceFacts
        ])
    );

    const globals = new Map();
    const unresolvedGlobals = new Map();
    const parseErrors = [];

    /*
     * Pass 1
     *
     * Collect every top-level declaration from every JS source
     * that belongs to this browser world.
     *
     * Same name across files belongs to the same world-global
     * symbol for now, while preserving every declaration site.
     */
    for (const sourceId of uniqueSourceIds) {
        const sourceFacts = sourceFactsMap.get(sourceId);

        if (!sourceFacts) {
            continue;
        }

        if (sourceFacts.parseError) {
            parseErrors.push({
                sourceId,
                error: sourceFacts.parseError
            });

            continue;
        }

        const globalScope = getGlobalScope(sourceFacts);

        if (!globalScope) {
            continue;
        }

        for (const variable of globalScope.variables) {
            /*
             * Ignore eslint-scope implicit variables.
             *
             * We only create a world symbol here when an actual
             * declaration exists in source.
             */
            if (variable.definitions.length === 0) {
                continue;
            }

            let worldGlobal = globals.get(variable.name);

            if (!worldGlobal) {
                worldGlobal = createWorldGlobal(variable.name);
                globals.set(variable.name, worldGlobal);
            }

            for (const definition of variable.definitions) {
                worldGlobal.declarations.push({
                    sourceId,
                    ...definition
                });
            }

            /*
             * References already resolved by eslint-scope inside
             * this source also belong to the world-global symbol.
             *
             * Example:
             *
             *   var x = 1;
             *   console.log(x);
             */
            for (const reference of variable.references) {
                addReference(
                    worldGlobal,
                    sourceId,
                    reference,
                    "SOURCE"
                );
            }
        }

        /*
         * Classic browser scripts can create an identifier-visible global
         * by explicitly assigning a static property on `window`:
         *
         *   window.foo = value;
         *
         * These supplemental facts remain distinguishable from eslint-scope
         * declarations. They establish world-level binding existence only;
         * this pass intentionally makes no execution-order guarantee.
         */
        for (const binding of sourceFacts.explicitGlobalBindings ?? []) {
            let worldGlobal = globals.get(binding.name);

            if (!worldGlobal) {
                worldGlobal = createWorldGlobal(binding.name);
                globals.set(binding.name, worldGlobal);
            }

            worldGlobal.declarations.push({ ...binding });
            addReference(
                worldGlobal,
                sourceId,
                {
                    name: binding.name,
                    read: false,
                    write: true,
                    line: binding.line,
                    column: binding.column,
                    referenceType: "GlobalObjectPropertyWrite",
                    object: binding.object
                },
                "SOURCE"
            );
        }
    }

    /*
     * Sloppy-mode unresolved `name = value` writes provide a browser-global
     * binding only when no ordinary or explicit window binding with that name
     * exists anywhere in this world. The first assignment supplies the single
     * declaration fact; every assignment site is retained below as a WORLD
     * write reference through eslint-scope's globalThrough facts.
     */
    for (const sourceId of uniqueSourceIds) {
        const sourceFacts = sourceFactsMap.get(sourceId);

        if (!sourceFacts || sourceFacts.parseError) {
            continue;
        }

        for (const candidate of sourceFacts.implicitGlobalCandidates ?? []) {
            if (globals.has(candidate.name)) {
                continue;
            }

            const worldGlobal = createWorldGlobal(candidate.name);
            worldGlobal.declarations.push({ ...candidate });
            globals.set(candidate.name, worldGlobal);
        }
    }

    /*
     * Static global-object property access is consumer/write evidence for an
     * already-established world binding. It never creates a binding here.
     */
    for (const sourceId of uniqueSourceIds) {
        const sourceFacts = sourceFactsMap.get(sourceId);

        if (!sourceFacts || sourceFacts.parseError) {
            continue;
        }

        for (const reference of sourceFacts.globalObjectReferences ?? []) {
            const worldGlobal = globals.get(reference.name);

            if (worldGlobal) {
                addReference(worldGlobal, sourceId, reference, "WORLD");
            }
        }
    }

    /*
     * Pass 2
     *
     * globalThrough means:
     *
     *   "This individual JS source could not resolve this name."
     *
     * Now try again using declarations from every source in the
     * same browser world.
     */
    for (const sourceId of uniqueSourceIds) {
        const sourceFacts = sourceFactsMap.get(sourceId);

        if (!sourceFacts || sourceFacts.parseError) {
            continue;
        }

        for (const reference of sourceFacts.globalThrough) {
            const worldGlobal = globals.get(reference.name);

            if (worldGlobal) {
                addReference(
                    worldGlobal,
                    sourceId,
                    reference,
                    "WORLD"
                );

                continue;
            }

            /*
             * Still unresolved even after searching the whole world.
             *
             * This may be:
             *
             *   window
             *   document
             *   console
             *   $
             *   setTimeout
             *
             * or a genuinely missing application global.
             *
             * We do NOT classify it yet.
             */
            let unresolved = unresolvedGlobals.get(reference.name);

            if (!unresolved) {
                unresolved = createUnresolvedGlobal(reference.name);
                unresolvedGlobals.set(reference.name, unresolved);
            }

            addReference(
                unresolved,
                sourceId,
                reference,
                "UNRESOLVED"
            );
        }
    }

    for (const symbol of globals.values()) {
        symbol.multipleDeclarations =
            symbol.declarations.length > 1;
    }

    return {
        worldId,

        sourceIds: uniqueSourceIds,

        globals: [...globals.values()]
            .sort((a, b) => a.name.localeCompare(b.name)),

        unresolvedGlobals: [...unresolvedGlobals.values()]
            .sort((a, b) => a.name.localeCompare(b.name)),

        parseErrors
    };
}
