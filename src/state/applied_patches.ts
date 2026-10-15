import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Tracks files that SutureLoop itself has patched and not yet committed.
 *
 * Why this exists: `assertCleanWorktree` refuses to remediate a file with
 * uncommitted changes, because an atomic rollback would destroy work. A
 * successful heal, however, *by design* leaves the patched file uncommitted --
 * the patch is the agent's output. Without this record, watch mode would heal
 * exactly one incident and then refuse every subsequent one, because the file
 * it just wrote is now "dirty work at risk".
 *
 * The record is deliberately content-addressed: a file counts as agent-authored
 * only when its current bytes still hash to what the agent wrote. The moment a
 * developer edits on top of the patch the hash diverges and the normal safety
 * gate takes over again.
 *
 * Stored under `.git/sutureloop/` so it never appears in `git status` and can
 * never itself be mistaken for project state. When there is no `.git` (tarball,
 * Docker build) every call is a safe no-op and the stricter behaviour applies.
 */
interface AppliedPatchRecord {
  /** Repo-relative, forward-slashed path. */
  file: string;
  /** SHA-256 of the exact bytes the agent wrote. */
  hash: string;
  appliedAt: number;
  sessionId?: string;
}

function stateDir(): string | null {
  try {
    const gitDir = path.resolve(process.cwd(), '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return null;
    return path.join(gitDir, 'sutureloop');
  } catch {
    return null;
  }
}

function stateFile(): string | null {
  const dir = stateDir();
  return dir ? path.join(dir, 'applied-patches.json') : null;
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function readRecords(): AppliedPatchRecord[] {
  const file = stateFile();
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as AppliedPatchRecord[]) : [];
  } catch {
    return [];
  }
}

function writeRecords(records: AppliedPatchRecord[]): void {
  const dir = stateDir();
  const file = stateFile();
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[AppliedPatch] Could not persist applied-patch record: ${err.message}`);
  }
}

function toRepoRelative(filePath: string): string {
  const abs = path.resolve(filePath);
  const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
  return rel.startsWith('..') ? abs.replace(/\\/g, '/') : rel;
}

/** Records that the agent wrote `content` into `filePath` and left it uncommitted. */
export function recordAppliedPatch(filePath: string, content: string, sessionId?: string): void {
  const file = toRepoRelative(filePath);
  const record: AppliedPatchRecord = {
    file,
    hash: hashContent(content),
    appliedAt: Date.now(),
    sessionId
  };
  const others = readRecords().filter((r) => r.file !== file);
  writeRecords([...others, record]);
}

/** Drops the record, e.g. after a rollback restored the file to baseline. */
export function clearAppliedPatch(filePath: string): void {
  const file = toRepoRelative(filePath);
  const records = readRecords();
  const kept = records.filter((r) => r.file !== file);
  if (kept.length !== records.length) writeRecords(kept);
}

/**
 * True when the file on disk is byte-for-byte what SutureLoop last wrote.
 *
 * Any divergence -- a developer edit, an external tool, a second agent -- makes
 * this false, which re-arms the "uncommitted work at risk" gate.
 */
export function isAgentAuthored(filePath: string): boolean {
  const file = toRepoRelative(filePath);
  const record = readRecords().find((r) => r.file === file);
  if (!record) return false;
  try {
    const current = fs.readFileSync(path.resolve(filePath), 'utf-8');
    if (hashContent(current) === record.hash) return true;
    clearAppliedPatch(file);
    return false;
  } catch {
    clearAppliedPatch(file);
    return false;
  }
}