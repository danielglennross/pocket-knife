import * as R from 'ramda';
import { timeout } from '../async';

export type Mutex = {
  lock<T = void>(fn: () => Promise<T>): Promise<T>;
};

export function newMutex(): Mutex {
  let callCount = 0;
  const deferredPromises: ((value?: unknown) => void)[] = [];

  const aquire = (): Promise<unknown> => {
    const wait =
      callCount === 0
        ? Promise.resolve()
        : new Promise(resolve => deferredPromises.push(resolve));
    ++callCount;
    return wait;
  };

  const release = (): void => {
    const pendingResolve = deferredPromises.shift();
    if (pendingResolve) {
      pendingResolve();
    }
    --callCount;
  };

  return {
    async lock<T = void>(fn: () => Promise<T>): Promise<T> {
      try {
        await aquire();
        return await fn();
      } finally {
        release();
      }
    },
  };
}

type PromiseResolve = (value?: void | PromiseLike<void>) => void;

export type WaitGroup = {
  add(count: number): void;
  done(): void;
  wait({
    msg,
    timeoutInMs,
  }: {
    msg: string;
    timeoutInMs: number;
  }): Promise<void>;
};

export function waitGroup(): WaitGroup {
  const awaitables: { promise: Promise<void>; resolve: PromiseResolve }[] = [];
  return {
    add(count: number): void {
      Array.from({ length: count }, () => {
        let res: PromiseResolve = null;
        const promise = new Promise<void>(resolve => {
          res = resolve;
        });
        awaitables.push({
          promise,
          resolve: res,
        });
      });
    },
    done(): void {
      if (awaitables.length === 0) {
        return;
      }
      const { resolve } = awaitables.splice(0, 1)[0];
      resolve();
    },
    wait({
      msg,
      timeoutInMs,
    }: {
      msg: string;
      timeoutInMs: number;
    }): Promise<void> {
      if (awaitables.length === 0) {
        return Promise.resolve();
      }
      const waitFnc = async () => {
        await Promise.all(R.map(({ promise }) => promise, awaitables));
      };
      return timeout<void>(waitFnc, { action: msg, timeoutInMs });
    },
  } as WaitGroup;
}
