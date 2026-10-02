import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRotatingLogger } from "./logging.mjs";

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "route-log-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "controller.log");
  const warnings = [];
  const logger = createRotatingLogger({ filePath, writeWarning: line => warnings.push(JSON.parse(line)), ...options });
  const read = async suffix => fs.readFile(`${filePath}${suffix || ""}`, "utf8");
  return { directory, filePath, warnings, logger, read };
}

test("unlink and external rename recreate the active log on the next event", async t => {
  const f = await fixture(t);
  f.logger.write('first\n');
  await f.logger.flush();
  await fs.unlink(f.filePath);
  f.logger.write('after-unlink\n');
  await f.logger.flush();
  assert.equal(await f.read(), 'after-unlink\n');
  await fs.rename(f.filePath, `${f.filePath}.external`);
  f.logger.write('after-rename\n');
  await f.logger.flush();
  assert.equal(await f.read(), 'after-rename\n');
  assert.equal(await f.read('.external'), 'after-unlink\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.filePath)).mode & 0o777, 0o600);
  assert.deepEqual(f.warnings, []);
});

test("serial writes rotate in order with bounded file count and byte size", async t => {
  const f = await fixture(t, { maxBytes: 256, maxFiles: 3 });
  const lines = Array.from({ length: 12 }, (_, index) => `${JSON.stringify({ index, data: 'x'.repeat(70) })}\n`);
  for (const line of lines) f.logger.write(line);
  await f.logger.flush();
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['controller.log', 'controller.log.1', 'controller.log.2']);
  const retained = [];
  for (const suffix of ['.2', '.1', '']) {
    const contents = await f.read(suffix);
    assert.ok(Buffer.byteLength(contents) <= 256);
    retained.push(...contents.trim().split('\n').map(line => JSON.parse(line).index));
  }
  assert.deepEqual(retained, [6, 7, 8, 9, 10, 11]);
  assert.deepEqual(f.warnings, []);
});

test("I/O failures do not throw, leak record content or prevent later recovery", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.filePath);
  for (let index = 0; index < 3; index += 1) f.logger.write('private-node-and-token\n');
  await f.logger.flush();
  assert.equal(f.warnings.length, 1, 'warnings are rate limited');
  assert.equal(f.warnings[0].code, 'LOG_NOT_REGULAR');
  assert.equal(JSON.stringify(f.warnings).includes('private-node'), false);
  assert.equal(JSON.stringify(f.warnings).includes(f.directory), false);
  await fs.rmdir(f.filePath);
  f.logger.write('recovered\n');
  await f.logger.flush();
  assert.equal(await f.read(), 'recovered\n');
});

test("queue and individual records remain bounded under bursts", async t => {
  const f = await fixture(t, { maxBytes: 256, maxQueueBytes: 256 });
  f.logger.write(`${'sensitive'.repeat(100)}\n`);
  for (let index = 0; index < 100; index += 1) f.logger.write(`${'x'.repeat(80)}\n`);
  await f.logger.flush();
  const contents = await f.read();
  assert.ok(Buffer.byteLength(contents) <= 256);
  assert.equal(contents.includes('sensitive'), false);
  assert.ok(contents.includes('log_record_omitted'));
  assert.equal(f.warnings.length, 1);
});

test("invalid configuration is rejected before any file writes", () => {
  for (const options of [
    { filePath: 'relative.log' }, { maxFiles: 0 }, { maxBytes: 0 }, { maxQueueBytes: NaN },
  ]) {
    assert.throws(() => createRotatingLogger({ filePath: path.join(os.tmpdir(), 'unused.log'), ...options }), /Invalid rotating log/);
  }
});

test("single-file retention rotates without leaving backup files", async t => {
  const f = await fixture(t, { maxBytes: 256, maxFiles: 1 });
  for (const text of ['a', 'b', 'c']) f.logger.write(`${text.repeat(120)}\n`);
  await f.logger.flush();
  assert.deepEqual(await fs.readdir(f.directory), ['controller.log']);
  assert.equal(await f.read(), `${'c'.repeat(120)}\n`);
});

test("both installers include the logger and keep stdout separate from its file", async () => {
  for (const script of ['scripts/install-macos.sh', 'scripts/install-windows.ps1']) {
    assert.match(await fs.readFile(new URL(script, import.meta.url), 'utf8'), /logging\.mjs/);
  }
  for (const script of ['launchd/com.local.openai-route-controller.plist.template', 'scripts/start-controller.ps1']) {
    const text = await fs.readFile(new URL(script, import.meta.url), 'utf8');
    assert.match(text, /LOG_PATH/);
    assert.match(text, /controller\.bootstrap\.log/);
  }
});
