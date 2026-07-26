// deps: node:test, node:assert, src/config.mjs
//
// The credential guard is the one piece that, if it regresses, turns a public repo into a
// leak. It gets the most coverage here.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigError, isApiPath, loadTarget, urlFor } from '../src/config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'uiharness-'));

function writeConfig(name, obj) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const BASE = { name: 't', baseUrl: 'http://localhost:1234' };

test('refuses a config containing a literal password', () => {
  const path = writeConfig('literal', {
    ...BASE,
    identities: { buyer: { username: 'b', password: 'hunter2' } },
  });
  assert.throws(() => loadTarget(path), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /literal credentials/);
    assert.match(err.message, /buyer\.password/);
    return true;
  });
});

test('names every offending identity at once, not just the first', () => {
  const path = writeConfig('many', {
    ...BASE,
    identities: { a: { token: 'x' }, b: { secret: 'y' } },
  });
  assert.throws(() => loadTarget(path), /a\.token[\s\S]*b\.secret|b\.secret[\s\S]*a\.token/);
});

test('resolves a password from the named environment variable', () => {
  const path = writeConfig('env', {
    ...BASE,
    identities: { buyer: { username: 'b', passwordEnv: 'TEST_PW' } },
  });
  const target = loadTarget(path, { TEST_PW: 's3cret' });
  assert.equal(target.identities.buyer.password, 's3cret');
  assert.equal(target.identities.buyer.username, 'b');
});

test('fails loudly when the named variable is unset', () => {
  const path = writeConfig('unset', {
    ...BASE,
    identities: { buyer: { username: 'b', passwordEnv: 'ABSENT_PW' } },
  });
  assert.throws(() => loadTarget(path, {}), /ABSENT_PW.*unset|unset/s);
});

test('rejects an unknown identity key rather than ignoring it', () => {
  const path = writeConfig('typo', {
    ...BASE,
    identities: { buyer: { username: 'b', passwordEnvv: 'X' } },
  });
  assert.throws(() => loadTarget(path), /unknown key "passwordEnvv"/);
});

test('requires an absolute baseUrl', () => {
  const path = writeConfig('rel', { name: 't', baseUrl: 'localhost:1234' });
  assert.throws(() => loadTarget(path), /must start with http/);
});

test('trailing slashes in baseUrl do not produce doubled slashes', () => {
  const path = writeConfig('slash', { name: 't', baseUrl: 'http://x.test/' });
  const target = loadTarget(path);
  assert.equal(urlFor(target, '/orders'), 'http://x.test/orders');
  assert.equal(urlFor(target, 'orders'), 'http://x.test/orders');
});

test('isApiPath matches the prefix but not merely similar paths', () => {
  const path = writeConfig('api', { ...BASE, apiPathPrefixes: ['/api'] });
  const target = loadTarget(path);
  assert.equal(isApiPath(target, 'http://localhost:1234/api/orders'), true);
  assert.equal(isApiPath(target, 'http://localhost:1234/api'), true);
  assert.equal(isApiPath(target, 'http://localhost:1234/apiary'), false);
  assert.equal(isApiPath(target, 'http://localhost:1234/orders'), false);
});

test('a missing config file explains itself', () => {
  assert.throws(() => loadTarget(join(dir, 'nope.json')), /not found/);
});
