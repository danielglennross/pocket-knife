import * as R from 'ramda';

export type HealthCheck = {
  category: string;
  name: string;
  action: () => Promise<string | Object>;
};

export type DebugInfo<T> = {
  key: string;
  value: T;
};

export type Debug<T> = T | 'disabled';
export type NamedDebug<T> = { [key in keyof T]: T[key] | 'disabled' };
export type HealthCheckStatus = 'initialised' | 'uninitialised';
export type NamedHealthCheckStatus = { [key in string]: HealthCheckStatus };

export interface IDiagnosable<T = {}> {
  debugInfo?: () => Promise<Debug<T> | NamedDebug<T>>;
  healthCheck?: () => Promise<HealthCheckStatus | NamedHealthCheckStatus>;
}

export function extractDebugInfo(
  ...services: { key: string; service: any }[]
): DebugInfo<any>[] {
  return R.reduce(
    (acc, { key, service }) => {
      if ((service as IDiagnosable) && service.debugInfo) {
        acc = [...acc, { key, value: service.debugInfo.bind(service) }];
      }
      return acc;
    },
    <DebugInfo<any>[]>[],
    services,
  );
}

export function extractHealthCheck(
  ...services: { category: string; name: string; service: any }[]
): HealthCheck[] {
  return R.reduce(
    (acc, { name, category, service }) => {
      if ((service as IDiagnosable) && service.healthCheck) {
        acc = [
          ...acc,
          { name, category, action: service.healthCheck.bind(service) },
        ];
      }
      return acc;
    },
    <HealthCheck[]>[],
    services,
  );
}
