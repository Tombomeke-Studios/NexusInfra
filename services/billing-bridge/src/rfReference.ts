import { randomInt } from 'crypto';

// Top-up references as ISO 11649 RF creditor references (#436).
//
// A top-up's reference used to be `topup-<userId>-<uuid>`. It is now also the
// structured reference in the EPC QR the Billing page shows, and FinVault pays
// the request a scanned reference names. An EPC structured reference must be an
// RF creditor reference: `RF`, two check digits, then 1–21 letters or digits.
// FinVault validates the check digits (its epc.ts), so a reference we invent has
// to be a real one.
//
// The 21 characters are random, not derived from the user id: a reference is
// printed in a QR anyone near the screen can read, and paying it is the only
// thing it allows, so it must not be guessable from anything else.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Letters to their ISO 7064 values (A=10 … Z=35), digits as they are. */
function toDigits(input: string): string {
  let out = '';
  for (const ch of input) out += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  return out;
}

/** A long digit string modulo 97, chunked so it never leaves a safe integer. */
function mod97(digits: string): number {
  let rest = 0;
  for (let i = 0; i < digits.length; i += 7) rest = Number(String(rest) + digits.slice(i, i + 7)) % 97;
  return rest;
}

/** The RF creditor reference for `body` (1–21 letters or digits, case-insensitive). */
export function rfReference(body: string): string {
  const clean = body.toUpperCase();
  if (!/^[A-Z0-9]{1,21}$/.test(clean)) throw new Error('an RF reference body is 1–21 letters or digits');
  const check = 98 - mod97(toDigits(`${clean}RF00`));
  return `RF${String(check).padStart(2, '0')}${clean}`;
}

/** True for a well-formed RF creditor reference with correct check digits. */
export function isRfReference(reference: string): boolean {
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(reference)) return false;
  return mod97(toDigits(reference.slice(4) + reference.slice(0, 4))) === 1;
}

/** A new, unguessable top-up reference: an RF reference over 21 random characters (~108 bits). */
export function newTopUpReference(pick: (max: number) => number = randomInt): string {
  let body = '';
  for (let i = 0; i < 21; i++) body += ALPHABET[pick(ALPHABET.length)];
  return rfReference(body);
}
