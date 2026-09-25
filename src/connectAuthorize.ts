import { ConnectError, getTokenResponse, startAuthorization } from '@vercel/connect';
import { sorterSettings, type SorterSettings } from '../config/sorter.js';
import { connectTarget } from './app.js';
import { validateSettings, type Env } from './config.js';
import { checkCronAuth } from './cronAuth.js';
import { jsonLog, type Log } from './log.js';
import { describeConnectError, isAuthorizationRequired, xTokenParams } from './x/auth.js';

export interface AuthorizeDeps {
  env?: Env;
  log?: Log;
  settings?: SorterSettings;
  getTokenResponse?: typeof getTokenResponse;
  startAuthorization?: typeof startAuthorization;
}

function connectErrorFields(error: unknown): Record<string, unknown> {
  return {
    error: (error as Error).name,
    ...(error instanceof ConnectError && { code: error.code, status: error.status }),
  };
}

/**
 * Production counterpart of `npm run connect:x`: both calls run under this deployment's OIDC
 * token, so the grant is created for the same project principal the cron uses. Bearer-only,
 * like the cron route, so CRON_SECRET never lands in request logs or browser history.
 */
export async function handleAuthorizeXRequest(request: Request, deps: AuthorizeDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? jsonLog;
  const auth = checkCronAuth(request.headers.get('authorization'), env.CRON_SECRET);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });

  let target;
  let settings;
  try {
    settings = validateSettings(deps.settings ?? sorterSettings);
    target = connectTarget(settings);
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
  const { connector, subjectId } = target;
  const params = xTokenParams(subjectId);

  try {
    const response = await (deps.getTokenResponse ?? getTokenResponse)(connector, params, { forceRefresh: true });
    log('connect_authorize_ok', { connector, subject: subjectId, tokenId: response.tokenId });
    return Response.json({
      ok: true,
      connector,
      subject: subjectId,
      xUserId: settings.xUserId || response.externalSubject || undefined,
      expiresAt: new Date(response.expiresAt).toISOString(),
    });
  } catch (error) {
    if (!isAuthorizationRequired(error)) {
      log('connect_authorize_failed', { connector, subject: subjectId, ...connectErrorFields(error) });
      return Response.json({ ok: false, error: describeConnectError(error, target).message }, { status: 500 });
    }
    log('connect_authorize_required', { connector, subject: subjectId, ...connectErrorFields(error) });
  }

  try {
    const { url } = await (deps.startAuthorization ?? startAuthorization)(connector, params);
    log('connect_authorize_started', { connector, subject: subjectId });
    return Response.json(
      { ok: false, authorizationRequired: true, connector, subject: subjectId, authorizeUrl: url },
      { status: 302, headers: { location: url, 'cache-control': 'no-store' } },
    );
  } catch (error) {
    log('connect_authorize_failed', { connector, subject: subjectId, ...connectErrorFields(error) });
    return Response.json({ ok: false, error: describeConnectError(error, target).message }, { status: 500 });
  }
}
