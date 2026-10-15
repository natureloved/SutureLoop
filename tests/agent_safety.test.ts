import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Mutex } from '../src/core/mutex.js';
import { TestSynthesizer } from '../src/synthesis/test_synthesizer.js';
import { recordAppliedPatch, clearAppliedPatch, isAgentAuthored } from '../src/state/applied_patches.js';
import { assertCleanWorktree } from '../src/core/invariants.js';
import { InvariantViolationError } from '../src/core/errors.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

describe('Mutex', () => {
  it('serialises overlapping sections', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const task = (label: string, delay: number) =>
      mutex.runExclusive(async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${label}:end`);
      });

    await Promise.all([task('a', 20), task('b', 1), task('c', 1)]);

    expect(order).toEqual([
      'a:start', 'a:end',
      'b:start', 'b:end',
      'c:start', 'c:end'
    ]);
  });

  it('keeps running queued sections after one rejects', async () => {
    const mutex = new Mutex();
    const results: string[] = [];

    await Promise.allSettled([
      mutex.runExclusive(() => { throw new Error('boom'); }),
      mutex.runExclusive(() => { results.push('second'); })
    ]);

    expect(results).toEqual(['second']);
  });
});

describe('applied-patch tracking', () => {
  const probe = 'demo/service/routes/billing.ts';
  let original: string;

  beforeEach(() => { original = fs.readFileSync(probe, 'utf-8'); });
  afterEach(() => {
    fs.writeFileSync(probe, original, 'utf-8');
    clearAppliedPatch(probe);
  });

  it('recognises a file the agent itself patched, so watch mode can re-run', () => {
    fs.writeFileSync(probe, `${original}\n// agent-authored\n`, 'utf-8');
    // Without the record the gate refuses, because the healed file is dirty.
    expect(() => assertCleanWorktree(probe)).toThrow(InvariantViolationError);

    recordAppliedPatch(probe, `${original}\n// agent-authored\n`, 'suture_test');
    expect(isAgentAuthored(probe)).toBe(true);
    expect(() => assertCleanWorktree(probe)).not.toThrow();
  });

  it('re-arms the safety gate as soon as a developer edits on top', () => {
    const patched = `${original}\n// agent-authored\n`;
    fs.writeFileSync(probe, patched, 'utf-8');
    recordAppliedPatch(probe, patched, 'suture_test');

    fs.writeFileSync(probe, `${patched}\n// developer work in progress\n`, 'utf-8');
    expect(isAgentAuthored(probe)).toBe(false);
    expect(() => assertCleanWorktree(probe)).toThrow(InvariantViolationError);
  });

  it('stores its record under .git so it never shows up as project state', () => {
    recordAppliedPatch(probe, original, 'suture_test');
    const stateFile = path.resolve('.git/sutureloop/applied-patches.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const stdout = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
    // The repo is itself named SutureLoop, so assert on the record's own path.
    expect(stdout).not.toContain('.git/sutureloop');
    expect(stdout).not.toContain('applied-patches');
  });
});

describe('TestSynthesizer', () => {
  let scratch: string;

  beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sutureloop-synth-')); });
  afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

  it('derives the test from the incident, not from a hardcoded demo file', () => {
    const modPath = path.join(scratch, 'cart.ts');
    fs.writeFileSync(modPath, 'export function totalPrice(c: any): number {\n  return c.items.length;\n}\n');

    const result = TestSynthesizer.generateReproductionTest(
      { traceId: 't1', name: 'totalPrice', filePath: modPath, errorMessage: 'TypeError' },
      path.join(scratch, 'repro.test.ts')
    );

    expect(result?.functionName).toBe('totalPrice');
    const generated = fs.readFileSync(result!.filePath, 'utf-8');
    expect(generated).toContain('totalPrice');
    expect(generated).toContain('./cart.js');
    expect(generated).not.toContain('processInvoice');
  });

  it('carries the crashing payload into the reproduction', () => {
    const modPath = path.join(scratch, 'cart.ts');
    fs.writeFileSync(modPath, 'export function totalPrice(c: any): number { return c.items.length; }\n');

    TestSynthesizer.generateReproductionTest(
      {
        traceId: 't2',
        name: 'totalPrice',
        filePath: modPath,
        errorMessage: 'TypeError',
        rawAttributes: { payload: { items: null } }
      },
      path.join(scratch, 'repro2.test.ts')
    );

    expect(fs.readFileSync(path.join(scratch, 'repro2.test.ts'), 'utf-8')).toContain('"items": null');
  });

  it('refuses to synthesize against a symbol the target does not export', () => {
    const modPath = path.join(scratch, 'cart.ts');
    fs.writeFileSync(modPath, 'export function totalPrice(c: any): number { return 0; }\n');

    const result = TestSynthesizer.generateReproductionTest(
      { traceId: 't3', name: 'notExported', filePath: modPath, errorMessage: 'TypeError' },
      path.join(scratch, 'repro3.test.ts')
    );

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(scratch, 'repro3.test.ts'))).toBe(false);
  });

  it('refuses to synthesize against a module with import-time side effects', () => {
    const modPath = path.join(scratch, 'serverish.ts');
    fs.writeFileSync(modPath, 'export function boot(): void {}\napp.listen(3000);\n');

    const result = TestSynthesizer.generateReproductionTest(
      { traceId: 't4', name: 'boot', filePath: modPath, errorMessage: 'TypeError' },
      path.join(scratch, 'repro4.test.ts')
    );

    expect(result).toBeNull();
  });

  it('refuses to synthesize when the span carries no target', () => {
    expect(TestSynthesizer.generateReproductionTest({ traceId: 't5', errorMessage: 'x' })).toBeNull();
  });
});
describe('GitHub PR boundary fence', () => {
  it('refuses to push a target outside the remediation boundary', async () => {
    const { GitHubPRClient } = await import('../src/github/pr_client.js');
    const originalToken = process.env.GITHUB_TOKEN;
    const originalEnable = process.env.ENABLE_REMOTE_PR;
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.ENABLE_REMOTE_PR = 'true';

    try {
      const result = await new GitHubPRClient().createRemediationPullRequest({
        sessionId: 'suture_test',
        incidentTraceId: 'trace_test',
        // The agent's own source: fenced at the entry, and fenced again here.
        targetFile: 'src/core/orchestrator.ts',
        targetFunction: 'runSession',
        economicMetrics: {
          measuredTokenCostUSD: 0.0001,
          mttrHoursSaved: 0.75,
          grossSavingsUSD: 93.75,
          grossMarginPercent: 100
        }
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('TARGET_OUTSIDE_REMEDIATION_BOUNDARY');
    } finally {
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalEnable === undefined) delete process.env.ENABLE_REMOTE_PR;
      else process.env.ENABLE_REMOTE_PR = originalEnable;
    }
  });
});
