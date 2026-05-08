/**
 * Phone-change cooldown helpers — Reboot Pack §7 ID-D-08.
 *
 * Default 24-hour cooldown after a successful phone change. Longer for
 * accounts with active Kipkiren Pay balances (KP isn't built yet at v1.0;
 * we lift the cooldown to 7 days for any account flagged as `hasActiveBalance`
 * — caller pulls that signal from the rail-internal KP tier API once KP-2
 * lands).
 *
 * Used by ID-7 phone-change endpoints. ID-6 ships the helpers + unit tests
 * so ID-7 can wire them in directly.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_COOLDOWN_MS = DAY_MS; // 24h
export const ACTIVE_BALANCE_COOLDOWN_MS = 7 * DAY_MS; // 7 days

export function computeCooldownUntil(
  now: Date,
  opts: { hasActiveBalance: boolean }
): Date {
  const ms = opts.hasActiveBalance ? ACTIVE_BALANCE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
  return new Date(now.getTime() + ms);
}

export function isInCooldown(
  cooldownUntil: Date | null | undefined,
  now: Date
): boolean {
  if (!cooldownUntil) return false;
  return cooldownUntil.getTime() > now.getTime();
}

/**
 * Seconds until the cooldown expires. Returns 0 if not in cooldown. Used to
 * populate the `Retry-After`-equivalent field in cooldown rejection
 * responses (Schema Appendix §3.6 `phone_change_cooldown_active`).
 */
export function cooldownRemainingSeconds(
  cooldownUntil: Date | null | undefined,
  now: Date
): number {
  if (!cooldownUntil) return 0;
  const ms = cooldownUntil.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}
