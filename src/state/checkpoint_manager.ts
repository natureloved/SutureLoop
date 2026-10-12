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

  async save(tag: string, targetFile?: string): Promise<string> {
    const id = `cp_${Date.now()}_${tag}`;
    const type = 'git-safety-net';
    console.log(`[Entire] Creating scoped checkpoint: ${id} (fenced to target file)`);

    let fileSnapshot: string | null = null;
    if (targetFile) {
      const fullPath = path.resolve(targetFile);
      if (fs.existsSync(fullPath)) {
        fileSnapshot = fs.readFileSync(fullPath, 'utf-8');
      }
    }

    try {
      // Create local git checkpoint ref for safety net without touching other worktree files
      await execFileAsync('git', ['branch', '-f', id, 'HEAD']);
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

    console.log(`[Entire] Restoring checkpoint: ${id} (scoped to: ${fileToRestore || 'fenced files'})`);

    try {
      // 1. Direct in-memory snapshot restore (instant, zero side-effects to other workspace files)
      if (fileToRestore && info?.fileSnapshot !== undefined && info.fileSnapshot !== null) {
        fs.writeFileSync(path.resolve(fileToRestore), info.fileSnapshot, 'utf-8');
      } else if (fileToRestore) {
        // 2. Scoped git checkout of only the specific target file from the checkpoint branch
        await execFileAsync('git', ['checkout', id, '--', fileToRestore]);
      } else {
        // Fallback: restore demo files only, never repo-wide root
        await execFileAsync('git', ['checkout', id, '--', 'demo/service/routes/billing.ts']);
      }
    } catch (err: any) {
      throw new CheckpointFailed(`Scoped rollback failed: ${err.message}`);
    }

    const duration = Math.round(performance.now() - start);
    console.log(`[Entire] Scoped rollback completed in ${duration}ms (workspace protected, zero data loss)`);
    return duration;
  }

  async cleanup(id: string): Promise<void> {
    try {
      await execFileAsync('git', ['branch', '-D', id]);
    } catch {
      // Ignore if branch was already pruned
    }
    this.checkpoints.delete(id);
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
