// Structured logger — JSON lines on stdout. Just enough to be greppable in
// `docker logs` and friendly to a future log shipper. No dependency on pino /
// winston because we emit ~10 lines a minute and the format is trivial.

type Level = "debug" | "info" | "warn" | "error";

const MIN_LEVEL: Level = (process.env.CHORUM_CLASSIFIER_LOG_LEVEL as Level) || "info";

const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[MIN_LEVEL]) return;
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
