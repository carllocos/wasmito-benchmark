import {
  PHASE_LABELS,
  analysisName,
  baselineName,
  breakdownPhases,
  phaseTime,
  phaseTotalName,
  timeColumnOf,
  matchAnalyses,
  moduleAnalyses,
  orderAnalyses,
  wasmDisplayName,
} from './plot_util.js';

/*
 * A Markdown report with the numbers behind the comparison plots: one table
 * per analysis with columns per Wasm module, one per tool, and a row per
 * statistic.
 */

/** The statistics of a table's rows, in order. */
const METRIC_ROWS = [
  { label: 'Mean (average)', value: (s) => s.mean },
  { label: 'Median', value: (s) => s.median },
  { label: 'Min', value: (s) => s.min },
  { label: 'Max', value: (s) => s.max },
  { label: 'Standard deviation', value: (s) => s.stdev },
  { label: 'Q1 (25th percentile)', value: (s) => s.q1 },
  { label: 'Q3 (75th percentile)', value: (s) => s.q3 },
];

/** Seconds with fewer decimals the larger they are: 0.022, 1.18, 16.4, 420. */
function seconds(ms) {
  const s = ms / 1000;
  if (s >= 100) return s.toFixed(0);
  if (s >= 10) return s.toFixed(1);
  if (s >= 1) return s.toFixed(2);
  return s.toFixed(3);
}

/** A slowdown without the ×, which the table's title carries: 1.03, 16.4, 2132. */
function ratio(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** Why a cell has no numbers. */
function missingText(cell) {
  if (cell?.failure === 'timeout') return 'timeout';
  if (cell?.failure === 'error') return 'error';
  if (cell?.runs !== undefined) return 'no baseline';
  return '–';
}

/** A Markdown table: a header row, right-aligned value columns, `rows`. */
function markdownTable(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [
    line(header),
    line(header.map((_, i) => (i === 0 ? '---' : '---:'))),
    ...rows.map(line),
  ].join('\n');
}

/** The Wasm modules of the tools, sorted by the name shown. */
function allWasms(tools) {
  return [...new Set(tools.flatMap((t) => [...t.cells.keys()]))].sort((a, b) =>
    wasmDisplayName(a).localeCompare(wasmDisplayName(b)),
  );
}

/** The analyses both tools have, as in the plots. */
function matchedAnalyses(first, second, pairs) {
  return matchAnalyses(
    moduleAnalyses(first),
    moduleAnalyses(second),
    pairs,
  ).filter((g) => g.first !== undefined && g.second !== undefined);
}

/** `35`, or `1–35` when the counts differ. */
function countRange(counts) {
  if (counts.length === 0) return 'none';
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

/** `a`, `a and b`, `a, b and c`. */
function listText(items) {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Where to find the cells of the tools, by the index of the tool.
 *
 * @typedef {(side: number, wasm: string) => ModuleCell | undefined} CellOf
 */

/** A row per statistic: its label, then per Wasm module a value per tool. */
function metricRows(sides, wasms, cellOf, statsOf, format, indent = '') {
  return METRIC_ROWS.map(({ label, value }) => [
    `${indent}${label}`,
    ...wasms.flatMap((wasm) =>
      sides.map((side) => {
        const cell = cellOf(side, wasm);
        const stats = statsOf(cell);
        return stats !== undefined ? format(value(stats)) : missingText(cell);
      }),
    ),
  ]);
}

/** The number of runs per Wasm module of the tools, per side. */
function runCounts(sides, wasms, cellOf, statsOf) {
  return sides.map((side) =>
    wasms.flatMap((wasm) => statsOf(cellOf(side, wasm))?.count ?? []),
  );
}

/** `35 for each tool`, or `wasmito 35, whamm 1–35` when they differ. */
function describeRuns(labels, counts) {
  const all = counts.flat();
  return all.length > 0 && all.every((n) => n === all[0])
    ? `${all[0]} for each tool`
    : labels
        .map((label, side) => `${label} ${countRange(counts[side])}`)
        .join(', ');
}

/** The index of every tool of `labels`. */
function sidesOf(labels) {
  return labels.map((_, side) => side);
}

/**
 * A row of a comparison table: statistics, or the name of an analysis.
 *
 * @typedef {string[] | {group: string}} ComparisonRow
 */

/**
 * A comparison as an HTML table, which Markdown renders but which, unlike a
 * Markdown table, can let every Wasm module's name span the columns of all
 * tools: a first header row with the modules, a second with the tools. A
 * vertical line precedes the columns of every module.
 */
function htmlComparisonTable(corner, wasms, labels, rows) {
  const width = 1 + wasms.length * labels.length;
  const separator = 'style="border-left: 2px solid"';
  /** The attributes of the `i`th value column, a separator on a module's first. */
  const at = (i) => (i % labels.length === 0 ? ` ${separator}` : '');
  const body = rows.map((row) =>
    Array.isArray(row)
      ? `<tr><td>${row[0]}</td>${row
          .slice(1)
          .map((cell, i) => `<td align="right"${at(i)}>${cell}</td>`)
          .join('')}</tr>`
      : `<tr><td colspan="${width}"><b>${row.group}</b></td></tr>`,
  );
  return [
    '<table>',
    '<thead>',
    `<tr><th rowspan="2" align="left">${corner}</th>${wasms
      .map(
        (w) =>
          `<th colspan="${labels.length}" ${separator}><code>${wasmDisplayName(w)}</code></th>`,
      )
      .join('')}</tr>`,
    `<tr>${wasms
      .map(() => labels.map((label, i) => `<th${at(i)}>${label}</th>`).join(''))
      .join('')}</tr>`,
    '</thead>',
    '<tbody>',
    ...body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

/**
 * The table of one analysis comparing the tools: columns per Wasm module,
 * one per tool, and a row per statistic of `statsOf`. It is preceded
 * by a line with the number of runs behind it.
 */
function comparisonTable(labels, wasms, cellOf, statsOf, format) {
  const sides = sidesOf(labels);
  return [
    `Runs per module: ${describeRuns(labels, runCounts(sides, wasms, cellOf, statsOf))}.`,
    '',
    htmlComparisonTable(
      'Metric',
      wasms,
      labels,
      metricRows(sides, wasms, cellOf, statsOf, format),
    ),
  ].join('\n');
}

/**
 * One table for several analyses: a bold row naming each analysis across
 * the whole width, then its
 * rows of statistics, indented. The run counts come first, in the text.
 */
function groupedComparisonTable(labels, wasms, groups, statsOf, format) {
  const sides = sidesOf(labels);
  const runs = groups.map((g) => ({
    name: g.name,
    runs: describeRuns(labels, runCounts(sides, wasms, g.cellOf, statsOf)),
  }));
  const runsText = runs.every((r) => r.runs === runs[0].runs)
    ? `Runs per module: ${runs[0].runs}, in every analysis.`
    : `Runs per module: ${runs.map((r) => `${r.name}: ${r.runs}`).join('; ')}.`;
  const rows = groups.flatMap((g) => [
    { group: g.name },
    ...metricRows(
      sides,
      wasms,
      g.cellOf,
      statsOf,
      format,
      '&nbsp;&nbsp;&nbsp;&nbsp;',
    ),
  ]);
  return [
    runsText,
    '',
    htmlComparisonTable('Analysis / metric', wasms, labels, rows),
  ].join('\n');
}

/**
 * The whole report: the absolute times of the tools, their slowdowns, and
 * the phases of the first tool (wasmito), each as one table per analysis.
 * The analyses of the first two tools are matched; the tools after the second
 * share the analysis names of the second.
 */
export function formatMarkdownTables(tools, phases, pairs, timeoutMinutes) {
  const [first, second, ...rest] = tools;
  const others = [second, ...rest];
  const wasms = allWasms(tools);
  const matched = matchedAnalyses(first, second, pairs);
  /** The cells of the analysis of the first tool, and of the others. */
  const cellIn =
    ([ofFirst, ofOthers]) =>
    (side, wasm) =>
      tools[side].cells.get(wasm)?.get(side === 0 ? ofFirst : ofOthers);
  const labels = tools.map((t) => t.label);
  const timeout =
    timeoutMinutes !== undefined
      ? `\`timeout\`: every run hit the ${timeoutMinutes} min limit`
      : '`timeout`: every run hit the time limit';

  const out = [
    `# ${labels.join(' vs ')}`,
    '',
    `Every Wasm module has ${['two', 'three'][tools.length - 2] ?? tools.length} columns, one for ${listText(labels.map((l, i) => (i === 0 ? l : `one for ${l}`)))}. ${timeout}; \`error\`: every run failed; \`–\`: no data; \`no baseline\`: the runtime without analysis never finished, so there is no slowdown. Mean and average are the same statistic.`,
    '',
    '## Absolute times (s)',
    '',
    `Total time in seconds of every run: ${tools.map((t) => `\`${timeColumnOf(t)}\` of ${analysisName(t)}`).join(', ')}. All analyses are in one table; in the rows without analysis, the ${listText(labels)} columns are the runtimes ${listText(tools.map(baselineName))} alone.`,
    '',
    groupedComparisonTable(
      labels,
      wasms,
      [
        {
          name: `no analysis (${tools.map(baselineName).join(' / ')})`,
          cellOf: (side, wasm) =>
            tools[side].cells.get(wasm)?.get(tools[side].baseline),
        },
        ...matched.map((g) => ({
          name: g.second,
          cellOf: cellIn([g.first, g.second]),
        })),
      ],
      (cell) => cell?.runs,
      seconds,
    ),
  ];

  // The analyzer, e.g. `wei`, unless another tool has the same one.
  const shortName = (tool) => {
    const short = (t) => t.analyzer ?? t.label;
    return tools.filter((t) => short(t) === short(tool)).length > 1
      ? analysisName(tool)
      : short(tool);
  };
  out.push(
    '',
    '## Relative times (×)',
    '',
    `Slowdown of every run: its time divided by the median time of the runtime without analysis on the same module (${tools.map((t) => `${baselineName(t)} for ${analysisName(t)}`).join(', ')}). Under every table, the median slowdown of ${listText(others.map(shortName))} divided by that of ${shortName(first)}.`,
  );
  for (const g of matched) {
    const cellOf = cellIn([g.first, g.second]);
    const compared = others.map((tool, i) => [
      `Median, ${shortName(tool)} / ${shortName(first)}`,
      ...wasms.map((wasm) => {
        const a = cellOf(0, wasm)?.slowdown;
        const b = cellOf(i + 1, wasm)?.slowdown;
        return a !== undefined && b !== undefined
          ? ratio(b.median / a.median)
          : '–';
      }),
    ]);
    out.push(
      '',
      `### ${g.second}`,
      '',
      comparisonTable(labels, wasms, cellOf, (cell) => cell?.slowdown, ratio),
      '',
      markdownTable(
        ['', ...wasms.map((w) => `\`${wasmDisplayName(w)}\``)],
        compared,
      ),
    );
  }

  const phaseList = breakdownPhases(phases);
  out.push(
    '',
    `## Phases of ${first.label}`,
    '',
    `Mean time in seconds of every phase of ${analysisName(first)} over the runs, with its share of the mean total time; the phases add up to the total (\`${phaseTotalName(phaseList)}\`). The few ms no phase accounts for count as ${phaseList.includes('spawn_ms') ? 'spawning' : `the last phase, ${PHASE_LABELS[phaseList[phaseList.length - 1]]}`}.`,
  );
  const phaseWasms = allWasms([first]);
  for (const analysis of orderAnalyses(phases.keys()).filter(
    (a) => a !== first.baseline,
  )) {
    const perAnalysis = phases.get(analysis);
    const row = (label, value) => [
      label,
      ...phaseWasms.map((wasm) => {
        const b = perAnalysis.get(wasm);
        if (b === undefined) return '–';
        return typeof b === 'string' ? b : value(wasm);
      }),
    ];
    const breakdown = (wasm) => {
      const b = perAnalysis.get(wasm);
      return typeof b === 'object' ? b : undefined;
    };
    const rows = [
      ...phaseList.map((p) =>
        row(PHASE_LABELS[p], (wasm) => {
          const b = breakdown(wasm);
          const ms = phaseTime(b, p, phaseList);
          const percent = (ms / b.total) * 100;
          return `${seconds(ms)} (${percent < 0.5 ? '<1' : Math.round(percent)}%)`;
        }),
      ),
      row('**Total, mean**', (wasm) => `**${seconds(breakdown(wasm).total)}**`),
      row('Total, standard deviation', (wasm) => {
        const total = first.cells.get(wasm)?.get(analysis)?.runs;
        return total !== undefined ? seconds(total.stdev) : '–';
      }),
    ];
    const runs = countRange(
      phaseWasms.flatMap((wasm) => breakdown(wasm)?.runs ?? []),
    );
    out.push(
      '',
      `### ${analysis}`,
      '',
      `Runs per module: ${runs}.`,
      '',
      markdownTable(
        ['Phase', ...phaseWasms.map((w) => `\`${wasmDisplayName(w)}\``)],
        rows,
      ),
    );
  }
  return out.join('\n') + '\n';
}
