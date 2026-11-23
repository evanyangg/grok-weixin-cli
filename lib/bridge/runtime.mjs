// Long-poll WeChat, persist the queue, wake the current Grok Bot, and send claimed replies.
// This process does not call Cursor or xAI.

import fs from "node:fs";
import path from "node:path";

import { STALE_TOKEN_ERRCODE, getUpdates, notifyStart, notifyStop, sendText } from "../ilink.mjs";
import { atomicWriteJson } from "./lock.mjs";
import { assertBridgeStart, classifyInbound, classifySendError, ownerAutoAllowed, summarizeForQueue } from "./policy.mjs";
import {
  claimSendSlots,
  commitCursor,
  finishSend,
  ingestPrepared,
  readCursor,
  readGrant,
} from "./queue.mjs";
import { flushWake } from "./wake.mjs";

const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;

function log(message) {
  const stamp = new Date().toLocaleTimeString();
  console.log(`\x1b[90m${stamp}\x1b[0m ${message}`);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function pollerPath(dir) {
  return path.join(dir, "poller.json");
}

function readPoller(dir) {
  try {
    return JSON.parse(fs.readFileSync(pollerPath(dir), "utf8"));
  } catch {
    return {};
  }
}

function otherPoller(dir) {
  const data = readPoller(dir);
  if (!data.pid || data.pid === process.pid) return null;
  try {
    process.kill(data.pid, 0);
  } catch {
    return null;
  }
  return data;
}

function markPoller(dir) {
  atomicWriteJson(pollerPath(dir), { pid: process.pid, mode: "grok-bot" });
}

function unmarkPoller(dir) {
  const data = readPoller(dir);
  if (data.pid === process.pid) {
    try {
      fs.rmSync(pollerPath(dir), { force: true });
    } catch {}
  }
}

export async function acceptBatch({ dir, account, config, resp, now = Date.now() }) {
  if (config.allowFrom?.includes("*")) {
    const err = new Error("grok-bot 桥接拒绝 allowFrom=*");
    err.code = "allow_all_rejected";
    throw err;
  }
  const ret = resp?.ret ?? 0;
  const errcode = resp?.errcode ?? 0;
  if (ret !== 0 || errcode !== 0) {
    if (ret === STALE_TOKEN_ERRCODE || errcode === STALE_TOKEN_ERRCODE) {
      const err = new Error("微信登录已失效，请重新运行: grok-weixin login");
      err.code = "STALE_LOGIN";
      throw err;
    }
    throw new Error(`getUpdates ret=${ret} errcode=${errcode}`);
  }

  const prepared = [];
  const rejections = {};
  for (const msg of resp.msgs ?? []) {
    const decision = classifyInbound(msg, { account, config });
    if (decision.action === "enqueue") {
      const summary = summarizeForQueue(msg);
      prepared.push({
        record: {
          dedupeKey: decision.dedupeKey,
          accountRef: "bot",
          peerRole: decision.peerRole,
          conversationKind: decision.conversationKind,
          direction: "inbound",
          text: summary.text,
          hasMedia: summary.hasMedia,
          textTruncated: summary.textTruncated,
          contextTokenPresent: typeof msg.context_token === "string" && msg.context_token.length > 0,
        },
        secret: {
          contextToken: typeof msg.context_token === "string" ? msg.context_token : "",
          peerUserId: msg.from_user_id,
          messageId: msg.message_id,
        },
      });
    } else if (decision.action === "reject" || decision.action === "drop") {
      rejections[decision.reason] = (rejections[decision.reason] || 0) + 1;
    }
  }

  const result = await ingestPrepared(dir, prepared, rejections, now);
  if (resp.get_updates_buf) commitCursor(dir, resp.get_updates_buf);
  return result;
}

export async function deliverAccepted({ dir, account, fetchImpl, now = Date.now() }) {
  const grant = readGrant(dir);
  const slots = await claimSendSlots(dir, grant, now);
  const outcomes = [];
  for (const slot of slots) {
    let outcome;
    try {
      await sendText({
        baseUrl: account.baseUrl,
        token: account.token,
        to: slot.peerUserId,
        text: slot.text,
        contextToken: slot.contextToken,
        clientId: slot.clientId,
        fetchImpl,
      });
      outcome = { status: "sent", failure: "" };
    } catch (err) {
      const status = classifySendError(err);
      outcome = { status, failure: status === "failed" ? "wechat_rejected" : "uncertain" };
    }
    const saved = await finishSend(dir, slot.outboundId, outcome, now);
    outcomes.push(saved);
  }
  return outcomes;
}

async function oneCycle({ dir, account, config, env, fetchImpl, signal, now }) {
  const resp = await getUpdates({
    baseUrl: account.baseUrl,
    token: account.token,
    getUpdatesBuf: readCursor(dir),
    abortSignal: signal,
    fetchImpl,
  });
  const ingested = await acceptBatch({ dir, account, config, resp, now: now() });
  if (ingested.created.length) log(`inbound +${ingested.created.length} pending=${ingested.created.length}`);
  const sent = await deliverAccepted({ dir, account, fetchImpl, now: now() });
  for (const item of sent) log(`outbound ${item.status} id=${item.queueId}`);
  const wake = await flushWake({ dir, env, fetchImpl, now: now() });
  if (wake.posted || (wake.reason && wake.reason !== "idle" && wake.reason !== "unconfigured")) {
    log(`wake ${wake.reason}`);
  }
  return { ingested, sent, wake };
}

export async function runBridge({
  dir,
  account,
  config,
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
  pollOnce = false,
  manageSignals = false,
  now = () => Date.now(),
}) {
  assertBridgeStart(config);
  const grant = readGrant(dir);
  if (!grant.botBinding) {
    throw new Error("尚未运行 bridge-init。说明文档里的历史许可不会自动生效，桥接也不会自动发送。");
  }
  if (grant.permissionBlocked) {
    throw new Error("桥接授权文件权限过宽，已拒绝启动。请把状态文件收紧为仅所有者可读写。");
  }
  const other = otherPoller(dir);
  if (other) {
    throw new Error(`已有另一个接收进程 (pid ${other.pid}) 使用这个状态目录。请先停止它，避免两个消费者争用微信游标。`);
  }
  markPoller(dir);
  const abort = signal ? null : new AbortController();
  const stopSignal = signal ?? abort.signal;
  const shutdown = async () => {
    if (stopSignal.aborted) return;
    abort?.abort();
  };
  if (manageSignals) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  try {
    try {
      await notifyStart({ baseUrl: account.baseUrl, token: account.token, fetchImpl });
    } catch {
      log("notifyStart 失败（忽略）");
    }
    log("已连接微信。后端=Grok Bot bridge。本进程不调用模型；自动发送默认关闭。");
    if (!ownerAutoAllowed(grant)) log("主人自动发送未授权。提交回复会被拒绝，直到在本机执行 bridge-authorize。");
    let failures = 0;
    while (!stopSignal.aborted) {
      try {
        await oneCycle({ dir, account, config, env, fetchImpl, signal: stopSignal, now });
        failures = 0;
        if (pollOnce || stopSignal.aborted) break;
      } catch (err) {
        if (stopSignal.aborted) break;
        if (err.code === "STALE_LOGIN" || err.code === "allow_all_rejected") throw err;
        failures += 1;
        log(`getUpdates 失败 (${failures})`);
        if (pollOnce) throw err;
        await sleep(failures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, stopSignal);
        if (failures >= 3) failures = 0;
      }
    }
  } finally {
    try {
      await notifyStop({ baseUrl: account.baseUrl, token: account.token, fetchImpl });
    } catch {}
    unmarkPoller(dir);
    if (manageSignals) {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
  }
}
