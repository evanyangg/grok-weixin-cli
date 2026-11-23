// Durable inbound/outbound queue. Context tokens and peer ids live in a separate mode-600 file.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { atomicWriteJson, isOwnerOnly, readJsonFile, withFileLock } from "./lock.mjs";
import {
  GRANT_SOURCE,
  INBOUND_SCHEMA,
  OUTBOUND_SCHEMA,
  defaultGrant,
  ownerAutoAllowed,
  prepareReplyText,
  publicInbound,
  publicOutbound,
} from "./policy.mjs";

export const QUEUE_FILE = "bridge-queue.json";
export const SECRETS_FILE = "bridge-secrets.json";
export const TOKEN_FILE = "bridge-mcp.token";
export const GRANT_FILE = "bridge-grant.json";
export const CURSOR_FILE = "sync-buf.json";
export const LEASE_MS = 120_000;

const BLOCKING_OUTBOUND = new Set([
  "accepted",
  "sending",
  "sent",
  "unknown",
  "failed",
  "needs_confirmation",
]);

function queueFile(dir) {
  return path.join(dir, QUEUE_FILE);
}
function secretsFile(dir) {
  return path.join(dir, SECRETS_FILE);
}
function grantFile(dir) {
  return path.join(dir, GRANT_FILE);
}
function tokenFile(dir) {
  return path.join(dir, TOKEN_FILE);
}
function lockFile(dir) {
  return path.join(dir, "bridge-queue.lock");
}

function blankState() {
  return {
    version: 1,
    inbound: {},
    dedupe: {},
    outbound: {},
    wake: { pendingIds: [], results: [], attempts: 0, nextAttemptAt: 0, hourStart: 0, hourCount: 0, lastResult: "" },
    rejected: {},
  };
}

function blankSecrets() {
  return { version: 1, inbound: {}, outbound: {} };
}

function asRecord(value) {
  const out = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of Object.keys(value)) out[key] = value[key];
  return out;
}

function loadState(dir) {
  const raw = readJsonFile(queueFile(dir), null) ?? blankState();
  raw.inbound = asRecord(raw.inbound);
  raw.dedupe = asRecord(raw.dedupe);
  raw.outbound = asRecord(raw.outbound);
  raw.wake = {
    pendingIds: Array.isArray(raw.wake?.pendingIds) ? raw.wake.pendingIds : [],
    results: Array.isArray(raw.wake?.results) ? raw.wake.results : [],
    attempts: raw.wake?.attempts || 0,
    nextAttemptAt: raw.wake?.nextAttemptAt || 0,
    hourStart: raw.wake?.hourStart || 0,
    hourCount: raw.wake?.hourCount || 0,
    lastResult: raw.wake?.lastResult || "",
  };
  raw.rejected = asRecord(raw.rejected);
  return raw;
}

function loadSecrets(dir) {
  const file = secretsFile(dir);
  if (fs.existsSync(file) && !isOwnerOnly(file)) {
    const err = new Error("bridge-secrets.json 权限过宽，已拒绝读取令牌");
    err.code = "state_permissions";
    throw err;
  }
  const raw = readJsonFile(file, null) ?? blankSecrets();
  raw.inbound = asRecord(raw.inbound);
  raw.outbound = asRecord(raw.outbound);
  return raw;
}

function saveBoth(dir, state, secrets) {
  atomicWriteJson(secretsFile(dir), secrets);
  atomicWriteJson(queueFile(dir), state);
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function recoverLeases(state, now) {
  let changed = false;
  for (const item of Object.values(state.inbound)) {
    if (item.status === "leased" && (!item.lease || item.lease.until <= now)) {
      item.status = "pending";
      item.lease = null;
      if (!state.wake.pendingIds.includes(item.queueId)) state.wake.pendingIds.push(item.queueId);
      changed = true;
    }
  }
  return changed;
}

function recoverSending(state, now) {
  let changed = false;
  for (const item of Object.values(state.outbound)) {
    if (item.status !== "sending") continue;
    item.status = "unknown";
    item.failure = "interrupted";
    item.resolvedAt = new Date(now).toISOString();
    pushResult(state, item);
    changed = true;
  }
  return changed;
}

function pushResult(state, item) {
  const id = `${item.queueId}:${item.status}:${item.sendAttempt}`;
  if (state.wake.results.some((row) => row.id === id)) return;
  state.wake.results.push({
    id,
    outboundId: item.queueId,
    inReplyTo: item.inReplyTo,
    status: item.status,
    peerRole: item.peerRole,
  });
}

function activeOutbound(state, inboundId) {
  return Object.values(state.outbound).find(
    (item) => item.inReplyTo === inboundId && !item.superseded && item.status !== "cancelled" && BLOCKING_OUTBOUND.has(item.status),
  );
}

function mustLease(item, leaseId, now) {
  if (!item) return "not_found";
  if (item.status !== "leased" || !item.lease || item.lease.id !== leaseId || item.lease.until <= now) {
    return "lease_required";
  }
  return "";
}

export function readGrant(dir) {
  const file = grantFile(dir);
  if (!fs.existsSync(file)) return defaultGrant();
  const saved = readJsonFile(file, null) ?? {};
  const grant = {
    ...defaultGrant(),
    ...saved,
    autoSend: { ...defaultGrant().autoSend, ...(saved.autoSend ?? {}) },
    confirmSend: { ...defaultGrant().confirmSend, ...(saved.confirmSend ?? {}) },
  };
  if (!isOwnerOnly(file)) {
    grant.autoSend = { ...grant.autoSend, enabled: false };
    grant.confirmSend = { ...grant.confirmSend, enabled: false };
    grant.groupPolicy = "fail-closed";
    grant.permissionBlocked = true;
  }
  return grant;
}

export function writeGrant(dir, grant) {
  const next = { ...grant };
  delete next.permissionBlocked;
  atomicWriteJson(grantFile(dir), next);
}

export function initBridge(dir, botBinding, { rotateToken = false, now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const grant = readGrant(dir);
  if (grant.botBinding && grant.botBinding !== botBinding && !rotateToken) {
    throw new Error(`这个状态目录已绑定 ${grant.botBinding}。更换绑定会让原来的 routine 对不上队列。`);
  }
  grant.botBinding = botBinding;
  if (!grant.autoSend?.grantSource) grant.autoSend = defaultGrant().autoSend;
  if (!grant.confirmSend?.grantSource) grant.confirmSend = defaultGrant().confirmSend;
  if (!grant.groupPolicy) grant.groupPolicy = "fail-closed";
  writeGrant(dir, grant);
  const file = tokenFile(dir);
  let created = false;
  if (!fs.existsSync(file) || rotateToken) {
    atomicWriteJson(file, { token: crypto.randomBytes(32).toString("base64url"), createdAt: new Date(now).toISOString() });
    created = true;
  } else if (!isOwnerOnly(file)) {
    throw new Error("MCP 令牌文件权限过宽。请先收紧为仅所有者可读，或使用 --rotate-token 重新生成。");
  }
  return { tokenFile: file, created, botBinding };
}

export function readMcpToken(dir) {
  const file = tokenFile(dir);
  if (!fs.existsSync(file)) {
    const err = new Error("尚未初始化桥接 MCP 令牌");
    err.code = "auth_failed";
    throw err;
  }
  if (!isOwnerOnly(file)) {
    const err = new Error("MCP 令牌文件权限过宽");
    err.code = "state_permissions";
    throw err;
  }
  const saved = readJsonFile(file, null);
  if (!saved?.token || typeof saved.token !== "string") {
    const err = new Error("MCP 令牌文件无效");
    err.code = "auth_failed";
    throw err;
  }
  return saved.token;
}

export function tokenMatches(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string" || !expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function commitCursor(dir, buf) {
  atomicWriteJson(path.join(dir, CURSOR_FILE), { buf });
}

export function readCursor(dir) {
  return readJsonFile(path.join(dir, CURSOR_FILE), {}).buf ?? "";
}

export async function ingestPrepared(dir, prepared, rejections, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    recoverLeases(state, now);
    const created = [];
    const existing = [];
    for (const entry of prepared) {
      const priorId = state.dedupe[entry.record.dedupeKey];
      if (priorId && state.inbound[priorId]) {
        existing.push(publicInbound(state.inbound[priorId]));
        continue;
      }
      const queueId = crypto.randomUUID();
      const record = {
        ...entry.record,
        schema: INBOUND_SCHEMA,
        queueId,
        receivedAt: new Date(now).toISOString(),
        status: "pending",
        lease: null,
      };
      state.inbound[queueId] = record;
      state.dedupe[entry.record.dedupeKey] = queueId;
      secrets.inbound[queueId] = {
        contextToken: entry.secret.contextToken || "",
        peerUserId: entry.secret.peerUserId,
        messageId: entry.secret.messageId,
      };
      if (!state.wake.pendingIds.includes(queueId)) state.wake.pendingIds.push(queueId);
      created.push(publicInbound(record));
    }
    for (const [reason, count] of Object.entries(rejections)) {
      for (let i = 0; i < count; i++) bump(state.rejected, reason);
    }
    saveBoth(dir, state, secrets);
    return { created, existing, rejected: { ...state.rejected } };
  });
}

export async function readInbound(dir, queueId, leaseId, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    if (recoverLeases(state, now)) saveBoth(dir, state, loadSecrets(dir));
    const item = state.inbound[queueId];
    if (!item) return { ok: false, error: "not_found" };
    if (item.status === "leased" && item.lease?.until > now && item.lease.id !== leaseId) {
      return { ok: false, error: "leased" };
    }
    return { ok: true, item: publicInbound(item), leaseId: item.lease?.id ?? null };
  });
}

export async function claimInbound(dir, queueId, now, leaseMs = LEASE_MS) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const changed = recoverLeases(state, now);
    const item = state.inbound[queueId];
    if (!item) return { ok: false, error: "not_found" };
    if (item.status === "leased" && item.lease?.until > now) {
      if (changed) saveBoth(dir, state, loadSecrets(dir));
      return { ok: false, error: "leased", retryAt: item.lease.until };
    }
    if (item.status === "acked") return { ok: false, error: "acked" };
    const leaseId = crypto.randomUUID();
    item.status = "leased";
    item.lease = { id: leaseId, until: now + leaseMs };
    state.wake.pendingIds = state.wake.pendingIds.filter((id) => id !== queueId);
    saveBoth(dir, state, loadSecrets(dir));
    return { ok: true, leaseId, leaseExpiresAt: item.lease.until, item: publicInbound(item) };
  });
}

export async function ackInbound(dir, queueId, leaseId, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    recoverLeases(state, now);
    const item = state.inbound[queueId];
    const leaseError = mustLease(item, leaseId, now);
    if (leaseError) return { ok: false, error: leaseError };
    item.status = "acked";
    item.lease = null;
    state.wake.pendingIds = state.wake.pendingIds.filter((id) => id !== queueId);
    saveBoth(dir, state, loadSecrets(dir));
    return { ok: true, item: publicInbound(item) };
  });
}

function rejectExtraSend(state, inboundId) {
  const existing = activeOutbound(state, inboundId);
  if (!existing) return null;
  return { ok: true, idempotent: true, outbound: publicOutbound(existing) };
}

export async function submitOwnerReply(dir, { queueId, leaseId, text, grant }, now) {
  const plain = prepareReplyText(text);
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    recoverLeases(state, now);
    const item = state.inbound[queueId];
    const duplicate = item ? rejectExtraSend(state, queueId) : null;
    if (duplicate) return duplicate;
    const leaseError = mustLease(item, leaseId, now);
    if (leaseError) return { ok: false, error: leaseError };
    if (item.peerRole !== "owner") return { ok: false, error: "owner_only" };
    if (item.conversationKind !== "unverified") return { ok: false, error: "conversation_blocked" };
    if (!ownerAutoAllowed(grant)) return { ok: false, error: "autosend_not_granted" };
    const secret = secrets.inbound[queueId];
    if (!secret?.contextToken) return { ok: false, error: "context_token_missing" };
    if (!secret?.peerUserId) return { ok: false, error: "peer_missing" };
    const outbound = newOutbound({
      inReplyTo: queueId,
      peerRole: "owner",
      text: plain,
      authorization: "owner_auto",
      status: "accepted",
      now,
    });
    state.outbound[outbound.queueId] = outbound;
    secrets.outbound[outbound.queueId] = { contextToken: secret.contextToken, peerUserId: secret.peerUserId };
    item.status = "acked";
    item.lease = null;
    state.wake.pendingIds = state.wake.pendingIds.filter((id) => id !== queueId);
    saveBoth(dir, state, secrets);
    return { ok: true, idempotent: false, outbound: publicOutbound(outbound) };
  });
}

export async function requestSend(dir, { queueId, leaseId, text }, now) {
  const plain = prepareReplyText(text);
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    recoverLeases(state, now);
    const item = state.inbound[queueId];
    const duplicate = item ? rejectExtraSend(state, queueId) : null;
    if (duplicate) return duplicate;
    const leaseError = mustLease(item, leaseId, now);
    if (leaseError) return { ok: false, error: leaseError };
    if (item.conversationKind !== "unverified") return { ok: false, error: "conversation_blocked" };
    const secret = secrets.inbound[queueId];
    if (!secret?.contextToken) return { ok: false, error: "context_token_missing" };
    if (!secret?.peerUserId) return { ok: false, error: "peer_missing" };
    const outbound = newOutbound({
      inReplyTo: queueId,
      peerRole: item.peerRole,
      text: plain,
      authorization: "needs_confirmation",
      status: "needs_confirmation",
      now,
    });
    state.outbound[outbound.queueId] = outbound;
    secrets.outbound[outbound.queueId] = { contextToken: secret.contextToken, peerUserId: secret.peerUserId };
    item.status = "acked";
    item.lease = null;
    state.wake.pendingIds = state.wake.pendingIds.filter((id) => id !== queueId);
    saveBoth(dir, state, secrets);
    return { ok: true, idempotent: false, outbound: publicOutbound(outbound) };
  });
}

export async function confirmSend(dir, outboundId, grant, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    const item = state.outbound[outboundId];
    if (!item || item.superseded) return { ok: false, error: "not_found" };
    if (item.status === "sent" || item.status === "sending" || item.status === "unknown" || item.status === "accepted") {
      return { ok: true, idempotent: true, outbound: publicOutbound(item) };
    }
    if (item.status !== "needs_confirmation") return { ok: false, error: "not_confirmable" };
    if (grant?.confirmSend?.enabled !== true || grant?.confirmSend?.grantSource !== GRANT_SOURCE) {
      return { ok: false, error: "confirm_not_granted" };
    }
    if (grant.groupPolicy !== "allow-unverified-direct" || grant.permissionBlocked) {
      return { ok: false, error: "conversation_unverified" };
    }
    const inbound = state.inbound[item.inReplyTo];
    if (!inbound || inbound.conversationKind !== "unverified") return { ok: false, error: "conversation_blocked" };
    const secret = secrets.outbound[outboundId];
    const inboundSecret = secrets.inbound[item.inReplyTo];
    if (!secret?.contextToken || !secret?.peerUserId) return { ok: false, error: "context_token_missing" };
    if (!inboundSecret || inboundSecret.peerUserId !== secret.peerUserId) return { ok: false, error: "peer_mismatch" };
    item.status = "accepted";
    item.authorization = "confirmed";
    saveBoth(dir, state, secrets);
    return { ok: true, idempotent: false, outbound: publicOutbound(item) };
  });
}

export async function cancelSend(dir, outboundId) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    const item = state.outbound[outboundId];
    if (!item || item.superseded) return { ok: false, error: "not_found" };
    if (item.status === "cancelled") return { ok: true, idempotent: true, outbound: publicOutbound(item) };
    if (item.status !== "needs_confirmation" && item.status !== "accepted") {
      return { ok: false, error: "not_cancellable", status: item.status };
    }
    item.status = "cancelled";
    saveBoth(dir, state, secrets);
    return { ok: true, idempotent: false, outbound: publicOutbound(item) };
  });
}

function newOutbound({ inReplyTo, peerRole, text, authorization, status, now }) {
  const queueId = crypto.randomUUID();
  return {
    schema: OUTBOUND_SCHEMA,
    queueId,
    inReplyTo,
    createdAt: new Date(now).toISOString(),
    peerRole,
    text,
    authorization,
    status,
    sendAttempt: 0,
    failure: "",
    clientId: `bridge:${queueId}`,
    superseded: false,
  };
}

export async function listPending(dir, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    if (recoverLeases(state, now)) saveBoth(dir, state, loadSecrets(dir));
    const pending = Object.values(state.inbound)
      .filter((item) => item.status === "pending")
      .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)))
      .slice(0, 20)
      .map(publicInbound);
    return { pending, rejected: { ...state.rejected } };
  });
}

export async function getOutbound(dir, outboundId) {
  const state = loadState(dir);
  if (!outboundId) {
    return Object.values(state.outbound)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 20)
      .map(publicOutbound);
  }
  const item = state.outbound[outboundId];
  if (!item) return null;
  return publicOutbound(item);
}

export function bridgeSummary(dir, env = process.env) {
  const grant = readGrant(dir);
  const state = fs.existsSync(queueFile(dir)) ? loadState(dir) : blankState();
  const url = env.GROK_WEIXIN_ROUTINE_WEBHOOK_URL || "";
  const token = env.GROK_WEIXIN_ROUTINE_WEBHOOK_TOKEN || "";
  return {
    botBinding: grant.botBinding || "",
    groupPolicy: grant.groupPolicy,
    autoSend: ownerAutoAllowed(grant),
    confirmSend: grant.confirmSend?.enabled === true && grant.confirmSend?.grantSource === GRANT_SOURCE && !grant.permissionBlocked,
    permissionBlocked: Boolean(grant.permissionBlocked),
    webhookConfigured: Boolean(url && token),
    pending: Object.values(state.inbound).filter((item) => item.status === "pending").length,
    leased: Object.values(state.inbound).filter((item) => item.status === "leased").length,
    wakeLastResult: state.wake.lastResult || "",
    rejected: { ...state.rejected },
  };
}

function sendStillAllowed(item, state, secrets, grant) {
  const inbound = state.inbound[item.inReplyTo];
  const secret = secrets.outbound[item.queueId];
  const inboundSecret = secrets.inbound[item.inReplyTo];
  if (!inbound || inbound.conversationKind !== "unverified") return "conversation_blocked";
  if (!secret?.contextToken || !secret?.peerUserId) return "context_token_missing";
  if (!inboundSecret || inboundSecret.peerUserId !== secret.peerUserId) return "peer_mismatch";
  if (item.authorization === "owner_auto") {
    if (item.peerRole !== "owner" || inbound.peerRole !== "owner") return "owner_only";
    if (!ownerAutoAllowed(grant)) return "autosend_not_granted";
    return "";
  }
  if (item.authorization === "confirmed") {
    if (grant?.confirmSend?.enabled !== true || grant?.confirmSend?.grantSource !== GRANT_SOURCE) return "confirm_not_granted";
    if (grant.groupPolicy !== "allow-unverified-direct" || grant.permissionBlocked) return "conversation_unverified";
    return "";
  }
  return "authorization_rejected";
}

export async function claimSendSlots(dir, grant, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    recoverLeases(state, now);
    recoverSending(state, now);
    const won = [];
    for (const item of Object.values(state.outbound)) {
      if (item.status !== "accepted" || item.superseded) continue;
      const blocked = sendStillAllowed(item, state, secrets, grant);
      if (blocked) {
        item.status = "failed";
        item.failure = blocked;
        pushResult(state, item);
        continue;
      }
      item.status = "sending";
      item.sendAttempt += 1;
      item.sendingAt = new Date(now).toISOString();
      const secret = secrets.outbound[item.queueId];
      won.push({
        outboundId: item.queueId,
        text: item.text,
        clientId: item.clientId,
        contextToken: secret.contextToken,
        peerUserId: secret.peerUserId,
      });
    }
    saveBoth(dir, state, secrets);
    return won;
  });
}

export async function finishSend(dir, outboundId, { status, failure }, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    const item = state.outbound[outboundId];
    if (!item) return null;
    if (item.status === "sent") return publicOutbound(item);
    if (item.status !== "sending" && item.status !== "unknown") return publicOutbound(item);
    item.status = status;
    item.failure = failure || "";
    item.resolvedAt = new Date(now).toISOString();
    if (status === "sent") {
      delete secrets.outbound[outboundId];
      delete secrets.inbound[item.inReplyTo];
    }
    pushResult(state, item);
    saveBoth(dir, state, secrets);
    return publicOutbound(item);
  });
}

export async function resolveOutbound(dir, outboundId, decision, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const secrets = loadSecrets(dir);
    const item = state.outbound[outboundId];
    if (!item || item.superseded) return { ok: false, error: "not_found" };
    if (item.status !== "unknown" && item.status !== "failed") {
      return { ok: false, error: "not_resolvable", status: item.status };
    }
    if (decision === "close") {
      item.superseded = true;
      item.status = item.status === "unknown" ? "closed_unknown" : "closed_failed";
      saveBoth(dir, state, secrets);
      return { ok: true, outbound: publicOutbound(item) };
    }
    if (decision === "allow-resend") {
      item.superseded = true;
      item.status = item.status === "unknown" ? "closed_unknown" : "closed_failed";
      const inbound = state.inbound[item.inReplyTo];
      if (inbound && inbound.status === "acked") {
        inbound.status = "pending";
        inbound.lease = null;
        if (!state.wake.pendingIds.includes(inbound.queueId)) state.wake.pendingIds.push(inbound.queueId);
      }
      saveBoth(dir, state, secrets);
      return { ok: true, outbound: publicOutbound(item), reopened: Boolean(inbound) };
    }
    return { ok: false, error: "bad_decision" };
  });
}

export function secretScanList(dir) {
  if (!fs.existsSync(secretsFile(dir))) return [];
  let secrets;
  try {
    secrets = loadSecrets(dir);
  } catch {
    return [];
  }
  const values = [];
  for (const bag of [secrets.inbound, secrets.outbound]) {
    for (const entry of Object.values(bag)) {
      if (entry?.contextToken) values.push(entry.contextToken);
      if (entry?.peerUserId) values.push(entry.peerUserId);
    }
  }
  return values;
}

export async function reserveWake(dir, now, maxPerHour) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    recoverLeases(state, now);
    const pendingIds = state.wake.pendingIds.filter((id) => state.inbound[id]?.status === "pending");
    state.wake.pendingIds = pendingIds;
    if (!pendingIds.length && !state.wake.results.length) {
      saveBoth(dir, state, loadSecrets(dir));
      return { idle: true };
    }
    if (state.wake.nextAttemptAt && now < state.wake.nextAttemptAt) {
      saveBoth(dir, state, loadSecrets(dir));
      return { delayed: true, nextAttemptAt: state.wake.nextAttemptAt };
    }
    if (!state.wake.hourStart || now - state.wake.hourStart >= 3_600_000) {
      state.wake.hourStart = now;
      state.wake.hourCount = 0;
    }
    if (state.wake.hourCount >= maxPerHour) {
      state.wake.lastResult = "local_rate_limit";
      saveBoth(dir, state, loadSecrets(dir));
      return { limited: true };
    }
    state.wake.hourCount += 1;
    const pending = pendingIds.map((id) => ({
      queueId: id,
      peerRole: state.inbound[id].peerRole,
    }));
    const results = state.wake.results.map((row) => ({ ...row }));
    saveBoth(dir, state, loadSecrets(dir));
    return { pending, results, pendingIds: [...pendingIds], resultIds: results.map((row) => row.id) };
  });
}

export async function noteWakeSuccess(dir, snapshot) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const ids = new Set(snapshot.pendingIds);
    const resultIds = new Set(snapshot.resultIds);
    state.wake.pendingIds = state.wake.pendingIds.filter((id) => !ids.has(id));
    state.wake.results = state.wake.results.filter((row) => !resultIds.has(row.id));
    state.wake.attempts = 0;
    state.wake.nextAttemptAt = 0;
    state.wake.lastResult = "http_200";
    saveBoth(dir, state, loadSecrets(dir));
  });
}

export async function noteWakeFailure(dir, snapshot, code, now) {
  return withFileLock(lockFile(dir), async () => {
    const state = loadState(dir);
    const delays = [5_000, 15_000, 30_000, 60_000];
    const delay = delays[Math.min(state.wake.attempts, delays.length - 1)];
    state.wake.attempts += 1;
    state.wake.nextAttemptAt = now + delay;
    state.wake.lastResult = code;
    saveBoth(dir, state, loadSecrets(dir));
    return { delay, attempts: state.wake.attempts };
  });
}

export function authorizeOwnerAuto(dir, now = Date.now()) {
  const grant = readGrant(dir);
  if (!grant.botBinding) throw new Error("请先在这个状态目录运行 bridge-init。");
  if (grant.permissionBlocked) throw new Error("授权文件权限过宽，拒绝写入自动发送许可。");
  grant.autoSend = {
    enabled: true,
    scope: "owner",
    grantedAt: new Date(now).toISOString(),
    grantSource: GRANT_SOURCE,
  };
  grant.groupPolicy = "allow-unverified-direct";
  writeGrant(dir, grant);
  return readGrant(dir);
}

export function authorizeConfirm(dir, now = Date.now()) {
  const grant = readGrant(dir);
  if (!grant.botBinding) throw new Error("请先在这个状态目录运行 bridge-init。");
  if (grant.permissionBlocked) throw new Error("授权文件权限过宽，拒绝写入确认发送许可。");
  if (grant.groupPolicy !== "allow-unverified-direct") {
    grant.groupPolicy = "allow-unverified-direct";
  }
  grant.confirmSend = {
    enabled: true,
    grantedAt: new Date(now).toISOString(),
    grantSource: GRANT_SOURCE,
  };
  writeGrant(dir, grant);
  return readGrant(dir);
}

export function revokeGrant(dir, scope) {
  const grant = readGrant(dir);
  if (scope === "owner" || scope === "all") grant.autoSend = defaultGrant().autoSend;
  if (scope === "confirm-send" || scope === "all") grant.confirmSend = defaultGrant().confirmSend;
  if (scope !== "owner" && scope !== "confirm-send" && scope !== "all") {
    throw new Error("scope 只能是 owner、confirm-send 或 all");
  }
  if (!grant.autoSend.enabled && !grant.confirmSend.enabled) grant.groupPolicy = "fail-closed";
  writeGrant(dir, grant);
  return readGrant(dir);
}

export function loadQueueForTest(dir) {
  return { state: loadState(dir), secrets: fs.existsSync(secretsFile(dir)) ? loadSecrets(dir) : blankSecrets() };
}

export { GRANT_SOURCE };
