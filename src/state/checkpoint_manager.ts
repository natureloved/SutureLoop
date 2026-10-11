import { exec } from 'child_process';
import { promisify } from 'util';
import { CheckpointFailed } from '../core/errors.js';
import { CheckpointInfo } from '../core/types.js';

const execAsync = promisify(exec);

export class CheckpointManager {
  private checkpoints: Map<string, CheckpointInfo> = new Map();

  async save(tag: string): Promise<string> {
    const id = `cp_${Date.now()}_${tag}`;
    let type: 'entire-native' | 'git-safety-net' = 'entire-native';

    try {
      // Attempt Entire native checkpoint if available
      await execAsync(`entire checkpoint save "${id}"`);
      console.log(`[Entire] Created native checkpoint: ${id}`);
    } catch {
      // Honest label: git safety net (behavioral parity, no session context)
      type = 'git-safety-net';
      console.log(`[Entire] Using git safety net branch: ${id} (behavioral parity, no session context)`);
      try {
        await execAsync(`git branch -f ${id} HEAD`);
      } catch (gitErr: any) {
        throw new CheckpointFailed(`Git checkpoint creation failed: ${gitErr.message}`);
      }
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
    try {
      await execAsync(`entire checkpoint restore "${id}"`);
      console.log(`[Entire] Restored from native checkpoint: ${id}`);
    } catch {
      try {
        console.log(`[Entire] Rolling back via git safety net to: ${id}`);
        await execAsync(`git reset --hard ${id}`);
        // CRITICAL: Scope clean strictly to demo/ to avoid wiping runs/posts/ or evidence files!
        await execAsync(`git clean -fd -- demo/`);
      } catch (err: any) {
        throw new CheckpointFailed(`Rollback failed: ${err.message}`);
      }
    }
    const duration = Date.now() - start;
    console.log(`[Entire] Rollback complete in ${duration}ms`);
    return duration;
  }

  async isTreePristine(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`git status --porcelain`);
      return stdout.trim().length === 0;
    } catch {
      return false;
    }
  }

  getCheckpointInfo(id: string): CheckpointInfo | undefined {
    return this.checkpoints.get(id);
  }
}
