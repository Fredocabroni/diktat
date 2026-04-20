export class DiktatError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ValidationError extends DiktatError {
  constructor(message: string, cause?: unknown) {
    super('VALIDATION_FAILED', message, { cause });
  }
}

export class NotFoundError extends DiktatError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', id ? `${resource} not found: ${id}` : `${resource} not found`);
  }
}

export class BudgetExceededError extends DiktatError {
  readonly task: string;
  readonly attemptedUsd: number;
  readonly capUsd: number;

  constructor(task: string, attemptedUsd: number, capUsd: number) {
    super(
      'BUDGET_EXCEEDED',
      `AI budget exceeded for task=${task}: attempted $${attemptedUsd.toFixed(4)} would exceed cap $${capUsd.toFixed(2)}`,
    );
    this.task = task;
    this.attemptedUsd = attemptedUsd;
    this.capUsd = capUsd;
  }
}

export class RoutingError extends DiktatError {
  constructor(message: string, cause?: unknown) {
    super('ROUTING_FAILED', message, { cause });
  }
}

export class ProviderError extends DiktatError {
  readonly provider: string;
  readonly httpStatus?: number;

  constructor(provider: string, message: string, httpStatus?: number, cause?: unknown) {
    super('PROVIDER_FAILED', `[${provider}] ${message}`, { cause });
    this.provider = provider;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}
