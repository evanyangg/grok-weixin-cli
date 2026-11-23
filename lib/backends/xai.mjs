// Grok via the xAI API key; conversation history is kept locally.

import * as grok from "../grok.mjs";
import { clearHistory, loadHistory, saveHistory } from "../store.mjs";

export function createXaiBackend(config) {
  if (!config.apiKey) {
    throw new Error(
      "未配置 xAI API Key，请运行 `grok-weixin config apiKey <key>` 或设置 XAI_API_KEY",
    );
  }

  return {
    label: `xAI ${config.model}`,

    async ask(userId, { text, images }) {
      const historyText = [text, images.length ? `[图片 x${images.length}]` : ""]
        .filter(Boolean)
        .join("\n");
      const content = images.length
        ? [
            ...images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: "high" },
            })),
            { type: "text", text: text || "请描述这张图片。" },
          ]
        : text;

      const history = loadHistory(userId);
      const answer = await grok.chat({
        apiKey: config.apiKey,
        apiBaseUrl: config.apiBaseUrl,
        model: config.model,
        messages: [
          ...(config.systemPrompt ? [{ role: "system", content: config.systemPrompt }] : []),
          ...history,
          { role: "user", content },
        ],
      });

      const updated = [
        ...history,
        { role: "user", content: historyText },
        { role: "assistant", content: answer },
      ];
      saveHistory(userId, updated.slice(-config.historyTurns * 2));
      return answer;
    },

    async reset(userId) {
      clearHistory(userId);
    },

    async close() {},
  };
}
