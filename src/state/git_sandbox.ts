import { exec } from 'child_process';
import { promisify } from 'util';
import { assertCleanWorktree } from '../core/invariants.js';

const execAsync = promisify(exec);

export class GitSandbox {
  static async isPristine(allowedPrefix = 'demo'): Promise<boolean> {
    try {
      assertCleanWorktree(allowedPrefix);
      return true;
    } catch {
      return false;
    }
  }

  static async getModifiedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('git status --porcelain');
      if (!stdout.trim()) return [];
      return stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().substring(3));
    } catch {
      return [];
    }
  }

  static async getDiff(): Promise<string> {
    try {
      const { stdout } = await execAsync('git diff');
      return stdout;
    } catch {
      return '';
    }
  }
}
