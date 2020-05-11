import * as R from 'ramda';
import IORedis from 'ioredis';
import { IManagedLifetime, withManagedLifetime } from '../lifetime';
import { tuple } from '../async';
import { useCallerName } from '../trace';

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

type RedisDetails =
  | { host: string; port: number }
  | (() => Promise<{ host: string; port: number }>);

export type RedisConnection = {
  details: RedisDetails;
  db: number;
  password: string;
};

type RedisClientOptions = {
  connectionFactory: () => Promise<ConnectionDetails>;
};

export function createRedisClient(
  options: RedisClientOptions,
): IRedisClient & IManagedLifetime {
  let client: IORedis.Redis;
  let details: ConnectionDetails;

  const connectionDetails = () => {
    return details;
  };

  const disconnect = async (errorListener?: (...args: any[]) => void) => {
    try {
      if (client) {
        if (errorListener) {
          client.removeListener('error', errorListener);
        }
        client.disconnect();
      }
    } catch (e) {
    } finally {
      client = null;
    }
  };

  const destroy = async () => {
    await disconnect();
  };

  const setup = async () => {
    return new Promise<void>(async (resolve, reject) => {
      const errorListener = async (e: Error) => {
        disconnect(errorListener);
        reject(
          new Error(`redis client handled error on initialise: ${e.message}`),
        );
      };

      try {
        details = await options.connectionFactory();
        client = new IORedis({
          host: details.host,
          port: details.port,
          db: details.db,
          password: details.password,
          enableReadyCheck: true,
          retryStrategy: times => {
            return Math.min(Math.exp(times), 20000);
          },
          reconnectOnError: err => {
            if (R.contains('READONLY', R.toUpper(err.message))) {
              // When a slave is promoted, we might get temporary errors saying
              // READONLY You can't write against a read only slave. Attempt to
              // reconnect if this happens.
              return 2; // `1` means reconnect, `2` means reconnect and resend
            }
            return false;
          },
        });
      } catch (e) {
        disconnect(errorListener);
        throw new Error(`redis client failed to initialise: ${e.message}`);
      }

      client.on('error', errorListener);

      client.on('ready', () => {
        // ioredis may autoreconnect at a future point.
        // If so, error events will be emitted which we dont want to handle anymore.
        // Our listener here deals with initial setup only.
        // If no error listeners, ioredis will be fire silently.
        if (client) {
          client.removeListener('error', errorListener);
        }
        resolve();
      });
    });
  };

  const redisClient: IRedisClient = {
    async safePing(): Promise<RedisClientPing> {
      if (!client) {
        return {
          clientStatus: 'unknown',
        };
      }
      const [resp, err] = await tuple<string, Error>(client.ping());
      if (err) {
        return {
          error: err,
          clientStatus: client.status,
          connection: details,
        };
      }
      return {
        pingResponse: resp,
        clientStatus: client.status,
        connection: details,
      };
    },
    connection(): Promise<ConnectionDetails> {
      return Promise.resolve(connectionDetails());
    },
    async client(): Promise<IORedis.Redis> {
      return client;
    },
  };

  return withManagedLifetime<IRedisClient>({
    setup,
    destroy,
    forKeys: ['safePing', 'client'],
    useTraceArgs: useCallerName('redisClient'),
  })(redisClient);
}
