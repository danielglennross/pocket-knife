import { EventEmitter } from 'events';
import { ILogger } from '../logger';
import { IManagedLifetime } from '../lifetime';
import { IDiagnosable } from '../diagnosable';
import { RedisClientPing, IRedisClient } from '../store';

export function buildJobId(id: string | number, queueName: string): string {
  const uuid = id.toString().split(':')[0];
  return `${uuid}:${queueName}`;
}

export function isScheduableQueue(
  queue: IQueue,
): queue is IScheduableQueue & IQueue {
  return 'runScheduledCleaner' in queue;
}

export function isProviderAwareQueue<T>(
  queue: IQueue,
): queue is IProviderAwareQueue<T> & IQueue {
  return 'getStats' in queue && 'instrument' in queue;
}

export function isLinkableQueue(
  queue: IQueue,
): queue is ILinkableQueue & IQueue {
  return 'setNext' in queue && 'getNext' in queue && 'getLinkedJob' in queue;
}

export interface IScheduableQueue {
  runScheduledCleaner(): Promise<void>;
}

export interface IProviderAwareQueue<T> {
  getStats(): Promise<T>;
  instrument(
    action: (queueProvider: IQueueProvider<T>) => Promise<void>,
  ): Promise<void>;
}

export type OnProcessingOptions = {
  isCancellationRequested: boolean;
  updateJobProgress?: UpdateJobProgress;
  addJobLog?: AddJobLog;
};

export type OnProcessing<T> = (
  data: T,
  options: OnProcessingOptions,
) => Promise<void>;

export interface IQueueConsumer<T> {
  work: OnProcessing<T>;
}

export interface IQueueProducer<T> {
  createJob(
    data: T,
    jobOptions?: JobOptions,
    compositeJobId?: string,
  ): Promise<string>;
}

export interface ILinkableQueue {
  setNext(queue: ILinkableProducingQueue): void;
  getNext(): ILinkableProducingQueue;
  getNextJob: (compositeJobId: string | number) => Promise<Job<any>>;
}

export interface IQueue {
  readonly name: string;
  clean(grace: number, status?: string, limit?: number): Promise<Job<any>[]>;
  getJobCounts(): Promise<JobDebugInfo>;
  getJobs(
    status: string[],
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<Job<any>[]>;
}

export interface IQueueCleaner {
  isRunning(): boolean;
}

export type IBoardQueue = IQueue &
  ILinkableQueue &
  IProviderAwareQueue<Partial<RedisMetrics>>;

export type IQueueWithLifetime = IQueue & IManagedLifetime;

export type ILinkableProducingQueue = (IQueue | IQueueWithLifetime) &
  ILinkableQueue &
  IQueueProducer<any>;

export type Queue<T> = IQueue &
  IScheduableQueue &
  ILinkableQueue &
  IQueueProducer<T> &
  IQueueConsumer<T> &
  IProviderAwareQueue<Partial<RedisMetrics>>;

export type BaseQueueOptions<T> = {
  queueName: string;
  queueProviderFactory: QueueProviderFactory;
  queueCleanerFactory: QueueCleanerFactory;
  logger: ILogger;
  cleanQueueOnInitialise: boolean;
  getEnableProcessing(): boolean;
  getProcessingConcurrency(): number;
  events?: {
    onInitialised?: (queue: IQueue) => void;
    onTeardown?: (queue: IQueue) => void;
  };
};

export type QueueOptions<T> = {
  onProcessing: OnProcessing<T>;
  queueJobOptions: JobOptions;
} & BaseQueueOptions<T>;

export type QueueCleanerOptions = {
  prefix: string;
  redisClient: IRedisClient;
  queue: IQueue;
  logger: ILogger;
  getQueueCleanInterval(): number;
  getQueueCleanBatchSize(): number;
  getQueueCleanJobGracePeriod(): number;
};

export type IQueueProviderWithLifetime<T> = IQueueProvider<T> &
  IManagedLifetime;
export type QueueProviderFactory = <T>({
  queueName,
}: {
  queueName: string;
}) => Promise<IQueueProvider<T> | IQueueProviderWithLifetime<T>>;

export type IQueueCleanerWithLifetime = IQueueCleaner & IManagedLifetime;
export type QueueCleanerFactory = ({
  queue,
}: {
  queue: IQueue;
}) => (IQueueCleaner | IQueueCleanerWithLifetime) &
  IDiagnosable<QueueCleanerDebugInfo>;

export interface IQueueProvider<S> extends EventEmitter {
  readonly name: string;
  getStats(): Promise<S>;
  getJobCounts(): Promise<JobDebugInfo>;
  isReady(): Promise<any>;
  close(): Promise<void>;
  process(concurrency: number, callback: ProcessPromiseFunction<any>): void;
  getJob(jobId: number | string): Promise<Job<any>>;
  getJobLogs(
    jobId: string,
    start?: number,
    end?: number,
  ): Promise<{
    logs: string[];
    count: number;
  }>;
  getJobs(
    status: string[],
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<Job<any>[]>;
  add<T extends { jobId: string }>(data: any, options: T): Promise<Job<any>>;
  whenCurrentJobsFinished(): Promise<void>;
  clean(grace: number, status?: string, limit?: number): Promise<Job<any>[]>;
}

export interface IQueueRepository {
  getDataForQueues(queryParams: any): Promise<QueueData>;
  getQueues(): BoardQueues;
  getAggregateJobState(
    compositeJobId: string | number,
    options?: JobStateOptions,
  ): Promise<JobMeta | null>;
}

export type QueueDebugInfo = {
  queue: {
    jobCounts?: JobDebugInfo;
  };
  queueCleaner: QueueCleanerDebugInfo;
};

export type QueueCleanerDebugInfo = {
  clientPing: RedisClientPing;
};

export type ProcessPromiseFunction<T> = (job: Job<T>) => Promise<void>;

export const JobBoardStatuses = {
  latest: 'latest',
  active: 'active',
  waiting: 'waiting',
  completed: 'completed',
  failed: 'failed',
  delayed: 'delayed',
  paused: 'paused',
};

export type JobBoardStatus = keyof typeof JobBoardStatuses;

export type CleanableJobStatus = 'completed' | 'failed';

export type AggregateJobStatus = {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'partiallyFailed';
};

export type JobStateOpts = {
  delay?: number;
};

export type JobState = {
  id?: string;
  opts?: JobStateOpts;
  data?: any;
  name: string;
  progress: number;
  delay: number;
  timestamp: number;
  attemptsMade: number;
  failedReason: any;
  stacktrace: string[] | null;
  finishedOn: number | null;
  processedOn: number | null;
};

export type JobMeta =
  | ({ kind: 'job' } & JobState & AggregateJobStatus)
  | ({
      kind: 'job-chain';
      jobs: (JobState & AggregateJobStatus)[];
    } & AggregateJobStatus);

export type JobOpts = {
  delay?: number;
};

export type UpdateJobProgress = (progress: number) => Promise<void>;

export type AddJobLog = (log: string) => Promise<void>;

export type Job<T> = {
  id: string | number;
  data: T;
  attemptsMade: number;
  opts?: JobOpts;
  progress: UpdateJobProgress;
  log: AddJobLog;
  toJSON: () => JobState;
};

export type JobStateOptions = {
  isJobAuthorizedForStateRetrieval?: <T>(job: Job<T>) => Boolean;
};

export class JobStateAuthorizeError extends Error {
  constructor(...args: any[]) {
    super(...args);
  }
}

export type JobDebugInfo = {
  waiting: number | 'unknown';
  active: number | 'unknown';
  completed: number | 'unknown';
  failed: number | 'unknown';
  delayed: number | 'unknown';
};

export type JobOptions = {
  timeout?: number;
  retries?: number;
  omitJobDataPropsFromLogs?: string[];
};

export interface BoardQueues {
  [key: string]: IBoardQueue;
}

export interface RedisMetrics {
  total_system_memory: string;
  redis_version: string;
  used_memory: string;
  mem_fragmentation_ratio: string;
  connected_clients: string;
  blocked_clients: string;
}

export type MetricName = keyof RedisMetrics;

export interface AppJob {
  id: string | number | undefined;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  progress: number | object;
  attempts: number;
  failedReason: string;
  stacktrace: string[] | null;
  opts: any;
  data: any;
  name: string;
  delay: number | undefined;
}

export interface AppQueue {
  name: string;
  counts: Record<JobBoardStatus, number>;
  jobs: AppJob[];
}

export interface QueueData {
  stats: Partial<RedisMetrics>;
  queues: AppQueue[];
}

export * from './cleaner';
export * from './provider';
export * from './queue';
export * from './repository';
