import { handleSortRequest } from '../../src/handler.js';

export function GET(request: Request): Promise<Response> {
  return handleSortRequest(request);
}
