/**
 * One-time password generation and verification.
 * Per Instruction Pack §6.5: 6-digit numeric, crypto.randomInt; bcrypt-hashed
 * (cost factor 10 default); 5 min step-up TTL, 10 min login/account-verify TTL;
 * max 3 attempts then invalidate.
 */

import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

export const OTP_DIGIT_LEN = 6;
export const MAX_OTP_ATTEMPTS = 3;
export const LOGIN_OTP_TTL_SECONDS = 600;
export const STEPUP_OTP_TTL_SECONDS = 300;

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(OTP_DIGIT_LEN, '0');
}

export async function hashOtp(otp: string, rounds: number): Promise<string> {
  return bcrypt.hash(otp, rounds);
}

export async function verifyOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}
