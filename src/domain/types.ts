import IORedis from 'ioredis';
import { EventEmitter } from 'events';

/** LIFETIME **/

export interface IManagedLifetime {
  init(): Promise<void>;
  teardown(): Promise<void>;
}

/** DIAGNOSTICS **/

export type HealthCheck = {
  category: string;
  name: string;
  action: () => Promise<string | Object>;
};

export type DebugInfo<T> = {
  key: string;
  value: T;
};

export interface IDiagnosable<T = {}> {
  debugInfo?: () => Promise<T>;
  healthCheck?: () => Promise<string | Object>;
}

/** AUTH **/

export type TokenValidateSuccessResult = { isOk: true };
export type TokenValidateErrorResult = { isOk: false; message: string };
export type TokenValidateResult =
  | TokenValidateSuccessResult
  | TokenValidateErrorResult;

export type TokenVerifyOptions = {
  requiredScope: string;
  validateToken?: (tokenPayload: TokenPayload) => Promise<TokenValidateResult>;
};

export type TokenPayload = {
  sub?: string;
  nbf?: number;
  scope: ReadonlyArray<string>;
  client_id?: string;
};

export type TokenSignOptions = {
  header: object;
  expiresIn: number;
};

/** POLLER **/

export interface IPoller {
  get<T>(): Promise<T>;
}

export type CreatePoller = <T extends { cache: (opt: any) => ICache }>(
  server: T,
) => IPoller;

export type PollerCacheOptions = {
  key: string;
  wait: number;
};

export type PollerRequestOptions = {
  headers?: { [key in string]: string };
  timeout?: number;
  getUrl: () => Promise<string>;
  project: (data: any) => Promise<any>;
};

export type PollerOptions = {
  description: string;
  cache: ICache;
  cacheOptions: PollerCacheOptions;
  httpClient: IHttpClient;
  logger: ILogger;
  requestOptions: PollerRequestOptions;
};

/** HTTP **/

export type HttResponse = {
  data: object;
  status: number;
  statusText: string;
  headers: { [key in string]: string };
  request: {
    headers: { [key in string]: string };
    method: string;
    url: string;
    data: object;
  };
};

export type HttpClientOptions = {
  headers?: { [key in string]: string };
  timeout?: number;
};

export interface IHttpClient {
  get(url: string, options: HttpClientOptions): Promise<HttResponse>;
  head(url: string, options: HttpClientOptions): Promise<HttResponse>;
  options(url: string, options: HttpClientOptions): Promise<HttResponse>;
  post(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttResponse>;
  put(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttResponse>;
  patch(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttResponse>;
  delete(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttResponse>;
}

export type HttpClientFactory = () => IHttpClient;
export type DecoratedHttpClientFactory<T> = (
  httpClient: IHttpClient,
  options: T,
) => IHttpClient;

/** REDIS **/

export type ConnectionDetails = {
  host: string;
  port: number;
  db: number;
  password: string;
};

export type RedisClientPing = {
  pingResponse?: string;
  error?: Error;
  connection?: ConnectionDetails;
  clientStatus: string;
};

export interface IRedisClient {
  safePing(): Promise<RedisClientPing>;
  connection(): Promise<ConnectionDetails>;
  client(): Promise<IORedis.Redis>;
}

/** EVENTS **/

export interface IAppEventEmitter {
  emit(event: string, ...args: any): void;
  on(event: string, handler: (...args: any) => void): void;
}

export type AppEvent = {
  name: string;
  dependencies?: string[];
};

export type AppEventOptions = {
  events: AppEvent[];
};

/** LOGGER **/

export interface ILogger {
  error(msg: string, err: Error): void;
  error(msg: string, target?: any): void;
  warn(msg: string, target?: any): void;
  info(msg: string, target?: any): void;
  debug(msg: string, target?: any): void;
  verbose(msg: string, target?: any): void;
}

/** CACHE **/

export interface ICache {
  isReady(): boolean;
  get<T>(id: string): Promise<T>;
  set<T>(id: string, data: T, ttl?: number): Promise<void>;
  drop(id: string): Promise<void>;
}

export interface ICacheProvider {
  isReady(): boolean;
  cache: ICache;
  ttl: number;
  id: string;
}

/** CONNECTIONS **/

type RedisDetails =
  | { host: string; port: number }
  | (() => Promise<{ host: string; port: number }>);

export type RedisConnection = {
  details: RedisDetails;
  db: number;
  password: string;
};

/** JOBS **/

export type JobHandler = (data: any) => Promise<void>;

export interface IJobFactory {
  createJob(name: string, handler: JobHandler): Promise<IJob>;
  createJobChain(name: string, ...handlers: JobHandler[]): Promise<IJob>;
}

export interface IJob {
  name: string;
  link(job: IJob): void;
  createJob(id: string, data: any, jobOptions?: JobOptions): Promise<void>;
  getJobState(
    id: string | number,
    options?: JobStateOptions,
  ): Promise<JobMeta | null>;
}

export type JobQueueOptions = {
  queueProviderFactory: () => Promise<IQueueProvider>;
  queueCleanerFactory: (queue: IQueueProvider) => Promise<IQueueCleaner>;
  logger: ILogger;
  events?: {
    onInitialised?: (queueName: string) => void;
    onTeardown?: () => void;
  };
};

export interface IQueueCleaner {
  run(): Promise<void>;
}

export interface IQueueProvider extends EventEmitter {
  name: string;
  getJobCounts(): Promise<JobDebugInfo>;
  isReady(): Promise<any>;
  close(): Promise<void>;
  process(name: string, callback: ProcessPromiseFunction<any>): void;
  getJob(jobId: number | string): Promise<Job<any>>;
  add<T extends { jobId: string }, J extends Job<any>>(
    name: string,
    data: any,
    options: T,
  ): Promise<J>;
}

export type ProcessPromiseFunction<T> = (job: Job<T>) => Promise<void>;

export type JobStatus = {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'partiallyFailed';
};

export type JobState = {
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
  | ({ kind: 'job' } & JobState & JobStatus)
  | ({
      kind: 'job-chain';
      jobs: (JobState & JobStatus)[];
    } & JobStatus);

export type Job<T> = {
  id: string | number;
  name: string;
  data: T;
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

export type JobLink = {
  name: string;
  action: (id: string, data: any) => Promise<void>;
};

export type JobOptions = {
  timeout: number;
  retries: number;
};

/** DOMAIN JOB **/

export interface IDomainJob<T> {
  work: (data: T) => Promise<void>;
  scheduleJob(data: T, jobOptions?: JobOptions): Promise<string>;
  getJobState(
    id: string | number,
    options?: JobStateOptions,
  ): Promise<JobMeta | null>;
  link<U>(job: IDomainJob<U>): IDomainJob<T & U>;
}

/** SCHEDULER **/

export interface IScheduler {
  schedule(scheduledJob: ScheduledJob): Promise<void>;
}

export type SchedulerOptions = {
  prefix: string;
  logger: ILogger;
  newRedisClient: () => IRedisClient & IManagedLifetime;
};

export type ScheduledJob = {
  name: string;
  interval: number;
  work: () => Promise<void>;
};
