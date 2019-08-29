import { IncomingMessage } from 'http';
import Wreck from '@hapi/wreck';
import * as Hoek from '@hapi/hoek';
import * as R from 'ramda';
import HttpProxyAgent from 'http-proxy-agent';
import { tuple } from '../../core/async';
import { parseJson } from '../../core/formatting';
import {
  IHttpClient,
  HttpClientOptions,
  HttResponse,
  ILogger,
} from '../../domain/types';

export function createHttpClient({
  httpProxyEnabled,
  httpProxyAddress,
}: {
  httpProxyEnabled: boolean;
  httpProxyAddress: string;
}): IHttpClient {
  let options = <{ [key in string]: any }>{ events: true };

  if (httpProxyEnabled) {
    const agent = new HttpProxyAgent(httpProxyAddress);
    options = { ...options, agent };
  }

  const httpInstance = Wreck.defaults(options);

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
  }): Promise<HttResponse> {
    options.headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...options.headers,
    };

    let requestOptions = <{ [key in string]: any }>{ ...options };
    if (data) {
      requestOptions = { ...requestOptions, payload: JSON.stringify(data) };
    }

    const [incomingMessage, responseErr] = await tuple<IncomingMessage, Error>(
      httpInstance.request(method, url, requestOptions),
    );
    if (responseErr) {
      throw new Error(
        `Response not received for request: ${responseErr.message}`,
      );
    }

    const [body, readErr] = await tuple<any, Error>(
      httpInstance.read(incomingMessage, {}),
    );
    if (readErr) {
      throw new Error(`Response not read for request: ${readErr.message}`);
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

  return <IHttpClient>{
    get(url: string, options: HttpClientOptions): Promise<HttResponse> {
      return httpRequest({ method: 'get', url, options });
    },
    head(url: string, options: HttpClientOptions): Promise<HttResponse> {
      return httpRequest({ method: 'head', url, options });
    },
    options(url: string, options: HttpClientOptions): Promise<HttResponse> {
      return httpRequest({ method: 'options', url, options });
    },
    post(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttResponse> {
      return httpRequest({ method: 'post', url, data, options });
    },
    put(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttResponse> {
      return httpRequest({ method: 'put', url, data, options });
    },
    patch(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttResponse> {
      return httpRequest({ method: 'patch', url, data, options });
    },
    delete(
      url: string,
      data: object,
      options: HttpClientOptions,
    ): Promise<HttResponse> {
      return httpRequest({ method: 'delete', url, data, options });
    },
  };
}

class RequestError extends Error {
  constructor(
    message: string,
    public headers: { [key in string]: string },
    public statusCode: number,
    public data: any,
  ) {
    super(message);
  }
}

export function createLoggingHttpClient(
  httpClient: IHttpClient,
  options: { logger: ILogger },
): IHttpClient {
  const { logger } = options;

  async function loggingHttpRequest(
    httpCall: () => Promise<HttResponse>,
    requestData: {
      url: string;
      options: HttpClientOptions;
      method: string;
      data?: any;
    },
  ): Promise<HttResponse> {
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
      `Sending outbound request to: ${requestData.url}`,
      buildBaseLogMeta(),
    );

    const [response, requestErr] = await tuple<HttResponse, Error>(httpCall());
    if (requestErr) {
      logger.error(
        `Failed response from outbound request to: ${requestData.url}`,
        responseLogPayload({
          detail: requestErr.message,
        }),
      );
      throw requestErr;
    }

    const level = response && response.status < 400 ? 'info' : 'error';

    logger[level](
      `Received response from outbound request to: ${requestData.url}`,
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

  return <IHttpClient>{
    get(url: string, options: HttpClientOptions): Promise<HttResponse> {
      return loggingHttpRequest(() => httpClient.get(url, options), {
        url,
        options,
        method: 'GET',
      });
    },
    head(url: string, options: HttpClientOptions): Promise<HttResponse> {
      return loggingHttpRequest(() => httpClient.head(url, options), {
        url,
        options,
        method: 'HEAD',
      });
    },
    options(url: string, options: HttpClientOptions): Promise<HttResponse> {
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
    ): Promise<HttResponse> {
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
    ): Promise<HttResponse> {
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
    ): Promise<HttResponse> {
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
    ): Promise<HttResponse> {
      return loggingHttpRequest(() => httpClient.delete(url, data, options), {
        url,
        options,
        method: 'DELETE',
      });
    },
  };
}
