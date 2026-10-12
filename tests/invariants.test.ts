import { describe, it, expect } from 'vitest';
import { assertValidTargetFile, assertMeasuredMetric } from '../src/core/invariants.js';
import { InvariantViolationError } from '../src/core/errors.js';
import * as path from 'path';

describe('Invariants & Security Guards', () => {
  it('should pass for legitimate workspace files', () => {
    expect(() => assertValidTargetFile('demo/service/routes/billing.ts')).not.toThrow();
  });

  it('should reject non-existent files', () => {
    expect(() => assertValidTargetFile('demo/non_existent.ts')).toThrow(InvariantViolationError);
  });

  it('should reject command injection sequences in file paths', () => {
    expect(() => assertValidTargetFile('billing.ts; touch /tmp/PWNED')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('billing.ts && rm -rf /')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('billing.ts | cat /etc/passwd')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('billing.ts`id`')).toThrow(InvariantViolationError);
  });

  it('should validate measured metrics', () => {
    expect(() => assertMeasuredMetric('durationMs', 225)).not.toThrow();
    expect(() => assertMeasuredMetric('durationMs', -1)).toThrow(InvariantViolationError);
    expect(() => assertMeasuredMetric('durationMs', NaN)).toThrow(InvariantViolationError);
  });
});
