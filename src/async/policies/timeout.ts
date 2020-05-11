import { PolicyError } from '../';

export class TimeoutError extends PolicyError {
  constructor(action: string, public timeoutInMs: number) {
    super(`${action} timed out in [${timeoutInMs} ms]`);
  }
}

type TimeoutOptions = {
  action?: string;
  timeoutInMs?: number;
};

export function timeout<T = any>(
  func: () => Promise<T>,
  options?: TimeoutOptions,
): Promise<T> {
  const { timeoutInMs = 30 * 1000, action = 'Promise' } = options || {};
  const timeout = new Promise<T>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new TimeoutError(action, timeoutInMs));
    }, timeoutInMs);
  });

  return Promise.race([func(), timeout]);
}
