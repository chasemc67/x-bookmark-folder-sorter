import type { SorterSettings } from '../config/sorter.js';
import { loadConfig, type Env } from './config.js';
import { GatewayJevClient } from './jev/client.js';
import type { Log } from './log.js';
import { runSorter, type RunSummary } from './sorter/run.js';
import { ConnectTokenProvider, type XConnectTarget } from './x/auth.js';
import { fetchAuthenticatedUserId, XClient } from './x/client.js';
import type { AccessTokenProvider } from './x/types.js';

export function connectTarget(settings: Pick<SorterSettings, 'xConnectConnector' | 'xConnectSubjectId'>): XConnectTarget {
  return { connector: settings.xConnectConnector, subjectId: settings.xConnectSubjectId };
}

export function createTokenProvider(target: XConnectTarget, log?: Log): AccessTokenProvider {
  return new ConnectTokenProvider({ ...target, log });
}

export async function runFromEnv(
  env: Env,
  options: { forceDryRun?: boolean; forceLive?: boolean; log: Log },
): Promise<RunSummary> {
  const config = loadConfig(env);
  if (options.forceDryRun) config.dryRun = true;
  else if (options.forceLive) config.dryRun = false;
  const tokens = createTokenProvider(connectTarget(config), options.log);
  const userId = config.xUserId || await fetchAuthenticatedUserId(tokens);
  const x = new XClient({ tokens, userId, log: options.log });
  const jev = new GatewayJevClient({
    apiKey: config.secrets.aiGatewayApiKey,
    timeoutMs: config.jevTimeoutMs,
    zeroDataRetention: config.gatewayZeroDataRetention,
    log: options.log,
  });
  return runSorter(config, { x, jev, log: options.log });
}
