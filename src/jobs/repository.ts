import * as R from 'ramda';
import {
  buildJobId,
  IQueue,
  IBoardQueue,
  JobStateOptions,
  JobMeta,
  Job,
  IQueueRepository,
  BoardQueues,
  AppJob,
  AppQueue,
  JobBoardStatus,
  QueueData,
  JobStatus,
  JobState,
  JobReport,
  JobStateAuthorizeError,
  ILinkableQueue,
} from '.';
import { ILogger } from '../logger';
import { tuple } from '../async';

const truthy = (prop: string) => (object: object) => Boolean(object[prop]);
const statusIs = R.propEq('status');
const attemptsMadeIs = R.propEq('attemptsMade');

export class QueueRepository implements IQueueRepository {
  private queues: IBoardQueue[];
  private logger: ILogger;

  constructor({ queues, logger }: { queues: IBoardQueue[]; logger: ILogger }) {
    this.queues = queues;
    this.logger = logger;
  }

  private formatJob(job: Job<any>): AppJob {
    const jobProps = job.toJSON();

    return {
      id: jobProps.id,
      timestamp: jobProps.timestamp,
      processedOn: jobProps.processedOn,
      finishedOn: jobProps.finishedOn,
      progress: jobProps.progress,
      attempts: jobProps.attemptsMade,
      delay: job.opts.delay,
      failedReason: jobProps.failedReason,
      stacktrace: jobProps.stacktrace,
      opts: jobProps.opts,
      data: jobProps.data,
      name: jobProps.name,
    };
  }

  private mapJobMeta(job: Job<any>): JobState {
    const {
      id,
      data,
      opts: { attempts },
      name,
      returnvalue,
      ...rest
    } = job.toJSON() as JobMeta;

    // only failed, when attempts == attemptsMade
    const status = R.cond([
      [
        R.allPass([truthy('failedReason'), attemptsMadeIs(attempts)]),
        R.always('failed'),
      ],
      [truthy('finishedOn'), R.always('completed')],
      [truthy('processedOn'), R.always('processing')],
      [R.defaultTo, R.always('pending')],
    ])(rest);

    return {
      status,
      attempts,
      ...rest,
    };
  }

  async getDataForQueues(queryParams: any): Promise<QueueData> {
    const query = queryParams || {};
    const boardQueues = this.getQueues();
    const pairs = Object.entries(boardQueues);

    if (R.isEmpty(pairs)) {
      return {
        stats: {},
        queues: [],
      };
    }

    const statuses: JobBoardStatus[] = [
      'active',
      'completed',
      'delayed',
      'failed',
      'paused',
      'waiting',
    ];

    const queues: AppQueue[] = await Promise.all(
      R.map(async ([name, queue]) => {
        const counts = await queue.getJobCounts();
        const status =
          query[name] === 'latest' ? statuses : [<string>query[name]];
        const jobs = await queue.getJobs(status, 0, 10);

        return {
          name,
          counts: counts as Record<JobBoardStatus, number>,
          jobs: R.map(this.formatJob, jobs),
        };
      }, pairs),
    );

    const queue = pairs[0][1];
    const stats = await queue.getStats();

    return {
      stats,
      queues,
    };
  }

  getQueues(): BoardQueues {
    return R.reduce(
      (acc, queue) => {
        acc[queue.name] = queue;
        return acc;
      },
      {} as BoardQueues,
      this.queues,
    );
  }

  async getAggregateJobState(
    compositeJobId: string | number,
    options?: JobStateOptions,
  ): Promise<JobReport> {
    const [jobId, queueName] = (<string>compositeJobId).split(':');
    const queue = R.find<IBoardQueue>(R.propEq('name', queueName), this.queues);
    if (!queue) {
      this.logger.error(
        `queue: ${queueName ||
          '<unknown>'} associated with job: ${jobId} is not registered for inspection`,
      );
      return null;
    }

    const isJobAuthorizedForStateRetrieval =
      options.isJobAuthorizedForStateRetrieval || (() => true);

    const rec = async (
      states: JobState[],
      queue: IQueue & ILinkableQueue,
    ): Promise<JobState[]> => {
      const compositeJobId = buildJobId(jobId, queue.name);
      const [job, err] = await tuple<Job<any>, Error>(
        queue.getNextJob(compositeJobId),
      );
      if (err) {
        throw new Error(`failed to fetch job`);
      }
      if (!job) {
        return states;
      }
      if (!isJobAuthorizedForStateRetrieval(job)) {
        throw new JobStateAuthorizeError(`Job not authorized for retrieval`);
      }
      const state = this.mapJobMeta(job);
      states = [...states, state];
      const linkedQueue = queue.getNext();
      if (linkedQueue) {
        return rec(states, linkedQueue);
      }
      return states;
    };
    const states = await rec([], queue);

    if (states.length === 0) {
      return null;
    }
    if (states.length === 1) {
      return { kind: 'job', ...states[0] };
    }

    const aggregatedStatus = R.cond([
      [R.all(statusIs('failed')), R.always('failed')],
      [R.all(statusIs('completed')), R.always('completed')],
      [R.any(statusIs('failed')), R.always('partiallyFailed')],
      [R.any(statusIs('processing')), R.always('processing')],
      [R.defaultTo, R.always('pending')],
    ])(states);

    return {
      kind: 'job-chain',
      status: aggregatedStatus,
      jobs: states,
    };
  }
}
