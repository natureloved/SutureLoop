import { resolveAstBlastRadius } from './entire_graph.js';
import { BlastRadiusReport, AstCaller } from '../core/types.js';
import * as fs from 'fs';
import * as path from 'path';

export interface ComprehensiveImpact {
  report: BlastRadiusReport;
  impactedRoutes: string[];
  affectedTests: string[];
  summary: string;
}

export async function analyzeBlastRadius(
  filePath: string,
  lineNumber: number
): Promise<ComprehensiveImpact> {
  const report = await resolveAstBlastRadius(filePath, lineNumber);

  const impactedRoutes: string[] = [];
  const affectedTests: string[] = [];

  // Check callers for route registrations or API calls
  for (const caller of report.callers) {
    if (caller.filePath.includes('routes') || caller.filePath.includes('server')) {
      impactedRoutes.push(`${caller.filePath}:${caller.lineNumber} (${caller.functionName})`);
    }
  }

  // Scan tests directory for mentions of the target function
  const testDir = path.resolve('demo/tests');
  if (fs.existsSync(testDir)) {
    const testFiles = fs.readdirSync(testDir);
    for (const file of testFiles) {
      if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) {
        const fullPath = path.join(testDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.includes(report.targetFunction)) {
          affectedTests.push(`demo/tests/${file}`);
        }
      }
    }
  }

  const summary = `Function '${report.targetFunction}' in '${report.filePath}' (line ${report.lineNumber}) has ${report.callers.length} downstream caller(s), affecting ${impactedRoutes.length} route(s) and ${affectedTests.length} test suite(s).`;

  return {
    report,
    impactedRoutes,
    affectedTests,
    summary
  };
}
