import * as R from 'ramda';
import { EventEmitter } from 'events';
import { ILogger } from '../logger';
import { IDiagnosable } from '../diagnosable';
import { waitGroup, WaitGroup } from '../sync';
import { TargetError } from '../error';

export interface IAppEventEmitter {
  emit(event: string, ...args: any): void;
  on(event: string, handler: (...args: any) => Promise<void>): void;
  once(event: string, handler: (...args: any) => Promise<void>): void;
}

export type AppEvent = {
  name: string;
  // run dependencies, left to right, synchronously
  synchronousDependencies?: boolean;
  dependencies?: string[];
};

export type AppEventOptions = {
  events: AppEvent[];
};

type EventDebugInfo = {
  events: AppEvent[];
};

type SyncAppEventId = { kind: 'sync'; wg: WaitGroup };
type AsyncAppEventId = { kind: 'async' };
type AppEventId = SyncAppEventId | AsyncAppEventId;

const wgTimeoutInMs = 30000;

// returns a function that will call 'fn' across deep dependency chain
function getDeepAction(
  events: AppEvent[],
  fn: (eventName: string, wg?: WaitGroup) => Promise<void>,
) {
  const used = [];
  const deep = async (event: AppEvent, wg?: WaitGroup) => {
    const dependencies = event.dependencies;
    if (dependencies && dependencies.length) {
      for (let i = 0; i < dependencies.length; i++) {
        // if our event uses synchronous dependencies, we'll embed & pass a wait group to all handlers
        const wg = event.synchronousDependencies ? waitGroup() : null;
        const dependency = R.find(e => e.name === dependencies[i], events);
        await deep(dependency, wg);
      }
    }
    if (!R.contains(event, used)) {
      used.push(event);
      await fn(event.name, wg);
    }
  };
  return deep;
}

// returns all events that have a circular dependency chain
function getCircularEventChains(events: AppEvent[]) {
  const deep = (event: AppEvent, used: AppEvent[], circular: AppEvent[]) => {
    if (R.contains(event, used)) {
      circular.push(event);
      return;
    }
    used.push(event);
    const dependencies = event.dependencies;
    if (dependencies && dependencies.length) {
      R.forEach(d => {
        const dependency = R.find(e => e.name === d, events);
        // circular dependencies occur in the current captured used items
        const currentUsed = used.slice(0);
        deep(dependency, currentUsed, circular);
      }, dependencies);
    }
  };

  const circularChains = R.reduce(
    (circular, event) => {
      deep(event, [], circular);
      return circular;
    },
    <AppEvent[]>[],
    events,
  );

  return circularChains;
}

function buildEmitEvent(
  eventEmitter: EventEmitter,
  logger: ILogger,
  args: any[],
) {
  async function emitSyncEvent(
    eventName: string,
    wg: WaitGroup,
  ): Promise<void> {
    // wait groups allows us to to process events sequentially.
    // if we have multiple events in a dependency chain, we only move on to the
    // next event, if all the current handlers have signalled completion.

    // this addition prevents 'wg.wait' resolving immediately
    // as it is ran on the same stack following 'eventEmitter.emit'
    wg.add(1);
    eventEmitter.once(eventName, () => {
      wg.done();
    });

    eventEmitter.emit(
      eventName,
      { kind: 'sync', wg } as SyncAppEventId,
      ...args,
    );

    return await wg.wait({ timeoutInMs: wgTimeoutInMs }).catch(err => {
      logger.error(
        `failed to process all handlers for dependent event: ${eventName} (timeout)`,
        new TargetError(err, {
          category: 'bff-framework:events',
          eventName,
          timeoutInMs: wgTimeoutInMs,
        }),
      );
    });
  }

  async function emitAsyncEvent(eventName: string): Promise<void> {
    eventEmitter.emit(eventName, { kind: 'async' } as AsyncAppEventId, ...args);
  }

  return function emitEvent(eventName: string, wg?: WaitGroup): Promise<void> {
    if (wg) {
      return emitSyncEvent(eventName, wg);
    }
    return emitAsyncEvent(eventName);
  };
}

function handleEvent(
  handler: (...args: any[]) => Promise<void>,
  args: [AppEventId, ...any[]],
): Promise<void> {
  const [appEventId, ...handlerArgs] = args;
  return {
    async: (_: AsyncAppEventId) => handler(...handlerArgs),
    sync: ({ wg }: SyncAppEventId) => {
      wg.add(1);
      return handler(...handlerArgs).then(
        () => wg.done(),
        () => wg.done(),
      );
    },
  }[appEventId.kind](<any>appEventId);
}

export function createEventEmitter({
  logger,
  events,
}: {
  logger: ILogger;
  events: AppEvent[];
}): IAppEventEmitter & IDiagnosable<EventDebugInfo> {
  // ensure each event dependency chain does not circular dependency
  const circularEvents = getCircularEventChains(events);
  if (circularEvents.length) {
    throw new Error(
      `circular dependencies found in events: ${R.map(
        e => e.name,
        circularEvents,
      )
        .join(', ')
        .trim()}`,
    );
  }

  // we may add more than 10 (default) pluginsLoaded event listeners, incr limit for MaxListenersExceededWarning
  const eventEmitter = new EventEmitter();
  eventEmitter.setMaxListeners(15);

  return {
    debugInfo() {
      return Promise.resolve(<EventDebugInfo>{ events });
    },
    healthCheck() {
      return Promise.resolve('initialised');
    },
    emit(event: string, ...args: any[]): void {
      // fire dependency event chain first, then event
      const action = R.find(e => e.name === event, events);
      if (!action) {
        return;
      }

      const emitEventChain = getDeepAction(
        events,
        buildEmitEvent(eventEmitter, logger, args),
      );

      // fire and forget the promise
      emitEventChain(action);
    },
    on(event: string, handler: (...args: any[]) => Promise<void>): void {
      eventEmitter.on(event, async (...args: any[]) => {
        return handleEvent(handler, <[AppEventId, ...any[]]>args);
      });
    },
    once(event: string, handler: (...args: any[]) => Promise<void>): void {
      eventEmitter.once(event, async (...args: any[]) => {
        return handleEvent(handler, <[AppEventId, ...any[]]>args);
      });
    },
  };
}
