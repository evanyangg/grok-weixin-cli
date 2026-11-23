// Weixin iLink bot HTTP API, ported from @tencent-weixin/openclaw-weixin (src/api/api.ts).

import crypto from "node:crypto";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Protocol version of the upstream channel this client mirrors; sent as iLink-App-ClientVersion. */
const CHANNEL_VERSION = "2.4.10";
const ILINK_APP_ID = "bot";
const BOT_AGENT = "GrokWeixin/0.1.0";

/** Server errcode meaning the bot token is stale / expired. */
export const STALE_TOKEN_ERRCODE = -14;

export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const TypingStatus = { TYPING: 1, CANCEL: 2 };

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const LIGHT_TIMEOUT_MS = 10_000;

function clientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

function commonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(clientVersion(CHANNEL_VERSION)),
  };
}

/** X-WECHAT-UIN: random uint32 -> decimal string -> base64. */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function postHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function buildUrl(baseUrl, endpoint) {
  return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function withTimeout(timeoutMs, external) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  if (external?.aborted) controller.abort();
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

export async function apiGet({ baseUrl, endpoint, timeoutMs, label }) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(buildUrl(baseUrl, endpoint), {
      method: "GET",
      headers: commonHeaders(),
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text}`);
    return text;
  } finally {
    t.done();
  }
}

export async function apiPost({ baseUrl, endpoint, body, token, timeoutMs, label, abortSignal }) {
  const t = withTimeout(timeoutMs, abortSignal);
  try {
    const res = await fetch(buildUrl(baseUrl, endpoint), {
      method: "POST",
      headers: postHeaders(token),
      body: JSON.stringify(body),
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text}`);
    return text;
  } finally {
    t.done();
  }
}

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/** JSON.parse that keeps uint64 message ids as strings instead of lossy numbers. */
export function parseJson(rawText) {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }
    const stringStart = index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;
    let key;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (!LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) output += rawText[cursor++];
    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor++;
    while (/\d/.test(rawText[cursor] ?? "")) cursor++;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output);
}

/** Long-poll for new messages. A client-side timeout is normal and yields an empty batch. */
export async function getUpdates({ baseUrl, token, getUpdatesBuf, timeoutMs, abortSignal }) {
  try {
    const raw = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf ?? "", base_info: baseInfo() },
      token,
      timeoutMs: timeoutMs ?? LONG_POLL_TIMEOUT_MS,
      label: "getUpdates",
      abortSignal,
    });
    return parseJson(raw);
  } catch (err) {
    if (err?.name === "AbortError") return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    throw err;
  }
}

export async function sendMessage({ baseUrl, token, msg }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: { msg, base_info: baseInfo() },
    token,
    timeoutMs: API_TIMEOUT_MS,
    label: "sendMessage",
  });
  const resp = parseJson(raw);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  return resp;
}

export async function sendText({ baseUrl, token, to, text, contextToken }) {
  return sendMessage({
    baseUrl,
    token,
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `grok-weixin:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      context_token: contextToken || undefined,
    },
  });
}

/** Returns the typing_ticket needed by sendTyping. */
export async function getConfig({ baseUrl, token, userId, contextToken }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() },
    token,
    timeoutMs: LIGHT_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(raw);
}

export async function sendTyping({ baseUrl, token, userId, typingTicket, status }) {
  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: baseInfo(),
    },
    token,
    timeoutMs: LIGHT_TIMEOUT_MS,
    label: "sendTyping",
  });
}

export async function notifyStart({ baseUrl, token }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: baseInfo() },
    token,
    timeoutMs: LIGHT_TIMEOUT_MS,
    label: "notifyStart",
  });
  return JSON.parse(raw);
}

export async function notifyStop({ baseUrl, token }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: { base_info: baseInfo() },
    token,
    timeoutMs: LIGHT_TIMEOUT_MS,
    label: "notifyStop",
  });
  return JSON.parse(raw);
}
