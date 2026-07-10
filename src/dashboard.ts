import { Hono } from "hono";
import { cfg } from "./config.js";
import { ledger } from "./ledger.js";

/**
 * Operator dashboard: GET /dashboard (self-contained HTML, no external assets)
 * backed by GET /dashboard/data (ledger aggregates). Unpaid endpoints — they sit
 * in front of the payment middleware. Everything renders client-side from the
 * JSON so the page stays a static string.
 */

const MAX_RANGE_MS = 5 * 365 * 24 * 3600_000;

export const dashboard = new Hono();

dashboard.get("/data", (c) => {
  const now = Date.now();
  const rangeMs = Math.min(Math.max(Number(c.req.query("range") ?? 0), 0), MAX_RANGE_MS);
  const bucketMs = Math.min(
    Math.max(Number(c.req.query("bucket") ?? 3600_000), 60_000),
    7 * 24 * 3600_000,
  );
  if (!Number.isFinite(rangeMs) || !Number.isFinite(bucketMs)) {
    return c.json({ error: "range and bucket must be numbers (ms)" }, 400);
  }
  const since = rangeMs === 0 ? 0 : now - rangeMs;

  return c.json({
    now,
    since,
    bucketMs,
    network: cfg.networkName,
    markup: cfg.markup,
    spendCapPerMinUsd: cfg.globalSpendCapPerMinUsd,
    spendLastMinUsd: ledger.upstreamSpendUsdSince(now - 60_000),
    summary: ledger.summary(since, now + 1),
    // Same-length window immediately before, for the revenue delta. Meaningless
    // for the all-time view, so the client hides the delta when since === 0.
    prev: since === 0 ? null : ledger.summary(since - rangeMs, since),
    buckets: ledger.bucketsSince(since, bucketMs),
    models: ledger.byModelSince(since),
    statuses: ledger.byStatusSince(since),
    recent: ledger.recentSince(since, 50),
  });
});

dashboard.get("/", (c) => c.html(PAGE));

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402 gateway — dashboard</title>
<style>
  :root {
    --page: #f9f9f7; --surface: #fcfcfb;
    --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --accent: #2a78d6; --accent-track: #cde2fb;
    --good: #0ca30c; --good-text: #006300; --warn: #fab219; --warn-track: #fbe8c2;
    --serious: #ec835a; --critical: #d03b3b; --critical-track: #f3cdcd;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #0d0d0d; --surface: #1a1a19;
      --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --accent: #3987e5; --accent-track: #0d366b;
      --good-text: #0ca30c; --warn-track: #4a3a10; --critical-track: #4a1d1d;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--page); color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px 20px 48px;
  }
  .wrap { max-width: 1120px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  header h1 { font-size: 17px; font-weight: 600; }
  header .net { color: var(--ink2); font-size: 12px; border: 1px solid var(--border); border-radius: 99px; padding: 2px 10px; }
  header .spacer { flex: 1; }
  .live { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .live .dot { width: 7px; height: 7px; border-radius: 99px; background: var(--good); }
  .live.stale .dot { background: var(--muted); }

  .filters { display: flex; gap: 6px; margin-bottom: 16px; }
  .filters button {
    font: inherit; font-size: 13px; color: var(--ink2); background: var(--surface);
    border: 1px solid var(--border); border-radius: 8px; padding: 5px 12px; cursor: pointer;
  }
  .filters button:hover { color: var(--ink); }
  .filters button[aria-pressed="true"] { color: var(--ink); font-weight: 600; border-color: var(--axis); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .tile .label { color: var(--ink2); font-size: 13px; }
  .tile .value { font-size: 30px; font-weight: 600; margin-top: 4px; }
  .tile .value.hero { font-size: 48px; line-height: 1.1; }
  .tile .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .tile .delta { font-size: 13px; font-weight: 500; margin-top: 4px; }
  .tile .delta.up { color: var(--good-text); }
  .tile .delta.down { color: var(--critical); }
  .meter { margin-top: 14px; height: 8px; border-radius: 99px; background: var(--accent-track); overflow: hidden; }
  .meter .fill { height: 100%; border-radius: 99px; background: var(--accent); }

  .grid2 { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; margin-bottom: 12px; }
  @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
  .card h2 { font-size: 13px; font-weight: 600; color: var(--ink2); margin-bottom: 12px; }
  .card .head { display: flex; align-items: baseline; justify-content: space-between; }
  .card .head button {
    font: inherit; font-size: 12px; color: var(--muted); background: none;
    border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; cursor: pointer;
  }
  .chartbox { position: relative; }
  .chartbox svg { display: block; width: 100%; height: auto; }
  .chartbox .hit:focus { outline: none; }
  .chartbox .hit:focus + rect, .chartbox .hit:hover + rect { opacity: 1; }
  .tooltip {
    position: absolute; pointer-events: none; z-index: 2; display: none;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12); padding: 8px 10px; font-size: 12px; min-width: 120px;
  }
  .tooltip .t-when { color: var(--muted); margin-bottom: 4px; }
  .tooltip .t-row { display: flex; justify-content: space-between; gap: 12px; }
  .tooltip .t-row .v { font-weight: 600; }
  .tooltip .t-row .k { color: var(--ink2); }

  .empty { color: var(--muted); padding: 32px 0; text-align: center; }

  .bars .row { display: grid; grid-template-columns: 110px 1fr 70px; align-items: center; gap: 10px; padding: 5px 0; font-size: 13px; }
  .bars .name { color: var(--ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bars .track { height: 16px; position: relative; }
  .bars .bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); border-radius: 0 4px 4px 0; min-width: 2px; }
  .bars .val { text-align: right; font-variant-numeric: tabular-nums; }
  .bars .val .n { color: var(--muted); }

  .statuses .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
  .statuses .icon { width: 16px; text-align: center; font-weight: 700; }
  .statuses .name { color: var(--ink2); flex: 1; }
  .statuses .count { font-variant-numeric: tabular-nums; font-weight: 600; }
  .statuses .track { width: 72px; height: 6px; border-radius: 99px; background: var(--grid); overflow: hidden; }
  .statuses .track .fill { display: block; height: 100%; border-radius: 99px; }

  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  td { padding: 7px 12px 7px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink2); }
  .chip .icon { font-weight: 700; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>x402 inference gateway</h1>
    <span class="net" id="net"></span>
    <span class="spacer"></span>
    <span class="live stale" id="live"><span class="dot"></span><span id="live-text">connecting…</span></span>
  </header>

  <div class="filters" id="filters" role="group" aria-label="Date range"></div>

  <div id="content" style="transition: opacity .15s">
    <div class="tiles" id="tiles"></div>
    <div class="grid2">
      <div class="card">
        <div class="head">
          <h2 id="rev-title">Revenue over time (USDC)</h2>
          <button id="rev-toggle" aria-pressed="false">table</button>
        </div>
        <div class="chartbox" id="rev-chart"></div>
      </div>
      <div class="card">
        <h2>Requests by status</h2>
        <div class="statuses" id="statuses"></div>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <h2>Revenue by model (USDC)</h2>
        <div class="bars" id="models"></div>
      </div>
      <div class="card">
        <h2>Unit economics</h2>
        <div class="bars" id="econ"></div>
      </div>
    </div>
    <div class="card">
      <h2>Recent requests</h2>
      <div class="tablewrap"><table id="recent"></table></div>
    </div>
  </div>
</div>

<script>
"use strict";
var HOUR = 3600000, DAY = 86400000;
var PRESETS = [
  { key: "today", label: "Today", bucket: HOUR },
  { key: "24h", label: "24h", range: 24 * HOUR, bucket: HOUR },
  { key: "7d", label: "7 days", range: 7 * DAY, bucket: DAY },
  { key: "30d", label: "30 days", range: 30 * DAY, bucket: DAY },
  { key: "all", label: "All time", range: 0, bucket: DAY },
];
var STATUS = {
  settled:        { label: "settled",             color: "var(--good)",     icon: "\\u2713" },
  upstream_ok:    { label: "awaiting settlement", color: "var(--warn)",     icon: "\\u25D4" },
  pending:        { label: "in flight",           color: "var(--warn)",     icon: "\\u25CB" },
  canceled:       { label: "canceled (unbilled)", color: "var(--muted)",    icon: "\\u2298" },
  upstream_error: { label: "upstream error",      color: "var(--serious)",  icon: "!" },
  settle_failed:  { label: "settle failed",       color: "var(--critical)", icon: "\\u2715" },
};
var state = { preset: PRESETS[1], data: null, revAsTable: false, timer: null };

function el(tag, attrs, children) {
  var ns = tag === "svg" || attrs && attrs._svg;
  var node = ns
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === "_svg") continue;
    if (k === "text") node.textContent = attrs[k];
    else node.setAttribute(k, attrs[k]);
  }
  (children || []).forEach(function (ch) { if (ch) node.appendChild(ch); });
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function fmtUsd(v) {
  if (v == null) return "—";
  if (v === 0) return "$0";
  var abs = Math.abs(v);
  var s;
  if (abs >= 1000) s = v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  else if (abs >= 1) s = v.toFixed(2);
  else if (abs >= 0.01) s = v.toFixed(4);
  else s = v.toFixed(6).replace(/0+$/, "").replace(/\\.$/, "");
  return (v < 0 ? "-$" : "$") + s.replace("-", "");
}
function fmtCount(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e4) return (v / 1e3).toFixed(1) + "K";
  return v.toLocaleString("en-US");
}
function fmtBucket(ts, bucketMs) {
  var d = new Date(ts);
  if (bucketMs >= DAY) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtTime(ts) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}
function short(hex) { return hex ? hex.slice(0, 6) + "\\u2026" + hex.slice(-4) : "—"; }
function explorer() {
  return state.data && state.data.network === "mainnet"
    ? "https://basescan.org" : "https://sepolia.basescan.org";
}

function rangeMs(preset) {
  if (preset.key !== "today") return preset.range;
  var mid = new Date(); mid.setHours(0, 0, 0, 0);
  return Date.now() - mid.getTime();
}

function renderFilters() {
  var box = document.getElementById("filters");
  clear(box);
  PRESETS.forEach(function (p) {
    var b = el("button", { text: p.label, "aria-pressed": String(p === state.preset) });
    b.addEventListener("click", function () {
      state.preset = p;
      renderFilters();
      refresh();
    });
    box.appendChild(b);
  });
}

function tile(label, value, opts) {
  opts = opts || {};
  var kids = [
    el("div", { class: "label", text: label }),
    el("div", { class: "value" + (opts.hero ? " hero" : ""), text: value }),
  ];
  if (opts.delta) kids.push(el("div", { class: "delta " + opts.deltaDir, text: opts.delta }));
  if (opts.sub) kids.push(el("div", { class: "sub", text: opts.sub }));
  if (opts.meter) {
    var sev = opts.meter.ratio < 0.6 ? "var(--accent)"
      : opts.meter.ratio < 0.85 ? "var(--warn)" : "var(--critical)";
    var track = opts.meter.ratio < 0.6 ? "var(--accent-track)"
      : opts.meter.ratio < 0.85 ? "var(--warn-track)" : "var(--critical-track)";
    kids.push(el("div", { class: "meter", style: "background:" + track }, [
      el("div", { class: "fill", style: "width:" + Math.min(100, opts.meter.ratio * 100).toFixed(1) + "%;background:" + sev }),
    ]));
  }
  return el("div", { class: "card tile" }, kids);
}

function renderTiles(d) {
  var box = document.getElementById("tiles");
  clear(box);
  var s = d.summary;
  var margin = s.revenue_usd - s.settled_upstream_usd;

  var deltaOpts = {};
  if (d.prev && d.prev.requests > 0) {
    var diff = s.revenue_usd - d.prev.revenue_usd;
    deltaOpts.delta = (diff >= 0 ? "+" : "") + fmtUsd(diff).replace("$-", "-$") + " vs previous period";
    deltaOpts.deltaDir = diff >= 0 ? "up" : "down";
  }
  deltaOpts.hero = true;
  deltaOpts.sub = "settled on-chain";
  box.appendChild(tile("Revenue", fmtUsd(s.revenue_usd), deltaOpts));

  box.appendChild(tile("Gross margin", fmtUsd(margin), {
    sub: "revenue minus upstream cost of settled requests",
  }));

  var settleRate = s.requests ? Math.round((s.settled / s.requests) * 100) : 0;
  box.appendChild(tile("Requests", fmtCount(s.requests), {
    sub: s.requests
      ? settleRate + "% settled \\u00B7 " + fmtCount(s.tokens) + " tokens \\u00B7 " + fmtCount(s.payers) + " payer" + (s.payers === 1 ? "" : "s")
      : "no traffic in this range",
  }));

  var ratio = d.spendCapPerMinUsd > 0 ? d.spendLastMinUsd / d.spendCapPerMinUsd : 0;
  box.appendChild(tile("Spend cap, last minute", fmtUsd(d.spendLastMinUsd), {
    sub: "of " + fmtUsd(d.spendCapPerMinUsd) + " upstream cap per rolling minute",
    meter: { ratio: ratio },
  }));
}

/* Continuous bucket series: the ledger only returns buckets that have rows. */
function filledBuckets(d) {
  var by = {};
  d.buckets.forEach(function (b) { by[b.bucket] = b; });
  var start = d.since > 0 ? Math.floor(d.since / d.bucketMs) * d.bucketMs
    : d.buckets.length ? d.buckets[0].bucket : Math.floor(d.now / d.bucketMs) * d.bucketMs;
  var out = [];
  for (var t = start; t <= d.now; t += d.bucketMs) {
    out.push(by[t] || { bucket: t, requests: 0, revenue_usd: 0 });
  }
  return out;
}

function niceMax(v) {
  if (v <= 0) return 1;
  var mag = Math.pow(10, Math.floor(Math.log10(v)));
  var n = v / mag;
  var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function renderRevChart(d) {
  var box = document.getElementById("rev-chart");
  clear(box);
  var buckets = filledBuckets(d);
  if (!d.summary.requests) {
    box.appendChild(el("div", { class: "empty", text: "No requests in this range yet." }));
    return;
  }
  if (state.revAsTable) { renderRevTable(box, d, buckets); return; }

  var W = 720, H = 220, padL = 70, padR = 8, padT = 18, padB = 26;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
    "aria-label": "Column chart of settled revenue per time bucket" });

  var maxRev = 0, maxIdx = 0;
  buckets.forEach(function (b, i) { if (b.revenue_usd > maxRev) { maxRev = b.revenue_usd; maxIdx = i; } });
  var yMax = niceMax(maxRev);

  // hairline grid + y ticks
  [0, 0.5, 1].forEach(function (f) {
    var y = padT + plotH - f * plotH;
    svg.appendChild(el("line", { _svg: 1, x1: padL, x2: W - padR, y1: y, y2: y,
      stroke: f === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
    svg.appendChild(el("text", { _svg: 1, x: padL - 8, y: y + 4, "text-anchor": "end",
      "font-size": 11, fill: "var(--muted)",
      style: "font-variant-numeric: tabular-nums",
      text: fmtUsd(yMax * f) }));
  });

  var n = buckets.length;
  var band = plotW / n;
  var barW = Math.min(24, Math.max(2, band - 2));
  var tooltip = el("div", { class: "tooltip" }, [
    el("div", { class: "t-when" }),
    el("div", { class: "t-row" }, [el("span", { class: "k", text: "revenue" }), el("span", { class: "v" })]),
    el("div", { class: "t-row" }, [el("span", { class: "k", text: "requests" }), el("span", { class: "v" })]),
  ]);

  var labelEvery = Math.max(1, Math.ceil(n / 6));
  buckets.forEach(function (b, i) {
    var cx = padL + band * i + band / 2;
    var h = yMax > 0 ? (b.revenue_usd / yMax) * plotH : 0;
    var y = padT + plotH - h;
    var x = cx - barW / 2;

    if (h > 0) {
      var r = Math.min(4, barW / 2, h);
      svg.appendChild(el("path", { _svg: 1, fill: "var(--accent)",
        d: "M" + x + " " + (padT + plotH) +
           " V" + (y + r) + " Q" + x + " " + y + " " + (x + r) + " " + y +
           " H" + (x + barW - r) + " Q" + (x + barW) + " " + y + " " + (x + barW) + " " + (y + r) +
           " V" + (padT + plotH) + " Z" }));
    }
    if (i === maxIdx && maxRev > 0) {
      svg.appendChild(el("text", { _svg: 1, x: cx, y: y - 5, "text-anchor": "middle",
        "font-size": 11, "font-weight": 600, fill: "var(--ink2)", text: fmtUsd(b.revenue_usd) }));
    }
    if (i % labelEvery === 0) {
      svg.appendChild(el("text", { _svg: 1, x: cx, y: H - 8, "text-anchor": "middle",
        "font-size": 11, fill: "var(--muted)", text: fmtBucket(b.bucket, d.bucketMs) }));
    }

    // full-band hit target, hover lift as a soft wash behind the column
    var hit = el("rect", { _svg: 1, class: "hit", x: padL + band * i, y: padT,
      width: band, height: plotH, fill: "transparent", tabindex: 0 });
    var lift = el("rect", { _svg: 1, x: padL + band * i, y: padT, width: band, height: plotH,
      fill: "var(--accent)", opacity: 0, "pointer-events": "none", style: "opacity:0" });
    function show() {
      lift.style.opacity = "0.08";
      tooltip.children[0].textContent = fmtBucket(b.bucket, d.bucketMs) +
        (d.bucketMs >= DAY ? "" : " \\u2013 " + fmtBucket(b.bucket + d.bucketMs, d.bucketMs));
      tooltip.children[1].lastChild.textContent = fmtUsd(b.revenue_usd);
      tooltip.children[2].lastChild.textContent = String(b.requests);
      tooltip.style.display = "block";
      var frac = (band * i + band / 2 + padL) / W;
      tooltip.style.left = Math.min(92, Math.max(2, frac * 100)) + "%";
      tooltip.style.transform = "translateX(" + (frac > 0.75 ? "-100%" : "8px") + ")";
      tooltip.style.top = "8px";
    }
    function hide() { lift.style.opacity = "0"; tooltip.style.display = "none"; }
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    svg.appendChild(hit);
    svg.appendChild(lift);
  });

  box.appendChild(svg);
  box.appendChild(tooltip);
}

function renderRevTable(box, d, buckets) {
  var table = el("table");
  table.appendChild(el("tr", null, [
    el("th", { text: "Bucket" }),
    el("th", { class: "num", text: "Revenue (USDC)" }),
    el("th", { class: "num", text: "Requests" }),
  ]));
  buckets.forEach(function (b) {
    if (!b.requests && !b.revenue_usd) return;
    table.appendChild(el("tr", null, [
      el("td", { text: fmtBucket(b.bucket, d.bucketMs) + " \\u00B7 " + new Date(b.bucket).toLocaleDateString("en-US", { month: "short", day: "numeric" }) }),
      el("td", { class: "num", text: fmtUsd(b.revenue_usd) }),
      el("td", { class: "num", text: String(b.requests) }),
    ]));
  });
  box.appendChild(el("div", { class: "tablewrap" }, [table]));
}

function renderModels(d) {
  var box = document.getElementById("models");
  clear(box);
  if (!d.models.length) {
    box.appendChild(el("div", { class: "empty", text: "No requests in this range yet." }));
    return;
  }
  var max = Math.max.apply(null, d.models.map(function (m) { return m.revenue_usd; }));
  d.models.forEach(function (m) {
    var w = max > 0 ? (m.revenue_usd / max) * 100 : 0;
    box.appendChild(el("div", { class: "row" }, [
      el("div", { class: "name", text: m.model, title: m.model }),
      el("div", { class: "track" }, [el("div", { class: "bar", style: "width:" + w.toFixed(1) + "%" })]),
      el("div", { class: "val" }, [
        el("div", { text: fmtUsd(m.revenue_usd) }),
        el("div", { class: "n", text: m.requests + " req" }),
      ]),
    ]));
  });
}

function renderEcon(d) {
  var box = document.getElementById("econ");
  clear(box);
  var s = d.summary;
  if (!s.settled) {
    box.appendChild(el("div", { class: "empty", text: "Nothing settled in this range yet." }));
    return;
  }
  var rows = [
    ["Avg revenue / settled request", fmtUsd(s.revenue_usd / s.settled)],
    ["Avg upstream cost / settled request", fmtUsd(s.settled_upstream_usd / s.settled)],
    ["Effective markup",
      s.settled_upstream_usd > 0
        ? "\\u00D7" + (s.revenue_usd / s.settled_upstream_usd).toFixed(2)
        : "\\u2014"],
    ["Configured markup", "\\u00D7" + d.markup.toFixed(2) + " (+ minimum bill floor)"],
  ];
  rows.forEach(function (r) {
    box.appendChild(el("div", { class: "row", style: "grid-template-columns: 1fr auto" }, [
      el("div", { class: "name", text: r[0], title: r[0] }),
      el("div", { class: "val", text: r[1] }),
    ]));
  });
}

function renderStatuses(d) {
  var box = document.getElementById("statuses");
  clear(box);
  if (!d.statuses.length) {
    box.appendChild(el("div", { class: "empty", text: "No requests in this range yet." }));
    return;
  }
  var total = d.statuses.reduce(function (a, s) { return a + s.count; }, 0);
  var order = Object.keys(STATUS);
  d.statuses.slice().sort(function (a, b) {
    return order.indexOf(a.status) - order.indexOf(b.status);
  }).forEach(function (s) {
    var meta = STATUS[s.status] || { label: s.status, color: "var(--muted)", icon: "?" };
    box.appendChild(el("div", { class: "row" }, [
      el("span", { class: "icon", style: "color:" + meta.color, text: meta.icon, "aria-hidden": "true" }),
      el("span", { class: "name", text: meta.label }),
      el("span", { class: "track" }, [
        el("span", { class: "fill", style: "width:" + ((s.count / total) * 100).toFixed(1) + "%;background:" + meta.color }),
      ]),
      el("span", { class: "count", text: String(s.count) }),
    ]));
  });
}

function renderRecent(d) {
  var table = document.getElementById("recent");
  clear(table);
  if (!d.recent.length) {
    table.appendChild(el("tr", null, [el("td", { class: "empty", text: "No requests in this range yet." })]));
    return;
  }
  table.appendChild(el("tr", null, [
    el("th", { text: "Time" }), el("th", { text: "Model" }),
    el("th", { class: "num", text: "Tokens in\\u2192out" }),
    el("th", { class: "num", text: "Billed" }),
    el("th", { class: "num", text: "Settled" }),
    el("th", { text: "Status" }), el("th", { text: "Payer" }), el("th", { text: "Tx" }),
  ]));
  d.recent.forEach(function (r) {
    var meta = STATUS[r.status] || { label: r.status, color: "var(--muted)", icon: "?" };
    var chip = el("span", { class: "chip" }, [
      el("span", { class: "icon", style: "color:" + meta.color, text: meta.icon, "aria-hidden": "true" }),
      el("span", { text: meta.label }),
    ]);
    if (r.error) chip.setAttribute("title", r.error);
    var payer = r.payer
      ? el("a", { href: explorer() + "/address/" + encodeURIComponent(r.payer), target: "_blank", rel: "noopener", text: short(r.payer) })
      : el("span", { text: "\\u2014" });
    var tx = r.tx_hash
      ? el("a", { href: explorer() + "/tx/" + encodeURIComponent(r.tx_hash), target: "_blank", rel: "noopener", text: short(r.tx_hash) })
      : el("span", { text: "\\u2014" });
    table.appendChild(el("tr", null, [
      el("td", { text: fmtTime(r.ts) }),
      el("td", { text: r.model }),
      el("td", { class: "num", text: r.prompt_tokens != null ? r.prompt_tokens + "\\u2192" + r.completion_tokens : "\\u2014" }),
      el("td", { class: "num", title: "quoted ceiling " + fmtUsd(r.quoted_ceiling_usd), text: fmtUsd(r.billed_usd) }),
      el("td", { class: "num", text: r.settled_atomic != null ? fmtUsd(Number(r.settled_atomic) / 1e6) : "\\u2014" }),
      el("td", null, [chip]),
      el("td", null, [payer]),
      el("td", null, [tx]),
    ]));
  });
}

function render(d) {
  state.data = d;
  document.getElementById("net").textContent =
    d.network === "mainnet" ? "Base mainnet" : "Base Sepolia (testnet)";
  renderTiles(d);
  renderRevChart(d);
  renderStatuses(d);
  renderModels(d);
  renderEcon(d);
  renderRecent(d);
}

function refresh() {
  var content = document.getElementById("content");
  var live = document.getElementById("live");
  if (state.data) content.style.opacity = "0.6"; // hold the frame, no skeleton
  var p = state.preset;
  fetch("/dashboard/data?range=" + rangeMs(p) + "&bucket=" + p.bucket)
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (d) {
      render(d);
      live.classList.remove("stale");
      document.getElementById("live-text").textContent =
        "live \\u00B7 updated " + new Date().toLocaleTimeString("en-US", { hour12: false });
    })
    .catch(function (err) {
      live.classList.add("stale");
      document.getElementById("live-text").textContent = "update failed (" + err.message + ")";
    })
    .then(function () { content.style.opacity = "1"; });
}

document.getElementById("rev-toggle").addEventListener("click", function () {
  state.revAsTable = !state.revAsTable;
  this.setAttribute("aria-pressed", String(state.revAsTable));
  this.textContent = state.revAsTable ? "chart" : "table";
  if (state.data) renderRevChart(state.data);
});

renderFilters();
refresh();
state.timer = setInterval(function () {
  if (!document.hidden) refresh();
}, 5000);
</script>
</body>
</html>`;
