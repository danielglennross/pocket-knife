import * as R from 'ramda';
import IORedis from 'ioredis';
import Redlock from 'redlock';
import { TargetError } from '../error';
import { tuple, safe } from '../async';
import { IManagedLifetime, withManagedLifetime } from '../lifetime';
import { guid } from '../uuid';
import { IDiagnosable, HealthCheckStatus, Debug } from '../diagnosable';
import { useLogger, useCallerName } from '../trace';
import {
  Job,
  IQueueCleaner,
  QueueCleanerOptions,
  QueueCleanerDebugInfo,
  CleanableJobStatus,
} from '.';

type SuccessCleanResult = {
  code: 'success';
  status: CleanableJobStatus;
  count: number;
};
type FailedCleanResult = { code: 'failed'; status: CleanableJobStatus };
type CleanResult = FailedCleanResult | SuccessCleanResult;

type LoggingMeta = {
  category: string;
  correlationToken: string;
};

function buildLoggingMeta(): LoggingMeta {
  return {
    category: 'bff-framework:queue-cleaner',
    correlationToken: guid(),
  };
}

const logMessage = R.curry((queueName: string, msg: string) => {
  return `queue cleaner for queue: ${queueName} ${msg}`;
});

export function createNullQueueCleaner(): IManagedLifetime & IQueueCleaner {
  let isRunning = false;
  return {
    init() {
      isRunning = true;
      return Promise.resolve();
    },
    teardown() {
      isRunning = false;
      return Promise.resolve();
    },
    isRunning() {
      return isRunning;
    },
  };
}

export function createQueueCleaner({
  prefix,
  redisClient,
  queue,
  logger,
  getQueueCleanInterval,
  getQueueCleanBatchSize,
  getQueueCleanJobGracePeriod,
}: QueueCleanerOptions): IManagedLifetime &
  IQueueCleaner &
  IDiagnosable<QueueCleanerDebugInfo> {
  let redlock: Redlock;
  let client: IORedis.Redis;
  let diagnosticsEnabled: boolean = false;
  let interval: NodeJS.Timeout = null;

  const queueCleanerLastProcessedKey = `${prefix}:queueCleaner:${queue.name}`;
  const queueCleanerLockKey = `${prefix}:queueCleaner:${queue.name}:lock`;
  const logMessageForQueue = logMessage(queue.name);

  const setup = async () => {
    diagnosticsEnabled = true;

    client = await redisClient.client();
    redlock = new Redlock([client], { retryCount: 0 });
    setImmediate(async () => await safe(doWork()));
    interval = setInterval(async () => {
      await safe(doWork());
    }, getQueueCleanInterval());
  };

  const destroy = async () => {
    diagnosticsEnabled = false;

    // redisClient lifetime is externally owned
    if (interval) {
      clearTimeout(interval);
      interval = null;
    }
    redlock = null;
  };

  const doWork = async (): Promise<void> => {
    // this is a Bluebird Promise API not native Promise (cannot use async/await)
    return new Promise(resolve => {
      const loggingMeta = buildLoggingMeta();

      redlock.lock(queueCleanerLockKey, 2000).then(
        lock => {
          return removeFinishedJobs(loggingMeta)
            .catch(err => {
              logger.error(
                logMessageForQueue(
                  `failed processing with error: ${err.message}`,
                ),
                new TargetError<LoggingMeta>(err, loggingMeta),
              );
            })
            .finally(() => {
              return lock.unlock().then(
                () => resolve(),
                () => resolve(),
              );
            });
        },
        () => {
          // if we fail to get a lock, that means another instance already processed the job.
          resolve();
        },
      );
    });
  };

  const startCleaning = ({
    loggingMeta,
  }: {
    loggingMeta: LoggingMeta;
  }): Promise<CleanResult[]> => {
    logger.info(logMessageForQueue('checking for cleanable jobs'), loggingMeta);
    return Promise.all(
      R.map<CleanableJobStatus, Promise<CleanResult>>(
        async (status: CleanableJobStatus) => {
          const [jobs, err] = await tuple<Job<any>[], Error>(
            queue.clean(
              getQueueCleanJobGracePeriod(),
              status,
              getQueueCleanBatchSize(),
            ),
          );
          if (err) {
            return { code: 'failed', status };
          }
          return { code: 'success', status, count: jobs.length };
        },
        ['completed', 'failed'],
      ),
    );
  };

  const handleCleanResults = ({
    cleanResults,
    loggingMeta,
  }: {
    cleanResults: CleanResult[];
    loggingMeta: LoggingMeta;
  }): Promise<void> => {
    const printStatusForCode = (code: 'success' | 'failed') =>
      R.join(
        ', ',
        R.map(R.prop('status'), R.filter(R.propEq('code', code), cleanResults)),
      ).trim();
    const calcJobsCleaned = () =>
      R.sum(
        R.map<SuccessCleanResult, number>(
          R.propOr(0, 'count'),
          cleanResults as SuccessCleanResult[],
        ),
      );

    // all success
    if (R.all(R.propEq('code', 'success'), cleanResults)) {
      logger.info(
        logMessageForQueue(`was successful, removed ${calcJobsCleaned()} jobs`),
        loggingMeta,
      );
      return Promise.resolve();
    }

    // all fail
    if (R.all(R.propEq('code', 'failed'), cleanResults)) {
      logger.error(
        logMessageForQueue('failed for all job statuses'),
        loggingMeta,
      );
      return Promise.reject('cleaner failed');
    }

    // partial success
    const successful = printStatusForCode('success');
    const failed = printStatusForCode('failed');
    logger.error(
      logMessageForQueue(
        'was partially successful:\n' +
          `job statuses cleaned successfully: [${successful}]\n` +
          `job statuses failed to clean: [${failed}]\n` +
          `removed ${calcJobsCleaned()} jobs`,
      ),
      loggingMeta,
    );
    return Promise.reject('cleaner partial success');
  };

  const enoughTimeElapsedSinceLastProcessed = async ({
    loggingMeta,
  }: {
    loggingMeta: LoggingMeta;
  }) => {
    const queueLastProcessed = await client.get(queueCleanerLastProcessedKey);
    if (!queueLastProcessed) {
      logger.info(
        logMessageForQueue('last processed cannot be found. processing anyway'),
        loggingMeta,
      );
      return true;
    }
    const lastProcessedTimestamp = parseInt(queueLastProcessed, 10);
    const processingAllowedTimestamp = Date.now() - getQueueCleanInterval();
    const jitter = 3000;
    const canProcess =
      lastProcessedTimestamp < processingAllowedTimestamp + jitter;
    if (canProcess) {
      logger.info(logMessageForQueue('starting processing'), loggingMeta);
    } else {
      logger.info(
        logMessageForQueue('last processed is too soon, skipping cleaning'),
        loggingMeta,
      );
    }
    return canProcess;
  };

  const setLastProcessed = async ({
    loggingMeta,
  }: {
    loggingMeta: LoggingMeta;
  }) => {
    try {
      await client.set(queueCleanerLastProcessedKey, Date.now());
    } catch (e) {
      logger.error(
        logMessageForQueue('failed to set last processed date'),
        loggingMeta,
      );
      throw e;
    }
  };

  const removeFinishedJobs = async (
    loggingMeta: LoggingMeta,
  ): Promise<void> => {
    if (!(await enoughTimeElapsedSinceLastProcessed({ loggingMeta }))) {
      return;
    }
    const cleanResults = await startCleaning({ loggingMeta });
    await handleCleanResults({ cleanResults, loggingMeta });
    await setLastProcessed({ loggingMeta });
  };

  const queueCleaner: IQueueCleaner & IDiagnosable<QueueCleanerDebugInfo> = {
    async debugInfo(): Promise<Debug<QueueCleanerDebugInfo>> {
      if (!diagnosticsEnabled) {
        return 'disabled';
      }
      const clientPing = await redisClient.safePing();
      return {
        clientPing,
      };
    },
    healthCheck(): Promise<HealthCheckStatus> {
      if (!diagnosticsEnabled) {
        return Promise.resolve('uninitialised');
      }
      if (client) {
        return Promise.resolve('initialised');
      }
      return Promise.reject('failed');
    },
    isRunning(): boolean {
      return Boolean(interval);
    },
  };

  return withManagedLifetime<
    IQueueCleaner & IDiagnosable<QueueCleanerDebugInfo>
  >({
    setup,
    destroy,
    useTraceArgs: R.pipe(useLogger(logger), useCallerName('queueCleaner')),
  })(queueCleaner);
}
