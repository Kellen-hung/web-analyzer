import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    loadAnalyzerConfig,
    normalizeAnalyzerConfig
} from "../src/config/analyzer_config.mjs";


async function withConfig(rawConfig, callback) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "rx-web-analyzer-config-test-")
    );
    const configPath = path.join(directory, "analyzer.config.json");

    try {
        await fs.writeFile(
            configPath,
            JSON.stringify(rawConfig),
            "utf8"
        );

        return await callback(configPath, directory);
    } finally {
        await fs.rm(directory, {
            recursive: true,
            force: true
        });
    }
}


test("loads analyzer.config.json from the project by default", async () => {
    const config = await loadAnalyzerConfig();

    assert.equal(
        config.configPath,
        path.resolve("analyzer.config.json")
    );
    assert(path.isAbsolute(config.input.wwwDirectory));
    assert(path.isAbsolute(config.input.lmParamsJson));
    assert(path.isAbsolute(config.report.outputFile));
    assert.equal(path.extname(config.report.outputFile), ".html");
    assert(config.browser.entryDocuments.every(document =>
        !document.includes("\\")
    ));
});


test("resolves a custom wwwDirectory relative to the config file", async () => {
    await withConfig({
        input: {
            wwwDirectory: "./package/www"
        }
    }, async (configPath, directory) => {
        const config = await loadAnalyzerConfig(configPath);

        assert.equal(
            config.input.wwwDirectory,
            path.join(directory, "package", "www")
        );
    });
});


test("resolves a custom lm_params_json path relative to the config file", async () => {
    await withConfig({
        input: {
            wwwDirectory: "./www",
            lmParamsJson: "./snapshots/lm_params_json"
        }
    }, async (configPath, directory) => {
        const config = await loadAnalyzerConfig(configPath);

        assert.equal(
            config.input.lmParamsJson,
            path.join(directory, "snapshots", "lm_params_json")
        );
    });
});


test("accepts custom entry documents and normalizes package separators", async () => {
    await withConfig({
        input: {
            wwwDirectory: "./www"
        },
        browser: {
            entryDocuments: ["login.html", "admin\\index.html"]
        }
    }, async configPath => {
        const config = await loadAnalyzerConfig(configPath);

        assert.deepEqual(
            config.browser.entryDocuments,
            ["login.html", "admin/index.html"]
        );
    });
});


test("rejects invalid config values with the failing setting name", () => {
    assert.throws(
        () => normalizeAnalyzerConfig({
            input: {
                wwwDirectory: 42
            }
        }),
        /input\.wwwDirectory must be a non-empty string/
    );

    assert.throws(
        () => normalizeAnalyzerConfig({
            input: {
                wwwDirectory: "./www"
            },
            browser: {
                entryDocuments: "index.html"
            }
        }),
        /browser\.entryDocuments must be an array/
    );

    assert.throws(
        () => normalizeAnalyzerConfig({
            input: {
                wwwDirectory: "./www"
            },
            vendor: {
                jsPatterns: ["["]
            }
        }),
        /vendor\.jsPatterns\[0\] must be a valid regular expression/
    );
});


test("uses defaults when optional config fields are omitted", () => {
    const config = normalizeAnalyzerConfig({
        input: {
            wwwDirectory: "./www"
        }
    });

    assert.equal(config.input.lmParamsJson, null);
    assert.deepEqual(config.browser.entryDocuments, []);
    assert.equal(config.browser.libraryGlobals.length, 1);
    assert.deepEqual(
        config.browser.libraryGlobals[0].names,
        ["$", "jQuery"]
    );
    assert.equal(config.vendor.jsPatterns.length, 1);
    assert.equal(config.vendor.cssPatterns.length, 0);
    assert.equal(config.report.outputFile, null);
    assert(config.vendor.jsPatterns[0].test("js/jquery-1.5.1.min.js"));
});


test("resolves report.outputFile relative to the config file", async () => {
    await withConfig({
        input: {
            wwwDirectory: "./www"
        },
        report: {
            outputFile: "./reports/model-report.html"
        }
    }, async (configPath, directory) => {
        const config = await loadAnalyzerConfig(configPath);

        assert.equal(
            config.report.outputFile,
            path.join(directory, "reports", "model-report.html")
        );
    });
});


test("normalizes a Windows-style report output path", async () => {
    await withConfig({
        input: {
            wwwDirectory: "./www"
        },
        report: {
            outputFile: ".\\reports\\model-report.html"
        }
    }, async (configPath, directory) => {
        const config = await loadAnalyzerConfig(configPath);

        assert.equal(
            config.report.outputFile,
            path.join(directory, "reports", "model-report.html")
        );
    });
});


test("rejects an invalid report.outputFile type", () => {
    assert.throws(
        () => normalizeAnalyzerConfig({
            input: {
                wwwDirectory: "./www"
            },
            report: {
                outputFile: true
            }
        }),
        /report\.outputFile must be a non-empty string/
    );
});


test("rejects report output inside the analyzed www directory", () => {
    assert.throws(
        () => normalizeAnalyzerConfig({
            input: {
                wwwDirectory: "./package/www"
            },
            report: {
                outputFile: "./package/www/report.html"
            }
        }),
        /report\.outputFile must be outside input\.wwwDirectory/
    );
});


test("normalizes Windows-style relative filesystem paths", async () => {
    await withConfig({
        input: {
            wwwDirectory: ".\\model\\www",
            lmParamsJson: ".\\model\\lm_params_json"
        }
    }, async (configPath, directory) => {
        const config = await loadAnalyzerConfig(configPath);

        assert.equal(
            config.input.wwwDirectory,
            path.join(directory, "model", "www")
        );
        assert.equal(
            config.input.lmParamsJson,
            path.join(directory, "model", "lm_params_json")
        );
    });
});


test("rejects unknown settings instead of silently ignoring typos", () => {
    assert.throws(
        () => normalizeAnalyzerConfig({
            input: {
                wwwDirectory: "./www",
                lmParamJson: "./lm_params_json"
            }
        }),
        /input\.lmParamJson is not a recognized setting/
    );
});
