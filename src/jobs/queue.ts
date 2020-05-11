import * as R from 'ramda';
import PCancelable from 'p-cancelable';
import pTimeout from 'p-timeout';
import {
  buildJobId,
  JobOptions,
  JobDebugInfo,
  IQueueProvider,
  Job,
  QueueOptions,
  ILinkableProducingQueue,
  Queue,
  IQueue,
  IQueueCleaner,
  QueueCleanerDebugInfo,
  QueueDebugInfo,
  RedisMetrics,
  OnProcessingOptions,
} from '.';
import {
  IManagedLifetime,
  isManagedLifetime,
  withManagedLifetime,
} from '../lifetime';
import { TargetError } from '../error';
import { safe, timeout, tuple } from '../async';
import { guid } from '../uuid';
import {
  IDiagnosable,
  NamedHealthCheckStatus,
  HealthCheckStatus,
  Debug,
  NamedDebug,
} from '../diagnosable';
import { useLogger, useCallerName } from '../trace';

function getLoggableJobData<
  ET extends { jobOptions: { omitJobDataPropsFromLogs?: string[] } }
>(job: Job<ET>, props?: Record<string, any>): Record<string, any> {
  const omitKeys = job.data.jobOptions.omitJobDataPropsFromLogs || [];
  return <Record<string, any>>{ ...R.omit(omitKeys, job.data), ...props };
}

const logMessage = R.curry((queueName: string, msg: string) => {
  return `queue: ${queueName} ${msg}`;
});

const defaultJobOptions: JobOptions = {
  retries: 3,
  timeout: 30000,
  omitJobDataPropsFromLogs: [],
};

const evaluateJobOptions = (jobOptions: JobOptions) => {
  return R.reject(R.isNil, {
    retries: Number.isInteger(jobOptions.retries as number)
      ? jobOptions.retries
      : ((jobOptions.retries as () => number) || (() => null))(),
    timeout: Number.isInteger(jobOptions.timeout as number)
      ? jobOptions.timeout
      : ((jobOptions.timeout as () => number) || (() => null))(),
    omitJobDataPropsFromLogs: jobOptions.omitJobDataPropsFromLogs,
  }) as {
    retries: number;
    timeout: number;
    omitJobDataPropsFromLogs: string[];
  };
};

export function createQueue<
  T, // data managed by queue
  ET extends T & { jobOptions: JobOptions } = T & { jobOptions: JobOptions } // extended data created when creatingJob
>({
  queueName,
  queueJobOptions,
  onProcessing,
  getEnableProcessing,
  getProcessingConcurrency,
  queueProviderFactory,
  queueCleanerFactory,
  logger,
  cleanQueueOnInitialise,
  events,
}: QueueOptions<T>): Queue<T> &
  IDiagnosable<QueueDebugInfo> &
  IManagedLifetime {
  let provider: IQueueProvider<Partial<RedisMetrics>> = null;
  let cleaner: IQueueCleaner & IDiagnosable<QueueCleanerDebugInfo> = null;
  let linkedQueue: ILinkableProducingQueue = null;
  let diagnosticsEnabled: boolean = false;

  let onInitialised = (events || {}).onInitialised || (() => {});
  let onTeardown = (events || {}).onTeardown || (() => {});
  let logMessageForQueue = logMessage(queueName);

  const disconnect = async () => {
    if (cleaner && cleaner.isRunning() && isManagedLifetime(cleaner)) {
      await safe(cleaner.teardown());
    }
    if (linkedQueue && isManagedLifetime(linkedQueue)) {
      await safe(linkedQueue.teardown());
    }
    if (provider) {
      onTeardown(queue);
      await safe(
        timeout(() => provider.whenCurrentJobsFinished(), {
          action: 'teardown queue provider',
          timeoutInMs: 3000,
        }),
      );
      await safe(provider.close());
      provider.removeAllListeners();
      if (isManagedLifetime(provider)) {
        await safe(provider.teardown());
      }
    }
  };

  const setup = async () => {
    diagnosticsEnabled = true;

    const handleCompletedJob = async (job: Job<ET>) => {
      logger.info(
        logMessageForQueue(`completed job ${job.id}`),
        getLoggableJobData(job, { logs: await getJobLogs(job) }),
      );
      if (linkedQueue) {
        const [, cbErr] = await tuple<string, Error>(
          linkedQueue.createJob(
            job.data,
            job.data.jobOptions,
            buildJobId(job.id, linkedQueue.name),
          ),
        );
        if (cbErr) {
          logger.error(
            logMessageForQueue(
              `failed emitting success callback for ${job.id}: ${cbErr.message}`,
            ),
            new TargetError(cbErr, getLoggableJobData(job)),
          );
        }
      }
    };

    const handleFailedJob = async (job: Job<ET>, err: Error) => {
      logger.error(
        logMessageForQueue(`failed processing job ${job.id}: ${err.message}`),
        new TargetError(
          err,
          getLoggableJobData(job, { logs: await getJobLogs(job) }),
        ),
      );
    };

    const updateJobProgress = (job: Job<any>) => async (
      progress: number,
    ): Promise<void> => {
      try {
        return await job.progress(progress);
      } catch (err) {
        return logger.error(
          logMessageForQueue(
            `failed to update progress for job ${job.id}: ${err.message}`,
          ),
          new TargetError(err, getLoggableJobData(job)),
        );
      }
    };

    const addJobLog = (job: Job<any>) => {
      const attempts = job.attemptsMade;
      return async function(log: string): Promise<void> {
        try {
          return await job.log(`attempt ${attempts}: ${log}`);
        } catch (err) {
          return logger.error(
            logMessageForQueue(
              `failed to add log for job ${job.id}: ${err.message}`,
            ),
            new TargetError(err, getLoggableJobData(job)),
          );
        }
      };
    };

    const getJobLogs = async (job: Job<any>): Promise<string[] | Error> => {
      try {
        const jobLogs = await provider.getJobLogs(<string>job.id);
        return jobLogs.logs;
      } catch (err) {
        return err;
      }
    };

    const processJobWithTimeout = (job: Job<any>) => {
      logger.info(
        logMessageForQueue(`processing job ${job.id}`),
        getLoggableJobData(job),
      );

      return pTimeout<void>(
        new PCancelable(async (resolve, reject, onCancel) => {
          const options: OnProcessingOptions = {
            isCancellationRequested: false,
            updateJobProgress: updateJobProgress(job),
            addJobLog: addJobLog(job),
          };

          onCancel(() => {
            options.isCancellationRequested = true;
            logger.error(
              logMessageForQueue(`cancelling job ${job.id}`),
              getLoggableJobData(job),
            );
          });

          try {
            await queue.work(job.data, options);
            resolve();
          } catch (e) {
            reject(e);
          }
        }),
        job.data.jobOptions.timeout,
      );
    };

    try {
      provider = await queueProviderFactory({
        queueName: queueName,
      });
      if (isManagedLifetime(provider)) {
        await provider.init();
      }
      await provider.isReady();

      if (getEnableProcessing()) {
        provider.process(getProcessingConcurrency(), processJobWithTimeout);
      }

      provider
        .on('completed', handleCompletedJob)
        .on('failed', handleFailedJob);

      cleaner = queueCleanerFactory({
        queue: queue,
      });
      if (cleanQueueOnInitialise && isManagedLifetime(cleaner)) {
        await cleaner.init();
      }
      if (linkedQueue && isManagedLifetime(linkedQueue)) {
        await linkedQueue.init();
      }
      onInitialised(queue);
    } catch (e) {
      await disconnect();
      throw new TargetError(e, {
        details: `failed initialising job with ${e.message}`,
      });
    }
  };

  const destroy = async () => {
    diagnosticsEnabled = false;

    try {
      await disconnect();
    } catch {
      /* nothing we can do */
    } finally {
      provider = null;
      cleaner = null;
    }
  };

  const queue: Queue<T> & IDiagnosable<QueueDebugInfo> = {
    work(data: T, options: OnProcessingOptions): Promise<void> {
      return onProcessing.call(this, data, options);
    },

    async debugInfo(): Promise<
      Debug<QueueDebugInfo> | NamedDebug<QueueDebugInfo>
    > {
      if (!diagnosticsEnabled) {
        return 'disabled';
      }
      const queueCleanerDebugInfo = <Debug<QueueCleanerDebugInfo>>(
        await cleaner.debugInfo()
      );
      const jobCounts = await this.getJobCounts();
      return { queue: { jobCounts }, queueCleaner: queueCleanerDebugInfo };
    },

    async healthCheck(): Promise<HealthCheckStatus | NamedHealthCheckStatus> {
      if (!diagnosticsEnabled) {
        return 'uninitialised';
      }
      if (!provider) {
        throw 'failed';
      }
      const queueCleanerHealthCheck = <HealthCheckStatus>(
        await cleaner.healthCheck()
      );
      return { queue: 'initialised', queueCleaner: queueCleanerHealthCheck };
    },

    async getJobCounts(): Promise<JobDebugInfo> {
      const defaultJobCounts: JobDebugInfo = {
        waiting: 'unknown',
        active: 'unknown',
        completed: 'unknown',
        failed: 'unknown',
        delayed: 'unknown',
      };
      const jobCounts = await (provider
        ? provider.getJobCounts().catch(() => defaultJobCounts)
        : defaultJobCounts);

      return jobCounts;
    },

    get name() {
      return queueName;
    },

    setNext(queue) {
      linkedQueue = queue;
    },

    getNext() {
      return linkedQueue;
    },

    getNextJob(jobId: string | number) {
      return provider.getJob(jobId);
    },

    async runScheduledCleaner(): Promise<void> {
      if (isManagedLifetime(cleaner)) {
        await cleaner.init();
      }
    },

    async clean(grace: number, status?: string, limit?: number) {
      return provider.clean(grace, status, limit);
    },

    async createJob(
      data: T,
      jobOptions: JobOptions = {},
      compositeJobId?: string,
    ): Promise<string> {
      const { retries, timeout, omitJobDataPropsFromLogs } = R.pipe(
        R.mergeRight(evaluateJobOptions(queueJobOptions)),
        R.mergeRight(evaluateJobOptions(defaultJobOptions)),
      )(evaluateJobOptions(jobOptions));

      const extendedData = {
        ...data,
        jobOptions: {
          retries,
          timeout,
          omitJobDataPropsFromLogs,
        },
      } as ET;

      const jobId = compositeJobId || buildJobId(guid(), provider.name);

      const job = await provider.add(extendedData, {
        jobId,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: false,
        removeOnFail: false,
        attempts: retries,
        // omit timeout:
        // provider (bull) timeouts do not cancel promises
        // we'll use our own mechanism when processing the job
      });

      logger.info(
        logMessageForQueue(`created job ${job.id}`),
        getLoggableJobData(job),
      );

      return <string>job.id;
    },

    async getJobs(
      status: string[],
      start?: number,
      end?: number,
      asc?: boolean,
    ): Promise<Job<any>[]> {
      return provider.getJobs(status, start, end, asc);
    },

    async instrument(
      action: (
        queueProvider: IQueueProvider<Partial<RedisMetrics>>,
      ) => Promise<void>,
    ): Promise<void> {
      return action(provider);
    },

    async getStats(): Promise<Partial<RedisMetrics>> {
      return provider.getStats();
    },
  };

  return withManagedLifetime<Queue<T> & IDiagnosable<QueueDebugInfo>>({
    setup,
    destroy,
    forKeys: [
      'clean',
      'createJob',
      'getJobCounts',
      'getJobs',
      'getStats',
      'instrument',
      'runScheduledCleaner',
      'work',
    ],
    useTraceArgs: R.pipe(useLogger(logger), useCallerName(queue.name)),
  })(queue);
}

type DecoratedPartialFunctionsFor<T> = {
  [key in keyof Partial<T>]: (
    base: T, // first arg, is base target (what we're decorating)
    ...args: any[] // function args
  ) => T[key] extends (...args: any) => any ? ReturnType<T[key]> : never; // only allow types where T[key] is a function
};

export function withDecoratedQueue<T extends IQueue>(
  decorations: DecoratedPartialFunctionsFor<T>,
) {
  const forKeys = Object.keys(decorations);
  return function(original: T): T {
    const decorated = R.reduce(
      (acc, key) => ({
        ...acc,
        [key]: decorations[key].bind(decorations, original),
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
