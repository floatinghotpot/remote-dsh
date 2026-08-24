import { test } from "node:test";
import assert from "node:assert/strict";
import { systemdUnit, launchdPlist, SERVICE_NAME, JOIN_SERVICE_NAME } from "../src/service.ts";

test("systemd unit 模板（serve + --config）", () => {
  const unit = systemdUnit("/usr/bin/node /usr/lib/rdsh/bin.js", {
    name: SERVICE_NAME,
    args: ["serve"],
    configPath: "/home/u/.rdsh/config.json",
  });
  assert.ok(unit.includes("[Unit]"));
  assert.ok(unit.includes("ExecStart=/usr/bin/node /usr/lib/rdsh/bin.js serve --config /home/u/.rdsh/config.json"));
  assert.ok(unit.includes("Restart=on-failure"));
  assert.ok(unit.includes("WantedBy=default.target"));
});

test("launchd plist 模板（serve + --config）", () => {
  const plist = launchdPlist("/usr/local/bin/node /usr/local/bin/rdsh", {
    name: SERVICE_NAME,
    args: ["serve"],
    configPath: "/Users/u/.rdsh/config.json",
  });
  assert.ok(plist.includes("com.rdsh"));
  assert.ok(plist.includes("KeepAlive"));
  assert.ok(plist.includes("<string>/usr/local/bin/node /usr/local/bin/rdsh</string>"));
  assert.ok(plist.includes("<string>serve</string>"));
  assert.ok(plist.includes("/Users/u/.rdsh/config.json"));
});

test("join 服务 unit：join+hubUrl+--dsh、无 --config、含 EnvironmentFile、Restart=on-failure", () => {
  const unit = systemdUnit("/usr/bin/node /usr/lib/rdsh/bin.js", {
    name: JOIN_SERVICE_NAME,
    args: ["join", "https://hub.example.com", "--dsh", "/opt/dsh/bin/dsh", "--insecure"],
    envFile: "/home/u/.rdsh/join.env",
  });
  assert.ok(unit.includes("ExecStart=/usr/bin/node /usr/lib/rdsh/bin.js join https://hub.example.com --dsh /opt/dsh/bin/dsh --insecure"));
  assert.ok(!unit.includes("--config"), "join 无 config，不应追加 --config");
  assert.ok(unit.includes("EnvironmentFile=-/home/u/.rdsh/join.env"));
  assert.ok(unit.includes("Restart=on-failure"));
});

test("host 服务 unit 含 Environment=PATH（nvm 防 dsh shebang 127）", () => {
  const unit = systemdUnit("/usr/bin/node /usr/lib/rdsh/bin.js", {
    name: JOIN_SERVICE_NAME,
    args: ["host", "serve"],
    configPath: "/home/u/.rdsh/host.json",
    pathEnv: "/home/u/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/bin",
  });
  assert.ok(unit.includes("Environment=PATH=/home/u/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/bin"));
  assert.ok(unit.includes("ExecStart=/usr/bin/node /usr/lib/rdsh/bin.js host serve --config /home/u/.rdsh/host.json"));
});

test("join 服务 launchd plist：Label com.rdsh-join、含 join args、无 --config", () => {
  const plist = launchdPlist("/usr/local/bin/node /usr/local/bin/rdsh", {
    name: JOIN_SERVICE_NAME,
    args: ["join", "https://hub.example.com", "--dsh", "/opt/dsh/bin/dsh"],
  });
  assert.ok(plist.includes("com.rdsh-join"));
  assert.ok(plist.includes("<string>join</string>"));
  assert.ok(plist.includes("<string>https://hub.example.com</string>"));
  assert.ok(plist.includes("<string>/opt/dsh/bin/dsh</string>"));
  assert.ok(!plist.includes("--config"));
});
