/**
 * Account UUID — Identiti's universal foreign key.
 * Format: `acc_<uuid v4>` per Rail Contract Schema Appendix §1.1.
 *
 * NOTE: Reboot Pack §9.1 says ULID for platform identifiers; the Rail Contract
 * locks UUID v4 for the app-facing Account UUID. Rail Contract wins app-facing.
 * See memory: identiti_phase1_decisions.md.
 */

import { randomUUID } from 'node:crypto';

export type AccountUuid = string & { readonly __brand: 'AccountUuid' };

const ACCOUNT_UUID_RE = /^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function generateAccountUuid(): AccountUuid {
  return `acc_${randomUUID()}` as AccountUuid;
}

export function isAccountUuid(value: string): value is AccountUuid {
  return ACCOUNT_UUID_RE.test(value);
}

export function assertAccountUuid(value: string): AccountUuid {
  if (!isAccountUuid(value)) {
    throw new Error(`Invalid Account UUID format: ${value}`);
  }
  return value as AccountUuid;
}
