import * as fs from 'fs';
import * as path from 'path';
import { FailureSpan } from '../core/types.js';

export interface SynthesizedTest {
  /** Absolute path of the generated vitest file. */
  filePath: string;
  /** The exported symbol under test, or undefined when none could be derived. */
  functionName?: string;
  /** Repo-relative import specifier used in the generated file. */
  importSpecifier: string;
}

const DEFAULT_TEST_FILE = 'demo/tests/reproduction.test.ts';

/** Files that boot a server or otherwise have import-time side effects. */
function hasImportTimeSideEffects(source: string): boolean {
  return /\bapp\.listen\s*\(|\bcreateServer\s*\(|\bnew\s+Server\s*\(/.test(source);
}

/** A usable JS identifier for a named import. */
function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

export class TestSynthesizer {
  /**
   * Generates a vitest reproduction test for the failure described by `span`.
   *
   * The test is derived from the incident: it imports the *actual* target
   * module and calls the *actual* crashing export. It used to be a fixed
   * template that always imported `processInvoice` from
   * `demo/service/routes/billing.ts` regardless of the span, which meant a
   * regression suite for any other incident tested the wrong module -- and
   * passed or failed for reasons unrelated to the bug being remediated.
   *
   * @returns the generated file, or `null` when the span does not carry enough
   *          information to build a meaningful test (the caller then skips
   *          verification instead of verifying the wrong thing).
   */
  static generateReproductionTest(
    span: FailureSpan,
    testFilePath?: string
  ): SynthesizedTest | null {
    const targetFilePath = span.filePath;
    const functionName = span.name;

    if (!targetFilePath) {
      console.warn('[TestSynthesizer] Span carries no filePath; cannot synthesize a reproduction test.');
      return null;
    }
    if (!functionName || !isSafeIdentifier(functionName)) {
      console.warn(
        `[TestSynthesizer] Span carries no usable function name ` +
          `(got ${JSON.stringify(functionName)}); cannot synthesize a reproduction test.`
      );
      return null;
    }

    const absoluteTarget = path.resolve(targetFilePath);
    if (!fs.existsSync(absoluteTarget)) {
      console.warn(`[TestSynthesizer] Target ${targetFilePath} does not exist on disk.`);
      return null;
    }

    const source = fs.readFileSync(absoluteTarget, 'utf-8');
    if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${functionName}\\b`).test(source)) {
      console.warn(
        `[TestSynthesizer] '${functionName}' is not exported by ${targetFilePath}; ` +
          `cannot synthesize a reproduction test against it.`
      );
      return null;
    }
    if (hasImportTimeSideEffects(source)) {
      console.warn(
        `[TestSynthesizer] ${targetFilePath} has import-time side effects (server bootstrap); ` +
          `skipping test synthesis rather than booting a listener inside vitest.`
      );
      return null;
    }

    const absoluteTestFile = path.resolve(testFilePath || DEFAULT_TEST_FILE);

    // ESM specifier: extensionless source path, `.js` extension, relative to
    // the test file. Vitest resolves `.js` back to the TypeScript source.
    const withoutExtension = absoluteTarget.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
    let importSpecifier = path
      .relative(path.dirname(absoluteTestFile), withoutExtension)
      .replace(/\\/g, '/');
    if (!importSpecifier.startsWith('.')) importSpecifier = `./${importSpecifier}`;
    importSpecifier = `${importSpecifier}.js`;

    // The exact request body that crashed, when telemetry carried one.
    const crashPayload = span.rawAttributes?.payload ?? {};

    const testContent = `import { describe, it, expect } from 'vitest';
import { ${functionName} } from '${importSpecifier}';

// Synthesized from failure span ${span.traceId} at ${span.filePath}:${span.lineNumber ?? '?'}
// Error: ${String(span.errorMessage).replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').slice(0, 200)}

describe('SutureLoop auto-synthesized regression: ${functionName}', () => {
  it('does not throw on the payload that crashed it', () => {
    const crashingPayload = ${JSON.stringify(crashPayload, null, 2).split('\n').join('\n    ')};
    expect(() => ${functionName}(crashingPayload)).not.toThrow();
  });

  it('returns a defined value for an empty payload', () => {
    let result: unknown;
    expect(() => { result = ${functionName}({}); }).not.toThrow();
    expect(result).toBeDefined();
  });

  it('does not throw on null or undefined input (root-null guard)', () => {
    expect(() => ${functionName}(null as any)).not.toThrow();
    expect(() => ${functionName}(undefined as any)).not.toThrow();
  });
});
`;

    fs.mkdirSync(path.dirname(absoluteTestFile), { recursive: true });
    fs.writeFileSync(absoluteTestFile, testContent, 'utf-8');

    return { filePath: absoluteTestFile, functionName, importSpecifier };
  }
}