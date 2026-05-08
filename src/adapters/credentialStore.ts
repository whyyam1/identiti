/**
 * Drizzle-backed implementation of the AppCredentialStore interface from
 * @kmv/platform-shared. Looks up app_credentials by app_id.
 */

import { eq } from 'drizzle-orm';
import type { AppCredentialStore } from '@kmv/platform-shared/fastify-auth';
import type { Db } from '../db/client.js';
import { appCredentials } from '../db/schema.js';

export function createCredentialStore(db: Db): AppCredentialStore {
  return {
    async lookup(appId) {
      const rows = await db
        .select()
        .from(appCredentials)
        .where(eq(appCredentials.appId, appId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      const tenantClass = row.tenantClass === 'internal' ? 'internal' : 'external';
      const status = row.status === 'suspended' ? 'suspended' : 'active';

      return {
        record: {
          app_id: row.appId,
          app_name: row.appName,
          tenant_class: tenantClass,
          scopes: row.scopes,
          status,
        },
        hmacSecret: row.hmacSecret,
      };
    },
  };
}
