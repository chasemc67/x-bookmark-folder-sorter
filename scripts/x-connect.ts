import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { startAuthorization } from '@vercel/connect';
import { sorterSettings } from '../config/sorter.js';
import { connectTarget, createTokenProvider } from '../src/app.js';
import { validateSettings } from '../src/config.js';
import { XAuthorizationRequiredError, xTokenParams } from '../src/x/auth.js';
import { fetchAuthenticatedUserId } from '../src/x/client.js';
import { loadLocalEnv } from './env.js';

/**
 * One-time authorization of an X account for a Vercel Connect `user` subject (default:
 * xConnectSubjectId in config). Needs VERCEL_OIDC_TOKEN from `vercel link` + `vercel env pull`.
 * Re-run it if the grant is ever revoked. `--subject` is for trying other subjects; the cron
 * only uses the configured one.
 */
const { values } = parseArgs({
  options: {
    subject: { type: 'string' },
    'callback-url': { type: 'string' },
  },
});

loadLocalEnv();
const settings = validateSettings({ ...sorterSettings, xConnectSubjectId: values.subject ?? sorterSettings.xConnectSubjectId });
const target = connectTarget(settings);
const tokens = createTokenProvider(target);

async function printXUser(): Promise<void> {
  const userId = await fetchAuthenticatedUserId(tokens);
  console.log(`Connect subject "${target.subjectId}" is authorized as X user id ${userId} on "${target.connector}".`);
  console.log('Optionally set xUserId in config/sorter.ts to skip the /2/users/me lookup each run.');
}

try {
  try {
    await printXUser();
  } catch (error) {
    if (!(error instanceof XAuthorizationRequiredError)) throw error;
    const { url } = await startAuthorization(
      target.connector,
      xTokenParams(target.subjectId),
      values['callback-url'] ? { callbackUrl: values['callback-url'] } : undefined,
    );
    console.log(`Open this URL, sign in to the X account for subject "${target.subjectId}", and approve access:\n\n${url}\n`);
    if (!process.stdin.isTTY) {
      console.log('Then run `npm run connect:x` again to verify.');
      process.exit(0);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('Press Enter after approving... ');
    rl.close();
    await printXUser();
  }
} catch (error) {
  console.error(`connect:x failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
