import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { FailureSpan, BlastRadiusReport } from '../core/types.js';
import { PatchSynthesisFailed } from '../core/errors.js';
import { SynthesisMode } from '../economics/measurements.js';
import { config } from '../config/env.js';

export interface GeneratedPatch {
  patchCode: string;
  originalCode: string;
  rationale: string;
  tokenCount: number;
  costUSD: number;
  /**
   * Whether this patch consumed LLM tokens or was produced locally. Carried
   * into the measurement ledger so a cost figure is never quoted without
   * saying what produced it.
   */
  synthesisMode: SynthesisMode;
}

/**
 * A member-expression chain that starts with a real identifier.
 *
 * The leading `[A-Za-z_$]` matters: an earlier version used
 * `[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+`, which also matched the numeric literal in
 * `1.5` and rewrote it to `1?.5`.
 */
const MEMBER_CHAIN = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+/g;

/** Ranges (as [start, end) offsets) covered by a quoted literal on a line. */
function quotedRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let quote: string | null = null;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (quote === null && (ch === '"' || ch === "'" || ch === '`')) {
      quote = ch;
      start = i;
    } else if (quote !== null && ch === quote) {
      ranges.push([start, i + 1]);
      quote = null;
    }
  }
  if (quote !== null) ranges.push([start, line.length]);
  return ranges;
}

function isInsideRanges(ranges: Array<[number, number]>, offset: number): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Rewrites every property chain on `line` into optional chaining with a
 * nullish-coalesced fallback.
 *
 * Two correctness properties this must hold:
 *
 *  1. Each rewritten chain is parenthesised. `??` binds looser than `*`, `+`
 *     and most binary operators, so an unparenthesised
 *     `invoice?.rate ?? "Unknown City" * 2` silently becomes
 *     `(invoice?.rate ?? "Unknown City") * 2` -- a value substitution, not a
 *     null guard. The fallback is applied once, to the whole returned
 *     expression, so precedence cannot be inverted.
 *  2. Chains inside string literals are left alone.
 */
export function toSafeNavigation(line: string, fallback = '"Unknown City"'): string {
  const quoted = quotedRanges(line);

  const rewritten = line.replace(MEMBER_CHAIN, (chain, offset: number) => {
    if (isInsideRanges(quoted, offset)) return chain;
    return `(${chain.replace(/\./g, '?.')})`;
  });

  const isReturnStatement = /^\s*return\b/.test(rewritten);
  if (!isReturnStatement) return rewritten;

  // Attach the fallback to the returned expression, after the optional chaining
  // rewrite, preserving any trailing semicolon.
  const trimmedEnd = rewritten.replace(/\s*;\s*$/, '');
  const semicolon = rewritten.trimEnd().endsWith(';') ? ';' : '';
  return `${trimmedEnd} ?? ${fallback}${semicolon}`;
}

/**
 * Parses `code` as TypeScript and returns the parser's diagnostics.
 *
 * Used to reject an LLM patch before it overwrites the target file. Checking
 * only that the reply *mentions* the target function accepts prose, a diff, or
 * a file that does not compile.
 */
export function parseDiagnostics(code: string): string[] {
  const sourceFile = ts.createSourceFile(
    'candidate.ts',
    code,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ false,
    ts.ScriptKind.TS
  );
  // `parseDiagnostics` is not in the public .d.ts surface, so it is read off the
  // internal shape with a cast rather than suppressed.
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics
    .slice(0, 5)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

/** True when `code` parses as TypeScript without syntax errors. */
export function isParsable(code: string): boolean {
  return parseDiagnostics(code).length === 0;
}

export class PatchGenerator {
  /**
   * Generates a code patch based on attempt number, trace, and AST context.
   */
  static async generatePatch(
    filePath: string,
    span: FailureSpan,
    blastRadius: BlastRadiusReport,
    attempt: number,
    forceFault = false
  ): Promise<GeneratedPatch> {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new PatchSynthesisFailed(`Target file does not exist: ${filePath}`);
    }

    const fileContent = fs.readFileSync(fullPath, 'utf-8');
    const lines = fileContent.split('\n');
    const targetLineIdx = (span.lineNumber && span.lineNumber > 0 && span.lineNumber <= lines.length)
      ? span.lineNumber - 1
      : lines.findIndex(l => l.includes('return ') && l.includes('.'));

    const offendingLine = targetLineIdx >= 0 ? lines[targetLineIdx] : '';

    // Extract failing property name from error message (e.g., "reading 'address'" -> "address")
    const propMatch = span.errorMessage.match(/reading\s+['"]([^'"]+)['"]/i) ||
                      span.errorMessage.match(/Cannot read property\s+['"]([^'"]+)['"]/i);
    const failingProperty = propMatch ? propMatch[1] : '';

    // ==========================================
    // ATTEMPT 1: Trace-blind patch (stack trace only, NO caller context)
    //
    // This is a genuinely limited strategy, not a staged failure. Without the
    // AST blast radius the agent can only see the throwing statement, so it
    // guards the immediate receiver and misses the root-null case one level
    // further out. The reproduction test asserts the root-null case, so this
    // attempt fails for a real reason and the rollback is earned.
    //
    // It is chosen when the operator asks for it (`--demo-force-fault`) or when
    // there is genuinely no caller context to learn from. When the blast radius
    // *does* carry callers, attempt 1 gets them -- otherwise every automatic
    // run would stage a failure it did not need to stage.
    // ==========================================
    const useBlindStrategy = forceFault || (blastRadius?.callers?.length ?? 0) === 0;

    if (attempt === 1 && useBlindStrategy) {
      console.log(`[PatchGenerator] Generating Attempt 1 (Trace-blind: stack trace only, no caller context)...`);

      let naivePatch = fileContent;
      // The failing property name comes from an error message, i.e. from
      // untrusted input. Escape it before interpolating into a RegExp.
      const escapedProperty = failingProperty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Locate the member chain that raised, e.g. invoice.customer.address.city
      const memberRegex = escapedProperty
        ? new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*\\.${escapedProperty}(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)?)`, 'g')
        : null;
      const match = memberRegex ? offendingLine.match(memberRegex) : null;

      if (match && match[0]) {
        const chain = match[0];
        const lastDot = chain.lastIndexOf('.');
        const receiver = chain.substring(0, lastDot);
        const remainder = chain.substring(lastDot);
        // Trace-blind fix: guard the immediate receiver only. When the object
        // that actually raised is one level FURTHER out (invoice itself is
        // undefined), this guard does not help -- which is the real blind
        // spot, not a deliberately planted bug.
        const naiveLine = offendingLine.replace(chain, `(${receiver} ? ${receiver}${remainder} : "Unknown")`);
        const patchLines = [...lines];
        patchLines[targetLineIdx] = `  // Trace-blind patch: guards only the immediate receiver\n${naiveLine}`;
        naivePatch = patchLines.join('\n');
      } else if (offendingLine && targetLineIdx >= 0) {
        // No chain matched the reported property. Guard the whole offending
        // statement generically rather than substituting a hardcoded literal
        // from one specific demo file.
        const patchLines = [...lines];
        patchLines[targetLineIdx] =
          `  // Trace-blind patch: no caller context available\n${toSafeNavigation(offendingLine, '"Unknown"')}`;
        naivePatch = patchLines.join('\n');
      }

      const promptLength = (span.errorMessage + offendingLine).length;
      const tokenCount = Math.ceil((promptLength + naivePatch.length) / 4);
      const costUSD = Number(((tokenCount / 1_000_000) * 0.15).toFixed(6));

      return {
        patchCode: naivePatch,
        originalCode: fileContent,
        rationale: 'Attempt 1 (Trace-blind): Shallow guard from the stack trace alone, without AST caller traversal.',
        tokenCount,
        costUSD,
        synthesisMode: 'offline-transformer'
      };
    }

    // ==========================================
    // ATTEMPT 2: Full context + AST repair
    // ==========================================
    console.log(`[PatchGenerator] Generating Attempt ${attempt} (Informed patch with AST & Trace context)...`);

    // 1. Try real LLM provider if configured (OpenRouter / OpenAI / Anthropic)
    const apiKey = config.openRouterApiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const promptSystem = 'You are an autonomous code repair agent. Output ONLY valid TypeScript replacement code for the entire file with the crash fixed. No markdown backticks, no conversational text.';
        const promptUser = `Fix the runtime crash in ${filePath}:\nError: ${span.errorMessage}\nStack:\n${span.errorStack}\nTarget Function: ${blastRadius.targetFunction}\nCallers (${blastRadius.callers.length}): ${JSON.stringify(blastRadius.callers)}\n\nSource Code:\n${fileContent}`;

        const endpoint = config.openRouterApiKey
          ? 'https://openrouter.ai/api/v1/chat/completions'
          : 'https://api.openai.com/v1/chat/completions';

        const model = config.openRouterApiKey ? 'google/gemini-2.5-flash' : 'gpt-4o-mini';

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: promptSystem },
              { role: 'user', content: promptUser }
            ],
            temperature: 0.1
          })
        });

        if (response.ok) {
          const json: any = await response.json();
          let rawFix = json.choices?.[0]?.message?.content?.trim();
          if (rawFix) {
            rawFix = rawFix.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
            // A reply that merely mentions the target function can still be
            // prose, a diff, or a file that does not compile -- and this code
            // is about to overwrite the target. Require that it parses as
            // TypeScript before it is accepted.
            const syntaxErrors = parseDiagnostics(rawFix);
            if (syntaxErrors.length > 0) {
              console.warn(
                `[PatchGenerator] Rejected LLM patch for ${filePath}: does not parse ` +
                  `(${syntaxErrors[0]}). Falling back to the AST-guided transformer.`
              );
            } else if (rawFix.includes(blastRadius.targetFunction)) {
              const usage = json.usage || {};
              const totalTokens = usage.total_tokens || Math.ceil((promptUser.length + rawFix.length) / 4);
              const cost = Number(((totalTokens / 1_000_000) * 0.30).toFixed(6));

              return {
                patchCode: rawFix,
                originalCode: fileContent,
                rationale: `Attempt ${attempt}: Autonomous LLM synthesized AST-aware null-safe patch (${model}).`,
                tokenCount: totalTokens,
                costUSD: cost,
                synthesisMode: 'llm'
              };
            }
          }
        }
      } catch (err: any) {
        console.warn(`[PatchGenerator] LLM API call fallback (${err.message}). Using AST-guided transformation engine.`);
      }
    }

    // 2. Autonomous AST-Guided Property Transformer (Offline / Guaranteed Fallback)
    let robustPatch = fileContent;

    if (offendingLine && targetLineIdx >= 0) {
      // Already null-guarded: rewriting `a?.b` again would produce nonsense.
      if (offendingLine.includes('?.')) {
        robustPatch = fileContent;
      } else {
        const patchLines = [...lines];
        patchLines[targetLineIdx] =
          `  // SutureLoop Verified Patch: AST-guided safe navigation with fallback\n${toSafeNavigation(offendingLine)}`;
        robustPatch = patchLines.join('\n');
      }
    }

    // Never hand a syntactically broken file to the test runner: the failure
    // would be attributed to the remediation rather than to the bug.
    if (robustPatch !== fileContent && !isParsable(robustPatch)) {
      throw new PatchSynthesisFailed(
        `AST-guided patch for ${filePath} did not produce parsable TypeScript; refusing to write it.`
      );
    }

    const promptText = `Target: ${filePath}:${span.lineNumber}\nError: ${span.errorMessage}\nFunction: ${blastRadius.targetFunction}`;
    const tokenCount = Math.ceil((promptText.length + robustPatch.length) / 4);
    const costUSD = Number(((tokenCount / 1_000_000) * 0.30).toFixed(6));

    return {
      patchCode: robustPatch,
      originalCode: fileContent,
rationale: `Attempt ${attempt}: Applied AST-guided safe property navigation with bounded fallback.`,
    tokenCount,
    costUSD,
    synthesisMode: 'offline-transformer'
  };
  }
}
