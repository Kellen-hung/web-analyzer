import { buildInventory } from "./inventory/inventory.mjs";
import { buildHtmlFacts } from "./facts/html_facts.mjs";
import { buildJsFacts } from "./facts/js_facts.mjs";
import { buildCssFacts } from "./facts/css_facts.mjs";
import { buildCorpusFacts } from "./facts/corpus_facts.mjs";
import { resolveWorlds } from "./resolution/world_resolver.mjs";
import { buildFileReport } from "./report/file_report.mjs";


export async function analyzePackage(
    wwwDirectory,
    {
        entryDocuments = []
    } = {}
) {
    const inventory = await buildInventory(wwwDirectory);
    const htmlFacts = await buildHtmlFacts(wwwDirectory, inventory);
    const jsFacts = await buildJsFacts(
        wwwDirectory,
        inventory,
        htmlFacts
    );
    const cssFacts = await buildCssFacts(wwwDirectory, inventory);
    const corpusFacts = await buildCorpusFacts(inventory);
    const worldResolution = resolveWorlds({
        inventory,
        htmlFacts,
        jsFacts,
        corpusFacts,
        entryDocuments
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
        fileReport
    };
}
