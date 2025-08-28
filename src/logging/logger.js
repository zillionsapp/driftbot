export function createLogger(cfg) {
  const now = () => new Date().toISOString();
  const base = (lvl, msg) => console[lvl](`[${now()}] ${msg}`);
  return {
    info: (m) => base('log', m),
    warn: (m) => base('warn', m),
    error: (m) => base('error', m),
    debug: (m) => { if (cfg.NODE_ENV !== 'production') base('log', `[DEBUG] ${m}`); }
  };
}
