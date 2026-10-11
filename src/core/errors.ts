export class TraceFetchFailed extends Error {
  constructor(msg: string) {
    super(`TraceFetchFailed: ${msg}`);
    this.name = 'TraceFetchFailed';
  }
}

export class AstQueryFailed extends Error {
  constructor(msg: string) {
    super(`AstQueryFailed: ${msg}`);
    this.name = 'AstQueryFailed';
  }
}

export class CheckpointFailed extends Error {
  constructor(msg: string) {
    super(`CheckpointFailed: ${msg}`);
    this.name = 'CheckpointFailed';
  }
}

export class InvariantViolationError extends Error {
  constructor(msg: string) {
    super(`InvariantViolationError: ${msg}`);
    this.name = 'InvariantViolationError';
  }
}

export class PatchSynthesisFailed extends Error {
  constructor(msg: string) {
    super(`PatchSynthesisFailed: ${msg}`);
    this.name = 'PatchSynthesisFailed';
  }
}
