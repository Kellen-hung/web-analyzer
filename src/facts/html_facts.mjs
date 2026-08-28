import fs from "node:fs/promises";
import path from "node:path";
import * as parse5 from "parse5";
import { getPhysicalCandidate } from "../resolution/resource_utils.mjs";


function getAttribute(node, name) {
    const attribute = node.attrs?.find(attr => attr.name === name);
    return attribute?.value ?? null;
}


function walkNodes(node, callback, ancestors = []) {
    callback(node, ancestors);

    if (!node.childNodes) {
        return;
    }

    const nextAncestors = node.tagName
        ? [...ancestors, node]
        : ancestors;

    for (const child of node.childNodes) {
        walkNodes(child, callback, nextAncestors);
    }
}


function getAncestorIds(ancestors) {
    return ancestors
        .map(node => getAttribute(node, "id"))
        .filter(Boolean);
}


function getTextContent(node) {
    if (!node.childNodes) {
        return "";
    }

    let text = "";

    for (const child of node.childNodes) {
        if (child.nodeName === "#text") {
            text += child.value;
        }
    }

    return text;
}


async function inspectHtml(wwwDirectory, htmlFile) {
    const fullPath = path.join(
        wwwDirectory,
        ...htmlFile.path.split("/")
    );

    const source = await fs.readFile(fullPath, "utf8");

    /*
     * Always use parseFragment here.
     *
     * At this stage we only extract raw HTML facts.
     * We do NOT decide whether the file is a top-level document,
     * AJAX fragment, iframe document, etc.
     */
    const root = parse5.parseFragment(source, {
        sourceCodeLocationInfo: true
    });

    const scripts = [];
    const inlineScripts = [];
    const inlineHandlers = [];
    const iframes = [];
    const links = [];
    const references = [];

    let scriptOrder = 0;
    let referenceOrder = 0;

    function addReference(node, ancestors, attribute, kind) {
        const rawTarget = getAttribute(node, attribute);

        if (!rawTarget || rawTarget.startsWith("#")) {
            return;
        }

        references.push({
            order: referenceOrder++,
            kind,
            tag: node.tagName,
            attribute,
            rawTarget,
            physicalCandidate: getPhysicalCandidate(
                htmlFile.path,
                rawTarget
            ),
            ancestorIds: getAncestorIds(ancestors),
            line: node.sourceCodeLocation?.startLine ?? null
        });
    }

    walkNodes(root, (node, ancestors) => {
        if (!node.tagName) {
            return;
        }

        // <script src="...">
        // <script>...</script>
        if (node.tagName === "script") {
            const src = getAttribute(node, "src");

            if (src) {
                scripts.push({
                    order: scriptOrder++,
                    rawTarget: src,
                    physicalCandidate: getPhysicalCandidate(htmlFile.path, src),
                    line: node.sourceCodeLocation?.startLine ?? null
                });
                addReference(node, ancestors, "src", "SCRIPT");
            } else {
                const code = getTextContent(node);

                if (code.trim()) {
                    const line = node.sourceCodeLocation?.startLine ?? null;
                    inlineScripts.push({
                        order: scriptOrder++,
                        sourceId: `${htmlFile.path}#inline-script:${line ?? "?"}`,
                        code,
                        line
                    });
                }
            }
        }

        // <iframe src="...">
        if (node.tagName === "iframe") {
            const src = getAttribute(node, "src");

            if (src) {
                iframes.push({
                    rawTarget: src,
                    physicalCandidate: getPhysicalCandidate(htmlFile.path, src),
                    line: node.sourceCodeLocation?.startLine ?? null
                });
                addReference(node, ancestors, "src", "IFRAME");
            }
        }

        // <a href="...">
        if (node.tagName === "a") {
            const href = getAttribute(node, "href");

            if (href && !href.startsWith("#")) {
                links.push({
                    rawTarget: href,
                    physicalCandidate: getPhysicalCandidate(htmlFile.path, href),
                    id: getAttribute(node, "id"),
                    ancestorIds: getAncestorIds(ancestors),
                    line: node.sourceCodeLocation?.startLine ?? null
                });
                addReference(node, ancestors, "href", "LINK");
            }
        }

        if (node.tagName === "link") {
            const rel = (getAttribute(node, "rel") ?? "")
                .toLowerCase()
                .split(/\s+/);
            addReference(
                node,
                ancestors,
                "href",
                rel.includes("stylesheet") ? "STYLESHEET" : "LINK_RESOURCE"
            );
        }

        if (node.tagName === "form") {
            addReference(node, ancestors, "action", "FORM_ACTION");
        }

        if (["img", "input", "source", "audio", "video", "embed"].includes(node.tagName)) {
            addReference(node, ancestors, "src", "ASSET");
        }

        if (node.tagName === "object") {
            addReference(node, ancestors, "data", "ASSET");
        }

        if (node.tagName === "video") {
            addReference(node, ancestors, "poster", "ASSET");
        }

        // onclick="", onchange="", onload="", ...
        for (const attr of node.attrs ?? []) {
            if (
                attr.name.startsWith("on") &&
                attr.value.trim()
            ) {
                const line = node.sourceCodeLocation?.startLine ?? null;
                inlineHandlers.push({
                    event: attr.name,
                    sourceId: `${htmlFile.path}#${attr.name}:${line ?? "?"}`,
                    code: attr.value,
                    line
                });
            }
        }
    });

    return {
        path: htmlFile.path,
        scripts,
        inlineScripts,
        inlineHandlers,
        iframes,
        links,
        references
    };
}


export async function buildHtmlFacts(wwwDirectory, inventory) {
    const htmlFiles = inventory.filter(file => file.type === "HTML");
    const htmlFacts = [];

    for (const htmlFile of htmlFiles) {
        htmlFacts.push(
            await inspectHtml(wwwDirectory, htmlFile)
        );
    }

    return htmlFacts;
}
