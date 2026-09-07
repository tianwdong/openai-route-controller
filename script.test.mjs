import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { nodeProbeProxyUrl } from "./lib.mjs";

async function loadMain() {
  const source = await readFile(new URL("./Script.openai.js", import.meta.url), "utf8");
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.__main = main;`, context);
  return context.__main;
}

test("global script keeps every matching node in one OpenAI selector", async () => {
  const main = await loadMain();
  const config = {
    proxies: [
      { name: "JP-1" },
      { name: "JP3-HY2" },
      { name: "US-1TCP" },
      { name: "HK-1" },
    ],
    "proxy-groups": [
      { name: "OpenAI 自动选择", type: "fallback", proxies: ["JP-1"] },
      { name: "主代理", type: "select", proxies: ["JP-1"] },
    ],
    rules: ["MATCH,主代理"],
  };

  const result = main(config, "test");
  const openAI = result["proxy-groups"].find((group) => group.name === "OpenAI 自动选择");

  assert.equal(openAI.type, "select");
  assert.deepEqual(Array.from(openAI.proxies), ["JP-1", "JP3-HY2", "US-1TCP"]);
  assert.equal("url" in openAI, false);
  assert.equal("interval" in openAI, false);
  assert.equal(result["proxy-groups"].filter((group) => group.name === "OpenAI 自动选择").length, 1);
  assert.equal(result.profile["store-selected"], true);
  assert.equal(result.rules.at(-1), "MATCH,主代理");
});

test("probe listeners bind each candidate directly on loopback and remain idempotent", async () => {
  const main = await loadMain();
  const config = {
    proxies: [{ name: "TW-2" }, { name: "JP-1" }],
    listeners: [{ name: "existing", type: "mixed", port: 10808 }],
    rules: ["MATCH,DIRECT"],
  };
  main(config);
  main(config);
  const probes = config.listeners.filter((listener) => listener.name.startsWith("openai-route-probe-"));
  assert.equal(probes.length, 2);
  assert.equal(config.listeners[0].name, "existing");
  for (const probe of probes) {
    assert.equal(probe.listen, "127.0.0.1");
    assert.equal(probe.udp, false);
    assert.equal(probe.users.length, 0);
    assert.equal(`http://${probe.listen}:${probe.port}`, nodeProbeProxyUrl(probe.proxy, ["TW-2", "JP-1"]));
  }
});

test("probe setup refuses to overwrite another configured listener port", async () => {
  const main = await loadMain();
  assert.throws(() => main({
    proxies: [{ name: "JP-1" }],
    listeners: [{ name: "another-service", port: 17900 }],
  }), /already configured/);
});
