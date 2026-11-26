import { describe, it, expect } from 'vitest';
import { isRfReference, topUpEpcPayload } from './topUpQr';

const payee = { name: 'NexusInfra', iban: 'BE89 3770 0771 9941' };

describe('topUpEpcPayload (#436)', () => {
  it('lays a top-up out the way FinVault reads an EPC QR', () => {
    // Line by line: BCD, version, charset, SCT, BIC, name, IBAN, amount,
    // purpose, structured reference, remittance.
    expect(topUpEpcPayload(payee, 10, 'RF18539007547034')).toBe(
      ['BCD', '002', '1', 'SCT', '', 'NexusInfra', 'BE89377007719941', 'EUR10.00', '', 'RF18539007547034', ''].join('\n'),
    );
  });

  it('writes the amount with exactly two decimals', () => {
    expect(topUpEpcPayload(payee, 12.5, 'RF18539007547034')?.split('\n')[7]).toBe('EUR12.50');
  });

  it('offers no QR it cannot be paid by', () => {
    expect(topUpEpcPayload(null, 10, 'RF18539007547034')).toBeNull();
    // A top-up from before RF references: FinVault would find no request by it.
    expect(topUpEpcPayload(payee, 10, 'topup-u1-5c1f2a')).toBeNull();
    expect(topUpEpcPayload(payee, 10, 'RF19539007547034')).toBeNull();
    expect(topUpEpcPayload(payee, 0, 'RF18539007547034')).toBeNull();
  });
});

describe('isRfReference', () => {
  it('checks the ISO 11649 check digits', () => {
    expect(isRfReference('RF18539007547034')).toBe(true);
    expect(isRfReference('RF19539007547034')).toBe(false);
    expect(isRfReference('rf18539007547034')).toBe(false);
  });
});
