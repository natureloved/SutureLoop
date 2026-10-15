import { describe, it, expect } from 'vitest';
import { toSafeNavigation, isParsable, parseDiagnostics } from '../src/synthesis/patch_generator.js';

/**
 * The AST-guided transformer used to corrupt any offending line that was not a
 * single bare member chain. These are the exact shapes it broke.
 */
describe('toSafeNavigation', () => {
  it('rewrites a bare member-chain return', () => {
    expect(toSafeNavigation('  return invoice.customer.address.city;')).toBe(
      '  return (invoice?.customer?.address?.city) ?? "Unknown City";'
    );
  });

  it('parenthesises the guard so `??` cannot invert operator precedence', () => {
    // Unparenthesised, this parsed as `(invoice?.rate ?? "Unknown City") * 1.5`
    // -- a value substitution, not a null guard.
    const patched = toSafeNavigation('  return invoice.rate * 1.5;');
    expect(patched).toBe('  return (invoice?.rate) * 1.5 ?? "Unknown City";');
    // The fallback applies to the whole returned expression, not to `invoice.rate`.
    expect(patched).not.toContain('?? "Unknown City" *');
  });

  it('does not rewrite numeric literals as if they were member chains', () => {
    const patched = toSafeNavigation('  return 1.5;');
    expect(patched).not.toContain('?.');
    expect(patched).toBe('  return 1.5 ?? "Unknown City";');
  });

  it('leaves chains inside string literals alone', () => {
    expect(toSafeNavigation('  return "a.b.c";')).toBe('  return "a.b.c" ?? "Unknown City";');
  });

  it('leaves non-return statements without a coalesced fallback', () => {
    const patched = toSafeNavigation('  send(invoice.customer.email);');
    expect(patched).toBe('  send((invoice?.customer?.email));');
    expect(patched).not.toContain('??');
  });

  it('keeps statements without a trailing semicolon parseable', () => {
    expect(isParsable(`function f(i) {${toSafeNavigation('  return i.a.b')}}`)).toBe(true);
  });
});

describe('LLM patch validation', () => {
  it('accepts parsable TypeScript', () => {
    expect(isParsable('export function f(): string { return "x"; }')).toBe(true);
  });

  it('rejects prose that merely mentions the target function', () => {
    const reply = 'Sure! Here is how processInvoice should look, but this is not code.';
    expect(isParsable(reply)).toBe(false);
  });

  it('rejects an unterminated block', () => {
    expect(parseDiagnostics('function f() { return 1;').length).toBeGreaterThan(0);
  });

  it('rejects a diff, which is not a whole file', () => {
    expect(isParsable('-  return a.b;\n+  return a?.b;')).toBe(false);
  });
});