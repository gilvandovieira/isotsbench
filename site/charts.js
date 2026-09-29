// Result charts, drawn from the normalized dataset (site/data → ../results/normalized).
// No benchmark number is written here: charts name case ids, and every value,
// range and ratio comes from data/results.json.
//
// Conventions, shared by every chart:
// - a filled mark is the fresh-process (or fresh-browser) result;
// - a ring is the shared-process result, drawn only where the record is `divergent`;
// - an `unstable` record (per-run medians spread > 5%) is drawn as the range of
//   its per-run medians, never as one point, and its value is written as a range with †;
// - every chart has a data table with fresh, shared and stability for each case.

const SVG = "http://www.w3.org/2000/svg";

const ENV = {
  node: "charts.env.node",
  bun: "charts.env.bun",
  deno: "charts.env.deno",
  scriptc: "charts.env.scriptc",
  "chromium.main": "charts.env.chromiumMain",
  "firefox.main": "charts.env.firefoxMain",
  "chromium.worker": "charts.env.chromiumWorker",
  "firefox.worker": "charts.env.firefoxWorker",
};
const RUNTIMES = ["node", "bun", "deno"];
const M = "1000000";

// ---------------------------------------------------------------- data

let dataset;

function loadData() {
  dataset ??= fetch("data/results.json")
    .then((response) => {
      if (!response.ok) throw new Error(`data/results.json: HTTP ${response.status}`);
      return response.json();
    })
    .then((records) => {
      const byKey = new Map();
      for (const r of records) {
        if (!r.official) continue;
        const key = `${r.environment}|${r.isolation}|${r.id}`;
        if (byKey.has(key)) throw new Error(`two official records for ${key}`);
        byKey.set(key, r);
      }
      return byKey;
    });
  return dataset;
}

/** One case in one environment: its fresh and shared records. */
function observe(data, env, id) {
  const fresh = data.get(`${env}|case|${id}`);
  const shared = data.get(`${env}|runtime|${id}`);
  if (!fresh || !shared) return null;
  return { env, id, fresh, shared, divergent: fresh.divergent === true };
}

const unstable = (...records) => records.some((r) => r.stability === "unstable");
/** The values a record stands for: its median, or its whole run range when unstable. */
const span = (r) => (r.stability === "unstable" ? [r.min_run_ns, r.max_run_ns] : [r.median_ns, r.median_ns]);

// ---------------------------------------------------------------- formatting

function formats(lang) {
  // Values keep three significant digits ("5.80 ns"); axis ticks drop trailing zeros ("1 ms").
  const n3 = new Intl.NumberFormat(lang, { minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
  const n2 = new Intl.NumberFormat(lang, { minimumSignificantDigits: 2, maximumSignificantDigits: 2 });
  const plain = new Intl.NumberFormat(lang, { maximumSignificantDigits: 3 });
  const unit = (ns) => (ns >= 1e9 ? [1e9, "s"] : ns >= 1e6 ? [1e6, "ms"] : ns >= 1e3 ? [1e3, "µs"] : [1, "ns"]);
  const time = (ns) => {
    const [d, u] = unit(ns);
    return `${n3.format(ns / d)} ${u}`;
  };
  const tickTime = (ns) => {
    const [d, u] = unit(ns || 1);
    return `${plain.format(ns / d)} ${u}`;
  };
  const tickRatio = (x) => `${plain.format(x)}×`;
  const timeRange = (lo, hi) => {
    const [d, u] = unit(hi);
    return n3.format(lo / d) === n3.format(hi / d) ? `${n3.format(hi / d)} ${u}` : `${n3.format(lo / d)}–${n3.format(hi / d)} ${u}`;
  };
  const ratio = (x) => `${n2.format(x)}×`;
  const ratioRange = (lo, hi) => (n2.format(lo) === n2.format(hi) ? ratio(hi) : `${n2.format(lo)}–${n2.format(hi)}×`);
  const record = (r) => (r.stability === "unstable" ? `${timeRange(r.min_run_ns, r.max_run_ns)}†` : time(r.median_ns));
  /** Fresh, plus shared when they diverge. */
  const obs = (o) => (o.divergent ? `${record(o.fresh)} / ${record(o.shared)}` : record(o.fresh));
  return { time, timeRange, ratio, ratioRange, record, obs, tickTime, tickRatio };
}

/** min–max over the spans of several records, formatted as a time range. */
function timeSpan(f, records) {
  const values = records.flatMap(span);
  return f.timeRange(Math.min(...values), Math.max(...values));
}

// ---------------------------------------------------------------- SVG helpers

function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

function text(content, attrs, parent) {
  const node = svg("text", attrs, parent);
  node.textContent = content;
  return node;
}

let measureContext;
function textWidth(content, mono = false) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  const style = getComputedStyle(document.body);
  measureContext.font = `12px ${mono ? style.getPropertyValue("--mono") : style.fontFamily}`;
  return measureContext.measureText(content).width;
}

function logScale(lo, hi) {
  const a = Math.floor(Math.log10(lo));
  const b = Math.ceil(Math.log10(hi));
  const ticks = [];
  for (let e = a; e <= b; e++) ticks.push(10 ** e);
  return { domain: [10 ** a, 10 ** b], ticks, at: (v, x0, x1) => x0 + ((Math.log10(v) - a) / (b - a)) * (x1 - x0) };
}

function linearScale(hi) {
  const raw = hi / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { domain: [0, top], ticks, at: (v, x0, x1) => x0 + (v / top) * (x1 - x0) };
}

/** A horizontal bar from x0 to x1, square at x0 and rounded (4px) at x1. */
function barPath(x0, x1, y, h) {
  const r = Math.min(4, (x1 - x0) / 2, h / 2);
  return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z`;
}

// ---------------------------------------------------------------- the row chart

/**
 * Rows of marks against one horizontal scale.
 * rows: { group } | { label, mono?, value, title, marks: Mark[] }
 * Mark: { kind: "point", record, role: "fresh" | "shared" | "ref" }
 *     | { kind: "ratio", lo, mid, hi, role }                         (unstable when lo < hi)
 *     | { kind: "segment", from, to, role: "compute" | "transfer", end: boolean }
 *     | { kind: "tick", at, role: "native" }
 *     | { kind: "link", from, to }                                   (dumbbell connector)
 */
function drawRows(container, { rows, scale, axis, tickLabel, reference, label }) {
  const width = Math.max(280, container.clientWidth);
  const widest = Math.max(...rows.map((r) => (r.label ? textWidth(r.label, r.mono) : 0)));
  // Compact: labels above their marks, when they would not fit a third of the width beside them.
  const compact = width < 560 || widest + 12 > width * 0.34;
  const labelWidth = compact ? 0 : widest + 12;
  const valueWidth = compact ? 0 : 16 + Math.max(...rows.map((r) => (r.value ? textWidth(r.value) : 0)));
  const x0 = labelWidth + 8;
  const x1 = width - valueWidth - 10;
  const x = (v) => scale.at(v, x0, x1);

  /** Splits a heading that is wider than the chart into two lines, at the space nearest its middle. */
  const lines = (content) => {
    if (textWidth(content) * 1.1 <= width) return [content];
    const spaces = [...content.matchAll(/ /g)].map((m) => m.index);
    const cut = spaces.reduce((best, i) => (Math.abs(i - content.length / 2) < Math.abs(best - content.length / 2) ? i : best), spaces[0]);
    return [content.slice(0, cut), content.slice(cut + 1)];
  };

  const layout = [];
  let y = 4;
  for (const [i, row] of rows.entries()) {
    if (row.group) {
      y += i === 0 ? 0 : 10;
      const parts = lines(row.group);
      layout.push({ row, parts, y: y + 16 });
      y += 8 + 16 * parts.length;
    } else if (!compact) {
      layout.push({ row, y, mid: y + 13, valueY: y + 17 });
      y += 26;
    } else if (textWidth(row.label, row.mono) + textWidth(row.value) + 16 <= width) {
      layout.push({ row, y: y + 16, mid: y + 28, valueY: y + 16 });
      y += 40;
    } else {
      // The value does not fit beside the label: it gets its own line.
      layout.push({ row, y: y + 16, mid: y + 44, valueY: y + 32 });
      y += 56;
    }
  }
  const plotBottom = y + 4;
  const height = plotBottom + 40;

  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
  const grid = svg("g", { class: "v-grid" }, root);
  for (const t of scale.ticks) {
    const tx = x(t);
    svg("line", { x1: tx, x2: tx, y1: 0, y2: plotBottom }, grid);
    text(tickLabel(t), { x: tx, y: plotBottom + 16, "text-anchor": "middle", class: "v-tick" }, root);
  }
  if (reference) {
    const rx = x(reference.at);
    svg("line", { x1: rx, x2: rx, y1: 0, y2: plotBottom, class: "v-reference" }, root);
  }
  text(axis, { x: (x0 + x1) / 2, y: plotBottom + 34, "text-anchor": "middle", class: "v-axis" }, root);

  for (const { row, parts, y: ry, mid, valueY } of layout) {
    if (row.group) {
      parts.forEach((part, i) => text(part, { x: 0, y: ry + 16 * i, class: "v-group" }, root));
      continue;
    }
    const g = svg("g", { class: "v-row" }, root);
    svg("title", {}, g).textContent = `${row.title}: ${row.value}`;
    svg("rect", { x: 0, y: mid - 12, width, height: 24, class: "v-hit" }, g);
    text(row.label, { x: 0, y: compact ? ry : mid + 4, class: row.mono ? "v-label v-mono" : "v-label" }, g);
    // Inset by the text halo (styles.css), which would otherwise spill past the edge.
    text(row.value, { x: width - 2, y: compact ? valueY : mid + 4, "text-anchor": "end", class: "v-value" }, g);
    for (const mark of row.marks) drawMark(g, mark, x, mid);
  }
  container.replaceChildren(root);
}

function drawMark(g, mark, x, mid) {
  if (mark.kind === "link") {
    svg("line", { x1: x(mark.from), x2: x(mark.to), y1: mid, y2: mid, class: "v-link" }, g);
    return;
  }
  if (mark.kind === "tick") {
    svg("line", { x1: x(mark.at), x2: x(mark.at), y1: mid - 10, y2: mid + 10, class: "v-native" }, g);
    return;
  }
  if (mark.kind === "segment") {
    const a = x(mark.from) + (mark.from > 0 ? 1 : 0);
    const b = Math.max(a + 1, x(mark.to) - 1);
    svg("path", { d: mark.end ? barPath(a, b, mid - 6, 12) : `M${a},${mid - 6}H${b}V${mid + 6}H${a}Z`, class: `v-${mark.role}` }, g);
    return;
  }
  const [lo, hi, value] = mark.kind === "ratio"
    ? [mark.lo, mark.hi, mark.mid]
    : [...span(mark.record), mark.record.median_ns];
  if (hi > lo * 1.0001) {
    // Unstable: the range of per-run medians is the mark.
    const a = x(lo);
    const b = Math.max(x(hi), a + 14);
    svg("rect", { x: a, y: mid - 4, width: b - a, height: 8, rx: 4, class: `v-range v-${mark.role}` }, g);
  } else {
    const ring = mark.role === "shared" || mark.role === "ref-shared";
    svg("circle", { cx: x(value), cy: mid, r: ring ? 6.5 : 4.5, class: `v-dot v-${mark.role}` }, g);
  }
}

// ---------------------------------------------------------------- chart definitions

/** A point row for one observation: fresh mark, plus a shared ring when they diverge. */
function pointRow(o, label, f, role = "fresh", mono = false) {
  // The shared ring is drawn first, so the fresh mark stays visible inside it.
  const marks = [];
  if (o.divergent) marks.push({ kind: "point", record: o.shared, role: role === "ref" ? "ref-shared" : "shared" });
  marks.push({ kind: "point", record: o.fresh, role: role === "ref" ? "ref" : "fresh" });
  return { label, mono, value: f.obs(o), title: `${o.env} · ${o.id}`, marks, observations: [o] };
}

const upper = (rows) => Math.max(...rows.flatMap((r) => r.observations ?? []).flatMap((o) => [...span(o.fresh), ...(o.divergent ? span(o.shared) : [])]));
const lower = (rows) => Math.min(...rows.flatMap((r) => r.observations ?? []).flatMap((o) => [...span(o.fresh), ...(o.divergent ? span(o.shared) : [])]));

const CHARTS = {
  boundary(data, t, f) {
    const paths = [
      ["ts", "charts.paths.emptyLoop", "ref"],
      ["napi", "charts.paths.napi"],
      ["ffi", "charts.paths.ffi"],
      ["wasm.inlineable", "charts.paths.wasmInlineable"],
      ["wasm.no-inline", "charts.paths.wasmNoInline"],
    ];
    const rows = [];
    for (const env of ["node", "bun", "deno", "scriptc"]) {
      rows.push({ group: t(ENV[env]) });
      for (const [path, key, role] of paths) {
        const o = observe(data, env, `noop/${path}`);
        if (o) rows.push(pointRow(o, t(key), f, role));
      }
    }
    const all = (path) => RUNTIMES.concat("scriptc").map((e) => observe(data, e, `noop/${path}`)).filter(Boolean).map((o) => o.fresh);
    return {
      rows,
      scale: logScale(lower(rows), upper(rows)),
      tickLabel: f.tickTime,
      vars: { ffi: timeSpan(f, all("ffi")), napi: timeSpan(f, all("napi")), noInline: timeSpan(f, all("wasm.no-inline")) },
    };
  },

  wasmSum(data, t, f) {
    const paths = [
      ["napi", "charts.paths.napi", "ref"],
      ["ffi", "charts.paths.ffi", "ref"],
      ["wasm.copy", "charts.paths.wasmCopy"],
      ["wasm.resident", "charts.paths.wasmResident"],
      ["wasm.simd128.copy", "charts.paths.simdCopy"],
      ["wasm.simd128.resident", "charts.paths.simdResident"],
    ];
    const rows = [];
    for (const env of [...RUNTIMES, "chromium.main", "firefox.main"]) {
      rows.push({ group: t(ENV[env]) });
      for (const [path, key, role] of paths) {
        const o = observe(data, env, `sum_i32/${path}/${M}`);
        if (o) rows.push(pointRow(o, t(key), f, role));
      }
    }
    const native = RUNTIMES.flatMap((e) => ["napi", "ffi"].map((p) => observe(data, e, `sum_i32/${p}/${M}`))).filter(Boolean);
    const simd = RUNTIMES.map((e) => observe(data, e, `sum_i32/wasm.simd128.resident/${M}`).fresh.median_ns / observe(data, e, `sum_i32/napi/${M}`).fresh.median_ns);
    return {
      rows,
      scale: linearScale(upper(rows)),
      tickLabel: f.tickTime,
      vars: {
        native: timeSpan(f, native.map((o) => o.fresh)),
        resident: timeSpan(f, [...RUNTIMES, "chromium.main", "firefox.main"].map((e) => observe(data, e, `sum_i32/wasm.resident/${M}`).fresh)),
        simd: f.ratioRange(Math.min(...simd), Math.max(...simd)),
      },
    };
  },

  wasmSplit(data, t, f) {
    const rows = [];
    const transfers = [];
    for (const env of [...RUNTIMES, "chromium.main", "firefox.main"]) {
      rows.push({ group: t(ENV[env]) });
      const native = observe(data, env, `sum_i32/napi/${M}`);
      for (const [build, key] of [["wasm", "charts.paths.defaultBuild"], ["wasm.simd128", "charts.paths.simdBuild"]]) {
        const copy = observe(data, env, `sum_i32/${build}.copy/${M}`);
        const resident = observe(data, env, `sum_i32/${build}.resident/${M}`);
        const compute = resident.fresh.median_ns;
        const total = copy.fresh.median_ns;
        const transfer = total - compute;
        transfers.push(transfer);
        const flag = unstable(copy.fresh, resident.fresh) ? "†" : "";
        const marks = [
          { kind: "segment", from: 0, to: compute, role: "compute", end: false },
          { kind: "segment", from: compute, to: Math.max(compute, total), role: "transfer", end: true },
        ];
        if (copy.divergent) marks.push({ kind: "point", record: copy.shared, role: "shared" });
        if (native) marks.push({ kind: "tick", at: native.fresh.median_ns, role: "native" });
        rows.push({
          label: t(key),
          value: t("charts.wasmSplit.value", { compute: f.time(compute), transfer: f.time(transfer) }) + flag,
          title: `${env} · ${copy.id} − ${resident.id}`,
          marks,
          observations: [copy, resident, ...(native ? [native] : [])],
        });
      }
    }
    return {
      rows,
      scale: linearScale(upper(rows)),
      tickLabel: f.tickTime,
      vars: { transfer: f.timeRange(Math.min(...transfers), Math.max(...transfers)) },
    };
  },

  workers(data, t, f) {
    const rows = [];
    const adds = { transfer: [], copy: [], clone: [] };
    const trips = [];
    for (const browser of ["chromium", "firefox"]) {
      const env = `${browser}.worker`;
      rows.push({ group: t(ENV[env]) });
      const trip = observe(data, env, "noop/worker.ts");
      trips.push(trip.fresh);
      rows.push(pointRow(trip, t("charts.paths.roundTrip"), f));
      const resident = observe(data, env, `sum_i32/worker.wasm.resident/${M}`);
      for (const [strategy, key] of [
        ["resident", "charts.paths.workerResident"],
        ["transfer", "charts.paths.workerTransfer"],
        ["copy", "charts.paths.workerCopy"],
        ["clone", "charts.paths.workerClone"],
      ]) {
        const o = observe(data, env, `sum_i32/worker.wasm.${strategy}/${M}`);
        rows.push(pointRow(o, t(key), f));
        if (strategy !== "resident") adds[strategy].push(o.fresh.median_ns - resident.fresh.median_ns);
      }
      rows.push(pointRow(observe(data, `${browser}.main`, `sum_i32/wasm.resident/${M}`), t("charts.paths.mainThread"), f, "ref"));
    }
    const range = (values) => f.timeRange(Math.min(...values), Math.max(...values));
    return {
      rows,
      scale: linearScale(upper(rows)),
      tickLabel: f.tickTime,
      vars: { trip: timeSpan(f, trips), transfer: range(adds.transfer), copy: range(adds.copy), clone: range(adds.clone) },
    };
  },

  jit(data, t, f) {
    const cases = [
      ["node", "sum_i32/ts/1000000"],
      ["deno", "checksum_bytes/ts/16777216"],
      ["bun", "sum_i32/ts/1000000"],
      ["scriptc", "sum_i32/ts/1000000"],
    ];
    const rows = [];
    // shared ÷ fresh as a range over both records' spans, so an unstable side widens it.
    const ratios = {};
    for (const [env, id] of cases) {
      const o = observe(data, env, id);
      const [flo, fhi] = span(o.fresh);
      const [slo, shi] = span(o.shared);
      ratios[env] = [slo / fhi, shi / flo];
      rows.push({ group: t(ENV[env]) });
      rows.push({
        label: id,
        mono: true,
        value: `${f.record(o.fresh)} · ${f.record(o.shared)}`,
        title: `${env} · ${id}`,
        marks: [
          { kind: "link", from: o.fresh.median_ns, to: o.shared.median_ns },
          { kind: "point", record: o.shared, role: "shared" },
          { kind: "point", record: o.fresh, role: "fresh" },
        ],
        observations: [{ ...o, divergent: true }],
      });
    }
    return {
      rows,
      scale: logScale(lower(rows), upper(rows)),
      tickLabel: f.tickTime,
      vars: {
        node: f.ratioRange(1 / ratios.node[1], 1 / ratios.node[0]),
        deno: f.ratioRange(ratios.deno[0], ratios.deno[1]),
      },
    };
  },

  dataShape(data, t, f) {
    const shapes = [
      ["charts.shapes.ascii", "string_len/napi/ascii/16777216", "string_len/ts/ascii/16777216"],
      ["charts.shapes.utf8", "string_len/napi/utf8/16777216", "string_len/ts/utf8/16777216"],
      ["charts.shapes.bytesOut", "return_bytes/napi/16777216", "return_bytes/ts/16777216"],
      ["charts.shapes.objects", "return_rows/napi.objects/10000", "return_rows/ts/10000"],
      ["charts.shapes.packed", "return_rows/napi.packed/10000", "return_rows/ts/10000"],
    ];
    const ratioText = (x) => (x < 1 ? t("charts.faster", { x: f.ratio(1 / x) }) : t("charts.slower", { x: f.ratio(x) }));
    const rows = [];
    let lo = Infinity;
    let hi = 0;
    for (const [key, nativeId, tsId] of shapes) {
      rows.push({ group: t(key) });
      for (const env of RUNTIMES) {
        const n = observe(data, env, nativeId);
        const s = observe(data, env, tsId);
        const mark = (nr, sr, role) => {
          const [nlo, nhi] = span(nr);
          const [slo, shi] = span(sr);
          return { kind: "ratio", lo: nlo / shi, hi: nhi / slo, mid: nr.median_ns / sr.median_ns, role };
        };
        const fresh = mark(n.fresh, s.fresh, "fresh");
        const marks = [fresh];
        const divergent = n.divergent || s.divergent;
        let value = ratioText(fresh.mid);
        if (divergent) {
          const shared = mark(n.shared, s.shared, "shared");
          marks.unshift(shared);
          value = `${ratioText(fresh.mid)} / ${ratioText(shared.mid)}`;
        }
        if (unstable(n.fresh, s.fresh, ...(divergent ? [n.shared, s.shared] : []))) value += "†";
        for (const m of marks) [lo, hi] = [Math.min(lo, m.lo), Math.max(hi, m.hi)];
        rows.push({ label: t(ENV[env]), value, title: `${env} · ${nativeId} ÷ ${tsId}`, marks, observations: [n, s] });
      }
    }
    return {
      rows,
      scale: logScale(lo, hi),
      tickLabel: f.tickRatio,
      reference: { at: 1 },
      vars: {},
    };
  },
};

// ---------------------------------------------------------------- figures and tables

function legend(t, name) {
  const items = [["fresh", "charts.legend.fresh"], ["shared", "charts.legend.shared"], ["range", "charts.legend.range"]];
  const reference = { boundary: "charts.legend.refBoundary", wasmSum: "charts.legend.refWasmSum", workers: "charts.legend.refWorkers" };
  if (reference[name]) items.push(["ref", reference[name]]);
  if (name === "wasmSplit") {
    items.splice(0, 3, ["compute", "charts.legend.compute"], ["transfer", "charts.legend.transfer"], ["native", "charts.legend.native"], ["shared", "charts.legend.shared"]);
  }
  if (name === "dataShape") items.push(["reference", "charts.legend.parity"]);
  const list = document.createElement("ul");
  list.className = "viz-legend";
  for (const [kind, key] of items) {
    const li = document.createElement("li");
    const swatch = svg("svg", { width: 22, height: 12, "aria-hidden": "true" });
    if (kind === "range") svg("rect", { x: 1, y: 2, width: 20, height: 8, rx: 4, class: "v-range v-fresh" }, swatch);
    else if (kind === "compute" || kind === "transfer") svg("rect", { x: 1, y: 1, width: 20, height: 10, rx: 2, class: `v-${kind}` }, swatch);
    else if (kind === "native" || kind === "reference") svg("line", { x1: 11, x2: 11, y1: 0, y2: 12, class: kind === "native" ? "v-native" : "v-reference" }, swatch);
    else svg("circle", { cx: 11, cy: 6, r: kind === "shared" ? 4.5 : 4, class: `v-dot v-${kind}` }, swatch);
    const label = document.createElement("span");
    label.textContent = t(key);
    li.append(swatch, label);
    list.append(li);
  }
  return list;
}

function dataTable(t, f, rows, title) {
  const details = document.createElement("details");
  details.className = "viz-table";
  const summary = document.createElement("summary");
  summary.textContent = t("charts.table.summary");
  const wrap = scrollRegion(`${summary.textContent}: ${title}`);
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const key of ["charts.table.env", "charts.table.case", "charts.table.fresh", "charts.table.shared", "charts.table.note"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = t(key);
    head.append(th);
  }
  const body = table.createTBody();
  const seen = new Set();
  const sources = new Set();
  for (const o of rows.flatMap((r) => r.observations ?? [])) {
    const key = `${o.env}|${o.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.add(o.fresh.source);
    const notes = [];
    if (o.fresh.divergent) notes.push(t("charts.table.divergent"));
    if (unstable(o.fresh, o.shared)) notes.push(t("charts.table.unstable"));
    const tr = body.insertRow();
    for (const [content, mono] of [[t(ENV[o.env]), false], [o.id, true], [f.record(o.fresh), false], [f.record(o.shared), false], [notes.join("; "), false]]) {
      const td = tr.insertCell();
      if (mono) {
        const code = document.createElement("code");
        code.textContent = content;
        td.append(code);
      } else td.textContent = content;
    }
  }
  const caption = table.createCaption();
  caption.textContent = t("charts.table.caption", { runs: [...sources].join(", ") });
  wrap.append(table);
  details.append(summary, wrap);
  return details;
}

const drawn = new Map();
const resize = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const state = drawn.get(entry.target);
    if (state && Math.abs(entry.contentRect.width - state.width) > 1) {
      state.width = entry.contentRect.width;
      state.draw();
    }
  }
});

/**
 * Fills every <figure data-chart="<name>"> and every [data-values] element.
 * i18n: { t(key, vars) → string, fill(element, key, vars), lang }.
 */
export async function renderCharts(root, i18n) {
  const { t, fill, lang } = i18n;
  const figures = [...root.querySelectorAll("figure[data-chart]")];
  const valueHolders = [...root.querySelectorAll("[data-values]")];
  let data;
  try {
    data = await loadData();
  } catch (error) {
    for (const figure of figures) {
      const message = document.createElement("p");
      message.className = "viz-error";
      message.textContent = t("charts.error", { error: error.message });
      figure.replaceChildren(message);
    }
    throw error;
  }
  const f = formats(lang);
  const built = {};
  for (const [name, build] of Object.entries(CHARTS)) built[name] = build(data, t, f);
  for (const plot of drawn.keys()) resize.unobserve(plot);
  drawn.clear();

  for (const figure of figures) {
    const name = figure.dataset.chart;
    const chart = built[name];
    if (!chart) throw new Error(`unknown chart "${name}"`);
    const caption = document.createElement("figcaption");
    const title = document.createElement("strong");
    const reading = document.createElement("p");
    const description = document.createElement("p");
    fill(title, `charts.${name}.title`);
    fill(reading, `charts.${name}.reading`, chart.vars);
    fill(description, `charts.${name}.description`);
    description.className = "viz-description";
    caption.append(title, reading, description);
    const plot = document.createElement("div");
    plot.className = "viz-plot";
    const note = document.createElement("p");
    note.className = "viz-description";
    fill(note, "charts.note");
    figure.replaceChildren(caption, legend(t, name), plot, note, dataTable(t, f, chart.rows, title.textContent));

    const draw = () => drawRows(plot, { ...chart, axis: t(`charts.${name}.axis`), label: t(`charts.${name}.title`) });
    drawn.set(plot, { width: plot.clientWidth, draw });
    resize.observe(plot);
    draw();
  }

  // Sentences elsewhere on the page that quote measured values: data-i18n + data-values.
  const values = patternValues(data, f, built);
  for (const element of valueHolders) fill(element, element.dataset.i18n, values);
  const borrowed = root.querySelector("[data-borrowed]");
  if (borrowed) borrowed.replaceChildren(borrowedTable(data, t, f));
}

/** Values quoted by the data-shape patterns. */
function patternValues(data, f, built) {
  const sizes = [16, 64, 1024, 65536, 1048576, 16777216];
  let borrowed = 1;
  for (const env of [...RUNTIMES, "scriptc"]) {
    for (const path of ["napi", "ffi"]) {
      const medians = sizes.map((s) => observe(data, env, `bytes_len/${path}/${s}`)?.fresh.median_ns).filter(Boolean);
      if (medians.length) borrowed = Math.max(borrowed, Math.max(...medians) / Math.min(...medians));
    }
  }
  const ratios = (nativeIds, tsId, invert) =>
    RUNTIMES.flatMap((env) =>
      nativeIds.map((id) => [observe(data, env, id), observe(data, env, tsId)]).filter(([n]) => n)
        .flatMap(([n, s]) => ["fresh", "shared"].map((m) => invert ? s[m].median_ns / n[m].median_ns : n[m].median_ns / s[m].median_ns))
    );
  const range = (xs) => f.ratioRange(Math.min(...xs), Math.max(...xs));
  return {
    borrowed: f.ratio(borrowed),
    copy: built.wasmSplit.vars.transfer,
    native: built.wasmSum.vars.native,
    bytesOut: range(ratios(["return_bytes/napi/16777216"], "return_bytes/ts/16777216", true)),
    objects: range(ratios(["return_rows/napi.objects/10000"], "return_rows/ts/10000")),
    packed: range(ratios(["return_rows/napi.packed/10000", "return_rows/ffi.packed/10000"], "return_rows/ts/10000")),
  };
}

/** Buffer hand-over at the smallest and largest size, per borrowed native path. */
function borrowedTable(data, t, f) {
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const label of [t("charts.table.env"), t("charts.table.case"), "16 B", "16 MiB"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const env of [...RUNTIMES, "scriptc"]) {
    for (const path of ["napi", "ffi"]) {
      const small = observe(data, env, `bytes_len/${path}/16`);
      const large = observe(data, env, `bytes_len/${path}/16777216`);
      if (!small || !large) continue;
      const tr = body.insertRow();
      tr.insertCell().textContent = t(ENV[env]);
      const code = document.createElement("code");
      code.textContent = `bytes_len/${path}`;
      tr.insertCell().append(code);
      tr.insertCell().textContent = f.obs(small);
      tr.insertCell().textContent = f.obs(large);
    }
  }
  const wrap = scrollRegion(t("dataShape.patterns.0.title"));
  wrap.append(table);
  return wrap;
}

/** A table container that may scroll sideways: keyboard-reachable and named. */
function scrollRegion(label) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", label);
  return wrap;
}
