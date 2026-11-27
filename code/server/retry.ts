export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

export type RetryOptions = {
  backoffMs?: () => number;
};

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function linkedTimeoutSignal(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) {
      controller.abort(outer.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
    outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    const error = new Error('timeout');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}

export function parseJsonRetryable(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RetryableError(label);
  }
}

export async function readJsonRetryable(response: Response, label: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    throw new RetryableError(label);
  }
}

export async function runWithSingleRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: { signal?: AbortSignal; backoffMs?: () => number } = {},
): Promise<T> {
  const { signal, backoffMs = () => 350 + Math.floor(Math.random() * 150) } = options;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable = error instanceof RetryableError || (!isAbortError(error) && error instanceof TypeError);
      if (attempt >= 2 || !retryable || signal?.aborted) throw error;
      await waitWithAbort(backoffMs(), signal);
    }
  }
  throw new Error('unreachable');
}
