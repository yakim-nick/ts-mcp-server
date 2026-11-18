/**
 * End-to-end over the real MCP protocol: the server and the SDK's own client talk through an
 * in-memory transport pair. Two more tests run the compiled-from-source CLI over stdio.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION, createServer } from '../src/server.js';
import { MAX_LIST_ENTRIES } from '../src/tools.js';
import { workspace } from './helpers.js';
import pkg from '../package.json' with { type: 'json' };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(files: Record<string, string> = {}) {
  const ws = await workspace({
    'README.md': '# Demo\nhello\n',
    'src/main.rs': 'fn main() {}\n',
    'src/nested/deep.txt': 'deep',
    '.env': 'TOKEN=super-secret',
    '.git/config': '[core]',
    ...files,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(ws.sandbox);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());
  return { client, ...ws };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

describe('server identity and tools', () => {
  it('advertises its name, version and instructions, and the version matches package.json', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(client.getInstructions()).toContain('Read-only access to one project directory');
  });

  it('lists exactly three tools, all annotated read-only, with object schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['git_log', 'list_files', 'read_file']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toContain('Read-only');
    }
    const read = tools.find((t) => t.name === 'read_file')!;
    expect(read.inputSchema.required).toEqual(['path']);
  });
});

describe('list_files', () => {
  it('shows a sorted tree and hides secrets', async () => {
    const { client } = await connect();
    const { isError, text } = await call(client, 'list_files');
    expect(isError).toBe(false);
    // Default depth is 2 levels, so deep.txt (a third level) is not shown yet.
    expect(text).toBe('.\nsrc/\n  nested/\n  main.rs (13 bytes)\nREADME.md (13 bytes)\n');
    expect((await call(client, 'list_files', { max_depth: 3 })).text).toContain(
      '    deep.txt (4 bytes)',
    );
  });

  it('handles subdirectories, non-directories and bad depth', async () => {
    const { client } = await connect();
    expect((await call(client, 'list_files', { path: 'src', max_depth: 1 })).text).toBe(
      'src\nnested/\nmain.rs (13 bytes)\n',
    );
    const notDir = await call(client, 'list_files', { path: 'README.md' });
    expect(notDir).toMatchObject({ isError: true });
    expect(notDir.text).toContain('not a directory');
    expect((await call(client, 'list_files', { max_depth: 99 })).isError).toBe(true);
  });

  it('stops at the entry limit and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_LIST_ENTRIES + 50; i++)
      files[`many/f${String(i).padStart(4, '0')}.txt`] = 'x';
    const { client } = await connect(files);
    const { text } = await call(client, 'list_files', { path: 'many' });
    expect(text).toContain(`stopped after ${MAX_LIST_ENTRIES} entries`);
  });

  it('skips symlinks', async () => {
    const { client, dir } = await connect();
    const outside = await workspace();
    await symlink(outside.dir, path.join(dir, 'escape'));
    expect((await call(client, 'list_files')).text).not.toContain('escape');
  });
});

describe('read_file', () => {
  it('returns content, and truncates without splitting a character', async () => {
    const { client } = await connect({ 'euro.txt': '€'.repeat(100) });
    expect(await call(client, 'read_file', { path: 'src/main.rs' })).toEqual({
      isError: false,
      text: 'fn main() {}\n',
    });
    expect((await call(client, 'read_file', { path: 'euro.txt', max_bytes: 10 })).text).toBe(
      '€€€\n\n[truncated at 10 bytes]',
    );
  });

  it('refuses secrets, traversal, directories, binaries and missing files, leaking nothing', async () => {
    const { client, dir } = await connect();
    await writeFile(path.join(dir, 'image.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const cases: Array<[string, string]> = [
      ['.env', 'not allowed'],
      ['.git/config', 'not allowed'],
      ['../etc/passwd', "must not contain '..'"],
      ['/etc/passwd', 'must be relative'],
      ['src', 'not a regular file'],
      ['image.bin', 'not valid UTF-8'],
      ['missing.txt', 'not found'],
    ];
    for (const [target, expected] of cases) {
      const result = await call(client, 'read_file', { path: target });
      expect(result.isError, target).toBe(true);
      expect(result.text, target).toContain(expected);
      expect(result.text).not.toContain('super-secret');
      expect(result.text).not.toContain(dir);
    }
  });

  it('cannot follow a symlink out of the project or to a denied file', async () => {
    const { client, dir } = await connect();
    const outside = await workspace({ 'secret.txt': 'outside-secret' });
    await symlink(path.join(outside.dir, 'secret.txt'), path.join(dir, 'link.txt'));
    await symlink(path.join(dir, '.env'), path.join(dir, 'env-link.txt'));
    for (const target of ['link.txt', 'env-link.txt']) {
      const result = await call(client, 'read_file', { path: target });
      expect(result.isError, target).toBe(true);
      expect(result.text).not.toContain('secret');
    }
  });

  it('reports bad arguments as a readable error', async () => {
    const { client } = await connect();
    const result = await call(client, 'read_file', {});
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toContain('path');
  });
});

describe('git_log', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tester',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, stdio: 'pipe' },
    );

  it('lists commits newest first and respects the limit', async () => {
    const { client, dir } = await connect();
    await mkdir(path.join(dir, 'nested'), { recursive: true });
    git(dir, 'init', '-q');
    await writeFile(path.join(dir, 'a.txt'), '1');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'first commit');
    await writeFile(path.join(dir, 'a.txt'), '2');
    git(dir, 'commit', '-q', '-am', 'second commit');

    const { isError, text } = await call(client, 'git_log');
    expect(isError).toBe(false);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Tester {2}second commit$/);
    expect(lines[1]).toMatch(/Tester {2}first commit$/);
    expect((await call(client, 'git_log', { limit: 1 })).text.split('\n')).toHaveLength(1);
    expect((await call(client, 'git_log', { limit: 0 })).isError).toBe(true);
  });

  it('outside a repository it is a tool error, not a crash', async () => {
    const outside = await workspace({ 'a.txt': 'x' });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const server = createServer(outside.sandbox);
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(s), client.connect(c)]);
    closers.push(() => client.close());
    const result = await call(client, 'git_log');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('git log failed');
  });
});

describe('unknown tools', () => {
  it('are rejected', async () => {
    const { client } = await connect();
    const outcome = await client.callTool({ name: 'delete_everything', arguments: {} }).then(
      (r) => ({ rejected: false, isError: (r as { isError?: boolean }).isError === true }),
      () => ({ rejected: true, isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });
});

describe('the CLI over stdio (real child process)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const start = (args: string[]) =>
    spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  it('speaks MCP and keeps stdout clean (only JSON-RPC lines)', async () => {
    const { dir } = await workspace({ 'README.md': '# Demo\nhello\n' });
    const child = start([dir]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));

    child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n',
    );
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"README.md"}}}\n',
    );
    child.stdin.end(); // closing stdin ends the session
    expect(await closed).toBe(0);

    const messages = stdout
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as { id: number; result: Record<string, unknown> };
        } catch {
          throw new Error(`stdout must only carry JSON-RPC, got: ${line}`);
        }
      });
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.id === 1)!.result['serverInfo']).toMatchObject({
      name: 'ts-mcp-server',
    });
    const read = messages.find((m) => m.id === 2)!.result as { content: Array<{ text: string }> };
    expect(read.content[0]!.text).toBe('# Demo\nhello\n');
    expect(stderr).toContain('serving');
  });

  it('refuses a bad project directory with exit code 2 and nothing on stdout', async () => {
    const child = start(['/definitely/not/here']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('cannot use');
  });

  it('prints help and version', async () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--version'], {
      cwd: root,
    }).toString();
    expect(out).toContain(`ts-mcp-server ${pkg.version}`);
  });
});
