// Find and validate Grok credentials for `install`.

import { loadSdk } from "./backends/cursor.mjs";
import * as grok from "./grok.mjs";
import { cursorKeyFromEnv, loadConfig, loadSavedConfig } from "./store.mjs";

/**
 * Look for credentials that already exist, without asking the user.
 * Returns { provider: "cursor" | "xai", source } or null.
 *
 * Order: environment (Cursor first, then xAI), then config.json (preferring its
 * saved provider), then a stored `cursor-login`.
 */
export async function detectCredentials() {
  const cursorEnv = cursorKeyFromEnv();
  const xaiEnv = process.env.XAI_API_KEY?.trim();
  const saved = loadSavedConfig();

  if (cursorEnv && xaiEnv && saved.provider === "xai") return { provider: "xai", source: "XAI_API_KEY" };
  if (cursorEnv) return { provider: "cursor", source: cursorEnv.source };
  if (xaiEnv) return { provider: "xai", source: "XAI_API_KEY" };

  const savedOrder = saved.provider === "xai" ? ["xai", "cursor"] : ["cursor", "xai"];
  for (const provider of savedOrder) {
    if (provider === "cursor" && saved.cursorApiKey) return { provider, source: "config.json" };
    if (provider === "xai" && saved.apiKey) return { provider, source: "config.json" };
  }

  try {
    const sdk = await loadSdk();
    const status = await sdk.Cursor.auth.status();
    if (status.status === "logged-in") {
      return { provider: "cursor", source: `cursor-login${status.email ? ` (${status.email})` : ""}` };
    }
  } catch {}
  return null;
}

/**
 * Check that the configured provider's credential works.
 * Returns { ok: true, note? } or { ok: false, error }. For Cursor, also returns
 * `model` when the configured cursorModel is unavailable and a Grok model was picked instead.
 */
export async function validateCredentials(provider, key) {
  const config = loadConfig();
  try {
    if (provider === "xai") {
      const ids = await grok.listModels({ apiKey: key ?? config.apiKey, apiBaseUrl: config.apiBaseUrl });
      if (ids.length && !ids.includes(config.model)) {
        return { ok: true, note: `模型 ${config.model} 不在列表中，可选: ${ids.slice(0, 8).join(", ")}` };
      }
      return { ok: true };
    }

    const sdk = await loadSdk();
    const models = await sdk.Cursor.models.list({ apiKey: key ?? (config.cursorApiKey || undefined) });
    const matches = (m) => m.id === config.cursorModel || m.aliases?.includes(config.cursorModel);
    if (models.some(matches)) return { ok: true };
    const grokModel = models.find((m) => /grok/i.test(`${m.id} ${m.displayName}`));
    if (!grokModel) {
      return { ok: false, error: "这个 Cursor 账号没有可用的 Grok 模型（grok-weixin models 查看全部）" };
    }
    return { ok: true, model: grokModel.id, note: `${config.cursorModel} 不可用，改用 ${grokModel.id}` };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
