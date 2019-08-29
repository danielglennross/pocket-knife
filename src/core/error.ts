import * as R from 'ramda';

export class TargetError<T> extends Error {
  constructor(innerError: Error, data: T) {
    super(innerError.message);
    R.forEach(([k, v]) => {
      Object.defineProperty(this, k, {
        get: () => v,
      });
    }, Object.entries(data));
  }
}
