import fs from "node:fs/promises";
import path from "node:path";


const DEFAULT_ENTRY_DOCUMENTS = [];
const DEFAULT_VENDOR_JS_PATTERN_SOURCES = [
    "(?:^|/)jquery(?:[-.]|$).*\\.min\\.js$"
];
const DEFAULT_VENDOR_CSS_PATTERNS = [];
const DEFAULT_LIBRARY_GLOBAL_CONFIG = [
    {
        library: "jQuery",
        names: ["$", "jQuery"],
        sourcePatterns: ["(^|/)jquery(?:[-.]\\d|\\.|$)"]
    }
];


function isPlainObject(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
}


function fail(location, expectation) {
    throw new Error(`Invalid analyzer config: ${location} ${expectation}`);
}


function assertObject(value, location) {
    if (!isPlainObject(value)) {
        fail(location, "must be an object");
    }
}


function assertAllowedKeys(value, location, allowedKeys) {
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
            fail(`${location}.${key}`, "is not a recognized setting");
        }
    }
}


function nonEmptyString(value, location) {
    if (typeof value !== "string" || value.trim() === "") {
        fail(location, "must be a non-empty string");
    }

    return value.trim();
}


function stringArray(value, location) {
    if (!Array.isArray(value)) {
        fail(location, "must be an array of non-empty strings");
    }

    return value.map((item, index) =>
        nonEmptyString(item, `${location}[${index}]`)
    );
}


function resolveConfigPath(value, location, configRoot) {
    const configuredPath = nonEmptyString(value, location);
    const platformPath = configuredPath.replace(/[\\/]/g, path.sep);

    return path.resolve(configRoot, platformPath);
}


function isInsideDirectory(directory, candidate) {
    const relative = path.relative(directory, candidate);

    return relative === "" || (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}


function normalizePackagePath(value, location) {
    const configuredPath = nonEmptyString(value, location)
        .replace(/\\/g, "/");

    if (
        path.posix.isAbsolute(configuredPath) ||
        /^[A-Za-z]:\//.test(configuredPath)
    ) {
        fail(location, "must be relative to the analyzed www directory");
    }

    const normalized = path.posix.normalize(configuredPath)
        .replace(/^\.\//, "");

    if (normalized === ".." || normalized.startsWith("../")) {
        fail(location, "must stay inside the analyzed www directory");
    }

    return normalized;
}


function compilePatterns(value, location, defaults) {
    const sources = value === undefined
        ? [...defaults]
        : stringArray(value, location);

    return sources.map((source, index) => {
        try {
            return new RegExp(source, "i");
        } catch (error) {
            fail(`${location}[${index}]`, `must be a valid regular expression (${error.message})`);
        }
    });
}


function normalizeLibraryGlobals(value) {
    const providers = value === undefined
        ? DEFAULT_LIBRARY_GLOBAL_CONFIG
        : value;

    if (!Array.isArray(providers)) {
        fail("browser.libraryGlobals", "must be an array");
    }

    return providers.map((provider, index) => {
        const location = `browser.libraryGlobals[${index}]`;
        assertObject(provider, location);
        assertAllowedKeys(
            provider,
            location,
            new Set(["library", "names", "sourcePatterns"])
        );

        return {
            library: nonEmptyString(provider.library, `${location}.library`),
            names: stringArray(provider.names, `${location}.names`),
            sourcePatterns: compilePatterns(
                stringArray(
                    provider.sourcePatterns,
                    `${location}.sourcePatterns`
                ),
                `${location}.sourcePatterns`,
                []
            )
        };
    });
}


export const DEFAULT_VENDOR_JS_PATTERNS = compilePatterns(
    DEFAULT_VENDOR_JS_PATTERN_SOURCES,
    "vendor.jsPatterns",
    []
);

export const DEFAULT_LIBRARY_GLOBAL_PROVIDERS = normalizeLibraryGlobals();


export function normalizeAnalyzerConfig(rawConfig, {
    configPath = path.resolve("analyzer.config.json")
} = {}) {
    assertObject(rawConfig, "root");
    assertAllowedKeys(
        rawConfig,
        "root",
        new Set(["input", "browser", "vendor", "report"])
    );

    assertObject(rawConfig.input, "input");
    assertAllowedKeys(
        rawConfig.input,
        "input",
        new Set(["wwwDirectory", "lmParamsJson"])
    );

    const browser = rawConfig.browser ?? {};
    const vendor = rawConfig.vendor ?? {};
    const report = rawConfig.report ?? {};
    assertObject(browser, "browser");
    assertObject(vendor, "vendor");
    assertObject(report, "report");
    assertAllowedKeys(
        browser,
        "browser",
        new Set(["entryDocuments", "libraryGlobals"])
    );
    assertAllowedKeys(
        vendor,
        "vendor",
        new Set(["jsPatterns", "cssPatterns"])
    );
    assertAllowedKeys(
        report,
        "report",
        new Set(["outputFile"])
    );

    const absoluteConfigPath = path.resolve(configPath);
    const configRoot = path.dirname(absoluteConfigPath);
    const lmParamsJson = rawConfig.input.lmParamsJson;
    const wwwDirectory = resolveConfigPath(
        rawConfig.input.wwwDirectory,
        "input.wwwDirectory",
        configRoot
    );
    const reportOutputFile = report.outputFile === undefined
        ? null
        : resolveConfigPath(
            report.outputFile,
            "report.outputFile",
            configRoot
        );

    if (lmParamsJson !== undefined && lmParamsJson !== null) {
        nonEmptyString(lmParamsJson, "input.lmParamsJson");
    }

    if (
        reportOutputFile &&
        isInsideDirectory(wwwDirectory, reportOutputFile)
    ) {
        fail(
            "report.outputFile",
            "must be outside input.wwwDirectory"
        );
    }

    return {
        configPath: absoluteConfigPath,
        configRoot,
        input: {
            wwwDirectory,
            lmParamsJson: lmParamsJson === undefined || lmParamsJson === null
                ? null
                : resolveConfigPath(
                    lmParamsJson,
                    "input.lmParamsJson",
                    configRoot
                )
        },
        browser: {
            entryDocuments: stringArray(
                browser.entryDocuments ?? DEFAULT_ENTRY_DOCUMENTS,
                "browser.entryDocuments"
            )
                .map((document, index) => normalizePackagePath(
                    document,
                    `browser.entryDocuments[${index}]`
                )),
            libraryGlobals: normalizeLibraryGlobals(browser.libraryGlobals)
        },
        vendor: {
            jsPatterns: compilePatterns(
                vendor.jsPatterns,
                "vendor.jsPatterns",
                DEFAULT_VENDOR_JS_PATTERN_SOURCES
            ),
            cssPatterns: compilePatterns(
                vendor.cssPatterns,
                "vendor.cssPatterns",
                DEFAULT_VENDOR_CSS_PATTERNS
            )
        },
        report: {
            outputFile: reportOutputFile
        }
    };
}


export async function loadAnalyzerConfig(
    configPath = path.resolve("analyzer.config.json")
) {
    const absoluteConfigPath = path.resolve(configPath);
    let source;

    try {
        source = await fs.readFile(absoluteConfigPath, "utf8");
    } catch (error) {
        throw new Error(
            `Unable to read analyzer config at ${absoluteConfigPath}: ${error.message}`
        );
    }

    let rawConfig;

    try {
        rawConfig = JSON.parse(source);
    } catch (error) {
        throw new Error(
            `Invalid JSON in analyzer config at ${absoluteConfigPath}: ${error.message}`
        );
    }

    return normalizeAnalyzerConfig(rawConfig, {
        configPath: absoluteConfigPath
    });
}
