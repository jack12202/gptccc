import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStore } from "../src/store.js";

test("legacy provider settings migrate once to the unified primary default", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-provider-migration-"));
  const file = path.join(dir, "orders.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(file, JSON.stringify({
    orders: [],
    rechargeSessions: [],
    rechargeLogs: [],
    settings: {
      defaultProvider: "sange",
      providerUpdatedAt: "",
      providerUpdatedBy: ""
    }
  }));

  const store = new JsonStore(file);
  const settings = store.getSettings();
  assert.equal(settings.defaultProvider, "czgpt");
  assert.equal(settings.providerConfigVersion, 2);
  assert.equal(settings.providerUpdatedBy, "provider-config-v2");
});
