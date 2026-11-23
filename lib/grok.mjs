// xAI Grok chat completions (OpenAI-compatible): https://docs.x.ai/docs/api-reference

const REQUEST_TIMEOUT_MS = 180_000;

/**
 * @param {object} params
 * @param {Array<{role: string, content: unknown}>} params.messages
 * @returns {Promise<string>} assistant reply text
 */
export async function chat({ apiKey, apiBaseUrl, model, messages }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Grok API ${res.status}: ${text.slice(0, 500)}`);
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("Grok API 请求超时");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
