import { buildIntegratedReport } from "./integrated_report.mjs";
import { renderSemanticText } from "./report_format.mjs";


export function renderCliReport(
    result,
    {
        root,
        mode = "default",
        colorEnabled = false
    } = {}
) {
    const semanticReport = buildIntegratedReport(result, {
        root,
        mode
    });

    return renderSemanticText(semanticReport, {
        format: colorEnabled ? "ansi" : "plain",
        colorEnabled
    });
}
