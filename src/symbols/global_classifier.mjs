import globals from "globals";
import {
    DEFAULT_LIBRARY_GLOBAL_PROVIDERS
} from "../config/analyzer_config.mjs";


const PLATFORM_GLOBAL_NAMES = new Set([
    ...Object.keys(globals.browser),
    ...Object.keys(globals.es2021)
]);


function findLibraryProvider(name, sources, libraryGlobals) {
    for (const provider of libraryGlobals) {
        if (!provider.names.includes(name)) {
            continue;
        }

        const source = sources.find(source => {
            const sourcePath = source.filePath ?? source.sourceId ?? "";

            return provider.sourcePatterns.some(pattern =>
                pattern.test(sourcePath)
            );
        });

        if (source) {
            return {
                library: provider.library,
                sourceId: source.sourceId,
                filePath: source.filePath ?? null
            };
        }
    }

    return null;
}


export function classifyWorldGlobals(worldSymbolFacts, {
    libraryGlobals: libraryGlobalProviders = DEFAULT_LIBRARY_GLOBAL_PROVIDERS
} = {}) {
    const platformGlobals = [];
    const libraryGlobals = [];
    const unknownGlobals = [];

    for (const symbol of worldSymbolFacts.unresolvedGlobals) {
        if (PLATFORM_GLOBAL_NAMES.has(symbol.name)) {
            platformGlobals.push({
                ...symbol,
                classification: "PLATFORM_GLOBAL"
            });

            continue;
        }

        const libraryProvider = findLibraryProvider(
            symbol.name,
            worldSymbolFacts.sources,
            libraryGlobalProviders
        );

        if (libraryProvider) {
            libraryGlobals.push({
                ...symbol,
                classification: "LIBRARY_GLOBAL",
                provider: libraryProvider
            });

            continue;
        }

        unknownGlobals.push({
            ...symbol,
            classification: "UNKNOWN_GLOBAL"
        });
    }

    return {
        platformGlobals,
        libraryGlobals,
        unknownGlobals
    };
}
