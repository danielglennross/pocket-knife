import * as R from 'ramda';

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
