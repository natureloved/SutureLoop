import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { AstQueryFailed } from '../core/errors.js';
import { AstCaller, BlastRadiusReport } from '../core/types.js';

const execAsync = promisify(exec);

export async function resolveAstBlastRadius(
  filePath: string,
  line: number
): Promise<BlastRadiusReport> {
  let normPath = filePath.replace(/\\/g, '/');
  const rootPath = process.cwd().replace(/\\/g, '/');
  if (normPath.toLowerCase().startsWith(rootPath.toLowerCase())) {
    normPath = normPath.slice(rootPath.length).replace(/^\//, '');
  }
  const targetSymbol = `${normPath}:${line}`;

  try {
    // Run entire graph impact using the official CLI format discovered in Spike 1
    const { stdout, stderr } = await execAsync(
      `entire graph impact --repo . --symbol "${targetSymbol}" --format json`
    );

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
    console.warn(
      `[Entire] 'entire graph impact' failed or returned unexpected payload: ${err.message}. Activating regex AST parser fallback...`
    );
    return regexAstFallback(normPath, line);
  }
}

/**
 * Deterministic regex-based AST fallback parser:
 * Reads the target source file, scans upward from crash line to locate enclosing function,
 * and searches calling files in demo/service for callers.
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

    for (const searchDir of searchDirs) {
      if (fs.existsSync(searchDir) && targetFunction !== 'unknownFunction') {
        const files = getAllFiles(searchDir);
        for (const f of files) {
          if ((f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.test.ts')) {
            const relPath = path.relative(process.cwd(), f).replace(/\\/g, '/');
            const fileLines = fs.readFileSync(f, 'utf-8').split('\n');
            fileLines.forEach((fileLine, idx) => {
              // Exclude the definition line itself
              if (
                fileLine.includes(targetFunction) &&
                !(relPath === filePath && idx + 1 <= line && idx + 1 >= line - 10)
              ) {
                callers.push({
                  filePath: relPath,
                  functionName: fileLine.trim().slice(0, 40),
                  lineNumber: idx + 1,
                  relation: 'CALLS'
                });
              }
            });
          }
        }
      }
    }

    console.log(
      `[Regex-AST] Isolated function: "${targetFunction}" with ${callers.length} callers`
    );

    return {
      targetFunction,
      filePath,
      lineNumber: line,
      callers,
      callees: [],
      resolvedVia: 'regex-fallback'
    };
  } catch (err: any) {
    throw new AstQueryFailed(`Regex AST fallback failed: ${err.message}`);
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
