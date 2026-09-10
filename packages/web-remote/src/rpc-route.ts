/**
 * The `/remote-access` HTTP route: the browser half's unary RPC channel.
 *
 * The plugin registers it on the DSH web server (`ctx.webServer.register`)
 * instead of using the connection service's own `rpc.handle(...)`: since dsh
 * `0.1.5-rc.2` that helper reaches `owner.webServer` through a service shadow
 * that cannot resolve `webServer` for third-party plugin rows and aborts the
 * whole plugin tree at boot (upstream regression, deepseek-harness discussion
 * #5926). The wire contract is deliberately the connection service's own —
 * `POST <channel>/<endpoint>` carrying a `client-request` envelope and
 * answering with a `server-response` envelope, behind the same official
 * Host/Origin + browser-session fence — so the browser half is unchanged and
 * one code path serves both dsh `0.1.2-rc.1` and `0.1.5-rc.2`.
 *
 * The status semantics mirror `dsh-client-connection`'s `rpcFetchHandler`:
 * 404 wrong method/endpoint, 415 wrong content type, 400 unparsable body,
 * 500 a throwing handler, and 200 for every envelope-level outcome — including
 * an invalid envelope or a `method` that disagrees with the path, which are
 * reported as `gateway/bad-request` business failures.
 *
 * Kept free of filesystem and tunnel state so the protocol can be unit-tested
 * without touching the host's real rdsh configuration.
 * @module
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** One business result, enveloped for the browser half. */
export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** One business endpoint of the browser half's RPC channel. */
export type RpcDispatch = (
  endpoint: string,
  payload: { args?: Record<string, unknown> },
  signal: AbortSignal,
) => Promise<RpcResult>;

/** Channel path the browser half calls (`client.js`): POST `<path>/<endpoint>`. */
export const RPC_CHANNEL = "/remote-access";

/** Business payloads are tiny (hub url, token, access code); the cap bounds a hostile body. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/** Correlation id the connection service answers with when the envelope carries none. */
const INVALID_REQUEST_RPC_ID = "invalid-request";

/** Endpoint segment shape the connection service accepts. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** The slice of the DSH connection service this plugin uses. */
export interface ConnectionService {
  /** Official Host/Origin fence + browser-session check, shared with DSH's own routes. */
  requestRejection(request: Request): number | undefined;
  /** 0.1.2+ in-process launch-token exchange; absent on older dsh. */
  authenticatedUrl?: (baseUrl: string) => string;
}

/** One prefix route as the DSH web server (`webServer.register`) accepts it. */
export interface WebServerRoute {
  kind: "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** The slice of the DSH web-server service this plugin uses. */
export interface WebServerService {
  port: number;
  register(route: WebServerRoute): unknown;
}

/** Serialize one business result into the envelope the browser half parses. */
function serverResponse(rpcId: string, result: RpcResult): string {
  return JSON.stringify({ type: "server-response", rpcId, result });
}

/** Answer an envelope failure the way the connection service does: 200 + `gateway/bad-request`. */
function envelopeFailure(res: ServerResponse, rpcId: string, message: string): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(serverResponse(rpcId, { ok: false, error: { code: "gateway/bad-request", message, details: {} } }));
}

/** Whether a parsed JSON value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Endpoint named by the path, or `undefined` when the path is not exactly `<channel>/<segment>`. */
function endpointFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(`${RPC_CHANNEL}/`)) return undefined;
  const endpoint = pathname.slice(RPC_CHANNEL.length + 1);
  const segments = endpoint.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined;
  }
  return endpoint;
}

/**
 * Buffer the request body under `MAX_REQUEST_BODY_BYTES`. When the cap is
 * exceeded the caller has already answered 413 and destroyed the socket, so a
 * hostile caller cannot grow the buffer.
 * @param req - incoming request.
 * @param res - response used to refuse an oversized body.
 * @returns the body, or `null` when the request was refused.
 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    received += buffer.byteLength;
    if (received > MAX_REQUEST_BODY_BYTES) {
      res.writeHead(413, { connection: "close" });
      res.end();
      req.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Serve one call on the browser half's RPC channel: the official Host/Origin +
 * browser-session fence first, then the connection service's own status
 * semantics.
 * @param connection - connection service providing the official fence.
 * @param req - incoming node request.
 * @param res - node response this handler owns to completion.
 * @param dispatch - business endpoint switch of the channel.
 */
export async function handleRpcRoute(
  connection: ConnectionService,
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: RpcDispatch,
): Promise<void> {
  /* node:http always sets url/method on server requests; the fallbacks keep the
  handler total for hand-built requests. */
  const url = new URL(req.url ?? `${RPC_CHANNEL}/`, "http://dsh.internal");
  /* String-valued headers only: the fence reads Host/Origin/Cookie, and
  set-cookie style array headers never appear on a request. */
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
  }

  // The body is deliberately not read yet: an unauthenticated caller is
  // rejected before any buffering happens.
  const rejection = connection.requestRejection(
    new Request(`${url.origin}${url.pathname}`, { method: req.method ?? "POST", headers }),
  );
  if (rejection !== undefined) {
    res.writeHead(rejection, { "content-type": "text/plain" });
    res.end(rejection === 401 ? "unauthorized" : "forbidden");
    return;
  }

  const endpoint = endpointFromPath(url.pathname);
  if ((req.method ?? "GET") !== "POST" || endpoint === undefined) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  if ((req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    res.writeHead(415, { "content-type": "text/plain" });
    res.end("content type must be application/json");
    return;
  }

  const body = await readBody(req, res);
  if (body === null) return;

  let envelope: unknown;
  try {
    envelope = JSON.parse(body.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("body is not JSON");
    return;
  }
  const rpcId = isRecord(envelope) && typeof envelope.rpcId === "string" ? envelope.rpcId : undefined;
  if (
    !isRecord(envelope)
    || envelope.type !== "client-request"
    || rpcId === undefined
    || typeof envelope.method !== "string"
  ) {
    envelopeFailure(res, rpcId ?? INVALID_REQUEST_RPC_ID, "invalid client-request message");
    return;
  }
  // The path names the endpoint; the envelope must agree, exactly as the
  // connection service's own bridge requires.
  if (envelope.method !== endpoint) {
    envelopeFailure(res, rpcId, `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`);
    return;
  }

  // Abort the business call when the caller goes away mid-request.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const payload = isRecord(envelope.payload) ? (envelope.payload as { args?: Record<string, unknown> }) : {};
  let result: RpcResult;
  try {
    result = await dispatch(endpoint, payload, abort.signal);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`handler failure: ${String(error)}`);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(serverResponse(rpcId, result));
}
