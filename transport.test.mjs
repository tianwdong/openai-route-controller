import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import vm from "node:vm";

// Exercise the production helper without starting the controller or real probes.
const source = await readFile(new URL("./controller.mjs", import.meta.url), "utf8");
const start = source.indexOf("function mihomoRequest(");
const end = source.indexOf("\nasync function refreshGroup(", start);
assert.ok(start >= 0 && end > start, "Mihomo request helper must be present");

async function fixture(context, respond, onResponse = null) {
  const server = http.createServer(respond);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const activeTimers = new Set();
  const sandbox = vm.createContext({
    Buffer,
    setTimeout(callback, ms) {
      const timer = setTimeout(() => {
        activeTimers.delete(timer);
        callback();
      }, ms);
      activeTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      activeTimers.delete(timer);
      clearTimeout(timer);
    },
    createMihomoRequest(method, requestPath, encodedBody) {
      const request = http.request({
        host: "127.0.0.1",
        port: server.address().port,
        path: requestPath,
        method,
        agent: false,
        headers: encodedBody == null ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encodedBody),
        },
      });
      if (onResponse) request.once("response", onResponse);
      return request;
    },
  });
  vm.runInContext(source.slice(start, end), sandbox);
  return { request: sandbox.mihomoRequest, activeTimers };
}

test("Mihomo requests send JSON and parse a complete JSON response", async (context) => {
  let received = "";
  const { request, activeTimers } = await fixture(context, (incoming, response) => {
    assert.equal(incoming.method, "PUT");
    assert.equal(incoming.headers["content-type"], "application/json");
    incoming.on("data", (chunk) => { received += chunk; });
    incoming.on("end", () => response.end('{"ok":true}'));
  });
  const result = await request("PUT", "/proxies/test", { name: "JP-TEST" });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(received), { name: "JP-TEST" });
  assert.equal(activeTimers.size, 0);
});

test("Mihomo requests preserve non-JSON response text", async (context) => {
  const { request, activeTimers } = await fixture(context, (_, response) => response.end("ready"));
  assert.equal(await request("GET", "/version"), "ready");
  assert.equal(activeTimers.size, 0);
});

test("Mihomo 204 responses succeed through normal post-body close", async (context) => {
  let responseClosed;
  const closed = new Promise((resolve) => { responseClosed = resolve; });
  const { request, activeTimers } = await fixture(context,
    (_, response) => response.writeHead(204).end(),
    (response) => response.once("close", () => responseClosed(response.complete)),
  );
  assert.equal(await request("PUT", "/proxies/test", { name: "JP-TEST" }), null);
  assert.equal(await closed, true);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo non-2xx responses reject and release the deadline", async (context) => {
  const { request, activeTimers } = await fixture(context,
    (_, response) => response.writeHead(503).end("unavailable"),
  );
  await assert.rejects(request("GET", "/proxies"), /Mihomo 503: unavailable/);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo requests without a response hit the elapsed-time deadline", async (context) => {
  const { request, activeTimers } = await fixture(context, () => {});
  const startedAt = Date.now();
  await assert.rejects(request("GET", "/proxies", null, 80), /Mihomo request timed out/);
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo continuously arriving response bytes cannot extend the deadline", async (context) => {
  let sent = 0;
  let interval;
  context.after(() => clearInterval(interval));
  const { request, activeTimers } = await fixture(context, (_, response) => {
    response.writeHead(200);
    response.write(" ");
    interval = setInterval(() => {
      sent += 1;
      response.write(" ");
    }, 10);
    response.once("close", () => clearInterval(interval));
  });
  const startedAt = Date.now();
  await assert.rejects(request("GET", "/proxies", null, 120), /Mihomo request timed out/);
  assert.ok(sent >= 2, "response must keep producing data before the deadline");
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo truncated Content-Length responses reject before the deadline", async (context) => {
  let aborted = false;
  const { request, activeTimers } = await fixture(context, (_, response) => {
    response.writeHead(200, { "content-length": "100" });
    response.write('{"now":"JP-');
    setImmediate(() => response.socket.end());
  }, (response) => response.once("aborted", () => { aborted = true; }));
  const startedAt = Date.now();
  await assert.rejects(request("GET", "/proxies/test", null, 2000), /response closed before completion/);
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo request socket errors reject without waiting for the deadline", async (context) => {
  const { request, activeTimers } = await fixture(context, (incoming) => incoming.socket.destroy());
  await assert.rejects(request("GET", "/proxies", null, 2000), /socket hang up|ECONNRESET/);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo response errors settle once even when close follows", async (context) => {
  const { request, activeTimers } = await fixture(context, (_, response) => {
    response.writeHead(200);
    response.write("partial");
  }, (response) => {
    setImmediate(() => response.emit("error", new Error("injected response read failure")));
  });
  await assert.rejects(request("GET", "/proxies", null, 2000), /injected response read failure/);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo premature response close rejects even without an aborted event", async (context) => {
  const { request, activeTimers } = await fixture(context, (_, response) => {
    response.writeHead(200);
    response.write("partial");
  }, (response) => setImmediate(() => response.emit("close")));
  await assert.rejects(request("GET", "/proxies", null, 2000), /response closed before completion/);
  assert.equal(activeTimers.size, 0);
});

test("Mihomo requests honor an explicitly supplied delay-test timeout", async (context) => {
  let timer;
  context.after(() => clearTimeout(timer));
  const { request, activeTimers } = await fixture(context, (_, response) => {
    timer = setTimeout(() => response.end('{"delay":100}'), 100);
  });
  const result = await request("GET", "/proxies/test/delay", null, 1000);
  assert.equal(result.delay, 100);
  assert.equal(activeTimers.size, 0);
});
