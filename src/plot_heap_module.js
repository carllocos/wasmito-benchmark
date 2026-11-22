#!/usr/bin/env node
// Plots the heap the hooks of each analysis consume in WARDuino
// (deploy_delta of heap.csv) against the size of the Wasm module, on log-log
// axes, and reports how strongly the two correlate.
//
// Usage: node plot_heap_module.js [options] <heap.csv> <modules-dir> <out-dir>
//
// Writes to <out-dir>:
//   heap_vs_module_size.{pdf,png}        the plot
//   heap_vs_module_size_correlation.csv  per analysis: Spearman's rho, the
//                                        Pearson r of the log10 values, and
//                                        the slope of the log-log fit
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from 'canvas';
import { Command } from 'commander';

// The colours and font of the other plots (plot_util.js).
const COLORS = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  series: '#0072b2',
};
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const RASTER_SCALE = 2;

// ---------------------------------------------------------------- data ---

/** Reads heap.csv into [{analysis, wasm, before, delta}], bytes as numbers. */
function readHeapCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const col = Object.fromEntries(header.split(',').map((name, i) => [name, i]));
  for (const name of ['analysis', 'wasm', 'deploy_delta']) {
    if (!(name in col)) throw new Error(`${file}: missing column '${name}'`);
  }
  return lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const f = line.split(',');
      return { analysis: f[col.analysis], wasm: f[col.wasm], delta: Number(f[col.deploy_delta]) };
    });
}

/** Ranks, 1-based, ties get the average of their ranks. */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pearson(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Least squares y = a + b x. */
function linearFit(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Correlation of module size and heap, x and y in bytes. */
function correlate(xs, ys) {
  const lx = xs.map(Math.log10);
  const ly = ys.map(Math.log10);
  return {
    n: xs.length,
    spearman: pearson(ranks(xs), ranks(ys)),
    pearsonLog: pearson(lx, ly),
    slope: linearFit(lx, ly).b,
  };
}

// ---------------------------------------------------------------- plot ---

function setFont(ctx, px, weight = '') {
  ctx.font = `${weight} ${px}px ${FONT}`.trim();
}

/** "1 KB", "10 MB", ... for a power of ten of bytes (1 KB = 1000 B). */
function bytesLabel(v) {
  const units = [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB'], [1, 'B']];
  const [div, unit] = units.find(([d]) => v >= d);
  return `${Math.round(v / div)} ${unit}`;
}

function render(points, modules, fit, overall, format) {
  const W = 640;
  const H = 460;
  const scale = format === 'pdf' ? 1 : RASTER_SCALE;
  const canvas = format === 'pdf' ? createCanvas(W, H, 'pdf') : createCanvas(W * scale, H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = COLORS.surface;
  ctx.fillRect(0, 0, W, H);

  // Header.
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.ink;
  setFont(ctx, 16, 'bold');
  ctx.fillText('Heap used by the hooks vs. Wasm module size', 24, 30);
  ctx.fillStyle = COLORS.inkSecondary;
  setFont(ctx, 11);
  ctx.fillText(
    `Spearman ρ = ${overall.spearman.toFixed(2)}, log–log slope = ${fit.b.toFixed(2)} ` +
      `(all ${points.length} analysis × module pairs); ` +
      `per analysis ρ = ${overall.minRho.toFixed(2)}–${overall.maxRho.toFixed(2)}`,
    24,
    48,
  );

  // Plot area and log axes over whole decades.
  const plot = { left: 76, right: W - 24, top: 70, bottom: H - 56 };
  const decades = (vals) => [
    Math.floor(Math.log10(Math.min(...vals))),
    Math.ceil(Math.log10(Math.max(...vals))),
  ];
  const [x0, x1] = decades(points.map((p) => p.size));
  const [y0, y1] = decades(points.map((p) => p.delta));
  const sx = (v) => plot.left + ((Math.log10(v) - x0) / (x1 - x0)) * (plot.right - plot.left);
  const sy = (v) => plot.bottom - ((Math.log10(v) - y0) / (y1 - y0)) * (plot.bottom - plot.top);

  // Grid and tick labels.
  ctx.lineWidth = 1;
  setFont(ctx, 10);
  ctx.fillStyle = COLORS.muted;
  for (let e = x0; e <= x1; e++) {
    const x = sx(10 ** e);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(x, plot.top);
    ctx.lineTo(x, plot.bottom);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(bytesLabel(10 ** e), x, plot.bottom + 16);
  }
  for (let e = y0; e <= y1; e++) {
    const y = sy(10 ** e);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(bytesLabel(10 ** e), plot.left - 8, y + 3.5);
  }
  ctx.strokeStyle = COLORS.axis;
  ctx.beginPath();
  ctx.moveTo(plot.left, plot.bottom);
  ctx.lineTo(plot.right, plot.bottom);
  ctx.stroke();

  // Axis titles.
  ctx.fillStyle = COLORS.inkSecondary;
  setFont(ctx, 11);
  ctx.textAlign = 'center';
  ctx.fillText('Wasm module size (log scale)', (plot.left + plot.right) / 2, H - 18);
  ctx.save();
  ctx.translate(20, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Heap used by deploying the hooks (log scale)', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.clip();

  // Log-log fit over all pairs.
  ctx.strokeStyle = COLORS.inkSecondary;
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(sx(10 ** x0), sy(10 ** (fit.a + fit.b * x0)));
  ctx.lineTo(sx(10 ** x1), sy(10 ** (fit.a + fit.b * x1)));
  ctx.stroke();
  ctx.setLineDash([]);

  // Per module: min-max range over the analyses.
  ctx.strokeStyle = COLORS.series;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const m of modules) {
    ctx.beginPath();
    ctx.moveTo(sx(m.size), sy(m.min));
    ctx.lineTo(sx(m.size), sy(m.max));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // One point per (analysis, module).
  ctx.strokeStyle = COLORS.muted;
  ctx.lineWidth = 1;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(sx(p.size), sy(p.delta), 2.5, 0, 2 * Math.PI);
    ctx.stroke();
  }

  // Per module: median over the analyses, with a surface ring.
  for (const m of modules) {
    ctx.beginPath();
    ctx.arc(sx(m.size), sy(m.median), 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = COLORS.series;
    ctx.fill();
    ctx.strokeStyle = COLORS.surface;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();

  // Legend, top left of the plot (the data runs bottom left to top right).
  const lx = plot.left + 12;
  let ly = plot.top + 14;
  const legendBox = { left: lx, right: lx + 170, top: plot.top, bottom: plot.top + 14 + 4 * 15 };
  setFont(ctx, 10);
  ctx.textAlign = 'left';
  const entry = (draw, label) => {
    draw(lx + 6, ly - 3.5);
    ctx.fillStyle = COLORS.inkSecondary;
    ctx.fillText(label, lx + 20, ly);
    ly += 15;
  };
  entry((x, y) => {
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
    ctx.stroke();
  }, 'one analysis on one module');
  entry((x, y) => {
    ctx.fillStyle = COLORS.series;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
    ctx.fill();
  }, 'median over the analyses');
  entry((x, y) => {
    ctx.strokeStyle = COLORS.series;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x, y + 6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, 'min–max over the analyses');
  entry((x, y) => {
    ctx.strokeStyle = COLORS.inkSecondary;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x - 7, y);
    ctx.lineTo(x + 7, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }, 'log–log least-squares fit');

  // Module labels, centred under the lowest point of the module (the lower
  // right of the plot is empty), merged for modules of about the same size
  // (the same column), and moved down until they clear every mark and label.
  setFont(ctx, 10);
  const obstacles = [legendBox];
  for (const p of points) {
    const x = sx(p.size);
    const y = sy(p.delta);
    obstacles.push({ left: x - 3.5, right: x + 3.5, top: y - 3.5, bottom: y + 3.5 });
  }
  for (const m of modules) {
    const x = sx(m.size);
    obstacles.push({ left: x - 2, right: x + 2, top: sy(m.max) - 2, bottom: sy(m.min) + 2 });
  }
  const fitY = (x) => {
    const lx10 = x0 + ((x - plot.left) / (plot.right - plot.left)) * (x1 - x0);
    return sy(10 ** (fit.a + fit.b * lx10));
  };
  const overlaps = (a, b) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const crossesFit = (r) => {
    const ya = fitY(r.left);
    const yb = fitY(r.right);
    return Math.max(ya, yb) > r.top && Math.min(ya, yb) < r.bottom;
  };

  const groups = [];
  for (const m of [...modules].sort((a, b) => a.size - b.size)) {
    const x = sx(m.size);
    const g = groups.find((o) => Math.abs(o.x - x) < 6);
    if (g) {
      g.names.push(m.name);
      g.bottom = Math.max(g.bottom, sy(m.min));
    } else groups.push({ x, bottom: sy(m.min), names: [m.name] });
  }
  const labels = [];
  for (const g of groups.sort((a, b) => a.x - b.x)) {
    const text = g.names.join(', ');
    const w = ctx.measureText(text).width;
    const left = Math.min(Math.max(g.x - w / 2, plot.left + 2), plot.right - w - 2);
    const box = (top) => ({ left: left - 2, right: left + w + 2, top, bottom: top + 12 });
    let top = g.bottom + 6;
    const blocked = (b) =>
      [...obstacles, ...labels].some((o) => overlaps(b, o)) || crossesFit(b);
    while (blocked(box(top)) && top + 12 < plot.bottom) top += 2;
    const b = box(top);
    labels.push(b);
    if (top > g.bottom + 7) {
      // Leader line from the lowest point down to the label.
      ctx.strokeStyle = COLORS.axis;
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(g.x, g.bottom + 4);
      ctx.lineTo(Math.min(Math.max(g.x, b.left + 2), b.right - 2), top);
      ctx.stroke();
    }
    ctx.fillStyle = COLORS.inkSecondary;
    ctx.textAlign = 'left';
    ctx.fillText(text, left, top + 9);
  }

  switch (format) {
    case 'pdf':
      return canvas.toBuffer('application/pdf');
    case 'png':
      return canvas.toBuffer('image/png');
    default:
      throw new Error(`unknown format '${format}'`);
  }
}

// ----------------------------------------------------------------- cli ---

const program = new Command();
program
  .name('plot_heap_module')
  .description('Plot the heap used by the hooks against the Wasm module size.')
  .argument('<heap-csv>', 'heap.csv with analysis,wasm,...,deploy_delta')
  .argument('<modules-dir>', 'directory with the .wasm modules named in the CSV')
  .argument('<out-dir>', 'directory to write the plot and correlations to')
  .option('--analyses <list>', 'comma-separated analyses to include (default: all)')
  .option('--formats <list>', 'comma-separated output formats: pdf, png', 'pdf,png')
  .action((csvFile, modulesDir, outDir, opts) => {
    let rows = readHeapCsv(csvFile);
    if (opts.analyses) {
      const keep = new Set(opts.analyses.split(','));
      for (const a of keep) {
        if (!rows.some((r) => r.analysis === a)) throw new Error(`unknown analysis '${a}'`);
      }
      rows = rows.filter((r) => keep.has(r.analysis));
    }

    const sizes = new Map();
    for (const wasm of new Set(rows.map((r) => r.wasm))) {
      const file = path.join(modulesDir, wasm);
      if (fs.existsSync(file)) sizes.set(wasm, fs.statSync(file).size);
      else console.warn(`warning: '${file}' does not exist, leaving ${wasm} out`);
    }
    const points = rows
      .filter((r) => sizes.has(r.wasm) && r.delta > 0)
      .map((r) => ({ ...r, size: sizes.get(r.wasm) }));
    if (points.length < 3) throw new Error('need at least 3 points to plot');

    // Per module: median and range over the analyses.
    const byModule = Map.groupBy(points, (p) => p.wasm);
    const modules = [...byModule].map(([wasm, ps]) => {
      const ds = ps.map((p) => p.delta);
      return {
        name: wasm.replace(/\.wasm$/, ''),
        size: sizes.get(wasm),
        median: median(ds),
        min: Math.min(...ds),
        max: Math.max(...ds),
      };
    });

    // Correlations: per analysis, and over all pairs.
    const perAnalysis = [...Map.groupBy(points, (p) => p.analysis)].map(([analysis, ps]) => ({
      analysis,
      ...correlate(ps.map((p) => p.size), ps.map((p) => p.delta)),
    }));
    const all = correlate(points.map((p) => p.size), points.map((p) => p.delta));
    const fit = linearFit(points.map((p) => Math.log10(p.size)), points.map((p) => Math.log10(p.delta)));
    const rhos = perAnalysis.map((c) => c.spearman);
    const overall = { ...all, minRho: Math.min(...rhos), maxRho: Math.max(...rhos) };

    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, 'heap_vs_module_size');
    for (const format of opts.formats.split(',')) {
      fs.writeFileSync(`${base}.${format}`, render(points, modules, fit, overall, format));
      console.log(`> Wrote ${base}.${format}`);
    }
    const csv = [
      'analysis,n,spearman_rho,pearson_r_log10,loglog_slope',
      ...[...perAnalysis, { analysis: 'all', ...all }].map(
        (c) =>
          `${c.analysis},${c.n},${c.spearman.toFixed(4)},${c.pearsonLog.toFixed(4)},${c.slope.toFixed(4)}`,
      ),
    ].join('\n');
    fs.writeFileSync(`${base}_correlation.csv`, `${csv}\n`);
    console.log(`> Wrote ${base}_correlation.csv`);
  });

program.parseAsync().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
