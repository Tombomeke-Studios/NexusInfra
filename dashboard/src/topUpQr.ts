// The EPC QR a hosted top-up shows (#436). Pure; rendered by the Billing page,
// which a community build replaces with a stub, so none of this ships there.
//
// EPC069-12 (the SEPA Credit Transfer QR): the payee's name and IBAN, the amount,
// and the top-up's RF creditor reference in the structured-reference field.
// Scanning it in the FinVault app pays that top-up's payment request — whoever
// scans it, so a customer whose FinVault address differs from their NexusInfra
// one can still pay. The layout must match FinVault's parseEpcQr (its
// apps/mobile/src/lib/epc.ts); the tests pin it.

export interface Payee {
  name: string;
  iban: string;
}

/** True for an ISO 11649 RF creditor reference — the only kind FinVault pays by. */
export function isRfReference(reference: string): boolean {
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(reference)) return false;
  const rotated = reference.slice(4) + reference.slice(0, 4);
  let digits = '';
  for (const ch of rotated) digits += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  let rest = 0;
  for (let i = 0; i < digits.length; i += 7) rest = Number(String(rest) + digits.slice(i, i + 7)) % 97;
  return rest === 1;
}

/**
 * The QR payload for one top-up, or null when it cannot be paid by scanning: no
 * payee configured, or a reference from before RF references (#436) — FinVault
 * would not find a request by it.
 */
export function topUpEpcPayload(payee: Payee | null, amount: number, reference: string): string | null {
  if (!payee || !isRfReference(reference) || !(amount > 0)) return null;
  return [
    'BCD', '002', '1', 'SCT',
    '', // BIC: optional in version 002
    payee.name.trim().slice(0, 70),
    payee.iban.replace(/\s+/g, '').toUpperCase(),
    `EUR${amount.toFixed(2)}`,
    '', // purpose
    reference, // structured reference
    '', // remittance text: EPC allows it or a structured reference, not both
  ].join('\n');
}
