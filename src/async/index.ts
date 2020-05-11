import * as R from 'ramda';
import { AsyncFunctionKeys, CallingContext } from '../types';

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

export type PromisePolicy<T = any> = (p: () => Promise<T>) => Promise<T>;

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
  if (R.anyPass([R.isNil, R.isEmpty])(decorators)) {
    decorators = [task => task()]; // identity decorator
  }

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

export class PolicyError extends Error {}

export * from './policies/bulkhead';
export * from './policies/circuitBreaker';
export * from './policies/retry';
export * from './policies/timeout';
