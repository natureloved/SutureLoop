import { describe, it, expect } from 'vitest';
import { TraceInterceptor } from '../src/telemetry/trace_interceptor.js';

describe('Neatlogs Trace Interceptor', () => {
  it('should accurately extract target file and line number from stack trace', () => {
    const rawSpan = {
      traceId: 'trace_test_123',
      spanId: 'span_test_456',
      name: 'processInvoice',
      service: 'billing-service',
      timestamp: Date.now(),
      errorMessage: "TypeError: Cannot read properties of undefined (reading 'address')",
      errorStack: "TypeError: Cannot read properties of undefined (reading 'address')\n    at processInvoice (demo/service/routes/billing.ts:20:27)\n    at handleInvoiceBilling (demo/service/routes/billing.ts:25:18)"
    };

    const extracted = TraceInterceptor.extractFailureContext(rawSpan);
    expect(extracted.traceId).toBe('trace_test_123');
    expect(extracted.filePath).toContain('demo/service/routes/billing.ts');
    expect(extracted.lineNumber).toBe(20);
    expect(extracted.name).toBe('processInvoice');
  });

  it('should ignore non-error spans', () => {
    const rawSpan = {
      traceId: 'trace_success_789',
      spanId: 'span_success_789',
      name: 'processInvoice',
      service: 'billing-service',
      timestamp: Date.now(),
      errorMessage: ''
    };

    const extracted = TraceInterceptor.extractFailureContext(rawSpan);
    expect(extracted.traceId).toBe('trace_success_789');
    expect(extracted.errorMessage).toBe('');
  });
});
