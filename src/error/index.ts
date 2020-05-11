import * as R from 'ramda';
import { AsyncFunctionKeys } from '../types';

export class TargetError<T> extends Error {
  // private innerError so we include when calling toJSON
  constructor(private innerError: Error, data: T) {
    super(innerError.message);
    R.forEach(([k, v]) => {
      Object.defineProperty(this, k, {
        get: () => v,
      });
    }, Object.entries(data));
  }

  toJSON(): object {
    return (function write(error: Error) {
      return R.reduce(
        (acc, key: string) => {
          if (error[key] instanceof Error) {
            return { ...acc, [key]: write(error[key]) };
          }
          return { ...acc, [key]: error[key] };
        },
        {},
        R.sortBy(
          p => (R.includes(p, ['message', 'stack', 'innerError']) ? -1 : 0),
          Object.getOwnPropertyNames(error),
        ),
      );
    })(this);
  }
}

export function isTargetError<T>(
  err: Error,
  { expectedKeys = [] }: { expectedKeys?: (keyof T)[] } = {},
): err is TargetError<T> {
  return (
    err instanceof TargetError &&
    (R.isEmpty(expectedKeys) || R.all(k => k in err, expectedKeys))
  );
}

export function asTargetError<T>(
  err: Error,
  options?: { expectedKeys?: (keyof T)[] },
): T & TargetError<T> {
  if (!isTargetError(err, options)) {
    return null;
  }
  return <T & TargetError<T>>(<unknown>err);
}

export function withCleanErrorOperations<T extends object>({
  appendToError,
  forKeys,
}: {
  appendToError: <E extends Error>(error: E) => Record<string, any> | void;
  forKeys: AsyncFunctionKeys<T>[];
}): (decorated: T) => T {
  return function(decorated: T) {
    async function runInErrorHandler(
      key: AsyncFunctionKeys<T>,
      ...args: any[]
    ): Promise<any> {
      try {
        return await decorated[key as string].call(decorated, ...args);
      } catch (err) {
        const prop = value => ({ value, enumerable: true });
        const errProps = R.reduce(
          (acc, [k, v]) => {
            return { ...acc, [k]: prop(v) };
          },
          {
            stack: prop(err.stack),
          },
          Object.entries(appendToError(err) || {}),
        );

        throw Object.defineProperties(new Error(err.message), errProps);
      }
    }

    return new Proxy(decorated, {
      get(target: T, key: keyof T) {
        if (target[key] === void 0) {
          return target[key];
        }
        return function wrapper(...args: any[]) {
          if (!R.contains(key, forKeys)) {
            return (<any>target[key]).call(target, ...args);
          }
          return runInErrorHandler(<AsyncFunctionKeys<T>>key, ...args);
        };
      },
    });
  };
}
