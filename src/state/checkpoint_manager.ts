import { exec } from 'child_process';
import { promisify } from 'util';
import { CheckpointFailed } from '../core/errors.js';
import { CheckpointInfo } from '../core/types.js';

const execAsync = promisify(exec);

export class CheckpointManager {
  private checkpoints: Map<string, CheckpointInfo> = new Map();

  async save(tag: string): Promise<string> {
    const id = `cp_${Date.now()}_${tag}`;
    const type = 'git-safety-net';
    console.log(`[Entire] Using git safety net branch: ${id} (behavioral parity, no session context)`);
    try {
      await execAsync(`git branch -f ${id} HEAD`);
    } catch (gitErr: any) {
      throw new CheckpointFailed(`Git checkpoint creation failed: ${gitErr.message}`);
    }

    const info: CheckpointInfo = {
      id,
      tag,
      createdAt: Date.now(),
      type
    };
    this.checkpoints.set(id, info);

    return id;
  }

  async restore(id: string): Promise<number> {
    const start = Date.now();
    console.log(`[Entire] Rolling back via git safety net to: ${id}`);
    try {
      await execAsync(`git reset --hard ${id}`);
      // CRITICAL: Scope clean strictly to demo/service/ to avoid wiping runs/posts/ or evidence files!
      await execAsync(`git clean -fd -- demo/service/`);
    } catch (err: any) {
      throw new CheckpointFailed(`Rollback failed: ${err.message}`);
    }
    const duration = Date.now() - start;
    console.log(`[Entire] Rollback complete in ${duration}ms`);
    return duration;
  }

  async isTreePristine(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`git status --porcelain demo/service`);
      return stdout.trim().length === 0;
    } catch {
      return false;
    }
  }

  getCheckpointInfo(id: string): CheckpointInfo | undefined {
    return this.checkpoints.get(id);
  }
}
