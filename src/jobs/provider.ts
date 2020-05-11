import * as R from 'ramda';
import IORedis from 'ioredis';
import Bull from 'bull';
import { EventEmitter } from 'events';
import { parse as parseRedisInfo } from 'redis-info';
import { parseJson } from '../formatting';
import { IRedisClient } from '../store';
import {
  ProcessPromiseFunction,
  JobDebugInfo,
  RedisMetrics,
  IQueueProvider,
  Job,
  JobMeta,
  MetricName,
} from '.';
import { IManagedLifetime } from '../lifetime';

type PropertiesForType<T> = {
  [key in keyof T]: { value: T[key] };
};

type ExtendedJob = Job<any> & JobMeta & { _progress: number; _logs: string[] };

const toLowerSafe = R.pipe(R.defaultTo(''), R.toLower);

const property = R.curry((prop: string, source: any) =>
  R.pipe(R.prop(prop), toLowerSafe)(source),
);

export const propMatchesOneOf = R.curry(
  <T>(prop: string, values: string[], source: ReadonlyArray<T>) => {
    return R.filter(s =>
      R.contains(property(prop, s), R.map(toLowerSafe, values)),
    )(<[]>source);
  },
);

export class NonDistributedQueueProvider extends EventEmitter
  implements IQueueProvider<unknown> {
  private jobDebugInfo: JobDebugInfo;
  private handler: ProcessPromiseFunction<any>;
  private jobs: ExtendedJob[];

  constructor(private queueName: string) {
    super();
    this.initState();
  }
  getJobs(
    status: string[],
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<Job<any>[]> {
    const job = <Job<any>>{};
    return Promise.resolve([job]);
  }
  get name() {
    return this.queueName;
  }
  getJobCounts() {
    return Promise.resolve(this.jobDebugInfo);
  }
  getStats(): Promise<unknown> {
    return Promise.resolve({});
  }
  isReady() {
    return Promise.resolve(this);
  }
  close() {
    this.initState();
    return Promise.resolve();
  }
  clean(grace: number, status?: string, limit?: number) {
    return Promise.resolve([]);
  }
  whenCurrentJobsFinished() {
    return Promise.resolve();
  }
  process(concurrency: number, callback: ProcessPromiseFunction<any>) {
    this.handler = callback;
  }
  getJob(jobId: string | number): Promise<Job<any>> {
    const job = R.find<ExtendedJob>(R.propEq('id', jobId), this.jobs);
    return Promise.resolve(job);
  }
  getJobLogs(
    jobId: string,
    start?: number,
    end?: number,
  ): Promise<{
    logs: string[];
    count: number;
  }> {
    const job = R.find<ExtendedJob>(R.propEq('id', jobId), this.jobs);
    return Promise.resolve({
      logs: job._logs,
      count: job._logs.length,
    });
  }
  async add<T extends { jobId: string }>(data: any, options: T) {
    const job = <ExtendedJob>{
      _progress: 0,
      _logs: [],
      id: options.jobId,
      name: this.queueName,
      opts: {
        delay: 500,
        attempts: 1,
      },
      returnvalue: null,
      data: JSON.stringify(data),
      delay: 0,
      timestamp: Date.now(),
      attemptsMade: 0,
      failedReason: null,
      stacktrace: null,
      finishedOn: null,
      processedOn: null,
      progress: function(progress: number) {
        this._progress = progress;
        return Promise.resolve();
      },
      log: function(log: string) {
        this._logs = [...this._logs, log];
        return Promise.resolve();
      },
      toJSON: function() {
        return {
          progress: this._progress,
          delay: this.delay,
          timestamp: this.timestamp,
          attemptsMade: this.attemptsMade,
          failedReason: this.failedReason,
          stacktrace: this.stacktrace,
          finishedOn: this.finishedOn,
          processedOn: this.processedOn,
        };
      },
    };
    this.jobs = [...this.jobs, job];
    await this.jobAdded(job);
    return job;
  }
  private initState() {
    this.jobDebugInfo = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };
    this.handler = null;
    this.jobs = [];
  }
  private async jobAdded(job: Job<any> & JobMeta) {
    if (!this.handler) {
      throw new Error(`no handler provided for processor: ${job.name}`);
    }
    try {
      job.data = parseJson(job.data);
      ++job.attemptsMade;
      job.processedOn = Date.now();
      ++(<number>this.jobDebugInfo.active);
      await this.handler(job);
      ++(<number>this.jobDebugInfo.completed);
      const { id, data } = job;
      this.emit('completed', { id, data }, 'ok');
    } catch (e) {
      job.stacktrace = e.stacktrace;
      job.failedReason = e.message;
      ++(<number>this.jobDebugInfo.failed);
      const { id, data } = job;
      this.emit('failed', { id, data }, e);
    } finally {
      job.finishedOn = Date.now();
      --(<number>this.jobDebugInfo.active);
    }
  }
}

export async function createBullQueueProvider({
  queueName,
  prefix,
  redis: { client, subscriber, bClient },
}: {
  queueName: string;
  prefix: string;
  redis: {
    client: IRedisClient & IManagedLifetime;
    subscriber: IRedisClient & IManagedLifetime;
    bClient: IRedisClient & IManagedLifetime;
  };
}): Promise<IQueueProvider<Partial<RedisMetrics>> & IManagedLifetime> {
  const metrics: MetricName[] = [
    'redis_version',
    'used_memory',
    'mem_fragmentation_ratio',
    'connected_clients',
    'blocked_clients',
  ];

  const init = () => {
    return Promise.all([client.init(), bClient.init(), subscriber.init()]);
  };

  const teardown = () => {
    return Promise.all([
      client.teardown(),
      bClient.teardown(),
      subscriber.teardown(),
    ]);
  };

  const getStats = async (bull: Bull.Queue) => {
    const redisClient: IORedis.Redis = bull.client;
    const redisInfoRaw = await redisClient.info();
    const redisInfo = parseRedisInfo(redisInfoRaw);
    const redisMetrics = R.reduce(
      (acc, metric) => {
        if (redisInfo[metric]) {
          acc[metric] = redisInfo[metric];
        }
        return acc;
      },
      {} as Record<MetricName, string>,
      metrics,
    );
    // eslint-disable-next-line @typescript-eslint/camelcase
    redisMetrics.total_system_memory =
      redisInfo.total_system_memory || redisInfo.maxmemory;
    return redisMetrics;
  };

  const iorClient = await client.client();
  const iorBClient = await bClient.client();
  const iorSubscriber = await subscriber.client();

  const bull = new Bull(queueName, {
    prefix,
    createClient: type => {
      switch (type) {
        case 'client':
          return iorClient;
        case 'bclient':
          return iorBClient;
        case 'subscriber':
          return iorSubscriber;
      }
    },
  }) as Bull.Queue<any>;

  const lifetimeProperties: PropertiesForType<IManagedLifetime> = {
    init: {
      value: async function() {
        await init();
      },
    },
    teardown: {
      value: async function() {
        await teardown();
      },
    },
  };

  const additionalProviderProperties: PropertiesForType<Partial<
    IQueueProvider<Partial<RedisMetrics>>
  >> = {
    getStats: {
      value: function() {
        return getStats(bull);
      },
    },
  };

  return Object.defineProperties(bull, {
    ...lifetimeProperties,
    ...additionalProviderProperties,
  }) as IQueueProvider<Partial<RedisMetrics>> & IManagedLifetime;
}

export function createNonDistributedQueueProvider({
  queueName,
}: {
  queueName: string;
}): Promise<IQueueProvider<unknown>> {
  return Promise.resolve(new NonDistributedQueueProvider(queueName));
}
