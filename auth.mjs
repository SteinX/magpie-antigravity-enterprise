import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliMetadataError, readCliMetadata } from './cli-metadata.mjs';
import { nativeFetch } from './transport.mjs';
import { KeychainError, readCredential, withRefreshLock } from './keychain.mjs';

const APP = '/Applications/Antigravity.app';
const PREFIX = 'go-keyring-base64:';
const REFRESH_MARGIN = 300_000;
const CLOUD_CLIENT = '884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com';
const WIF_CLIENT = 'a2a6f0e3e-3ff0-462b-869a-47277df4c806';
// Identifies the public installed-app client configuration without storing its secret.
// Source: Mag1cFall/Antigravity2API, 6aa1a0a, internal/antigravity/oauth.go.
const CLOUD_SECRET_HASH = 'a2ddedc84850a9c48b7e01d61700848083bf0e10fb8d6c99c496803e8b48ced0';
const flights = new Map();
const clientCache = new Map();

class NativeAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeAuthError';
    this.code = code;
    if (['ERR_NATIVE_ACCOUNT_CHANGED', 'ERR_NATIVE_METHOD', 'ERR_NATIVE_FORMAT', 'ERR_NATIVE_PRINCIPAL'].includes(code)) this.signIn = 'expired';
  }
}
const failure = (code, message) => new NativeAuthError(code, message);
const aborted = () => Object.assign(new Error('Native authentication cancelled.'), { name: 'AbortError' });
const hash = value => createHash('sha256').update(value).digest('hex');
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };
const tokenSnapshot = profile => hash(JSON.stringify(profile.token));
const providerKey = profile => JSON.stringify([profile.auth_method, profile.wif_provider]);
const tokenKey = profile => hash(JSON.stringify([profile.auth_method, profile.wif_provider, profile.token.refresh_token]));
const publicError = error => error instanceof KeychainError ? new KeychainError(error.kind)
  : error instanceof NativeAuthError || error instanceof CliMetadataError || error?.name === 'AbortError'
    ? (error?.name === 'AbortError' ? aborted() : error)
    : failure('ERR_NATIVE_AUTH', 'Native authentication failed; no credential details were recorded.');

function effectiveRefreshMethod(profile) {
  if (!['gcp', 'wif', 'business_licensed_enterprise'].includes(profile.auth_method)) {
    throw failure('ERR_NATIVE_METHOD', 'The native account is not a supported enterprise account.');
  }
  // Native getOAuthConfig gives a nonempty provider precedence over the stored label.
  if (profile.wif_provider) return 'wif';
  if (profile.auth_method === 'wif') {
    throw failure('ERR_NATIVE_METHOD', 'The native workforce account has no identity provider.');
  }
  return 'gcp';
}

function decode(raw) {
  try {
    const text = raw.trim();
    if (!text.startsWith(PREFIX)) throw new Error();
    const encoded = text.slice(PREFIX.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error();
    const profile = JSON.parse(bytes.toString('utf8'));
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error();
    const token = profile.token;
    if (!token || typeof token !== 'object' || Array.isArray(token)) throw new Error();
    for (const field of ['access_token', 'refresh_token', 'expiry']) {
      if (typeof token[field] !== 'string' || !token[field]) throw new Error();
    }
    if (!Number.isFinite(Date.parse(token.expiry))) throw new Error();
    for (const field of ['auth_method', 'wif_provider', 'project_id', 'region', 'user_tier']) {
      if (typeof profile[field] !== 'string') throw new Error();
    }
    if (Object.hasOwn(profile, 'tier_display_name') && typeof profile.tier_display_name !== 'string') throw new Error();
    effectiveRefreshMethod(profile);
    return { raw: text, profile };
  } catch (error) {
    if (error instanceof NativeAuthError) throw error;
    throw failure('ERR_NATIVE_FORMAT', 'The Antigravity Keychain credential has an unsupported format.');
  }
}

function validateConfig(profile, config) {
  if (!config) return;
  if (config.authMethod && config.authMethod !== 'auto' && config.authMethod !== effectiveRefreshMethod(profile)) {
    throw failure('ERR_NATIVE_ACCOUNT_CHANGED', 'The configured authentication method differs from the native account; reconnect explicitly.');
  }
  if (config.wifProvider && config.wifProvider !== profile.wif_provider) {
    throw failure('ERR_NATIVE_ACCOUNT_CHANGED', 'The configured identity provider differs from the native account; reconnect explicitly.');
  }
  // projectId/location belong to the caller's license selection, never to token refresh.
}

function binding(profile) {
  if (typeof profile?._principal !== 'string' || !/^[a-f0-9]{64}$/.test(profile._principal)) {
    throw failure('ERR_NATIVE_PRINCIPAL', 'The native account has no verified principal binding.');
  }
  return hash(JSON.stringify([profile._principal, profile.auth_method, profile.wif_provider]));
}

async function installedClientConfig(appPath, profile) {
  const executable = join(appPath, 'Contents/Resources/bin/language_server');
  const info = await stat(executable);
  const key = `${executable}:${info.mtimeMs}:${info.size}`;
  let pending = clientCache.get(key);
  if (!pending) {
    pending = (async () => {
      let carry = '';
      let cloudSecret;
      let cloudClient = false;
      let wifClient = false;
      for await (const chunk of createReadStream(executable, { highWaterMark: 128 * 1024 })) {
        const text = carry + chunk.toString('latin1');
        cloudClient ||= text.includes(CLOUD_CLIENT);
        wifClient ||= text.includes(WIF_CLIENT);
        for (const match of text.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)) {
          if (hash(match[0]) === CLOUD_SECRET_HASH) cloudSecret = match[0];
        }
        carry = text.slice(-128);
        if (cloudClient && wifClient && cloudSecret) break;
      }
      return { cloudSecret, cloudClient, wifClient };
    })();
    clientCache.set(key, pending);
    pending.catch(() => clientCache.delete(key));
  }
  const native = await pending;
  if (effectiveRefreshMethod(profile) === 'wif') {
    if (!native.wifClient) throw failure('ERR_NATIVE_CLIENT', 'The installed app does not contain the expected workforce OAuth client.');
    return { url: 'https://sts.googleapis.com/v1/oauthtoken', clientId: WIF_CLIENT, clientSecret: '', authStyle: 'basic' };
  }
  if (!native.cloudClient || !native.cloudSecret) {
    throw failure('ERR_NATIVE_CLIENT', 'The installed app does not contain the supported enterprise OAuth configuration.');
  }
  return { url: 'https://oauth2.googleapis.com/token', clientId: CLOUD_CLIENT, clientSecret: native.cloudSecret, authStyle: 'form' };
}


function subscribe(flight, signal) {
  checkAbort(signal);
  flight.consumers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      if (--flight.consumers === 0 && !flight.critical && !flight.settled) flight.controller.abort();
      return true;
    };
    const onAbort = () => { if (release()) reject(aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(value => { if (release()) resolve(value); }, error => { if (release()) reject(error); });
    if (signal?.aborted) onAbort();
  });
}

// Only accept ID-token identity obtained directly from a successful TLS token response.
// Stored/unverified JWTs are never decoded as an account identity.
function responsePrincipal(idToken, clientId) {
  if (typeof idToken !== 'string') return undefined;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return undefined;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(clientId) || typeof claims.sub !== 'string' || !claims.sub || typeof claims.iss !== 'string' || !claims.iss) return undefined;
    return hash(JSON.stringify([claims.iss.replace(/^https:\/\//, ''), claims.sub]));
  } catch { return undefined; }
}

/** Native credentials stay in the original Keychain item. _deps is for deterministic tests. */
export function createNativeSession(options = {}) {
  const appPath = options.appPath ?? APP;
  const stateDir = options.stateDir ?? join(homedir(), '.config/magpie/antigravity-enterprise');
  const overrides = options._deps ?? {};
  const deps = {
    now: Date.now,
    fetch: nativeFetch,
    readCredential: request => readCredential(stateDir, request),
    withRefreshLock: (task, signal, policy) => withRefreshLock(stateDir, task, signal, policy),
    metadata: () => readCliMetadata(options.cliPath),
    oauthConfig: profile => installedClientConfig(appPath, profile),
    async readPrincipal(key) {
      try {
        const value = (await readFile(join(stateDir, `principal-${key}`), 'utf8')).trim();
        if (!/^[a-f0-9]{64}$/.test(value)) throw failure('ERR_NATIVE_PRINCIPAL', 'The saved native account binding is invalid.');
        return value;
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async writePrincipal(key, principal) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const destination = join(stateDir, `principal-${key}`);
      const temporary = `${destination}.${randomUUID()}`;
      try {
        await writeFile(temporary, principal + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, destination);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    },
    ...overrides,
  };
  let pinnedBinding;
  const principals = new Map();
  const read = async (signal, interactive = false) => decode(await deps.readCredential({ signal, interactive }));
  const cachedPrincipal = async profile => {
    const key = tokenKey(profile);
    let principal = principals.get(key);
    if (!principal) {
      principal = await deps.readPrincipal(key);
      if (principal) principals.set(key, principal);
    }
    return principal;
  };
  const savePrincipal = async (profile, principal) => {
    await deps.writePrincipal(tokenKey(profile), principal);
    principals.set(tokenKey(profile), principal);
  };
  const identify = async (profile, signal) => {
    const known = await cachedPrincipal(profile);
    if (known) return known;
    checkAbort(signal);
    let response;
    try {
      response = await deps.fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { authorization: `Bearer ${profile.token.access_token}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw failure('ERR_NATIVE_PRINCIPAL', 'Google did not provide a stable native account identity; sign in again in Antigravity.');
      }
      const data = await response.json();
      const subject = data.id ?? data.sub;
      if (typeof subject !== 'string' || !subject) throw failure('ERR_NATIVE_PRINCIPAL', 'Google returned no stable native account identity.');
      const principal = hash(JSON.stringify(['accounts.google.com', subject]));
      await savePrincipal(profile, principal);
      return principal;
    } catch (error) {
      if (signal?.aborted) throw aborted();
      throw publicError(error);
    }
  };
  const checkBinding = (profile, config) => {
    const actual = binding(profile);
    if ((pinnedBinding && pinnedBinding !== actual) || (config?.nativeBinding && config.nativeBinding !== actual)) {
      throw failure('ERR_NATIVE_ACCOUNT_CHANGED', 'The native Antigravity account changed; reconnect explicitly before continuing.');
    }
    return actual;
  };

  async function renew(initial, forceRefresh, signal, config, interactive) {
    // A background consumer must never inherit an explicit sign-in's UI policy.
    // Different policies still serialize their rotations through the native flock.
    const flightKey = `${stateDir}:${tokenKey(initial.profile)}:${interactive ? 'interactive' : 'noninteractive'}`;
    let flight = flights.get(flightKey);
    if (!flight || flight.controller.signal.aborted) {
      flight = { controller: new AbortController(), consumers: 0, critical: false, settled: false };
      const own = flight;
      own.promise = deps.withRefreshLock(async lock => {
        const current = await read(own.controller.signal, interactive);
        validateConfig(current.profile, config);
        if (providerKey(current.profile) !== providerKey(initial.profile)) {
          throw failure('ERR_NATIVE_ACCOUNT_CHANGED', 'Native authentication changed while waiting for token renewal.');
        }
        const previousPrincipal = await cachedPrincipal(initial.profile);
        const currentPrincipal = await cachedPrincipal(current.profile);
        if (current.profile.token.refresh_token !== initial.profile.token.refresh_token && (!previousPrincipal || previousPrincipal !== currentPrincipal)) {
          throw failure('ERR_NATIVE_ACCOUNT_CHANGED', 'Native credentials changed while waiting for token renewal.');
        }
        if (currentPrincipal) checkBinding({ ...current.profile, _principal: currentPrincipal }, config);
        if (tokenSnapshot(current.profile) !== tokenSnapshot(initial.profile) && Date.parse(current.profile.token.expiry) - deps.now() >= REFRESH_MARGIN) {
          return { ...current.profile, _principal: await identify(current.profile, own.controller.signal) };
        }
        if (!forceRefresh && Date.parse(current.profile.token.expiry) - deps.now() >= REFRESH_MARGIN) {
          return { ...current.profile, _principal: await identify(current.profile, own.controller.signal) };
        }
        const client = await deps.oauthConfig(current.profile);
        checkAbort(own.controller.signal);
        const form = new URLSearchParams();
        const headers = { 'content-type': 'application/x-www-form-urlencoded' };
        if (client.authStyle === 'basic') {
          // Captured native WIF refresh uses Basic with an empty client secret.
          headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
          headers['user-agent'] = 'Go-http-client/2.0';
          headers['accept-encoding'] = 'gzip';
        } else {
          form.set('client_id', client.clientId);
          if (client.clientSecret) form.set('client_secret', client.clientSecret);
        }
        form.set('grant_type', 'refresh_token');
        form.set('refresh_token', current.profile.token.refresh_token);
        // Once dispatched, Google may rotate the refresh token before its body
        // is parsed. Consumers can stop waiting, but bounded renewal and commit
        // must retain ownership even if the final consumer cancels.
        checkAbort(own.controller.signal);
        own.critical = true;
        const response = await deps.fetch(client.url, {
          method: 'POST', headers, body: form,
          signal: AbortSignal.any([own.controller.signal, AbortSignal.timeout(30_000)]), redirect: 'error',
        });
        if (!response.ok) {
          let oauthError;
          try {
            const body = await response.json();
            if (typeof body?.error === 'string') oauthError = body.error;
          } catch { /* A response body is never attached to an error. */ }
          const error = failure('ERR_NATIVE_REFRESH', `Native enterprise token renewal failed (HTTP ${response.status}). Sign in again in Antigravity if authorization expired.`);
          if (response.status === 401 || ['invalid_grant', 'invalid_token', 'unauthorized_client'].includes(oauthError)) error.signIn = 'expired';
          throw error;
        }
        const data = await response.json();
        if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
          !Number.isFinite(new Date(deps.now() + data.expires_in * 1000).getTime()) ||
          (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token)) ||
          (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))) {
          throw failure('ERR_NATIVE_REFRESH', 'Google returned an invalid native token renewal response.');
        }
        const latest = await read(undefined, interactive);
        if (providerKey(latest.profile) !== providerKey(current.profile) || tokenSnapshot(latest.profile) !== tokenSnapshot(current.profile)) {
          throw failure('ERR_NATIVE_ACCOUNT_CHANGED', 'Antigravity changed its credentials during renewal; the plugin did not overwrite them.');
        }
        const updated = {
          ...latest.profile,
          token: {
            ...latest.profile.token,
            access_token: data.access_token,
            refresh_token: data.refresh_token ?? latest.profile.token.refresh_token,
            token_type: data.token_type ?? latest.profile.token.token_type ?? 'Bearer',
            expiry: new Date(deps.now() + data.expires_in * 1000).toISOString(),
          },
        };
        // Keep an established binding even if a later response supplies stronger
        // identity. Workforce tokens may expose no userinfo or ID token at all.
        // Such accounts use the verified refresh-token lineage; unknown external
        // rotations require explicit rebind instead of guessing the human account.
        const principal = currentPrincipal ?? responsePrincipal(data.id_token, client.clientId)
          ?? hash(JSON.stringify(['native-refresh-lineage', tokenKey(current.profile)]));
        // Publish both fingerprints while holding the lock, before native commit,
        // so another host can recognize a rotation as belonging to this lineage.
        let mappingError;
        try {
          await savePrincipal(current.profile, principal);
          await savePrincipal(updated, principal);
        } catch (error) {
          // A disk failure must not discard a newly rotated native refresh token.
          mappingError = publicError(error);
        }
        const encoded = PREFIX + Buffer.from(JSON.stringify(updated)).toString('base64');
        if (!await lock.commit(latest.raw, encoded)) {
          throw failure('ERR_NATIVE_ACCOUNT_CHANGED', 'Antigravity changed its Keychain item before renewal was saved; reconnect explicitly.');
        }
        if (mappingError) throw mappingError;
        return { ...updated, _principal: principal };
      }, own.controller.signal, { interactive }).finally(() => {
        own.settled = true;
        if (flights.get(flightKey) === own) flights.delete(flightKey);
      });
      own.promise.catch(() => {});
      flights.set(flightKey, own);
    }
    return subscribe(flight, signal);
  }

  return {
    async profile({ signal, forceRefresh = false, config, interactive = false } = {}) {
      try {
        checkAbort(signal);
        interactive = interactive === true;
        const initial = await read(signal, interactive);
        validateConfig(initial.profile, config);
        const known = await cachedPrincipal(initial.profile);
        if (known) checkBinding({ ...initial.profile, _principal: known }, config);
        let result;
        if (forceRefresh || Date.parse(initial.profile.token.expiry) - deps.now() < REFRESH_MARGIN) {
          result = await renew(initial, forceRefresh, signal, config, interactive);
        } else {
          try {
            result = { ...initial.profile, _principal: known ?? await identify(initial.profile, signal) };
          } catch (error) {
            if (error?.code !== 'ERR_NATIVE_PRINCIPAL') throw error;
            // A successful renewal authenticates an otherwise opaque workforce
            // lineage. Merely possessing an unverified local token does not.
            result = await renew(initial, true, signal, config, interactive);
          }
        }
        checkAbort(signal);
        validateConfig(result, config);
        pinnedBinding = checkBinding(result, config);
        return result;
      } catch (error) { throw publicError(error); }
    },
    async identity(profile) {
      try {
        const metadata = await deps.metadata();
        if (metadata.platform !== 'darwin') throw failure('ERR_NATIVE_PLATFORM', 'Native Antigravity Keychain authentication requires macOS.');
        if (!['gcp', 'wif', 'business_licensed_enterprise'].includes(profile?.auth_method)) {
          throw failure('ERR_NATIVE_METHOD', 'Cannot identify an unsupported native authentication method.');
        }
        return `antigravity/cli/${metadata.version} (aidev_client; os_type=${metadata.platform}; arch=${metadata.arch}; cl=${metadata.cl}; auth_method=${profile.auth_method})`;
      } catch (error) { throw publicError(error); }
    },
    binding,
  };
}
