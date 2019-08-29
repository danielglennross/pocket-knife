import * as R from 'ramda';
import Bull from 'bull';
import { safe, tuple } from '../../core/async';
import {
  ILogger,
  IJobFactory,
  JobOptions,
  JobQueueOptions,
  IJob,
  JobHandler,
  IDiagnosable,
  JobDebugInfo,
  IQueueProvider,
  JobLink,
  Job,
  JobState,
  JobStatus,
  IRedisClient,
  IQueueCleaner,
  IScheduler,
  JobMeta,
  IManagedLifetime,
  JobStateOptions,
  JobStateAuthorizeError,
} from '../../domain/types';
import { TargetError } from '../../core/error';

type BullJobState = JobState & {
  name: string;
  id: string | number;
  data: any;
  opts: any;
  returnvalue: any;
};

type JobFactoryDebugInfo = {
  jobCounts?: JobDebugInfo;
};

type RemoveableJob<T> = Job<T> & {
  finishedOn: number;
  attemptsMade: number;
  opts: {
    attempts: number;
  };
  remove(): Promise<void>;
};

interface IGetFinishedJobs {
  getCompleted(): Promise<any[]>;
  getFailed(): Promise<any[]>;
}

const propTruthy = R.curry((prop: string, object: any) => {
  return Boolean(object[prop]);
});

function isIGetFinishedJobs(object: any): object is IQueueProvider {
  return 'getFailed' in object && 'getCompleted' in object;
}

function buildJobId(id: string | number, jobName: string) {
  const uuid = id.toString().split(':')[0];
  return `${uuid}:${jobName}`;
}

function mapJobMeta(job: Job<any>): JobState & JobStatus {
  const { id, data, opts, returnvalue, ...rest } = job.toJSON() as BullJobState;

  const status = R.cond([
    [propTruthy('failedReason'), R.always('failed')],
    [propTruthy('finishedOn'), R.always('completed')],
    [propTruthy('processedOn'), R.always('processing')],
    [R.defaultTo, R.always('pending')],
  ])(rest);

  return {
    status,
    ...rest,
  };
}

export function createNullQueueCleaner(): IQueueCleaner {
  return {
    run() {
      return Promise.resolve();
    },
  };
}

export async function createQueueCleaner({
  queueCleanInterval,
  queueCleanBatchSize,
  scheduler,
  queue,
  logger,
}: {
  queueCleanInterval: number;
  queueCleanBatchSize: number;
  scheduler: IScheduler;
  queue: IQueueProvider;
  logger: ILogger;
}): Promise<IQueueCleaner> {
  if (!isIGetFinishedJobs(queue)) {
    throw new Error(
      'QueueProvider must implement IGetFinishedJobs to be used as a queue cleaner',
    );
  }

  const removeFinishedJobs = async () => {
    logger.debug(`checking for finished jobs`);

    const finishedJobsAwareQueue = <IGetFinishedJobs>(<unknown>queue);
    let [finished, fetchErr] = await tuple<RemoveableJob<any>[], Error>(
      R.flatten(
        await Promise.all([
          finishedJobsAwareQueue.getCompleted(),
          finishedJobsAwareQueue.getFailed(),
        ]),
      ),
    );

    if (fetchErr) {
      logger.error(
        `failed fetch finished jobs, will retry on next poll: ${
          fetchErr.message
        }`,
        fetchErr,
      );
      return;
    }

    const batch = R.take(queueCleanBatchSize, (finished = finished || []));
    logger.debug(
      `found: ${finished.length} finished jobs - attempting to remove: ${
        batch.length
      }`,
    );

    const jobRemovalTasks = R.pipe<
      RemoveableJob<any>[],
      RemoveableJob<any>[],
      Promise<void>[]
    >(
      R.filter<RemoveableJob<any>>(job => {
        // job either finished, or failed / stuck
        return (
          job &&
          (Boolean(job.finishedOn) || job.attemptsMade >= job.opts.attempts)
        );
      }),
      R.map(async job => {
        try {
          logger.debug(`found finished job ${job.id}`, job.data);
          await job.remove();
        } catch (err) {
          logger.error(
            `failed to remove finished job ${job.id}: ${err.message}`,
            new TargetError(err, job.data),
          );
        }
      }),
    )(batch);

    await Promise.all(jobRemovalTasks);
  };

  return {
    run(): Promise<void> {
      return scheduler.schedule({
        name: 'queueCleaner',
        interval: queueCleanInterval,
        work: removeFinishedJobs,
      });
    },
  };
}

export function createJobFactory(
  options: JobQueueOptions,
): IJobFactory & IDiagnosable<JobFactoryDebugInfo> & IManagedLifetime {
  let initialiseInFlight: Promise<void> = null;
  let queue: IQueueProvider = null;
  let cleaner: IQueueCleaner = null;
  const jobLinks = <JobLink[]>[];

  const events = options.events || {};
  const onInitialised = events.onInitialised || (() => {});
  const onTeardown = events.onTeardown || (() => {});

  const { logger, queueProviderFactory, queueCleanerFactory } = options;

  const destruct = async () => {
    if (queue) {
      await safe(queue.close());
      queue.removeAllListeners();
    }
    queue = null;
    cleaner = null;
    initialiseInFlight = null;
  };

  const setup = async () => {
    try {
      queue = await queueProviderFactory();
      await queue.isReady();

      queue
        .on('completed', async (job: Job<any>) => {
          logger.info(`Completed job ${job.id}`, job.data);
          const link = R.find(h => h.name === job.name, jobLinks);
          if (link) {
            const [, cbErr] = await tuple<void, Error>(
              link.action(<string>job.id, job.data),
            );
            if (cbErr) {
              logger.error(
                `failed emitting success callback for ${job.id}: ${
                  cbErr.message
                }`,
                new TargetError(cbErr, job.data),
              );
            }
          }
        })
        .on('failed', async (job: Job<any>, err: Error) => {
          logger.error(
            `Failed processing job ${job.id}: ${err.message}`,
            new TargetError(err, job.data),
          );
        });

      cleaner = await queueCleanerFactory(queue);
      await cleaner.run();

      onInitialised(queue.name);
    } catch (e) {
      await destruct();
      throw new Error(`failed with ${e.message}`);
    }
  };

  return {
    async debugInfo(): Promise<JobFactoryDebugInfo> {
      let defaultJobCounts: JobDebugInfo = {
        waiting: 'unknown',
        active: 'unknown',
        completed: 'unknown',
        failed: 'unknown',
        delayed: 'unknown',
      };
      return {
        jobCounts: await (queue
          ? queue.getJobCounts().catch(() => defaultJobCounts)
          : defaultJobCounts),
      };
    },
    healthCheck() {
      if (queue) {
        return Promise.resolve('initialised');
      }
      return Promise.reject('uninitialised');
    },
    async init(): Promise<void> {
      return initialiseInFlight || (initialiseInFlight = setup());
    },
    async teardown(): Promise<void> {
      await destruct();
      onTeardown();
    },
    async createJobChain(
      name: string,
      ...handlers: JobHandler[]
    ): Promise<IJob> {
      await this.init();

      const [firstHandler, ...otherHandlers] = handlers;

      let index = 0;
      let job: IJob, initJob: IJob;
      job = initJob = await this.createJob(`${name}-${index}`, firstHandler);

      R.forEach(async handler => {
        ++index;
        const newJob = await this.createJob(`${name}-${index}`, handler);
        job.link(newJob);
        job = newJob;
      }, otherHandlers);

      return initJob;
    },
    async createJob(name: string, handler: JobHandler): Promise<IJob> {
      await this.init();

      queue.process(name, async job => {
        logger.info(`Processing job ${job.id}`, job.data);
        await handler(job.data);
      });

      return {
        get name() {
          return name;
        },
        link(job: IJob) {
          jobLinks.push({
            name,
            action: async (id, data) => {
              return job.createJob(buildJobId(id, name), data);
            },
          });
        },
        async getJobState(
          jobId: string | number,
          {
            isJobAuthorizedForStateRetrieval = () => true,
          }: JobStateOptions = {},
        ): Promise<JobMeta | null> {
          const getAllJobs = async function(
            acc: Job<any>[],
            id: string | number,
          ) {
            const [job, err] = await tuple<Job<any>, Error>(queue.getJob(id));
            if (err) {
              throw new Error(`Failed to fetch job`);
            }
            if (!job) {
              return acc;
            }
            if (!isJobAuthorizedForStateRetrieval(job)) {
              throw new JobStateAuthorizeError(
                `Job not authorized for retrieval`,
              );
            }
            acc = [...acc, job];
            const nextLink = R.find(h => h.name === job.name, jobLinks);
            if (!nextLink) {
              return acc;
            }
            return getAllJobs(acc, buildJobId(id, job.name));
          };

          const jobs: Job<any>[] = await getAllJobs([], jobId);

          // job not found, send null
          if (!jobs.length) {
            return null;
          }

          // if the first found job exists in the jobLinks, we expect a job chain
          const expectedChain = R.pipe<
            ReadonlyArray<Job<any>>,
            Job<any>,
            string,
            boolean
          >(
            R.head,
            R.prop('name'),
            R.contains(R.__, R.map(R.prop('name'), jobLinks)),
          )(jobs);

          // not expected to be a job chain, send single job
          if (!expectedChain) {
            return { kind: 'job', ...mapJobMeta(jobs[0]) };
          }

          // expected to be a job chain
          const jobStateMeta = R.map(mapJobMeta, jobs);
          const aggregatedStatus = R.cond([
            [R.all(j => propTruthy('failedOn', j)), R.always('failed')],
            [R.all(j => propTruthy('finishedOn', j)), R.always('completed')],
            [
              R.any(j => propTruthy('failedOn', j)),
              R.always('partiallyFailed'),
            ],
            [R.any(j => propTruthy('processedOn', j)), R.always('processing')],
            [R.defaultTo, R.always('pending')],
          ])(jobStateMeta);
          return {
            kind: 'job-chain',
            status: aggregatedStatus,
            jobs: jobStateMeta,
          };
        },
        async createJob(
          id: string,
          data: any,
          jobOptions: JobOptions = <JobOptions>{},
        ): Promise<void> {
          const job = await queue.add(name, data, {
            jobId: id,
            backoff: { type: 'exponential', delay: 500 },
            removeOnComplete: false,
            removeOnFail: false,
            attempts: jobOptions.retries || 1,
            timeout: jobOptions.timeout || 30000,
          });
          logger.debug(`Created job ${job.id}`, job.data);
        },
      };
    },
  };
}

export async function createBullQueueProvider({
  name,
  prefix,
  newRedisClient,
}: {
  name: string;
  prefix: string;
  newRedisClient: () => IRedisClient & IManagedLifetime;
}): Promise<IQueueProvider & IGetFinishedJobs> {
  const [client, bClient, subscriber] = await Promise.all(
    R.map(c => c.client(), [
      newRedisClient(),
      newRedisClient(),
      newRedisClient(),
    ]),
  );

  return <Bull.Queue<any>>new Bull(name, {
    prefix,
    createClient: type => {
      switch (type) {
        case 'client':
          return client;
        case 'bclient':
          return bClient;
        case 'subscriber':
          return subscriber;
      }
    },
  });
}
