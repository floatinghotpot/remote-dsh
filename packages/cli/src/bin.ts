#!/usr/bin/env node
/**
 * rdsh CLI 入口（用户侧，手写参数解析，零依赖）。
 *
 *   rdsh setup lan|cloud
 *   rdsh join [hub-url] [--token <t>] [--name <n>] [--dsh <p>] [--insecure]
 *   rdsh serve | service install|status|start|stop|restart|uninstall | leave | user ... | gate ...
 *   rdsh --version | --help
 *
 * `rdsh host <cmd>` 仍可用（兼容别名，TTY 下提示一次）。hub 命令已迁到 `rdsh-hub`（feature 47）。
 */
import { createInterface } from "node:readline";
import { hostname } from "node:os";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  serve,
  join,
  registerJoin,
  findDsh,
  selfRevoke,
  readPersistedToken,
  persistToken,
  persistJoinMeta,
  detectInsecure,
  loadOrCreateE2eeKeyPair,
  hubRequest,
  clearPersistedToken,
  UserManager,
  resolveConfigPath,
  loadConfig,
  saveConfig,
  generateAccessCode,
  installService,
  uninstallService,
  serviceStatus,
  startService,
  stopService,
  restartService,
  HOST_SERVICE_NAME,
  JOIN_SERVICE_NAME,
} from "rdsh-gateway";
import qrcode from "qrcode-terminal";
import type { JoinOptions } from "rdsh-gateway";
import { VERSION } from "./index.js";

const HELP = `rdsh — secure remote access for DeepSeek Harness

Usage:
  rdsh setup lan|cloud        Configure this machine (LAN / cloud HTTPS gateway)
  rdsh join [hub-url]          Connect this machine to a hub (scan QR, or --token)
  rdsh serve                   Run the configured mode in the foreground
  rdsh service ...             Run as a systemd/launchd service
  rdsh leave                   Unregister this machine from the hub
  rdsh user ...                Manage gateway users (LAN/cloud password auth)
  rdsh gate ...                Set / clear the access code (LAN + tunnel gate)

  (rdsh host <cmd> 仍可用，作为兼容别名)

Global:
  --config <path>             Host config (default ~/.rdsh/host.json; also $RDSH_CONFIG)
  --version, -v               Print version
  --help, -h                  Print this help
`;

/** 子命令级用法（`rdsh <cmd> --help`）。 */
const SUB_HELP: Record<string, string> = {
  host: `Usage: rdsh <command>   (or the compatible alias: rdsh host <command>)

Configure and run this machine (the DSH host).

Commands:
  setup lan              Configure a LAN gateway (access-code auth, plain http)
  setup cloud            Configure a cloud HTTPS gateway (password + TLS + allowFrom)
  join <hub-url>         Connect to a hub (interactive token paste; --token for scripts)
  serve                  Run the configured mode in the foreground
  service install|status|start|stop|restart|uninstall   Run as a systemd/launchd service
  leave                  Unregister this machine from the hub
  user add|passwd|ls|rm  Manage gateway users
  gate set|clear|status  Set / clear the access code (LAN + tunnel gate)

Options (setup lan):   --port <n>
Options (setup cloud):  --tls-cert <path> --tls-key <path> [--port <n>] [--allow-from <cidr,...>]
Options (join):         --token <t> --name <n> --dsh <path> --insecure
`,
};

/** 参数里是否有 --help / -h。 */
function hasHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

interface CliOptions {
  configPath?: string;
  flags: string[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`rdsh ${VERSION}`);
    return;
  }

  // 全局解析：先剥 --config <path>（允许出现在任何位置），剩余为子命令参数
  const cli = parseGlobal(argv);
  let command = cli.flags[0];
  let rest = cli.flags.slice(1);
  // `host` 兼容别名：可省略；TTY 下提示一次、非 TTY（脚本/systemd）静默。
  if (command === "host") {
    if (process.stdout.isTTY) {
      console.error("rdsh: 'host' 可省略——`rdsh serve` / `rdsh join` 等直接可用（保留 `rdsh host` 仅为兼容）。");
    }
    command = cli.flags[1];
    rest = cli.flags.slice(2);
  }
  if (command === undefined) {
    console.log(SUB_HELP["host"] ?? HELP);
    return;
  }
  const known = ["setup", "join", "serve", "service", "leave", "user", "gate"];
  if (!known.includes(command)) {
    console.error(`rdsh: unknown command '${command}'. Run 'rdsh --help'.`);
    process.exitCode = 1;
    return;
  }
  try {
    await handleHost([command, ...rest], cli.configPath);
  } catch (err) {
    console.error(`rdsh: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/** 提取全局 --config <path>（或 $RDSH_CONFIG），返回剩余参数。 */
function parseGlobal(argv: string[]): CliOptions {
  const flags: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      i += 1;
      configPath = argv[i];
      if (configPath === undefined) throw new Error("missing value for --config");
    } else {
      flags.push(argv[i]!);
    }
  }
  return { configPath, flags };
}

function parsePort(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port '${v}'`);
  return n;
}

/** 服务 unit 的子进程 PATH：node 目录（nvm/自装）+ 系统路径，保证 spawn dsh 时 shebang 能解析 node。 */
function nodePathEnv(): string {
  return `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
}

async function handleHost(args: string[], configPath?: string): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || hasHelp(rest)) {
    console.log(SUB_HELP["host"] ?? HELP);
    return;
  }
  switch (sub) {
    case "setup":
      await handleHostSetup(rest, configPath);
      return;
    case "join":
      await handleHostJoin(rest, configPath);
      return;
    case "serve":
      await handleHostServe(rest, configPath);
      return;
    case "service":
      await handleHostService(rest, configPath);
      return;
    case "leave":
      await handleHostLeave(rest, configPath);
      return;
    case "user":
      await handleHostUser(rest, configPath);
      return;
    case "gate":
      await handleHostGate(rest, configPath);
      return;
    default:
      throw new Error("usage: rdsh host setup|join|serve|service|leave|user|gate");
  }
}

/** `rdsh host setup lan|cloud`：写 host.json（mode + 预设字段），配置完退出。 */
async function handleHostSetup(args: string[], configPath?: string): Promise<void> {
  const which = args[0];
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);

  if (which === "lan") {
    let port = config.port;
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--port") port = parsePort(args[++i]);
      else throw new Error(`unknown option '${flag}'`);
    }
    config.mode = "lan";
    config.port = port;
    config.tls = undefined;
    config.behindProxy = false;
    config.allowFrom = [];
    config.auth.mode = "none";
    // 统一固定口令：LAN 直连的门禁（取代旧动态配对码）
    const code = config.gateway?.accessCode ?? generateAccessCode();
    config.gateway = { accessCode: code };
    config.dshPath = config.dshPath ?? findDsh() ?? undefined;
    await saveConfig(target, config);
    console.log(`rdsh: host 配置为 LAN 网关（访问口令，端口 ${port}）→ ${target}`);
    console.log(`rdsh: 访问口令（请记录，可用 \`rdsh host gate set\` 修改）：${code}`);
    console.log("rdsh: 运行 `rdsh host serve` 前台启动，或 `rdsh host service install` 常驻。");
    return;
  }

  if (which === "cloud") {
    let port = config.port;
    let cert: string | undefined;
    let key: string | undefined;
    let allowFrom: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--port") port = parsePort(args[++i]);
      else if (flag === "--tls-cert") cert = args[++i];
      else if (flag === "--tls-key") key = args[++i];
      else if (flag === "--allow-from") allowFrom = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      else throw new Error(`unknown option '${flag}'`);
    }
    if (cert === undefined || key === undefined) {
      throw new Error("usage: rdsh host setup cloud --tls-cert <path> --tls-key <path> [--port <n>] [--allow-from <cidr,...>]");
    }
    config.mode = "cloud";
    config.port = port;
    config.tls = { cert, key };
    config.behindProxy = false;
    config.allowFrom = allowFrom;
    config.auth.mode = "password";
    config.dshPath = config.dshPath ?? findDsh() ?? undefined;
    await saveConfig(target, config);
    console.log(`rdsh: host 配置为云 HTTPS 网关（password，端口 ${port}）→ ${target}`);
    console.log("rdsh: 用 `rdsh host user add <name>` 建用户，再 `rdsh host serve` / `rdsh host service install`。");
    return;
  }

  throw new Error("usage: rdsh host setup lan|cloud");
}

/** 省略位置参数时使用的默认 hub。 */
const DEFAULT_HUB_URL = "https://hub.rdsh.cn";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 无 token 时的扫码接入：在 hub 建一次性绑定会话 → 终端打印二维码 →
 * 手机 App（已登录账号）扫码确认 → 领取 host token 并持久化。
 *
 * 二维码内容只有 `rdsh://bind?code=<id>`，不含任何密钥；会话 5 分钟过期、
 * 用后即弃，且必须由手机端已登录账号批准。
 * @returns true 已接入；false hub 不支持绑定会话（旧版本），调用方回退到粘贴 token。
 */
async function bindByQr(hubUrl: string, name: string, insecure: boolean): Promise<boolean> {
  const keys = loadOrCreateE2eeKeyPair();
  const created = await hubRequest(hubUrl, "/api/bind-sessions", {
    method: "POST",
    insecure,
    body: { name, e2eePublicKey: keys.publicRaw.toString("base64url") },
  });
  if (created.status === 404) return false;
  if (!created.ok) throw new Error(`bind session create failed: HTTP ${created.status}`);
  const session = created.body as { bindId?: string; consumeToken?: string; expiresAt?: number };
  if (typeof session.bindId !== "string" || typeof session.consumeToken !== "string" || typeof session.expiresAt !== "number") {
    throw new Error("hub returned malformed bind session");
  }
  const payload = `rdsh://bind?code=${session.bindId}`;
  console.log("");
  console.log(`  用鲸语通 App 扫码接入 ${hubUrl}`);
  console.log("  App → 地址列表 → 远程智能体 → 扫码添加");
  console.log("");
  qrcode.generate(payload, { small: true }, (qr) => console.log(qr));
  console.log(`  二维码 ${Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000))} 秒后过期；也可手输：${payload}`);
  console.log("");
  for (;;) {
    if (Date.now() >= session.expiresAt) throw new Error("二维码已过期，请重新运行 `rdsh host join`");
    await sleep(1500);
    const poll = await hubRequest(hubUrl, `/api/bind-sessions/${session.bindId}`, { method: "GET", insecure });
    if (!poll.ok) continue;
    const status = (poll.body as { status?: string }).status;
    if (status === "expired" || status === "consumed") throw new Error("二维码已过期或已被使用，请重新运行");
    if (status !== "approved") continue;
    const consumed = await hubRequest(hubUrl, `/api/bind-sessions/${session.bindId}/consume`, {
      method: "POST",
      insecure,
      body: { consumeToken: session.consumeToken },
    });
    if (!consumed.ok) throw new Error(`bind consume failed: HTTP ${consumed.status}`);
    const granted = consumed.body as { hostId?: string; hostToken?: string; hostCookiePubKey?: string };
    if (typeof granted.hostId !== "string" || typeof granted.hostToken !== "string") {
      throw new Error("hub returned malformed host credentials");
    }
    persistToken(hubUrl, granted.hostToken);
    persistJoinMeta(hubUrl, { hostId: granted.hostId, hostCookiePubKey: granted.hostCookiePubKey ?? "" });
    console.log(`rdsh: 已通过扫码接入 ${hubUrl}`);
    return true;
  }
}

/** `rdsh host join <hub>`：注册（join token）→ 写 host.json + session，配置完退出。 */
async function handleHostJoin(args: string[], configPath?: string): Promise<void> {
  // hub 可省略：省略时用 DEFAULT_HUB_URL；首个不以 '-' 开头的参数视为 hub。
  let hubUrl = DEFAULT_HUB_URL;
  let first = 0;
  const head = args[0];
  if (head !== undefined && !head.startsWith("-")) {
    if (!/^https?:\/\//.test(head)) throw new Error(`hub must be an http(s) URL, got '${head}'`);
    hubUrl = head;
    first = 1;
  }
  const opts: JoinOptions = { hubUrl };
  for (let i = first; i < args.length; i++) {
    const flag = args[i];
    const value = (name: string): string => {
      i += 1;
      if (i >= args.length) throw new Error(`missing value for ${name}`);
      return args[i] ?? "";
    };
    if (flag === "--token") opts.token = value(flag);
    else if (flag === "--name") opts.name = value(flag);
    else if (flag === "--dsh") opts.dshPath = value(flag);
    else if (flag === "--insecure") opts.insecure = true;
    else if (flag === "--reset") opts.reset = true;
    else throw new Error(`unknown option '${flag}'`);
  }
  if (opts.token === undefined && readPersistedToken(hubUrl) === null) {
    // 无 --token 且无持久化 session：TTY 下走扫码接入；非 TTY 报错不 hang。
    if (!process.stdin.isTTY) {
      throw new Error("无持久化 session 且未提供 --token；非交互环境请用 --token <t>");
    }
    const insecure = opts.insecure === true || (await detectInsecure(hubUrl));
    const bound = await bindByQr(hubUrl, opts.name?.trim() || hostname(), insecure);
    if (!bound) {
      // hub 不支持绑定会话（旧版本）→ 回退到粘贴 token
      const pasted = (await promptLine("Paste your join token (hub portal → Add host): ")).trim();
      if (pasted === "") throw new Error("需要 join token（hub portal → 添加主机 生成）");
      opts.token = pasted;
    }
  }

  const outcome = await registerJoin(opts);
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);
  config.mode = "join";
  config.hub = hubUrl;
  config.name = outcome.name;
  config.insecure = outcome.insecure;
  config.dshPath = opts.dshPath ?? findDsh() ?? config.dshPath;
  await saveConfig(target, config);
  console.log(`rdsh: host 已接入 ${hubUrl}（${config.name}）—— session 已保存`);
  console.log("rdsh: 运行 `rdsh host serve` 前台启动，或 `rdsh host service install` 常驻。");
}

/** `rdsh host serve`：前台常驻，读 host.json 按 mode 分发（join→隧道，lan/cloud→网关）。 */
async function handleHostServe(_args: string[], configPath?: string): Promise<void> {
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);
  if (config.mode === "join") {
    if (config.hub === undefined) throw new Error("host.json 缺 hub（join 模式）；先 `rdsh host join <hub>`");
    await join({ hubUrl: config.hub, name: config.name, insecure: config.insecure, dshPath: config.dshPath, dshUiCompat: config.dshUiCompat, gateway: config.gateway, direct: { host: config.host, port: config.port } });
    return;
  }
  await serve({ configPath: target });
}

/** `rdsh host service install|status|start|stop|restart|uninstall`：读 host.json mode 定位服务（unit 不含 token）。 */
async function handleHostService(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const target = resolveConfigPath(configPath);
  const actions = ["install", "status", "start", "stop", "restart", "uninstall"];
  if (action === undefined || !actions.includes(action)) {
    throw new Error(`usage: rdsh host service ${actions.join("|")}`);
  }
  if (action === "install") {
    await maybeRegisterForServiceInstall(args, target);
  }
  const config = await loadConfig(target);
  const name = config.mode === "join" ? JOIN_SERVICE_NAME : HOST_SERVICE_NAME;
  switch (action) {
    case "install":
      // host 服务会 spawn dsh（shebang `#!/usr/bin/env node`），nvm/自装 node 下需补 node 目录到 PATH（防 127）
      console.log(await installService({ name, args: ["serve"], configPath: target, pathEnv: nodePathEnv() }));
      console.log(`rdsh: host service installed (${name}) —— 开机自启 + 崩溃重启。`);
      return;
    case "status":
      console.log(`rdsh host service (${name}): ${await serviceStatus(name)}`);
      return;
    case "start":
      console.log(await startService(name));
      return;
    case "stop":
      console.log(await stopService(name));
      return;
    case "restart":
      console.log(await restartService(name));
      return;
    case "uninstall":
      console.log(await uninstallService(name));
      return;
  }
}

/** 一行接入：`host service install <hub-url> --token <t> [--name <n>]` → 注册 + 写 host.json（再装服务）。 */
async function maybeRegisterForServiceInstall(args: string[], target: string): Promise<void> {
  const maybeHub = args[1];
  if (maybeHub === undefined || !/^https?:\/\//.test(maybeHub)) return; // 无 <hub>，走读 host.json 路径
  const joinOpts: JoinOptions = { hubUrl: maybeHub };
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--token") joinOpts.token = args[++i];
    else if (flag === "--name") joinOpts.name = args[++i];
    else if (flag === "--dsh") joinOpts.dshPath = args[++i];
    else if (flag === "--insecure") joinOpts.insecure = true;
    else throw new Error(`unknown option '${flag}'`);
  }
  const outcome = await registerJoin(joinOpts);
  const cfg = await loadConfig(target);
  cfg.mode = "join";
  cfg.hub = maybeHub;
  cfg.name = outcome.name;
  cfg.insecure = outcome.insecure;
  cfg.dshPath = joinOpts.dshPath ?? findDsh() ?? cfg.dshPath;
  await saveConfig(target, cfg);
}

/** `rdsh host gate set|clear|status`：访问口令（gateway.accessCode）——隧道与直连两条通道共用的门禁。 */
async function handleHostGate(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);
  if (action === "set") {
    const code = await promptPassword("访问口令（≥4 位，留空取消）: ");
    if (code.trim() === "") return;
    if (code.length < 4) throw new Error("访问口令至少 4 位");
    config.gateway = { accessCode: code };
    await saveConfig(target, config);
    console.log("rdsh: 访问口令已设置（重启 host 生效；插件面板设置即时生效）。");
    return;
  }
  if (action === "clear") {
    config.gateway = { accessCode: null };
    await saveConfig(target, config);
    console.log("rdsh: 访问口令已清除——直连口仍会监听，但只认一次性直连票（无票一律 403，不再有口令挑战页）；隧道两条通道不再要求口令。");
    return;
  }
  if (action === "status") {
    const code = config.gateway?.accessCode ?? null;
    console.log(code === null ? "rdsh: 未设置访问口令（直连口仍监听，仅认一次性直连票；隧道无门禁）。" : "rdsh: 访问口令已设置（两条通道均需口令）。");
    return;
  }
  throw new Error("usage: rdsh host gate set|clear|status");
}

/** `rdsh host leave`：self-revoke + 清 session + 删 host.json → 未配置。 */
async function handleHostLeave(_args: string[], configPath?: string): Promise<void> {
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);
  if (config.mode !== "join" || config.hub === undefined) {
    throw new Error("当前不是 join 模式（或缺 hub），无需 leave");
  }
  const token = readPersistedToken(config.hub);
  if (token === null) {
    console.log("rdsh: 本地无 session 文件，仅清理配置");
  } else {
    await selfRevoke(config.hub, token, config.insecure === true);
    console.log("rdsh: 已在 hub 自吊销本机");
  }
  clearPersistedToken(config.hub);
  await rm(target, { force: true });
  console.log(`rdsh: host 已注销（清理 ${target}）—— 回到未配置状态`);
}

/** `rdsh host user add|passwd|ls|rm`：本机网关用户（写 host.json auth.users）。 */
async function handleHostUser(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const um = new UserManager(resolveConfigPath(configPath));
  switch (action) {
    case "add": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh host user add <name>");
      const password = await promptPassword(`password for ${name}: `);
      const again = await promptPassword("confirm: ");
      if (password !== again) throw new Error("passwords do not match");
      await um.add(name, password);
      console.log(`rdsh: user '${name}' added`);
      return;
    }
    case "passwd": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh host user passwd <name>");
      const password = await promptPassword(`new password for ${name}: `);
      const again = await promptPassword("confirm: ");
      if (password !== again) throw new Error("passwords do not match");
      const ok = await um.passwd(name, password);
      if (!ok) throw new Error(`user '${name}' not found`);
      console.log(`rdsh: password updated for '${name}' (all existing sessions revoked)`);
      return;
    }
    case "ls": {
      const users = await um.list();
      console.log(users.length > 0 ? users.join("\n") : "(no users)");
      return;
    }
    case "rm": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh host user rm <name>");
      const ok = await um.remove(name);
      if (!ok) throw new Error(`user '${name}' not found`);
      console.log(`rdsh: user '${name}' removed`);
      return;
    }
    default:
      throw new Error("usage: rdsh host user add|passwd|ls|rm");
  }
}

function promptPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    return new Promise<string>((resolve) => {
      let input = "";
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 13 || byte === 10) {
            stdin.removeListener("data", onData);
            if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
            process.stdout.write("\n");
            resolve(input);
            return;
          }
          if (byte === 127 || byte === 8) {
            input = input.slice(0, -1);
            continue;
          }
          input += String.fromCharCode(byte);
        }
      };
      stdin.on("data", onData);
    });
  }
  // 非 TTY（管道/重定向）：一次性读完 stdin（EOF），逐行消费。
  process.stdout.write(prompt);
  return nextPipeLine();
}

let pipeLines: string[] | null = null;

/** 读取一行（echo，用于粘贴 token 等非敏感输入）。 */
function promptLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function nextPipeLine(): Promise<string> {
  if (pipeLines !== null) {
    return Promise.resolve(pipeLines.shift() ?? "");
  }
  pipeLines = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return new Promise<string>((resolve) => {
    rl.on("line", (l) => pipeLines!.push(l));
    rl.on("close", () => resolve(pipeLines!.shift() ?? ""));
  });
}

// 管理命令（host setup/join/leave/service/user 完成后）显式退出：
// 常驻命令（host serve / hub serve）不 resolve，靠信号退出。
void main().then(() => process.exit(process.exitCode ?? 0));
