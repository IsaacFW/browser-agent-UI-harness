// deps: node:test, node:assert, src/config.mjs
//
// The credential guard is the one piece that, if it regresses, turns a public repo into a
// leak. It gets the most coverage here.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigError, credentialsFor, isApiPath, loadTarget, urlFor } from '../src/config.mjs';

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
  const target = loadTarget(path);
  const creds = credentialsFor(target, 'buyer', { TEST_PW: 's3cret' });
  assert.equal(creds.password, 's3cret');
  assert.equal(creds.username, 'b');
});

test('fails loudly when the named variable is unset', () => {
  const path = writeConfig('unset', {
    ...BASE,
    identities: { buyer: { username: 'b', passwordEnv: 'ABSENT_PW' } },
  });
  const target = loadTarget(path);
  assert.throws(() => credentialsFor(target, 'buyer', {}), /ABSENT_PW[\s\S]*unset|unset/);
});

test('working as one identity does not require every identity\'s credentials', () => {
  // Regression: eager resolution meant driving the site as one persona demanded the
  // passwords of all the others, which is both annoying and a reason to over-share secrets.
  const path = writeConfig('lazy', {
    ...BASE,
    identities: {
      buyer: { username: 'b', passwordEnv: 'ONLY_THIS_ONE' },
      admin: { username: 'a', passwordEnv: 'NOT_EXPORTED' },
    },
  });
  const target = loadTarget(path);
  const creds = credentialsFor(target, 'buyer', { ONLY_THIS_ONE: 'pw' });
  assert.equal(creds.password, 'pw');
  assert.throws(() => credentialsFor(target, 'admin', { ONLY_THIS_ONE: 'pw' }), /NOT_EXPORTED/);
});

test('credentialsFor rejects an unknown identity by name', () => {
  const path = writeConfig('unknown-id', { ...BASE, identities: { buyer: { username: 'b' } } });
  assert.throws(() => credentialsFor(loadTarget(path), 'nobody', {}), /unknown identity "nobody"/);
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
