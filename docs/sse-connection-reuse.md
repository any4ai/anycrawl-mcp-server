# SSE POST acknowledgement framing

The legacy SSE transport in mcp-proxy sends `202 Accepted` without a
Content-Length. Disabling chunked transfer encoding in Nginx's `/messages`
locations left those HTTP/1.1 responses without a body-length delimiter. The
container consequently returned `Connection: close` on every successful POST.
`proxy_set_header Connection ""` affects upstream requests and does not fix this
downstream response framing.

Both the API-key-prefixed and header-authenticated `/messages` locations now
explicitly allow chunked transfer encoding. Their POST acknowledgements can end
without closing TCP. The SSE GET routes and buffering settings are unchanged.

## Validation

An isolated comparison on 2026-09-10 used three sessions per variant and client
mode, alternating order. Each session initialized and listed six tools five
times. All 18 sessions and 90 lists succeeded; roots requests were zero.

| Local HTTP container                                  | Default SDK connections per session | Body-draining client connections |
| ----------------------------------------------------- | ----------------------------------: | -------------------------------: |
| Original Nginx configuration                          |                                   9 |                                8 |
| Chunked POST acknowledgements enabled                 |                                   2 |                                2 |
| Empty 202 with explicit length (isolated alternative) |                                   2 |                                2 |

Client: Node 24.3.0 native fetch, MCP SDK 1.29.0, an explicit Undici 5.29.0
Agent with two connections and pipelining 1. Counts are successful connection
events, including the long-lived SSE connection, and were identical in all three
rounds. The empty-202 dependency patch was only an experiment and is not shipped.

The existing default-SDK container handshake remains in place. A separate
`tests/sse-reuse.mjs` check drains only short POST acknowledgements with a
4096-byte cap and 2-second deadline. It checks 202 framing and connection
headers, then proves initialization and five lists reuse one POST socket on
both route styles. This isolates server framing from a client's body-cancel
behavior. It runs through `npm run test:containers` in the existing ARM64/AMD64
release gates.

These are local HTTP results, not a reproduction of the historical 5.33-second
public request. Outer HTTPS proxies can change response framing. Recheck the
deployed HTTPS/Tunnel path before claiming a latency improvement. A controlled
SSE client should still drain successful short POST responses with strict size
and time limits: cancelling an incomplete response can independently lose
connection reuse. Never fully buffer the SSE GET stream or retry business POSTs
as a connection-reuse workaround.
