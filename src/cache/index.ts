export interface ICache {
  isReady(): boolean;
  get<T>(id: string): Promise<T | null>;
  set<T>(id: string, data: T, ttl?: number): Promise<void>;
  drop(id: string): Promise<void>;
}
