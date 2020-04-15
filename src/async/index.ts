import * as R from 'ramda';
import { AsyncFunctionKeys } from '../types';

export async function safe<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (e) {
    return void 0;
  }
}

export async function tuple<T, E = any>(
  promise: T | Promise<T>,
): Promise<[T, E]> {
  try {
    const data = await promise;
    return <[T, E]>[data, null];
  } catch (err) {
    return <[T, E]>[null, err];
  }
}

export class RetryError extends Error {
  constructor(private error: Error) {
    super(`Promise retried max times with error: ${error.message}`);
  }
}

export async function retryWithBackOff<E extends Error, T = any>(
  func: () => Promise<T>,
  options?: {
    retries?: number;
    delay?: number;
    shouldRetry?: {
      when: (data: E | T) => boolean;
      errMsg: (data: E | T) => string;
    };
    onFail?: (data: E | T, retries: number) => Promise<void>;
    withErrMsg?: (data: E | T, retries: number) => string;
  },
): Promise<T> {
  let {
    retries = 3,
    delay = 300,
    shouldRetry = {
      when: () => false,
      errMsg: () => 'should retry evaluated as true',
    },
    onFail = () => Promise.resolve(),
  } = options || {};

  return (async function run(attempt: number, timeout: number): Promise<T> {
    async function evaluateRetry<U extends T & { toString: () => string }>(
      e: E | U,
    ) {
      await safe(onFail(e, attempt));
      if (attempt >= retries) {
        throw new RetryError(e instanceof Error ? e : new Error(e.toString()));
      }
      await new Promise(res => setTimeout(res, timeout));
      return run(++attempt, timeout * 2);
    }

    try {
      const result = await func();
      if (shouldRetry.when(result)) {
        return evaluateRetry({
          ...result,
          toString: () => shouldRetry.errMsg(result),
        });
      }
      return result;
    } catch (e) {
      if (shouldRetry.when(e)) {
        return evaluateRetry(e);
      }
      throw e;
    }
  })(1, delay);
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Promise timed out in ${timeoutMs} ms`);
  }
}

export function timeout<T = any>(
  func: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  timeoutMs = timeoutMs || 30 * 1000;
  const timeout = new Promise<T>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([func(), timeout]);
}

export type PromisePolicy<T = any> = (
  p: () => Promise<T>,
  options?: any,
) => Promise<T>;

// effectively builds up a chain of decorators like:
//
// const [d1, d2] = decorators;
// return tasks.map(task => {
//   return d2(() => {
//     return d1(task);
//   });
// });
export function tupleWithPolicies(
  decorators: PromisePolicy[],
  ...tasks: (() => Promise<any>)[]
) {
  const runForTask = withPromisePolicyChain(decorators);
  return tuple(
    Promise.all(
      R.map(task => {
        return runForTask(task);
      }, tasks),
    ),
  );
}

export function withPolicies(
  decorators: PromisePolicy[],
  task: () => Promise<any>,
) {
  const runForTask = withPromisePolicyChain(decorators);
  return runForTask(task);
}

function withPromisePolicyChain(decorators: PromisePolicy[]) {
  const [firstDecorator, ...otherDecorators] = decorators;
  return function runForTask(task: () => Promise<any>) {
    const chainedDecorators = R.reduce(
      (acc, nextNecorator) => {
        return () => nextNecorator(acc);
      },
      () => {
        return firstDecorator(task);
      },
      otherDecorators,
    );
    return chainedDecorators();
  };
}

export type PolicyFactory<T> = (decorated: T) => PromisePolicy;

export function withPolicyAwareOperations<T extends object>({
  policyFactories,
  forKeys,
}: {
  policyFactories: PolicyFactory<T>[];
  forKeys: AsyncFunctionKeys<T>[];
}): (decorated: T) => T {
  return function(decorated: T) {
    async function runInPolicy(
      key: AsyncFunctionKeys<T>,
      ...args: any[]
    ): Promise<any> {
      return withPolicies(
        R.map(pFactory => pFactory(decorated), policyFactories),
        (<any>decorated[key]).bind(decorated, ...args),
      );
    }

    return new Proxy(decorated, {
      get(target: T, key: keyof T) {
        return function wrapper(...args: any[]) {
          if (!R.contains(key, forKeys)) {
            return (<any>target[key]).call(target, ...args);
          }
          return runInPolicy(<AsyncFunctionKeys<T>>key, ...args);
        };
      },
    });
  };
}
