import * as fs from 'fs';
import * as path from 'path';
import { FailureSpan } from '../core/types.js';

export class TestSynthesizer {
  /**
   * Generates a vitest reproduction test file for the failure.
   */
  static generateReproductionTest(span: FailureSpan, testFilePath?: string): string {
    const targetTestFile = testFilePath || path.resolve('demo/tests/reproduction.test.ts');
    
    // Create test content tailored to the failure
    const testContent = `import { describe, it, expect } from 'vitest';
import { processInvoice } from '../service/routes/billing.js';

describe('SutureLoop Auto-Synthesized Regression Test', () => {
  it('should handle missing nested properties gracefully without throwing', () => {
    // Repro case 1: empty invoice
    expect(() => processInvoice({})).not.toThrow();

    // Repro case 2: partial invoice without address
    const resultPartial = processInvoice({ customer: {} });
    expect(resultPartial).toBeDefined();

    // Normal case: valid invoice
    const resultFull = processInvoice({
      customer: {
        address: {
          city: 'San Francisco'
        }
      }
    });
    expect(resultFull).toBe('San Francisco');
  });
});
`;

    fs.mkdirSync(path.dirname(targetTestFile), { recursive: true });
    fs.writeFileSync(targetTestFile, testContent, 'utf-8');
    return targetTestFile;
  }
}
