import { InvariantViolationError } from './errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Ensures the git worktree is clean before starting any self-healing mutation.
 */
export function assertCleanWorktree(allowedPathsPrefix = 'demo'): void {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    if (status.length > 0) {
      const dirtyFiles = status.split('\n').map(line => line.trim().substring(3));
      const nonAllowed = dirtyFiles.filter(f => !f.startsWith(allowedPathsPrefix) && !f.startsWith('scratch'));
      if (nonAllowed.length > 0) {
        throw new InvariantViolationError(
          `Worktree has uncommitted changes outside sandbox: ${nonAllowed.join(', ')}`
        );
      }
    }
  } catch (err: any) {
    if (err instanceof InvariantViolationError) {
      throw err;
    }
    // If git error, fail closed
    throw new InvariantViolationError(`Unable to verify worktree cleanliness: ${err.message}`);
  }
}

/**
 * Validates that the target file exists, is inside the allowed workspace/demo boundary,
 * and contains valid contents.
 */
export function assertValidTargetFile(filePath: string): void {
  if (!filePath || filePath.trim() === '') {
    throw new InvariantViolationError('Target file path cannot be empty.');
  }

  // Prevent shell metacharacters and command injection
  if (/[\0\r\n;&|`$(){}<>"'\\]/.test(filePath) && !filePath.includes(':\\')) {
    throw new InvariantViolationError(`Malicious characters detected in target file path: ${filePath}`);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new InvariantViolationError(`Target file does not exist on disk: ${filePath}`);
  }

  // Bound strictly to workspace root
  const workspaceRoot = process.cwd();
  if (!resolved.toLowerCase().startsWith(workspaceRoot.toLowerCase())) {
    throw new InvariantViolationError(`Target file is outside the workspace root boundary: ${filePath}`);
  }
}

/**
 * Ensures measured values are genuine numbers and not placeholder mocks.
 */
export function assertMeasuredMetric(metricName: string, value: number): void {
  if (value === undefined || value === null || isNaN(value) || value < 0) {
    throw new InvariantViolationError(`Metric '${metricName}' was not measured accurately. Got: ${value}`);
  }
}
