// Grok through your Cursor account via @cursor/sdk. One local Cursor agent per WeChat user
// keeps the conversation; tools are limited to web search/fetch so chat messages can never
// reach your shell or files.

import { cursorWorkspaceDir, loadCursorAgentIds, saveCursorAgentIds } from "../store.mjs";

const TOOLS = ["webSearch", "webFetch"];

function wechatInstructions(systemPrompt) {
  return [
    systemPrompt,
    "你正在通过微信与用户对话：回复会以纯文本发到手机上。",
    "你只能使用网页搜索和网页抓取工具；需要实时信息时再搜索。不要尝试读写文件或运行命令。",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function loadSdk() {
  try {
    return await import("@cursor/sdk");
  } catch {
    throw new Error("缺少依赖 @cursor/sdk，请在项目目录运行 npm install");
  }
}

export async function createCursorBackend(config) {
  const sdk = await loadSdk();
  const apiKey = config.cursorApiKey || undefined;
  if (!apiKey && (await sdk.Cursor.auth.status()).status !== "logged-in") {
    throw new Error(
      "尚未登录 Cursor，请运行 grok-weixin cursor-login，或 grok-weixin config cursorApiKey <key>",
    );
  }

  const agentOptions = {
    apiKey,
    model: { id: config.cursorModel },
    tools: TOOLS,
    local: { cwd: cursorWorkspaceDir(), settingSources: [] },
  };
  const agentIds = loadCursorAgentIds();
  const agents = new Map();

  const getAgent = async (userId) => {
    if (agents.has(userId)) return { agent: agents.get(userId), fresh: false };
    const savedId = agentIds[userId];
    if (savedId) {
      try {
        const agent = await sdk.Agent.resume(savedId, agentOptions);
        agents.set(userId, agent);
        return { agent, fresh: false };
      } catch (err) {
        if (!(err instanceof sdk.AgentNotFoundError)) throw err;
      }
    }
    const agent = await sdk.Agent.create({ ...agentOptions, name: `WeChat ${userId}` });
    agents.set(userId, agent);
    agentIds[userId] = agent.agentId;
    saveCursorAgentIds(agentIds);
    return { agent, fresh: true };
  };

  const dispose = async (userId) => {
    const agent = agents.get(userId);
    agents.delete(userId);
    await agent?.[Symbol.asyncDispose]?.().catch(() => {});
  };

  return {
    label: `Cursor ${config.cursorModel}`,

    async ask(userId, { text, images }) {
      let agent, fresh;
      try {
        ({ agent, fresh } = await getAgent(userId));
      } catch (err) {
        if (err instanceof sdk.AuthenticationError) {
          throw new Error(
            apiKey
              ? "Cursor API Key 无效或已过期，请检查 cursorApiKey / CURSOR_API_KEY"
              : "Cursor 登录已失效，请重新运行 grok-weixin cursor-login",
          );
        }
        throw err;
      }

      const body = text || (images.length ? "请描述这张图片。" : "");
      const prompt = fresh ? `${wechatInstructions(config.systemPrompt)}\n\n用户消息：\n${body}` : body;
      const run = await agent.send({
        text: prompt,
        ...(images.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
      });
      const result = await run.wait();
      if (result.status !== "finished") {
        throw new Error(result.error?.message ?? `Cursor run ${result.status}`);
      }
      return result.result ?? "";
    },

    async reset(userId) {
      await dispose(userId);
      delete agentIds[userId];
      saveCursorAgentIds(agentIds);
    },

    async close() {
      await Promise.all([...agents.keys()].map(dispose));
    },
  };
}
