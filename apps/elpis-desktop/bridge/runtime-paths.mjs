import path from 'node:path';

/** Provider tools stay at the bundle root in both legacy and complete CLI packages. */
export function runtimeTools(engine) {
  const directory = path.dirname(engine);
  const root = path.basename(directory) === 'bin' && path.basename(path.dirname(directory)) === 'package'
    ? path.resolve(directory, '../..') : directory;
  return path.join(root, 'tools', 'elpis-claude');
}
