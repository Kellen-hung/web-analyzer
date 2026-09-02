# RX Web Analyzer

This Node.js analyzer builds conservative Phase 1 evidence for a configured
legacy web package. It reports browser worlds, file-level incoming
evidence, unresolved references, and human-review cleanup candidates. It never
modifies the analyzed package and does not claim that a candidate is safe to
delete.

## Run

```powershell
npm.cmd start
```

The default report is a terminal-sized summary. Full world membership, script
loads, bindings, corpus findings, and partial/unresolved evidence are available
with:

```powershell
npm.cmd start -- --verbose
```

Color is limited to headings, status values, and review-target names. It is disabled automatically
for redirected/non-TTY output and whenever `NO_COLOR` is present.

When `report.outputFile` is configured, each run also writes the same normal,
verbose, or debug report as a standalone dark-theme HTML file. HTML colors do
not depend on TTY support or `NO_COLOR`, and no external CSS, JavaScript, or
assets are required.

On systems where PowerShell permits `npm.ps1`, `npm start` is equivalent.
The report is written to stdout and contains:

- inventory counts;
- document worlds, AJAX fragments, child iframe contexts, and ordered scripts;
- evidence-derived HTML roles;
- ELF and shell corpus findings;
- referenced-but-not-packaged resources;
- file candidates and retained unresolved evidence.

Package-specific inputs are centralized in `analyzer.config.json`. The current
configuration analyzes `4601D-RX/www` and its sibling `lm_params_json`, and
seeds `index.html` plus `vw/index.html` as browser entry documents. Input paths
are resolved relative to the config file; entry documents and vendor matching
use POSIX-style package paths. Switching to another package should only require
editing this file. The analyzer never modifies either configured input.

The same config also contains case-insensitive regular-expression sources for
vendor JS/CSS identification, source-backed library globals, and the generated
HTML report path. Missing
optional sections receive documented defaults; invalid types, unknown keys,
and invalid regular expressions fail with a setting-specific error.

## Test

```powershell
npm.cmd test
```

Tests create small synthetic packages in the operating system's temporary
directory. They do not copy or modify the configured company source package.

## Modules

- `inventory/inventory.mjs`: recursive package inventory and file-type detection.
- `config/analyzer_config.mjs`: one-time config loading, validation, path
  resolution, package-path normalization, and regex compilation.
- `facts/html_facts.mjs`: parse5-based raw scripts, handlers, links, iframe, form,
  stylesheet, and asset facts. Physical candidates remain non-semantic hints.
- `facts/js_facts.mjs`: Acorn-based request/navigation/tabs/dynamic-site facts plus
  conservative URL expressions, ordered top-level assignments, and narrowly
  summarized zero-argument/single-return URL helpers.
- `resolution/url_expression_resolver.mjs`: tiny URL-specific symbolic resolver for
  strings, concatenation, per-world bindings, and current-location primitives.
  It reports `RESOLVED`, `PARTIALLY_RESOLVED`, or `UNRESOLVED`; only a fully
  resolved pathname may enter package/missing classification.
- `facts/css_facts.mjs`: PostCSS and postcss-value-parser resource references plus
  configured vendor-source marking; it does not analyze CSS rule reachability.
- `facts/corpus_facts.mjs`: weak, source-typed ELF printable-string and shell-text
  evidence with package/device/missing/relative classification.
- `resolution/world_resolver.mjs`: document contexts, jQuery Tabs fragments, host runtime
  bases, iframe isolation, script scopes/order, fetched-resource roles, and
  per-world URL binding evaluation.
- `resolution/resource_utils.mjs`: shared web-target normalization and physical
  candidate helpers.
- `report/file_report.mjs`: per-file evidence, referenced-but-not-packaged findings,
  and conservative candidates.
- `report/integrated_report.mjs`: shared semantic report sections and mode selection
  used by both terminal and HTML presentation.
- `report/html_report.mjs`: escaped, self-contained HTML rendering and artifact output.
- `lm_params/lm_param_facts.mjs`: scope-aware static `LM_PARAM` field access,
  access-mode, destructuring, dynamic-property, and whole-object facts.
- `lm_params/lm_param_analyzer.mjs`: package-wide JSON-field aggregation using
  resolved runtime world membership only.
- `report/lm_param_report.mjs`: concise, verbose, and debug LM_PARAM reporting.

The analyzer intentionally stops before transitive function reachability,
runtime coverage, or automatic deletion.
