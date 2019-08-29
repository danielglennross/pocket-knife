import { tuple } from '../../core/async';
import {
  ICache,
  PollerCacheOptions,
  PollerOptions,
  ILogger,
  HttResponse,
  IPoller,
  IManagedLifetime,
} from '../../domain/types';

export class Poller implements IPoller, IManagedLifetime {
  private description: string;
  private cache: ICache;
  private cacheOptions: PollerCacheOptions;
  private logger: ILogger;
  private interval: NodeJS.Timer;
  private fetchData: () => Promise<any>;

  constructor(options: PollerOptions) {
    const {
      description,
      cache,
      cacheOptions,
      requestOptions,
      logger,
      httpClient,
    } = options;

    this.cache = cache;
    this.cacheOptions = cacheOptions;
    this.logger = logger;
    this.description = description;
    this.interval = null;
    this.fetchData = async () => {
      const fetchRawData = async () => {
        const url = await requestOptions.getUrl();
        return httpClient.get(url, {
          headers: requestOptions.headers,
          timeout: requestOptions.timeout,
        });
      };
      const projectResult = (response: HttResponse) => {
        return requestOptions.project(response.data);
      };

      const data = await fetchRawData();
      return projectResult(data);
    };
  }

  async init() {
    try {
      await this.poll();
    } catch (e) {}
    this.interval = setInterval(() => this.poll(), this.cacheOptions.wait);
  }

  teardown() {
    this.interval = null;
    return Promise.resolve();
  }

  get<T>() {
    return this.cache.get<T>(this.cacheOptions.key);
  }

  private async poll() {
    const [data, pollErr] = await tuple<any, Error>(this.fetchData());
    if (pollErr) {
      this.logger.error(
        `failed to poll ${this.description} with err: ${pollErr.message}`,
        pollErr,
      );
      return;
    }
    const [, cacheSetErr] = await tuple<any, Error>(
      this.cache.set(this.cacheOptions.key, data),
    );
    if (cacheSetErr) {
      this.logger.error(
        `failed to set cache for poll ${this.description} with err: ${
          cacheSetErr.message
        }`,
        cacheSetErr,
      );
    }
  }
}
