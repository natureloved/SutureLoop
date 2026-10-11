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
});
