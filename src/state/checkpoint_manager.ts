import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { CheckpointFailed } from '../core/errors.js';
import { CheckpointInfo } from '../core/types.js';

const execFileAsync = promisify(execFile);

interface ExtendedCheckpointInfo extends CheckpointInfo {
  targetFile?: string;
  fileSnapshot?: string | null;
}

export class CheckpointManager {
  private checkpoints: Map<string, ExtendedCheckpointInfo> = new Map();

  private activeBranches: Set<string> = new Set();

  async save(tag: string, targetFile?: string): Promise<string> {
    const id = `cp_${Date.now()}_${tag}`;
    const type = 'git-safety-net';
    // Labelled as what it is: an in-memory snapshot plus a git ref, scoped to
    // the remediation target. The `[Entire]` prefix here used to imply Entire
    // was doing the work; the `entire` CLI is not involved in checkpoints.
    console.log(`[Checkpoint] Creating scoped snapshot: ${id} (fenced to: ${targetFile || 'workspace'})`);

    let fileSnapshot: string | null = null;
    if (targetFile) {
      const fullPath = path.resolve(targetFile);
      if (fs.existsSync(fullPath)) {
        fileSnapshot = fs.readFileSync(fullPath, 'utf-8');
      }
    }

    try {
      // Store as git ref under refs/sutureloop/cp/* so it never pollutes the user's branch list
      await execFileAsync('git', ['update-ref', `refs/sutureloop/checkpoints/${id}`, 'HEAD']);
      // Also maintain ephemeral branch if git checkout by branch name is needed
      await execFileAsync('git', ['branch', '-f', id, 'HEAD']);
      this.activeBranches.add(id);
    } catch (gitErr: any) {
      console.warn(`[Checkpoint Warning] Git ref creation notice: ${gitErr.message}`);
    }

    const info: ExtendedCheckpointInfo = {
      id,
      tag,
      createdAt: Date.now(),
      type,
      targetFile,
      fileSnapshot
    };
    this.checkpoints.set(id, info);

    return id;
  }

  async restore(id: string, targetFile?: string): Promise<number> {
    const start = performance.now();
    const info = this.checkpoints.get(id);
    const fileToRestore = targetFile || info?.targetFile;

    if (!fileToRestore) {
      throw new CheckpointFailed(`Scoped rollback failed: target file is undefined for checkpoint '${id}'.`);
    }

    console.log(`[Checkpoint] Restoring snapshot: ${id} (scoped strictly to: ${fileToRestore})`);

    try {
      // 1. Direct in-memory snapshot restore (instant, 100% deterministic, zero side-effects to other files)
      if (info?.fileSnapshot !== undefined && info.fileSnapshot !== null) {
        fs.writeFileSync(path.resolve(fileToRestore), info.fileSnapshot, 'utf-8');
      } else {
        // 2. Scoped git checkout of only the specific target file from the checkpoint ref
        await execFileAsync('git', ['checkout', `refs/sutureloop/checkpoints/${id}`, '--', fileToRestore]);
      }
    } catch (err: any) {
      throw new CheckpointFailed(`Scoped rollback failed: ${err.message}`);
    }

    const duration = Math.round(performance.now() - start);
    console.log(`[Checkpoint] Scoped rollback completed in ${duration}ms (target file only, other files untouched)`);
    return duration;
  }

  async cleanup(id: string): Promise<void> {
    try {
      await execFileAsync('git', ['branch', '-D', id]);
    } catch {
      // Branch might not exist or already pruned
    }
    try {
      await execFileAsync('git', ['update-ref', '-d', `refs/sutureloop/checkpoints/${id}`]);
    } catch {
      // Ref might already be deleted
    }
    this.activeBranches.delete(id);
    this.checkpoints.delete(id);
  }

  async pruneAll(): Promise<void> {
    for (const id of Array.from(this.activeBranches)) {
      await this.cleanup(id);
    }
    // Also delete any dangling cp_* branches in git
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--list', 'cp_*']);
      const branches = stdout.split('\n').map(b => b.trim().replace(/^\*\s*/, '')).filter(Boolean);
      for (const b of branches) {
        try {
          await execFileAsync('git', ['branch', '-D', b]);
        } catch {}
      }
    } catch {}
  }

  async isTreePristine(targetFile?: string): Promise<boolean> {
    try {
      const checkPath = targetFile ? targetFile : 'demo/service/routes/billing.ts';
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', checkPath]);
      return stdout.trim().length === 0;
    } catch {
      return false;
    }
  }

  getCheckpointInfo(id: string): CheckpointInfo | undefined {
    return this.checkpoints.get(id);
  }
}
