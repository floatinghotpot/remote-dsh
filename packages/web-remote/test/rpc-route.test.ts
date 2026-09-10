/**
 * Protocol tests for the `/remote-access` RPC route.
 *
 * The route is the plugin's only browser-facing surface, and its status
 * semantics must stay the connection service's own (404 / 415 / 413 / 400 /
 * 200-with-business-result) so the browser half needs no changes. Imported
 * module keeps the tunnel and filesystem out, so these tests never touch the
 * host's real rdsh configuration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_REQUEST_BODY_BYTES, RPC_CHANNEL, handleRpcRoute } from "../src/rpc-route.ts";
import type { ConnectionService, RpcDispatch } from "../src/rpc-route.ts";

interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

/** Minimal node response double capturing what the route writes. */
function makeRes(): { res: ServerResponse; rec: Recorded } {
  const rec: Recorded = { status: 0, headers: {}, body: "", ended: false };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      rec.status = status;
      if (headers !== undefined) rec.headers = headers;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.body += chunk;
      rec.ended = true;
      return res;
    },
    on() {
      return res;
    },
    get writableEnded() {
      return rec.ended;
    },
  };
  return { res: res as unknown as ServerResponse, rec };
}

/** Minimal node request double: headers, method, url, and one body chunk. */
function makeReq(
  body: string,
  options: { method?: string; url?: string; contentType?: string | null; contentLength?: string } = {},
): IncomingMessage {
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["content-type"] = contentType;
  headers["content-length"] = options.contentLength ?? String(Buffer.byteLength(body));
  const chunks = body === "" ? [] : [Buffer.from(body)];
  const req = {
    method: options.method ?? "POST",
    url: options.url ?? `${RPC_CHANNEL}/state`,
    headers,
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return req as unknown as IncomingMessage;
}

const allowAll: ConnectionService = { requestRejection: () => undefined };

function envelope(endpoint: string, args: Record<string, unknown> = {}, rpcId = "r1"): string {
  return JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } });
}

const okDispatch: RpcDispatch = async (endpoint, payload) => ({ ok: true, value: { endpoint, args: payload.args } });

test("fence: an unauthenticated caller is refused before the body is read", async () => {
  const { res, rec } = makeRes();
  let dispatched = false;
  const connection: ConnectionService = { requestRejection: () => 401 };
  await handleRpcRoute(connection, makeReq(envelope("state")), res, async () => {
    dispatched = true;
    return { ok: true, value: null };
  });
  assert.equal(rec.status, 401);
  assert.equal(rec.body, "unauthorized");
  assert.equal(dispatched, false);
});

test("fence: a non-401 refusal keeps its status", async () => {
  const { res, rec } = makeRes();
  const connection: ConnectionService = { requestRejection: () => 403 };
  await handleRpcRoute(connection, makeReq(envelope("state")), res, okDispatch);
  assert.equal(rec.status, 403);
  assert.equal(rec.body, "forbidden");
});

test("404: a non-POST call", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(allowAll, makeReq("", { method: "GET" }), res, okDispatch);
  assert.equal(rec.status, 404);
});

test("404: a path that names no endpoint", async () => {
  for (const url of [`${RPC_CHANNEL}`, `${RPC_CHANNEL}/`, `${RPC_CHANNEL}/a//b`, `${RPC_CHANNEL}/..`]) {
    const { res, rec } = makeRes();
    await handleRpcRoute(allowAll, makeReq(envelope("state"), { url }), res, okDispatch);
    assert.equal(rec.status, 404, `expected 404 for ${url}`);
  }
});

test("200: a multi-segment endpoint is accepted, as the connection service accepts it", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(
    allowAll,
    makeReq(envelope("remote-access/state"), { url: `${RPC_CHANNEL}/remote-access/state` }),
    res,
    okDispatch,
  );
  assert.equal(rec.status, 200);
  const parsed = JSON.parse(rec.body) as { result: { ok: boolean; value: { endpoint: string } } };
  assert.equal(parsed.result.value.endpoint, "remote-access/state");
});

test("415: a non-JSON content type", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(allowAll, makeReq(envelope("state"), { contentType: "text/plain" }), res, okDispatch);
  assert.equal(rec.status, 415);
});

test("415: a JSON content type with a charset is accepted", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(
    allowAll,
    makeReq(envelope("state"), { contentType: "application/json; charset=utf-8" }),
    res,
    okDispatch,
  );
  assert.equal(rec.status, 200);
});

test("413: a declared body above the cap", async () => {
  const { res, rec } = makeRes();
  let dispatched = false;
  await handleRpcRoute(allowAll, makeReq("", { contentLength: String(MAX_REQUEST_BODY_BYTES + 1) }), res, async () => {
    dispatched = true;
    return { ok: true, value: null };
  });
  assert.equal(rec.status, 413);
  assert.equal(rec.headers.connection, "close");
  assert.equal(dispatched, false);
});

test("400: a body that is not JSON", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(allowAll, makeReq("not json"), res, okDispatch);
  assert.equal(rec.status, 400);
  assert.equal(rec.body, "body is not JSON");
});

test("200: an invalid envelope is answered as a gateway/bad-request failure", async () => {
  const cases: Array<[string, string]> = [
    ['{"nope":1}', "invalid-request"],
    ['{"type":"client-request","method":"state"}', "invalid-request"],
    ['{"type":"client-request","rpcId":"r3","payload":{}}', "r3"],
  ];
  for (const [body, expectedRpcId] of cases) {
    const { res, rec } = makeRes();
    await handleRpcRoute(allowAll, makeReq(body), res, okDispatch);
    assert.equal(rec.status, 200, `expected 200 for ${body}`);
    const parsed = JSON.parse(rec.body) as { rpcId: string; result: { ok: boolean; error: { code: string } } };
    assert.equal(parsed.rpcId, expectedRpcId, `rpcId for ${body}`);
    assert.equal(parsed.result.ok, false);
    assert.equal(parsed.result.error.code, "gateway/bad-request");
  }
});

test("200: a malformed envelope echoes the rpcId it carried", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(allowAll, makeReq('{"type":"client-request","rpcId":"r7","payload":{}}'), res, okDispatch);
  assert.equal(rec.status, 200);
  assert.equal((JSON.parse(rec.body) as { rpcId: string }).rpcId, "r7");
});

test("200: a method that disagrees with the path is a gateway/bad-request failure", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(allowAll, makeReq(envelope("connect")), res, okDispatch);
  assert.equal(rec.status, 200);
  const parsed = JSON.parse(rec.body) as { rpcId: string; result: { ok: boolean; error: { code: string; message: string } } };
  assert.equal(parsed.rpcId, "r1");
  assert.equal(parsed.result.ok, false);
  assert.equal(parsed.result.error.code, "gateway/bad-request");
  assert.match(parsed.result.error.message, /does not match endpoint/);
});

test("500: a throwing handler is reported as a transport failure", async () => {
  const { res, rec } = makeRes();
  const throwing: RpcDispatch = async () => {
    throw new Error("boom");
  };
  await handleRpcRoute(allowAll, makeReq(envelope("state")), res, throwing);
  assert.equal(rec.status, 500);
  assert.match(rec.body, /handler failure: Error: boom/);
});

test("200: the business result is enveloped with the echoed rpcId", async () => {
  const { res, rec } = makeRes();
  await handleRpcRoute(
    allowAll,
    makeReq(envelope("connect", { hub: "https://rdsh.cn" }, "rpc-42"), { url: `${RPC_CHANNEL}/connect` }),
    res,
    okDispatch,
  );
  assert.equal(rec.status, 200);
  assert.match(rec.headers["content-type"] ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(rec.body), {
    type: "server-response",
    rpcId: "rpc-42",
    result: { ok: true, value: { endpoint: "connect", args: { hub: "https://rdsh.cn" } } },
  });
});

test("200: a business failure travels inside the envelope", async () => {
  const { res, rec } = makeRes();
  const failing: RpcDispatch = async () => ({ ok: false, error: { code: "bad-request", message: "unknown endpoint" } });
  await handleRpcRoute(allowAll, makeReq(envelope("nope"), { url: `${RPC_CHANNEL}/nope` }), res, failing);
  assert.equal(rec.status, 200);
  const parsed = JSON.parse(rec.body) as { result: { ok: boolean; error: { code: string } } };
  assert.equal(parsed.result.ok, false);
  assert.equal(parsed.result.error.code, "bad-request");
});

test("200: an envelope without args still dispatches (payload passes through)", async () => {
  const { res, rec } = makeRes();
  const seen: unknown[] = [];
  const spy: RpcDispatch = async (_endpoint, payload) => {
    seen.push(payload.args);
    return { ok: true, value: null };
  };
  await handleRpcRoute(allowAll, makeReq('{"type":"client-request","rpcId":"r9","method":"state","payload":{}}'), res, spy);
  assert.equal(rec.status, 200);
  assert.deepEqual(seen, [undefined]);
});
