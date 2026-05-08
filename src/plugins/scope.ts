/**
 * Scope-check helper for route handlers.
 * Use as a Fastify preHandler factory: `preHandler: requireScope('identiti:customers:write')`.
 *
 * Returns AUTH_SCOPE_INSUFFICIENT (403) when the authenticated tenant is
 * missing the required scope. Per Rail Contract §3.5.
 */

import type { preHandlerHookHandler } from 'fastify';
import { errorResponse } from '@kmv/platform-shared';

export function requireScope(scope: string): preHandlerHookHandler {
  return async (request, reply) => {
    const scopes = request.tenantRecord?.scopes ?? [];
    if (!scopes.includes(scope)) {
      return reply
        .code(403)
        .send(
          errorResponse(
            'AUTH_SCOPE_INSUFFICIENT',
            `Missing required scope: ${scope}`,
            request.requestId
          )
        );
    }
    return;
  };
}
