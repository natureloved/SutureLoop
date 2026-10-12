export interface FailureSpan {
  traceId: string;
  spanId?: string;
  name?: string;
  service?: string;
  timestamp?: number;
  errorMessage: string;
  errorStack?: string;
  filePath?: string;
  lineNumber?: number;
  rawAttributes?: Record<string, any>;
}

export interface AstCaller {
  filePath: string;
  functionName: string;
  lineNumber: number;
  relation?: string;
}

export interface BlastRadiusReport {
  targetFunction: string;
  filePath: string;
  lineNumber: number;
  callers: AstCaller[];
  callees?: string[];
  /**
   * How the call graph was produced. 'text-scan-fallback' means a lexical
   * scan, not an AST call graph -- callers from it are UNVERIFIED.
   */
  resolvedVia: 'entire-graph' | 'text-scan-fallback';
}

export interface CheckpointInfo {
  id: string;
  tag: string;
  createdAt: number;
  type: 'entire-native' | 'git-safety-net';
}

export interface ComparativeEvalResult {
  mode: 'PROGRAMMATIC_EVAL' | 'DASHBOARD_SIDE_BY_SIDE';
  baselineTraceId: string;
  healedTraceId: string;
  baselineTraceUrl: string;
  healedTraceUrl: string;
  baselineErrors?: number;
  healedErrors?: number;
  deltaErrors?: number;
  durationMs?: number;
  tokenCostUSD?: number;
  status: 'VERIFIED_PASS' | 'REGRESSION_DETECTED' | 'MANUAL_VERIFICATION_REQUIRED';
  note?: string;
  error?: string;
  /**
   * Which layer actually produced this verdict. Reported so the demo never
   * claims a stronger verification than it performed.
   */
  verifiedBy?: 'local-spans' | 'local-spans+live-replay' | 'neatlogs-cli' | 'dashboard-manual';
}

export interface PatchAttemptResult {
  attempt: number;
  blindPrompt: boolean;
  patchApplied: boolean;
  testPassed: boolean;
  rollbackOccurred: boolean;
  rollbackDurationMs?: number;
  testOutput: string;
  patchDiff?: string;
  error?: string;
}

export interface SelfHealingSessionResult {
  sessionId: string;
  incidentTraceId: string;
  healedTraceId?: string;
  targetFile: string;
  targetFunction: string;
  blastRadius: BlastRadiusReport;
  checkpointId: string;
  attempts: PatchAttemptResult[];
  evalResult?: ComparativeEvalResult;
  economicMetrics?: {
    measuredTokenCostUSD: number;
    mttrHoursSaved: number;
    hourlyEngineerRateUSD: number;
    grossSavingsUSD: number;
    netSavingsUSD: number;
    grossMarginPercent: number;
  };
  durationMs: number;
  finalStatus: 'HEALED' | 'FAILED' | 'ROLLED_BACK';
}
