export function getNonEnumerableEntries(object: object): [string, any][] {
  return Object.getOwnPropertyNames(object).map(
    (key: string) => <[string, any]>[key, object[key]],
  );
}

function getProperty(object: any, path: string): any {
  return Array.isArray(object) ? object.map(o => o[path]) : object[path];
}

export function getObjectPath(object: any, path: string): any {
  if (!path) {
    return object;
  }

  if (path.indexOf('.') === -1) {
    return getProperty(object, path);
  }

  const crumbs = path.split('.');

  let result = object;
  let i = 0;

  do {
    if (!crumbs[i]) {
      continue;
    }
    if (result === void 0) {
      break;
    }
    result = getProperty(result, crumbs[i]);
  } while (++i < crumbs.length);

  return result;
}
