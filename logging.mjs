import { promises as fs } from "node:fs";
import path from "node:path";

// One writer per path. No persistent descriptor: unlink/rename cannot leave
// subsequent records going into an invisible inode. Queueing keeps file I/O
// outside the route controller's serial monitoring path.
export function createRotatingLogger({
  filePath,
  maxBytes = 10 * 1024 * 1024,
  maxFiles = 5,
  maxQueueBytes = 1024 * 1024,
  writeWarning = line => process.stderr.write(line),
}) {
  if (!path.isAbsolute(filePath)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 256
    || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 20
    || !Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 256) {
    throw new Error("Invalid rotating log configuration");
  }
  let tail = Promise.resolve();
  let pendingBytes = 0;
  let dropped = 0;
  let lastWarningAt = -Infinity;

  function warn(code) {
    dropped += 1;
    const now = Date.now();
    if (now - lastWarningAt < 60_000) return;
    lastWarningAt = now;
    // Do not forward the record, file path or raw exception to a second log.
    try {
      writeWarning(`${JSON.stringify({
        time: new Date(now).toISOString(), level: "error", event: "log_write_failed",
        code: /^[A-Z0-9_]+$/.test(code || "") ? code : "LOG_IO_ERROR", dropped,
      })}\n`);
    } catch { /* Diagnostic failures must not affect routing. */ }
  }

  async function renameIfPresent(from, to) {
    try {
      await fs.rename(from, to);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function append(line, bytes) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile()) throw Object.assign(new Error("Not a regular log file"), { code: "LOG_NOT_REGULAR" });
      size = stat.size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (size > 0 && size + bytes > maxBytes) {
      const oldest = maxFiles === 1 ? filePath : `${filePath}.${maxFiles - 1}`;
      await fs.rm(oldest, { force: true });
      for (let index = maxFiles - 2; index >= 1; index -= 1) {
        await renameIfPresent(`${filePath}.${index}`, `${filePath}.${index + 1}`);
      }
      if (maxFiles > 1) await renameIfPresent(filePath, `${filePath}.1`);
    }
    await fs.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
  }

  return {
    write(line) {
      let bytes = Buffer.byteLength(line);
      if (bytes > Math.min(maxBytes, 64 * 1024)) {
        warn("LOG_RECORD_TOO_LARGE");
        line = `${JSON.stringify({ level: "warning", event: "log_record_omitted", bytes })}\n`;
        bytes = Buffer.byteLength(line);
      }
      if (pendingBytes + bytes > maxQueueBytes) {
        warn("LOG_QUEUE_FULL");
        return;
      }
      pendingBytes += bytes;
      tail = tail.then(() => append(line, bytes)).catch(error => warn(error.code)).finally(() => {
        pendingBytes -= bytes;
      });
    },
    async flush() { await tail; },
  };
}
