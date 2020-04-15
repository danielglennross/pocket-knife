import { randomBytes } from 'crypto';
import * as R from 'ramda';

// ignore int64, as native js rounds these values
type intType = 'int8' | 'int16' | 'int32';

export function getRandomInts(amount: number, type?: intType): number[] {
  const factory = R.cond([
    [R.equals('int8'), R.always(() => randomBytes(1).readUInt8(0))],
    [R.equals('int16'), R.always(() => randomBytes(2).readInt16BE(0))],
    [R.equals('int32'), R.always(() => randomBytes(4).readInt32BE(0))],
  ])(type || 'int32');

  return R.map(factory, [...Array(amount)]);
}
