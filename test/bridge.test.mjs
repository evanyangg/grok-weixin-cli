import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { legacyBridgeConflict } from "../lib/mcp.mjs";
import { classifyInbound, classifySendError, ownerAutoAllowed } from "../lib/bridge/policy.mjs";
import {
  LEASE_MS,
  QUEUE_FILE,
  SECRETS_FILE,
  authorizeConfirm,
  authorizeOwnerAuto,
  claimInbound,
  claimSendSlots,
  initBridge,
  loadQueueForTest,
  readGrant,
  readMcpToken,
  resolveOutbound,
} from "../lib/bridge/queue.mjs";
import { acceptBatch, deliverAccepted, runBridge } from "../lib/bridge/runtime.mjs";
import { BRIDGE_TOOLS, callBridgeTool, createBridgeMcpServer } from "../lib/bridge/tools.mjs";
import { buildWakeBody, flushWake } from "../lib/bridge/wake.mjs";

const OWNER = "owner-user";
const OTHER = "other-user";
const CONTEXT = "ctx-token-value";
const BINDING = "weixin-assistant";
const savedEnv = {
  GROK_WEIXIN_STATE_DIR: process.env.GROK_WEIXIN_STATE_DIR,
  GROK_WEIXIN_PROVIDER: process.env.GROK_WEIXIN_PROVIDER,
};

afterEach(() => {
  if (savedEnv.GROK_WEIXIN_STATE_DIR === undefined) delete process.env.GROK_WEIXIN_STATE_DIR;
  else process.env.GROK_WEIXIN_STATE_DIR = savedEnv.GROK_WEIXIN_STATE_DIR;
  if (savedEnv.GROK_WEIXIN_PROVIDER === undefined) delete process.env.GROK_WEIXIN_PROVIDER;
  else process.env.GROK_WEIXIN_PROVIDER = savedEnv.GROK_WEIXIN_PROVIDER;
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gw-bridge-"));
}

function account() {
  return { token: "bot-token", accountId: "bot-account", userId: OWNER, baseUrl: "https://ilink.test" };
}

function config(extra = {}) {
  return { provider: "grok-bot", allowFrom: [], ...extra };
}

function message({ id = "m1", from = OWNER, text = "hello", groupId, context = CONTEXT, type = 1 } = {}) {
  return {
    message_id: id,
    from_user_id: from,
    to_user_id: "bot-account",
    message_type: type,
    ...(groupId === undefined ? {} : { group_id: groupId }),
    ...(context === undefined ? {} : { context_token: context }),
    item_list: text === undefined ? [] : [{ type: 1, text_item: { text } }],
  };
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function setup(dir = tempDir()) {
  initBridge(dir, BINDING);
  return { dir, token: readMcpToken(dir), account: account() };
}

function auth(token, extra = {}) {
  return { auth_token: token, bot_binding: BINDING, ...extra };
}

function queueText(dir) {
  return fs.readFileSync(path.join(dir, QUEUE_FILE), "utf8");
}

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const entry = {
      url: String(url),
      method: opts.method,
      redirect: opts.redirect,
      headers: opts.headers,
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    calls.push(entry);
    const result = await handler(entry, calls);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, text: async () => result.body ?? "" };
  };
  return { fn, calls };
}

describe("classification", () => {
  test("owner is unverified, other is dropped, group_id is rejected, missing id is not hashed", () => {
    const cfg = config();
    const acc = account();
    assert.equal(classifyInbound(message(), { account: acc, config: cfg }).conversationKind, "unverified");
    assert.equal(classifyInbound(message(), { account: acc, config: cfg }).peerRole, "owner");
    assert.equal(classifyInbound(message({ from: OTHER }), { account: acc, config: cfg }).action, "drop");
    assert.equal(classifyInbound(message({ groupId: "room-1" }), { account: acc, config: cfg }).reason, "group");
    assert.equal(classifyInbound(message({ id: "" }), { account: acc, config: cfg }).reason, "missing_message_id");
    assert.equal(classifyInbound({ ...message(), message_id: 123 }, { account: acc, config: cfg }).reason, "missing_message_id");
    assert.equal(classifyInbound(message({ type: 2 }), { account: acc, config: cfg }).action, "ignore");
    assert.equal(classifyInbound(message(), { account: acc, config: config({ allowFrom: ["*"] }) }).reason, "allow_all");
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    assert.equal(classifySendError(aborted), "unknown");
    assert.equal(classifySendError(new Error("sendMessage 500: upstream")), "unknown");
    assert.equal(classifySendError(new Error("sendMessage ret=14 errmsg=context expired")), "failed");
  });
});

describe("queue", () => {
  test("persists owner messages, drops others, rejects groups, and keeps secrets out of the queue file", async () => {
    const { dir, account: acc } = setup();
    const resp = {
      ret: 0,
      get_updates_buf: "cursor-2",
      msgs: [
        message({ text: "hello from owner" }),
        message({ id: "m1", text: "duplicate" }),
        message({ id: "m2", from: OTHER, text: "other person" }),
        message({ id: "m3", groupId: "room", text: "group text" }),
        message({ id: "m4", context: "" }),
      ],
    };
    const result = await acceptBatch({ dir, account: acc, config: config(), resp, now: 10 });
    assert.equal(result.created.length, 2);
    assert.equal(result.existing.length, 1);
    assert.equal(result.created[0].peerRole, "owner");
    assert.equal(result.created[0].conversationKind, "unverified");
    assert.equal(fs.readFileSync(path.join(dir, "sync-buf.json"), "utf8").includes("cursor-2"), true);
    const raw = queueText(dir);
    assert.equal(raw.includes(CONTEXT), false);
    assert.equal(raw.includes(OWNER), false);
    assert.equal(raw.includes("other person"), false);
    assert.equal(raw.includes("group text"), false);
    assert.equal(mode(path.join(dir, SECRETS_FILE)), 0o600);
    assert.equal(mode(path.join(dir, "bridge-mcp.token")), 0o600);
    const again = await acceptBatch({ dir, account: acc, config: config(), resp: { ...resp, get_updates_buf: "cursor-3" }, now: 11 });
    assert.equal(again.created.length, 0);
    assert.equal(Object.keys(loadQueueForTest(dir).state.inbound).length, 2);
  });

  test("does not advance the cursor when the queue cannot be saved", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, SECRETS_FILE), { mode: 0o700 });
    await assert.rejects(() =>
      acceptBatch({
        dir,
        account: account(),
        config: config(),
        resp: { ret: 0, msgs: [message()], get_updates_buf: "should-not-save" },
        now: 1,
      }),
    );
    assert.equal(fs.existsSync(path.join(dir, "sync-buf.json")), false);
  });

  test("refuses allow-all before touching the cursor", async () => {
    const dir = tempDir();
    await assert.rejects(
      () => acceptBatch({ dir, account: account(), config: config({ allowFrom: ["*"] }), resp: { ret: 0, msgs: [message()], get_updates_buf: "nope" }, now: 1 }),
      (err) => err.code === "allow_all_rejected",
    );
    assert.equal(fs.existsSync(path.join(dir, "sync-buf.json")), false);
  });

  test("serializes claims and restores an expired lease without duplicating the item", async () => {
    const { dir, account: acc } = setup();
    await acceptBatch({ dir, account: acc, config: config(), resp: { ret: 0, msgs: [message()], get_updates_buf: "c" }, now: 100 });
    const id = loadQueueForTest(dir).state.inbound[Object.keys(loadQueueForTest(dir).state.inbound)[0]].queueId;
    const [first, second] = await Promise.all([claimInbound(dir, id, 100), claimInbound(dir, id, 100)]);
    const wins = [first, second].filter((item) => item.ok);
    assert.equal(wins.length, 1);
    const expired = await claimInbound(dir, id, 100 + LEASE_MS + 1);
    assert.equal(expired.ok, true);
    assert.notEqual(expired.leaseId, wins[0].leaseId);
    assert.equal(Object.keys(loadQueueForTest(dir).state.inbound).length, 1);
  });
});

describe("authorization and replies", () => {
  test("blocks auto-send until this directory is authorized, then sends once", async () => {
    const { dir, token, account: acc } = setup();
    await acceptBatch({ dir, account: acc, config: config(), resp: { ret: 0, msgs: [message({ text: "ping" })] }, now: 1 });
    const queueId = Object.keys(loadQueueForTest(dir).state.inbound)[0];
    const claimed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 1);
    const denied = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "pong" }),
      1,
    );
    assert.equal(denied.error, "autosend_not_granted");
    assert.equal(ownerAutoAllowed(readGrant(dir)), false);

    authorizeOwnerAuto(dir, 2);
    const accepted = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "pong" }),
      2,
    );
    assert.equal(accepted.outbound.status, "accepted");
    const sends = [];
    const fetchImpl = mockFetch(async (entry) => {
      if (entry.url.includes("sendmessage")) {
        sends.push(entry.body);
        return { status: 200, body: JSON.stringify({ ret: 0 }) };
      }
      return { status: 200, body: JSON.stringify({ ret: 0 }) };
    }).fn;
    await deliverAccepted({ dir, account: acc, fetchImpl, now: 3 });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].msg.to_user_id, OWNER);
    assert.equal(sends[0].msg.context_token, CONTEXT);
    const again = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: "stale", text: "pong again" }),
      4,
    );
    assert.equal(again.idempotent, true);
    assert.equal(again.outbound.status, "sent");
    await deliverAccepted({ dir, account: acc, fetchImpl, now: 5 });
    assert.equal(sends.length, 1);
    assert.equal(queueText(dir).includes(CONTEXT), false);
  });

  test("rejects a caller-supplied recipient and a non-owner reply", async () => {
    const { dir, token, account: acc } = setup();
    authorizeOwnerAuto(dir, 1);
    await acceptBatch({
      dir,
      account: acc,
      config: config({ allowFrom: [OTHER] }),
      resp: { ret: 0, msgs: [message({ id: "o", from: OTHER, text: "hi" })] },
      now: 1,
    });
    const queueId = Object.keys(loadQueueForTest(dir).state.inbound)[0];
    const claimed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 1);
    await assert.rejects(
      () =>
        callBridgeTool(
          dir,
          "weixin_submit_reply",
          auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "no", to: "someone-else" }),
          1,
        ),
      (err) => err.code === "forbidden_field",
    );
    const denied = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "no" }),
      1,
    );
    assert.equal(denied.error, "owner_only");
  });

  test("confirmation cannot send without a separate grant, and then only to the stored peer", async () => {
    const { dir, token, account: acc } = setup();
    await acceptBatch({
      dir,
      account: acc,
      config: config({ allowFrom: [OTHER] }),
      resp: { ret: 0, msgs: [message({ id: "o", from: OTHER, text: "hi" })] },
      now: 1,
    });
    const queueId = Object.keys(loadQueueForTest(dir).state.inbound)[0];
    const claimed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 1);
    const draft = await callBridgeTool(
      dir,
      "weixin_request_send",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "draft" }),
      1,
    );
    assert.equal(draft.outbound.status, "needs_confirmation");
    const blocked = await callBridgeTool(dir, "weixin_confirm_send", auth(token, { outbound_id: draft.outbound.queueId }), 1);
    assert.equal(blocked.error, "confirm_not_granted");
    authorizeConfirm(dir, 2);
    const confirmed = await callBridgeTool(dir, "weixin_confirm_send", auth(token, { outbound_id: draft.outbound.queueId }), 2);
    assert.equal(confirmed.outbound.status, "accepted");
    const sends = [];
    const fetchImpl = mockFetch(async (entry) => {
      if (entry.url.includes("sendmessage")) sends.push(entry.body);
      return { status: 200, body: JSON.stringify({ ret: 0 }) };
    }).fn;
    await deliverAccepted({ dir, account: acc, fetchImpl, now: 3 });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].msg.to_user_id, OTHER);
  });

  test("missing context token never calls sendmessage", async () => {
    const { dir, token, account: acc } = setup();
    authorizeOwnerAuto(dir, 1);
    await acceptBatch({
      dir,
      account: acc,
      config: config(),
      resp: { ret: 0, msgs: [message({ context: "" })] },
      now: 1,
    });
    const queueId = Object.keys(loadQueueForTest(dir).state.inbound)[0];
    const claimed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 1);
    const denied = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "cannot" }),
      1,
    );
    assert.equal(denied.error, "context_token_missing");
    const transport = mockFetch(async () => ({ status: 200, body: JSON.stringify({ ret: 0 }) }));
    await deliverAccepted({ dir, account: acc, fetchImpl: transport.fn, now: 2 });
    assert.equal(transport.calls.some((call) => call.url.includes("sendmessage")), false);
  });

  test("an uncertain send is not retried until this machine explicitly reopens it", async () => {
    const { dir, token, account: acc } = setup();
    authorizeOwnerAuto(dir, 1);
    await acceptBatch({ dir, account: acc, config: config(), resp: { ret: 0, msgs: [message()] }, now: 1 });
    const queueId = Object.keys(loadQueueForTest(dir).state.inbound)[0];
    const claimed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 2);
    const accepted = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "maybe" }),
      2,
    );
    const transport = mockFetch(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const outcome = await deliverAccepted({ dir, account: acc, fetchImpl: transport.fn, now: 3 });
    assert.equal(outcome[0].status, "unknown");
    assert.equal(outcome[0].failure, "uncertain");
    await deliverAccepted({ dir, account: acc, fetchImpl: transport.fn, now: 4 });
    assert.equal(transport.calls.length, 1);
    const duplicate = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "maybe" }),
      5,
    );
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.outbound.status, "unknown");
    const closed = await resolveOutbound(dir, accepted.outbound.queueId, "close", 6);
    assert.equal(closed.ok, true);
    const stillClosed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 7);
    assert.equal(stillClosed.error, "acked");
  });

  test("a restart while sending becomes unknown and is not sent again", async () => {
    const { dir, token, account: acc } = setup();
    authorizeOwnerAuto(dir, 1);
    await acceptBatch({ dir, account: acc, config: config(), resp: { ret: 0, msgs: [message()] }, now: 1 });
    const queueId = Object.keys(loadQueueForTest(dir).state.inbound)[0];
    const claimed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 2);
    await callBridgeTool(dir, "weixin_submit_reply", auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "inflight" }), 2);
    const slots = await claimSendSlots(dir, readGrant(dir), 3);
    assert.equal(slots.length, 1);
    assert.equal(loadQueueForTest(dir).state.outbound[slots[0].outboundId].status, "sending");
    const restarted = await claimSendSlots(dir, readGrant(dir), 4);
    assert.equal(restarted.length, 0);
    assert.equal(loadQueueForTest(dir).state.outbound[slots[0].outboundId].status, "unknown");
    const transport = mockFetch(async () => ({ status: 200, body: JSON.stringify({ ret: 0 }) }));
    await deliverAccepted({ dir, account: acc, fetchImpl: transport.fn, now: 5 });
    assert.equal(transport.calls.length, 0);
  });

  test("a definite WeChat rejection is stored without the server body and is not retried", async () => {
    const { dir, token, account: acc } = setup();
    authorizeOwnerAuto(dir, 1);
    await acceptBatch({ dir, account: acc, config: config(), resp: { ret: 0, msgs: [message()] }, now: 1 });
    const queueId = Object.keys(loadQueueForTest(dir).state.inbound)[0];
    const claimed = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 2);
    const accepted = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: claimed.leaseId, text: "nope" }),
      2,
    );
    const transport = mockFetch(async () => ({ status: 200, body: JSON.stringify({ ret: 14, errmsg: "context expired" }) }));
    const failed = await deliverAccepted({ dir, account: acc, fetchImpl: transport.fn, now: 3 });
    assert.equal(failed[0].status, "failed");
    assert.equal(failed[0].failure, "wechat_rejected");
    assert.equal(queueText(dir).includes("context expired"), false);
    await deliverAccepted({ dir, account: acc, fetchImpl: transport.fn, now: 4 });
    assert.equal(transport.calls.length, 1);
    const reopened = await resolveOutbound(dir, accepted.outbound.queueId, "allow-resend", 5);
    assert.equal(reopened.reopened, true);
    const again = await callBridgeTool(dir, "weixin_get_item", auth(token, { queue_id: queueId }), 6);
    const resent = await callBridgeTool(
      dir,
      "weixin_submit_reply",
      auth(token, { queue_id: queueId, lease_id: again.leaseId, text: "after check" }),
      6,
    );
    assert.equal(resent.ok, true);
    assert.equal(resent.outbound.status, "accepted");
    assert.notEqual(resent.outbound.queueId, accepted.outbound.queueId);
  });

  test("a loose grant or token file fails closed", async () => {
    const { dir, token } = setup();
    authorizeOwnerAuto(dir, 1);
    fs.chmodSync(path.join(dir, "bridge-grant.json"), 0o644);
    assert.equal(ownerAutoAllowed(readGrant(dir)), false);
    fs.chmodSync(path.join(dir, "bridge-mcp.token"), 0o644);
    await assert.rejects(() => callBridgeTool(dir, "weixin_list_pending", auth(token), 1), (err) => err.code === "state_permissions");
  });

  test("wrong token is rejected and does not return message text", async () => {
    const { dir } = setup();
    await assert.rejects(() => callBridgeTool(dir, "weixin_list_pending", auth("wrong-token"), 1), (err) => err.code === "auth_failed");
  });
});

describe("webhook", () => {
  test("coalesces wakes, retries a non-200, and does not treat 200 as a WeChat reply", async () => {
    const { dir, account: acc } = setup();
    const env = {
      GROK_WEIXIN_ROUTINE_WEBHOOK_URL: "http://127.0.0.1/hook",
      GROK_WEIXIN_ROUTINE_WEBHOOK_TOKEN: "wake-secret",
      GROK_WEIXIN_BRIDGE_ALLOW_HTTP: "1",
      GROK_WEIXIN_BRIDGE_WAKE_MAX_PER_HOUR: "30",
    };
    await acceptBatch({
      dir,
      account: acc,
      config: config(),
      resp: { ret: 0, msgs: [message({ id: "a", text: "one" }), message({ id: "b", text: "two" })], get_updates_buf: "c" },
      now: 1_000,
    });
    let status = 500;
    const transport = mockFetch(async () => ({ status, body: "nope" }));
    const first = await flushWake({ dir, env, fetchImpl: transport.fn, now: 1_000 });
    assert.equal(first.reason, "http_500");
    assert.equal(loadQueueForTest(dir).state.outbound && Object.keys(loadQueueForTest(dir).state.outbound).length, 0);
    const backedOff = await flushWake({ dir, env, fetchImpl: transport.fn, now: 1_100 });
    assert.equal(backedOff.reason, "backoff");
    status = 200;
    const second = await flushWake({ dir, env, fetchImpl: transport.fn, now: 1_000 + 5_000 });
    assert.equal(second.posted, true);
    const wakes = transport.calls.filter((call) => call.url.includes("/hook"));
    assert.equal(wakes.length, 2);
    assert.equal(wakes[1].body.pendingCount, 2);
    assert.equal(wakes[1].body.schema, "weixin-bridge.wake.v1");
    assert.equal(wakes[1].redirect, "manual");
    const raw = JSON.stringify(wakes[1].body);
    assert.equal(raw.includes("one"), false);
    assert.equal(raw.includes("two"), false);
    assert.equal(raw.includes(CONTEXT), false);
    assert.equal(raw.includes(OWNER), false);
    assert.equal(raw.includes("wake-secret"), false);
    assert.equal(transport.calls.some((call) => call.url.includes("sendmessage")), false);
    const idle = await flushWake({ dir, env, fetchImpl: transport.fn, now: 20_000 });
    assert.equal(idle.reason, "idle");
  });

  test("wake body builder has no message text", () => {
    const body = buildWakeBody({
      botBinding: BINDING,
      pending: [{ queueId: "q1", peerRole: "owner" }],
      results: [],
    });
    assert.equal(JSON.stringify(body).includes("hello"), false);
    assert.deepEqual(body.peerRoles, ["owner"]);
  });
});

describe("process", () => {
  test("one poll enqueues, wakes, and does not send before a reply exists", async () => {
    const { dir, account: acc } = setup();
    const env = {
      GROK_WEIXIN_ROUTINE_WEBHOOK_URL: "http://127.0.0.1/hook",
      GROK_WEIXIN_ROUTINE_WEBHOOK_TOKEN: "wake-secret",
      GROK_WEIXIN_BRIDGE_ALLOW_HTTP: "1",
    };
    const transport = mockFetch(async (entry) => {
      if (entry.url.includes("getupdates")) {
        return {
          status: 200,
          body: JSON.stringify({ ret: 0, errcode: 0, get_updates_buf: "next", msgs: [message({ text: "from-phone" })] }),
        };
      }
      return { status: 200, body: JSON.stringify({ ret: 0 }) };
    });
    await runBridge({
      dir,
      account: acc,
      config: config(),
      env,
      fetchImpl: transport.fn,
      pollOnce: true,
      manageSignals: false,
      now: () => 50,
    });
    assert.equal(Object.keys(loadQueueForTest(dir).state.inbound).length, 1);
    assert.equal(Object.keys(loadQueueForTest(dir).state.outbound).length, 0);
    assert.equal(transport.calls.some((call) => call.url.includes("/hook")), true);
    assert.equal(transport.calls.some((call) => call.url.includes("sendmessage")), false);
    assert.equal(fs.existsSync(path.join(dir, "poller.json")), false);
  });

  test("a live bridge poller blocks the legacy sender", () => {
    const dir = tempDir();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      fs.writeFileSync(path.join(dir, "poller.json"), JSON.stringify({ pid: child.pid, mode: "grok-bot" }));
      process.env.GROK_WEIXIN_STATE_DIR = dir;
      delete process.env.GROK_WEIXIN_PROVIDER;
      assert.match(legacyBridgeConflict(), /bridge-mcp|桥接/);
      process.env.GROK_WEIXIN_PROVIDER = "grok-bot";
      assert.match(legacyBridgeConflict(), /grok-bot/);
    } finally {
      child.kill();
    }
  });
});

describe("mcp", () => {
  test("lists the custom tools and rejects a bad token without returning the queue", async () => {
    const { dir, token } = setup();
    await acceptBatch({ dir, account: account(), config: config(), resp: { ret: 0, msgs: [message({ text: "secret-body" })] }, now: 1 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createBridgeMcpServer({ dir });
    await server.connect(serverTransport);
    const client = new Client({ name: "bridge-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...BRIDGE_TOOLS].sort());
      const bad = await client.callTool({
        name: "weixin_list_pending",
        arguments: { auth_token: "nope", bot_binding: BINDING },
      });
      assert.equal(bad.isError, true);
      assert.equal(JSON.stringify(bad).includes("secret-body"), false);
      const good = await client.callTool({
        name: "weixin_list_pending",
        arguments: { auth_token: token, bot_binding: BINDING },
      });
      assert.equal(good.isError, false);
      assert.equal(JSON.stringify(good).includes("secret-body"), true);
      assert.equal(JSON.stringify(good).includes(CONTEXT), false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("cli", () => {
  test("status and authorize stay on the temp directory and do not print secrets", () => {
    const dir = tempDir();
    const env = {
      ...process.env,
      GROK_WEIXIN_STATE_DIR: dir,
      GROK_WEIXIN_PROVIDER: "grok-bot",
      GROK_WEIXIN_ROUTINE_WEBHOOK_URL: "https://example.invalid/hook",
      GROK_WEIXIN_ROUTINE_WEBHOOK_TOKEN: "cli-wake-secret",
    };
    const init = spawnSync(process.execPath, ["cli.mjs", "bridge-init", "--bot-binding", BINDING], { cwd: "/workspace", env, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const token = readMcpToken(dir);
    assert.equal(`${init.stdout}${init.stderr}`.includes(token), false);
    assert.equal(`${init.stdout}${init.stderr}`.includes("cli-wake-secret"), false);
    const denied = spawnSync(process.execPath, ["cli.mjs", "bridge-authorize", "--scope", "owner"], { cwd: "/workspace", env, encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    const status = spawnSync(process.execPath, ["cli.mjs", "bridge-status"], { cwd: "/workspace", env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /"autoSend": false/);
    assert.match(status.stdout, /"webhookConfigured": true/);
    assert.equal(status.stdout.includes("cli-wake-secret"), false);
    assert.equal(status.stdout.includes(token), false);
    const help = spawnSync(process.execPath, ["cli.mjs", "help"], { cwd: "/workspace", env, encoding: "utf8" });
    assert.match(help.stdout, /bridge-mcp/);
  });
});
