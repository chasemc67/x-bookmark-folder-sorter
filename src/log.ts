export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** One JSON object per line so Vercel log search can filter by `event`. Never pass secrets. */
export const jsonLog: Log = (event, fields = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
};

export const silentLog: Log = () => {};
