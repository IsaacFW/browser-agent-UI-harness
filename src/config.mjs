// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: node:fs, node:path
//
// Target configuration: what site to drive, how to log into it, and which identities
// exist. Credentials are NEVER stored here — an identity names an environment variable
// and the value is read at run time. loadTarget() hard-fails on a literal password so a
// config file cannot become the thing that leaks one.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Fields an identity may declare. `password` is deliberately absent — see assertNoLiteralSecrets. */
const IDENTITY_KEYS = new Set(['username', 'passwordEnv', 'usernameEnv', 'description', 'startPath']);

/** Keys that would mean a secret is sitting in a committed file. */
const FORBIDDEN_IDENTITY_KEYS = ['password', 'pass', 'secret', 'token', 'apiKey', 'api_key'];

export class ConfigError extends Error {}

/**
 * Read and validate a target config, resolving credentials from the environment.
 * Returns a frozen object; `identities` values carry resolved `password`/`username`
 * that exist only in memory.
 */
export function loadTarget(targetPath, env = process.env) {
  const path = isAbsolute(targetPath) ? targetPath : resolve(process.cwd(), targetPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new ConfigError(`target config not found: ${path}`);
    throw new ConfigError(`target config is not valid JSON (${path}): ${err.message}`);
  }

  requireString(raw, 'baseUrl', path);
  raw.baseUrl = raw.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(raw.baseUrl)) {
    throw new ConfigError(`baseUrl must start with http:// or https:// (got "${raw.baseUrl}")`);
  }

  const identities = raw.identities ?? {};
  if (typeof identities !== 'object' || Array.isArray(identities)) {
    throw new ConfigError('identities must be an object keyed by identity name');
  }
  assertNoLiteralSecrets(identities, path);

  // Shape is validated for every identity, but credentials are NOT resolved here. Working
  // as one persona must not require holding the passwords of every other one — resolution
  // happens in credentialsFor(), when an identity is actually used.
  const resolved = {};
  for (const [name, spec] of Object.entries(identities)) {
    for (const key of Object.keys(spec)) {
      if (!IDENTITY_KEYS.has(key)) {
        throw new ConfigError(`identity "${name}" has unknown key "${key}" (allowed: ${[...IDENTITY_KEYS].join(', ')})`);
      }
    }
    resolved[name] = { ...spec };
  }

  return Object.freeze({
    name: raw.name ?? 'target',
    baseUrl: raw.baseUrl,
    apiPathPrefixes: raw.apiPathPrefixes ?? ['/api'],
    login: raw.login ?? null,
    signout: raw.signout ?? null,
    viewport: raw.viewport ?? { width: 1440, height: 900 },
    identities: resolved,
    configPath: path,
    configDir: dirname(path),
  });
}

/**
 * The guard that makes a public repo safe: a target config may point AT a secret but
 * may never contain one. Fails loudly and names every offending identity at once.
 */
function assertNoLiteralSecrets(identities, path) {
  const offenders = [];
  for (const [name, spec] of Object.entries(identities)) {
    for (const key of FORBIDDEN_IDENTITY_KEYS) {
      if (key in spec) offenders.push(`${name}.${key}`);
    }
  }
  if (offenders.length) {
    throw new ConfigError(
      `refusing to load a config containing literal credentials: ${offenders.join(', ')}\n` +
        `  in ${path}\n` +
        `  Replace each with an env var name, e.g. "passwordEnv": "UIH_<IDENTITY>_PASSWORD",\n` +
        `  then export the value in your shell. Configs are meant to be committable.`
    );
  }
}

/**
 * Resolve one identity's credentials from the environment, at the point of use. Returns a
 * plain object that exists only in memory and is never written to the run log.
 */
export function credentialsFor(target, name, env = process.env) {
  const spec = target.identities[name];
  if (!spec) {
    const known = Object.keys(target.identities);
    throw new ConfigError(`unknown identity "${name}". Declared: ${known.length ? known.join(', ') : '(none)'}`);
  }
  return {
    ...spec,
    username: spec.usernameEnv ? requireEnv(env, spec.usernameEnv, name, 'usernameEnv') : spec.username,
    password: spec.passwordEnv ? requireEnv(env, spec.passwordEnv, name, 'passwordEnv') : undefined,
  };
}

function requireEnv(env, varName, identity, field) {
  const value = env[varName];
  if (value === undefined || value === '') {
    throw new ConfigError(
      `identity "${identity}" declares ${field}="${varName}" but that variable is unset.\n` +
        `  export ${varName}='…' before running.`
    );
  }
  return value;
}

function requireString(obj, key, path) {
  if (typeof obj[key] !== 'string' || !obj[key]) {
    throw new ConfigError(`target config is missing required string "${key}" (${path})`);
  }
}

/** Resolve a path (possibly relative) against the target's baseUrl. */
export function urlFor(target, pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return target.baseUrl + (pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`);
}

/** True when a URL path looks like the target's API rather than a user-facing page. */
export function isApiPath(target, url) {
  let path;
  try {
    path = new URL(url, target.baseUrl).pathname;
  } catch {
    return false;
  }
  return target.apiPathPrefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}
