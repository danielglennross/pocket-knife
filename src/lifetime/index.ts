import * as R from 'ramda';
import { newMutex, Mutex, waitGroup, WaitGroup } from '../sync';
import { AsyncFunctionKeys, CallingContext } from '../types';
import { createNullLogger } from '../logger';
import {
  UseTraceArgs,
  EvaluatedTraceArgs,
  evaluate,
  withTrace,
  useIdentityTraceArgs,
  useLogger,
  useLogLevel,
  useCallerContext,
  useMessage,
  useIgnoreError,
  useAppendToInfoLog,
  useAppendToErrorLog,
} from '../trace';

export type LifetimeOptions = {
  useTraceArgs?: UseTraceArgs;
};

export type LifetimeOperation = (options?: LifetimeOptions) => Promise<void>;

export function isManagedLifetime(object: any): object is IManagedLifetime {
  return R.all(k => k in object, ['init', 'teardown']);
}

export interface IManagedLifetime {
  init: LifetimeOperation;
  teardown: LifetimeOperation;
}

export function withManagedLifetime<T extends object>({
  setup,
  destroy,
  useTraceArgs = useIdentityTraceArgs,
  forKeys = [],
}: {
  setup: LifetimeOperation;
  destroy: LifetimeOperation;
  useTraceArgs?: UseTraceArgs;
  forKeys?: AsyncFunctionKeys<T>[];
}): (target: T) => IManagedLifetime & T {
  // only one context allowed in lifetimeLock closure at a time
  const lifetimeLock: Mutex = newMutex();
  // allow multiple concurrent calls to lifetime managed functions
  const wg: WaitGroup = waitGroup();

  let initialiseInFlight: Promise<void> = null;
  let teardownInFlight: Promise<void> = null;

  let currentInitialisingTraceArgs: EvaluatedTraceArgs = null;
  let currentTearingDownTraceArgs: EvaluatedTraceArgs = null;

  // tracing (bake in default args, then any provided override args)
  const useLoggingTracer = R.pipe(
    useLogger(createNullLogger()),
    useLogLevel('debug'),
    useTraceArgs,
  );

  const wrappedSetup = ({
    initialisingInternally = false,
    useTraceArgs = useIdentityTraceArgs,
  }: {
    initialisingInternally?: boolean;
    useTraceArgs?: UseTraceArgs;
  } = {}) => {
    currentInitialisingTraceArgs = evaluate(useTraceArgs);

    return lifetimeLock
      .lock(async () => {
        if (!initialisingInternally) {
          await withTrace(
            R.pipe(
              useMessage(
                '[wait for non-lifetime operations to complete] within [initialise] (withManagedLifetime)',
              ),
              useIgnoreError(),
              useTraceArgs,
              useLoggingTracer,
            ),
          )(() =>
            wg.wait({
              timeoutInMs: 30000,
              msg: 'initialise: wait for non-lifetime operations',
            }),
          );
        }

        try {
          await setup({ useTraceArgs });
        } catch (e) {
          initialiseInFlight = null;
          throw e;
        } finally {
          teardownInFlight = null;
        }
      })
      .finally(() => {
        currentInitialisingTraceArgs = null;
      });
  };

  const wrappedDestroy = ({
    useTraceArgs = useIdentityTraceArgs,
  }: {
    useTraceArgs?: UseTraceArgs;
  } = {}) => {
    currentTearingDownTraceArgs = evaluate(useTraceArgs);

    return lifetimeLock
      .lock(async () => {
        await withTrace(
          R.pipe(
            useMessage(
              '[wait for non-lifetime operations to complete] within [teardown] (withManagedLifetime)',
            ),
            useIgnoreError(),
            useLoggingTracer,
          ),
        )(() =>
          wg.wait({
            timeoutInMs: 30000,
            msg: 'teardown: wait for non-lifetime operations',
          }),
        );

        try {
          await destroy({ useTraceArgs });
        } catch {
          teardownInFlight = null;
          // don't throw, always safe
        } finally {
          initialiseInFlight = null;
        }
      })
      .finally(() => {
        currentTearingDownTraceArgs = null;
      });
  };

  const lifetime: IManagedLifetime = {
    init({ useTraceArgs }: { useTraceArgs?: UseTraceArgs } = {}): Promise<
      void
    > {
      return (
        initialiseInFlight ||
        (initialiseInFlight = wrappedSetup({
          useTraceArgs,
          initialisingInternally: false,
        }))
      );
    },
    teardown({ useTraceArgs }: { useTraceArgs?: UseTraceArgs } = {}): Promise<
      void
    > {
      return (
        teardownInFlight ||
        (teardownInFlight = wrappedDestroy({ useTraceArgs }))
      );
    },
  };

  const initInternal = (useTraceArgs: UseTraceArgs) => {
    return (
      initialiseInFlight ||
      (initialiseInFlight = wrappedSetup({
        useTraceArgs,
        initialisingInternally: true,
      }))
    );
  };

  const waitForLifetimeOperation = () => {
    return Promise.all([
      teardownInFlight || Promise.resolve(),
      initialiseInFlight || Promise.resolve(),
    ]);
  };

  const waitForLifetimeOperationLogData = (...args: any[]) => {
    const body = args[args.length - 1]; // body is always last param
    const currentInitialisingContext = (currentInitialisingTraceArgs || [])[2];
    const currentTearingDownContext = (currentTearingDownTraceArgs || [])[2];
    return {
      ...body,
      ...(currentInitialisingContext ? { currentInitialisingContext } : null),
      ...(currentTearingDownContext ? { currentTearingDownContext } : null),
    };
  };

  return function(original: T): IManagedLifetime & T {
    const decorated = R.reduce(
      (acc, [key, value]) => {
        return {
          ...acc,
          [key]: async (...args: any[]) => {
            const callingContext: CallingContext<T> = {
              target: original,
              key,
              args,
            };

            await withTrace(
              R.pipe(
                useMessage(
                  `[wait for lifetime operations to complete] before calling: [${key}] (withManagedLifetime)`,
                ),
                useAppendToInfoLog(waitForLifetimeOperationLogData),
                useAppendToErrorLog(waitForLifetimeOperationLogData),
                useCallerContext(callingContext),
                useLoggingTracer,
              ),
            )(() => waitForLifetimeOperation()); // if we're in a lifetime method, wait

            try {
              wg.add(1);
              await initInternal(useCallerContext(callingContext)); // always ensure target is initialised (early init may not have been called)
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

    // 'decorated' keys will override 'original' keys
    return {
      ...original,
      ...lifetime,
      ...decorated,
    };
  };
}

type ManagedLifetimeKeys = keyof IManagedLifetime;

export function withReinitialisingLifetime<T extends object>({
  forKeys,
  useTraceArgs = useIdentityTraceArgs,
  getSessionIdleTimeoutInMs = () => 0,
  getMaxRequestsPerSession = () => 0,
}: {
  forKeys: AsyncFunctionKeys<T>[];
  useTraceArgs?: UseTraceArgs;
  getSessionIdleTimeoutInMs?: () => number;
  getMaxRequestsPerSession?: () => number;
}): (decorated: IManagedLifetime & T) => IManagedLifetime & T {
  let requestCount: number = 0;
  let requestInFlightCount: number = 0;
  let timer: NodeJS.Timeout;

  // lock prevents race conditions where another request may evalute
  // guard expressions as true when a teardown & reset is already flight
  const teardownLock: Mutex = newMutex();

  const getLogData = (...args: any[]) => {
    const body = args[args.length - 1]; // body is always last param
    const maxRequestsPerSession = getMaxRequestsPerSession();
    const sessionIdleTimeoutInMs = getSessionIdleTimeoutInMs();
    return {
      ...body,
      ...(maxRequestsPerSession > 0 ? { requestCount } : null),
      requestInFlightCount,
      maxRequestsPerSession,
      sessionIdleTimeoutInMs,
    };
  };

  // tracing (bake in default args, then any provided override args)
  const useLoggingTracer = R.pipe(
    useLogger(createNullLogger()),
    useIgnoreError(),
    useLogLevel('debug'),
    useAppendToInfoLog(getLogData),
    useAppendToErrorLog(getLogData),
    useTraceArgs,
  );

  function resetRequestCount() {
    requestCount = 0;
  }

  return function(decorated: IManagedLifetime & T) {
    function onProcessing(_: LifetimeOptions): Promise<void> {
      ++requestInFlightCount;
      killTimeout();
      return Promise.resolve();
    }

    async function onProcessed(options: LifetimeOptions): Promise<void> {
      await teardownLock.lock(async () => {
        --requestInFlightCount;

        const maxRequestsPerSession = getMaxRequestsPerSession();
        // only inc requestCount if feature is enabled (maxRequestsPerSession > 0)
        if (
          maxRequestsPerSession > 0 &&
          ++requestCount > maxRequestsPerSession
        ) {
          await lifetime.teardown(options);
        } else if (requestInFlightCount === 0) {
          createTimeout(options);
        }
      });
    }

    function createTimeout(options: LifetimeOptions = {}): void {
      const sessionIdleTimeoutInMs = getSessionIdleTimeoutInMs();

      // only set timeout if feature is enabled (sessionIdleTimeoutInMs > 0)
      if (sessionIdleTimeoutInMs > 0) {
        timer = setTimeout(
          async (timeoutArgs: LifetimeOptions = {}) => {
            await teardownLock.lock(async () => {
              if (requestInFlightCount === 0) {
                await lifetime.teardown(timeoutArgs);
              }
            });
          },
          sessionIdleTimeoutInMs,
          options,
        );
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
      const callingContext: CallingContext<T> = {
        target: decorated,
        key,
        args,
      };

      const options: LifetimeOptions = {
        useTraceArgs: useCallerContext(callingContext),
      };

      const traceOnProcessing = () =>
        withTrace(
          R.pipe(
            useMessage(
              `call [onProcessing] before calling [${key}] (withReinitialisingLifetime)`,
            ),
            useCallerContext(callingContext),
            useLoggingTracer,
          ),
        )(() => onProcessing(options));

      const traceOnProcessed = () =>
        withTrace(
          R.pipe(
            useMessage(
              `call [onProcessed] after calling [${key}] (withReinitialisingLifetime)`,
            ),
            useCallerContext(callingContext),
            useLoggingTracer,
          ),
        )(() => onProcessed(options));

      try {
        await traceOnProcessing();
        return await (<any>decorated[key]).call(decorated, ...args);
      } finally {
        await traceOnProcessed();
      }
    }

    function keyIsLifetime(
      key: keyof (IManagedLifetime & T),
    ): key is ManagedLifetimeKeys {
      return key in lifetime;
    }

    const lifetime: IManagedLifetime = {
      async init(options: LifetimeOptions = {}) {
        resetRequestCount();
        // only on success, createTimeout
        await decorated.init(options);
        return createTimeout(options);
      },
      teardown(options: LifetimeOptions = {}) {
        // always reset
        return decorated.teardown(options).finally(() => {
          resetRequestCount();
          killTimeout();
        });
      },
    };

    return new Proxy(decorated, {
      get(target, key: keyof (IManagedLifetime & T)) {
        if (target[key] === void 0) {
          return target[key];
        }
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
