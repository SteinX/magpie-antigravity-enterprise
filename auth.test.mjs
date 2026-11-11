import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeSession } from './auth.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const encode = value => 'go-keyring-base64:' + Buffer.from(JSON.stringify(value)).toString('base64');
const decode = value => JSON.parse(Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString());
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function native(overrides = {}) {
  return {
    token: { access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer', expiry: new Date(NOW + 3600_000).toISOString() },
    auth_method: 'gcp', wif_provider: '', saved_wif_provider: 'previous-provider', project_id: 'native-project', region: 'native-region',
    user_tier: 'native-tier', tier_display_name: 'Native tier', writer_id: 'native-writer', extra: { preserved: true },
    ...overrides,
  };
}
function fixture(initial = native(), options = {}) {
  let raw = encode(initial);
  let queue = Promise.resolve();
  const principalMap = new Map();
  const calls = { reads: 0, commits: 0, oauthConfigs: 0, renewals: 0, userinfo: 0, urls: [], forms: [], signals: [] };
  const deps = {
    now: () => NOW,
    metadata: async () => ({ version: '2.31.0', cl: '1017595969', platform: 'darwin', arch: 'arm64' }),
    readCredential: async ({ signal } = {}) => {
      calls.reads++;
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      return raw;
    },
    readPrincipal: async key => principalMap.get(key),
    writePrincipal: async (key, value) => { principalMap.set(key, value); },
    withRefreshLock: async (work, signal) => {
      const previous = queue;
      const released = deferred();
      queue = released.promise;
      try {
        await previous;
        if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        return await work({ commit: async (expected, replacement) => {
          await options.beforeCommit?.();
          if (raw !== expected) return false;
          calls.commits++;
          raw = replacement;
          return true;
        } });
      } finally { released.resolve(); }
    },
    oauthConfig: async value => {
      calls.oauthConfigs++;
      return value.wif_provider
        ? { url: 'https://sts.googleapis.com/v1/oauthtoken', clientId: 'test-workforce-client' }
        : { url: 'https://oauth2.googleapis.com/token', clientId: 'test-cloud-client', clientSecret: 'test-public-client-config' };
    },
    fetch: async (url, request) => {
      if (url.endsWith('/userinfo')) {
        calls.userinfo++;
        return options.userinfo ? options.userinfo(url, request) : json({ id: 'account-A' });
      }
      calls.renewals++;
      calls.urls.push(url);
      calls.forms.push(Object.fromEntries(request.body));
      calls.signals.push(request.signal);
      return options.refresh ? options.refresh(url, request) : json({ access_token: `renewed-access-${calls.renewals}`, expires_in: 3600 });
    },
  };
  const sessionOptions = { stateDir: join(tmpdir(), `auth-unit-${randomUUID()}`), _deps: deps };
  return {
    session: createNativeSession(sessionOptions),
    freshSession: () => createNativeSession(sessionOptions),
    deps, calls, principalMap,
    get value() { return decode(raw); },
    set value(value) { raw = encode(value); },
    set raw(value) { raw = value; },
    sessionOptions,
  };
}

test('preserves native fields and keeps caller license selection separate', async () => {
  const f = fixture();
  const config = { projectId: 'user-project', location: 'user-location', authMethod: 'auto', wifProvider: '' };
  const original = structuredClone(config);
  const result = await f.session.profile({ config });
  assert.equal(result.project_id, 'native-project');
  assert.equal(result.region, 'native-region');
  assert.equal(result.writer_id, 'native-writer');
  assert.deepEqual(config, original);
  assert.equal(f.calls.renewals, 0);
  assert.equal(await f.session.identity(result), 'antigravity/2.31.0 (aidev_client; os_type=darwin; arch=arm64; cl=1017595969; auth_method=gcp)');
  assert.equal(f.session.binding(result).length, 64);
});

test('refreshes only below the five-minute boundary', async () => {
  const f = fixture(native({ token: { ...native().token, expiry: new Date(NOW + 300_000).toISOString() } }));
  await f.session.profile();
  assert.equal(f.calls.renewals, 0);
  f.value = { ...f.value, token: { ...f.value.token, expiry: new Date(NOW + 299_999).toISOString() } };
  await f.session.profile();
  assert.equal(f.calls.renewals, 1);
  assert.equal(f.calls.commits, 1);
});

test('selects the effective refresh mechanism across native labels and explicit choices', async t => {
  const profiles = [
    { auth_method: 'gcp', wif_provider: '', effective: 'gcp' },
    { auth_method: 'gcp', wif_provider: 'native-provider', effective: 'wif' },
    { auth_method: 'wif', wif_provider: '', effective: undefined },
    { auth_method: 'wif', wif_provider: 'native-provider', effective: 'wif' },
    { auth_method: 'business_licensed_enterprise', wif_provider: '', effective: 'gcp' },
    { auth_method: 'business_licensed_enterprise', wif_provider: 'native-provider', effective: 'wif' },
  ];
  for (const { auth_method, wif_provider, effective } of profiles) {
    for (const authMethod of ['auto', 'gcp', 'wif']) {
      await t.test(`${auth_method}, provider ${wif_provider ? 'present' : 'absent'}, choice ${authMethod}`, async () => {
        const f = fixture(native({ auth_method, wif_provider }));
        const original = f.value;
        const config = { authMethod, wifProvider: wif_provider, projectId: 'caller-project', location: 'caller-location' };
        const originalConfig = structuredClone(config);
        if (!effective || (authMethod !== 'auto' && authMethod !== effective)) {
          await assert.rejects(f.session.profile({ forceRefresh: true, config }), {
            code: effective ? 'ERR_NATIVE_ACCOUNT_CHANGED' : 'ERR_NATIVE_METHOD',
          });
          assert.equal(f.calls.oauthConfigs, 0);
          assert.equal(f.calls.renewals, 0);
          assert.equal(f.calls.userinfo, 0);
          assert.equal(f.calls.commits, 0);
          assert.equal(f.principalMap.size, 0);
          assert.deepEqual(f.value, original);
        } else {
          const result = await f.session.profile({ forceRefresh: true, config });
          assert.equal(f.calls.oauthConfigs, 1);
          assert.equal(f.calls.renewals, 1);
          assert.equal(f.calls.commits, 1);
          assert.deepEqual(f.calls.urls, [effective === 'wif' ? 'https://sts.googleapis.com/v1/oauthtoken' : 'https://oauth2.googleapis.com/token']);
          assert.equal(f.calls.forms[0].client_id, effective === 'wif' ? 'test-workforce-client' : 'test-cloud-client');
          assert.equal('client_secret' in f.calls.forms[0], effective === 'gcp');
          for (const value of [result, f.value]) {
            assert.equal(value.auth_method, auth_method);
            assert.equal(value.wif_provider, wif_provider);
            assert.equal(value.project_id, 'native-project');
            assert.equal(value.region, 'native-region');
          }
          assert.equal(await f.session.identity(result), `antigravity/2.31.0 (aidev_client; os_type=darwin; arch=arm64; cl=1017595969; auth_method=${auth_method})`);
        }
        assert.deepEqual(config, originalConfig);
      });
    }
  }
});

test('rejects provider mismatches before automatic or forced renewal', async t => {
  for (const forceRefresh of [false, true]) {
    for (const [auth_method, wif_provider, wifProvider] of [
      ['gcp', '', 'unexpected-provider'],
      ['gcp', 'native-provider', 'other-provider'],
      ['wif', 'native-provider', 'other-provider'],
      ['business_licensed_enterprise', '', 'unexpected-provider'],
      ['business_licensed_enterprise', 'native-provider', 'other-provider'],
    ]) {
      await t.test(`${auth_method}, provider ${wif_provider ? 'present' : 'absent'}, forced ${forceRefresh}`, async () => {
        const f = fixture(native({ auth_method, wif_provider, token: { ...native().token, expiry: new Date(NOW - 1).toISOString() } }));
        const original = f.value;
        await assert.rejects(f.session.profile({ forceRefresh, config: { authMethod: 'auto', wifProvider } }), { code: 'ERR_NATIVE_ACCOUNT_CHANGED' });
        assert.equal(f.calls.oauthConfigs, 0);
        assert.equal(f.calls.renewals, 0);
        assert.equal(f.calls.userinfo, 0);
        assert.equal(f.calls.commits, 0);
        assert.equal(f.principalMap.size, 0);
        assert.deepEqual(f.value, original);
      });
    }
  }
});

test('rejects unsupported native labels even when a provider is present', async () => {
  for (const wif_provider of ['', 'native-provider']) {
    const f = fixture(native({ auth_method: 'unsupported', wif_provider }));
    await assert.rejects(f.session.profile({ forceRefresh: true, config: { authMethod: 'auto' } }), { code: 'ERR_NATIVE_METHOD' });
    assert.equal(f.calls.oauthConfigs, 0);
    assert.equal(f.calls.renewals, 0);
    assert.equal(f.calls.commits, 0);
  }
});

test('retains the binding when writer, project, or region changes for the same account', async () => {
  const f = fixture();
  const first = await f.session.profile();
  f.value = { ...f.value, writer_id: 'new-process', project_id: 'new-native-license', region: 'new-native-region' };
  const next = await f.session.profile();
  assert.equal(f.session.binding(first), f.session.binding(next));
});

test('refuses another account even when its project and provider match', async () => {
  let account = 'account-A';
  const f = fixture(native(), { userinfo: () => json({ id: account }) });
  const first = await f.session.profile();
  account = 'account-B';
  f.value = { ...f.value, token: { ...f.value.token, access_token: 'other-access', refresh_token: 'other-refresh' } };
  await assert.rejects(f.session.profile(), { code: 'ERR_NATIVE_ACCOUNT_CHANGED' });
  const next = await f.freshSession().profile();
  assert.notEqual(f.session.binding(first), f.session.binding(next));
});

test('shares one renewal while one waiting consumer cancels', async () => {
  const entered = deferred();
  const finish = deferred();
  const f = fixture(native(), { refresh: async () => { entered.resolve(); await finish.promise; return json({ access_token: 'shared-access', expires_in: 3600 }); } });
  const cancel = new AbortController();
  const a = f.session.profile({ forceRefresh: true, signal: cancel.signal });
  const b = f.session.profile({ forceRefresh: true });
  await entered.promise;
  const rejected = assert.rejects(a, { name: 'AbortError' });
  cancel.abort();
  await rejected;
  assert.equal(f.calls.signals[0].aborted, false);
  finish.resolve();
  assert.equal((await b).token.access_token, 'shared-access');
  assert.equal(f.calls.renewals, 1);
  assert.equal(f.calls.commits, 1);
});

test('last consumer cancellation aborts a pending renewal without saving', async () => {
  const entered = deferred();
  const f = fixture(native(), { refresh: async (_url, request) => {
    entered.resolve();
    await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('private detail'), { name: 'AbortError' })), { once: true }));
  } });
  const cancel = new AbortController();
  const pending = f.session.profile({ forceRefresh: true, signal: cancel.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  cancel.abort();
  await rejected;
  assert.equal(f.calls.signals[0].aborted, true);
  assert.equal(f.calls.commits, 0);
});

test('passes cancellation to direct native keychain reads', async () => {
  const entered = deferred();
  const f = fixture();
  f.deps.readCredential = ({ signal }) => new Promise((_resolve, reject) => {
    entered.resolve();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('credential body'), { name: 'AbortError' })), { once: true });
  });
  const session = f.freshSession();
  const cancel = new AbortController();
  const pending = session.profile({ signal: cancel.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  cancel.abort();
  await rejected;
});

test('preserves an app metadata change made during renewal', async () => {
  let f;
  f = fixture(native(), { refresh: async () => {
    f.value = { ...f.value, project_id: 'app-selected-project', extra: { preserved: 'new' }, writer_id: 'new-native-writer' };
    return json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 });
  } });
  const result = await f.session.profile({ forceRefresh: true });
  assert.equal(result.project_id, 'app-selected-project');
  assert.deepEqual(f.value.extra, { preserved: 'new' });
  assert.equal(f.value.writer_id, 'new-native-writer');
  assert.equal(f.value.token.refresh_token, 'rotated');
});

test('never overwrites another native account written during the network request', async () => {
  let f;
  f = fixture(native(), { refresh: async () => {
    f.value = { ...f.value, token: { ...f.value.token, refresh_token: 'account-B-refresh', access_token: 'account-B-access' } };
    return json({ access_token: 'renewed-A', expires_in: 3600 });
  } });
  await assert.rejects(f.session.profile({ forceRefresh: true }), { code: 'ERR_NATIVE_ACCOUNT_CHANGED' });
  assert.equal(f.calls.commits, 0);
  assert.equal(f.value.token.access_token, 'account-B-access');
});

test('the immediate native compare rejects a change after the JS reread', async () => {
  let f;
  f = fixture(native(), { beforeCommit: async () => { f.value = { ...f.value, token: { ...f.value.token, refresh_token: 'changed-at-commit' } }; } });
  await assert.rejects(f.session.profile({ forceRefresh: true }), { code: 'ERR_NATIVE_ACCOUNT_CHANGED' });
  assert.equal(f.calls.commits, 0);
  assert.equal(f.value.token.refresh_token, 'changed-at-commit');
});

test('opaque workforce lineage survives our rotations and a new session', async () => {
  let rotation = 0;
  const f = fixture(native({ wif_provider: 'workforce-provider' }), {
    userinfo: () => json({ error: 'opaque token' }, 401),
    refresh: () => json({ access_token: `workforce-access-${++rotation}`, refresh_token: `workforce-refresh-${rotation}`, expires_in: 3600 }),
  });
  const first = await f.session.profile();
  const second = await f.session.profile({ forceRefresh: true });
  const nextHost = await f.freshSession().profile();
  assert.equal(f.session.binding(first), f.session.binding(second));
  assert.equal(f.session.binding(first), f.session.binding(nextHost));
  assert.equal(f.calls.renewals, 2);
  assert.equal(f.calls.forms[0].client_id, 'test-workforce-client');
  assert.equal('client_secret' in f.calls.forms[0], false);
  for (const [key, value] of f.principalMap) {
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.match(value, /^[a-f0-9]{64}$/);
  }
});

test('unknown external workforce token replacement requires explicit rebind', async () => {
  const f = fixture(native({ wif_provider: 'same-workforce-provider' }), { userinfo: () => json({}, 401) });
  const first = await f.session.profile();
  f.value = { ...f.value, token: { ...f.value.token, access_token: 'external-access', refresh_token: 'external-refresh' } };
  await assert.rejects(f.session.profile(), { code: 'ERR_NATIVE_ACCOUNT_CHANGED' });
  const rebound = await f.freshSession().profile();
  assert.notEqual(f.session.binding(first), f.session.binding(rebound));
});

test('rejects malformed native data and redacts untrusted failure details', async () => {
  const f = fixture();
  f.raw = 'go-keyring-base64:' + Buffer.from('{"secret":"test-sensitive-value"').toString('base64');
  await assert.rejects(f.session.profile(), error => error.code === 'ERR_NATIVE_FORMAT' && !JSON.stringify(error).includes('test-sensitive-value'));
  f.deps.readCredential = async () => { throw new Error('stderr includes test-sensitive-value'); };
  await assert.rejects(f.freshSession().profile(), error => !String(error.stack).includes('test-sensitive-value'));
});

test('a failed renewal neither overwrites native credentials nor exposes its body', async () => {
  const f = fixture(native(), { refresh: () => json({ error_description: 'test-sensitive-value' }, 400) });
  const original = f.value;
  await assert.rejects(f.session.profile({ forceRefresh: true }), error => error.code === 'ERR_NATIVE_REFRESH' && !String(error.stack).includes('test-sensitive-value'));
  assert.deepEqual(f.value, original);
  assert.equal(f.calls.commits, 0);
});

test('uses installed WIF client evidence for every supported native label', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-client-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'Contents/Resources/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'language_server'), 'native binary fixture a2a6f0e3e-3ff0-462b-869a-47277df4c806');
  for (const auth_method of ['gcp', 'wif', 'business_licensed_enterprise']) {
    for (const authMethod of ['auto', 'wif']) {
      await t.test(`${auth_method}, choice ${authMethod}`, async () => {
        const f = fixture(native({ auth_method, wif_provider: 'native-workforce-provider' }));
        const { oauthConfig: _unused, ...dependencies } = f.deps;
        const session = createNativeSession({ ...f.sessionOptions, appPath: directory, _deps: dependencies });
        const result = await session.profile({ forceRefresh: true, config: { authMethod, wifProvider: '' } });
        assert.deepEqual(f.calls.urls, ['https://sts.googleapis.com/v1/oauthtoken']);
        assert.equal(f.calls.forms[0].client_id, 'a2a6f0e3e-3ff0-462b-869a-47277df4c806');
        assert.equal('client_secret' in f.calls.forms[0], false);
        assert.equal(result.auth_method, auth_method);
      });
    }
  }
});

test('reports missing installed OAuth evidence for the effective mechanism before renewal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-missing-client-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profiles = [
    { auth_method: 'gcp', wif_provider: '', authMethod: 'gcp', message: /supported enterprise OAuth configuration/ },
    { auth_method: 'business_licensed_enterprise', wif_provider: '', authMethod: 'gcp', message: /supported enterprise OAuth configuration/ },
    { auth_method: 'gcp', wif_provider: 'native-provider', authMethod: 'wif', message: /expected workforce OAuth client/ },
    { auth_method: 'wif', wif_provider: 'native-provider', authMethod: 'wif', message: /expected workforce OAuth client/ },
    { auth_method: 'business_licensed_enterprise', wif_provider: 'native-provider', authMethod: 'wif', message: /expected workforce OAuth client/ },
  ];
  for (const [index, { auth_method, wif_provider, authMethod, message }] of profiles.entries()) {
    await t.test(`${auth_method}, effective ${authMethod}`, async () => {
      const appPath = join(directory, String(index));
      const bin = join(appPath, 'Contents/Resources/bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'language_server'), 'native binary fixture without supported OAuth configuration');
      const f = fixture(native({ auth_method, wif_provider }));
      const original = f.value;
      const { oauthConfig: _unused, ...dependencies } = f.deps;
      const session = createNativeSession({ ...f.sessionOptions, appPath, _deps: dependencies });
      await assert.rejects(session.profile({ forceRefresh: true, config: { authMethod } }), { code: 'ERR_NATIVE_CLIENT', message });
      assert.equal(f.calls.renewals, 0);
      assert.equal(f.calls.commits, 0);
      assert.deepEqual(f.value, original);
    });
  }
});

test('persists a rotated native token even when nonsecret binding storage fails', async () => {
  const f = fixture(native(), { refresh: () => json({ access_token: 'valid-new-access', refresh_token: 'valid-new-refresh', expires_in: 3600 }) });
  f.deps.writePrincipal = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(f.freshSession().profile({ forceRefresh: true }), { code: 'ERR_NATIVE_AUTH' });
  assert.equal(f.calls.commits, 1);
  assert.equal(f.value.token.refresh_token, 'valid-new-refresh');
});

test('does not discard a received refresh token when the final caller cancels during commit', async () => {
  const entered = deferred();
  const finish = deferred();
  const f = fixture(native(), {
    refresh: () => json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    beforeCommit: async () => { entered.resolve(); await finish.promise; },
  });
  const cancel = new AbortController();
  const pending = f.session.profile({ forceRefresh: true, signal: cancel.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  cancel.abort();
  await rejected;
  assert.equal(f.calls.signals[0].aborted, false);
  // Join the still-owned renewal, then let its guarded commit finish.
  const remaining = f.freshSession().profile({ forceRefresh: true });
  finish.resolve();
  assert.equal((await remaining).token.refresh_token, 'new-refresh');
  assert.equal(f.calls.renewals, 1);
  assert.equal(f.calls.commits, 1);
});

test('marks revoked authorization for rebind while retaining transient failure semantics', async () => {
  for (const [status, code, expired] of [[400, 'invalid_grant', true], [400, 'unauthorized_client', true], [401, 'unknown', true], [503, 'temporarily_unavailable', false], [400, 'invalid_request', false]]) {
    const f = fixture(native(), { refresh: () => json({ error: code, error_description: 'test-sensitive-value' }, status) });
    await assert.rejects(f.session.profile({ forceRefresh: true }), error => {
      assert.equal(error.signIn === 'expired', expired);
      assert.equal(String(error.stack).includes('test-sensitive-value'), false);
      return error.code === 'ERR_NATIVE_REFRESH';
    });
    assert.equal(f.calls.commits, 0);
  }
});
