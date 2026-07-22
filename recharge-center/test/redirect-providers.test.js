import assert from "node:assert/strict";
import test from "node:test";
import { getProviderAdapter, listProviders } from "../src/providers/index.js";

test("external backup providers are available as redirect routes", async () => {
  const providers = listProviders();
  assert.deepEqual(
    providers.filter(provider => provider.mode === "redirect"),
    [
      { key: "dnscon", label: "白", mode: "redirect" },
      { key: "9977ai", label: "七七", mode: "redirect" }
    ]
  );

  const white = getProviderAdapter("dnscon");
  const result = await white.verifyCard({ cardInfo: "TEST" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.data.redirectUrl, "https://dnscon.xyz/");
});
