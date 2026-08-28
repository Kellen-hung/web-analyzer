import fs from "node:fs/promises";


const RESOURCE_PATTERN =
    /(?:\/www\/[A-Za-z0-9_.\-/]+|\/?[A-Za-z0-9_.\-/]+\.(?:html?|js|css|png|jpe?g|gif|webp|ico|svg|cgi|json|txt))(?:\?[^?\s"'<>]+)?/gi;

const DEVICE_PATH_PREFIX =
    /^\/(?:share|temppatch|dev|var|etc|tmp|proc|sys|run|mnt|usr|bin|sbin|lib)(?:\/|$)/;


function extractAsciiStrings(buffer, minLength = 4) {
    const strings = [];
    let current = "";
    let startOffset = 0;

    for (let offset = 0; offset < buffer.length; offset++) {
        const byte = buffer[offset];
        const printable = byte >= 0x20 && byte <= 0x7e;

        if (printable) {
            if (!current) {
                startOffset = offset;
            }
            current += String.fromCharCode(byte);
            continue;
        }

        if (current.length >= minLength) {
            strings.push({
                text: current,
                offset: startOffset,
                line: null
            });
        }

        current = "";
    }

    if (current.length >= minLength) {
        strings.push({
            text: current,
            offset: startOffset,
            line: null
        });
    }

    return strings;
}


function extractTextLines(buffer) {
    return buffer.toString("utf8")
        .split(/\r?\n/)
        .map((text, index) => ({
            text,
            line: index + 1,
            offset: null
        }));
}


function cleanResourceTarget(rawTarget) {
    let target = rawTarget
        .split(/[?#]/, 1)[0]
        .replaceAll("\\", "/");

    if (target.startsWith("/www/")) {
        target = target.slice("/www/".length);
    } else if (target.startsWith("/")) {
        target = target.slice(1);
    }

    return target;
}


function classifyReference(rawTarget, target, inventoryPaths) {
    if (DEVICE_PATH_PREFIX.test(rawTarget)) {
        return "DEVICE_PATH";
    }

    if (rawTarget.startsWith("/www/")) {
        return inventoryPaths.has(target)
            ? "PACKAGE_RESOURCE"
            : "MISSING_WEB_RESOURCE";
    }

    if (rawTarget.startsWith("/")) {
        return inventoryPaths.has(target)
            ? "PACKAGE_RESOURCE"
            : "ABSOLUTE_PATH_UNKNOWN";
    }

    return "RELATIVE_REFERENCE";
}


function extractResourceStrings(strings) {
    const refsByKey = new Map();

    for (const item of strings) {
        for (const match of item.text.matchAll(RESOURCE_PATTERN)) {
            const rawTarget = match[0];
            const target = cleanResourceTarget(rawTarget);
            const key = `${rawTarget}\0${target}`;
            const occurrence = {
                line: item.line,
                offset: item.offset === null
                    ? null
                    : item.offset + match.index,
                context: item.text.trim()
            };

            if (!refsByKey.has(key)) {
                refsByKey.set(key, {
                    rawTarget,
                    target,
                    occurrences: []
                });
            }

            refsByKey.get(key).occurrences.push(occurrence);
        }
    }

    return [...refsByKey.values()];
}


async function inspectCorpusFile(file, inventoryPaths) {
    const buffer = await fs.readFile(file.fullPath);
    const strings = file.type === "ELF"
        ? extractAsciiStrings(buffer)
        : extractTextLines(buffer);
    const evidenceType = file.type === "ELF"
        ? "BINARY_STRING_REF"
        : "SHELL_TEXT_REF";

    const references = extractResourceStrings(strings).map(ref => ({
        ...ref,
        targetExists: inventoryPaths.has(ref.target),
        classification: classifyReference(
            ref.rawTarget,
            ref.target,
            inventoryPaths
        ),
        evidenceType
    }));

    return {
        source: file.path,
        sourceType: file.type,
        evidenceType,
        references
    };
}


export async function buildCorpusFacts(inventory) {
    const inventoryPaths = new Set(
        inventory.map(file => file.path)
    );

    const corpusFiles = inventory.filter(file =>
        file.type === "ELF" ||
        file.type === "SHELL"
    );

    const results = [];

    for (const file of corpusFiles) {
        const result = await inspectCorpusFile(
            file,
            inventoryPaths
        );

        if (result.references.length > 0) {
            results.push(result);
        }
    }

    return results;
}
