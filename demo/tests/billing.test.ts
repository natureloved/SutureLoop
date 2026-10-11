import { describe, it, expect } from 'vitest';
import { processInvoice } from '../service/routes/billing.js';

describe('Billing Service - Invoice Processing', () => {
  it('correctly processes a valid invoice with full address', () => {
    const validInvoice = {
      id: 'inv_101',
      amount: 450,
      customer: {
        name: 'Alice',
        address: {
          city: 'Tokyo',
          postalCode: '100-0001'
        }
      }
    };

    expect(processInvoice(validInvoice)).toBe('Tokyo');
  });

  it('fails on an unpopulated customer object in unpatched state', () => {
    const invalidInvoice = {
      id: 'inv_102',
      amount: 120,
      customer: null
    };

    // When unpatched, this will throw.
    // The test synthesizer will create a test expecting this to NOT throw.
    expect(() => processInvoice(invalidInvoice)).toThrow();
  });
});
