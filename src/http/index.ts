import * as Url from 'url';
import HttpProxyAgent from 'http-proxy-agent';
import { IncomingMessage } from 'http';
import HttpAgent, { HttpsAgent } from 'agentkeepalive';
import Boom from '@hapi/boom';
import Wreck from '@hapi/wreck';
import * as Hoek from '@hapi/hoek';
import * as R from 'ramda';

import { IManagedLifetime } from '../lifetime';
import { ILogger } from '../logger';
import { tuple, retryWithBackOff } from '../async';
import { parseJson } from '../formatting';

export function isInstrumentableHttpClient(
  httpClient: IHttpClient,
): httpClient is IInstrumentableHttpClient & IHttpClient {
  return 'httpClientProvider' in httpClient;
}

export interface IHttpClientEvents {
  onInitialised(httpClient: any): void;
}

export type HttpResponse = {
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

export interface IInstrumentableHttpClient {
  httpClientProvider: any;
}

export interface IHttpClient {
  get(url: string, options: HttpClientOptions): Promise<HttpResponse>;
  head(url: string, options: HttpClientOptions): Promise<HttpResponse>;
  options(url: string, options: HttpClientOptions): Promise<HttpResponse>;
  post(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttpResponse>;
  put(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttpResponse>;
  patch(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttpResponse>;
  delete(
    url: string,
    data: object,
    options: HttpClientOptions,
  ): Promise<HttpResponse>;
}

export type HttpClientFactory = () => IHttpClient;
export type DecoratedHttpClientFactory<T> = (
  httpClient: IHttpClient,
  options: T,
) => IHttpClient;

type BoomHttpErrorData = {
  code: string;
};

function toFormData(data: object) {
  return Object.entries(data)
    .map(([key, value]) => {
      return (
        encodeURIComponent(key) + '=' + encodeURIComponent(value.toString())
      );
    })
    .join('&');
}

function ensureBoomHttpError(error: Error, message: string) {
  if (Boom.isBoom(error)) {
    return error;
  }
  return Boom.boomify<unknown, BoomHttpErrorData>(error, {
    decorate: {
      code: (<any>error).code || 'unknown',
    },
    message: `${message}: ${error.message}`,
  });
}

export function createHttpClient({
  httpProxyEnabled,
  httpProxyAddress,
  events = {} as IHttpClientEvents,
}: {
  httpProxyEnabled: boolean;
  httpProxyAddress: string;
  events?: IHttpClientEvents;
}): IHttpClient & IInstrumentableHttpClient & IManagedLifetime {
  const agentDefaults = {
    maxSockets: Infinity,
    keepAlive: true,
    freeSocketTimeout: 30000,
  };

  const agents = httpProxyEnabled
    ? (() => {
        const proxyOptions = {
          ...agentDefaults,
          ...Url.parse(httpProxyAddress),
        };
        return {
          https: new HttpProxyAgent({ ...proxyOptions }),
          http: new HttpProxyAgent({ ...proxyOptions }),
          httpsAllowUnauthorized: new HttpProxyAgent({
            ...proxyOptions,
            rejectUnauthorized: false,
          }),
        };
      })()
    : {
        https: new HttpsAgent({ ...agentDefaults }),
        http: new HttpAgent({ ...agentDefaults }),
        httpsAllowUnauthorized: new HttpsAgent({
          ...agentDefaults,
          rejectUnauthorized: false,
        }),
      };

  // have to case to <any> as the type definition doesn't match the expected object
  // https://github.com/hapijs/wreck/blob/v15.0.0/lib/index.js#L33
  const httpInstance = Wreck.defaults(<any>{
    events: true,
    agents,
  });

  events.onInitialised = events.onInitialised || (() => {});

  async function httpRequest({
    method,
    url,
    data = null,
    options = {},
  }: {
    method: string;
    url: string;
    data?: object;
    options?: HttpClientOptions;
  }): Promise<HttpResponse> {
    options.headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...options.headers,
    };

    let requestOptions = <{ [key in string]: any }>{ ...options };
    if (data) {
      const isFormData = options.headers['content-type'].startsWith(
        'application/x-www-form-urlencoded',
      );
      requestOptions = {
        ...requestOptions,
        payload: isFormData ? toFormData(data) : JSON.stringify(data),
      };
    }

    const [incomingMessage, responseErr] = await tuple<IncomingMessage, Error>(
      httpInstance.request(method, url, requestOptions),
    );
    if (responseErr) {
      throw ensureBoomHttpError(
        responseErr,
        'Response not received for request',
      );
    }

    const [body, readErr] = await tuple<any, Error>(
      httpInstance.read(incomingMessage, {}),
    );
    if (readErr) {
      throw ensureBoomHttpError(readErr, 'Response not read for request');
    }

    return {
      data: body.length ? parseJson(body.toString()) : null,
      status: incomingMessage.statusCode,
      statusText: incomingMessage.statusMessage,
      headers: <{ [key in string]: string }>incomingMessage.headers,
      request: {
        headers: requestOptions.headers,
        method,
        url,
        data,
      },
    };
  }

  return <IHttpClient & IInstrumentableHttpClient & IManagedLifetime>{
    init() {
      events.onInitialised(this);
      return Promise.resolve();
    },
    teardown() {
      httpInstance.events.removeAllListeners();
      return Promise.resolve();
    },
    get httpClientProvider() {
      return httpInstance;
    },
    get(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return httpRequest({ method: 'get', url, options });
    },
    head(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return httpRequest({ method: 'head', url, options });
    },
    options(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return httpRequest({ method: 'options', url, options });
    },
    post(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return httpRequest({ method: 'post', url, data, options });
    },
    put(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return httpRequest({ method: 'put', url, data, options });
    },
    patch(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return httpRequest({ method: 'patch', url, data, options });
    },
    delete(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return httpRequest({ method: 'delete', url, data, options });
    },
  };
}

export function createLoggingHttpClient(
  httpClient: IHttpClient & IInstrumentableHttpClient & IManagedLifetime,
  options: { logger: ILogger },
): IHttpClient & IInstrumentableHttpClient & IManagedLifetime {
  const { logger } = options;

  async function loggingHttpRequest(
    httpCall: () => Promise<HttpResponse>,
    requestData: {
      url: string;
      options: HttpClientOptions;
      method: string;
      data?: any;
    },
  ): Promise<HttpResponse> {
    function routeDesc({ method, url }: { method: string; url: string }) {
      return `[${method.toUpperCase()}] ${url}`;
    }

    function buildBaseLogMeta(): object {
      const reqHeaders = requestData.options.headers || {};
      return {
        siteCode: reqHeaders['x-site-code'],
        correlationToken: reqHeaders['x-correlation-token'],
        request: {
          path: requestData.url,
          method: requestData.method.toUpperCase(),
          headers: requestData.options.headers,
          body: requestData.data,
        },
      };
    }

    function responseLogPayload(payload: object): object {
      const logMeta = Hoek.merge(payload, {
        duration: Date.now() - currTime,
        ...buildBaseLogMeta(),
      });
      return R.reject(R.isNil, logMeta);
    }

    const currTime = Date.now();

    logger.info(
      `Sending outbound request to: ${routeDesc(requestData)}`,
      buildBaseLogMeta(),
    );

    const [response, requestErr] = await tuple<HttpResponse, Error>(httpCall());
    if (requestErr) {
      logger.error(
        `Failed response from outbound request to: ${routeDesc(requestData)}`,
        responseLogPayload({
          details: requestErr.message,
        }),
      );
      throw requestErr;
    }

    const level = response && response.status < 400 ? 'info' : 'error';

    logger[level](
      `Received response from outbound request to: ${routeDesc(requestData)}`,
      responseLogPayload({
        request: {
          statusCode: response.status,
          statusText: response.statusText,
          responseHeaders: response.headers,
          responseBody: response.data,
        },
      }),
    );

    return response;
  }

  return <IHttpClient & IInstrumentableHttpClient & IManagedLifetime>{
    init() {
      return httpClient.init();
    },
    teardown() {
      return httpClient.teardown();
    },
    get httpClientProvider() {
      return httpClient.httpClientProvider;
    },
    get(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return loggingHttpRequest(() => httpClient.get(url, options), {
        url,
        options,
        method: 'GET',
      });
    },
    head(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return loggingHttpRequest(() => httpClient.head(url, options), {
        url,
        options,
        method: 'HEAD',
      });
    },
    options(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return loggingHttpRequest(() => httpClient.options(url, options), {
        url,
        options,
        method: 'OPTIONS',
      });
    },
    post(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return loggingHttpRequest(() => httpClient.post(url, data, options), {
        url,
        data,
        options,
        method: 'POST',
      });
    },
    put(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return loggingHttpRequest(() => httpClient.put(url, data, options), {
        url,
        data,
        options,
        method: 'PUT',
      });
    },
    patch(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return loggingHttpRequest(() => httpClient.patch(url, data, options), {
        url,
        data,
        options,
        method: 'PATCH',
      });
    },
    delete(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return loggingHttpRequest(() => httpClient.delete(url, data, options), {
        url,
        options,
        method: 'DELETE',
      });
    },
  };
}

export function createRetryingHttpClient(
  httpClient: IHttpClient & IInstrumentableHttpClient & IManagedLifetime,
  options?: { logger?: ILogger },
): IHttpClient & IInstrumentableHttpClient & IManagedLifetime {
  const { logger = null } = options || {};

  async function retryingHttpRequest(
    httpCall: () => Promise<HttpResponse>,
    requestData: {
      url: string;
      options: HttpClientOptions;
      method: string;
    },
  ): Promise<HttpResponse> {
    const retryErrorCodes = ['ECONNRESET'];

    function routeDesc({ method, url }: { method: string; url: string }) {
      return `[${method.toUpperCase()}] ${url}`;
    }

    function buildLogMeta(): object {
      const reqHeaders = requestData.options.headers || {};
      return {
        siteCode: reqHeaders['x-site-code'],
        correlationToken: reqHeaders['x-correlation-token'],
        request: {
          path: requestData.url,
          method: requestData.method.toUpperCase(),
        },
      };
    }

    return retryWithBackOff(httpCall, {
      shouldRetry: {
        when: (response: Error | HttpResponse) => {
          if (response instanceof Error && Boom.isBoom(response)) {
            return R.contains(
              (<BoomHttpErrorData>(<unknown>response)).code,
              retryErrorCodes,
            );
          }
          return false;
        },
        errMsg: (response: Error | HttpResponse) => {
          return `Outbound request to: ${routeDesc(
            requestData,
          )} failed too many times`;
        },
      },
      onFail: (_, retries: number) => {
        if (logger) {
          logger.error(
            `Outbound request to: ${routeDesc(
              requestData,
            )} failed on attempt ${retries}`,
            buildLogMeta(),
          );
        }
        return Promise.resolve();
      },
    });
  }

  return <IHttpClient & IInstrumentableHttpClient & IManagedLifetime>{
    init() {
      return httpClient.init();
    },
    teardown() {
      return httpClient.teardown();
    },
    get httpClientProvider() {
      return httpClient.httpClientProvider;
    },
    get(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return retryingHttpRequest(() => httpClient.get(url, options), {
        url,
        options,
        method: 'GET',
      });
    },
    head(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return retryingHttpRequest(() => httpClient.head(url, options), {
        url,
        options,
        method: 'HEAD',
      });
    },
    options(url: string, options: HttpClientOptions): Promise<HttpResponse> {
      return retryingHttpRequest(() => httpClient.options(url, options), {
        url,
        options,
        method: 'OPTIONS',
      });
    },
    post(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return retryingHttpRequest(() => httpClient.post(url, data, options), {
        url,
        options,
        method: 'POST',
      });
    },
    put(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return retryingHttpRequest(() => httpClient.put(url, data, options), {
        url,
        options,
        method: 'PUT',
      });
    },
    patch(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return retryingHttpRequest(() => httpClient.patch(url, data, options), {
        url,
        options,
        method: 'PATCH',
      });
    },
    delete(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttpResponse> {
      return retryingHttpRequest(() => httpClient.delete(url, data, options), {
        url,
        options,
        method: 'DELETE',
      });
    },
  };
}
