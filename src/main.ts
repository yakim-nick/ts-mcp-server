#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Sandbox } from './sandbox.js';
import { SERVER_VERSION, createServer } from './server.js';

const USAGE = `ts-mcp-server [PROJECT_DIR]

Serves three read-only tools (list_files, read_file, git_log) over MCP on stdio.
PROJECT_DIR defaults to the current directory; nothing outside it is ever read.`;

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (arg === '--version' || arg === '-V') {
    console.log(`ts-mcp-server ${SERVER_VERSION}`);
    return 0;
  }
  const root = arg ?? '.';

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create(root);
  } catch (error) {
    // stdout carries the protocol, so every diagnostic goes to stderr.
    console.error(
      `error: cannot use ${JSON.stringify(root)} as the project directory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  console.error(`ts-mcp-server: serving ${sandbox.root}`);
  await createServer(sandbox).connect(new StdioServerTransport());
  return -1; // keep running until stdin closes
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
