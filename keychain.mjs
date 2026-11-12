import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const IDENTIFIER = 'com.magpie.antigravity-enterprise.keychain';
const builds = new Map();
const verified = new Map();
const messages = {
  missing: ['ERR_NATIVE_KEYCHAIN_MISSING', 'No enterprise credential is stored in macOS Keychain. Sign in explicitly to connect.'],
  interaction: ['ERR_NATIVE_KEYCHAIN_ACCESS', 'macOS Keychain requires authorization. Reconnect explicitly and allow the Antigravity credential helper when prompted.'],
  denied: ['ERR_NATIVE_KEYCHAIN_ACCESS', 'macOS denied access to the Antigravity Keychain credential. Reconnect explicitly to authorize the credential helper.'],
  cancelled: ['ERR_NATIVE_KEYCHAIN_ACCESS', 'Keychain authorization was cancelled. Reconnect explicitly when you are ready to allow access.'],
  operation: ['ERR_NATIVE_KEYCHAIN', 'The guarded native Keychain operation failed.'],
  helper: ['ERR_NATIVE_KEYCHAIN_HELPER', 'The native credential helper could not be prepared or its signature is invalid.'],
};

export class KeychainError extends Error {
  constructor(kind = 'operation') {
    const safeKind = Object.hasOwn(messages, kind) ? kind : 'operation';
    const [code, message] = messages[safeKind];
    super(message);
    this.name = 'KeychainError';
    this.code = code;
    this.kind = safeKind;
    if (safeKind === 'missing') this.signIn = 'expired';
  }
}
const aborted = () => Object.assign(new Error('Native authentication cancelled.'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };
const exitError = code => new KeychainError(({ 10: 'missing', 11: 'interaction', 12: 'denied', 13: 'cancelled' })[code] ?? 'operation');

// stdout/stderr are private pipes. Never forward subprocess errors or attach
// captured output, command arguments, or stdin to any public error.
function command(file, args, { signal, input, timeout = 30_000, helper = false } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    let timedOut = false;
    const kill = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const onAbort = () => kill();
    const child = execFile(file, args, {
      encoding: 'utf8', detached: true, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        kill();
        reject(signal?.aborted ? aborted() : helper ? new KeychainError('helper') : timedOut ? new KeychainError() : exitError(error.code));
      } else if (signal?.aborted) reject(aborted());
      else resolve({ stdout, stderr });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    timer.unref();
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (signal?.aborted) onAbort();
  });
}

const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.uid].join(':');
async function verifyExecutable(path, signal) {
  checkAbort(signal);
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o222) || !(info.mode & 0o100)) throw new KeychainError('helper');
  const identity = fingerprint(info);
  if (verified.get(path) === identity) return path;
  await command('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '-R', `=identifier "${IDENTIFIER}"`, path], { signal, helper: true });
  const { stdout, stderr } = await command('/usr/bin/codesign', ['--display', '--verbose=4', '-r-', path], { signal, helper: true });
  const description = stdout + '\n' + stderr;
  // Ad-hoc identity must be bound to the actual CodeDirectory hash. An
  // identifier-only designated requirement would trust unrelated code.
  const cdhash = /^CDHash=([a-f0-9]{40})$/m.exec(description)?.[1];
  const requirement = /^#?\s*designated => (.+)$/m.exec(description)?.[1];
  if (!/^Signature=adhoc$/m.test(description) || !cdhash || requirement !== `cdhash H"${cdhash}"`) throw new KeychainError('helper');
  if (fingerprint(await lstat(path)) !== identity) throw new KeychainError('helper');
  verified.set(path, identity);
  return path;
}

async function buildExecutable(stateDir, source, destination, signal) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw new KeychainError('helper');
  try { return await verifyExecutable(destination, signal); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(join(stateDir, '.keychain-build-'));
  try {
    checkAbort(signal);
    const sourcePath = join(temporary, 'keychain-helper.swift');
    const binary = join(temporary, 'keychain-helper');
    await writeFile(sourcePath, source, { mode: 0o600, flag: 'wx' });
    await command('/usr/bin/xcrun', ['swiftc', '-O', '-module-name', 'MagpieAntigravityKeychain', sourcePath, '-o', binary], { signal, timeout: 120_000, helper: true });
    // Do not override the synthesized cdhash designated requirement.
    await command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', IDENTIFIER, '--timestamp=none', binary], { signal, helper: true });
    await chmod(binary, 0o500);
    await verifyExecutable(binary, signal);
    checkAbort(signal);
    // Atomic no-replace publication: a concurrent winner retains its identity.
    try { await link(binary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return await verifyExecutable(destination, signal);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function subscribeBuild(build, signal) {
  checkAbort(signal);
  build.consumers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      if (--build.consumers === 0 && !build.settled) build.controller.abort();
      return true;
    };
    const onAbort = () => { if (release()) reject(aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    build.promise.then(value => { if (release()) resolve(value); }, error => { if (release()) reject(error); });
    if (signal?.aborted) onAbort();
  });
}

/** Prepares code only; never accesses Keychain credentials. */
export async function prepareKeychainHelper(stateDir, { signal } = {}) {
  try {
    checkAbort(signal);
    const source = await readFile(new URL('./keychain-helper.swift', import.meta.url));
    checkAbort(signal);
    const version = createHash('sha256').update('signed-helper-v1\0' + process.arch + '\0').update(source).digest('hex');
    const destination = join(stateDir, `keychain-helper-${version}`);
    let build = builds.get(destination);
    if (!build || build.controller.signal.aborted) {
      build = { controller: new AbortController(), consumers: 0, settled: false };
      const own = build;
      own.promise = buildExecutable(stateDir, source, destination, own.controller.signal).finally(() => {
        own.settled = true;
        if (builds.get(destination) === own) builds.delete(destination);
      });
      own.promise.catch(() => {});
      builds.set(destination, own);
    }
    return await subscribeBuild(build, signal);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw aborted();
    throw error instanceof KeychainError ? new KeychainError(error.kind) : new KeychainError('helper');
  }
}

export async function readCredential(stateDir, { signal, interactive = false, _keychain } = {}) {
  const executable = await prepareKeychainHelper(stateDir, { signal });
  const args = ['read', interactive === true ? 'interactive' : 'noninteractive'];
  if (_keychain) args.push('--keychain', _keychain);
  const { stdout } = await command(executable, args, { signal });
  return stdout;
}

async function withLockProcess(stateDir, run, signal, { interactive = false, _keychain } = {}) {
  const executable = await prepareKeychainHelper(stateDir, { signal });
  checkAbort(signal);
  let child;
  let announce;
  let failReady;
  const ready = new Promise((resolve, reject) => { announce = resolve; failReady = reject; });
  const args = ['lock', interactive === true ? 'interactive' : 'noninteractive', join(stateDir, 'refresh.lock')];
  if (_keychain) args.push('--keychain', _keychain);
  const finished = new Promise((resolve, reject) => {
    try {
      child = execFile(executable, args, {
        encoding: 'utf8', signal, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 1024,
      }, (error, stdout) => {
        if (error) {
          const safe = signal?.aborted ? aborted() : exitError(error.code);
          failReady(safe);
          reject(safe);
        } else if (!stdout.startsWith('locked\n')) {
          const safe = new KeychainError();
          failReady(safe);
          reject(safe);
        } else resolve(stdout);
      });
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.startsWith('locked\n')) announce();
      });
      child.stdin.on('error', () => {});
    } catch {
      const safe = signal?.aborted ? aborted() : new KeychainError();
      failReady(safe);
      reject(safe);
    }
  });
  finished.catch(() => {});
  let sent = false;
  const send = async payload => {
    if (sent) throw new KeychainError();
    sent = true;
    child.stdin.end(payload);
    const output = await finished;
    if (output === 'locked\nchanged\n') return false;
    if (output !== 'locked\nsaved\n') throw new KeychainError();
    return true;
  };
  try {
    await ready;
    return await run(send);
  } finally {
    if (!sent) child?.stdin.end('\n');
    await finished;
  }
}

export async function installCredential(stateDir, expected, replacement, { signal, interactive = false, _keychain } = {}) {
  checkAbort(signal);
  if ((expected !== null && typeof expected !== 'string') || typeof replacement !== 'string') {
    throw new KeychainError();
  }
  const request = JSON.stringify({ operation: 'install', expected, replacement }) + '\n';
  if (Buffer.byteLength(request, 'utf8') > 2 * 1024 * 1024) throw new KeychainError();
  return withLockProcess(
    stateDir,
    send => send(request),
    signal,
    { interactive, _keychain },
  );
}

export async function withRefreshLock(stateDir, task, signal, options = {}) {
  return withLockProcess(stateDir, send => task({
    async commit(expected, replacement) {
      if (typeof expected !== 'string' || typeof replacement !== 'string') throw new KeychainError();
      return send(JSON.stringify({ expected, replacement }) + '\n');
    },
  }), signal, options);
}
