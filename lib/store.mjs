// Local state: ~/.grok-weixin (override with GROK_WEIXIN_STATE_DIR).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function stateDir() {
  return process.env.GROK_WEIXIN_STATE_DIR || path.join(os.homedir(), ".grok-weixin");
}

function filePath(name) {
  return path.join(stateDir(), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, data, { secret = false } = {}) {
  const p = filePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
  if (secret) {
    try {
      fs.chmodSync(p, 0o600);
    } catch {}
  }
}

function removeFile(name) {
  try {
    fs.rmSync(filePath(name), { recursive: true, force: true });
  } catch {}
}

// ── config ──────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  /** "cursor" = Grok through your Cursor account (@cursor/sdk); "xai" = xAI API key. */
  provider: "cursor",
  /** Model id used with provider "cursor" (see `grok-weixin models`). */
  cursorModel: "grok-4.7",
  /** Cursor API key; alternative to `grok-weixin cursor-login`. */
  cursorApiKey: "",
  apiKey: "",
  model: "grok-4",
  apiBaseUrl: "https://api.x.ai/v1",
  systemPrompt:
    "你是 Grok，一个通过微信与用户聊天的 AI 助手。回答简洁、直接，适合在手机上阅读；尽量少用复杂的 Markdown 格式。",
  /** Number of past user/assistant turns kept per conversation. */
  historyTurns: 20,
  /** WeChat user ids allowed to talk to the bot. Empty = only the account owner; ["*"] = anyone. */
  allowFrom: [],
};

/** Cursor key from the environment, in the same order the Agent SDK uses. */
export function cursorKeyFromEnv() {
  if (process.env.CURSOR_API_KEY?.trim()) {
    return { key: process.env.CURSOR_API_KEY.trim(), source: "CURSOR_API_KEY" };
  }
  if (process.env.CURSOR_API_KEY_FILE) {
    try {
      const key = fs.readFileSync(process.env.CURSOR_API_KEY_FILE, "utf-8").trim();
      if (key) return { key, source: "CURSOR_API_KEY_FILE" };
    } catch {}
  }
  if (process.env.CURSOR_SERVICE_ACCOUNT_KEY?.trim()) {
    return {
      key: process.env.CURSOR_SERVICE_ACCOUNT_KEY.trim(),
      source: "CURSOR_SERVICE_ACCOUNT_KEY",
    };
  }
  return null;
}

/** Keys and provider saved in config.json, ignoring environment overrides. */
export function loadSavedConfig() {
  return readJson("config.json", {});
}

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...readJson("config.json", {}) };
  if (process.env.XAI_API_KEY) cfg.apiKey = process.env.XAI_API_KEY;
  const cursorEnvKey = cursorKeyFromEnv();
  if (cursorEnvKey) cfg.cursorApiKey = cursorEnvKey.key;
  if (process.env.GROK_MODEL) cfg.model = process.env.GROK_MODEL;
  if (process.env.XAI_BASE_URL) cfg.apiBaseUrl = process.env.XAI_BASE_URL;
  if (process.env.GROK_WEIXIN_PROVIDER) cfg.provider = process.env.GROK_WEIXIN_PROVIDER;
  return cfg;
}

export function saveConfig(patch) {
  const current = readJson("config.json", {});
  writeJson("config.json", { ...current, ...patch }, { secret: true });
}

// ── Weixin account (bot token from QR login) ─────────────────────────────────

export function loadAccount() {
  const acc = readJson("account.json", null);
  return acc?.token && acc?.accountId ? acc : null;
}

export function saveAccount(account) {
  if (loadAccount()?.accountId !== account.accountId) resetSession();
  writeJson("account.json", { ...account, savedAt: new Date().toISOString() }, { secret: true });
}

export function clearAccount() {
  for (const name of [
    "account.json",
    "sync-buf.json",
    "context-tokens.json",
    "history",
    "cursor-agents.json",
    "pending-login.json",
    "login-qr.png",
  ]) {
    removeFile(name);
  }
}

/** Start a fresh message cursor and contact list, e.g. after logging into a new bot. */
export function resetSession() {
  for (const name of ["sync-buf.json", "context-tokens.json", "cursor-agents.json"]) {
    removeFile(name);
  }
}

// ── QR login in progress (MCP login spans several tool calls) ─────────────────

export function loadPendingLogin() {
  return readJson("pending-login.json", null);
}

export function savePendingLogin(login) {
  writeJson("pending-login.json", login, { secret: true });
}

export function clearPendingLogin() {
  removeFile("pending-login.json");
}

export function loginQrPngPath() {
  fs.mkdirSync(stateDir(), { recursive: true });
  return path.join(stateDir(), "login-qr.png");
}

// ── single getUpdates consumer per state dir ─────────────────────────────────

/** Live poller in this state dir, excluding this process. `mode` is "grok-bot" or "legacy". */
export function livePoller() {
  const data = readJson("poller.json", {});
  if (!data.pid || data.pid === process.pid) return null;
  try {
    process.kill(data.pid, 0);
  } catch {
    return null;
  }
  return { pid: data.pid, mode: data.mode || "legacy" };
}

/** Returns the pid of a live `grok-weixin start` process using this state dir, if any. */
export function activePollerPid() {
  return livePoller()?.pid ?? null;
}

export function markPoller(mode = "legacy") {
  writeJson("poller.json", { pid: process.pid, mode });
}

export function unmarkPoller() {
  if (readJson("poller.json", {}).pid === process.pid) removeFile("poller.json");
}

// ── getUpdates cursor ───────────────────────────────────────────────────────

export function loadSyncBuf() {
  return readJson("sync-buf.json", {}).buf ?? "";
}

export function saveSyncBuf(buf) {
  writeJson("sync-buf.json", { buf });
}

// ── context tokens (must be echoed on every reply) ───────────────────────────

export function loadContextTokens() {
  return readJson("context-tokens.json", {});
}

export function saveContextTokens(tokens) {
  writeJson("context-tokens.json", tokens);
}

// ── per-user chat history ───────────────────────────────────────────────────

function historyName(userId) {
  return path.join("history", `${userId.replace(/[^A-Za-z0-9_.@-]/g, "_")}.json`);
}

export function loadHistory(userId) {
  return readJson(historyName(userId), []);
}

export function saveHistory(userId, messages) {
  writeJson(historyName(userId), messages);
}

export function clearHistory(userId) {
  removeFile(historyName(userId));
}

// ── Cursor agent id per WeChat user ─────────────────────────────────────────

export function loadCursorAgentIds() {
  return readJson("cursor-agents.json", {});
}

export function saveCursorAgentIds(ids) {
  writeJson("cursor-agents.json", ids);
}

/** Empty working directory for Cursor local agents, so they never see your projects. */
export function cursorWorkspaceDir() {
  const dir = path.join(stateDir(), "cursor-workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
