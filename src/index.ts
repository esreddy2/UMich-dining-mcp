#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const handle = serveStdio(() => createServer(), {
  onerror: (error) => {
    // stdout is the protocol channel, so every log line goes to stderr.
    process.stderr.write(`umich-dining-mcp: ${error.message}\n`);
  },
});

const shutdown = (): void => {
  void handle.close().finally(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
