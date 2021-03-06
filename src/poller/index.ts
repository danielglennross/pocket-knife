import * as R from 'ramda';
import { tuple } from '../async';
import { IManagedLifetime, withManagedLifetime } from '../lifetime';
import { ICache } from '../cache';
import { ILogger } from '../logger';
import { HttpResponse, IHttpClient } from '../http';
import { useLogger, useCallerName } from '../trace';

export interface IPoller {
  readonly name: string;
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
  name: string;
  cache: ICache;
  cacheOptions: PollerCacheOptions;
  httpClient: IHttpClient;
  logger: ILogger;
  requestOptions: PollerRequestOptions;
};

export function createPoller(
  options: PollerOptions,
): IPoller & IManagedLifetime {
  const {
    name,
    cache,
    cacheOptions,
    requestOptions,
    logger,
    httpClient,
  } = options;

  let interval: NodeJS.Timer = null;

  const poll = async () => {
    const [data, pollErr] = await tuple<any, Error>(fetchData());
    if (pollErr) {
      logger.error(
        `failed to poll ${name} with err: ${pollErr.message}`,
        pollErr,
      );
      return;
    }
    const [, cacheSetErr] = await tuple<any, Error>(
      cache.set(cacheOptions.key, data),
    );
    if (cacheSetErr) {
      logger.error(
        `failed to set cache for poll ${name} with err: ${cacheSetErr.message}`,
        cacheSetErr,
      );
    }
  };

  const fetchData = async (): Promise<any> => {
    const fetchRawData = async () => {
      const url = await requestOptions.getUrl();
      return httpClient.get(url, {
        headers: requestOptions.headers,
        timeout: requestOptions.timeout,
      });
    };
    const projectResult = (response: HttpResponse) => {
      return requestOptions.project(response.data);
    };

    const data = await fetchRawData();
    return projectResult(data);
  };

  const setup = async () => {
    try {
      await poll();
    } catch (e) {}
    interval = setInterval(() => poll(), cacheOptions.wait);
  };

  const destroy = () => {
    clearTimeout(interval);
    interval = null;
    return Promise.resolve();
  };

  const poller: IPoller = {
    name,
    get<T>() {
      return cache.get<T>(cacheOptions.key);
    },
  };

  return withManagedLifetime<IPoller>({
    setup,
    destroy,
    forKeys: ['get'],
    useTraceArgs: R.pipe(useLogger(logger), useCallerName(poller.name)),
  })(poller);
}
