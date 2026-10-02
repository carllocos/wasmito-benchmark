#!/usr/bin/env node
import { Command } from 'commander';
import { registerPlotCommand } from './plot_command.js';

const program = new Command();
program
  .name('wasmito-plot')
  .description('Plot the benchmark CSVs of Wasmito and Whamm.');

registerPlotCommand(program);

program.parse();
