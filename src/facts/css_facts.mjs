import fs from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { getPhysicalCandidate } from "../resolution/resource_utils.mjs";


function getUrlFunctionValue(node) {
    const valueNode = node.nodes?.find(child =>
        child.type === "string" || child.type === "word"
    );
    return valueNode?.value?.trim() || null;
}


function getImportTarget(params) {
    const parsed = valueParser(params);
    const first = parsed.nodes.find(node => node.type !== "space");

    if (!first) {
        return null;
    }

    if (first.type === "string" || first.type === "word") {
        return first.value;
    }

    if (first.type === "function" && first.value.toLowerCase() === "url") {
        return getUrlFunctionValue(first);
    }

    return null;
}


export function inspectCss(source, sourcePath, {
    vendor = false
} = {}) {
    let root;

    try {
        root = postcss.parse(source, {
            from: sourcePath
        });
    } catch (error) {
        return {
            path: sourcePath,
            parseError: error.message,
            references: [],
            vendor
        };
    }

    const references = [];

    root.walkAtRules("import", rule => {
        const rawTarget = getImportTarget(rule.params);

        if (!rawTarget) {
            return;
        }

        references.push({
            kind: "CSS_IMPORT",
            rawTarget,
            physicalCandidate: getPhysicalCandidate(sourcePath, rawTarget),
            property: null,
            line: rule.source?.start?.line ?? null
        });
    });

    root.walkDecls(declaration => {
        const parsed = valueParser(declaration.value);

        parsed.walk(node => {
            if (node.type !== "function" || node.value.toLowerCase() !== "url") {
                return;
            }

            const rawTarget = getUrlFunctionValue(node);

            if (!rawTarget) {
                return;
            }

            references.push({
                kind: "CSS_URL",
                rawTarget,
                physicalCandidate: getPhysicalCandidate(sourcePath, rawTarget),
                property: declaration.prop,
                line: declaration.source?.start?.line ?? null
            });
        });
    });

    return {
        path: sourcePath,
        parseError: null,
        references,
        vendor
    };
}


export async function buildCssFacts(wwwDirectory, inventory, {
    vendorPatterns = []
} = {}) {
    const results = [];

    for (const file of inventory) {
        if (file.type !== "CSS") {
            continue;
        }

        const fullPath = path.join(
            wwwDirectory,
            ...file.path.split("/")
        );
        const source = await fs.readFile(fullPath, "utf8");
        results.push(inspectCss(source, file.path, {
            vendor: vendorPatterns.some(pattern => pattern.test(file.path))
        }));
    }

    return results;
}
