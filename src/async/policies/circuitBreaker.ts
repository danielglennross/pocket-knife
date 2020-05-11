import { tuple, safe, PolicyError } from '../';
import { newMutex, Mutex } from '../../sync';

type FallbackAction<T, E extends Error> = (err: E) => Promise<T>;
type StateChangedAction = (circuitState: CircuitState, err?: Error) => void;
type State = 'closed' | 'open' | 'halfOpen';

export type CircuitState = { state: State; failures: number; openedAt: number };

export class CircuitBreakerOpenError extends PolicyError {
  constructor(
    action: string,
    public failureThreshold: number,
    public gracePeriodInMs: number,
    public circuit: Circuit,
  ) {
    super(`${action} has been called within an open circuit`);
  }
}

export type CircuitBreakerInvoker<T = any> = (
  func: () => Promise<T>,
  runOptions?: CircuitBreakerRunOptions<T>,
) => Promise<T>;

type CircuitBreakerOptions = {
  gracePeriodInMs?: number;
  failureThreshold?: number;
  forFailure?: <E extends Error>(err: E) => boolean;
};

type CircuitBreakerRunOptions<T> = {
  action?: string;
  onClosed?: StateChangedAction;
  onOpen?: StateChangedAction;
  onHalfOpen?: StateChangedAction;
  fallback?: FallbackAction<T, CircuitBreakerOpenError | Error>;
};

interface Circuit {
  isValid(): boolean;
  getState(): CircuitState;
  recordFail(failureThreshold: number): CircuitState;
  recordSuccess(): CircuitState;
  tryReset(gracePeriodInMs: number): CircuitState;
}

const noop = () => {};

function createCircuit(): Circuit {
  let state: State = 'closed';
  let failures: number = 0;
  let openedAt: number = null;

  return {
    isValid() {
      return state === 'closed' || state === 'halfOpen';
    },
    getState() {
      return {
        state,
        failures,
        openedAt,
      };
    },
    recordFail(failureThreshold: number): CircuitState {
      if (state !== 'open') {
        if (++failures >= failureThreshold) {
          state = 'open';
          openedAt = Date.now();
        }
      }
      return this.getState();
    },
    recordSuccess(): CircuitState {
      if (state !== 'closed') {
        state = 'closed';
        failures = 0;
      }
      return this.getState();
    },
    tryReset(gracePeriodInMs: number): CircuitState {
      const moveToHalfOpen =
        state === 'open' && openedAt && Date.now() - openedAt > gracePeriodInMs;
      if (moveToHalfOpen) {
        state = 'halfOpen';
      }
      return this.getState();
    },
  };
}

export function circuitBreaker<T = any>(
  options?: CircuitBreakerOptions,
): CircuitBreakerInvoker<T> {
  const circuit = createCircuit();
  const circuitLock: Mutex = newMutex();

  const {
    gracePeriodInMs = 3000,
    failureThreshold = 10,
    forFailure = () => true,
  } = options || {};

  const handleSuccess = ({ onClosed }): Promise<void> => {
    return circuitLock.lock(() => {
      const circuitState = circuit.recordSuccess();
      if (circuitState.state === 'closed') {
        onClosed(circuitState);
      }
      return Promise.resolve();
    });
  };

  const handleFailure = ({ err, onOpen }): Promise<void> => {
    return circuitLock.lock(() => {
      if (forFailure(err)) {
        const circuitState = circuit.recordFail(failureThreshold);
        if (circuitState.state === 'open') {
          onOpen(circuitState, err);
        }
      }
      return Promise.resolve();
    });
  };

  const tryReset = ({ onHalfOpen }): Promise<boolean> => {
    return circuitLock.lock(() => {
      const circuitState = circuit.tryReset(gracePeriodInMs);
      if (circuitState.state === 'halfOpen') {
        onHalfOpen(circuitState);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });
  };

  const trigger = async ({ func, fallback, onClosed, onOpen }): Promise<T> => {
    const [result, err] = await tuple(func());
    if (err) {
      await safe(handleFailure({ err, onOpen }));
      if (fallback) {
        return fallback(err);
      }
      throw err;
    }

    await safe(handleSuccess({ onClosed }));
    return result;
  };

  const isCircuitValid = async (): Promise<boolean> => {
    return circuitLock.lock(() => {
      return Promise.resolve(circuit.isValid());
    });
  };

  const circuitOpen = ({ action, fallback }) => {
    const error = new CircuitBreakerOpenError(
      action,
      failureThreshold,
      gracePeriodInMs,
      circuit,
    );
    if (fallback) {
      return fallback(error);
    }
    throw error;
  };

  return async (
    func: () => Promise<T>,
    runOptions?: CircuitBreakerRunOptions<T>,
  ): Promise<T> => {
    const {
      action = 'Promise',
      onClosed = noop,
      onOpen = noop,
      onHalfOpen = noop,
      fallback = null,
    } = runOptions || {};

    if (await isCircuitValid()) {
      return trigger({ func, fallback, onClosed, onOpen });
    }

    if (await tryReset({ onHalfOpen })) {
      return trigger({ func, fallback, onClosed, onOpen });
    }

    return circuitOpen({ action, fallback });
  };
}
