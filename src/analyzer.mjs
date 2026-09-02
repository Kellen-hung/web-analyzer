import { buildInventory } from "./inventory/inventory.mjs";
import { buildHtmlFacts } from "./facts/html_facts.mjs";
import { buildJsFacts } from "./facts/js_facts.mjs";
import { buildCssFacts } from "./facts/css_facts.mjs";
import { buildCorpusFacts } from "./facts/corpus_facts.mjs";
import { resolveWorlds } from "./resolution/world_resolver.mjs";
import { buildFileReport } from "./report/file_report.mjs";
import { buildWorldSymbolAnalysis } from "./symbols/world_symbol_analyzer.mjs";
import { buildSymbolCleanupCandidates } from "./symbols/symbol_candidate_analyzer.mjs";
import { analyzeLmParams } from "./lm_params/lm_param_analyzer.mjs";


export async function analyzePackage(
    wwwDirectory,
    {
        entryDocuments = [],
        lmParamJsonPath = null,
        libraryGlobals,
        vendorJsPatterns,
        vendorCssPatterns
    } = {}
) {
    const inventory = await buildInventory(wwwDirectory);
    const htmlFacts = await buildHtmlFacts(wwwDirectory, inventory);
    const jsFacts = await buildJsFacts(
        wwwDirectory,
        inventory,
        htmlFacts,
        {
            vendorPatterns: vendorJsPatterns
        }
    );
    const cssFacts = await buildCssFacts(wwwDirectory, inventory, {
        vendorPatterns: vendorCssPatterns
    });
    const corpusFacts = await buildCorpusFacts(inventory);
    const worldResolution = resolveWorlds({
        inventory,
        htmlFacts,
        jsFacts,
        corpusFacts,
        entryDocuments
    });
    const symbolAnalysis = await buildWorldSymbolAnalysis({
        wwwDirectory,
        worldResolution,
        htmlFacts,
        libraryGlobals
    });
    const symbolCandidates = buildSymbolCleanupCandidates({
        symbolAnalysis,
        worldResolution,
        jsFacts
    });
    const lmParamAnalysis = await analyzeLmParams({
        wwwDirectory,
        lmParamJsonPath,
        worldResolution,
        htmlFacts,
        jsFacts
    });
    const fileReport = buildFileReport({
        inventory,
        cssFacts,
        jsFacts,
        corpusFacts,
        worldResolution
    });

    return {
        inventory,
        htmlFacts,
        jsFacts,
        cssFacts,
        corpusFacts,
        worldResolution,
        fileReport,
        symbolAnalysis,
        symbolCandidates,
        lmParamAnalysis
    };
}
