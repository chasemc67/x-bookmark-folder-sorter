import { createServer } from 'node:http';
import { handleSortRequest } from '../src/handler.js';
import { loadLocalEnv } from './env.js';

loadLocalEnv();
const port = 3000;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method !== 'GET' || url.pathname !== '/api/cron/sort-bookmarks') {
    res.writeHead(404).end('Not found. Try GET /api/cron/sort-bookmarks\n');
    return;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
  const response = await handleSortRequest(new Request(url, { headers }));
  res.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text());
}).listen(port, '127.0.0.1', () => {
  console.log(`Local cron route: http://127.0.0.1:${port}/api/cron/sort-bookmarks (send Authorization: Bearer $CRON_SECRET)`);
});
