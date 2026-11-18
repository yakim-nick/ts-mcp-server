import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Sandbox } from '../src/sandbox.js';

export async function workspace(
  files: Record<string, string> = {},
): Promise<{ dir: string; sandbox: Sandbox }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return { dir, sandbox: await Sandbox.create(dir) };
}
