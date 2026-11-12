import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { inspect } from 'node:util';
import { EnterpriseLoginError, startEnterpriseLogin } from './login.mjs';

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

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function sendRawCallback({ host = '127.0.0.1', port, method = 'GET', path, hostHeader = `localhost:${port}` }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host,
      port,
      method,
      path,
      headers: { host: hostHeader },
      agent: false,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function canBindPort(host, port) {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen({ port, host, ipv6Only: host === '::1' }, resolve);
    });
    return true;
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT', 'ENETUNREACH'].includes(error?.code)) {
      return true;
    }
    return false;
  } finally {
    await new Promise(resolve => {
      if (!probe.listening) return resolve();
      probe.close(() => resolve());
    });
  }
}

function captureConsole(t) {
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => {
      logged.push(args.map(item => (typeof item === 'string' ? item : inspect(item, { depth: null }))).join(' '));
    });
  }
  return logged;
}

function createFixture(overrides = {}) {
  const exchanges = [];
  const configCalls = [];
  const oauthConfig = overrides.oauthConfig ?? (async (config, options = {}) => {
    configCalls.push({ config, options });
    options.signal?.throwIfAborted?.();
    if (config.authMethod === 'wif') {
      return {
        url: 'https://sts.googleapis.com/v1/oauthtoken',
        clientId: 'test-workforce-client-id',
        clientSecret: '',
        authStyle: 'basic',
      };
    }
    return {
      url: 'https://oauth2.googleapis.com/token',
      clientId: 'test-gcp-client-id.apps.googleusercontent.com',
      clientSecret: 'test-gcp-client-secret-marker',
      authStyle: 'form',
    };
  });

  const fetchImpl = overrides.fetch ?? (async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    const form = init.body instanceof URLSearchParams
      ? Object.fromEntries(init.body)
      : Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    const record = { url, method: init.method, headers, form, redirect: init.redirect, signal: init.signal };
    exchanges.push(record);
    if (overrides.onToken) return overrides.onToken(record);
    return json({
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

  return {
    exchanges,
    configCalls,
    options: {
      appPath: '/synthetic/Antigravity.app',
      _deps: {
        oauthConfig,
        fetch: fetchImpl,
        ...(overrides.listen ? { listen: overrides.listen } : {}),
        ...(overrides.loginTimeoutMs !== undefined ? { loginTimeoutMs: overrides.loginTimeoutMs } : {}),
      },
    },
  };
}

test('GCP authorization URL, S256 PKCE pairing, and form client exchange succeed without leaking secrets', async t => {
  const logged = captureConsole(t);
  const f = createFixture({
    onToken: () => json({
      access_token: 'gcp-access-token',
      refresh_token: 'gcp-refresh-token',
      expires_in: 3599,
      token_type: 'bearer',
      id_token: 'unverified.header.payload',
    }),
  });
  const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
  t.after(() => login.close());

  const authUrl = new URL(login.url);
  assert.equal(`${authUrl.origin}${authUrl.pathname}`, 'https://accounts.google.com/o/oauth2/auth');
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('client_id'), 'test-gcp-client-id.apps.googleusercontent.com');
  assert.equal(authUrl.searchParams.get('scope'), GCP_SCOPES);
  assert.equal(authUrl.searchParams.get('scope').includes('aicode'), false);
  assert.equal(authUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authUrl.searchParams.get('prompt'), 'consent');
  assert.equal(authUrl.searchParams.get('audience'), null);
  assert.equal(authUrl.searchParams.get('provider_name'), null);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');

  const state = authUrl.searchParams.get('state');
  const challenge = authUrl.searchParams.get('code_challenge');
  assert.equal(Buffer.from(state, 'base64url').length, 32);
  assert.equal(Buffer.from(challenge, 'base64url').length, 32);

  const redirect = new URL(authUrl.searchParams.get('redirect_uri'));
  assert.equal(redirect.protocol, 'http:');
  assert.equal(redirect.hostname, 'localhost');
  assert.equal(redirect.pathname, '/auth/callback');
  const port = Number(redirect.port);
  assert.ok(port > 0);

  const pendingToken = login.wait();
  const callbackResponse = await sendRawCallback({
    host: '127.0.0.1',
    port,
    path: `/auth/callback?code=synthetic-auth-code-123&state=${encodeURIComponent(state)}`,
  });
  assert.equal(callbackResponse.status, 200);
  assert.equal(callbackResponse.headers['cache-control'], 'no-store');
  assert.equal(callbackResponse.headers['referrer-policy'], 'no-referrer');
  assert.match(callbackResponse.headers['content-type'], /^text\/plain;/);
  assert.equal(callbackResponse.body.includes('synthetic-auth-code-123'), false);
  assert.equal(callbackResponse.body.includes(state), false);

  const token = await pendingToken;
  assert.deepEqual(token, {
    access_token: 'gcp-access-token',
    refresh_token: 'gcp-refresh-token',
    expires_in: 3599,
    token_type: 'bearer',
    id_token: 'unverified.header.payload',
  });

  assert.equal(f.exchanges.length, 1);
  const sent = f.exchanges[0];
  assert.equal(sent.url, 'https://oauth2.googleapis.com/token');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.form.grant_type, 'authorization_code');
  assert.equal(sent.form.code, 'synthetic-auth-code-123');
  assert.equal(sent.form.redirect_uri, redirect.toString());
  assert.equal(sent.form.client_id, 'test-gcp-client-id.apps.googleusercontent.com');
  assert.equal(sent.form.client_secret, 'test-gcp-client-secret-marker');

  const verifier = sent.form.code_verifier;
  assert.equal(Buffer.from(verifier, 'base64url').length, 32);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);

  assert.equal(await canBindPort('127.0.0.1', port), true);
  assert.equal(await canBindPort('::1', port), true);
  assert.deepEqual(logged, []);
});

test('WIF authorization URL normalizes provider_name, omits unobserved audience, and exchanges with Basic empty secret', async t => {
  const logged = captureConsole(t);
  const f = createFixture();
  const login = await startEnterpriseLogin({
    authMethod: 'wif',
    wifProvider: '  //iam.googleapis.com/locations/global/workforcePools/enterprise-pool/providers/okta-sso/  ',
  }, f.options);
  t.after(() => login.close());

  const authUrl = new URL(login.url);
  assert.equal(`${authUrl.origin}${authUrl.pathname}`, 'https://auth.cloud.google/authorize');
  assert.equal(authUrl.searchParams.get('client_id'), 'test-workforce-client-id');
  assert.equal(authUrl.searchParams.get('scope'), WIF_SCOPES);
  assert.equal(authUrl.searchParams.get('provider_name'), 'locations/global/workforcePools/enterprise-pool/providers/okta-sso');
  assert.equal(authUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authUrl.searchParams.get('audience'), null);
  assert.equal(authUrl.searchParams.get('prompt'), null);
  assert.equal(f.configCalls[0].config.wifProvider, 'locations/global/workforcePools/enterprise-pool/providers/okta-sso');

  const state = authUrl.searchParams.get('state');
  const challenge = authUrl.searchParams.get('code_challenge');
  const redirect = new URL(authUrl.searchParams.get('redirect_uri'));
  const port = Number(redirect.port);

  // Reachable on IPv6 ::1 when available, falling back to 127.0.0.1 if IPv6 loopback is disabled in host kernel.
  let callbackHost = '::1';
  let hostHeader = `[::1]:${port}`;
  try {
    const res = await sendRawCallback({
      host: callbackHost,
      port,
      hostHeader,
      path: `/auth/callback?code=wif-auth-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(res.status, 200);
  } catch (error) {
    if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT', 'ENETUNREACH', 'ECONNREFUSED'].includes(error?.code)) {
      throw error;
    }
    const res = await sendRawCallback({
      host: '127.0.0.1',
      port,
      hostHeader: `localhost:${port}`,
      path: `/auth/callback?code=wif-auth-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(res.status, 200);
  }

  const token = await login.wait();
  assert.equal(token.access_token, 'synthetic-access-token');
  assert.equal(token.refresh_token, 'synthetic-refresh-token');

  assert.equal(f.exchanges.length, 1);
  const sent = f.exchanges[0];
  assert.equal(sent.url, 'https://sts.googleapis.com/v1/oauthtoken');
  assert.equal(sent.headers.authorization, `Basic ${Buffer.from('test-workforce-client-id:').toString('base64')}`);
  assert.equal(sent.headers['user-agent'], 'Go-http-client/2.0');
  assert.equal(sent.headers['accept-encoding'], 'gzip');
  assert.equal(sent.form.client_id, undefined);
  assert.equal(sent.form.client_secret, undefined);
  assert.equal(sent.form.grant_type, 'authorization_code');
  assert.equal(sent.form.code, 'wif-auth-code');
  assert.equal(sent.form.redirect_uri, `http://localhost:${port}/auth/callback`);
  assert.equal(createHash('sha256').update(sent.form.code_verifier).digest('base64url'), challenge);
  assert.deepEqual(logged, []);
});

test('rejects invalid config inputs before loading OAuth client or opening ports', async () => {
  for (const bad of [
    null,
    {},
    { authMethod: 'auto' },
    { authMethod: 'wif' },
    { authMethod: 'wif', wifProvider: '   ' },
    { authMethod: 'wif', wifProvider: 'projects/123/locations/global/workloadIdentityPools/p/providers/q' },
    { authMethod: 'gcp', wifProvider: 123 },
  ]) {
    let called = false;
    const f = createFixture({ oauthConfig: async () => { called = true; throw new Error('unexpected'); } });
    await assert.rejects(startEnterpriseLogin(bad, f.options), error => {
      assert.ok(error instanceof EnterpriseLoginError);
      assert.equal(error.code, 'ERR_LOGIN_CONFIG');
      return true;
    });
    assert.equal(called, false);
  }
});

test('wrong state, host, method, path, missing code, or duplicate query params do not consume pending login', async t => {
  const f = createFixture();
  const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
  t.after(() => login.close());

  const authUrl = new URL(login.url);
  const state = authUrl.searchParams.get('state');
  const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);

  const badRequests = [
    { name: 'wrong host header', hostHeader: `evil.example:${port}`, path: `/auth/callback?code=bad&state=${state}`, status: 400 },
    { name: 'missing port in host header', hostHeader: 'localhost', path: `/auth/callback?code=bad&state=${state}`, status: 400 },
    { name: 'POST method', method: 'POST', path: `/auth/callback?code=bad&state=${state}`, status: 405 },
    { name: 'wrong path', path: `/oauth2callback?code=bad&state=${state}`, status: 404 },
    { name: 'asset path', path: '/favicon.ico', status: 404 },
    { name: 'normalized dot path', path: `/other/../auth/callback?code=bad&state=${state}`, status: 404 },
    { name: 'network path with other authority', path: `//evil.example/auth/callback?code=bad&state=${state}`, status: 404 },
    { name: 'fragment in request target', path: `/auth/callback?code=bad&state=${state}#fragment`, status: 400 },
    { name: 'mismatched state', path: '/auth/callback?code=attacker-code&state=wrong-state-marker', status: 400 },
    { name: 'missing state', path: '/auth/callback?code=attacker-code', status: 400 },
    { name: 'duplicate state', path: `/auth/callback?code=dup&state=${state}&state=${state}`, status: 400 },
    { name: 'duplicate code', path: `/auth/callback?code=first&code=second&state=${state}`, status: 400 },
    { name: 'missing code without error', path: `/auth/callback?state=${state}`, status: 400 },
    { name: 'deny with wrong state', path: '/auth/callback?error=access_denied&state=wrong-state', status: 400 },
  ];

  for (const item of badRequests) {
    const res = await sendRawCallback({
      port,
      method: item.method ?? 'GET',
      hostHeader: item.hostHeader ?? `localhost:${port}`,
      path: item.path,
    });
    assert.equal(res.status, item.status, item.name);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.body.includes('attacker-code'), false);
    assert.equal(res.body.includes('wrong-state-marker'), false);
    assert.equal(res.body.includes(state), false);
  }
  assert.equal(f.exchanges.length, 0);

  // Valid callback still succeeds and exchanges exactly once.
  const validRes = await sendRawCallback({
    port,
    hostHeader: `127.0.0.1:${port}`,
    path: `/auth/callback?code=legitimate-code&state=${encodeURIComponent(state)}`,
  });
  assert.equal(validRes.status, 200);
  const token = await login.wait();
  assert.equal(token.access_token, 'synthetic-access-token');
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.exchanges[0].form.code, 'legitimate-code');
});

test('only one valid callback can finish and concurrent wait() calls share one code exchange', async t => {
  const exchangeGate = deferred();
  const f = createFixture({
    onToken: async () => {
      await exchangeGate.promise;
      return json({
        access_token: 'single-exchange-access',
        refresh_token: 'single-exchange-refresh',
        expires_in: 3600,
      });
    },
  });
  const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
  t.after(() => login.close());

  const authUrl = new URL(login.url);
  const state = authUrl.searchParams.get('state');
  const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);

  const firstWait = login.wait();
  const secondWait = login.wait();

  const firstCallback = await sendRawCallback({
    port,
    path: `/auth/callback?code=first-valid-code&state=${encodeURIComponent(state)}`,
  });
  assert.equal(firstCallback.status, 200);

  // Subsequent callback attempt either hits closed socket or receives 409; never triggers a second exchange.
  try {
    const secondCallback = await sendRawCallback({
      port,
      path: `/auth/callback?code=second-replayed-code&state=${encodeURIComponent(state)}`,
    });
    assert.equal(secondCallback.status, 409);
  } catch (error) {
    assert.ok(['ECONNREFUSED', 'ECONNRESET'].includes(error?.code));
  }

  exchangeGate.resolve();
  const [tokenA, tokenB] = await Promise.all([firstWait, secondWait]);
  assert.deepEqual(tokenA, tokenB);
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.exchanges[0].form.code, 'first-valid-code');
});

test('OAuth denial with valid state rejects safely without reflecting query values or unhandled rejections', async t => {
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  const sensitiveDetail = 'sensitive-idp-assertion-detail-xyz';
  for (const [rawError, expectedFragment] of [
    ['access_denied', 'access_denied'],
    [`<script>${sensitiveDetail}</script>`, 'authorization_failed'],
  ]) {
    const f = createFixture();
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    t.after(() => login.close());

    const authUrl = new URL(login.url);
    const state = authUrl.searchParams.get('state');
    const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);

    // Trigger denial BEFORE attaching login.wait() to verify unhandledRejection suppression.
    const callbackRes = await sendRawCallback({
      port,
      path: `/auth/callback?error=${encodeURIComponent(rawError)}&error_description=${encodeURIComponent(sensitiveDetail)}&state=${encodeURIComponent(state)}`,
    });
    assert.equal(callbackRes.status, 400);
    assert.equal(callbackRes.body.includes(sensitiveDetail), false);
    assert.equal(callbackRes.body.includes('<script>'), false);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, false);

    await assert.rejects(login.wait(), error => {
      assert.ok(error instanceof EnterpriseLoginError);
      assert.equal(error.code, 'ERR_LOGIN_DENIED');
      assert.match(error.message, new RegExp(expectedFragment));
      assert.equal(inspect(error, { depth: null }).includes(sensitiveDetail), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.exchanges.length, 0);
    assert.equal(await canBindPort('127.0.0.1', port), true);
  }
});

test('upstream HTTP errors, network failures, and secrets never leak verifier, client secret, or response body', async t => {
  const logged = captureConsole(t);
  const upstreamSecret = 'upstream-private-token-body-detail';

  // HTTP 400 error body redaction
  {
    let capturedVerifier;
    const f = createFixture({
      onToken: req => {
        capturedVerifier = req.form.code_verifier;
        return json({ error: 'invalid_grant', error_description: upstreamSecret }, 400);
      },
    });
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    const authUrl = new URL(login.url);
    const state = authUrl.searchParams.get('state');
    const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);
    await sendRawCallback({ port, path: `/auth/callback?code=code-400&state=${encodeURIComponent(state)}` });

    await assert.rejects(login.wait(), error => {
      assert.ok(error instanceof EnterpriseLoginError);
      assert.equal(error.code, 'ERR_LOGIN_TOKEN_HTTP');
      assert.equal(error.message, 'Enterprise OAuth token exchange failed (HTTP 400).');
      assert.equal(error.cause, undefined);
      const dumped = inspect(error, { depth: null });
      assert.equal(dumped.includes(upstreamSecret), false);
      assert.equal(dumped.includes(capturedVerifier), false);
      assert.equal(dumped.includes('test-gcp-client-secret-marker'), false);
      return true;
    });
  }

  // Network exception redaction
  {
    let capturedVerifier;
    const f = createFixture({
      onToken: req => {
        capturedVerifier = req.form.code_verifier;
        throw new TypeError(`TLS socket failed: ${upstreamSecret}`, { cause: new Error(upstreamSecret) });
      },
    });
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    const authUrl = new URL(login.url);
    const state = authUrl.searchParams.get('state');
    const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);
    await sendRawCallback({ port, path: `/auth/callback?code=code-net&state=${encodeURIComponent(state)}` });

    await assert.rejects(login.wait(), error => {
      assert.ok(error instanceof EnterpriseLoginError);
      assert.equal(error.code, 'ERR_LOGIN_TOKEN_NETWORK');
      assert.equal(error.cause, undefined);
      const dumped = inspect(error, { depth: null });
      assert.equal(dumped.includes(upstreamSecret), false);
      assert.equal(dumped.includes(capturedVerifier), false);
      return true;
    });
  }
  assert.deepEqual(logged, []);
});

test('rejects malformed or oversized token responses without fallback values', async () => {
  const invalidResponses = [
    new Response('not-json', { status: 200 }),
    json(null),
    json([]),
    json({ refresh_token: 'r', expires_in: 3600 }),
    json({ access_token: '', refresh_token: 'r', expires_in: 3600 }),
    json({ access_token: 'a', expires_in: 3600 }),
    json({ access_token: 'a', refresh_token: '', expires_in: 3600 }),
    json({ access_token: 'a', refresh_token: 'r', expires_in: 0 }),
    json({ access_token: 'a', refresh_token: 'r', expires_in: -10 }),
    json({ access_token: 'a', refresh_token: 'r', expires_in: Number.NaN }),
    json({ access_token: 'a', refresh_token: 'r', expires_in: '3600' }),
    json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'MAC' }),
    json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: '' }),
    json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 42 }),
    new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, pad: 'x'.repeat(140 * 1024) }), { status: 200 }),
  ];

  for (const badResponse of invalidResponses) {
    const f = createFixture({ onToken: () => badResponse });
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    const authUrl = new URL(login.url);
    const state = authUrl.searchParams.get('state');
    const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);
    await sendRawCallback({ port, path: `/auth/callback?code=valid-code&state=${encodeURIComponent(state)}` });
    await assert.rejects(login.wait(), error => {
      assert.ok(error instanceof EnterpriseLoginError);
      assert.equal(error.code, 'ERR_LOGIN_TOKEN_INVALID');
      return true;
    });
  }
});

test('initial authorize signal cancels startup, but detaches once started so host lifecycle cannot cancel wait()', async t => {
  // Pre-aborted startup signal rejects before oauthConfig or listen
  {
    let called = false;
    const preAborted = new AbortController();
    preAborted.abort();
    const f = createFixture({ oauthConfig: async () => { called = true; throw new Error('unexpected'); } });
    await assert.rejects(startEnterpriseLogin({ authMethod: 'gcp' }, f.options, { signal: preAborted.signal }), { name: 'AbortError' });
    assert.equal(called, false);
  }

  // Aborting initial signal AFTER startEnterpriseLogin resolves does NOT cancel wait()
  {
    const authorizeController = new AbortController();
    const f = createFixture();
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options, { signal: authorizeController.signal });
    t.after(() => login.close());

    authorizeController.abort(new Error('Host authorize request completed'));

    const authUrl = new URL(login.url);
    const state = authUrl.searchParams.get('state');
    const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);
    const res = await sendRawCallback({ port, path: `/auth/callback?code=post-authorize-code&state=${encodeURIComponent(state)}` });
    assert.equal(res.status, 200);
    const token = await login.wait();
    assert.equal(token.access_token, 'synthetic-access-token');
  }
});

test('close(), wait signal cancellation, and callback expiry shut down open sockets and release ports cleanly', async t => {
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  // 1. Wait signal cancellation destroys hanging open TCP socket and releases port
  {
    const f = createFixture();
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    const port = Number(new URL(new URL(login.url).searchParams.get('redirect_uri')).port);

    const rawSocket = connectTcp({ host: '127.0.0.1', port });
    await new Promise((resolve, reject) => {
      rawSocket.once('connect', resolve);
      rawSocket.once('error', reject);
    });
    const socketClosed = new Promise(resolve => rawSocket.once('close', resolve));

    const waitController = new AbortController();
    const waiting = login.wait({ signal: waitController.signal });
    waitController.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    await socketClosed;
    assert.equal(await canBindPort('127.0.0.1', port), true);
  }

  // 2. Callback timeout before wait() is attached suppresses unhandledRejection and frees port
  {
    const f = createFixture({ loginTimeoutMs: 25 });
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    const port = Number(new URL(new URL(login.url).searchParams.get('redirect_uri')).port);

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(unhandled, false);
    assert.equal(await canBindPort('127.0.0.1', port), true);

    await assert.rejects(login.wait(), error => {
      assert.ok(error instanceof EnterpriseLoginError);
      assert.equal(error.code, 'ERR_LOGIN_TIMEOUT');
      return true;
    });
  }

  // 3. Explicit close() is idempotent and aborts an in-flight token exchange
  {
    const enteredToken = deferred();
    let tokenSignal;
    const f = createFixture({
      onToken: req => {
        tokenSignal = req.signal;
        enteredToken.resolve();
        return new Promise(() => {});
      },
    });
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    const authUrl = new URL(login.url);
    const state = authUrl.searchParams.get('state');
    const port = Number(new URL(authUrl.searchParams.get('redirect_uri')).port);

    const waiting = login.wait();
    await sendRawCallback({ port, path: `/auth/callback?code=slow-exchange&state=${encodeURIComponent(state)}` });
    await enteredToken.promise;
    await login.close();
    await login.close();
    assert.equal(tokenSignal.aborted, true);
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(await canBindPort('127.0.0.1', port), true);
  }
});

test('dual-stack loopback binding retries IPv6 port collisions and tolerates one unavailable address family', async t => {
  // Simulate EADDRINUSE on first ::1 attempt, succeeding on retry; never binds wildcard 0.0.0.0 or ::
  {
    const attemptedHosts = [];
    let v6Attempts = 0;
    const f = createFixture({
      listen: async (_handler, _sockets, host, port) => {
        attemptedHosts.push({ host, port });
        assert.notEqual(host, '0.0.0.0');
        assert.notEqual(host, '::');
        if (host === '::1' && ++v6Attempts === 1) {
          throw Object.assign(new Error('port taken on v6'), { code: 'EADDRINUSE' });
        }
        const assignedPort = port || (51000 + v6Attempts);
        return {
          listening: true,
          address: () => ({ port: assignedPort }),
          close: cb => cb?.(),
        };
      },
    });
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    await login.close();
    assert.deepEqual(attemptedHosts, [
      { host: '127.0.0.1', port: 0 },
      { host: '::1', port: 51000 },
      { host: '127.0.0.1', port: 0 },
      { host: '::1', port: 51001 },
    ]);
  }

  // Simulate IPv6 unavailable (EAFNOSUPPORT): succeeds on IPv4 alone
  {
    const f = createFixture({
      listen: async (_handler, _sockets, host, port) => {
        if (host === '::1') throw Object.assign(new Error('no ipv6'), { code: 'EAFNOSUPPORT' });
        return {
          listening: true,
          address: () => ({ port: port || 52123 }),
          close: cb => cb?.(),
        };
      },
    });
    const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
    assert.equal(new URL(new URL(login.url).searchParams.get('redirect_uri')).port, '52123');
    await login.close();
  }
});

test('token exchange uses one 30-second deadline and returns only a safe timeout error', async t => {
  const deadline = new AbortController();
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    deadlines.push(milliseconds);
    return deadline.signal;
  });
  const entered = deferred();
  const f = createFixture({
    onToken: request => new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('sensitive timeout diagnostic')), { once: true });
      entered.resolve();
    }),
  });
  const login = await startEnterpriseLogin({ authMethod: 'gcp' }, f.options);
  t.after(() => login.close());
  const authURL = new URL(login.url);
  const state = authURL.searchParams.get('state');
  const port = Number(new URL(authURL.searchParams.get('redirect_uri')).port);
  const waiting = login.wait();
  const rejected = assert.rejects(waiting, error => {
    assert.ok(error instanceof EnterpriseLoginError);
    assert.equal(error.code, 'ERR_LOGIN_TIMEOUT');
    assert.equal(error.cause, undefined);
    assert.equal(inspect(error, { depth: null }).includes('sensitive timeout diagnostic'), false);
    return true;
  });
  await sendRawCallback({ port, path: `/auth/callback?code=deadline-code&state=${state}` });
  await entered.promise;
  assert.deepEqual(deadlines, [30_000]);
  deadline.abort();
  await rejected;
  assert.equal(await canBindPort('127.0.0.1', port), true);
});

test('aborting while client config loads prevents listener allocation', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const configReady = deferred();
  let listened = false;
  const f = createFixture({
    oauthConfig: async (_config, options) => {
      assert.equal(options.signal, controller.signal);
      entered.resolve();
      return configReady.promise;
    },
    listen: async () => { listened = true; throw new Error('unexpected listener'); },
  });
  const starting = startEnterpriseLogin({ authMethod: 'gcp' }, f.options, { signal: controller.signal });
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  configReady.resolve({
    url: 'https://oauth2.googleapis.com/token', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', authStyle: 'form',
  });
  await rejected;
  assert.equal(listened, false);
});

test('startup cancellation and second-family failure close an already allocated loopback listener', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let port;
    const f = createFixture({
      listen: async (_handler, _sockets, host) => {
        if (host === '::1') throw new Error('sensitive bind failure detail');
        const server = createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        port = server.address().port;
        if (cancel) controller.abort();
        return server;
      },
    });
    await assert.rejects(startEnterpriseLogin({ authMethod: 'gcp' }, f.options, { signal: controller.signal }), error => {
      assert.equal(cancel ? error.name : error.code, cancel ? 'AbortError' : 'ERR_LOGIN_LISTEN');
      assert.equal(inspect(error, { depth: null }).includes('sensitive bind failure detail'), false);
      return true;
    });
    assert.ok(port > 0);
    assert.equal(await canBindPort('127.0.0.1', port), true);
  }
});
