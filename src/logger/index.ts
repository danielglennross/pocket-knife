export interface ILogger {
  error(msg: string, err: Error): void;
  error(msg: string, target?: any): void;
  warn(msg: string, target?: any): void;
  info(msg: string, target?: any): void;
  debug(msg: string, target?: any): void;
  verbose(msg: string, target?: any): void;
}

export type LogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error';

export function createNullLogger() {
  return {
    error(msg: string, err: Error) {},
    warn(msg: string, target?: any) {},
    info(msg: string, target?: any) {},
    debug(msg: string, target?: any) {},
    verbose(msg: string, target?: any) {},
  }
}