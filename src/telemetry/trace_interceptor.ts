import { FailureSpan } from '../core/types.js';

export interface ParsedStackTrace {
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  functionName?: string;
}

export class TraceInterceptor {
  /**
   * Parse an error or stack trace string to identify the origin file, line, and function.
   */
  static parseStackTrace(stack: string): ParsedStackTrace | null {
    if (!stack) return null;

    const lines = stack.split('\n');
    for (const line of lines) {
      // Common V8 stack trace format: "    at functionName (filepath:line:col)" or "    at filepath:line:col"
      const matchWithFunc = line.match(/^\s*at\s+([a-zA-Z0-9_$.<>]+)\s+\((.*?):(\d+):(\d+)\)/);
      if (matchWithFunc) {
        const filePath = matchWithFunc[2].replace(/\\/g, '/');
        // Ignore internal node modules or node_modules
        if (!filePath.includes('node_modules') && !filePath.startsWith('node:')) {
          return {
            functionName: matchWithFunc[1],
            filePath,
            lineNumber: parseInt(matchWithFunc[3], 10),
            columnNumber: parseInt(matchWithFunc[4], 10),
          };
        }
      }

      const matchWithoutFunc = line.match(/^\s*at\s+(.*?):(\d+):(\d+)/);
      if (matchWithoutFunc) {
        const filePath = matchWithoutFunc[1].replace(/\\/g, '/');
        if (!filePath.includes('node_modules') && !filePath.startsWith('node:')) {
          return {
            filePath,
            lineNumber: parseInt(matchWithoutFunc[2], 10),
            columnNumber: parseInt(matchWithoutFunc[3], 10),
          };
        }
      }
    }

    return null;
  }

  /**
   * Enrich raw span data with parsed stack trace details.
   */
  static extractFailureContext(span: FailureSpan): FailureSpan {
    if (!span.errorStack) {
      return span;
    }

    const parsed = this.parseStackTrace(span.errorStack);
    if (parsed) {
      return {
        ...span,
        name: parsed.functionName || span.name,
        filePath: parsed.filePath,
        lineNumber: parsed.lineNumber,
      };
    }

    return span;
  }
}
