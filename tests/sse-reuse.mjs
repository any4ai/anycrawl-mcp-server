import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Test Nginx's HTTP/1.1 framing separately from the SDK's cancellation of POST
// bodies. Drain only the short POST acknowledgement; GET remains an SSE stream.
export async function checkSsePostReuse(url, headers = {}) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const sockets = new Set();
  const posts = [];
  const client = new Client({ name: 'sse-reuse-regression', version: '1.0.0' });
  const transport = new SSEClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: (input, init) => {
      if (init?.method !== 'POST') return fetch(input, init);
      const post = new Promise((resolve, reject) => {
        const req = request(
          input,
          {
            method: 'POST',
            headers: Object.fromEntries(new Headers(init.headers)),
            agent,
            signal: init.signal,
          },
          (res) => {
            const chunks = [];
            let bytes = 0;
            res.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 4096) {
                res.destroy(new Error('SSE POST acknowledgement exceeded 4096 bytes'));
                return;
              }
              chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
              clearTimeout(timer);
              try {
                assert.equal(res.statusCode, 202);
                assert.equal(res.complete, true);
                assert.doesNotMatch(res.headers.connection ?? '', /\bclose\b/i);
                const length = res.headers['content-length'];
                const chunked = /\bchunked\b/i.test(res.headers['transfer-encoding'] ?? '');
                assert.ok(
                  chunked || (length !== undefined && /^\d+$/.test(length)),
                  'SSE POST 202 must have explicit framing to preserve its connection'
                );
                if (length !== undefined) assert.equal(Number(length), bytes);
                resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }));
              } catch (error) {
                reject(error);
              }
            });
          }
        );
        const timer = setTimeout(() => req.destroy(new Error('SSE POST exceeded 2000ms')), 2000);
        req.on('socket', (socket) => sockets.add(socket));
        req.on('error', reject);
        req.on('close', () => clearTimeout(timer));
        req.end(init.body);
      });
      // Observe failures immediately even if the result reaches the client via
      // SSE before the POST acknowledgement finishes. Await all of them below.
      post.catch(() => {});
      posts.push(post);
      return post;
    },
  });
  try {
    await client.connect(transport, { timeout: 2000 });
    for (let i = 0; i < 5; i++) {
      const result = await client.listTools({}, { timeout: 2000 });
      assert.equal(result.tools.length, 6);
    }
    await Promise.all(posts);
    assert.equal(posts.length, 7, 'Expected initialize, initialized, and five list requests');
    assert.equal(sockets.size, 1, 'Successful SSE POSTs should reuse a single connection');
    return { posts: posts.length, postConnections: sockets.size, toolLists: 5 };
  } finally {
    await client.close();
    agent.destroy();
  }
}
