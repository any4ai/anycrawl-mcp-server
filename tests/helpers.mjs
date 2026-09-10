import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export const TEST_KEY = 'handshake-test-key';

export async function checkUnauthorized(url, mode) {
  const response = await fetch(url, {
    method: mode === 'MCP' ? 'POST' : 'GET',
    headers: {
      Accept: mode === 'MCP' ? 'application/json, text/event-stream' : 'text/event-stream',
      'Content-Type': 'application/json',
    },
    ...(mode === 'MCP'
      ? {
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              clientInfo: { name: 'unauthorized-test', version: '1.0.0' },
              capabilities: {},
            },
          }),
        }
      : {}),
    signal: AbortSignal.timeout(2000),
  });
  await response.body?.cancel();
  assert.equal(response.status, 401);
}

export async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

export async function waitForHealth(url, child, diagnostics = () => '') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child && child.exitCode !== null) {
      throw new Error(`Server exited (${child.exitCode}): ${diagnostics()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      // Only startup connection errors are retried; the deadline is bounded.
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
    }
    await delay(100);
  }
  throw new Error(`Health endpoint not ready: ${url}\n${diagnostics()}`);
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHandshake(transport, { stdioStartup = false } = {}) {
  const client = new Client(
    { name: 'handshake-regression', version: '1.0.0' },
    {
      capabilities: { roots: { listChanged: true } },
    }
  );
  const errors = [];
  client.onerror = (error) => errors.push(error);
  let rootsRequests = 0;
  let timer;
  let rejectDeadline;
  let rejectStartup;
  let startupListener;
  let handshakeStarted;
  const started = performance.now();
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const startup = stdioStartup
    ? new Promise((resolve, reject) => {
        assert.ok(transport.stderr, 'STDIO startup measurement requires piped stderr');
        rejectStartup = reject;
        let output = '';
        startupListener = (data) => {
          output += data;
          // This log is emitted immediately before server.start(), after module
          // loading. Initialization is sent as soon as it appears, during the
          // capability-polling window that triggers the original roots bug.
          if (output.includes('Starting AnyCrawl FastMCP Server in STDIO mode')) resolve();
        };
        transport.stderr.on('data', startupListener);
      })
    : Promise.resolve();
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const receive = transport.onmessage;
    transport.onmessage = (message, ...extra) => {
      if (message.method === 'roots/list') {
        rootsRequests++;
        return; // Model a client that never answers this request.
      }
      receive?.(message, ...extra);
    };
    await start();
    await startup;
    handshakeStarted = performance.now();
    clearTimeout(timer);
    timer = setTimeout(() => rejectDeadline(new Error('Handshake exceeded 2000ms')), 2000);
  };
  try {
    timer = setTimeout(
      () => rejectDeadline(new Error('Transport startup exceeded its deadline')),
      stdioStartup ? 10000 : 2000
    );
    await Promise.race([client.connect(transport, { timeout: 2000 }), deadline]);
    clearTimeout(timer);
    const handshakeMs = Math.round(performance.now() - handshakeStarted);
    const result = await client.listTools({}, { timeout: 2000 });
    const names = result.tools.map((tool) => tool.name);
    for (const name of ['anycrawl_scrape', 'anycrawl_crawl', 'anycrawl_search']) {
      assert.ok(names.includes(name), `Missing tool ${name}`);
    }
    // Exercise FastMCP's real parameter validation without a remote API call.
    await assert.rejects(
      client.callTool({ name: 'anycrawl_scrape', arguments: { url: 'not-a-url' } }, undefined, {
        timeout: 2000,
      }),
      { code: -32602 }
    );
    await client.notification({ method: 'notifications/roots/list_changed' });
    // FastMCP polls capabilities every 100ms. Keep the receive channel open
    // through that poll, also covering roots-change notifications.
    await delay(250);
    assert.equal(rootsRequests, 0, 'Roots-disabled server sent roots/list');
    assert.deepEqual(errors, [], 'Transport reported an error');
    return {
      rootsRequests,
      tools: names.length,
      startupMs: Math.round(handshakeStarted - started),
      handshakeMs,
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
    if (startupListener) transport.stderr.off('data', startupListener);
    rejectStartup?.(new Error('Client closed during startup'));
    try {
      if (transport.sessionId && typeof transport.terminateSession === 'function') {
        await transport.terminateSession();
      }
    } finally {
      await client.close();
    }
  }
}
