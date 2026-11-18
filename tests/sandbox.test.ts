import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxError } from '../src/sandbox.js';
import { workspace } from './helpers.js';

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no error';
  } catch (error) {
    return error instanceof SandboxError ? error.code : `unexpected: ${String(error)}`;
  }
}

describe('Sandbox', () => {
  it('resolves files inside the workspace and the root itself', async () => {
    const { dir, sandbox } = await workspace({ 'src/a.ts': 'x' });
    expect(await sandbox.resolveExisting('src/a.ts')).toBe(path.join(sandbox.root, 'src/a.ts'));
    expect(await sandbox.resolveExisting('.')).toBe(sandbox.root);
    expect(await sandbox.resolveExisting('')).toBe(sandbox.root);
    expect(sandbox.display(path.join(sandbox.root, 'src/a.ts'))).toBe(path.join('src', 'a.ts'));
    expect(dir).toBeTruthy();
  });

  it('rejects absolute paths, parent segments and missing files', async () => {
    const { sandbox } = await workspace({ 'a.txt': 'x' });
    expect(await code(sandbox.resolveExisting('/etc/passwd'))).toBe('NOT_RELATIVE');
    expect(await code(sandbox.resolveExisting('../x'))).toBe('NOT_RELATIVE');
    expect(await code(sandbox.resolveExisting('a/../../x'))).toBe('NOT_RELATIVE');
    expect(await code(sandbox.resolveExisting('..\\x'))).toBe('NOT_RELATIVE');
    expect(await code(sandbox.resolveExisting('missing.txt'))).toBe('NOT_FOUND');
  });

  it('denies .git and .env* but not look-alikes', async () => {
    const { sandbox } = await workspace({
      '.git/config': 'x',
      '.env': 'T=1',
      '.env.production': 'T=2',
      '.envrc': 'ok',
    });
    for (const denied of ['.git', '.git/config', '.env', '.env.production', 'sub/.env']) {
      expect(await code(sandbox.resolveExisting(denied))).toBe('DENIED');
    }
    expect(await code(sandbox.resolveExisting('.envrc'))).toBe('no error');
  });

  it('cannot follow a symlink out of the workspace, or to a denied file inside it', async () => {
    const { dir, sandbox } = await workspace({ '.env': 'T=1' });
    const outside = (await workspace({ 'secret.txt': 'top' })).dir;
    await symlink(outside, path.join(dir, 'escape'));
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    await symlink(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));

    expect(await code(sandbox.resolveExisting('escape'))).toBe('OUTSIDE');
    expect(await code(sandbox.resolveExisting('escape/secret.txt'))).toBe('OUTSIDE');
    expect(await code(sandbox.resolveExisting('link.txt'))).toBe('OUTSIDE');
    expect(await code(sandbox.resolveExisting('innocent.txt'))).toBe('DENIED');
  });

  it('resolveForWrite allows new files and folders but not escapes', async () => {
    const { dir, sandbox } = await workspace({ 'a.txt': 'x' });
    expect(await sandbox.resolveForWrite('new/deep/file.txt')).toBe(
      path.join(sandbox.root, 'new/deep/file.txt'),
    );
    expect(await code(sandbox.resolveForWrite('../evil.txt'))).toBe('NOT_RELATIVE');
    expect(await code(sandbox.resolveForWrite('.env'))).toBe('DENIED');
    expect(await code(sandbox.resolveForWrite('.'))).toBe('NOT_RELATIVE');

    const outside = (await workspace()).dir;
    await mkdir(path.join(outside, 'inner'));
    await symlink(outside, path.join(dir, 'linked'));
    expect(await code(sandbox.resolveForWrite('linked/new.txt'))).toBe('OUTSIDE');
    expect(await code(sandbox.resolveForWrite('linked/inner/new.txt'))).toBe('OUTSIDE');
  });

  it('requires an existing directory', async () => {
    const { dir } = await workspace({ 'f.txt': 'x' });
    const { Sandbox } = await import('../src/sandbox.js');
    await expect(Sandbox.create(path.join(dir, 'f.txt'))).rejects.toThrow('not a directory');
    await expect(Sandbox.create(path.join(dir, 'missing'))).rejects.toThrow();
    await writeFile(path.join(dir, 'ok.txt'), '');
  });
});
