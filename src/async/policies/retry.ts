import { safe, PolicyError } from '../';

export class RetryError extends PolicyError {
  constructor(
    action: string,
    public attempt: number,
    public innerError?: Error,
  ) {
    super(
      `${action} retried max times [${attempt}] ${
        innerError ? `with error: ${innerError.message}` : ''
      }`.trim(),
    );
  }
}

type RetryOptions<E, T> = {
  retries?: number;
  delay?: number | false;
  shouldRetry?: {
    when: (data: E | T) => boolean;
    action: string;
  };
  proxyError?: boolean;
  onFail?: (
    data: E | T,
    attempt: number,
    timeout: number,
  ) => Promise<number | void>; // can return new timeout
};

export async function retryWithBackOff<E extends Error, T = any>(
  func: () => Promise<T>,
  options?: RetryOptions<E, T>,
): Promise<T> {
  const {
    retries = 3,
    delay = 300,
    shouldRetry = {
      when: () => false,
      action: 'Promise',
    },
    proxyError = false,
    onFail = (_, __, timeout: number) => Promise.resolve(timeout),
  } = options || {};

  return (async function run(attempt: number, timeout: number): Promise<T> {
    async function evaluateRetry(errOrResult: E | T) {
      const newTimeout = await safe(onFail(errOrResult, attempt, timeout));
      timeout = newTimeout || timeout;
      if (attempt >= retries) {
        if (errOrResult instanceof Error) {
          throw proxyError
            ? errOrResult
            : new RetryError(shouldRetry.action, attempt, errOrResult);
        }
        throw new RetryError(shouldRetry.action, attempt);
      }
      if (timeout) {
        await new Promise(res => setTimeout(res, timeout));
      }
      return run(++attempt, timeout * 2);
    }

    try {
      const result = await func();
      if (shouldRetry.when(result)) {
        return evaluateRetry(result);
      }
      return result;
    } catch (e) {
      if (shouldRetry.when(e)) {
        return evaluateRetry(e);
      }
      throw e;
    }
  })(1, delay || 0);
}
