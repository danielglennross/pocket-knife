import * as R from 'ramda';
import {
  AppEvent,
  AppEventOptions,
  IAppEventEmitter,
  IDiagnosable,
} from '../../domain/types';
import { EventEmitter } from 'events';

type EventDebugInfo = {
  events: AppEvent[];
};

// returns a function that will call 'fn' across deep dependency chain
function getDeepAction(events: AppEvent[], fn: (eventName: string) => void) {
  const used = [];
  const deep = (event: AppEvent) => {
    const dependencies = event.dependencies;
    if (dependencies && dependencies.length) {
      R.forEach(d => {
        const dependency = R.find(e => e.name === d, events);
        deep(dependency);
      }, dependencies);
    }
    if (!R.contains(event, used)) {
      used.push(event);
      fn(event.name);
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

export function createEventEmitter(
  options: AppEventOptions,
): IAppEventEmitter & IDiagnosable<EventDebugInfo> {
  const { events } = options;

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

  const eventEmitter = new EventEmitter();
  return {
    debugInfo() {
      return Promise.resolve(<EventDebugInfo>{ events });
    },
    healthCheck() {
      return Promise.resolve('initialised');
    },
    emit(event: string, ...args: any): void {
      // fire dependency event chain first, then event
      const action = R.find(e => e.name === event, events);
      if (!action) {
        return;
      }

      const emitEventChain = getDeepAction(events, (eventName: string) =>
        eventEmitter.emit(eventName, ...args),
      );
      emitEventChain(action);
    },
    on(event: string, handler: (...args: any) => void): void {
      eventEmitter.on(event, handler);
    },
  };
}
