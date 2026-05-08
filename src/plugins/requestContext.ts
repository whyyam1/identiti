/**
 * Per-request context: assigns request_id (echoes incoming X-Request-Id, or
 * generates a ULID), and propagates W3C Traceparent (parses incoming if valid,
 * otherwise generates fresh). Both are written back as response headers and
 * become available on `request.requestId` / `request.traceparent`.
 *
 * Per Identiti Rail Contract §1 standard headers.
 */

import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { generateUlid } from '@kmv/platform-shared';
import { generateTraceparent, parseTraceparent } from '@kmv/platform-shared/trace';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    traceparent: string;
  }
}

const impl: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const incomingRid = request.headers['x-request-id'];
    const requestId =
      typeof incomingRid === 'string' && incomingRid.length > 0
        ? incomingRid
        : generateUlid();
    request.requestId = requestId;
    reply.header('x-request-id', requestId);

    const incomingTp = request.headers['traceparent'];
    const tp =
      typeof incomingTp === 'string' && parseTraceparent(incomingTp)
        ? incomingTp
        : generateTraceparent();
    request.traceparent = tp;
    reply.header('traceparent', tp);
  });
};

export const requestContextPlugin = fp(impl, {
  name: 'identiti/request-context',
  fastify: '4.x',
});
