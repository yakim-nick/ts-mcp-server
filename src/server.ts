/** The MCP server: three read-only tools over one sandboxed project directory. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Sandbox } from './sandbox.js';
import {
  DEFAULT_DEPTH,
  DEFAULT_LOG_LIMIT,
  DEFAULT_READ_BYTES,
  MAX_DEPTH,
  MAX_LOG_LIMIT,
  MAX_READ_BYTES,
  ToolFailure,
  gitLog,
  listFiles,
  readFile,
} from './tools.js';

export const SERVER_NAME = 'ts-mcp-server';
export const SERVER_VERSION = '0.1.0'; // must equal package.json (checked by a test)

const INSTRUCTIONS =
  'Read-only access to one project directory: list_files shows the tree, read_file returns a text ' +
  'file, git_log shows recent commits. Paths are relative to the project root; .git and .env files are hidden.';

/** Every tool here only reads, never touches anything outside the project, and has no side effects. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });

/** Failures become tool results with `isError: true`, so the model can read them and adjust. */
async function guarded(work: () => Promise<string>): Promise<Result> {
  try {
    return ok(await work());
  } catch (error) {
    if (error instanceof ToolFailure)
      return { content: [{ type: 'text', text: error.message }], isError: true };
    throw error; // unexpected: the SDK reports it as a protocol error without leaking details
  }
}

export function createServer(sandbox: Sandbox): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description:
        'List files and directories under a project directory as an indented tree. Read-only. ' +
        `Hides .git and .env files; symlinks are skipped. Stops at 500 entries.`,
      inputSchema: {
        path: z.string().default('.').describe('Directory relative to the project root.'),
        max_depth: z
          .number()
          .int()
          .min(1)
          .max(MAX_DEPTH)
          .default(DEFAULT_DEPTH)
          .describe('Levels to descend (1-5).'),
      },
      annotations: READ_ONLY,
    },
    (input) => guarded(() => listFiles(sandbox, input)),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a file',
      description:
        'Read a UTF-8 text file from the project. Read-only. Large files are truncated; ' +
        'binary files, .git and .env files are refused.',
      inputSchema: {
        path: z.string().describe('File relative to the project root.'),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_READ_BYTES)
          .default(DEFAULT_READ_BYTES)
          .describe('Maximum bytes to return (default 65536, at most 262144).'),
      },
      annotations: READ_ONLY,
    },
    (input) => guarded(() => readFile(sandbox, input)),
  );

  server.registerTool(
    'git_log',
    {
      title: 'Recent commits',
      description:
        'Show recent git commits of the project (hash, date, author, subject), newest first. ' +
        'Read-only. Fails if the project is not a git repository.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_LIMIT)
          .default(DEFAULT_LOG_LIMIT)
          .describe('Number of commits (1-50).'),
      },
      annotations: READ_ONLY,
    },
    (input) => guarded(() => gitLog(sandbox, input)),
  );

  return server;
}
