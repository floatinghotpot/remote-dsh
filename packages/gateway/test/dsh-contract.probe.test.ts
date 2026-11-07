/**
 * Optional contract probe against a real `dsh` installation.
 *
 * The gateway depends on literal, version-specific facts about dsh: the
 * `dsh web --port 0 --no-open` ready line, its launch token, the
 * `dsh-auth-<hash>` browser cookie, the in-page directory-picker module, and
 * the `isLoopbackHostname(pageLocation.hostname)` expression the gateway
 * rewrites at runtime. Upstream renames any of them and the breakage is silent
 * (the loopback rewrite is fail-open).
 *
 * The probe is isolated and skipped unless both variables name a real install:
 *
 *   DSH_PROBE_BIN   absolute path to the dsh executable
 *   DSH_PROBE_HOME  absolute path used as dsh's own home for this run
 *
 * It never touches the user's own dsh/rdsh home: the child inherits this test's
 * `DSH_HOME`/`DSH_AGENTS_HOME` (pointed at `DSH_PROBE_HOME`), `HOME` (pointed at
 * `DSH_PROBE_HOME`'s parent, so `os.homedir()`-based paths — including
 * `clearStaleDshLock` — stay inside the probe), and a nonexistent `RDSH_CONFIG`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  RDSH_REMOTE_TTY,
  checkRemotePickerGraph,
  detectDshVersion,
  exchangeDshSessionCookie,
  spawnDsh,
} from "../src/spawn-dsh.ts";

const BIN = process.env.DSH_PROBE_BIN;
const HOME = process.env.DSH_PROBE_HOME;
const SKIP = BIN === undefined || HOME === undefined
  ? "set DSH_PROBE_BIN and DSH_PROBE_HOME to probe a real dsh installation"
  : false;

/** Fetch text from the probe's dsh, forwarding the browser session cookie. */
async function getText(url: string, cookie: string | null): Promise<string> {
  const response = await fetch(url, cookie === null ? {} : { headers: { cookie } });
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  return response.text();
}

/** Fetch text, or null when the reference is not a served bundle (the boot
 * graph also names resources the index itself answers) or the fetch fails
 * (a dead reference must not abort the whole probe). */
async function tryGetText(url: string, cookie: string | null): Promise<string | null> {
  try {
    const response = await fetch(url, cookie === null ? {} : { headers: { cookie } });
    return response.status === 200 ? response.text() : null;
  } catch {
    return null;
  }
}

/** Whether a graph reference stays on the probe's own origin. A test must not
 * egress: the boot graph is document-relative, so anything absolute and foreign
 * (including protocol-relative `//host/…`) is not a bundle this probe inspects. */
function sameOrigin(url: string, origin: string): boolean {
  if (url.startsWith("//")) return false;
  if (!url.startsWith("http")) return true;
  return url === origin || url.startsWith(`${origin}/`);
}

test("dsh contract probe: wiring the gateway relies on still works", { skip: SKIP, timeout: 180_000 }, async () => {
  const bin = BIN!;
  const home = HOME!;

  // 1) `dsh --version` still prints one parseable semver line.
  const version = await detectDshVersion(bin);
  assert.ok(version !== null && /^\d+\.\d+\.\d+/.test(version), `unparseable dsh version: ${version}`);

  const saved = {
    home: process.env.DSH_HOME,
    agents: process.env.DSH_AGENTS_HOME,
    tty: process.env.SSH_TTY,
    rdsh: process.env.RDSH_CONFIG,
    userHome: process.env.HOME,
  };

  let dsh: Awaited<ReturnType<typeof spawnDsh>> | undefined;
  try {
    process.env.DSH_HOME = home;
    process.env.DSH_AGENTS_HOME = join(home, "agents");
    // Redirect `os.homedir()` (== $HOME on POSIX) so homedir()-based gateway paths
    // — including clearStaleDshLock — cannot touch the real `~/.dsh` / `~/.rdsh`.
    process.env.HOME = dirname(home);
    // If the probe profile happens to carry this plugin, keep it unconfigured:
    // a contract probe must never join a host to a real hub.
    process.env.RDSH_CONFIG = join(home, "rdsh-probe-host.json");
    // dsh writes its profile on first boot; a missing probe home must not turn
    // that into an ENOENT that looks like an upstream break.
    await mkdir(join(home, "agents"), { recursive: true });
    // The remote path relies on a non-empty TTY signal; pin it so the probe does
    // not depend on the shell that started the test suite.
    process.env.SSH_TTY = RDSH_REMOTE_TTY;

    // 2) `dsh web --port 0 --no-open` reports a port and (0.1.2+) a token.
    dsh = await spawnDsh(bin);
    assert.ok(dsh.port > 0, "no listening port");
    assert.ok(dsh.authToken !== undefined, "ready line no longer carries a launch token");

    // 3) The launch token still mints a `dsh-auth-*` browser session cookie.
    const cookie = await exchangeDshSessionCookie(dsh.port, dsh.authToken);
    assert.ok(cookie !== null && cookie.startsWith("dsh-auth-"), "session cookie exchange failed");

    const origin = `http://127.0.0.1:${dsh.port}`;

    // 4) The SSH_TTY signal still resolves the in-page picker (browse).
    const pickerOk = await checkRemotePickerGraph(dsh.port, cookie);
    assert.equal(pickerOk, true, pickerOk === null
      ? "could not read the boot graph (index unreachable or unauthenticated)"
      : "boot graph no longer contains the browse directory picker");

    // 5) `/api` still reaches dsh's own dispatcher behind its fence.
    const api = await fetch(`${origin}/api/session/list`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie === null ? {} : { cookie }) },
      body: "{}",
    });
    assert.equal(api.status, 200, `POST /api/session/list answered ${api.status}`);
    assert.ok((await api.text()).includes("server-response"), "/api no longer answers a connection envelope");

    // 6) The loopback rewrite input still exists in a served client bundle.
    const html = await getText(`${origin}/`, cookie);
    const urls = new Set<string>();
    for (const match of html.matchAll(/(?:src|url)="([^"]+\.js[^"]*)"/g)) urls.add(match[1]!);
    for (const match of html.matchAll(/"url":"([^"]+)"/g)) urls.add(match[1]!);

    let found = false;
    for (const url of urls) {
      if (!sameOrigin(url, origin)) continue;
      const text = await tryGetText(url.startsWith("http") ? url : `${origin}${url.startsWith("/") ? "" : "/"}${url}`, cookie);
      if (text !== null && text.includes("isLoopbackHostname(pageLocation.hostname)")) {
        found = true;
        break;
      }
    }
    assert.ok(found, "no served bundle carries isLoopbackHostname(pageLocation.hostname); the runtime rewrite is dead");
  } finally {
    if (dsh !== undefined) await dsh.stop();
    for (const [key, value] of [
      ["DSH_HOME", saved.home],
      ["DSH_AGENTS_HOME", saved.agents],
      ["SSH_TTY", saved.tty],
      ["RDSH_CONFIG", saved.rdsh],
      ["HOME", saved.userHome],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
