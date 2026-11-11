import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_CLI = join(homedir(), '.local/bin/agy');
const MACHO_64 = 0xfeedfacf;
const SEGMENT_64 = 0x19;
const ARCHITECTURES = new Map([[0x0100000c, 'arm64'], [0x01000007, 'x64']]);
const CELL_BYTES = 16;
const STAMP_BYTES = CELL_BYTES * 2 + 11;
const SCAN_BYTES = 128 * 1024;
const metadataCache = new Map();

export class CliMetadataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliMetadataError';
    this.code = code;
  }
}

const failure = (code, message) => new CliMetadataError(code, message);
const malformed = () => failure('ERR_NATIVE_CLI_FORMAT', 'The official Antigravity CLI must contain a valid thin 64-bit Mach-O executable.');
const changed = () => failure('ERR_NATIVE_CLI_CHANGED', 'The official Antigravity CLI changed while its identity was being read; retry after its update finishes.');
const unavailable = () => failure('ERR_NATIVE_CLI_UNAVAILABLE', 'The official Antigravity CLI could not be read; install agy at ~/.local/bin/agy or configure cliPath.');
const missingStamp = () => failure('ERR_NATIVE_CLI_METADATA', 'The official Antigravity CLI build stamp is missing or corrupt.');
const signature = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const sameFile = (left, right) => signature(left) === signature(right);

async function readExactly(file, buffer, position, length = buffer.length, offset = 0) {
  let received = 0;
  while (received < length) {
    const { bytesRead } = await file.read(buffer, offset + received, length - received, position + received);
    if (!bytesRead) throw malformed();
    received += bytesRead;
  }
}

function fileRange(offset, size, fileSize) {
  if (offset < 0n || size < 0n || offset + size > fileSize || offset + size > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed();
  return { offset: Number(offset), size: Number(size) };
}

function nameAt(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return buffer.toString('ascii', offset, end < 0 || end > offset + 16 ? offset + 16 : end);
}

async function rodataSection(file, info, arch) {
  const header = Buffer.alloc(32);
  if (info.size < 32n) throw malformed();
  await readExactly(file, header, 0);
  if (header.readUInt32LE(0) !== MACHO_64 || header.readUInt32LE(12) !== 2) throw malformed();
  const binaryArch = ARCHITECTURES.get(header.readUInt32LE(4));
  if (!binaryArch || binaryArch !== arch) {
    throw failure('ERR_NATIVE_CLI_ARCH', 'The official Antigravity CLI architecture does not match this macOS process; install its arm64 or x64 build as appropriate.');
  }
  const count = header.readUInt32LE(16);
  const size = header.readUInt32LE(20);
  if (!count || size < count * 8 || size > 16 * 1024 * 1024 || BigInt(32 + size) > info.size) throw malformed();
  const commands = Buffer.alloc(size);
  await readExactly(file, commands, 32);
  let section;
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > size) throw malformed();
    const command = commands.readUInt32LE(cursor);
    const commandSize = commands.readUInt32LE(cursor + 4);
    if (commandSize < 8 || commandSize % 8 || cursor + commandSize > size) throw malformed();
    if (command === SEGMENT_64) {
      if (commandSize < 72) throw malformed();
      const sections = commands.readUInt32LE(cursor + 64);
      if (commandSize !== 72 + sections * 80) throw malformed();
      if (nameAt(commands, cursor + 8) === '__TEXT') {
        const segment = fileRange(commands.readBigUInt64LE(cursor + 40), commands.readBigUInt64LE(cursor + 48), info.size);
        const protections = commands.readUInt32LE(cursor + 60);
        for (let number = 0; number < sections; number++) {
          const start = cursor + 72 + number * 80;
          if (nameAt(commands, start) !== '__rodata' || nameAt(commands, start + 16) !== '__TEXT') continue;
          if (section) throw failure('ERR_NATIVE_CLI_METADATA', 'The official Antigravity CLI contains ambiguous read-only build sections.');
          // Only file-backed regular data in a readable, non-writable segment is eligible.
          if (!(protections & 1) || (protections & 2) || (commands.readUInt32LE(start + 64) & 0xff)) throw malformed();
          section = fileRange(BigInt(commands.readUInt32LE(start + 48)), commands.readBigUInt64LE(start + 40), info.size);
          if (!section.size || section.offset < segment.offset || section.offset + section.size > segment.offset + segment.size || section.offset < 32 + size) throw malformed();
        }
      }
    }
    cursor += commandSize;
  }
  if (cursor !== size) throw malformed();
  if (!section) throw missingStamp();
  return section;
}

function stampAt(buffer, start) {
  if (buffer[start] < 0x31 || buffer[start] > 0x39) return undefined;
  for (let index = 0; index < CELL_BYTES; index++) {
    if (buffer[start + index] !== buffer[start + CELL_BYTES + index]) return undefined;
  }
  let digits = 0;
  while (digits < CELL_BYTES && buffer[start + digits] >= 0x30 && buffer[start + digits] <= 0x39) digits++;
  if (!digits || digits === CELL_BYTES) return undefined;
  for (let index = digits; index < CELL_BYTES; index++) if (buffer[start + index] !== 0) return undefined;
  const timestamp = start + CELL_BYTES * 2;
  if (buffer[timestamp] < 0x31 || buffer[timestamp] > 0x39) return undefined;
  for (let index = 0; index < 10; index++) {
    const byte = buffer[timestamp + index];
    if (byte < 0x30 || byte > 0x39) return undefined;
  }
  if (buffer[timestamp + 10] !== 0) return undefined;
  return buffer.toString('ascii', start, start + digits);
}

async function readBuild(file, section) {
  // Observed official CLI layout: two identical NUL-padded 16-byte decimal CL
  // cells, then ten-digit Unix build seconds terminated by NUL. Bytes after
  // that terminator are flags, not timestamp padding. Search the declared
  // read-only section rather than a release-specific offset.
  const buffer = Buffer.allocUnsafe(SCAN_BYTES + STAMP_BYTES - 1);
  let carry = 0;
  let position = section.offset;
  const end = section.offset + section.size;
  let cl;
  while (position < end) {
    const length = Math.min(SCAN_BYTES, end - position);
    await readExactly(file, buffer, position, length, carry);
    const available = carry + length;
    for (let start = 0; start <= available - STAMP_BYTES; start++) {
      const candidate = stampAt(buffer, start);
      if (candidate === undefined) continue;
      if (cl !== undefined) throw failure('ERR_NATIVE_CLI_METADATA', 'The official Antigravity CLI contains ambiguous build stamps.');
      cl = candidate;
    }
    carry = Math.min(STAMP_BYTES - 1, available);
    buffer.copy(buffer, 0, available - carry, available);
    position += length;
  }
  if (cl === undefined) throw missingStamp();
  return cl;
}

async function readVersion(cliPath, execute) {
  let output;
  try {
    output = await new Promise((resolve, reject) => {
      execute(cliPath, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  } catch {
    throw failure('ERR_NATIVE_CLI_VERSION', 'The official Antigravity CLI version command failed.');
  }
  const version = typeof output === 'string' ? output.trim() : '';
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw failure('ERR_NATIVE_CLI_VERSION', 'The official Antigravity CLI did not provide a valid version.');
  }
  return version;
}

async function loadMetadata(cliPath, before, deps) {
  const file = await deps.open(cliPath, 'r');
  try {
    if (!sameFile(before, await file.stat({ bigint: true }))) throw changed();
    const section = await rodataSection(file, before, deps.arch);
    const cl = await readBuild(file, section);
    const version = await readVersion(cliPath, deps.execFile);
    const [after, current] = await Promise.all([file.stat({ bigint: true }), deps.stat(cliPath, { bigint: true })]);
    if (!sameFile(before, after) || !sameFile(before, current)) throw changed();
    return Object.freeze({ version, cl, platform: 'darwin', arch: deps.arch });
  } finally {
    await file.close();
  }
}

/** Read only the official local CLI. _deps supplies deterministic test dependencies. */
export async function readCliMetadata(cliPath = DEFAULT_CLI, { _deps = {} } = {}) {
  const deps = { open, stat, execFile, platform: process.platform, arch: process.arch, ..._deps };
  if (deps.platform !== 'darwin' || !['arm64', 'x64'].includes(deps.arch)) {
    throw failure('ERR_NATIVE_CLI_PLATFORM', 'Official Antigravity CLI identity requires macOS on arm64 or x64.');
  }
  try {
    if (typeof cliPath !== 'string' || !cliPath.trim()) throw unavailable();
    const path = resolve(cliPath);
    const before = await deps.stat(path, { bigint: true });
    if (!before.isFile()) throw malformed();
    const key = signature(before);
    let entry = metadataCache.get(path);
    if (!entry || entry.key !== key) {
      entry = { key, promise: loadMetadata(path, before, deps) };
      metadataCache.set(path, entry);
      const own = entry;
      entry.promise.catch(() => { if (metadataCache.get(path) === own) metadataCache.delete(path); });
    }
    const metadata = await entry.promise;
    if (!sameFile(before, await deps.stat(path, { bigint: true }))) throw changed();
    if (metadata.arch !== deps.arch) throw failure('ERR_NATIVE_CLI_ARCH', 'The official Antigravity CLI architecture does not match this macOS process.');
    return metadata;
  } catch (error) {
    if (error instanceof CliMetadataError) throw error;
    // Subprocess failures can contain stdout/stderr; filesystem failures contain paths.
    // Neither is safe to publish as an authentication error or as an error cause.
    throw unavailable();
  }
}
