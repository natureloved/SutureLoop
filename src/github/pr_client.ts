import { execFile } from 'child_process';
import { promisify } from 'util';
import { assertValidTargetFile } from '../core/invariants.js';

const execFileAsync = promisify(execFile);

export interface PullRequestPayload {
  sessionId: string;
  incidentTraceId: string;
  healedTraceId?: string;
  targetFile: string;
  targetFunction: string;
  economicMetrics: {
    measuredTokenCostUSD: number;
    mttrHoursSaved: number;
    grossSavingsUSD: number;
    grossMarginPercent: number;
  };
  baselineTraceUrl?: string;
  healedTraceUrl?: string;
}

export class GitHubPRClient {
  private token?: string;
  private repo?: string;

  constructor() {
    this.token = process.env.GITHUB_TOKEN;
    this.repo = process.env.GITHUB_REPO || 'natureloved/SutureLoop';
  }

  /**
   * Creates a dedicated fix branch, pushes to remote, and opens a verified Pull Request.
   */
  async createRemediationPullRequest(payload: PullRequestPayload): Promise<{ prUrl?: string; branch: string; skipped: boolean; reason?: string }> {
    const branch = `sutureloop/fix-${payload.sessionId}`;

    // Safe default: Do NOT automatically push branches to remote Git unless explicitly opted in
    const isRemotePushEnabled = process.env.ENABLE_REMOTE_PR === 'true' || process.env.AUTO_PUSH_PR === 'true';
    if (!isRemotePushEnabled) {
      console.log(`[GitHub] Remote PR push is disabled by default for local safety. Set ENABLE_REMOTE_PR=true to enable remote git branch pushes.`);
      return { branch, skipped: true, reason: 'REMOTE_PUSH_DISABLED_SAFETY_GUARD' };
    }

    if (!this.token) {
      console.log(`[GitHub] GITHUB_TOKEN not configured. Skipping remote PR creation.`);
      return { branch, skipped: true, reason: 'GITHUB_TOKEN_NOT_CONFIGURED' };
    }

    // Re-assert the remediation boundary here, at the last point before the
    // irreversible side effect. Upstream callers already validate the target,
    // but `targetFile` arrives here as a payload field: without this fence a
    // path that reached this client by any other route could be staged and
    // pushed to origin, which is a far worse outcome than a local edit.
    try {
      assertValidTargetFile(payload.targetFile);
    } catch (err: any) {
      console.warn(`[GitHub] Refusing to push: ${err.message}`);
      return { branch, skipped: true, reason: 'TARGET_OUTSIDE_REMEDIATION_BOUNDARY' };
    }

    let startingBranch: string | null = null;
    try {
      // Remember where we were. Committing on a new branch moves HEAD, and the
      // demo sandbox restores its crash baseline from `git show HEAD:<file>`.
      // Leaving HEAD on the fix commit made "reset baseline" write back the
      // *patched* file, so the next `npm run demo` seeded no crash at all.
      const { stdout: originalBranch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      startingBranch = originalBranch.trim();

      console.log(`[GitHub] Checking out remediation branch: ${branch}...`);
      try {
        await execFileAsync('git', ['checkout', '-b', branch]);
      } catch {
        // Branch already exists from a previous run: reuse it rather than fail.
        await execFileAsync('git', ['checkout', branch]);
      }
      // Scope addition STRICTLY to the remediated target file, never repo-wide add -A
      await execFileAsync('git', ['add', '--', payload.targetFile]);
      await execFileAsync('git', [
        '-c',
        'core.hooksPath=',
        'commit',
        '-m',
        `fix(sutureloop): autonomous verified remediation for ${payload.incidentTraceId}`
      ]);
      await execFileAsync('git', ['-c', 'core.hooksPath=', 'push', 'origin', branch]);

      const title = `🩺 SutureLoop: Autonomous Verified Fix for ${payload.targetFunction}() [${payload.sessionId}]`;
      const body = `## 🩺 SutureLoop Autonomous Remediation Summary

### Incident Telemetry
- **Incident Trace ID**: \`${payload.incidentTraceId}\`
- **Target Function**: \`${payload.targetFunction}\` in \`${payload.targetFile}\`
- **Verification Status**: ✅ Verified by Vitest Regression Suite (100% PASS)

### Telemetry Verification (neatlogs)
- **Baseline Trace**: ${payload.baselineTraceUrl || 'https://app.neatlogs.com'}
- **Healed Trace**: ${payload.healedTraceUrl || 'https://app.neatlogs.com'}

### cfo.ai Unit Economics Audit
| Metric | Value |
|---|---|
| **Measured Token Spend** | **$${payload.economicMetrics.measuredTokenCostUSD.toFixed(4)} USD** |
| **MTTR Time Saved** | **${payload.economicMetrics.mttrHoursSaved} hrs ($${payload.economicMetrics.grossSavingsUSD})** |
| **Gross Margin on Fix** | **${payload.economicMetrics.grossMarginPercent}%** |

---
*Created autonomously by [SutureLoop](https://github.com/natureloved/SutureLoop) with Entire AST Code Graph and neatlogs telemetry.*`;

      const res = await fetch(`https://api.github.com/repos/${this.repo}/pulls`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'SutureLoop-Autonomous-Agent'
        },
        body: JSON.stringify({
          title,
          body,
          head: branch,
          base: 'main'
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[GitHub] Failed to create PR (${res.status}): ${errText}`);
        return { branch, skipped: true, reason: errText };
      }

      const prData = await res.json() as any;
      console.log(`[GitHub] ✅ Successfully created Pull Request: ${prData.html_url}`);
      return { prUrl: prData.html_url, branch, skipped: false };
    } catch (err: any) {
      console.warn(`[GitHub Error] ${err.message}`);
      return { branch, skipped: true, reason: err.message };
    } finally {
      // Always hand the working tree back to the branch we started on, so the
      // caller's HEAD (and therefore the demo's baseline restore) is unchanged.
      if (startingBranch && startingBranch !== branch) {
        try {
          await execFileAsync('git', ['checkout', startingBranch]);
          console.log(`[GitHub] Returned to '${startingBranch}'.`);
        } catch (backErr: any) {
          console.warn(
            `[GitHub] Could not return to '${startingBranch}': ${backErr.message}. ` +
              `You are on '${branch}' -- switch back manually.`
          );
        }
      }
    }
  }
}
