# RX Web Analyzer

This Node.js analyzer builds conservative Phase 1 evidence for the legacy web
package under `input/www`. It reports browser worlds, file-level incoming
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

Color is limited to headings and status values. It is disabled automatically
for redirected/non-TTY output and whenever `NO_COLOR` is present.

On systems where PowerShell permits `npm.ps1`, `npm start` is equivalent.
The report is written to stdout and contains:

- inventory counts;
- document worlds, AJAX fragments, child iframe contexts, and ordered scripts;
- evidence-derived HTML roles;
- ELF and shell corpus findings;
- referenced-but-not-packaged resources;
- file candidates and retained unresolved evidence.

Entry documents that cannot be discovered from an incoming package edge are
listed explicitly in `analyzer.config.json`. This package currently seeds
`index.html` and `vw/index.html`; other roles are derived from cross-file
evidence.

## Test

```powershell
npm.cmd test
```

Tests create small synthetic packages in the operating system's temporary
directory. They do not copy or modify company source from `input/`.

## Modules

- `inventory/inventory.mjs`: recursive package inventory and file-type detection.
- `facts/html_facts.mjs`: parse5-based raw scripts, handlers, links, iframe, form,
  stylesheet, and asset facts. Physical candidates remain non-semantic hints.
- `facts/js_facts.mjs`: Acorn-based request/navigation/tabs/dynamic-site facts plus
  conservative URL expressions, ordered top-level assignments, and narrowly
  summarized zero-argument/single-return URL helpers.
- `resolution/url_expression_resolver.mjs`: tiny URL-specific symbolic resolver for
  strings, concatenation, per-world bindings, and current-location primitives.
  It reports `RESOLVED`, `PARTIALLY_RESOLVED`, or `UNRESOLVED`; only a fully
  resolved pathname may enter package/missing classification.
- `facts/css_facts.mjs`: PostCSS and postcss-value-parser resource references only;
  it does not analyze CSS rule reachability.
- `facts/corpus_facts.mjs`: weak, source-typed ELF printable-string and shell-text
  evidence with package/device/missing/relative classification.
- `resolution/world_resolver.mjs`: document contexts, jQuery Tabs fragments, host runtime
  bases, iframe isolation, script scopes/order, fetched-resource roles, and
  per-world URL binding evaluation.
- `resolution/resource_utils.mjs`: shared web-target normalization and physical
  candidate helpers.
- `report/file_report.mjs`: per-file evidence, referenced-but-not-packaged findings,
  and conservative candidates.

The analyzer intentionally stops before function reachability, symbol usage,
LM_PARAM analysis, runtime coverage, or automatic deletion.
