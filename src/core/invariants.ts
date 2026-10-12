import { InvariantViolationError } from './errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Ensures the file the agent is about to mutate carries no uncommitted work.
 *
 * Design note (this is deliberately NOT a whole-repo cleanliness check):
 * the safety property that actually matters is that an atomic rollback cannot
 * destroy work the developer has not committed. The agent can only ever write
 * inside the application sandbox (see `assertValidTargetFile`), so the only
 * file at risk is the remediation target itself. Gating the entire worktree
 * instead means any unrelated edit -- or simply `npm install` rewriting
 * package-lock.json, or `cp .env.example .env` creating the env file -- aborts
 * remediation, which breaks the documented quickstart on every normal working
 * copy. Self-mutation of the agent's own source is already blocked by
 * `assertValidTargetFile`.
 *
 * @param targetFile - the file that will be mutated and rolled back
 */
export function assertCleanWorktree(targetFile?: string): void {
  if (!targetFile) {
    return;
  }

  let stdout: string;
  try {
    const normalized = targetFile.replace(/\\/g, '/');
    stdout = execFileSync('git', ['status', '--porcelain', '--', normalized], {
      encoding: 'utf-8'
    });
  } catch (err: any) {
    // If git is unavailable or the path is untracked, fail closed.
    throw new InvariantViolationError(`Unable to verify worktree cleanliness: ${err.message}`);
  }

  if (stdout.trim().length > 0) {
    const normalized = targetFile.replace(/\\/g, '/');
    throw new InvariantViolationError(
      `Refusing to remediate '${normalized}': it has uncommitted changes that an ` +
        `atomic rollback would destroy. Commit or stash them first.`
    );
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
