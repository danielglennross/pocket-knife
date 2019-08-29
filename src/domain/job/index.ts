import * as R from 'ramda';
import {
  IJob,
  JobOptions,
  IJobFactory,
  IDomainJob,
  IManagedLifetime,
  JobStateOptions,
} from '../types';
import { guid } from '../../core/uuid';

export abstract class BaseJob<T> implements IDomainJob<T>, IManagedLifetime {
  private name: string;
  private jobFactory: IJobFactory;
  private job: IJob;
  private setup: () => Promise<void>;
  private onSetup: (() => Promise<void>)[];
  private initialiseInFlight: Promise<void>;

  constructor({ name, jobFactory }: { name: string; jobFactory: IJobFactory }) {
    this.name = name;
    this.jobFactory = jobFactory;
    this.job = null;
    this.initialiseInFlight = null;

    this.onSetup = [];
    this.setup = async () => {
      this.job = await this.jobFactory.createJob(
        this.name,
        this.work.bind(this),
      );
      await R.reduce(
        async (acc, s) => {
          await acc;
          return s();
        },
        Promise.resolve(),
        this.onSetup,
      );
    };
  }

  public abstract work(data: T): Promise<void>;

  public link<U>(job: BaseJob<U>): IDomainJob<T & U> {
    this.onSetup = [
      ...this.onSetup,
      async () => {
        const linkJob = await this.jobFactory.createJob(
          job.name,
          job.work.bind(job),
        );
        this.job.link(linkJob);
      },
    ];

    return this;
  }

  public async scheduleJob(data: T, jobOptions?: JobOptions): Promise<string> {
    await this.init();
    const id = guid();
    await this.job.createJob(id, data, jobOptions);
    return id;
  }

  public async getJobState(id: string | number, options?: JobStateOptions) {
    await this.init();
    return this.job.getJobState(id, options);
  }

  public async init() {
    return this.initialiseInFlight || (this.initialiseInFlight = this.setup());
  }

  public teardown() {
    this.job = null;
    return Promise.resolve();
  }
}
