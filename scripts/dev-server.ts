import { createServer } from 'node:http';
import { handleAuthorizeXRequest } from '../src/connectAuthorize.js';
import { handleSortRequest } from '../src/handler.js';
import { loadLocalEnv } from './env.js';

loadLocalEnv();
const port = 3000;

const routes: Record<string, (request: Request) => Promise<Response>> = {
  '/api/cron/sort-bookmarks': request => handleSortRequest(request),
  '/api/connect/authorize-x': request => handleAuthorizeXRequest(request),
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const route = routes[url.pathname];
  if (req.method !== 'GET' || !route) {
    res.writeHead(404).end(`Not found. Try GET ${Object.keys(routes).join(' or ')}\n`);
    return;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
  const response = await route(new Request(url, { headers }));
  res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
}).listen(port, '127.0.0.1', () => {
  for (const path of Object.keys(routes)) console.log(`Local route: http://127.0.0.1:${port}${path}`);
  console.log('Send Authorization: Bearer $CRON_SECRET');
});
