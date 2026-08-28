import path from "node:path";


const NON_PACKAGE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;


export function stripQueryAndFragment(rawTarget) {
    if (typeof rawTarget !== "string") {
        return "";
    }

    const queryIndex = rawTarget.indexOf("?");
    const fragmentIndex = rawTarget.indexOf("#");
    const indexes = [queryIndex, fragmentIndex]
        .filter(index => index >= 0);
    const end = indexes.length > 0
        ? Math.min(...indexes)
        : rawTarget.length;

    return rawTarget.slice(0, end);
}


export function resolveWebTarget(rawTarget, basePath = null) {
    if (typeof rawTarget !== "string" || !rawTarget.trim()) {
        return {
            status: "UNRESOLVED",
            reason: "EMPTY_TARGET",
            target: null
        };
    }

    const normalizedRaw = rawTarget.trim().replaceAll("\\", "/");

    if (normalizedRaw.startsWith("#")) {
        return {
            status: "IGNORED",
            reason: "SAME_DOCUMENT_FRAGMENT",
            target: null
        };
    }

    if (
        normalizedRaw.startsWith("//") ||
        NON_PACKAGE_SCHEME.test(normalizedRaw)
    ) {
        return {
            status: "EXTERNAL",
            reason: "NON_PACKAGE_URL",
            target: null
        };
    }

    const cleanTarget = stripQueryAndFragment(normalizedRaw);

    if (!cleanTarget) {
        return {
            status: "IGNORED",
            reason: "QUERY_OR_FRAGMENT_ONLY",
            target: null
        };
    }

    let target;

    if (cleanTarget.startsWith("/www/")) {
        target = cleanTarget.slice("/www/".length);
    } else if (cleanTarget.startsWith("/")) {
        target = cleanTarget.slice(1);
    } else if (basePath) {
        target = path.posix.join(
            path.posix.dirname(basePath),
            cleanTarget
        );
    } else {
        return {
            status: "UNRESOLVED",
            reason: "RELATIVE_TARGET_WITHOUT_RUNTIME_BASE",
            target: null
        };
    }

    target = path.posix.normalize(target).replace(/^\.\//, "");

    if (
        !target ||
        target === ".." ||
        target.startsWith("../") ||
        path.posix.isAbsolute(target)
    ) {
        return {
            status: "UNRESOLVED",
            reason: "TARGET_OUTSIDE_PACKAGE_ROOT",
            target: null
        };
    }

    return {
        status: "RESOLVED",
        reason: null,
        target
    };
}


export function getPhysicalCandidate(sourcePath, rawTarget) {
    const result = resolveWebTarget(rawTarget, sourcePath);
    return result.status === "RESOLVED"
        ? result.target
        : null;
}


export function isHtmlPath(target) {
    return /\.html?$/i.test(target ?? "");
}

