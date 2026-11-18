/** The three read-only tools. Plain functions over a Sandbox, so they are easy to test. */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SandboxError, isDeniedName, type Sandbox } from './sandbox.js';

const run = promisify(execFile);

export const MAX_LIST_ENTRIES = 500;
export const MAX_DEPTH = 5;
export const DEFAULT_DEPTH = 2;
export const DEFAULT_READ_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;
export const DEFAULT_LOG_LIMIT = 10;
export const MAX_LOG_LIMIT = 50;

/** A failure the model can read and react to; it becomes an `isError` tool result. */
export class ToolFailure extends Error {}

function rethrow(error: unknown): never {
  if (error instanceof SandboxError) throw new ToolFailure(error.message);
  throw error;
}

export async function listFiles(
  sandbox: Sandbox,
  input: { path: string; max_depth: number },
): Promise<string> {
  const dir = await sandbox.resolveExisting(input.path).catch(rethrow);
  if (!(await fs.stat(dir)).isDirectory()) throw new ToolFailure('path is not a directory');
  const lines: string[] = [];
  const truncated = await walk(dir, input.max_depth, 0, lines);
  if (truncated) {
    lines.push(
      `... stopped after ${MAX_LIST_ENTRIES} entries, use a deeper path or a smaller max_depth`,
    );
  }
  return [sandbox.display(dir), ...(lines.length ? lines : ['(empty)'])].join('\n') + '\n';
}

async function walk(dir: string, maxDepth: number, level: number, out: string[]): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (isDeniedName(entry.name) || entry.isSymbolicLink()) continue;
    if (out.length >= MAX_LIST_ENTRIES) return true;
    const indent = '  '.repeat(level);
    if (entry.isDirectory()) {
      out.push(`${indent}${entry.name}/`);
      if (
        level + 1 < maxDepth &&
        (await walk(path.join(dir, entry.name), maxDepth, level + 1, out))
      ) {
        return true;
      }
    } else {
      const size = (await fs.stat(path.join(dir, entry.name))).size;
      out.push(`${indent}${entry.name} (${size} bytes)`);
    }
  }
  return false;
}

export async function readFile(
  sandbox: Sandbox,
  input: { path: string; max_bytes: number },
): Promise<string> {
  const file = await sandbox.resolveExisting(input.path).catch(rethrow);
  if (!(await fs.stat(file)).isFile()) throw new ToolFailure('path is not a regular file');
  const handle = await fs.open(file, 'r');
  try {
    // Read one byte more than the limit to learn whether the file was truncated.
    const buffer = Buffer.alloc(input.max_bytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > input.max_bytes;
    const text = decodeUtf8(buffer.subarray(0, Math.min(bytesRead, input.max_bytes)), truncated);
    if (text === null) {
      throw new ToolFailure('file is not valid UTF-8 text (binary files are not supported)');
    }
    return truncated ? `${text}\n\n[truncated at ${input.max_bytes} bytes]` : text;
  } finally {
    await handle.close();
  }
}

/**
 * Decode UTF-8. When the bytes were cut at a size limit, an incomplete character at the very
 * end is dropped instead of failing; any other invalid sequence (binary data) returns null.
 */
export function decodeUtf8(bytes: Uint8Array, truncated: boolean): string | null {
  const usable = truncated ? withoutIncompleteTail(bytes) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(usable);
  } catch {
    return null;
  }
}

/** Cut a trailing multi-byte sequence whose lead byte promises more bytes than are present. */
function withoutIncompleteTail(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: look further back for the lead
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

export async function gitLog(sandbox: Sandbox, input: { limit: number }): Promise<string> {
  // Fixed arguments, no shell: the only request value used is the validated number.
  try {
    const { stdout } = await run(
      'git',
      [
        '--no-pager',
        '-C',
        sandbox.root,
        'log',
        '-n',
        String(input.limit),
        '--date=short',
        '--pretty=format:%h  %ad  %an  %s',
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() === '' ? '(no commits yet)' : stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    if ((error as { code?: string }).code === 'ENOENT')
      throw new ToolFailure('could not run git: it is not installed');
    throw new ToolFailure(
      `git log failed (is this a git repository with commits?): ${stderr ?? 'unknown error'}`,
    );
  }
}
