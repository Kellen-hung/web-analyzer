import path from "node:path";
import pc from "picocolors";
import { analyzePackage } from "./analyzer.mjs";
import { loadAnalyzerConfig } from "./config/analyzer_config.mjs";
import { renderCliReport } from "./report/cli_report.mjs";
import {
    renderHtmlReport,
    writeHtmlReport
} from "./report/html_report.mjs";


const CONFIG_PATH = path.resolve("analyzer.config.json");


function getMode(argumentsList) {
    if (argumentsList.includes("--debug")) {
        return "debug";
    }

    if (argumentsList.includes("--verbose")) {
        return "verbose";
    }

    return "default";
}


async function main() {
    const config = await loadAnalyzerConfig(CONFIG_PATH);
    const result = await analyzePackage(config.input.wwwDirectory, {
        entryDocuments: config.browser.entryDocuments,
        lmParamJsonPath: config.input.lmParamsJson,
        libraryGlobals: config.browser.libraryGlobals,
        vendorJsPatterns: config.vendor.jsPatterns,
        vendorCssPatterns: config.vendor.cssPatterns
    });
    const mode = getMode(process.argv.slice(2));
    const colorEnabled =
        Boolean(process.stdout.isTTY) &&
        !("NO_COLOR" in process.env);
    let writtenReportPath = null;

    if (config.report.outputFile) {
        const html = renderHtmlReport(result, {
            root: config.input.wwwDirectory,
            lmParamJsonPath: config.input.lmParamsJson,
            mode
        });
        writtenReportPath = await writeHtmlReport(
            config.report.outputFile,
            html
        );
    }

    process.stdout.write(renderCliReport(result, {
        root: config.input.wwwDirectory,
        mode,
        colorEnabled
    }));

    if (writtenReportPath) {
        process.stdout.write(
            `\nReport written to:\n${writtenReportPath}\n`
        );
    }
}


main().catch(error => {
    const colors = pc.createColors(
        Boolean(process.stderr.isTTY) &&
        !("NO_COLOR" in process.env)
    );
    console.error(colors.red(error.stack ?? error.message));
    process.exitCode = 1;
});
