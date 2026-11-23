// Wake the existing Grok Bot through its routine webhook.
// HTTP 200 means a run started. It does not mean WeChat was answered.

import { WAKE_SCHEMA, assertPayloadSafe } from "./policy.mjs";
import { noteWakeFailure, noteWakeSuccess, readGrant, readMcpToken, reserveWake, secretScanList } from "./queue.mjs";

export function wakeCap(env = process.env) {
  const raw = Number(env.GROK_WEIXIN_BRIDGE_WAKE_MAX_PER_HOUR ?? 30);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(Math.floor(raw), 60);
}

export function buildWakeBody({ botBinding, pending, results }) {
  const peerRoles = [...new Set([...(pending ?? []).map((row) => row.peerRole), ...(results ?? []).map((row) => row.peerRole)])].sort();
  const latest = pending?.at(-1)?.queueId ?? results?.at(-1)?.inReplyTo ?? null;
  return {
    schema: WAKE_SCHEMA,
    botBinding,
    pendingCount: pending?.length ?? 0,
    latestQueueId: latest,
    peerRoles,
    reason: pending?.length ? "inbound" : "send_result",
    sendResults: (results ?? []).slice(0, 10).map((row) => ({
      outboundId: row.outboundId,
      inReplyTo: row.inReplyTo,
      status: row.status,
      peerRole: row.peerRole,
    })),
  };
}

function webhookTarget(env) {
  const url = env.GROK_WEIXIN_ROUTINE_WEBHOOK_URL || "";
  const token = env.GROK_WEIXIN_ROUTINE_WEBHOOK_TOKEN || "";
  if (!url || !token) return { error: "unconfigured" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "bad_url" };
  }
  if (parsed.username || parsed.password) return { error: "url_has_credentials" };
  const allowHttp = env.GROK_WEIXIN_BRIDGE_ALLOW_HTTP === "1";
  const localHttp =
    allowHttp && parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (parsed.protocol !== "https:" && !localHttp) return { error: "url_not_https" };
  return { url, token };
}

export async function flushWake({ dir, env = process.env, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const target = webhookTarget(env);
  if (target.error) return { posted: false, reason: target.error };
  const grant = readGrant(dir);
  const snapshot = await reserveWake(dir, now, wakeCap(env));
  if (snapshot.idle) return { posted: false, reason: "idle" };
  if (snapshot.delayed) return { posted: false, reason: "backoff" };
  if (snapshot.limited) return { posted: false, reason: "local_rate_limit" };

  const body = buildWakeBody({
    botBinding: grant.botBinding,
    pending: snapshot.pending,
    results: snapshot.results,
  });
  try {
    const secrets = [target.token, ...secretScanList(dir)];
    try {
      secrets.push(readMcpToken(dir));
    } catch {}
    assertPayloadSafe(body, secrets);
    const res = await fetchImpl(target.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify(body),
    });
    await res.text?.().catch(() => "");
    if (res.status !== 200) {
      await noteWakeFailure(dir, snapshot, `http_${res.status}`, now);
      return { posted: false, reason: `http_${res.status}` };
    }
    await noteWakeSuccess(dir, snapshot);
    return { posted: true, reason: "http_200" };
  } catch (err) {
    const code = err?.code === "payload_unsafe" ? "payload_unsafe" : "network";
    await noteWakeFailure(dir, snapshot, code, now);
    return { posted: false, reason: code };
  }
}
