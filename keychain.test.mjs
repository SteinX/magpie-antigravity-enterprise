import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareKeychainHelper } from './keychain.mjs';

// Native integration is opt-in so the ordinary consumer suite neither compiles
// Swift nor accesses any Keychain. Every native operation below uses an explicit
// private temporary keychain; no default/search-list setters are used.
const nativeEnabled = process.platform === 'darwin' && process.env.MAGPIE_NATIVE_KEYCHAIN_TESTS === '1';
function invoke(file, args, { input, signal, timeout = 120_000 } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { encoding: 'utf8', signal, timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, cancelled: error?.name === 'AbortError', stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const fixtureSource = String.raw`
import Darwin
import Foundation
import Security
let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else { exit(2) }
guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { exit(3) }
let operation = args[0]
let path = args[1]
let password = Data("synthetic-private-keychain-password".utf8)
var keychain: SecKeychain?
func require(_ status: OSStatus) {
    if status == errSecInteractionNotAllowed || status == errSecInteractionRequired { exit(11) }
    if status == errSecAuthFailed { exit(12) }
    guard status == errSecSuccess else { exit(20) }
}
if operation == "create" {
    require(path.withCString { location in
        password.withUnsafeBytes { bytes in
            SecKeychainCreate(location, UInt32(bytes.count), bytes.baseAddress, false, nil, &keychain)
        }
    })
} else {
    require(path.withCString { SecKeychainOpen($0, &keychain) })
}
guard let keychain else { exit(21) }
if operation == "delete" { require(SecKeychainDelete(keychain)); exit(0) }
if operation == "lock" { require(SecKeychainLock(keychain)); exit(0) }
if operation == "unlock" {
    require(password.withUnsafeBytes { bytes in SecKeychainUnlock(keychain, UInt32(bytes.count), bytes.baseAddress, true) })
    exit(0)
}
if operation == "create" {
    guard args.count == 3 else { exit(2) }
    require(password.withUnsafeBytes { bytes in SecKeychainUnlock(keychain, UInt32(bytes.count), bytes.baseAddress, true) })
    var own: SecTrustedApplication?
    var helper: SecTrustedApplication?
    require(SecTrustedApplicationCreateFromPath(nil, &own))
    require(args[2].withCString { SecTrustedApplicationCreateFromPath($0, &helper) })
    guard let own, let helper else { exit(22) }
    var access: SecAccess?
    require(SecAccessCreate("Synthetic isolated credential" as CFString, [own, helper] as CFArray, &access))
    guard let access else { exit(23) }
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecUseKeychain as String: keychain,
        kSecAttrService as String: "gemini",
        kSecAttrAccount as String: "antigravity",
        kSecAttrAccess as String: access,
        kSecValueData as String: Data("synthetic-native-original".utf8),
    ]
    require(SecItemAdd(query as CFDictionary, nil))
    exit(0)
}
if operation == "read" {
    var length: UInt32 = 0
    var data: UnsafeMutableRawPointer?
    let status = "gemini".withCString { service in
        "antigravity".withCString { account in
            SecKeychainFindGenericPassword(keychain, 6, service, 11, account, &length, &data, nil)
        }
    }
    require(status)
    if let data { SecKeychainItemFreeContent(nil, data) }
    exit(0)
}
exit(2)
`;

test('native helper reuses its signed identity and enforces noninteractive read/CAS with an isolated Keychain', { skip: !nativeEnabled, timeout: 300_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-native-keychain-'));
  const stateDir = join(directory, 'state');
  const keychain = join(directory, 'private-fixture.keychain');
  let fixture;
  t.after(async () => {
    try { if (fixture) await invoke(fixture, ['delete', keychain]); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const helper = await prepareKeychainHelper(stateDir);
  const originalInfo = await stat(helper);
  const originalHash = createHash('sha256').update(await readFile(helper)).digest('hex');
  const prepareScript = `import { prepareKeychainHelper } from ${JSON.stringify(new URL('./keychain.mjs', import.meta.url).href)}; process.stdout.write(await prepareKeychainHelper(process.argv[1]));`;
  const restarted = await invoke(process.execPath, ['--input-type=module', '-e', prepareScript, stateDir]);
  assert.equal(restarted.code, 0);
  assert.equal(restarted.stdout, helper);
  assert.equal((await stat(helper)).ino, originalInfo.ino);
  assert.equal(createHash('sha256').update(await readFile(helper)).digest('hex'), originalHash);

  const source = join(directory, 'fixture.swift');
  fixture = join(directory, 'fixture');
  await writeFile(source, fixtureSource, { mode: 0o600 });
  assert.equal((await invoke('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', fixture])).code, 0);
  assert.equal((await invoke('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.magpie.keychain-test.creator', fixture])).code, 0);
  assert.equal((await invoke(fixture, ['create', keychain, helper])).code, 0);
  const args = ['--keychain', keychain];
  const read = () => invoke(helper, ['read', 'noninteractive', ...args]);
  assert.deepEqual(await read(), { code: 0, cancelled: false, stdout: 'synthetic-native-original', stderr: '' });

  const lockPath = join(directory, 'refresh.lock');
  const commit = (expected, replacement) => invoke(helper, ['lock', 'noninteractive', lockPath, ...args], { input: JSON.stringify({ expected, replacement }) + '\n' });
  assert.deepEqual(await commit('synthetic-native-original', 'synthetic-native-rotated'), { code: 0, cancelled: false, stdout: 'locked\nsaved\n', stderr: '' });
  assert.deepEqual(await commit('stale-value', 'must-not-be-written'), { code: 0, cancelled: false, stdout: 'locked\nchanged\n', stderr: '' });
  assert.equal((await read()).stdout, 'synthetic-native-rotated');

  // Re-signing a copy with a different identity must not inherit the item's ACL.
  const outsider = join(directory, 'outsider');
  await copyFile(fixture, outsider);
  assert.equal((await invoke('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.magpie.keychain-test.outsider', outsider])).code, 0);
  const denied = await invoke(outsider, ['read', keychain]);
  assert.equal([11, 12].includes(denied.code), true);
  assert.equal(denied.stdout, '');
  assert.equal(denied.stderr, '');

  assert.equal((await invoke(fixture, ['lock', keychain])).code, 0);
  const lockedRead = await read();
  assert.ok([11, 12].includes(lockedRead.code), 'A locked Keychain must deny noninteractive credential access');
  assert.equal(lockedRead.stdout, '');
  assert.equal(lockedRead.stderr, '');
  const lockedCommit = await commit('synthetic-native-rotated', 'must-not-be-written');
  assert.ok([11, 12].includes(lockedCommit.code), 'A locked Keychain must deny noninteractive credential updates');
  assert.equal(lockedCommit.stdout, 'locked\n');
  assert.equal(lockedCommit.stderr, '');
  assert.equal((await invoke(fixture, ['unlock', keychain])).code, 0);
  assert.equal((await read()).stdout, 'synthetic-native-rotated');

  // An altered cached executable must fail closed instead of being re-signed or
  // overwritten at an already-authorized path.
  await chmod(helper, 0o700);
  await writeFile(helper, 'damaged cached executable');
  await chmod(helper, 0o500);
  await assert.rejects(prepareKeychainHelper(stateDir), { code: 'ERR_NATIVE_KEYCHAIN_HELPER' });
});
