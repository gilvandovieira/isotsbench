# site

The static GitHub Pages report for isotsbench: a human-readable reading of the committed official runs. The repository, `results/raw/` and `results/normalized/` remain the source of truth; the page explains first and links to `docs/` for depth.

No framework, npm dependency, bundler or build step.

```text
site/
  index.html        structure only: sections, tables of fixed facts, links, chart containers
  styles.css        layout, type and chart marks, light and dark
  app.js            loads i18n/<lang>.json, fills the page, language switch
  charts.js         draws every chart and data-driven sentence from data/results.json
  i18n/en.json      English, the default
  i18n/pt-BR.json   Brazilian Portuguese, the same keys and placeholders
  data -> ../results/normalized   symlink: the page reads the generated dataset itself
```

Preview: `make site-serve`, then open `http://127.0.0.1:8000/isotsbench/`. It serves `build/site/` under the same base path as GitHub Pages. The page fetches its text and data, so it does not work from `file://`.

## Text and languages

- Every piece of explanatory copy comes from `i18n/<lang>.json`: `data-i18n` (text), `data-i18n-list` (an array rendered as list items) and `data-i18n-attr` (`"aria-label:nav.language"`). Proper nouns, versions, case ids and commands stay in the HTML.
- Strings may use `` `code` ``, `**bold**`, `[text](https://…)` or `[text](#id)`, and `{name}` placeholders for values from the data. Nothing else is interpreted, and no string is inserted as HTML. Code examples (`data-i18n-code`) are plain text.
- English on first visit. The EN / PT-BR buttons switch language, update `<html lang>`, the title and the date format, and remember the choice in `localStorage` (`isotsbench.lang`) when storage is available.
- A missing key shows as `⟦key⟧` and is logged; it never silently falls back to another language. `tests/site.test.ts` (part of `make test`) fails when the two catalogs differ in keys or placeholders, when the page uses a key that does not exist, when copy is unused, or when inline markup is unbalanced.

## Numbers and charts

The copy quotes no measured value of its own. Every number on the page comes from `data/results.json` at load time:

- charts (`<figure data-chart="…">`) name case ids in `charts.js`; values, ranges and ratios are computed from the records;
- sentences that quote values (`reading` keys, and elements with `data-values`) use `{name}` placeholders filled by `charts.js`.

| Chart | Section | Shows |
| --- | --- | --- |
| `boundary` | Boundary cost | `noop` per path and runtime, log scale |
| `dataShape` | Data shape | Node-API ÷ TypeScript by what crosses, log scale |
| `wasmSum` | WebAssembly | `sum_i32` over 10⁶: native and four WebAssembly variants |
| `wasmSplit` | WebAssembly | `wasm.copy` split into resident sum and copy, with the native sum |
| `workers` | Workers | round trip, then resident / transfer / copy / clone at 10⁶ |
| `jit` | Fresh vs shared | two divergent cases and two controls |

Every chart follows the same rules: official records only; a filled mark is the fresh process, a ring the shared process, drawn where the record is `divergent`; an `unstable` record is drawn as the range of its per-run medians and written as a range with †; case ids are never merged; runtimes keep a fixed order and are never ranked. Each chart has a sentence that interprets it, a native tooltip per row (case id and value) and a data table with fresh, shared and stability for every case it uses.

`tests/site.test.ts` also checks each qualitative claim in the copy (for example "no native row strategy beat TypeScript at any size") against `results/normalized/`, so a new official run that contradicts the text fails the tests.

## Build, check and publish

- `make site` copies `site/` to `build/site/` with the `data` symlink resolved into real files, and without this README. That directory is exactly what is published.
- `make site-check` runs `tests/normalize.test.ts`, `tests/site.test.ts` and `tests/pages.test.ts`. The last one checks the built directory: data identical to `results/normalized/`; every reference relative, so it works under `/isotsbench/`; scripts, styles, text and data all local; every link into the repository resolving (docs and their `#anchors` on `main`, raw runs at their pinned commit); and, in Chromium under `/isotsbench/`, English first, Portuguese on request and after a reload, six charts from `data/results.json`, and no request outside the site. Without Chromium that last check is skipped, except in CI.
- `.github/workflows/pages.yml` runs on every push to `main`: `make site-check`, a check that the committed `results/normalized/` equals the regenerated one, then upload of `build/site/` and deployment. It builds no native code and runs no benchmark.

One-time repository setting: **Settings → Pages → Source: GitHub Actions**.
