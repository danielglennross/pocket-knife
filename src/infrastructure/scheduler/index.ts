import * as R from 'ramda';
import IORedis from 'ioredis';
import Redlock from 'redlock';
import {
  IRedisClient,
  IDiagnosable,
  RedisClientPing,
  IScheduler,
  SchedulerOptions,
  ScheduledJob,
  IManagedLifetime,
} from '../../domain/types';
import { tupleWithPolicies, retryWithBackOff } from '../../core/async';

type SchedulerDebugInfo = {
  clientPing: RedisClientPing;
  subscriberPing: RedisClientPing;
};

export function createScheduler(
  options: SchedulerOptions,
): IScheduler & IDiagnosable<SchedulerDebugInfo> & IManagedLifetime {
  const { newRedisClient, logger, prefix } = options;

  let initialiseInFlight: Promise<void> = null;
  let redlock: Redlock;

  let clientWrapper: IRedisClient & IManagedLifetime;
  let subscriberWrapper: IRedisClient & IManagedLifetime;
  let client: IORedis.Redis;
  let subscriber: IORedis.Redis;

  let jobs: ScheduledJob[] = [];

  const getJobKey = (name: string): string => {
    return `${prefix}:work:${name}`;
  };

  const getLockKey = (name: string): string => {
    return `${prefix}:lock:${name}`;
  };

  const doWork = async (job: ScheduledJob): Promise<void> => {
    // this is a Bluebird Promise API not native Promise (cannot use async/await)
    return new Promise(resolve => {
      redlock.lock(getLockKey(job.name), 2000).then(
        lock => {
          return job
            .work()
            .catch(err => {
              logger.error(
                `Failed processing scheduled job: ${job.name} with error: ${
                  err.message
                }`,
                err,
              );
            })
            .finally(() => {
              return lock.unlock().then(() => resolve(), () => resolve());
            });
        },
        () => {
          // if we fail to get a lock, that means another instance already processed the job.
          resolve();
        },
      );
    });
  };

  const scheduleRun = async (job: ScheduledJob): Promise<void> => {
    await client.set(getJobKey(job.name), job.name, 'PX', job.interval, 'NX');
  };

  const destruct = async () => {
    try {
      await clientWrapper.teardown();
      await subscriberWrapper.teardown();
    } finally {
      initialiseInFlight = null;
    }
  };

  const setup = async () => {
    clientWrapper = newRedisClient();
    subscriberWrapper = newRedisClient();
    client = await clientWrapper.client();
    subscriber = await subscriberWrapper.client();
    redlock = new Redlock([client], { retryCount: 0 });

    const { db } = await subscriberWrapper.connection();
    subscriber.config('SET', 'notify-keyspace-events', 'Ex');
    subscriber.subscribe(`__keyevent@${db}__:expired`);
    subscriber.on('message', async (channel, message) => {
      // Check to make sure that the message is a job run request:
      if (!message.startsWith(`${prefix}:work:`)) {
        return;
      }

      const jobName = message.replace(`${prefix}:work:`, '');
      const job = R.find(R.propEq('name', jobName), jobs);

      if (!job) {
        logger.error(
          `Cannot process scheduled job: ${job.name}, no handler registered`,
        );
      }

      // Attempt to perform the job. Only one worker will end up getting assigned
      // the job thanks to distributed locking via redlock.
      await doWork(job);

      // Schedule the next run. We do this in every instance because it's
      // just a simple set command, and is okay to run on top of eachother.
      await tupleWithPolicies([retryWithBackOff], () => scheduleRun(job));
    });
  };

  return {
    async debugInfo() {
      const cPing = await clientWrapper.safePing();
      const sPing = await subscriberWrapper.safePing();
      return {
        clientPing: cPing,
        subscriberPing: sPing,
      };
    },
    healthCheck() {
      if (client && subscriber) {
        return Promise.resolve('initialised');
      }
      return Promise.reject('unititialised');
    },
    init() {
      return initialiseInFlight || (initialiseInFlight = setup());
    },
    teardown() {
      return destruct();
    },
    async schedule(job: ScheduledJob) {
      await this.init();
      jobs = R.unionWith(R.eqBy(R.prop('name')), [job], jobs);
      return scheduleRun(job);
    },
  };
}

export function createNullScheduler(): IScheduler & IManagedLifetime {
  return {
    init() {
      return Promise.resolve();
    },
    teardown() {
      return Promise.resolve();
    },
    schedule(job: ScheduledJob) {
      return Promise.resolve();
    },
  };
}
