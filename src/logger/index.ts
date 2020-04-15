export interface ILogger {
  error(msg: string, err: Error): void;
  error(msg: string, target?: any): void;
  warn(msg: string, target?: any): void;
  info(msg: string, target?: any): void;
  debug(msg: string, target?: any): void;
  verbose(msg: string, target?: any): void;
}
