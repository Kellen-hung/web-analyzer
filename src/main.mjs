import fs from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { analyzePackage } from "./analyzer.mjs";


const WWW_DIR = path.resolve("input/www");
const CONFIG_PATH = path.resolve("analyzer.config.json");
const VERBOSE = process.argv.slice(2).includes("--verbose");
const colors = pc.createColors(
    Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env)
);


function countBy(items, getKey) {
    const counts = new Map();
    for (const item of items) {
        const key = getKey(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right));
}


function heading(label) {
    console.log(colors.bold(colors.cyan(label)));
}


function status(label, value) {
    const paint = {
        packaged: colors.green,
        missing: colors.yellow,
        partial: colors.yellow,
        unresolved: colors.yellow,
        high: colors.red,
        medium: colors.yellow
    }[label.toLowerCase()] ?? (text => text);
    return paint(value);
}


async function readConfig() {
    const source = await fs.readFile(CONFIG_PATH, "utf8");
    const config = JSON.parse(source);
    if (!Array.isArray(config.entryDocuments)) {
        throw new Error("analyzer.config.json must contain entryDocuments[]");
    }
    return config;
}


function printInventory(inventory) {
    heading(`Inventory · ${inventory.length} files`);
    console.log(`  ${countBy(inventory, file => file.type)
        .map(([type, count]) => `${type} ${count}`)
        .join(" · ")}`);
    console.log();
}


function printWorldSummary(worlds) {
    heading(`Worlds · ${worlds.length}`);
    for (const world of worlds) {
        const fragmentCount = world.htmlMembers.filter(member =>
            member.role === "AJAX_FRAGMENT"
        ).length;
        console.log(
            `  ${colors.bold(world.document)}` +
            ` · ${world.kind}` +
            ` · HTML ${world.htmlMembers.length}` +
            ` · fragments ${fragmentCount}` +
            ` · scripts ${world.scriptLoads.length}` +
            ` · iframes ${world.iframeChildren.length}`
        );
    }
    console.log();
}


function printWorldDetails(worlds) {
    heading("World details");
    for (const world of worlds) {
        console.log(`  ${colors.bold(world.id)} document=${world.document} kind=${world.kind}`);
        if (world.parentWorldId) {
            console.log(`    parent=${world.parentWorldId}`);
        }
        for (const member of world.htmlMembers) {
            console.log(`    HTML ${member.role} ${member.path} base=${member.runtimeBase}`);
        }
        for (const load of world.scriptLoads) {
            console.log(
                `    JS ${load.kind} ${load.sourceId}` +
                ` scope=${load.orderScope} order=${load.localOrder ?? "event/async"}`
            );
        }
        for (const binding of world.literalBindings) {
            console.log(`    BIND ${binding.name}=${JSON.stringify(binding.value)} source=${binding.source}`);
        }
    }
    console.log();
}


function printHtmlRoles(htmlRoles, verbose) {
    heading("HTML roles");
    console.log(`  ${countBy(htmlRoles, role => role.role)
        .map(([role, count]) => `${role} ${count}`)
        .join(" · ")}`);
    if (verbose) {
        for (const role of htmlRoles) {
            const contextual = role.ambiguous
                ? ` contextual=${role.roles.join(",")}`
                : "";
            console.log(`  ${role.role} ${role.path}${contextual}`);
        }
    }
    console.log();
}


function printMissing(references) {
    heading(`Referenced but not packaged · ${references.length}`);
    if (references.length === 0) {
        console.log(`  ${status("packaged", "none")}`);
    }
    for (const reference of references) {
        const evidenceTypes = [...new Set(
            reference.evidence.map(item => item.evidenceType)
        )].join(",");
        const paintedEvidence = evidenceTypes.includes("BINARY_STRING_REF")
            ? colors.magenta(evidenceTypes)
            : evidenceTypes;
        console.log(
            `  ${status("missing", reference.target)}` +
            ` · evidence ${reference.evidence.length}` +
            ` · ${paintedEvidence}`
        );
    }
    console.log();
}


function printCandidates(candidates) {
    heading(`File candidates · ${candidates.length}`);
    if (candidates.length === 0) {
        console.log("  none");
    }
    for (const candidate of candidates) {
        console.log(
            `  ${status(candidate.confidence, candidate.confidence)}` +
            ` ${candidate.path} (${candidate.type})`
        );
        if (VERBOSE) {
            console.log(`    ${colors.dim(candidate.note)}`);
        }
    }
    console.log();
}


function printCorpus(corpusFacts) {
    heading("Corpus findings");
    for (const source of corpusFacts) {
        console.log(`  ${source.source} · ${source.evidenceType}`);
        for (const reference of source.references) {
            const first = reference.occurrences[0];
            const location = first.line !== null
                ? `line=${first.line}`
                : `offset=${first.offset}`;
            console.log(
                `    ${reference.classification}` +
                ` raw=${JSON.stringify(reference.rawTarget)}` +
                ` target=${reference.target} ${location}`
            );
        }
    }
    console.log();
}


function printResolutionEvidence(fileReport, verbose) {
    const partial = fileReport.partialReferences;
    const unresolved = fileReport.unresolvedReferences;
    heading("Unresolved evidence");
    console.log(
        `  ${status("partial", `PARTIALLY_RESOLVED ${partial.length}`)}` +
        ` · ${status("unresolved", `UNRESOLVED ${unresolved.length}`)}` +
        " · retained, never classified as missing"
    );
    if (verbose) {
        for (const reference of [...partial, ...unresolved]) {
            const state = reference.urlResolutionState ?? "UNRESOLVED";
            console.log(
                `  ${status(state === "PARTIALLY_RESOLVED" ? "partial" : "unresolved", state)}` +
                ` ${reference.source}:${reference.line ?? "?"}` +
                ` api=${reference.api ?? reference.relation}` +
                ` raw=${JSON.stringify(reference.rawTarget)}` +
                ` reason=${reference.reason}`
            );
        }
    }
    console.log();
}


async function main() {
    const config = await readConfig();
    const result = await analyzePackage(WWW_DIR, config);

    console.log(colors.bold("rx-web-analyzer · Phase 1 evidence report"));
    console.log(colors.dim(`root=${WWW_DIR}${VERBOSE ? " · verbose" : ""}`));
    console.log();
    printInventory(result.inventory);
    printWorldSummary(result.worldResolution.worlds);
    if (VERBOSE) {
        printWorldDetails(result.worldResolution.worlds);
    }
    printHtmlRoles(result.worldResolution.htmlRoles, VERBOSE);
    printMissing(result.fileReport.referencedButNotPackaged);
    printCandidates(result.fileReport.candidates);
    printResolutionEvidence(result.fileReport, VERBOSE);
    if (VERBOSE) {
        printCorpus(result.corpusFacts);
    }
}


main().catch(error => {
    console.error(colors.red(error.stack ?? error.message));
    process.exitCode = 1;
});
