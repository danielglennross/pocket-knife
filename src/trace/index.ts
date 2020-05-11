import * as R from 'ramda';
import { AsyncFunctionKeys, CallingContext } from '../types';
import { TargetError } from '../error';
import { ILogger, LogLevel, createNullLogger } from '../logger';

export type Trace = (
  logger: ILogger,
  callerName: string,
  callerContext: CallingContext<any>,
  operationDesc: string,
  logInfo: <T = any>(
    callerContext?: CallingContext<T>,
    body?: Record<string, any>,
  ) => Record<string, any>,
  logError: <E extends Error, T = any>(
    err: E,
    callerContext?: CallingContext<T>,
    body?: Record<string, any>,
  ) => Record<string, any>,
  logLevel: LogLevel,
  ignoreError: boolean,
) => Promise<any>;

function getCleanResult<T>(value: T): T {
  const truncateString = R.curry((n, s) => `${s.substring(0, n)}...`);
  const scrubValue = v => `<scrubbed ${typeof v}>`;
  return R.cond([
    // if nil, just transfer it
    [R.isNil, R.identity],
    [
      // if simple primitive, use
      R.anyPass([R.is(Boolean), R.is(Number), R.is(BigInt), R.is(Date)]),
      R.toString,
    ],
    [
      // if string, truncate
      R.is(String),
      R.ifElse(R.pipe(R.length, R.gt(500)), truncateString(500), R.identity),
    ],
    // scrub anything complicated
    [R.defaultTo, scrubValue],
  ])(value);
}

async function trace(
  action: () => Promise<any> = () => Promise.resolve(),
  logger: ILogger = createNullLogger(),
  callerName: string = '<unknown caller>',
  callerContext: CallingContext<any> = null,
  operationDesc: string = '<unknown operation>',
  logInfo: <T = any>(
    callerContext?: CallingContext<T>,
    body?: Record<string, any>,
  ) => Record<string, any> = () => null,
  logError: <E extends Error, T = any>(
    err: E,
    callerContext?: CallingContext<T>,
    body?: Record<string, any>,
  ) => Record<string, any> = () => null,
  logLevel: LogLevel = 'debug',
  ignoreError: boolean = false,
): Promise<any> {
  const start = Date.now();
  const suffix =
    callerContext && callerContext.key
      ? `(called as part of flow: ${callerContext.key.toString()})`
      : '';
  const expandedMessage = `${operationDesc} ${suffix}`.trim();
  try {
    const logInfoBody = logInfo(callerContext);
    logger[logLevel](
      `${callerName}: attempting to ${operationDesc}`,
      logInfoBody,
    );

    const result = await action();
    const cleanResult = getCleanResult(result);

    logger[logLevel](`${callerName}: successful ${expandedMessage}`, {
      duration: Date.now() - start,
      ...(!R.isNil(cleanResult) ? { result: cleanResult } : null),
      ...logInfoBody,
    });

    return result;
  } catch (err) {
    // re-define errors, as some may have lots of additional noise (that callers can choose to pick)
    const innerError = Object.defineProperty(new Error(err.message), 'stack', {
      get: () => err.stack,
    });

    logger.error(
      `${callerName}: failed to ${expandedMessage}`,
      new TargetError(innerError, {
        duration: Date.now() - start,
        ...logError(err, callerContext),
      }),
    );

    if (!ignoreError) {
      throw err;
    }
  }
}

// higher order exp, designed to assign parametes as part of a pipline/ composition
export type UseTraceArgs = (args: Parameters<Trace>) => Parameters<Trace>;

export type EvaluatedTraceArgs = Parameters<Trace>;

export function evaluate(argBuilder: UseTraceArgs): EvaluatedTraceArgs {
  return argBuilder(<Parameters<Trace>>(<unknown>[]));
}

export function withTrace<T>(argBuilder: UseTraceArgs) {
  return (action: () => Promise<T>) => {
    const args = argBuilder(<Parameters<Trace>>(<unknown>[]));
    return trace.apply(trace, [action, ...args]);
  };
}

export function useIdentityTraceArgs(args: Parameters<Trace>) {
  return args;
}

export function useLogger(logger: ILogger) {
  return (args: Parameters<Trace>) => ((args[0] = logger), args);
}

export function useCallerName(name: string) {
  return (args: Parameters<Trace>) => ((args[1] = name), args);
}

export function useCallerContext<T>(callerContext: CallingContext<T>) {
  return (args: Parameters<Trace>) => ((args[2] = callerContext), args);
}

export function useMessage(message: string) {
  return (args: Parameters<Trace>) => ((args[3] = message), args);
}

export function useAppendToInfoLog(
  logBody: <T = any>(
    callerContext?: CallingContext<T>,
    body?: Record<string, any>,
  ) => Record<string, any>,
) {
  return (args: Parameters<Trace>) => {
    const previous = args[4] || (() => null);
    args[4] = <T = any>(
      callerContext?: CallingContext<T>,
      body?: Record<string, any>,
    ) => {
      const previousBody = previous(callerContext, body);
      return { ...logBody(callerContext, previousBody) };
    };
    return args;
  };
}

export function useAppendToErrorLog<E extends Error>(
  logBody: <T = any>(
    err: E,
    callerContext?: CallingContext<T>,
    body?: Record<string, any>,
  ) => Record<string, any>,
) {
  return (args: Parameters<Trace>) => {
    const previous = args[5] || (() => null);
    args[5] = <T = any>(
      err: Error,
      callerContext?: CallingContext<T>,
      body?: Record<string, any>,
    ) => {
      const previousBody = previous(err, callerContext, body);
      return {
        ...logBody(err as E, callerContext, previousBody),
      };
    };
    return args;
  };
}

export function useLogLevel(level: LogLevel) {
  return (args: Parameters<Trace>) => ((args[6] = level), args);
}

export function useIgnoreError() {
  return (args: Parameters<Trace>) => ((args[7] = true), args);
}

export function withTracing<T extends object>({
  useTraceArgs = useIdentityTraceArgs,
  forKeys = [],
  ignoreLoggingArgsforKeys = [],
}: {
  useTraceArgs?: UseTraceArgs;
  forKeys?: AsyncFunctionKeys<T>[];
  ignoreLoggingArgsforKeys?: AsyncFunctionKeys<T>[];
}) {
  return function(original: T): T {
    function getCleanArgs(args: any[]) {
      return R.reduce(
        (acc, arg) => {
          const cleanArg = getCleanResult(arg);
          return { ...acc, [`arg${R.indexOf(arg, args)}`]: cleanArg };
        },
        {} as Record<string, string>,
        args,
      );
    }
    function getLogData(key: keyof T) {
      return (...args: any[]) => {
        const body = args[args.length - 1]; // body is always last param
        const cleanArgs = !R.contains(key, ignoreLoggingArgsforKeys)
          ? getCleanArgs(args)
          : null;
        return {
          ...body,
          ...cleanArgs,
          key,
        };
      };
    }
    function trace(key: keyof T, ...args: any[]) {
      const callingContext: CallingContext<T> = {
        target: original,
        key,
        args,
      };

      return withTrace(
        R.pipe(
          useMessage(`call [${key}] (withTracing)`),
          useCallerContext(callingContext),
          useAppendToInfoLog(getLogData(key)),
          useAppendToErrorLog(getLogData(key)),
          useTraceArgs,
        ),
      )(() => original[key as string].apply(original, args));
    }

    const decorated = R.reduce(
      (acc, key: keyof T) => ({
        ...acc,
        [key]: trace.bind(trace, key),
      }),
      <Partial<T>>{},
      forKeys,
    );

    // 'decorated' keys will override 'original' keys
    return {
      ...original,
      ...decorated,
    };
  };
}
