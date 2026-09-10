# MCP roots fix: release and rollback

The application disables roots. FastMCP 3.17.0 could still issue `roots/list`
during session initialization when the client advertises `roots.listChanged`.
An unanswered request delays session readiness. Commit b8b6fd7 upgraded FastMCP;
the follow-up fixes pin 4.7.1, align Docker/CI on Node 22, add real handshake
coverage, and complete the combined-image publishing job.

The container gate also caught an invalid `default_type` directive inside an
Nginx `if` block; it now lives at location scope. Missing credentials explicitly
return HTTP 401 for both Streamable HTTP and legacy SSE.

## Release gates

1. `npm ci` and `npm test` pass on Node 22 (minimum supported Node: 22.12).
   The tests use the installed FastMCP and built CLI. No remote AnyCrawl API is
   needed. Existing opt-in real API tests remain opt-in.
2. The disabled-roots session becomes ready within 2 seconds with zero
   `roots/list` requests even when the client advertises roots and never answers.
   The enabled-roots control observes one request and responds with empty roots.
3. Real STDIO, Streamable HTTP and SSE handshakes list the expected tools;
   invalid tool arguments are rejected without calling the remote API.
4. Both standard and combined images pass the container test on the published
   architectures. It checks the actual Node/FastMCP versions, the CLI, Nginx
   API-key-prefix and header routes, the SSE message URL rewrite, health and
   missing-credential rejection. Health alone is not handshake verification.
   STDIO container startup has a separate 10-second deadline; the 2-second
   initialization deadline begins at the CLI's startup log, immediately before
   `server.start()`. This excludes slow module loading under architecture
   emulation without bypassing FastMCP's client-capability polling window.
5. Record the Git commit, lockfile, CI run, image digests, and OCI revision labels.
   The standard image is for STDIO by default; the `-combined` image runs the
   HTTP/SSE services and Nginx. Release jobs depend on the verification workflow.

## Check the currently deployed instance

For every production replica, record its container/image ID and repository
digest, OCI `org.opencontainers.image.revision` label, `node --version`, and the
version from `/app/node_modules/fastmcp/package.json`. Do not infer its runtime
version from the current source branch or from a mutable tag.

Compare the result with the candidate image. If production still runs 3.17.0,
trace the deployment's exact build source and registry artifact. In particular,
the old combined publish job did not include a build-and-push step.
Actual production inventory remains an operator check; local verification does
not establish what is deployed.

## Reproduce the old failure in isolation

The pre-upgrade lockfile paired FastMCP 3.17.0 with MCP SDK 1.18.1. Installing
3.17.0 alone today resolves a newer SDK and can fail before session setup with
`Server does not support completions`, which does not reproduce the roots bug.

```sh
baseline_dir=$(mktemp -d)
npm install --prefix "$baseline_dir" --save-exact --ignore-scripts --no-audit --no-fund \
  --registry=https://registry.npmjs.org fastmcp@3.17.0 @modelcontextprotocol/sdk@1.18.1
FASTMCP_TEST_MODULE="file://$baseline_dir/node_modules/fastmcp/dist/FastMCP.js" \
  node --test --test-force-exit tests/roots.test.mjs
```

Expected: exit 1, disabled-roots test fails its 2-second readiness deadline and
reports one `roots/list` request; enabled-roots control passes. The force-exit
flag applies only after all test assertions finish, because the old SDK can
retain a request timer after closing a failed connection. Normal project tests
do not use that flag. Running `node --test tests/roots.test.mjs` with the pinned
4.7.1 installation must pass and report zero requests for disabled roots.

## Canary and acceptance

Deploy the verified combined image by immutable digest to one replica. Keep
the previous image digest and deployment configuration available. Repeat the
runtime/version inspection inside the new container before moving traffic.

Use a controlled MCP client with `roots.listChanged=true` that keeps its server
receive stream open and counts but never answers `roots/list`. Make 100 fresh
connections through the production Nginx route, including `notifications/initialized`
and `tools/list`. Require zero roots requests, 100 successful connections, and
no client startup timeout. Record handshake/list latency separately from cold
container startup; investigate any connection exceeding 2 seconds rather than
increasing the client timeout. Close each session after the check.

Verify existing auth methods, legacy SSE, and one authorized tool call with a
controlled URL. Observe errors and restarts for at least 15 minutes before
expanding traffic. Never include real API keys, authorization headers or
key-bearing URLs in release records or test output.

## Rollback

Stop rollout if roots requests return, handshake/auth failures occur, or the
new instances restart unexpectedly. Restore the recorded image digest and
configuration, then repeat health and handshake checks. Rolling back to a
3.17.0 image also restores the roots defect; record that limitation explicitly.

Do not silently replace FastMCP with a patched old release. If the 4.7.1 upgrade
has a verified compatibility blocker, report it and propose a separately
reviewable, reproducible 3.17.0 patch with the same regression gates.

## Local verification record — 2026-09-10

- Node 22.14.0: TypeScript build, 28 existing tests and 5 new real handshake /
  roots tests passed. One opt-in real API test was skipped.
- Baseline FastMCP 3.17.0 + SDK 1.18.1: disabled roots produced one request and
  failed the 2-second ready deadline. The enabled-roots control passed.
- Pinned FastMCP 4.7.1: disabled roots produced zero requests and became ready
  in approximately 109 ms. The enabled-roots control observed one request.
- Standard and combined images built successfully for ARM64 and AMD64 and
  passed the container suite, using Node 22.23.2 and FastMCP 4.7.1. AMD64 ran
  under emulation on the ARM64 host; its STDIO cold start took about 4.1 seconds,
  followed by a 152 ms protocol handshake. All observed roots counts were zero.
- Workflow YAML/required job dependencies, package/lockfile consistency and
  whitespace checks passed. Hosted GitHub Actions and publishing were not run.
- ESLint is blocked by the existing `.eslintrc.json` extension
  `@typescript-eslint/recommended`, which ESLint cannot resolve. No alternative
  lint rules were substituted and lint is not recorded as passing.
- No production instances were changed. Runtime inventory, the production
  canary, and a real authorized API call remain release-time checks.
