import * as R from 'ramda';
import JSONBigInt from 'json-bigint';
import { getNonEnumerableEntries } from './object';

const jsonParser: { parse: <T>(input: string) => T } = JSONBigInt({
  storeAsString: true,
});

export function parseJson<T = any>(json: string) {
  return jsonParser.parse<T>(json);
}

export function concatenateQueryParams(obj: Object) {
  const query = R.reduce(
    (query, [key, value]) => {
      if (!R.isNil(value)) {
        query += `${key}=${encodeURIComponent(value)}&`;
      }
      return query;
    },
    '',
    Object.entries(obj),
  );

  // return and strip last &
  return query.substring(0, query.length - 1);
}

export function printObject(obj: object): string {
  function walk(str: string, tab: number, obj: object) {
    getNonEnumerableEntries(obj).forEach(([key, value]) => {
      const space = ' '.repeat(tab);
      if (typeof value === 'object') {
        str += `\n${space}${key}: {`;
        str = walk(str, ++tab, value || {});
        str += `\n${space}}`;
        --tab;
        return;
      }
      str += `\n${space}${key}: ${value || ''.toString()}`;
    });
    return str;
  }
  return walk('', 0, obj || {});
}

export function toBase64(str: string) {
  return Buffer.from(str).toString('base64');
}

export function fromBase64(str: string) {
  return Buffer.from(str, 'base64').toString('ascii');
}

export function camelCaseKeys(excludedKeys?: string[]) {
  return function(obj: object) {
    return formatKeys(
      key => {
        return key
          .replace(/(?:^\w|[A-Z]|\b\w)/g, (letter: string, index: number) => {
            return index == 0 ? letter.toLowerCase() : letter.toUpperCase();
          })
          .replace(/\s+/g, '');
      },
      obj,
      excludedKeys,
    );
  };
}

export function lowerCaseKeys(excludedKeys?: string[]) {
  return function(obj: object) {
    return formatKeys(key => key.toLowerCase(), obj, excludedKeys);
  };
}

export function kebabCase(excludedKeys?: string[]) {
  return function(obj: object) {
    return formatKeys(
      key => {
        return key.toLowerCase().replace('/s+/g', '-');
      },
      obj,
      excludedKeys,
    );
  };
}

function formatKeys(
  project: (key: string) => string,
  obj: object,
  excludedKeys?: string[],
): object {
  const newObj = obj;
  R.forEach(key => {
    if (R.includes(key, excludedKeys || [])) {
      return;
    }

    const newKey = project(key);

    if (typeof newObj[key] === 'object') {
      formatKeys(project, newObj[key], excludedKeys);
    }

    if (newKey !== key) {
      newObj[newKey] = newObj[key];
      delete newObj[key];
    }
  }, Object.keys(newObj || {}));

  return newObj;
}
