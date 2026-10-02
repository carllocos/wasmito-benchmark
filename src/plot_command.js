import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from './logger.js';
import {
  BASELINE_ANALYSIS,
  DEFAULT_ANALYSIS_PAIRS,
  METRICS,
  PLOT_FORMATS,
  PLOT_KINDS,
  WHAMM_BASELINE,
  computeModuleSlowdowns,
  computePhaseBreakdowns,
  computeSlowdownGroup,
  formatPhaseBreakdownsCsv,
  formatSlowdownTable,
  isMetric,
  mergeAnalysisPairs,
  parseAnalysisPair,
  parseBenchmarkCsv,
  withoutSpawn,
  writeBaselineComparisonPlot,
  writeBenchmarkPlot,
  writeModuleComparisonPlot,
  writePhasePlot,
  writeSlowdownPlot,
} from './plot_util.js';
import { formatMarkdownTables } from './markdown_tables.js';

function createDirectoryIfUnexisting(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function isFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** `outputDir/name`, created if it does not exist. */
function subdirectory(outputDir, name) {
  const dir = path.join(outputDir, name);
  createDirectoryIfUnexisting(dir);
  return dir;
}

/** The plot `name` in every format, in `outputDir`. */
function outputTargets(outputDir, name) {
  return PLOT_FORMATS.map((format) => ({
    format,
    path: path.join(outputDir, `${name}.${format}`),
  }));
}

export function registerPlotCommand(program) {
  program
    .command('plot')
    .description(
      `Plot a benchmark CSV file, as produced by the 'analysis' command, into PDF, PNG and JPG files in <output-dir>. By default the distribution and statistics (mean, median, min, max, standard deviation) of every analysis per Wasm module are plotted, as <metric>. With --slowdown the slowdown of every analysis relative to the '${BASELINE_ANALYSIS}' baseline is plotted instead, as slowdown. With a second CSV, produced by Whamm, both tools are compared per Wasm module as bars: the runtimes without analysis ('${BASELINE_ANALYSIS}' and '${WHAMM_BASELINE}') in engine/engine_absolute and, relative to each other, in engine/engine_relative; every analysis with its measured times next to the runtimes in analysis/analysis_absolute and with its slowdowns in analysis/analysis_relative; and how the phases of <csv-path> (parsing_ms, spawn_ms, register_ms, deploy_ms, run_ms) add up to its total_ms in wasmito_phases/wasmito_phases, with the mean time of every phase in wasmito_phases/wasmito_phases.csv. All the numbers are written as Markdown tables (columns per Wasm module, one per tool, and a row per statistic) to tables.md. With --whamm-optimised, the runs of Whamm on Wizard with optimisations enabled are added to every comparison, as wizard opt and wei + wizard opt.`,
    )
    .usage('[options] <csv-path> [whamm-csv-path] <output-dir>')
    .argument(
      '<paths...>',
      `<csv-path>: the benchmark CSV with header analysis,wasm,parsing_ms,spawn_ms,register_ms,deploy_ms,run_ms,total_ms. [whamm-csv-path]: a benchmark CSV produced by Whamm, with header analysis,wasm_module,time_ms, compared with <csv-path>; implies --slowdown. <output-dir>: the directory to store the plots in, created if it does not exist.`,
    )
    .option(
      '--pair <wasmito=whamm>',
      `an analysis of <csv-path> and the analysis of [whamm-csv-path] it is compared with, e.g. instruction-mix=ins_count-hw. Can be repeated. Replaces the default matches that share an analysis with it; the defaults are: ${DEFAULT_ANALYSIS_PAIRS.map(([a, b]) => `${a}=${b}`).join(', ')}. Analyses without a match are compared with the analysis of the same name, ignoring case, '-' and '_' and a plural 's'.`,
      (value, previous) => [...previous, value],
      [],
    )
    .option(
      '--whamm-optimised <csv-path>',
      'a benchmark CSV produced by Whamm like [whamm-csv-path], measured with the optimisations of Wizard enabled. Its runs are added to every plot and table that compares with [whamm-csv-path], named wizard opt without analysis and wei + wizard opt with one; its analyses are matched by the names of [whamm-csv-path]. It can also be given without [whamm-csv-path], to compare with the optimised Wizard only.',
    )
    .option(
      '--no-spawn',
      'leave the time wasmito spends spawning the VM out of every measurement of <csv-path>: spawn_ms is subtracted from total_ms, and the phases are shown without it',
    )
    .option(
      '--isolate-spawn',
      'keep spawn_ms in every measurement of <csv-path>, but draw it in wasmito_phases as a bar of its own next to the stack of the other phases',
    )
    .option(
      '--aggregate',
      'with [whamm-csv-path], compare the slowdown of every analysis over all Wasm modules together, as violins or ranges, in analysis_aggregate instead of per Wasm module as bars',
    )
    .option(
      '--slowdown',
      `plot the slowdown of every analysis relative to the '${BASELINE_ANALYSIS}' baseline of <csv-path>, computed on total_ms: the total time of each run divided by the mean total time of the baseline on the same Wasm module. Prints the statistics of the slowdowns.`,
    )
    .option(
      '-m, --metric <metric>',
      `the CSV column to plot, one of: ${METRICS.join(', ')}. Not applicable to --slowdown, which always uses total_ms.`,
      'total_ms',
    )
    .option(
      '-k, --kind <kind>',
      `the kind of plot, one of: ${PLOT_KINDS.join(', ')}. A 'violin' shows the distribution of the runs (at least 2 runs are needed to draw one), 'range' only min to max. Not applicable to the per Wasm module comparison, which draws bars.`,
      'violin',
    )
    .option(
      '-t, --title <title>',
      'the title of the plot; with [whamm-csv-path], of analysis_relative only',
    )
    .option('--no-title', 'draw no title on any of the plots')
    .option(
      '--no-min-max',
      'draw no whisker from the min to the max of the runs on the bars of analysis_absolute, analysis_relative, engine_absolute and engine_relative',
    )
    .option(
      '--log-scale',
      'use a logarithmic x-axis, which helps when analyses differ by orders of magnitude. The per Wasm module comparison always uses a logarithmic axis.',
    )
    .option('--width <pixels>', 'the width of the plot in pixels', '1400')
    .option(
      '--timeout <minutes>',
      'the time limit of a benchmark run, shown in the legend of the per Wasm module comparison',
      '10',
    )
    .action((paths, options) => {
      const logger = getGlobalLogger();
      if (paths.length < 2 || paths.length > 3) {
        program.error(
          'expected <csv-path> [whamm-csv-path] <output-dir>, got ' +
            `${paths.length} argument${paths.length === 1 ? '' : 's'}`,
        );
      }
      const csvPath = paths[0];
      const whammCsv = paths.length === 3 ? paths[1] : undefined;
      const whammOptCsv = options.whammOptimised;
      // Whamm is compared with when either of its CSVs is given: the one of
      // Wizard without optimisations, the one with (--whamm-optimised), or
      // both.
      const withWhamm = whammCsv !== undefined || whammOptCsv !== undefined;
      const outputDir = paths[paths.length - 1];
      const slowdown = withWhamm || options.slowdown === true;
      const perModule = withWhamm && options.aggregate !== true;
      const pairSpecs = options.pair;
      const noSpawn = options.spawn === false;
      // The wasmito CSV, without spawning with --no-spawn.
      const readWasmitoCsv = () => {
        const content = fs.readFileSync(csvPath, 'utf-8');
        return noSpawn ? withoutSpawn(content) : content;
      };
      const wasmitoColumn = noSpawn ? 'total_ms − spawn_ms' : 'total_ms';

      if (!isFilePath(csvPath)) {
        program.error('<csv-path> is not a valid path to a CSV file');
      }
      if (whammCsv !== undefined && !isFilePath(whammCsv)) {
        program.error('[whamm-csv-path] is not a valid path to a CSV file');
      }
      if (whammOptCsv !== undefined && !isFilePath(whammOptCsv)) {
        program.error('`--whamm-optimised` is not a valid path to a CSV file');
      }
      if (fs.existsSync(outputDir) && !fs.statSync(outputDir).isDirectory()) {
        program.error(`<output-dir> '${outputDir}' is not a directory`);
      }

      if (!isMetric(options.metric)) {
        program.error(
          `'${options.metric}' is not a valid metric. Choose one of: ${METRICS.join(', ')}`,
        );
      }
      if (pairSpecs.length > 0 && !withWhamm) {
        program.error(
          '`--pair` can only be used together with [whamm-csv-path] or `--whamm-optimised`',
        );
      }
      if (options.aggregate === true && !withWhamm) {
        program.error(
          '`--aggregate` can only be used together with [whamm-csv-path] or `--whamm-optimised`',
        );
      }
      let pairs = DEFAULT_ANALYSIS_PAIRS;
      try {
        pairs = mergeAnalysisPairs(
          DEFAULT_ANALYSIS_PAIRS,
          pairSpecs.map(parseAnalysisPair),
        );
      } catch (e) {
        program.error(`\`--pair\`: ${e instanceof Error ? e.message : e}`);
      }
      const isolateSpawn = options.isolateSpawn === true;
      if (noSpawn && isolateSpawn) {
        program.error(
          '`--no-spawn` leaves spawn_ms out, it cannot be used with `--isolate-spawn`',
        );
      }
      if (isolateSpawn && !perModule) {
        program.error(
          '`--isolate-spawn` only changes wasmito_phases, which is plotted with [whamm-csv-path] or `--whamm-optimised` and without `--aggregate`',
        );
      }
      if (noSpawn && options.metric === 'spawn_ms') {
        program.error('`--no-spawn` leaves out spawn_ms, it cannot be plotted');
      }
      if (slowdown && options.metric !== 'total_ms') {
        program.error(
          'the slowdown is computed on total_ms, `--metric` cannot be used with `--slowdown`, [whamm-csv-path] or `--whamm-optimised`',
        );
      }

      if (!PLOT_KINDS.includes(options.kind)) {
        program.error(
          `'${options.kind}' is not a valid kind. Choose one of: ${PLOT_KINDS.join(', ')}`,
        );
      }

      const width = Number(options.width);
      if (!Number.isInteger(width) || width < 600) {
        program.error('`--width` must be an integer of at least 600');
      }

      const timeoutMinutes = Number(options.timeout);
      if (!(timeoutMinutes > 0)) {
        program.error('`--timeout` must be a positive number of minutes');
      }

      const plotOptions = (format) => ({
        metric: options.metric,
        format,
        kind: options.kind,
        title: options.title,
        logScale: options.logScale === true,
        width,
      });

      const parseCsv = (path) => {
        const parsed = parseBenchmarkCsv(
          path === csvPath ? readWasmitoCsv() : fs.readFileSync(path, 'utf-8'),
          options.metric,
          (line, reason) =>
            logger.warn(`Skipping line ${line} of '${path}': ${reason}`),
        );
        if (parsed.runs === 0) {
          throw new Error(`'${path}' contains no usable rows to plot`);
        }
        return parsed;
      };

      try {
        const parsed = parseCsv(csvPath);
        createDirectoryIfUnexisting(outputDir);

        if (perModule) {
          const wasmito = {
            ...computeModuleSlowdowns(
              'wasmito',
              parsed,
              BASELINE_ANALYSIS,
              'warduino',
            ),
            timeColumn: wasmitoColumn,
          };
          const tools = [wasmito];
          if (whammCsv !== undefined) {
            tools.push({
              ...computeModuleSlowdowns(
                'whamm',
                parseCsv(whammCsv),
                WHAMM_BASELINE,
                'wizard',
                'wei',
              ),
              timeColumn: 'time_ms',
            });
          }
          if (whammOptCsv !== undefined) {
            tools.push({
              ...computeModuleSlowdowns(
                'whamm opt',
                parseCsv(whammOptCsv),
                WHAMM_BASELINE,
                'wizard opt',
                'wei',
              ),
              timeColumn: 'time_ms',
            });
          }
          const analysisDir = subdirectory(outputDir, 'analysis');
          const engineDir = subdirectory(outputDir, 'engine');
          const phasesDir = subdirectory(outputDir, 'wasmito_phases');

          // How the phases of wasmito make up its total time.
          const phases = computePhaseBreakdowns(readWasmitoCsv());
          const phasesPath = path.join(phasesDir, 'wasmito_phases.csv');
          fs.writeFileSync(phasesPath, formatPhaseBreakdownsCsv(phases));
          logger.info(`Wrote the phases of wasmito to ${phasesPath}`);

          // The numbers behind the plots as Markdown tables.
          const tablesPath = path.join(outputDir, 'tables.md');
          fs.writeFileSync(
            tablesPath,
            formatMarkdownTables(tools, phases, pairs, timeoutMinutes),
          );
          logger.info(`Wrote the tables to ${tablesPath}`);
          for (const target of outputTargets(phasesDir, 'wasmito_phases')) {
            writePhasePlot(
              phases,
              {
                format: target.format,
                title: options.title === false ? false : undefined,
                width,
                timeoutMinutes,
                isolateSpawn,
              },
              target.path,
            );
            logger.info(`Plotted the phases of wasmito to ${target.path}`);
          }
          for (const absolute of [false, true]) {
            const kind = absolute ? 'absolute' : 'relative';
            // The runtimes without analysis on their own.
            for (const target of outputTargets(engineDir, `engine_${kind}`)) {
              writeBaselineComparisonPlot(
                tools,
                {
                  format: target.format,
                  title: options.title === false ? false : undefined,
                  width,
                  absolute,
                  timeoutMinutes,
                  showMinMax: options.minMax,
                },
                target.path,
              );
              logger.info(
                `Plotted the ${absolute ? 'time' : 'relative time'} of the runtimes without analysis to ${target.path}`,
              );
            }
            // Every analysis of both tools.
            for (const target of outputTargets(
              analysisDir,
              `analysis_${kind}`,
            )) {
              writeModuleComparisonPlot(
                tools,
                pairs,
                {
                  format: target.format,
                  title:
                    absolute && options.title !== false
                      ? undefined
                      : options.title,
                  width,
                  absolute,
                  timeoutMinutes,
                  showMinMax: options.minMax,
                },
                target.path,
              );
              logger.info(
                `Plotted the ${absolute ? 'time' : 'slowdown'} per Wasm module of ${tools.map((t) => t.label).join(', ')} to ${target.path}`,
              );
            }
          }
          return;
        }

        if (!slowdown) {
          for (const target of outputTargets(outputDir, options.metric)) {
            writeBenchmarkPlot(parsed, plotOptions(target.format), target.path);
            logger.info(
              `Plotted ${parsed.runs} runs (${parsed.skippedRows} failed ${parsed.skippedRows === 1 ? 'run' : 'runs'} skipped) to ${target.path}`,
            );
          }
          return;
        }

        const groups = [
          computeSlowdownGroup('wasmito', parsed, BASELINE_ANALYSIS),
        ];
        if (whammCsv !== undefined) {
          groups.push(
            computeSlowdownGroup('whamm', parseCsv(whammCsv), WHAMM_BASELINE),
          );
        }
        if (whammOptCsv !== undefined) {
          groups.push(
            computeSlowdownGroup(
              'whamm opt',
              parseCsv(whammOptCsv),
              WHAMM_BASELINE,
            ),
          );
        }

        console.log(formatSlowdownTable(groups, pairs));
        const aggregateTargets = withWhamm
          ? outputTargets(
              subdirectory(outputDir, 'analysis'),
              'analysis_aggregate',
            )
          : outputTargets(outputDir, 'slowdown');
        for (const target of aggregateTargets) {
          writeSlowdownPlot(
            groups,
            plotOptions(target.format),
            target.path,
            pairs,
          );
          logger.info(
            `Plotted the slowdown of the ${groups.map((g) => g.label).join(' and ')} analyses to ${target.path}`,
          );
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : e;
        program.error(`Could not create plot, error occurred: ${errMsg}`);
      }
    });
}
