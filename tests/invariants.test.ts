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

  it('should strictly prohibit self-mutation of agent internal source files', () => {
    // Attempting to target orchestrator or internal engine must be blocked with InvariantViolationError
    expect(() => assertValidTargetFile('src/core/orchestrator.ts')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('src/state/checkpoint_manager.ts')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('bin/sutureloop.ts')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('.github/workflows/ci.yml')).toThrow(InvariantViolationError);
  });

  it('should strictly prohibit targeting root configuration files', () => {
    expect(() => assertValidTargetFile('package.json')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('tsconfig.json')).toThrow(InvariantViolationError);
  });

  it('should reject directory traversal and null byte sequences', () => {
    expect(() => assertValidTargetFile('../outside.ts')).toThrow(InvariantViolationError);
    expect(() => assertValidTargetFile('demo/service/\0routes/billing.ts')).toThrow(InvariantViolationError);
  });

  it('should validate measured metrics', () => {
    expect(() => assertMeasuredMetric('durationMs', 225)).not.toThrow();
    expect(() => assertMeasuredMetric('durationMs', -1)).toThrow(InvariantViolationError);
    expect(() => assertMeasuredMetric('durationMs', NaN)).toThrow(InvariantViolationError);
  });
});
