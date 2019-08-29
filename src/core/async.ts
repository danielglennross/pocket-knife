import * as R from 'ramda';

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
  get stack() {
    return this.error.stack;
  }
  get message() {
    return this.error.message;
  }
  get name() {
    return this.error.name;
  }
}

export async function retryWithBackOff<T = any>(
  func: () => Promise<T>,
  { retries = 3, delay = 300 }: { retries?: number; delay?: number } = {},
): Promise<T> {
  try {
    const result = await func();
    return result;
  } catch (e) {
    if (retries <= 1) {
      throw new RetryError(e instanceof Error ? e : new Error(e.toString()));
    }
    await new Promise(res => setTimeout(res, delay));
    return retryWithBackOff(func, { retries: --retries, delay: delay * 2 });
  }
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

type PromiseDecorators = <T = any>(p: () => Promise<T>) => Promise<T>;

// effectively builds up a chain of decorators like:
//
// const [d1, d2] = decorators;
// return tasks.map(task => {
//   return d2(() => {
//     return d1(task);
//   });
// });
export function tupleWithPolicies(
  decorators: PromiseDecorators[],
  ...tasks: (() => Promise<any>)[]
) {
  const [firstDecorator, ...otherDecorators] = decorators;
  return tuple(
    Promise.all(
      R.map(task => {
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
      }, tasks),
    ),
  );
}
