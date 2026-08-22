import { test } from "node:test";
import assert from "node:assert/strict";
import { systemdUnit, launchdPlist } from "../src/service.ts";

test("systemd unit 模板", () => {
  const unit = systemdUnit("/usr/bin/node /usr/lib/rdsh/bin.js", "/home/u/.rdsh/config.json");
  assert.ok(unit.includes("[Unit]"));
  assert.ok(unit.includes("ExecStart=/usr/bin/node /usr/lib/rdsh/bin.js serve --config /home/u/.rdsh/config.json"));
  assert.ok(unit.includes("Restart=on-failure"));
  assert.ok(unit.includes("WantedBy=default.target"));
});

test("launchd plist 模板", () => {
  const plist = launchdPlist("/usr/local/bin/node /usr/local/bin/rdsh", "/Users/u/.rdsh/config.json");
  assert.ok(plist.includes("com.rdsh"));
  assert.ok(plist.includes("KeepAlive"));
  assert.ok(plist.includes("<string>/usr/local/bin/node /usr/local/bin/rdsh</string>"));
  assert.ok(plist.includes("<string>serve</string>"));
  assert.ok(plist.includes("/Users/u/.rdsh/config.json"));
});
