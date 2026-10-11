export interface InvoiceRequest {
  id?: string;
  amount?: number;
  customer?: {
    name?: string;
    address?: {
      city?: string;
      postalCode?: string;
    };
  };
}

/**
 * Seeded crash function:
 * Directly accesses deeply nested properties without optional chaining or null checking.
 * When payload is missing 'customer' or 'address', it throws TypeError: Cannot read properties of undefined (reading 'address')
 */
export function processInvoice(invoice: any): string {
  // CRASH LINE:
  // SutureLoop Verified Patch: Safe navigation with fallback
  return invoice?.customer?.address?.city ?? "Unknown City";
}

export function handleInvoiceBilling(req: any, res: any): void {
  try {
    const city = processInvoice(req.body);
    res.json({ success: true, city });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
}
