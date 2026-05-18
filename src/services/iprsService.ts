/**
 * IPRS verification service.
 *
 * Production: hits the real IPRS API. Track A (government-mediated access);
 * not provisioned at v1.0 build time.
 * Stub: deterministic responses based on a fixture map; fixtures default to
 * `full_match` for any unknown national_id so happy-path tests don't need to
 * pre-register every test customer. Specific national_ids can be registered
 * to return mismatches, no-match, or upstream errors.
 *
 * Per Reboot Pack §7 ID-D-06 (IPRS Track A) + Instruction Pack §6.3 Phase 4.
 *
 * The raw IPRS response is never returned to the caller — only the §1.9
 * IprsResponseSummary projection.
 */

import type { IprsConfidenceBand, IprsMatch } from '../repositories/types.js';

export interface IprsLookupRequest {
  nationalId: string;
  nameFirst: string;
  nameLast: string;
  /** ISO 8601 date (yyyy-mm-dd). */
  dateOfBirth: string;
}

export interface IprsLookupSuccess {
  kind: 'verified' | 'failed';
  match: IprsMatch;
  confidenceBand: IprsConfidenceBand;
  iprsRef: string;
  /** Set when kind='failed'. */
  failureReason?: string;
}

export interface IprsLookupUnavailable {
  kind: 'upstream_unavailable';
  retryAfterSeconds?: number;
}

export type IprsLookupResult = IprsLookupSuccess | IprsLookupUnavailable;

export interface IprsService {
  lookup(req: IprsLookupRequest): Promise<IprsLookupResult>;
}

// ─── Stub ─────────────────────────────────────────────────────────────────

export interface StubFixture {
  match: IprsMatch;
  confidenceBand: IprsConfidenceBand;
  /** When set, lookup() returns failed kind with this reason. */
  failureReason?: string;
}

export interface StubIprsServiceOptions {
  /** Map of national_id → outcome. Unknown ids default to a full_match. */
  fixtures?: Record<string, StubFixture>;
  /**
   * national_ids in this set will return upstream_unavailable. Useful for
   * exercising retry / 502 paths.
   */
  unavailableIds?: string[];
}

export function createStubIprsService(opts: StubIprsServiceOptions = {}): IprsService & {
  register(id: string, fixture: StubFixture): void;
  setUnavailable(id: string): void;
} {
  const fixtures = new Map<string, StubFixture>(Object.entries(opts.fixtures ?? {}));
  const unavailable = new Set<string>(opts.unavailableIds ?? []);

  let counter = 0;

  return {
    async lookup({ nationalId, nameFirst, nameLast, dateOfBirth }) {
      // Sanity: keep the stub aware that it received name + DOB so it can
      // simulate document_mismatch when fixtures specify partial_match.
      void nameFirst;
      void nameLast;
      void dateOfBirth;

      if (unavailable.has(nationalId)) {
        return { kind: 'upstream_unavailable', retryAfterSeconds: 30 };
      }
      counter += 1;
      const ref = `iprs_stub_${Date.now()}_${counter}`;
      const fixture = fixtures.get(nationalId) ?? {
        match: 'full_match' as const,
        confidenceBand: 'high' as const,
      };
      if (fixture.match === 'no_match') {
        return {
          kind: 'failed',
          match: 'no_match',
          confidenceBand: fixture.confidenceBand,
          iprsRef: ref,
          failureReason: fixture.failureReason ?? 'kyc_iprs_no_match',
        };
      }
      if (fixture.match === 'partial_match') {
        return {
          kind: 'failed',
          match: 'partial_match',
          confidenceBand: fixture.confidenceBand,
          iprsRef: ref,
          failureReason: fixture.failureReason ?? 'kyc_iprs_document_mismatch',
        };
      }
      return {
        kind: 'verified',
        match: 'full_match',
        confidenceBand: fixture.confidenceBand,
        iprsRef: ref,
      };
    },
    register(id, fixture) {
      fixtures.set(id, fixture);
    },
    setUnavailable(id) {
      unavailable.add(id);
    },
  };
}
