import { runFromEnv } from './app.js';
import type { Env } from './config.js';
import { checkCronAuth } from './cronAuth.js';
import { jsonLog, type Log } from './log.js';
import type { RunSummary } from './sorter/run.js';

export interface HandlerDeps {
  env?: Env;
  log?: Log;
  run?: typeof runFromEnv;
}

const MAX_ACTIONS_IN_RESPONSE = 100;

/**
 * `?dry_run=1` can force a dry run for a manual trigger; there is intentionally no
 * query parameter that can force live mode.
 */
export async function handleSortRequest(request: Request, deps: HandlerDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? jsonLog;
  const auth = checkCronAuth(request.headers.get('authorization'), env.CRON_SECRET);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });

  const forceDryRun = ['1', 'true'].includes(new URL(request.url).searchParams.get('dry_run') ?? '');
  try {
    const summary: RunSummary = await (deps.run ?? runFromEnv)(env, { forceDryRun, log });
    return Response.json({
      ok: !summary.aborted,
      ...summary,
      actions: summary.actions.slice(0, MAX_ACTIONS_IN_RESPONSE),
      actionsTruncated: summary.actions.length > MAX_ACTIONS_IN_RESPONSE,
    }, { status: summary.aborted ? 502 : 200 });
  } catch (error) {
    log('run_failed', { message: (error as Error).message });
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
