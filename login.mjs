import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { nativeOAuthConfig } from './auth.mjs';
import { nativeFetch } from './transport.mjs';

const GCP_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
const WIF_AUTH_URL = 'https://auth.cloud.google/authorize';
const CALLBACK_PATH = '/auth/callback';
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const MAX_TOKEN_RESPONSE_BYTES = 128 * 1024;
const MAX_BIND_ATTEMPTS = 8;

// Conservative base 5 scopes from native getOAuthConfig; conditional aicode scope omitted pending upstream boolean confirmation.
const GCP_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

const WIF_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'openid',
  'email',
  'profile',
  'offline_access',
].join(' ');

const SAFE_OAUTH_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
]);

const RESPONSE_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  connection: 'close',
};

export class EnterpriseLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnterpriseLoginError';
    this.code = code;
  }
}

const loginFailure = (code, message) => new EnterpriseLoginError(code, message);
const aborted = () => Object.assign(new Error('Enterprise browser sign-in cancelled.'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };
const UNAVAILABLE_FAMILY_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT', 'ENETUNREACH']);

function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw loginFailure('ERR_LOGIN_CONFIG', 'Choose a supported enterprise authentication method.');
  }
  const authMethod = config.authMethod;
  if (authMethod !== 'gcp' && authMethod !== 'wif') {
    throw loginFailure('ERR_LOGIN_CONFIG', 'Choose Google Cloud SSO or Workforce Identity Federation for browser sign-in.');
  }
  if (authMethod === 'gcp') {
    if (config.wifProvider !== undefined && typeof config.wifProvider !== 'string') {
      throw loginFailure('ERR_LOGIN_CONFIG', 'WIF provider must be a string when supplied.');
    }
    return { authMethod: 'gcp', wifProvider: '' };
  }
  if (typeof config.wifProvider !== 'string') {
    throw loginFailure('ERR_LOGIN_CONFIG', 'Enter your Workforce Identity Federation provider.');
  }
  const normalized = config.wifProvider.trim()
    .replace(/^https:\/\/iam\.googleapis\.com\/+/i, '')
    .replace(/^\/\/iam\.googleapis\.com\/+/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^locations\/global\/workforcePools\/[A-Za-z0-9._-]+\/providers\/[A-Za-z0-9._-]+$/.test(normalized)) {
    throw loginFailure('ERR_LOGIN_CONFIG', 'WIF provider must have the form locations/global/workforcePools/POOL/providers/PROVIDER.');
  }
  return { authMethod: 'wif', wifProvider: normalized };
}

function buildAuthorizationURL(config, clientId, redirectUri, state, challenge) {
  const url = new URL(config.authMethod === 'wif' ? WIF_AUTH_URL : GCP_AUTH_URL);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('scope', config.authMethod === 'wif' ? WIF_SCOPES : GCP_SCOPES);
  params.set('state', state);
  params.set('code_challenge', challenge);
  params.set('code_challenge_method', 'S256');
  params.set('access_type', 'offline');
  if (config.authMethod === 'wif') {
    params.set('provider_name', config.wifProvider);
  } else {
    params.set('prompt', 'consent');
  }
  return url.toString();
}

function parseUniqueParams(rawSearch) {
  const seen = new Set();
  const values = new Map();
  const search = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  if (!search) return values;
  const params = new URLSearchParams(search);
  for (const [key, value] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
    values.set(key, value);
  }
  return values;
}

function respondPlain(response, status, text) {
  const body = Buffer.from(text, 'utf8');
  response.writeHead(status, { ...RESPONSE_HEADERS, 'content-length': String(body.length) });
  response.end(body);
}

function listenSingle(handler, sockets, host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    const onError = error => {
      try { server.close(); } catch { /* ignore */ }
      reject(error);
    };
    server.once('error', onError);
    server.listen({ port, host, ipv6Only: host === '::1' }, () => {
      server.removeListener('error', onError);
      server.on('error', () => {});
      resolve(server);
    });
  });
}

async function closeServers(servers, sockets, forceDestroy = true) {
  const closers = servers.map(server => new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeIdleConnections?.();
    if (forceDestroy) server.closeAllConnections?.();
  }));
  if (forceDestroy) {
    for (const socket of sockets) socket.destroy();
  }
  await Promise.all(closers);
}

async function bindDualLoopback(handler, sockets, listenImpl, signal) {
  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
    checkAbort(signal);
    const active = [];
    let port = 0;
    let v4Unavailable = false;
    try {
      const v4 = await listenImpl(handler, sockets, '127.0.0.1', 0);
      active.push(v4);
      if (signal?.aborted) {
        await closeServers(active, sockets);
        throw aborted();
      }
      const address = v4.address();
      port = typeof address === 'object' && address ? address.port : 0;
    } catch (error) {
      await closeServers(active, sockets);
      if (signal?.aborted || error?.name === 'AbortError') throw aborted();
      if (!UNAVAILABLE_FAMILY_CODES.has(error?.code)) {
        throw loginFailure('ERR_LOGIN_LISTEN', 'Could not start local OAuth callback listener.');
      }
      v4Unavailable = true;
    }

    try {
      const v6 = await listenImpl(handler, sockets, '::1', port);
      active.push(v6);
      if (signal?.aborted) {
        await closeServers(active, sockets);
        throw aborted();
      }
      if (!port) {
        const address = v6.address();
        port = typeof address === 'object' && address ? address.port : 0;
      }
      if (port > 0) return { servers: active, port };
      await closeServers(active, sockets);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        await closeServers(active, sockets);
        throw aborted();
      }
      if (!v4Unavailable && UNAVAILABLE_FAMILY_CODES.has(error?.code) && port > 0) {
        return { servers: active, port };
      }
      await closeServers(active, sockets);
      if (!v4Unavailable && error?.code === 'EADDRINUSE') {
        continue;
      }
      throw loginFailure('ERR_LOGIN_LISTEN', 'Could not start local OAuth callback listener.');
    }
  }
  throw loginFailure('ERR_LOGIN_LISTEN', 'Could not allocate a matching IPv4/IPv6 loopback callback port.');
}

async function readBoundedJSON(response, maxBytes, signal) {
  checkAbort(signal);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    checkAbort(signal);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response exceeded the maximum allowed size.');
    }
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response exceeded the maximum allowed size.');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function validateTokenPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response was not a JSON object.');
  }
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response did not include a valid access token.');
  }
  if (typeof data.refresh_token !== 'string' || !data.refresh_token) {
    throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response did not include a refresh token.');
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
    !Number.isFinite(Date.now() + data.expires_in * 1000)) {
    throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response did not include a positive finite expiry.');
  }
  if (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) {
    throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response returned an unsupported token type.');
  }
  if (data.id_token !== undefined && (typeof data.id_token !== 'string' || !data.id_token)) {
    throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response included an invalid ID token field.');
  }
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: data.token_type ?? 'Bearer',
  };
  if (data.id_token !== undefined) token.id_token = data.id_token;
  return token;
}

async function exchangeAuthorizationCode({ code, redirectUri, verifier, client, fetchImpl, signal }) {
  checkAbort(signal);
  const form = new URLSearchParams();
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (client.authStyle === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret ?? ''}`).toString('base64')}`;
    headers['user-agent'] = 'Go-http-client/2.0';
    headers['accept-encoding'] = 'gzip';
  } else if (client.authStyle === 'form') {
    form.set('client_id', client.clientId);
    if (client.clientSecret) form.set('client_secret', client.clientSecret);
  } else {
    throw loginFailure('ERR_LOGIN_CONFIG', 'Unsupported native OAuth client authentication style.');
  }
  form.set('code', code);
  form.set('redirect_uri', redirectUri);
  form.set('code_verifier', verifier);
  form.set('grant_type', 'authorization_code');

  const timeoutSignal = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(client.url, {
      method: 'POST',
      headers,
      body: form,
      signal: requestSignal,
      redirect: 'error',
    });
  } catch {
    if (signal?.aborted) throw aborted();
    if (timeoutSignal.aborted) {
      throw loginFailure('ERR_LOGIN_TIMEOUT', 'Enterprise OAuth token exchange timed out.');
    }
    throw loginFailure('ERR_LOGIN_TOKEN_NETWORK', 'Enterprise OAuth token exchange request failed.');
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* ignore body cancel errors */ }
    throw loginFailure('ERR_LOGIN_TOKEN_HTTP', `Enterprise OAuth token exchange failed (HTTP ${response.status}).`);
  }
  let payload;
  try {
    payload = await readBoundedJSON(response, MAX_TOKEN_RESPONSE_BYTES, requestSignal);
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (timeoutSignal.aborted) {
      throw loginFailure('ERR_LOGIN_TIMEOUT', 'Enterprise OAuth token exchange timed out.');
    }
    if (error instanceof EnterpriseLoginError) throw error;
    throw loginFailure('ERR_LOGIN_TOKEN_INVALID', 'Enterprise OAuth token response was not valid JSON.');
  }
  return validateTokenPayload(payload);
}

/** Starts a loopback PKCE browser sign-in flow for an enterprise account. */
export async function startEnterpriseLogin(config, options = {}, { signal } = {}) {
  checkAbort(signal);
  const normalized = normalizeConfig(config);
  const { _deps = {}, ...clientOptions } = options ?? {};
  const oauthConfig = _deps.oauthConfig ?? nativeOAuthConfig;
  const fetchImpl = _deps.fetch ?? nativeFetch;
  const listenImpl = _deps.listen ?? listenSingle;
  const loginTimeoutMs = _deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;

  let client;
  try {
    client = await oauthConfig(normalized, { ...clientOptions, signal });
    checkAbort(signal);
    if (!client || typeof client.url !== 'string' || !client.url || typeof client.clientId !== 'string' || !client.clientId ||
      (client.authStyle !== 'basic' && client.authStyle !== 'form') ||
      (client.clientSecret !== undefined && typeof client.clientSecret !== 'string')) {
      throw loginFailure('ERR_LOGIN_CONFIG', 'Native OAuth client configuration is invalid.');
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw aborted();
    if (error instanceof EnterpriseLoginError || error?.name === 'NativeAuthError') throw error;
    throw loginFailure('ERR_LOGIN_CONFIG', 'Could not load native enterprise OAuth client configuration.');
  }

  const state = randomBytes(32).toString('base64url');
  let verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  let settled = false;
  let callbackConsumed = false;
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  callbackPromise.catch(() => {});

  const sockets = new Set();
  let servers = [];
  let allowedHosts = new Set();
  let gracefulClosePromise;
  let forcedClosePromise;

  const shutdownServers = (forceDestroy = true) => {
    if (forceDestroy) {
      forcedClosePromise ??= closeServers(servers, sockets, true);
      return forcedClosePromise;
    }
    gracefulClosePromise ??= closeServers(servers, sockets, false);
    return gracefulClosePromise;
  };

  let expiryTimer;
  const finishCallback = (error, code, waitForFlush = false) => {
    if (settled) return;
    settled = true;
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    if (error) {
      verifier = '';
      if (!waitForFlush) void shutdownServers(true);
      rejectCallback(error);
    } else {
      resolveCallback(code);
    }
  };
  const handleRequest = (request, response) => {
    request.resume();
    if (callbackConsumed || settled) {
      respondPlain(response, 409, 'Sign-in session is no longer active.');
      return;
    }
    const hostHeader = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : '';
    if (!allowedHosts.has(hostHeader)) {
      respondPlain(response, 400, 'Invalid callback host.');
      return;
    }
    if (request.method !== 'GET') {
      respondPlain(response, 405, 'Method not allowed.');
      return;
    }
    const rawUrl = request.url ?? '';
    if (!rawUrl.startsWith('/') || rawUrl.includes('#')) {
      respondPlain(response, 400, 'Invalid callback request.');
      return;
    }
    if (rawUrl.split('?', 1)[0] !== CALLBACK_PATH) {
      respondPlain(response, 404, 'Not found.');
      return;
    }
    let parsed;
    try {
      parsed = new URL(rawUrl, 'http://localhost');
    } catch {
      respondPlain(response, 400, 'Invalid callback request.');
      return;
    }
    if (parsed.pathname !== CALLBACK_PATH) {
      respondPlain(response, 404, 'Not found.');
      return;
    }
    const params = parseUniqueParams(parsed.search);
    if (!params) {
      respondPlain(response, 400, 'Duplicate callback parameters are not allowed.');
      return;
    }
    const returnedState = params.get('state');
    if (typeof returnedState !== 'string' || returnedState !== state) {
      respondPlain(response, 400, 'Invalid sign-in state.');
      return;
    }
    const oauthError = params.get('error');
    const code = params.get('code');
    if (oauthError !== undefined) {
      callbackConsumed = true;
      const activeSocket = response.socket;
      for (const socket of sockets) {
        if (socket !== activeSocket) socket.destroy();
      }
      void shutdownServers(false);
      const flushTimer = setTimeout(() => { void shutdownServers(true); }, 2_000);
      flushTimer.unref?.();
      const onDone = () => {
        clearTimeout(flushTimer);
        void shutdownServers(true);
      };
      response.once('finish', onDone);
      response.once('close', onDone);
      const safeCode = SAFE_OAUTH_ERRORS.has(oauthError) ? oauthError : 'authorization_failed';
      respondPlain(response, 400, 'Enterprise sign-in was not completed. You may close this window.');
      finishCallback(
        loginFailure(
          'ERR_LOGIN_DENIED',
          safeCode === 'access_denied'
            ? 'Enterprise browser sign-in was denied (access_denied).'
            : `Enterprise browser sign-in failed (${safeCode}).`,
        ),
        undefined,
        true,
      );
      return;
    }
    if (typeof code !== 'string' || !code || code.length > 4096) {
      respondPlain(response, 400, 'Missing authorization code.');
      return;
    }
    callbackConsumed = true;
    const activeSocket = response.socket;
    for (const socket of sockets) {
      if (socket !== activeSocket) socket.destroy();
    }
    void shutdownServers(false);
    const flushTimer = setTimeout(() => { void shutdownServers(true); }, 2_000);
    flushTimer.unref?.();
    const onDone = () => {
      clearTimeout(flushTimer);
      void shutdownServers(true);
    };
    response.once('finish', onDone);
    response.once('close', onDone);
    respondPlain(response, 200, 'Enterprise sign-in received. Return to Magpie to finish connecting your account.');
    finishCallback(null, code);
  };

  let onStartupAbort;
  if (signal) {
    onStartupAbort = () => {
      void closeServers(servers, sockets);
    };
    signal.addEventListener('abort', onStartupAbort, { once: true });
  }

  let port;
  try {
    const bound = await bindDualLoopback(handleRequest, sockets, listenImpl, signal);
    servers = bound.servers;
    port = bound.port;
    if (signal?.aborted) {
      await shutdownServers(true);
      throw aborted();
    }
  } catch (error) {
    await shutdownServers(true);
    throw error;
  } finally {
    if (onStartupAbort) signal.removeEventListener('abort', onStartupAbort);
  }

  // Initial authorize signal is removed once startup completes; host request lifecycle cannot cancel wait().
  let redirectUri;
  let url;
  try {
    allowedHosts = new Set([
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
    ]);
    redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
    url = buildAuthorizationURL(normalized, client.clientId, redirectUri, state, challenge);

    expiryTimer = setTimeout(() => {
      finishCallback(loginFailure('ERR_LOGIN_TIMEOUT', 'Enterprise browser sign-in timed out before callback completed.'));
    }, loginTimeoutMs);
    expiryTimer.unref?.();
  } catch (error) {
    clearTimeout(expiryTimer);
    await shutdownServers(true);
    throw error;
  }
  const exchangeController = new AbortController();
  let closed = false;
  let waitConsumers = 0;
  let exchangePromise;

  const close = async () => {
    closed = true;
    exchangeController.abort();
    finishCallback(aborted());
    await shutdownServers(true);
  };

  const wait = async ({ signal: waitSignal } = {}) => {
    if (waitSignal?.aborted) {
      if (waitConsumers === 0) await close();
      throw aborted();
    }
    if (closed) throw aborted();
    waitConsumers++;
    let released = false;
    const releaseConsumer = () => {
      if (released) return false;
      released = true;
      waitSignal?.removeEventListener('abort', onWaitAbort);
      exchangeController.signal.removeEventListener('abort', onFlowAbort);
      waitConsumers--;
      return true;
    };
    let closeWaitPromise;
    let rejectConsumer;
    const abortPromise = new Promise((_, reject) => { rejectConsumer = reject; });
    abortPromise.catch(() => {});
    const onFlowAbort = () => { rejectConsumer(aborted()); };
    const onWaitAbort = () => {
      if (!releaseConsumer()) return;
      if (waitConsumers === 0) closeWaitPromise = close();
      rejectConsumer(aborted());
    };
    waitSignal?.addEventListener('abort', onWaitAbort, { once: true });
    exchangeController.signal.addEventListener('abort', onFlowAbort, { once: true });
    if (waitSignal?.aborted) onWaitAbort();
    try {
      const code = await Promise.race([callbackPromise, abortPromise]);
      await Promise.race([shutdownServers(false), abortPromise]);
      if (closed || exchangeController.signal.aborted) throw aborted();
      if (!exchangePromise) {
        const currentVerifier = verifier;
        verifier = '';
        exchangePromise = exchangeAuthorizationCode({
          code,
          redirectUri,
          verifier: currentVerifier,
          client,
          fetchImpl,
          signal: exchangeController.signal,
        });
        exchangePromise.catch(() => {});
      }
      const token = await Promise.race([exchangePromise, abortPromise]);
      if (closed || exchangeController.signal.aborted) throw aborted();
      return token;
    } catch (error) {
      if (closeWaitPromise) await closeWaitPromise;
      else if (closed) await shutdownServers(true);
      else if (!waitSignal?.aborted) await Promise.race([shutdownServers(false), abortPromise]).catch(() => {});
      if (waitSignal?.aborted || closed || exchangeController.signal.aborted || error?.name === 'AbortError') {
        throw aborted();
      }
      throw error;
    } finally {
      releaseConsumer();
    }
  };
  return { url, wait, close };
}
