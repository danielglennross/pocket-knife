import * as R from 'ramda';
import { safe } from '../async';
import { newMutex, Mutex, waitGroup, WaitGroup } from '../sync';
import { AsyncFunctionKeys } from '../types';
import { ILogger } from '../logger';
import { TargetError } from '../error';

const category = 'bff-framework:withManagedLifetime';

export function isManagedLifetime(object: any): object is IManagedLifetime {
  return R.all(k => k in object, ['init', 'teardown']);
}

export interface IManagedLifetime {
  init(): Promise<void>;
  teardown(): Promise<void>;
}

export function withManagedLifetime<T extends object>({
  setup,
  destroy,
  logger,
  forKeys = [],
}: {
  setup: () => Promise<void>;
  destroy: () => Promise<void>;
  logger?: ILogger;
  forKeys?: AsyncFunctionKeys<T>[];
}): (target: T) => IManagedLifetime & T {
  // only one context allowed in lifetimeLock closure at a time
  const lifetimeLock: Mutex = newMutex();
  // allow multiple concurrent calls to lifetime managed functions
  const wg: WaitGroup = waitGroup();

  let initialiseInFlight: Promise<void> = null;
  let teardownInFlight: Promise<void> = null;

  const wrappedSetup = ({
    initialisingInternally = false,
  }: {
    initialisingInternally?: boolean;
  } = {}) => {
    return lifetimeLock.lock(async () => {
      if (!initialisingInternally) {
        try {
          await wg.wait({ timeoutInMs: 60000 });
        } catch (err) {
          logger.error(
            'lifetime initialise: timeout waiting for lifetime managed actions to complete',
            new TargetError(err, { category }),
          );
        }
      }

      try {
        await setup();
      } catch (e) {
        initialiseInFlight = null;
        throw e;
      } finally {
        teardownInFlight = null;
      }
    });
  };

  const wrappedDestroy = () => {
    return lifetimeLock.lock(async () => {
      try {
        await wg.wait({ timeoutInMs: 60000 });
      } catch (err) {
        logger.error(
          'lifetime teardown: timeout waiting for lifetime managed actions to complete',
          new TargetError(err, { category }),
        );
      }

      try {
        await destroy();
      } catch {
        teardownInFlight = null;
      } finally {
        initialiseInFlight = null;
      }
    });
  };

  const lifetime: IManagedLifetime = {
    init(): Promise<void> {
      return initialiseInFlight || (initialiseInFlight = wrappedSetup());
    },
    teardown(): Promise<void> {
      return teardownInFlight || (teardownInFlight = wrappedDestroy());
    },
  };

  const initInternal = () => {
    return (
      initialiseInFlight ||
      (initialiseInFlight = wrappedSetup({ initialisingInternally: true }))
    );
  };

  const waitForLifetimeOperation = () => {
    return Promise.all([
      teardownInFlight || Promise.resolve(),
      initialiseInFlight || Promise.resolve(),
    ]);
  };

  return function(original: T): IManagedLifetime & T {
    const target = R.reduce(
      (acc, [key, value]) => {
        return {
          ...acc,
          [key]: async (...args: any[]) => {
            // if we're in a lifetime method, pause
            await waitForLifetimeOperation();

            try {
              wg.add(1);
              await initInternal(); // always ensure target is initialised (early init may not have been called)
              return await (<any>value).call(original, ...args);
            } finally {
              wg.done();
            }
          },
        };
      },
      <Partial<T>>{},
      R.filter(
        ([k]) => R.contains(k, <string[]>forKeys),
        Object.entries(original),
      ),
    );

    // 'target' keys will override 'original' keys
    return {
      ...original,
      ...lifetime,
      ...target,
    };
  };
}

export function withReinitialisingSession<T extends object>({
  forKeys,
  getSessionIdleTimeoutInMs = () => 0,
  getMaxRequestsPerSession = () => 0,
}: {
  forKeys: AsyncFunctionKeys<T>[];
  getSessionIdleTimeoutInMs?: () => number;
  getMaxRequestsPerSession?: () => number;
}): (
  decorated: IManagedLifetime & T,
) => IManagedLifetime & T {
  let requestCount: number = 0;
  let requestInFlightCount: number = 0;
  let timer: NodeJS.Timeout;

  function resetState() {
    requestCount = 0;
    requestInFlightCount = 0;
  }

  return function(decorated: IManagedLifetime & T) {
    function onProcessing(): Promise<void> {
      ++requestInFlightCount;
      killTimeout();
      return Promise.resolve();
    }

    async function onProcessed(): Promise<void> {
      --requestInFlightCount;

      const maxRequestsPerSession = getMaxRequestsPerSession();
      if (maxRequestsPerSession > 0 && ++requestCount > maxRequestsPerSession) {
        await lifetime.teardown();
      } else if (requestInFlightCount === 0) {
        createTimeout();
      }
    }

    function createTimeout(): void {
      const sessionIdleTimeoutInMs = getSessionIdleTimeoutInMs();
      if (sessionIdleTimeoutInMs > 0) {
        timer = setTimeout(async () => {
          if (requestInFlightCount === 0) {
            await lifetime.teardown();
          }
        }, sessionIdleTimeoutInMs);
      }
    }

    function killTimeout(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    async function runInSession(
      key: AsyncFunctionKeys<T>,
      ...args: any[]
    ): Promise<any> {
      try {
        await safe(onProcessing());
        return await (<any>decorated[key]).call(decorated, ...args);
      } finally {
        await safe(onProcessed());
      }
    }

    function keyIsLifetime(
      key: keyof (IManagedLifetime & T),
    ): key is keyof IManagedLifetime {
      return key in lifetime;
    }

    const lifetime: IManagedLifetime = {
      async init() {
        resetState();
        // only on success, createTimeout
        await decorated.init();
        return createTimeout();
      },
      teardown() {
        // always reset
        return decorated.teardown().finally(() => {
          resetState();
          killTimeout();
        });
      },
    };

    return new Proxy(decorated, {
      get(target, key: keyof (IManagedLifetime & T)) {
        return function wrapper(...args: any[]) {
          if (keyIsLifetime(key)) {
            return lifetime[key].call(lifetime, ...args);
          }
          if (!R.contains(key, forKeys)) {
            return (<any>target[key]).call(target, ...args);
          }
          return runInSession(<AsyncFunctionKeys<T>>key, ...args);
        };
      },
    });
  };
}
