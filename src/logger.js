// A minimal stand-in for Wasmito's winston logger: same message format, and
// the level is read from the LogLevel environment variable (error, warn,
// info or debug; default info). LogLevel=off silences everything.

const LEVELS = ['error', 'warn', 'info', 'debug'];

let globalLogger;

function maxLevel() {
  const level = process.env.LogLevel ?? 'info';
  if (level === 'off') return -1;
  const idx = LEVELS.indexOf(level);
  return idx >= 0 ? idx : LEVELS.indexOf('info');
}

export function getGlobalLogger() {
  if (globalLogger === undefined) {
    const max = maxLevel();
    globalLogger = Object.fromEntries(
      LEVELS.map((name, idx) => [
        name,
        (message) => {
          if (idx <= max) {
            console.log(
              `[${new Date().toISOString()} ${name}] wasmito: ${message}`,
            );
          }
        },
      ]),
    );
  }
  return globalLogger;
}
