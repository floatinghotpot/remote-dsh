/**
 * config.test.ts — hub 配置加载。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHubConfig, normalizeHubConfig, resolveHubConfigPath, DEFAULT_HUB_CONFIG_PATH } from "../src/index.ts";

test("默认值（无文件）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hubcfg-"));
  const cfg = await loadHubConfig(join(dir, "missing.json"));
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 8443);
  assert.equal(cfg.tls, undefined);
  assert.ok(cfg.dbPath.endsWith("hub.db"));
  assert.ok(cfg.jwtKeyPath.endsWith("hub-jwt.key"));
});

test("文件加载 + 覆盖默认", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hubcfg-"));
  const path = join(dir, "hub.json");
  await writeFile(path, JSON.stringify({ port: 9443, host: "127.0.0.1", tls: { cert: "/c.pem", key: "/k.pem" } }));
  const cfg = await loadHubConfig(path);
  assert.equal(cfg.port, 9443);
  assert.equal(cfg.host, "127.0.0.1");
  assert.deepEqual(cfg.tls, { cert: "/c.pem", key: "/k.pem" });
  assert.equal(cfg.dbPath.endsWith("hub.db"), true); // 未覆盖项用默认
});

test("路径优先级：--config > $RDSH_HUB_CONFIG > 默认", () => {
  assert.equal(resolveHubConfigPath("/x/hub.json", {}), "/x/hub.json");
  assert.equal(resolveHubConfigPath(undefined, { RDSH_HUB_CONFIG: "/y/hub.json" }), "/y/hub.json");
  assert.equal(resolveHubConfigPath(undefined, {}), DEFAULT_HUB_CONFIG_PATH);
});

test("非法字段明确报错", () => {
  assert.throws(() => normalizeHubConfig({ port: "abc" }), /invalid "port"/);
  assert.throws(() => normalizeHubConfig({ port: 70000 }), /invalid "port"/);
  assert.throws(() => normalizeHubConfig({ tls: { cert: "/c" } }), /"tls.cert" and "tls.key"/);
  assert.throws(() => normalizeHubConfig("nope"), /expected a JSON object/);
});

test("site.customerServiceUrl：字符串规范化 + 非法报错", () => {
  assert.equal(normalizeHubConfig({ site: { customerServiceUrl: "https://work.weixin.qq.com/kfid/x" } }).site?.customerServiceUrl, "https://work.weixin.qq.com/kfid/x");
  assert.equal(normalizeHubConfig({ site: {} }).site?.customerServiceUrl, undefined);
  assert.throws(() => normalizeHubConfig({ site: { customerServiceUrl: 123 } }), /"site.customerServiceUrl" must be a string/);
});

test("backup：dir/keepDays 规范化 + 非法报错", () => {
  assert.deepEqual(normalizeHubConfig({ backup: { dir: "/b", keepDays: 30 } }).backup, { dir: "/b", keepDays: 30 });
  assert.equal(normalizeHubConfig({}).backup, undefined);
  assert.throws(() => normalizeHubConfig({ backup: { keepDays: 0 } }), /positive integer/);
  assert.throws(() => normalizeHubConfig({ backup: { dir: "" } }), /non-empty string/);
});

test("behindProxy 字段（默认 false / 可配置 / 非法报错）", async () => {
  assert.equal(normalizeHubConfig({}).behindProxy, false);
  assert.equal(normalizeHubConfig({ behindProxy: true }).behindProxy, true);
  assert.equal(normalizeHubConfig({ behindProxy: false }).behindProxy, false);
  assert.throws(() => normalizeHubConfig({ behindProxy: "yes" }), /"behindProxy" must be boolean/);
});

test("email：log 可省略 from（占位）；smtp/aliyun 必填 from + 嵌套凭据", () => {
  const log = normalizeHubConfig({ email: { provider: "log" } }).email!;
  assert.equal(log.provider, "log");
  assert.equal(log.from, "noreply@localhost"); // 占位
  assert.throws(() => normalizeHubConfig({ email: { provider: "smtp" } }), /"email.from"/);
  assert.throws(() => normalizeHubConfig({ email: { provider: "aliyun" } }), /"email.from"/);
  // provider=smtp/aliyun 但缺嵌套凭据 → 启动即报错（不是运行时 500）
  assert.throws(() => normalizeHubConfig({ email: { provider: "smtp", from: "x@y.com" } }), /"email.smtp"/);
  assert.throws(() => normalizeHubConfig({ email: { provider: "aliyun", from: "x@y.com" } }), /"email.aliyun"/);
});

test("billing.payment.wechatpay：必填字段校验 + appSecret 可选", () => {
  const base = {
    mchid: "1900000001",
    appid: "wx123",
    certSerialNo: "SN1",
    privateKey: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
    apiV3Key: "0123456789abcdef0123456789abcdef",
    platformCert: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----",
    platformCertSerialNo: "PLATSN1",
    notifyUrl: "https://rdsh.cn/api/billing/callback",
  };
  assert.doesNotThrow(() => normalizeHubConfig({ billing: { payment: { provider: "wechatpay", wechatpay: base } } }));
  assert.doesNotThrow(() => normalizeHubConfig({ billing: { payment: { provider: "wechatpay", wechatpay: { ...base, appSecret: "s3" } } } }));
  assert.throws(() => normalizeHubConfig({ billing: { payment: { provider: "wechatpay" } } }), /"billing.payment.wechatpay" is required/);
  assert.throws(() => normalizeHubConfig({ billing: { payment: { provider: "wechatpay", wechatpay: { ...base, mchid: "" } } } }), /"billing.payment.wechatpay.mchid"/);
  assert.throws(() => normalizeHubConfig({ billing: { payment: { provider: "wechatpay", wechatpay: { ...base, apiV3Key: "" } } } }), /"billing.payment.wechatpay.apiV3Key"/);
  assert.throws(() => normalizeHubConfig({ billing: { payment: { provider: "wechatpay", wechatpay: { ...base, platformCert: "" } } } }), /"billing.payment.wechatpay.platformCert"/);
  assert.throws(() => normalizeHubConfig({ billing: { payment: { provider: "wechatpay", wechatpay: { ...base, appSecret: "" } } } }), /"billing.payment.wechatpay.appSecret"/);
});

test("e2ee：mode 枚举校验 + 缺省", () => {
  assert.doesNotThrow(() => normalizeHubConfig({ e2ee: { mode: "optional" } }));
  assert.doesNotThrow(() => normalizeHubConfig({ e2ee: { mode: "off" } }));
  assert.doesNotThrow(() => normalizeHubConfig({ e2ee: { mode: "required" } }));
  assert.throws(() => normalizeHubConfig({ e2ee: { mode: "weird" } }), /"e2ee.mode"/);
  assert.throws(() => normalizeHubConfig({ e2ee: "optional" }), /"e2ee" must be an object/);
  assert.equal(normalizeHubConfig({}).e2ee, undefined); // 缺省 → undefined（消费方按 optional）
  assert.equal(normalizeHubConfig({ e2ee: { mode: "required" } }).e2ee?.mode, "required");
});

test("注册限流：registrationDailyLimit / registrationMaxUsers 校验", () => {
  assert.equal(normalizeHubConfig({}).registrationMaxUsers, undefined); // 缺省不限
  assert.equal(normalizeHubConfig({ registrationMaxUsers: 1000 }).registrationMaxUsers, 1000);
  assert.equal(normalizeHubConfig({ registrationDailyLimit: 50 }).registrationDailyLimit, 50);
  assert.throws(() => normalizeHubConfig({ registrationMaxUsers: 0 }), /"registrationMaxUsers" must be a positive integer/);
  assert.throws(() => normalizeHubConfig({ registrationDailyLimit: -1 }), /"registrationDailyLimit" must be a positive integer/);
  assert.throws(() => normalizeHubConfig({ registrationMaxUsers: 1.5 }), /"registrationMaxUsers" must be a positive integer/);
});
