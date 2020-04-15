type KeysForFunctionReturnType<T, R> = {
  [key in keyof T]: T[key] extends (...args: any[]) => R ? key : never;
}[keyof T];

export type AsyncFunctionKeys<T> = KeysForFunctionReturnType<T, Promise<any>>;
