import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { readCliMetadata } from './cli-metadata.mjs';

const CL = '1098765432';
const VERSION = '7.8.9';
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function stamp(cl = CL, timestamp = '1700000000') {
  const buffer = Buffer.alloc(48);
  buffer.write(cl, 0, 16, 'ascii');
  buffer.write(cl, 16, 16, 'ascii');
  buffer.write(timestamp, 32, 16, 'ascii');
  buffer.fill(1, 43); // Following native boolean flags are outside the timestamp.
  return buffer;
}

function macho({ arch = 'arm64', data = stamp(), sectionOffset = 512, protections = 5, sectionFlags = 0 } = {}) {
  const buffer = Buffer.alloc(sectionOffset + data.length);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  buffer.writeUInt32LE(2, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(152, 20);
  const command = 32;
  buffer.writeUInt32LE(0x19, command);
  buffer.writeUInt32LE(152, command + 4);
  buffer.write('__TEXT', command + 8, 'ascii');
  buffer.writeBigUInt64LE(0x100000000n, command + 24);
  buffer.writeBigUInt64LE(BigInt(buffer.length), command + 32);
  buffer.writeBigUInt64LE(BigInt(buffer.length), command + 48);
  buffer.writeUInt32LE(protections, command + 56);
  buffer.writeUInt32LE(protections, command + 60);
  buffer.writeUInt32LE(1, command + 64);
  const section = command + 72;
  buffer.write('__rodata', section, 'ascii');
  buffer.write('__TEXT', section + 16, 'ascii');
  buffer.writeBigUInt64LE(0x100000000n + BigInt(sectionOffset), section + 32);
  buffer.writeBigUInt64LE(BigInt(data.length), section + 40);
  buffer.writeUInt32LE(sectionOffset, section + 48);
  buffer.writeUInt32LE(sectionFlags, section + 64);
  data.copy(buffer, sectionOffset);
  return buffer;
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agy-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'agy');
  const binary = options.binary ?? macho(options);
  await writeFile(path, binary);
  const calls = [];
  const result = { directory, path, binary, calls, output: VERSION, onVersion: undefined };
  const deps = {
    platform: 'darwin', arch: options.arch ?? 'arm64',
    execFile(file, args, configuration, callback) {
      calls.push({ file, args, configuration });
      Promise.resolve().then(() => result.onVersion ? result.onVersion() : result.output)
        .then(output => callback(null, output), error => callback(error, ''));
    },
  };
  result.read = overrides => readCliMetadata(path, { _deps: { ...deps, ...overrides } });
  return result;
}

const assertSafe = (error, code, secret) => {
  assert.equal(error.name, 'CliMetadataError');
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(error.stdout, undefined);
  assert.equal(error.stderr, undefined);
  assert.equal(error.request, undefined);
  if (secret) assert.equal(inspect(error, { depth: null, showHidden: true }).includes(secret), false);
  return true;
};

test('reads CLI version and the structural runtime CL independently of compiler metadata', async t => {
  const data = Buffer.concat([
    Buffer.from('runtime.buildVersion=go1.26.1\0compiler CL:9876543210\0'),
    Buffer.alloc(29, 0xab), stamp(), Buffer.alloc(31, 0xcd),
  ]);
  const f = await fixture(t, { data, sectionOffset: 4096 });
  assert.deepEqual(await f.read(), { version: VERSION, cl: CL, platform: 'darwin', arch: 'arm64' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, f.path);
  assert.deepEqual(f.calls[0].args, ['--version']);
  assert.deepEqual(f.calls[0].configuration, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 });
});

test('supports official thin Darwin arm64 and x64 executables', async t => {
  for (const arch of ['arm64', 'x64']) {
    await t.test(arch, async t => {
      const f = await fixture(t, { arch });
      f.output = '12.34.56-beta.2+build.7\n';
      assert.deepEqual(await f.read(), { version: '12.34.56-beta.2+build.7', cl: CL, platform: 'darwin', arch });
    });
  }
});

test('finds stamps across scan boundaries without release-specific file offsets', async t => {
  const data = Buffer.alloc(128 * 1024 + 100, 0xcd);
  stamp('1234567890123').copy(data, 128 * 1024 - 19);
  const f = await fixture(t, { data, sectionOffset: 3072 });
  assert.equal((await f.read()).cl, '1234567890123');
});

test('stops the build timestamp at its NUL terminator without interpreting following flags', async t => {
  for (const data of [stamp(), stamp().subarray(0, 43), Buffer.concat([stamp().subarray(0, 43), Buffer.from([0xff, 0x31, 0x00, 0x02, 0x7f])])]) {
    await t.test(`section size ${data.length}, tail ${data.subarray(43).toString('hex')}`, async t => {
      const f = await fixture(t, { data });
      assert.equal((await f.read()).cl, CL);
    });
  }
});

test('rejects missing, malformed, or unmirrored runtime stamps before executing the CLI', async t => {
  const mismatched = stamp();
  mismatched[16] = 0x38;
  const badPadding = stamp();
  badPadding[15] = badPadding[31] = 0x61;
  const badTimestamp = stamp();
  badTimestamp[36] = 0x61;
  const badTimestampTerminator = stamp();
  badTimestampTerminator[42] = 0x31;
  for (const [name, data] of [
    ['compiler metadata alone', Buffer.from('go1.26.1\0Built at CL: 9876543210\0')],
    ['different CL mirrors', mismatched],
    ['nonzero CL padding', badPadding],
    ['nonnumeric build time', badTimestamp],
    ['missing timestamp terminator', badTimestampTerminator],
    ['truncated stamp', stamp().subarray(0, 42)],
    ['no NUL terminator', stamp('1234567890123456')],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t, { data });
      await assert.rejects(f.read(), { code: 'ERR_NATIVE_CLI_METADATA', message: /missing or corrupt/ });
      assert.equal(f.calls.length, 0);
    });
  }
});

test('rejects every ambiguous stamp, including repeated identical CLs', async t => {
  for (const other of [CL, '1234567890']) {
    await t.test(other, async t => {
      const f = await fixture(t, { data: Buffer.concat([stamp(), Buffer.alloc(17), stamp(other)]) });
      await assert.rejects(f.read(), { code: 'ERR_NATIVE_CLI_METADATA', message: /ambiguous build stamps/ });
      assert.equal(f.calls.length, 0);
    });
  }
});

test('reads only the declared read-only regular section', async t => {
  const outside = macho({ data: Buffer.alloc(48) });
  stamp().copy(outside, 256);
  const missingSection = macho();
  missingSection.fill(0, 104, 120);
  missingSection.write('__cstring', 104, 'ascii');
  for (const [name, binary, code] of [
    ['stamp outside section', outside, 'ERR_NATIVE_CLI_METADATA'],
    ['missing rodata section', missingSection, 'ERR_NATIVE_CLI_METADATA'],
    ['writable data', macho({ protections: 3 }), 'ERR_NATIVE_CLI_FORMAT'],
    ['unreadable data', macho({ protections: 4 }), 'ERR_NATIVE_CLI_FORMAT'],
    ['zero-fill section', macho({ sectionFlags: 1 }), 'ERR_NATIVE_CLI_FORMAT'],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t, { binary });
      await assert.rejects(f.read(), { code });
      assert.equal(f.calls.length, 0);
    });
  }
});

test('rejects unsupported and corrupt Mach-O layouts before executing a version command', async t => {
  const cases = [
    ['ELF', Buffer.from('\x7fELF unsupported executable')],
    ['universal Mach-O', Buffer.from([0xca, 0xfe, 0xba, 0xbe, ...Buffer.alloc(60)])],
  ];
  const mutate = (name, change) => { const binary = macho(); change(binary); cases.push([name, binary]); };
  mutate('32-bit Mach-O', binary => binary.writeUInt32LE(0xfeedface, 0));
  mutate('big-endian Mach-O', binary => binary.writeUInt32LE(0xcffaedfe, 0));
  mutate('non-executable Mach-O', binary => binary.writeUInt32LE(6, 12));
  mutate('truncated command table', binary => binary.writeUInt32LE(binary.length, 20));
  mutate('invalid command count', binary => binary.writeUInt32LE(100, 16));
  mutate('misaligned command size', binary => binary.writeUInt32LE(151, 36));
  mutate('invalid section count', binary => binary.writeUInt32LE(2, 96));
  mutate('section exceeds file', binary => binary.writeBigUInt64LE(BigInt(binary.length), 144));
  mutate('section overlaps header', binary => binary.writeUInt32LE(32, 152));
  mutate('segment exceeds file', binary => binary.writeBigUInt64LE(BigInt(binary.length + 1), 80));
  for (const [name, binary] of cases) {
    await t.test(name, async t => {
      const f = await fixture(t, { binary });
      await assert.rejects(f.read(), { code: 'ERR_NATIVE_CLI_FORMAT' });
      assert.equal(f.calls.length, 0);
    });
  }
});

test('fails closed for a binary or host architecture mismatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.read({ arch: 'x64' }), { code: 'ERR_NATIVE_CLI_ARCH' });
  await assert.rejects(f.read({ arch: 'ia32' }), { code: 'ERR_NATIVE_CLI_PLATFORM' });
  await assert.rejects(f.read({ platform: 'linux' }), { code: 'ERR_NATIVE_CLI_PLATFORM' });
  const unknown = macho();
  unknown.writeUInt32LE(0x01000012, 4);
  await writeFile(f.path, unknown);
  await assert.rejects(f.read(), { code: 'ERR_NATIVE_CLI_ARCH' });
  assert.equal(f.calls.length, 0);
});

test('never accepts mixed versions or exposes unexpected CLI output', async t => {
  const secret = 'synthetic-private-cli-output';
  const f = await fixture(t);
  for (const output of ['1.5.5\n2.31.0', 'antigravity 1.5.5', 'go1.26.1', `1.5.5\n${secret}`, '01.5.5', '', undefined]) {
    f.output = output;
    await assert.rejects(f.read(), error => assertSafe(error, 'ERR_NATIVE_CLI_VERSION', secret));
  }
  f.output = VERSION;
  assert.equal((await f.read()).version, VERSION);
  assert.equal(f.calls.length, 8);
});

test('shares concurrent version reads and caches unchanged files', async t => {
  const f = await fixture(t);
  const started = deferred();
  const release = deferred();
  f.onVersion = async () => { started.resolve(); await release.promise; return VERSION; };
  const first = f.read();
  const second = f.read();
  await started.promise;
  release.resolve();
  const [left, right] = await Promise.all([first, second]);
  assert.strictEqual(left, right);
  assert.strictEqual(await f.read(), left);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(f.calls.length, 1);
});

test('invalidates cached metadata when the same path receives a new inode of equal size', async t => {
  const f = await fixture(t);
  assert.equal((await f.read()).cl, CL);
  const replacement = join(f.directory, 'updated-agy');
  await writeFile(replacement, macho({ data: stamp('1234567890') }));
  await rename(replacement, f.path);
  f.output = '8.9.10';
  assert.deepEqual(await f.read(), { version: '8.9.10', cl: '1234567890', platform: 'darwin', arch: 'arm64' });
  assert.equal(f.calls.length, 2);
});

test('invalidates cached metadata after an in-place update changes the file size', async t => {
  const f = await fixture(t);
  await f.read();
  await writeFile(f.path, macho({ data: Buffer.concat([Buffer.alloc(19), stamp('123456789012')]) }));
  f.output = '8.9.10';
  assert.equal((await f.read()).cl, '123456789012');
  assert.equal((await f.read()).version, '8.9.10');
  assert.equal(f.calls.length, 2);
});

test('rejects version/CL mixing when the executable is replaced during --version', async t => {
  const f = await fixture(t);
  f.onVersion = async () => {
    const replacement = join(f.directory, 'updated-agy');
    await writeFile(replacement, macho({ data: stamp('1234567890') }));
    await rename(replacement, f.path);
    return '8.9.10';
  };
  await assert.rejects(f.read(), { code: 'ERR_NATIVE_CLI_CHANGED' });
  f.onVersion = undefined;
  f.output = '8.9.10';
  assert.deepEqual(await f.read(), { version: '8.9.10', cl: '1234567890', platform: 'darwin', arch: 'arm64' });
});

test('rejects an in-place same-size update during --version', async t => {
  const f = await fixture(t);
  f.onVersion = async () => {
    await writeFile(f.path, macho({ data: stamp('1234567890') }));
    return '8.9.10';
  };
  await assert.rejects(f.read(), { code: 'ERR_NATIVE_CLI_CHANGED' });
});

test('rejects replacement between the initial path stat and opening the binary', async t => {
  const f = await fixture(t);
  await assert.rejects(f.read({
    async open(path, flags) {
      const replacement = join(f.directory, 'updated-agy');
      await writeFile(replacement, macho({ data: stamp('1234567890') }));
      await rename(replacement, path);
      return open(path, flags);
    },
  }), { code: 'ERR_NATIVE_CLI_CHANGED' });
  assert.equal(f.calls.length, 0);
});

test('checks the path again even when returning cached metadata', async t => {
  const f = await fixture(t);
  await f.read();
  let reads = 0;
  await assert.rejects(f.read({
    async stat(path, configuration) {
      if (++reads === 2) {
        const replacement = join(f.directory, 'updated-agy');
        await writeFile(replacement, f.binary);
        await rename(replacement, path);
      }
      return stat(path, configuration);
    },
  }), { code: 'ERR_NATIVE_CLI_CHANGED' });
  assert.equal(f.calls.length, 1);
});

test('redacts subprocess and filesystem errors without caching failed metadata', async t => {
  const secret = 'synthetic-private-cli-output';
  const f = await fixture(t);
  f.onVersion = () => { throw Object.assign(new Error(secret), { stdout: secret, stderr: secret, request: { credential: secret } }); };
  await assert.rejects(f.read(), error => assertSafe(error, 'ERR_NATIVE_CLI_VERSION', secret));
  await assert.rejects(f.read({ stat: async () => { throw new Error(secret); } }), error => assertSafe(error, 'ERR_NATIVE_CLI_UNAVAILABLE', secret));
  f.onVersion = undefined;
  assert.equal((await f.read()).version, VERSION);
  assert.equal(f.calls.length, 2);
});
