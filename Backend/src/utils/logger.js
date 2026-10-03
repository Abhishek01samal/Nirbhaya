const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function write(level, scope, message, meta) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const time = new Date().toISOString();
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta !== undefined) {
    fn(line, typeof meta === "object" ? JSON.stringify(meta) : meta);
  } else {
    fn(line);
  }
}

const logger = {
  debug: (scope, message, meta) => write("debug", scope, message, meta),
  info: (scope, message, meta) => write("info", scope, message, meta),
  warn: (scope, message, meta) => write("warn", scope, message, meta),
  error: (scope, message, meta) => write("error", scope, message, meta),
  child: (scope) => ({
    debug: (m, meta) => write("debug", scope, m, meta),
    info: (m, meta) => write("info", scope, m, meta),
    warn: (m, meta) => write("warn", scope, m, meta),
    error: (m, meta) => write("error", scope, m, meta),
  }),
};

export default logger;
