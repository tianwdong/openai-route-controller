import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const controllerPath = fileURLToPath(new URL("./controller.mjs", import.meta.url));

function runController(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [controllerPath, "--once", "--shadow"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  "loopback HTTP API transport authenticates and completes a shadow probe",
  { skip: process.platform === "win32" && "fake curl executable uses a Unix shebang" },
  async (context) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "openai-route-controller-test-"));
    context.after(() => rm(temporary, { recursive: true, force: true }));

    const fakeCurl = path.join(temporary, "fake-curl");
    await writeFile(
      fakeCurl,
      [
        "#!/usr/bin/env node",
        "const target = process.argv.at(-1) || '';",
        "process.stdout.write(target.includes('/codex/settings/usage')",
        "  ? '403\\t4000\\t0.010'",
        "  : '405\\t0\\t0.010');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCurl, 0o700);

    const groupName = "OpenAI Test Selector";
    const nodeName = "JP-TEST";
    const secret = "integration-test-secret";
    let authenticatedRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${secret}`) {
        response.writeHead(401).end("unauthorized");
        return;
      }
      authenticatedRequests += 1;
      const requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      response.setHeader("content-type", "application/json");
      if (requestPath === `/proxies/${groupName}`) {
        response.end(JSON.stringify({
          type: "Selector",
          now: nodeName,
          all: [nodeName],
        }));
        return;
      }
      if (requestPath === `/proxies/${nodeName}`) {
        response.end(JSON.stringify({ alive: true }));
        return;
      }
      if (requestPath === "/connections") {
        response.end(JSON.stringify({ connections: [] }));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();

    const result = await runController({
      ...process.env,
      MIHOMO_API: `http://127.0.0.1:${address.port}`,
      MIHOMO_SECRET: secret,
      MIHOMO_SOCKET: "",
      MIHOMO_PROXY: "http://127.0.0.1:1",
      OPENAI_GROUP: groupName,
      STATE_PATH: path.join(temporary, "state.json"),
      CURL_PATH: fakeCurl,
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.find((event) => event.event === "controller_started")?.type, "Selector");
    assert.equal(events.find((event) => event.event === "current_probe")?.ok, true);
    assert.ok(authenticatedRequests >= 3);
  },
);

test("HTTP API transport refuses a non-loopback controller", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openai-route-controller-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));

  const result = await runController({
    ...process.env,
    MIHOMO_API: "http://192.0.2.1:9097",
    MIHOMO_SOCKET: "",
    STATE_PATH: path.join(temporary, "state.json"),
  });

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.match(
    events.find((event) => event.event === "controller_failed")?.error || "",
    /Refusing non-loopback MIHOMO_API host/,
  );
});
