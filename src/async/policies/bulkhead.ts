import { safe, PolicyError } from '../';

export class BulkheadConcurrencyError extends PolicyError {
  constructor(
    action: string,
    public maxConcurrency: number,
    public callCount: number,
  ) {
    super(
      `${action} exceeded max concurrency [${maxConcurrency}] on call count [${callCount}]`,
    );
  }
}

export class BulkheadTimeoutError extends PolicyError {
  constructor(action: string, public timeoutInMs: number) {
    super(`${action} blocked by bulkhead timed out in [${timeoutInMs}ms]`);
  }
}

export type BulkheadInvoker<T = any> = (
  func: () => Promise<T>,
  runOptions?: BulkheadRunOptions,
) => Promise<T>;

type BulkheadOptions = {
  maxConcurrency?: number;
};

type BulkheadRunOptions = {
  action?: string;
  onResourceLimitConsumed?:
    | { kind: 'error' }
    | {
        kind: 'block';
        timeoutInMs?: number;
        onBlock?: (
          maxConcurrency: number,
          callCount: number,
          callingContext?: any,
        ) => Promise<void>;
      };
};

export function bulkhead<T = any>(
  options?: BulkheadOptions,
): BulkheadInvoker<T> {
  const deferredPromises: ((value?: unknown) => void)[] = [];
  let callCount = 0;

  const { maxConcurrency = 50 } = options || {};

  const aquire = ({ action, onResourceLimitConsumed }): Promise<void> => {
    if (++callCount <= maxConcurrency) {
      return Promise.resolve();
    }
    switch (onResourceLimitConsumed.kind) {
      case 'error':
        return Promise.reject(
          new BulkheadConcurrencyError(action, maxConcurrency, callCount),
        );
      case 'block':
        return new Promise(async (resolve, reject) => {
          deferredPromises.push(resolve);

          if (onResourceLimitConsumed.timeoutInMs) {
            setTimeout(() => {
              deferredPromises.shift();
              reject(
                new BulkheadTimeoutError(
                  action,
                  onResourceLimitConsumed.timeoutInMs,
                ),
              );
            }, onResourceLimitConsumed.timeoutInMs);
          }

          const onBlock =
            onResourceLimitConsumed.onBlock || (() => Promise.resolve());
          await safe(onBlock(maxConcurrency, callCount));
        });
    }
  };

  const release = (): void => {
    const pendingResolve = deferredPromises.shift();
    if (pendingResolve) {
      pendingResolve();
    }
    --callCount;
  };

  return async (
    func: () => Promise<T>,
    runOptions?: BulkheadRunOptions,
  ): Promise<T> => {
    const {
      action = 'Promise',
      onResourceLimitConsumed = {
        kind: 'block',
      },
    } = runOptions || {};

    try {
      await aquire({ action, onResourceLimitConsumed });
      return await func();
    } finally {
      release();
    }
  };
}
