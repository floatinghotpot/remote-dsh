/**
 * config.test.ts — hub 配置加载。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

test("billing.wechatOauth：必填字段校验", () => {
  const base = { appid: "wx123", appSecret: "s3", baseUrl: "https://rdsh.cn" };
  assert.doesNotThrow(() => normalizeHubConfig({ billing: { wechatOauth: base } }));
  assert.throws(() => normalizeHubConfig({ billing: { wechatOauth: { ...base, appid: "" } } }), /"billing.wechatOauth.appid"/);
  assert.throws(() => normalizeHubConfig({ billing: { wechatOauth: { ...base, appSecret: "" } } }), /"billing.wechatOauth.appSecret"/);
  assert.throws(() => normalizeHubConfig({ billing: { wechatOauth: { ...base, baseUrl: "" } } }), /"billing.wechatOauth.baseUrl"/);
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

test("billing.plans[].vipTier：可选 / 正整数 / 档位唯一（客户端据此判定用户档位，见 API.md §13）", () => {
  const plan = { id: "plus_monthly", name: "标准版", hosts: 2, priceCny: 38, intervalMonths: 1 };
  // 缺省：不传 → 按声明顺序推导（单档 = 1；与 App `vip_tier ?? 1` 兜底同向）
  assert.equal(normalizeHubConfig({ billing: { plans: [plan] } }).billing?.plans[0]?.vipTier, 1);
  // 透传到客户端
  assert.equal(normalizeHubConfig({ billing: { plans: [{ ...plan, vipTier: 2 }] } }).billing?.plans[0]?.vipTier, 2);
  // 必须是正整数
  assert.throws(
    () => normalizeHubConfig({ billing: { plans: [{ ...plan, vipTier: 0 }] } }),
    /"billing\.plans\[\]\.vipTier" must be a positive integer/,
  );
  assert.throws(
    () => normalizeHubConfig({ billing: { plans: [{ ...plan, vipTier: 1.5 }] } }),
    /"billing\.plans\[\]\.vipTier" must be a positive integer/,
  );
  // 档位不可重复：重复会让客户端无法区分"我是哪一档"
  assert.throws(
    () => normalizeHubConfig({
      billing: { plans: [{ ...plan, vipTier: 1 }, { ...plan, id: "pro_monthly", vipTier: 1 }] },
    }),
    /"billing\.plans\[\]\.vipTier" must be unique/,
  );
});

test("billing.plans[].vipTier：多档缺省按声明顺序推导 1/2/3（兼容存量配置，F1 回归）", () => {
  const plan = { id: "plus_monthly", name: "标准版", hosts: 2, priceCny: 38, intervalMonths: 1 };
  // 线上存量形态：3 套餐、均未声明 vipTier → 按顺序推导 1/2/3
  const cfg = normalizeHubConfig({
    billing: { plans: [plan, { ...plan, id: "pro_monthly", hosts: 5 }, { ...plan, id: "ultra_monthly", hosts: 15 }] },
  });
  assert.deepEqual(cfg.billing?.plans.map((p) => p.vipTier), [1, 2, 3]);
  // 显式声明 → 原样保留
  assert.deepEqual(
    normalizeHubConfig({ billing: { plans: [{ ...plan, vipTier: 3 }, { ...plan, id: "pro_monthly", vipTier: 2 }] } }).billing?.plans.map((p) => p.vipTier),
    [3, 2],
  );
  // 显式重复 → 仍报错
  assert.throws(
    () => normalizeHubConfig({ billing: { plans: [{ ...plan, vipTier: 1 }, { ...plan, id: "pro_monthly", vipTier: 1 }] } }),
    /must be unique/,
  );
});

test("site.brand：对象规范化 + 非法报错", () => {
  assert.deepEqual(normalizeHubConfig({ site: { brand: { zh: "鲸语通", en: "WhaleLink" } } }).site?.brand, { zh: "鲸语通", en: "WhaleLink" });
  assert.deepEqual(normalizeHubConfig({ site: { brand: { zh: "鲸语通" } } }).site?.brand, { zh: "鲸语通", en: undefined });
  assert.deepEqual(normalizeHubConfig({ site: { brand: {} } }).site?.brand, { zh: undefined, en: undefined });
  assert.throws(() => normalizeHubConfig({ site: { brand: "鲸语通 - WhaleLink" } }), /"site.brand" must be an object/);
  assert.throws(() => normalizeHubConfig({ site: { brand: { zh: 123 } } }), /"site.brand.zh" must be a string/);
});

test("email.codeTemplates：规范化 + 部分配置 + 非法报错", () => {
  const tpl = {
    subject: { zh: "{brand} 验证码", en: "{brand} verification code" },
    text: { zh: "【{brand}】{code}", en: "[{brand}] {code}" },
  };
  const cfg = normalizeHubConfig({ email: { provider: "log", codeTemplates: { verify: tpl } } });
  assert.deepEqual(cfg.email?.codeTemplates, { verify: tpl });
  // 只配 verify → reset 不写入（渲染层用内置兜底）
  assert.equal(cfg.email?.codeTemplates?.reset, undefined);
  // 非法：subject 缺 en
  assert.throws(
    () => normalizeHubConfig({
      email: { provider: "log", codeTemplates: { verify: { subject: { zh: "x" }, text: { zh: "x", en: "y" } } } },
    }),
    /"email.codeTemplates.verify.subject" needs zh\/en strings/,
  );
});

test("billing.credits：点数档位校验（从代码移入配置）", () => {
  assert.doesNotThrow(() => normalizeHubConfig({ billing: { credits: [{ id: "credits_1_usd", package: { credits: 800 }, priceCny: 8, priceUsd: 0.99 }] } }));
  assert.throws(() => normalizeHubConfig({ billing: { credits: {} } }), /"billing.credits" must be an array/);
  assert.throws(() => normalizeHubConfig({ billing: { credits: [{ id: "", package: { credits: 800 }, priceCny: 8 }] } }), /"billing.credits\[\]\.id" must be a non-empty string/);
  assert.throws(() => normalizeHubConfig({ billing: { credits: [{ id: "a", package: { credits: 0 }, priceCny: 8 }] } }), /"billing.credits\[\]\.package\.credits" must be a positive integer/);
  assert.throws(() => normalizeHubConfig({ billing: { credits: [{ id: "a", package: { credits: 1.5 }, priceCny: 8 }] } }), /"billing.credits\[\]\.package\.credits" must be a positive integer/);
  assert.throws(() => normalizeHubConfig({ billing: { credits: [{ id: "a", package: { credits: 1 }, priceCny: -1 }] } }), /"billing.credits\[\]\.priceCny" must be a non-negative number/);
  assert.throws(() => normalizeHubConfig({ billing: { credits: [{ id: "a", package: { credits: 1 }, priceCny: 8, priceUsd: -1 }] } }), /"billing.credits\[\]\.priceUsd" must be a non-negative number/);
  assert.throws(() => normalizeHubConfig({ billing: { credits: [{ id: "a", package: { credits: 1 }, priceCny: 8 }, { id: "a", package: { credits: 2 }, priceCny: 9 }] } }), /"billing.credits\[\]\.id" must be unique/);
  assert.deepEqual(normalizeHubConfig({ billing: {} }).billing?.credits, []);
});

test("billing.productsFile：从商品清单文件读点数档位（App/商店/hub 单一真相）", async () => {
const dir = await mkdtemp(join(tmpdir(), "hubcfg-iap-"));
const file = join(dir, "iap_products.json");
await writeFile(file, JSON.stringify({
  version: 1,
  products: {
    consumable: [
      { id: "credits_1_usd", package: { credits: 800 }, priceCNY: 8, priceUSD: 0.99 },
      { id: "credits_5_usd", package: { credits: 5000 }, priceCNY: 38, priceUSD: 4.99 },
    ],
    subscription: [
      {
        id: "plus_monthly",
        type: "subscription",
        subscriptionGroup: "vip",
        l10nName: { "zh-CN": "标准版" },
        duration: { unit: "month", count: 1 },
        package: { hosts: 2, vip_tier: 1, credits: 3000 },
        priceCNY: 38,
        priceUSD: 4.99,
      },
    ],
  },
}));
const cfg = normalizeHubConfig({ billing: { productsFile: file } });
assert.deepEqual(cfg.billing?.credits, [
  { id: "credits_1_usd", credits: 800, priceCny: 8, priceUsd: 0.99 },
  { id: "credits_5_usd", credits: 5000, priceCny: 38, priceUsd: 4.99 },
]);
// 同一份文件的订阅段 → 套餐（两段一起读）
assert.deepEqual(cfg.billing?.plans.map((p) => p.id), ["plus_monthly"]);
assert.equal(cfg.billing?.productsFile, file);
});

test("billing.productsFile：文件优先于内联 credits", async () => {
const dir = await mkdtemp(join(tmpdir(), "hubcfg-iap2-"));
const file = join(dir, "iap_products.json");
await writeFile(file, JSON.stringify({
  products: {
    consumable: [{ id: "from_file", package: { credits: 1 }, priceCNY: 1 }],
    subscription: [],
  },
}));
const cfg = normalizeHubConfig({
  billing: { productsFile: file, credits: [{ id: "from_config", package: { credits: 9 }, priceCny: 9 }] },
});
assert.deepEqual(cfg.billing?.credits.map((c) => c.id), ["from_file"]);
});

test("billing.productsFile：订阅段生成套餐（与 App/商店同一份清单）", (t) => {
  const real = process.env.RDSH_IAP_PRODUCTS_FILE;
  if (real === undefined || !existsSync(real)) {
    t.skip("RDSH_IAP_PRODUCTS_FILE not set，跳过真实清单冒烟");
    return;
  }
  const cfg = normalizeHubConfig({ billing: { productsFile: real } });
  assert.equal(cfg.billing?.plans.length, 3);
  // 全部字段都由清单推导：name 取 l10nName["zh-CN"]，hosts/价格/vipTier/赠点各归其位。
  assert.deepEqual(cfg.billing?.plans[0], {
    id: "plus_monthly",
    name: "标准版",
    hosts: 2,
    priceCny: 38,
    priceUsd: 4.99,
    intervalMonths: 1,
    vipTier: 1,
    bonusCredits: 3000,
  });
  assert.deepEqual(cfg.billing?.plans.map((p) => p.vipTier), [1, 2, 3]);
  assert.deepEqual(cfg.billing?.plans.map((p) => p.bonusCredits), [3000, 8000, 20000]);
});

test("billing.productsFile：duration 年付映射 + name 回落英文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hubcfg-iap6-"));
  const file = join(dir, "cat.json");
  await writeFile(
    file,
    JSON.stringify({
      products: {
        consumable: [],
        subscription: [
          {
            id: "pro_yearly",
            type: "subscription",
            subscriptionGroup: "vip",
            l10nName: { en: "Pro" },                       // 无 zh-CN ⇒ 回落 en
            duration: { unit: "year", count: 1 },           // 年付 ⇒ 12 个月
            package: { hosts: 5, vip_tier: 2, credits: 0 },
            priceCNY: 168,
          },
        ],
      },
    }),
  );
  const cfg = normalizeHubConfig({ billing: { productsFile: file } });
  assert.equal(cfg.billing?.plans[0]?.name, "Pro");
  assert.equal(cfg.billing?.plans[0]?.intervalMonths, 12);
});

test("billing.productsFile：文件里的套餐优先于内联 plans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hubcfg-iap4-"));
  const file = join(dir, "cat.json");
  await writeFile(
    file,
    JSON.stringify({
      products: {
        consumable: [{ id: "credits_x", package: { credits: 1 }, priceCNY: 1 }],
        subscription: [
          {
            id: "from_file",
            type: "subscription",
            subscriptionGroup: "vip",
            l10nName: { "zh-CN": "文件套餐", en: "From file" },
            duration: { unit: "month", count: 1 },
            package: { hosts: 3, vip_tier: 1, credits: 100 },
            priceCNY: 10,
          },
        ],
      },
    }),
  );
  const cfg = normalizeHubConfig({
    billing: {
      productsFile: file,
      plans: [{ id: "inline", name: "Inline", hosts: 1, priceCny: 1, intervalMonths: 1 }],
    },
  });
  assert.deepEqual(cfg.billing?.plans.map((p) => p.id), ["from_file"]);
  assert.equal(cfg.billing?.plans[0]?.name, "文件套餐");
  assert.equal(cfg.billing?.plans[0]?.bonusCredits, 100);
  assert.equal(cfg.billing?.plans[0]?.hosts, 3);
});

test("billing.productsFile：订阅段坏字段 ⇒ 启动失败（不静默不猜）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hubcfg-iap5-"));
  const base = { package: { hosts: 1, vip_tier: 1 }, priceCNY: 1, duration: { unit: "month", count: 1 }, l10nName: { "zh-CN": "套餐" } };
  const cases: Array<[string, unknown, RegExp]> = [
    ["no-name", { ...base, l10nName: {} }, /l10nName" must carry/],
    ["bad-unit", { ...base, duration: { unit: "week", count: 1 } }, /duration.unit" must be month\|year/],
    ["no-hosts", { ...base, package: { vip_tier: 1 } }, /package.hosts" must be a positive integer/],
    ["zero-count", { ...base, duration: { unit: "month", count: 0 } }, /duration.count" must be a positive integer/],
  ];
  for (const [name, sub, re] of cases) {
    const f = join(dir, `${name}.json`);
    await writeFile(f, JSON.stringify({ products: { consumable: [], subscription: [{ id: "p_monthly", ...sub }] } }));
    assert.throws(() => normalizeHubConfig({ billing: { productsFile: f } }), re, name);
  }

  // 缺 subscription 段键（如笔误成 `subscriptions`）⇒ 启动失败，而不是静默"不卖订阅"
  const noSub = join(dir, "no-subscription.json");
  await writeFile(noSub, JSON.stringify({ products: { consumable: [{ id: "c1", package: { credits: 1 }, priceCNY: 1 }] } }));
  assert.throws(() => normalizeHubConfig({ billing: { productsFile: noSub } }), /has no "products.subscription"/);

  // 同一个 id 不能跨段重复（否则下单/入账无法区分是点数还是套餐）
  const dup = join(dir, "dup.json");
  await writeFile(
    dup,
    JSON.stringify({
      products: {
        consumable: [{ id: "p_monthly", package: { credits: 1 }, priceCNY: 1 }],
        subscription: [{ id: "p_monthly", ...base }],
      },
    }),
  );
  assert.throws(() => normalizeHubConfig({ billing: { productsFile: dup } }), /both products\.consumable and products\.subscription/);
});

test("billing.productsFile：坏路径 / 坏 JSON / 缺字段 ⇒ 启动失败（不静默不卖点数）", async () => {
assert.throws(
  () => normalizeHubConfig({ billing: { productsFile: "/tmp/definitely-missing-iap.json" } }),
  /cannot read "billing.productsFile"/,
);
assert.throws(
  () => normalizeHubConfig({ billing: { productsFile: 123 } }),
  /"billing.productsFile" must be a non-empty string/,
);

const dir = await mkdtemp(join(tmpdir(), "hubcfg-iap3-"));
const bad = join(dir, "bad.json");
await writeFile(bad, "{ not json");
assert.throws(() => normalizeHubConfig({ billing: { productsFile: bad } }), /is not valid JSON/);

const noCredits = join(dir, "nocredits.json");
await writeFile(noCredits, JSON.stringify({ products: { subscription: [] } }));
assert.throws(() => normalizeHubConfig({ billing: { productsFile: noCredits } }), /has no "products.consumable"/);
});

test("billing.productsFile：真实 assets/iap_products.json 可解析（6 档）", (t) => {
// 真实清单属于 App 仓库（私有）；设置 RDSH_IAP_PRODUCTS_FILE 指向它才跑这个冒烟。
const real = process.env.RDSH_IAP_PRODUCTS_FILE;
if (real === undefined || !existsSync(real)) {
  t.skip("RDSH_IAP_PRODUCTS_FILE not set，跳过真实清单冒烟");
  return;
}
const cfg = normalizeHubConfig({ billing: { productsFile: real } });
assert.equal(cfg.billing?.credits.length, 6);
assert.deepEqual(cfg.billing?.credits[0], { id: "credits_1_usd", credits: 800, priceCny: 8, priceUsd: 0.99 });
});
