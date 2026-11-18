/**
 * The workspace boundary. Every path a tool receives is untrusted model output, so it is
 * resolved here: it must be relative, free of `..`, and (after resolving symlinks) still
 * inside the workspace. `.git` and `.env*` are never exposed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_RELATIVE' | 'OUTSIDE' | 'DENIED' | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export function isDeniedName(name: string): boolean {
  return name === '.git' || name === '.env' || name.startsWith('.env.');
}

export class Sandbox {
  private constructor(readonly root: string) {}

  /** Create a sandbox for an existing directory. */
  static async create(dir: string): Promise<Sandbox> {
    const root = await fs.realpath(dir);
    if (!(await fs.stat(root)).isDirectory()) throw new Error(`${dir} is not a directory`);
    return new Sandbox(root);
  }

  /** Resolve a workspace-relative path for reading. The target must already exist. */
  async resolveExisting(relative: string): Promise<string> {
    const lexical = this.lexical(relative);
    let real: string;
    try {
      real = await fs.realpath(lexical);
    } catch {
      throw new SandboxError('path not found', 'NOT_FOUND');
    }
    this.assertInside(real);
    return real;
  }

  /**
   * Resolve a workspace-relative path for writing. The file may not exist yet, so the
   * nearest existing parent is canonicalised (this blocks writing through a symlinked
   * directory that points outside the workspace).
   */
  async resolveForWrite(relative: string): Promise<string> {
    const lexical = this.lexical(relative);
    if (lexical === this.root) throw new SandboxError('path must name a file', 'NOT_RELATIVE');
    let existing = lexical;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = await fs.realpath(existing);
        this.assertInside(real);
        return path.join(real, ...missing.reverse());
      } catch (error) {
        if (error instanceof SandboxError) throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw new SandboxError('path not found', 'NOT_FOUND');
        missing.push(path.basename(existing));
        existing = parent;
      }
    }
  }

  /** Path relative to the workspace, for display (never leaks the absolute location). */
  display(absolute: string): string {
    return path.relative(this.root, absolute) || '.';
  }

  private lexical(relative: string): string {
    if (path.isAbsolute(relative)) {
      throw new SandboxError('path must be relative to the workspace', 'NOT_RELATIVE');
    }
    const parts = relative.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
    for (const part of parts) {
      if (part === '..') {
        throw new SandboxError("path must not contain '..'", 'NOT_RELATIVE');
      }
      if (isDeniedName(part)) {
        throw new SandboxError('access to this path is not allowed', 'DENIED');
      }
    }
    return path.join(this.root, ...parts);
  }

  private assertInside(real: string): void {
    const relative = path.relative(this.root, real);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new SandboxError('path resolves outside the workspace', 'OUTSIDE');
    }
    // A symlink inside the workspace may point at a denied name inside the workspace.
    if (relative.split(path.sep).some(isDeniedName)) {
      throw new SandboxError('access to this path is not allowed', 'DENIED');
    }
  }
}
