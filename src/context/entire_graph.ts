import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { AstQueryFailed } from '../core/errors.js';
import { AstCaller, BlastRadiusReport } from '../core/types.js';
import { assertValidTargetFile } from '../core/invariants.js';

const execFileAsync = promisify(execFile);

let entireAvailableCache: boolean | undefined;

/**
 * True when the `entire` CLI is installed and answers.
 *
 * The README documents `entire` as a prerequisite. When it is missing the demo
 * used to print `spawn entire ENOENT` mid-run and silently degrade, which reads
 * as "the central claim does not work". This makes the state explicit up front.
 */
export async function isEntireCliAvailable(): Promise<boolean> {
  if (entireAvailableCache !== undefined) {
    return entireAvailableCache;
  }
  try {
    await execFileAsync('entire', ['--version']);
    entireAvailableCache = true;
  } catch {
    entireAvailableCache = false;
  }
  return entireAvailableCache;
}

export async function resolveAstBlastRadius(
  filePath: string,
  line: number
): Promise<BlastRadiusReport> {
  // Validate target file against injection and boundary traversal
  assertValidTargetFile(filePath);

  const entirePresent = await isEntireCliAvailable();
  if (!entirePresent) {
    console.warn(
      `[Entire] The 'entire' CLI is not on PATH. Blast radius will come from the ` +
        `text-scan fallback and its callers are UNVERIFIED. Install Entire to get a ` +
        `real AST call graph: see https://docs.entire.dev`
    );
  }

  let normPath = filePath.replace(/\\/g, '/');
  const rootPath = process.cwd().replace(/\\/g, '/');
  if (normPath.toLowerCase().startsWith(rootPath.toLowerCase())) {
    normPath = normPath.slice(rootPath.length).replace(/^\//, '');
  }
  const safeLine = Number.isInteger(line) && line > 0 ? line : 1;
  const targetSymbol = `${normPath}:${safeLine}`;

  try {
    // Run entire graph impact using direct argument array (no shell interpolation, immune to command injection)
    const { stdout } = await execFileAsync('entire', [
      'graph',
      'impact',
      '--repo',
      '.',
      '--symbol',
      targetSymbol,
      '--format',
      'json'
    ]);

    const parsed = JSON.parse(stdout);

    if (parsed.focus && parsed.focus.name) {
      const targetFunction = parsed.focus.name;
      const callers: AstCaller[] = [];

      if (parsed.callers && Array.isArray(parsed.callers.entries)) {
        for (const entry of parsed.callers.entries) {
          const endpoint = entry.endpoint;
          const callSite = entry.call_site;
          if (endpoint) {
            callers.push({
              filePath: (callSite?.file_path || endpoint.file_path || '').replace(/\\/g, '/'),
              functionName: endpoint.name || 'anonymous',
              lineNumber: callSite?.line || endpoint.start_line || 0,
              relation: entry.relation || 'CALLS'
            });
          }
        }
      }

      const callees: string[] = [];
      if (parsed.callees && Array.isArray(parsed.callees.entries)) {
        for (const entry of parsed.callees.entries) {
          if (entry.endpoint?.name) {
            callees.push(entry.endpoint.name);
          }
        }
      }

      console.log(
        `[Entire] Resolved symbol '${targetFunction}' with ${callers.length} callers via entire-graph`
      );

      return {
        targetFunction,
        filePath: normPath,
        lineNumber: line,
        callers,
        callees,
        resolvedVia: 'entire-graph'
      };
    }

    throw new Error('No focus symbol found in entire graph output');
  } catch (err: any) {
    const reason = entirePresent ? err?.message : 'the entire CLI is not installed';
    console.warn(
      `[Entire] 'entire graph impact' unavailable (${reason}). ` +
        `Activating the text-scan fallback -- its callers are UNVERIFIED...`
    );
    return regexAstFallback(normPath, line);
  }
}

/**
 * Text-scan fallback used when the `entire` CLI is not available.
 *
 * IMPORTANT: this is a lexical scanner, NOT an AST parser. It finds the
 * enclosing function by scanning upward for a declaration keyword and then
 * greps other files for the identifier. Consequences:
 *
 *  - It cannot distinguish a real call site from a string literal, an import,
 *    a comment, or the synthesizer's own generated test.
 *  - It cannot see callers in files it does not scan.
 *
 * It is therefore labelled `resolvedVia: 'text-scan-fallback'` and callers are
 * reported as UNVERIFIED so the demo never presents a grep as a call graph.
 * Callers that are merely the identifier inside a string, a comment or an
 * import are dropped, which removes the most misleading false positives.
 */
export function regexAstFallback(
  filePath: string,
  line: number
): BlastRadiusReport {
  try {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new AstQueryFailed(`Target file ${filePath} does not exist`);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Scan upward from crash line to find enclosing function / handler
    let targetFunction = 'unknownFunction';
    const scanStart = Math.min(line - 1, lines.length - 1);
    for (let i = scanStart; i >= 0; i--) {
      const l = lines[i];
      const match =
        l.match(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/) ||
        l.match(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(/) ||
        l.match(/([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{/);
      if (match) {
        targetFunction = match[1] || match[2] || match[3] || targetFunction;
        break;
      }
    }

    const callers: AstCaller[] = [];
    const searchDirs = [path.resolve('demo/service'), path.resolve('src')];

    /** True when the identifier appears as a real call, not as prose. */
    const isCallSite = (text: string): boolean => {
      const t = text.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      if (/^(import|export)\s/.test(t) && !/\{\s*$/.test(t)) return false;
      // A bare identifier inside a string literal is prose, not a call.
      if (/['"`][^'"`]*\b/.test(t) && !/\w\s*\(/.test(t)) return false;
      // Require an actual invocation: identifier followed by an open paren.
      return new RegExp(`\\b${targetFunction}\\s*\\(`).test(t);
    };

    for (const searchDir of searchDirs) {
      if (fs.existsSync(searchDir) && targetFunction !== 'unknownFunction') {
        const files = getAllFiles(searchDir);
        for (const f of files) {
          if ((f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.test.ts')) {
            const relPath = path.relative(process.cwd(), f).replace(/\\/g, '/');
            const fileLines = fs.readFileSync(f, 'utf-8').split('\n');
            fileLines.forEach((fileLine, idx) => {
              if (
                fileLine.includes(targetFunction) &&
                isCallSite(fileLine) &&
                !(relPath === filePath && idx + 1 <= line && idx + 1 >= line - 10)
              ) {
                callers.push({
                  filePath: relPath,
                  functionName: targetFunction,
                  lineNumber: idx + 1,
                  relation: 'CALLS_UNVERIFIED'
                });
              }
            });
          }
        }
      }
    }

    console.log(
      `[Text-Scan] Isolated function: "${targetFunction}" with ${callers.length} candidate callers ` +
        `(UNVERIFIED: the 'entire' CLI is not installed, so this is a lexical scan, not an AST call graph)`
    );

    return {
      targetFunction,
      filePath,
      lineNumber: line,
      callers,
      callees: [],
      resolvedVia: 'text-scan-fallback'
    };
  } catch (err: any) {
    throw new AstQueryFailed(`Text-scan fallback failed: ${err.message}`);
  }
}

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}
