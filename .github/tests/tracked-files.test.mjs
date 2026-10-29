import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync, readlinkSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import test from 'node:test';

const root = resolve(new URL('../..', import.meta.url).pathname);
const tracked = execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);

test('no tracked path is named node_modules', () => {
  assert.deepEqual(tracked.filter(path => path.split('/').includes('node_modules')), []);
});

test('no tracked symlink resolves outside the repository', () => {
  const escaping = tracked.filter(path => {
    if (!lstatSync(resolve(root, path)).isSymbolicLink()) return false;
    const target = readlinkSync(resolve(root, path));
    const resolved = resolve(dirname(resolve(root, path)), target);
    const rel = relative(root, resolved);
    return isAbsolute(target) || rel === '..' || rel.startsWith(`..${sep}`);
  });
  assert.deepEqual(escaping, []);
});

test('node_modules directories are ignored so they cannot be added again', () => {
  execFileSync('git', ['check-ignore', '-q', '.github/tests/node_modules'], {cwd: root});
});
