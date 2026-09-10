import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  checkHandshake,
  checkUnauthorized,
  stopChild,
  unusedPort,
  waitForHealth,
  TEST_KEY,
} from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const env = {
  ...process.env,
  ANYCRAWL_API_KEY: TEST_KEY,
  ANYCRAWL_BASE_URL: 'http://127.0.0.1:1',
  LOG_LEVEL: 'error',
};

test(
  'real CLI: STDIO handshake with an unresponsive roots client',
  { timeout: 10000 },
  async () => {
    await checkHandshake(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli],
        stderr: 'pipe',
        env: { ...env, ANYCRAWL_MODE: 'STDIO', CLOUD_SERVICE: 'false' },
      })
    );
  }
);

for (const mode of ['MCP', 'SSE']) {
  test(`real CLI: ${mode} authentication, handshake and tools`, { timeout: 20000 }, async () => {
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [cli], {
      env: {
        ...env,
        ANYCRAWL_MODE: mode,
        CLOUD_SERVICE: 'true',
        ANYCRAWL_HOST: '127.0.0.1',
        ANYCRAWL_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (data) => {
      logs += data;
    });
    child.stderr.on('data', (data) => {
      logs += data;
    });
    try {
      await waitForHealth(`${base}/health`, child, () => logs);
      await checkUnauthorized(`${base}/${mode === 'MCP' ? 'mcp' : 'sse'}`, mode);
      const headers = { 'x-anycrawl-api-key': TEST_KEY };
      const transport =
        mode === 'MCP'
          ? new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } })
          : new SSEClientTransport(new URL(`${base}/sse`), {
              requestInit: { headers },
              fetch: (url, init) =>
                fetch(url, {
                  ...init,
                  headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
                }),
            });
      await checkHandshake(transport);
    } catch (error) {
      error.message += `\nServer logs:\n${logs}`;
      throw error;
    } finally {
      await stopChild(child);
    }
  });
}
