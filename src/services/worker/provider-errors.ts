// F4 foundation: classified provider errors with extensible kind field.
export type ProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'context_overflow'
  | (string & {}); // open union: providers may emit custom kinds

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;

  constructor(message: string, opts: {
    kind: ProviderErrorClass;
    cause: unknown;
    retryAfterMs?: number;
  }) {
    super(message);
    this.name = 'ClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
  }
}

export function isClassified(err: unknown): err is ClassifiedProviderError {
  return err instanceof ClassifiedProviderError;
}

export function isContextOverflowMessage(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  const lower = value.toLowerCase();
  return (
    lower.includes('prompt is too long') ||
    lower.includes('context overflow') ||
    lower.includes('context window') ||
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('max context') ||
    lower.includes('input too long') ||
    lower.includes('too many tokens') ||
    lower.includes('token count exceeds') ||
    /exceeds? (the )?(maximum|max)? ?(input )?(token|context)/.test(lower) ||
    /(token|context).{0,40}exceeds?/.test(lower)
  );
}

export function isProviderContextOverflowError(err: unknown): boolean {
  if (isClassified(err) && err.kind === 'context_overflow') {
    return true;
  }
  if (err instanceof Error && isContextOverflowMessage(err.message)) {
    return true;
  }
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && isContextOverflowMessage(cause.message)) {
    return true;
  }
  if (typeof cause === 'string' && isContextOverflowMessage(cause)) {
    return true;
  }
  return false;
}
