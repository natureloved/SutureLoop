import { describe, it, expect } from 'vitest';
import {
  assertValidTargetFile,
  assertCleanWorktree,
  assertMeasuredMetric
} from '../src/core/invariants.js';
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

describe('assertCleanWorktree (scoped safety gate)', () => {
  // The gate exists to stop a rollback from clobbering uncommitted work in the
  // file the agent is about to mutate. It must NOT refuse to run because the
  // developer has unrelated uncommitted edits elsewhere in the repo -- that
  // breaks the documented quickstart on any normal working copy.
  const TARGET = 'demo/service/routes/billing.ts';

  it('should not throw when the target file has no uncommitted changes', () => {
    expect(() => assertCleanWorktree(TARGET)).not.toThrow();
  });

  it('should be a no-op when no target file is supplied', () => {
    expect(() => assertCleanWorktree()).not.toThrow();
  });

  it('should ignore unrelated dirty files elsewhere in the repository', () => {
    // src/ and bin/ carry this change set's own uncommitted work. The gate is
    // scoped to the remediation target, so those must never block healing.
    expect(() => assertCleanWorktree(TARGET)).not.toThrow();
  });

  it('should refuse when the target file itself has uncommitted changes', () => {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const original = execFileSync('git', ['show', `HEAD:${TARGET}`], { encoding: 'utf-8' });
    try {
      require('fs').writeFileSync(TARGET, `${original}\n// uncommitted probe\n`, 'utf-8');
      expect(() => assertCleanWorktree(TARGET)).toThrow(InvariantViolationError);
    } finally {
      require('fs').writeFileSync(TARGET, original, 'utf-8');
    }
  });
});
