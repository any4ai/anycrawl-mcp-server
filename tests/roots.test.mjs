import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// An absolute module URL allows the same regression to be run against the
// separately installed 3.17.0 release, without changing this project's lockfile.
const { FastMCPSession } = await import(process.env.FASTMCP_TEST_MODULE || 'fastmcp');

for (const enabled of [false, true]) {
  test(
    `roots enabled=${enabled}: session initialization respects configuration`,
    { timeout: 5000 },
    async (context) => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      const messages = [];
      const session = new FastMCPSession({
        name: 'roots-regression',
        version: '1.0.0',
        logger: console,
        roots: { enabled },
        ping: { enabled: false },
        tools: [],
        prompts: [],
        resources: [],
        resourcesTemplates: [],
      });
      client.onmessage = async (message) => {
        messages.push(message);
        // In the disabled case, deliberately NEVER answer roots/list.
        // The enabled control proves the transport observes real requests.
        if (enabled && message.method === 'roots/list') {
          await client.send({ jsonrpc: '2.0', id: message.id, result: { roots: [] } });
        }
      };
      let timer;
      let connected;
      try {
        connected = session.connect(server);
        await client.start();
        await client.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'roots-regression', version: '1.0.0' },
            capabilities: { roots: { listChanged: true } },
          },
        });
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await Promise.race([
          connected,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Session did not become ready within 2000ms')),
              2000
            );
          }),
        ]);
        assert.equal(session.isReady, true);
        assert.deepEqual(session.clientCapabilities.roots, { listChanged: true });
        assert.ok(messages.some((message) => message.id === 1 && message.result));
        assert.equal(
          messages.filter((message) => message.method === 'roots/list').length,
          enabled ? 1 : 0
        );
      } finally {
        clearTimeout(timer);
        context.diagnostic(
          `roots/list requests: ${messages.filter((message) => message.method === 'roots/list').length}`
        );
        await session.close();
        await connected;
        // Older FastMCP can resume connect() after close() and install a
        // ping timer. Close again after it settles so failed baselines exit.
        await session.close();
      }
    }
  );
}
