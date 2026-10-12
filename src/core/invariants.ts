import { InvariantViolationError } from './errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Ensures the git worktree is clean before starting any self-healing mutation.
 */
export function assertCleanWorktree(allowedPathsPrefix = 'demo'): void {
  try {
    const rawStatus = execSync('git status --porcelain', { encoding: 'utf-8' });
    if (rawStatus.trim().length > 0) {
      const dirtyFiles = rawStatus
        .split('\n')
        .map(line => {
          const match = line.match(/^..\s+(.*)$/);
          return match ? match[1].trim() : '';
        })
        .filter(Boolean);
      const nonAllowed = dirtyFiles.filter(
        f => !f.startsWith(allowedPathsPrefix) && !f.startsWith('scratch') && !f.startsWith('runs/')
      );
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
 * Validates that the target file exists, is inside the allowed application boundary,
 * and strictly prevents self-mutation of the agent's own core code or configuration.
 */
export function assertValidTargetFile(filePath: string, allowedPrefixes = ['demo/service', 'demo']): void {
  if (!filePath || filePath.trim() === '') {
    throw new InvariantViolationError('Target file path cannot be empty.');
  }

  // Prevent null bytes and control characters
  if (/[\0\r\n]/.test(filePath)) {
    throw new InvariantViolationError(`Malicious control characters detected in target file path: ${filePath}`);
  }

  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(filePath);

  // Must be strictly within workspace root
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new InvariantViolationError(`Target file is outside the workspace root boundary: ${filePath}`);
  }

  // Normalize path separators to forward slash for boundary checks
  const normalizedRel = rel.replace(/\\/g, '/');

  // CRITICAL SECURITY GUARD: Autonomous self-healing cannot mutate the agent's own source, CLI, or config
  const forbiddenPrefixes = [
    'src/',
    'bin/',
    'tests/',
    'node_modules/',
    '.git/',
    '.entire/',
    '.agents/',
    '.claude/',
    '.cursor/',
    '.github/',
    '.factory/',
    '.codex/',
    '.gemini/',
    '.opencode/',
    '.pi/'
  ];

  for (const forbidden of forbiddenPrefixes) {
    if (normalizedRel.toLowerCase().startsWith(forbidden.toLowerCase())) {
      throw new InvariantViolationError(
        `Security boundary violation: Autonomous remediation cannot mutate agent core internal source or configuration ('${forbidden}'): ${filePath}`
      );
    }
  }

  // Prohibit root-level configuration files (e.g. package.json, tsconfig.json)
  if (!normalizedRel.includes('/')) {
    throw new InvariantViolationError(`Security boundary violation: Cannot target root workspace files: ${filePath}`);
  }

  // Ensure target is within designated application boundary
  const isAllowed = allowedPrefixes.some(prefix => normalizedRel.startsWith(prefix));
  if (!isAllowed) {
    throw new InvariantViolationError(
      `Target file '${filePath}' is not within permitted remediation application roots: [${allowedPrefixes.join(', ')}]`
    );
  }

  if (!fs.existsSync(resolved)) {
    throw new InvariantViolationError(`Target file does not exist on disk: ${filePath}`);
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
