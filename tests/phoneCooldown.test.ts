/**
 * Phone-change cooldown helpers — Reboot Pack §7 ID-D-08.
 * Unit tests; ID-7 will exercise these from the phone-change handler.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BALANCE_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MS,
  computeCooldownUntil,
  cooldownRemainingSeconds,
  isInCooldown,
} from '../src/domain/phoneCooldown.js';

const NOW = new Date('2026-05-08T12:00:00.000Z');

describe('computeCooldownUntil', () => {
  it('uses 24h when no active balance', () => {
    const until = computeCooldownUntil(NOW, { hasActiveBalance: false });
    expect(until.getTime() - NOW.getTime()).toBe(DEFAULT_COOLDOWN_MS);
    expect(DEFAULT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('uses 7d when account has an active KP balance', () => {
    const until = computeCooldownUntil(NOW, { hasActiveBalance: true });
    expect(until.getTime() - NOW.getTime()).toBe(ACTIVE_BALANCE_COOLDOWN_MS);
    expect(ACTIVE_BALANCE_COOLDOWN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('isInCooldown', () => {
  it('returns false when cooldownUntil is null/undefined', () => {
    expect(isInCooldown(null, NOW)).toBe(false);
    expect(isInCooldown(undefined, NOW)).toBe(false);
  });

  it('returns true when cooldownUntil is in the future', () => {
    const future = new Date(NOW.getTime() + 1000);
    expect(isInCooldown(future, NOW)).toBe(true);
  });

  it('returns false at or after the cooldown deadline', () => {
    expect(isInCooldown(NOW, NOW)).toBe(false);
    const past = new Date(NOW.getTime() - 1000);
    expect(isInCooldown(past, NOW)).toBe(false);
  });
});

describe('cooldownRemainingSeconds', () => {
  it('returns 0 when not in cooldown', () => {
    expect(cooldownRemainingSeconds(null, NOW)).toBe(0);
    expect(cooldownRemainingSeconds(new Date(NOW.getTime() - 1), NOW)).toBe(0);
  });

  it('rounds remaining time up to whole seconds', () => {
    const halfSecondAhead = new Date(NOW.getTime() + 500);
    expect(cooldownRemainingSeconds(halfSecondAhead, NOW)).toBe(1);

    const tenSeconds = new Date(NOW.getTime() + 10_000);
    expect(cooldownRemainingSeconds(tenSeconds, NOW)).toBe(10);
  });
});
