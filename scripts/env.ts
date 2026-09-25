import { existsSync } from 'node:fs';

/** Loads `.env` for local scripts; Vercel injects env vars directly. */
export function loadLocalEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
