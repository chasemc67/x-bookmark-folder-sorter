import { handleAuthorizeXRequest } from '../../src/connectAuthorize.js';

export function GET(request: Request): Promise<Response> {
  return handleAuthorizeXRequest(request);
}
