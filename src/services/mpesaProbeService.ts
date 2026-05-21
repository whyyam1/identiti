/**
 * M-Pesa ownership probe — Itafika §15.1.3.
 *
 * Production: KES 10 test send via Kipkiren Pay (KP-17, not yet started).
 * Sandbox stub: accepts any E.164-format MSISDN and returns `verified: true`
 * deterministically. The KP call is layered in once KP-17 ships.
 */

const E164_RE = /^\+[1-9][0-9]{6,14}$/;

export type MpesaProbeVerdict =
  | { ok: true; vendorRef: string | null }
  | { ok: false; reason: string };

export interface MpesaProbeService {
  probe(msisdn: string): Promise<MpesaProbeVerdict>;
}

export function createStubMpesaProbeService(): MpesaProbeService {
  return {
    async probe(msisdn) {
      const trimmed = msisdn.trim();
      if (!E164_RE.test(trimmed)) {
        return { ok: false, reason: 'mpesa_msisdn_format' };
      }
      // TODO Sprint 2+: call KP-17 `POST /v1/payouts/initiate` with
      // `verification_test=true` and await the rider's code confirmation.
      // Stub mode here just accepts the format.
      return { ok: true, vendorRef: null };
    },
  };
}
