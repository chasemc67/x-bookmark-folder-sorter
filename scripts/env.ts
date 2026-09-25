import { existsSync } from 'node:fs';

/**
 * Loads `.env.local` (written by `vercel env pull`, including VERCEL_OIDC_TOKEN) and then `.env`
 * for local scripts. Earlier files win because process.loadEnvFile never overrides a set var.
 * Vercel injects env vars directly.
 */
export function loadLocalEnv(paths: string[] = ['.env.local', '.env']): void {
  for (const path of paths) if (existsSync(path)) process.loadEnvFile(path);
}
