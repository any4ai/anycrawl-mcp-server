import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { checkHandshake, checkUnauthorized, waitForHealth, TEST_KEY } from '../tests/helpers.mjs';
import { checkSsePostReuse } from '../tests/sse-reuse.mjs';

const [standardImage, combinedImage] = process.argv.slice(2);
assert.ok(
  standardImage && combinedImage,
  'Usage: npm run test:containers -- <standard-image> <combined-image>'
);
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  // docker logs separates the application's stdout and stderr. Inspect both.
  return (result.stdout + (args[0] === 'logs' ? result.stderr : '')).trim();
};
const suffix = randomUUID().slice(0, 8);
const stdioName = `anycrawl-stdio-test-${suffix}`;
const combinedName = `anycrawl-combined-test-${suffix}`;
const platform = process.env.TEST_DOCKER_PLATFORM
  ? ['--platform', process.env.TEST_DOCKER_PLATFORM]
  : [];
const inspectRuntime = `console.log(JSON.stringify({node:process.versions.node,fastmcp:require('/app/node_modules/fastmcp/package.json').version}))`;

try {
  for (const image of [standardImage, combinedImage]) {
    const runtime = JSON.parse(
      docker('run', '--rm', ...platform, '--entrypoint', 'node', image, '-e', inspectRuntime)
    );
    assert.equal(runtime.node.split('.')[0], '22');
    assert.ok(Number(runtime.node.split('.')[1]) >= 12, 'Node 22.12+ is required');
    assert.equal(runtime.fastmcp, '4.7.1');
    console.log(JSON.stringify({ image, ...runtime }));
  }
  console.log(
    'STDIO',
    await checkHandshake(
      new StdioClientTransport({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          ...platform,
          '--name',
          stdioName,
          '-e',
          'CLOUD_SERVICE=false',
          '-e',
          `ANYCRAWL_API_KEY=${TEST_KEY}`,
          '-e',
          'LOG_LEVEL=info',
          standardImage,
        ],
        stderr: 'pipe',
      }),
      { stdioStartup: true }
    )
  );

  docker('run', '-d', ...platform, '--name', combinedName, '-p', '127.0.0.1::80', combinedImage);
  const address = docker('port', combinedName, '80/tcp');
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = `http://${address}`;
  await waitForHealth(`${base}/health`, null, () => docker('logs', combinedName));

  await checkUnauthorized(`${base}/mcp`, 'MCP');
  await checkUnauthorized(`${base}/sse`, 'SSE');

  for (const [route, headers] of [
    [`/${TEST_KEY}/mcp`, {}],
    ['/mcp', { 'x-anycrawl-api-key': TEST_KEY }],
    ['/mcp', { Authorization: `Bearer ${TEST_KEY}` }],
  ]) {
    console.log(
      'Nginx MCP',
      await checkHandshake(
        new StreamableHTTPClientTransport(new URL(`${base}${route}`), {
          requestInit: { headers },
        })
      )
    );
  }
  console.log(
    'Nginx SSE',
    await checkHandshake(new SSEClientTransport(new URL(`${base}/${TEST_KEY}/sse`)))
  );

  for (const [route, headers] of [
    [`/${TEST_KEY}/sse`, {}],
    ['/sse', { 'x-anycrawl-api-key': TEST_KEY }],
  ]) {
    console.log('Nginx SSE POST reuse', await checkSsePostReuse(`${base}${route}`, headers));
  }

  const wrongEndpoint = await fetch(`${base}/${TEST_KEY}/sse`, {
    headers: { Accept: 'application/json, text/event-stream' },
    signal: AbortSignal.timeout(2000),
  });
  await wrongEndpoint.body?.cancel();
  assert.equal(wrongEndpoint.status, 400);

  for (const endpoint of ['/health_mcp', '/health_sse']) {
    const response = await fetch(`${base}${endpoint}`, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    assert.equal(response.status, 200);
  }
  const logs = docker('logs', combinedName);
  assert.doesNotMatch(logs, /received error listing roots|Request timed out/);
  console.log('Container handshake checks passed.');
} finally {
  // Remove only containers created by this invocation, including on failures.
  for (const name of [stdioName, combinedName]) {
    const existing = docker('ps', '-aq', '--filter', `name=^/${name}$`);
    if (existing) docker('rm', '-f', name);
  }
}
