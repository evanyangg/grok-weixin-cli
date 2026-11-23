// WeChat <-> Grok bridge: long-poll getUpdates, ask the backend, reply via sendMessage.

import {
  MessageItemType,
  MessageType,
  STALE_TOKEN_ERRCODE,
  TypingStatus,
  getConfig,
  getUpdates,
  notifyStart,
  notifyStop,
  sendTyping,
} from "./ilink.mjs";
import {
  buildUserInput,
  createSenderFilter,
  itemText,
  sendReply,
  toPlainText,
} from "./messages.mjs";
import {
  activePollerPid,
  loadContextTokens,
  loadSyncBuf,
  markPoller,
  saveContextTokens,
  saveSyncBuf,
  unmarkPoller,
} from "./store.mjs";

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const TYPING_KEEPALIVE_MS = 5_000;

function ts() {
  return new Date().toLocaleTimeString();
}

function log(msg) {
  console.log(`\x1b[90m${ts()}\x1b[0m ${msg}`);
}

function logError(msg) {
  console.error(`\x1b[90m${ts()}\x1b[0m \x1b[31m${msg}\x1b[0m`);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runBot({ account, config, backend }) {
  const { token, accountId } = account;
  const baseUrl = account.baseUrl;
  const abort = new AbortController();

  const otherPid = activePollerPid();
  if (otherPid) {
    logError(`已有另一个 grok-weixin start 进程 (pid ${otherPid}) 在接收这个微信账号的消息，请先停止它。`);
    process.exit(1);
  }
  markPoller();
  process.on("exit", unmarkPoller);

  const isAllowed = createSenderFilter(config, account);
  if (!account.userId && !config.allowFrom.length) {
    logError("未知账号主人 userId，将拒绝所有消息。请在 config.json 设置 allowFrom。");
  }

  const contextTokens = loadContextTokens();
  const typingTickets = new Map();
  const userQueues = new Map();

  const shutdown = async () => {
    if (abort.signal.aborted) return;
    log("正在停止...");
    abort.abort();
    try {
      await notifyStop({ baseUrl, token });
    } catch {}
    await backend.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await notifyStart({ baseUrl, token });
  } catch (err) {
    logError(`notifyStart 失败（忽略）: ${err.message}`);
  }

  log(`\x1b[32m已连接微信\x1b[0m bot=${accountId}  后端=${backend.label}`);
  log("在微信里给机器人发消息即可与 Grok 对话。发送 /reset 清空上下文，Ctrl+C 退出。");

  const reply = (to, text) => sendReply({ account, to, text, contextToken: contextTokens[to] });

  const getTypingTicket = async (userId) => {
    if (typingTickets.has(userId)) return typingTickets.get(userId);
    let ticket = "";
    try {
      const resp = await getConfig({ baseUrl, token, userId, contextToken: contextTokens[userId] });
      if (resp.ret === 0) ticket = resp.typing_ticket ?? "";
    } catch {}
    typingTickets.set(userId, ticket);
    return ticket;
  };

  const startTyping = async (userId) => {
    const typingTicket = await getTypingTicket(userId);
    if (!typingTicket) return () => {};
    const send = (status) =>
      sendTyping({ baseUrl, token, userId, typingTicket, status }).catch(() => {});
    send(TypingStatus.TYPING);
    const timer = setInterval(() => send(TypingStatus.TYPING), TYPING_KEEPALIVE_MS);
    return () => {
      clearInterval(timer);
      send(TypingStatus.CANCEL);
    };
  };

  const handleCommand = async (from, text) => {
    const [cmd] = text.trim().split(/\s+/);
    switch (cmd) {
      case "/reset":
      case "/clear":
        await backend.reset(from);
        await reply(from, "已清空对话上下文。");
        return true;
      case "/model":
        await reply(from, `当前模型: ${backend.label}`);
        return true;
      case "/help":
        await reply(from, "/reset 清空上下文\n/model 查看当前模型\n/help 显示帮助");
        return true;
    }
    return false;
  };

  const handleMessage = async (msg) => {
    const from = msg.from_user_id;
    const firstText = itemText(msg.item_list?.find((i) => i.type === MessageItemType.TEXT));
    if (firstText.startsWith("/") && (await handleCommand(from, firstText))) return;

    const input = await buildUserInput(msg, { onError: logError });
    if (!input.text && !input.images.length) return;
    const preview = [input.text, input.images.length ? `[图片 x${input.images.length}]` : ""]
      .filter(Boolean)
      .join(" ");
    log(`\x1b[36m← ${from}\x1b[0m ${preview.slice(0, 80).replace(/\n/g, " ")}`);

    const stopTyping = await startTyping(from);
    let answer;
    try {
      answer = await backend.ask(from, input);
    } catch (err) {
      logError(err.message);
      await reply(from, `抱歉，Grok 请求失败：${err.message.slice(0, 200)}`);
      return;
    } finally {
      stopTyping();
    }

    const text = toPlainText(answer) || "（Grok 没有返回内容）";
    await reply(from, text);
    log(`\x1b[35m→ ${from}\x1b[0m ${text.slice(0, 80).replace(/\n/g, " ")}`);
  };

  const enqueue = (userId, task) => {
    const prev = userQueues.get(userId) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => logError(`处理消息失败: ${err?.stack ?? err}`))
      .finally(() => {
        if (userQueues.get(userId) === next) userQueues.delete(userId);
      });
    userQueues.set(userId, next);
  };

  let getUpdatesBuf = loadSyncBuf();
  let timeoutMs;
  let failures = 0;

  while (!abort.signal.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        getUpdatesBuf,
        timeoutMs,
        abortSignal: abort.signal,
      });
      if (resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;

      const isError = (resp.ret ?? 0) !== 0 || (resp.errcode ?? 0) !== 0;
      if (isError) {
        if (resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE) {
          logError("微信登录已失效，请重新运行: grok-weixin login");
          process.exit(1);
        }
        throw new Error(`getUpdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ""}`);
      }
      failures = 0;

      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        saveSyncBuf(getUpdatesBuf);
      }

      for (const msg of resp.msgs ?? []) {
        const from = msg.from_user_id;
        if (!from || msg.message_type === MessageType.BOT) continue;
        if (!isAllowed(from)) {
          log(`忽略未授权用户的消息: ${from}`);
          continue;
        }
        if (msg.context_token && contextTokens[from] !== msg.context_token) {
          contextTokens[from] = msg.context_token;
          saveContextTokens(contextTokens);
        }
        enqueue(from, () => handleMessage(msg));
      }
    } catch (err) {
      if (abort.signal.aborted) break;
      failures++;
      logError(`${err.message} (${failures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        failures = 0;
        await sleep(BACKOFF_DELAY_MS, abort.signal);
      } else {
        await sleep(RETRY_DELAY_MS, abort.signal);
      }
    }
  }
}
