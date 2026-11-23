// Cross-process lock and private JSON files for the Grok Bot bridge queue.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STALE_MS = 15_000;

export function isOwnerOnly(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (typeof st.uid === "number" && process.getuid && st.uid !== process.getuid()) return false;
  return (st.mode & 0o077) === 0;
}

export function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

function clearStale(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return;
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
    return;
  }
  const alive = Boolean(info?.pid) && isPidAlive(info.pid);
  const age = Date.now() - (info.at || 0);
  if (alive && age <= STALE_MS) return;
  if (alive) return;
  try {
    if (fs.readFileSync(lockPath, "utf8") === raw) fs.unlinkSync(lockPath);
  } catch {}
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Serialize queue mutations across processes. The lock is not held across network calls. */
export async function withFileLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID();
  const started = Date.now();
  let fd;
  while (!fd) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      clearStale(lockPath);
      if (Date.now() - started > 5_000) throw new Error("队列锁超时");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, at: Date.now() }));
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (cur.nonce === nonce) fs.unlinkSync(lockPath);
    } catch {}
  }
}
