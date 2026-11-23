#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createCursorBackend, loadSdk } from "./lib/backends/cursor.mjs";
import { createXaiBackend } from "./lib/backends/xai.mjs";
import { runBot } from "./lib/bot.mjs";
import { detectCredentials, validateCredentials } from "./lib/credentials.mjs";
import { loginWithQr } from "./lib/login.mjs";
import {
  DEFAULT_CONFIG,
  activePollerPid,
  clearAccount,
  loadAccount,
  loadConfig,
  saveAccount,
  saveConfig,
  stateDir,
} from "./lib/store.mjs";

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  emitWarning(warning, ...rest);
};

/** Exit code for "waiting on the user": re-run the same command to continue. */
const EXIT_PENDING = 2;
const MAX_KEY_ATTEMPTS = 3;

function log(msg) {
  console.log(`\x1b[36m[grok-weixin]\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m[grok-weixin]\x1b[0m ${msg}`);
}

function prompt(question, { secret = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) {
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
      else if (s.includes("\n")) rl.output.write("\n");
      else rl.output.write("*".repeat(s.length));
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── credentials ─────────────────────────────────────────────────────────────

async function cursorLogin() {
  const sdk = await loadSdk();
  log("正在打开浏览器登录 Cursor...");
  const result = await sdk.Cursor.auth.login({
    apiKeyName: "grok-weixin-cli",
    onLoginUrl: (url) => log(`如果浏览器没有自动打开，请访问：\n${url}`),
  });
  log(`✅ 已登录 Cursor${result.email ? ` (${result.email})` : ""}`);
}

async function askForCredentials() {
  console.log(`
  没有找到 Grok 凭据，请选择一种：
    1) Cursor API Key   在 https://cursor.com/dashboard/integrations 创建
    2) xAI API Key      在 https://console.x.ai 创建
    3) 浏览器登录 Cursor
`);
  for (;;) {
    const choice = await prompt("请输入 1 / 2 / 3: ");
    if (choice === "1") return { provider: "cursor", key: await prompt("粘贴 Cursor API Key: ", { secret: true }) };
    if (choice === "2") return { provider: "xai", key: await prompt("粘贴 xAI API Key: ", { secret: true }) };
    if (choice === "3") {
      await cursorLogin();
      return { provider: "cursor", key: undefined };
    }
  }
}

function saveCredential(provider, key) {
  const patch = { provider };
  if (key && provider === "cursor") patch.cursorApiKey = key;
  if (key && provider === "xai") patch.apiKey = key;
  saveConfig(patch);
}

/** Find, ask for, and validate credentials. Exits on failure. */
async function setupCredentials({ cursorKey, xaiKey, interactive }) {
  let candidate;
  if (cursorKey || xaiKey) {
    candidate = cursorKey
      ? { provider: "cursor", key: cursorKey, source: "--cursor-key" }
      : { provider: "xai", key: xaiKey, source: "--xai-key" };
  } else {
    const found = await detectCredentials();
    if (found) {
      log(`找到 ${found.provider === "xai" ? "xAI" : "Cursor"} 凭据（来源: ${found.source}）`);
      candidate = { provider: found.provider, key: undefined, source: found.source };
    }
  }

  for (let attempt = 1; ; attempt++) {
    if (!candidate) {
      if (!interactive) {
        console.log("CREDENTIALS=missing");
        error(
          "没有找到 Grok 凭据。请设置环境变量 CURSOR_API_KEY 或 XAI_API_KEY，" +
            "或用 --cursor-key / --xai-key 传入，然后重新运行。",
        );
        process.exit(1);
      }
      candidate = await askForCredentials();
    }

    log("正在验证凭据...");
    const result = await validateCredentials(candidate.provider, candidate.key);
    if (result.ok) {
      saveCredential(candidate.provider, candidate.key);
      if (result.model) saveConfig({ cursorModel: result.model });
      if (result.note) log(result.note);
      const cfg = loadConfig();
      log(`✅ 凭据有效，后端: ${candidate.provider === "xai" ? `xAI ${cfg.model}` : `Cursor ${cfg.cursorModel}`}`);
      console.log("CREDENTIALS=ok");
      return;
    }

    error(`凭据无效: ${result.error}`);
    if (!interactive || attempt >= MAX_KEY_ATTEMPTS) {
      console.log("CREDENTIALS=invalid");
      process.exit(1);
    }
    candidate = undefined;
  }
}

// ── WeChat login ────────────────────────────────────────────────────────────

/** Returns once an account is connected; exits with EXIT_PENDING when waiting on the user. */
async function connectWeixin({ interactive, verifyCode, waitSeconds, force }) {
  if (loadAccount() && !force) {
    log("已检测到本地微信凭据，跳过扫码（重新连接请运行 grok-weixin login）");
    console.log("WEIXIN=connected");
    return;
  }

  let result;
  try {
    result = await loginWithQr({ interactive, verifyCode, waitMs: waitSeconds * 1000 });
  } catch (err) {
    error(err.message);
    process.exit(1);
  }

  switch (result.status) {
    case "connected":
      saveAccount(result.account);
      log(`✅ 已将 Grok 连接到微信 (bot=${result.account.accountId})`);
      console.log("WEIXIN=connected");
      return;
    case "already_connected":
      if (loadAccount()) {
        log("✅ 此微信已连接过，沿用本地凭据。");
        console.log("WEIXIN=connected");
        return;
      }
      error("服务端提示已绑定，但本地没有凭据。请先运行 grok-weixin logout 后重新扫码。");
      process.exit(1);
    case "need_verify_code":
      error(
        result.retry
          ? "验证码不匹配。请用手机微信上显示的数字重新运行，并加上 --verify-code <数字>"
          : "手机微信上显示了一串数字。请重新运行同一条命令，并加上 --verify-code <数字>",
      );
      process.exit(EXIT_PENDING);
    case "timeout":
      error(
        result.scanned
          ? "已扫码，但还没在手机上确认。确认后重新运行同一条命令即可继续。"
          : "还没有扫码。扫码后重新运行同一条命令即可继续（5 分钟内二维码不变）。",
      );
      process.exit(EXIT_PENDING);
  }
}

// ── bot process ─────────────────────────────────────────────────────────────

async function createBackend(config) {
  if (config.provider === "grok-bot") {
    throw new Error("provider=grok-bot 不调用模型。请用 grok-weixin start 运行桥接，不要用 ask。");
  }
  if (config.provider === "xai") return createXaiBackend(config);
  if (config.provider === "cursor") return createCursorBackend(config);
  throw new Error(`未知 provider: ${config.provider}（可选: cursor, xai, grok-bot）`);
}

async function start() {
  const account = loadAccount();
  if (!account) {
    error("尚未连接微信，请先运行: grok-weixin install");
    process.exit(1);
  }
  const config = loadConfig();
  if (config.provider === "grok-bot") {
    const { runBridge } = await import("./lib/bridge/runtime.mjs");
    try {
      await runBridge({ dir: stateDir(), account, config, env: process.env, manageSignals: true });
    } catch (err) {
      error(err.message || "桥接启动失败");
      process.exit(1);
    }
    return;
  }
  let backend;
  try {
    backend = await createBackend(config);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
  await runBot({ account, config, backend });
}

async function startDaemon() {
  const running = activePollerPid();
  if (running) {
    log(`机器人已经在后台运行 (pid ${running})`);
    console.log(`BOT_PID=${running}`);
    return;
  }
  fs.mkdirSync(stateDir(), { recursive: true });
  const logPath = path.join(stateDir(), "bot.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();

  await new Promise((r) => setTimeout(r, 3000));
  if (activePollerPid() !== child.pid) {
    error(`机器人启动失败，请查看日志: ${logPath}`);
    process.exit(1);
  }
  log(`✅ 机器人已在后台运行 (pid ${child.pid})，日志: ${logPath}，停止: grok-weixin stop`);
  console.log(`BOT_PID=${child.pid}`);
  console.log(`BOT_LOG=${logPath}`);
}

function stop() {
  const pid = activePollerPid();
  if (!pid) {
    log("没有正在运行的机器人");
    return;
  }
  process.kill(pid, "SIGTERM");
  log(`已停止机器人 (pid ${pid})`);
}

// ── other commands ──────────────────────────────────────────────────────────

async function listModels() {
  if (loadConfig().provider === "grok-bot") {
    error("provider=grok-bot 没有模型列表。它只唤醒当前 Grok Bot，不调用 Cursor 或 xAI。");
    process.exit(1);
  }
  const config = loadConfig();
  const sdk = await loadSdk();
  const models = await sdk.Cursor.models.list({ apiKey: config.cursorApiKey || undefined });
  const grokModels = models.filter((m) => /grok/i.test(`${m.id} ${m.displayName}`));
  const shown = grokModels.length ? grokModels : models;
  if (!grokModels.length) log("没有找到 Grok 模型，以下是你的 Cursor 账号可用的全部模型：");
  for (const m of shown) console.log(`  ${m.id.padEnd(28)} ${m.displayName}`);
  console.log(`\n  切换模型: grok-weixin config cursorModel <id>`);
}

async function ask(text) {
  if (!text) {
    error('用法: grok-weixin ask "你好"');
    process.exit(1);
  }
  const backend = await createBackend(loadConfig());
  const userId = "cli-test";
  try {
    await backend.reset(userId);
    log(`正在询问 ${backend.label}...`);
    console.log(await backend.ask(userId, { text, images: [] }));
  } finally {
    await backend.reset(userId);
    await backend.close();
  }
}

async function status() {
  const account = loadAccount();
  const config = loadConfig();
  const pid = activePollerPid();
  console.log(`  状态目录: ${stateDir()}`);
  if (config.provider === "grok-bot") {
    const { bridgeSummary } = await import("./lib/bridge/queue.mjs");
    const summary = bridgeSummary(stateDir());
    console.log(`  微信:     ${account ? "已连接（标识已省略）" : "未连接"}`);
    console.log("  后端:     Grok Bot bridge（不调用 Cursor / xAI，不是官方微信渠道）");
    console.log(`  Bot 绑定: ${summary.botBinding || "未初始化"}`);
    console.log(`  群策略:   ${summary.groupPolicy}`);
    console.log(`  主人自动发送: ${summary.autoSend ? "已对本机授权" : "关闭"}`);
    console.log(`  确认发送: ${summary.confirmSend ? "已对本机授权" : "关闭"}`);
    console.log(`  Webhook:  ${summary.webhookConfigured ? "已配置" : "未配置"}`);
    console.log(`  待办:     ${summary.pending}`);
    console.log(`  允许用户: ${config.allowFrom.length ? "已填写明确列表" : "仅账号主人"}`);
    console.log(`  机器人:   ${pid ? `运行中 (pid ${pid})` : "未运行"}`);
    return;
  }
  console.log(`  微信:     ${account ? `已连接 (bot=${account.accountId}, 主人=${account.userId ?? "未知"})` : "未连接"}`);
  if (config.provider === "xai") {
    console.log(`  后端:     xAI API (${config.apiKey ? "Key 已配置" : "Key 未配置"})`);
    console.log(`  模型:     ${config.model}`);
  } else {
    let login = config.cursorApiKey ? "使用 API Key" : "未登录";
    try {
      const s = await (await loadSdk()).Cursor.auth.status();
      if (!config.cursorApiKey && s.status === "logged-in") login = `已登录 ${s.email ?? ""}`.trim();
    } catch {}
    console.log(`  后端:     Cursor 账号 (${login})`);
    console.log(`  模型:     ${config.cursorModel}`);
  }
  console.log(`  允许用户: ${config.allowFrom.length ? config.allowFrom.join(", ") : "仅账号主人"}`);
  console.log(`  机器人:   ${pid ? `运行中 (pid ${pid})` : "未运行"}`);
}

function configCmd(key, value) {
  if (!key) {
    const { apiKey, cursorApiKey, ...rest } = loadConfig();
    const mask = (v) => (v ? "***" : "");
    console.log(
      JSON.stringify({ ...rest, apiKey: mask(apiKey), cursorApiKey: mask(cursorApiKey) }, null, 2),
    );
    return;
  }
  if (!(key in DEFAULT_CONFIG)) {
    error(`未知配置项: ${key}（可选: ${Object.keys(DEFAULT_CONFIG).join(", ")}）`);
    process.exit(1);
  }
  if (value === undefined) {
    error(`用法: grok-weixin config ${key} <value>`);
    process.exit(1);
  }
  let parsed = value;
  if (key === "historyTurns") parsed = Number(value);
  if (key === "allowFrom") parsed = value.split(",").map((s) => s.trim()).filter(Boolean);
  saveConfig({ [key]: parsed });
  log(`已设置 ${key}`);
}

function help() {
  console.log(`
  用法: grok-weixin <命令> [选项]

  命令:
    install              查找/输入 Grok 凭据 → 验证 → 扫码绑定微信 → 启动机器人
    login                扫码连接（或重新连接）微信
    start                在前台启动机器人
    stop                 停止后台运行的机器人
    status               查看连接与配置状态
    mcp                  以旧版 MCP 服务器 (stdio) 运行，直接读微信并发消息
    bridge-init          初始化 Grok Bot 桥接（不自动发送，不打印令牌）
    bridge-authorize     仅对本状态目录授权主人自动发送或确认发送
    bridge-revoke        撤销本状态目录的发送授权
    bridge-resolve       关闭或在你确认微信未发出后允许再提交一次不确定的发送
    bridge-status        查看桥接授权、待办和 webhook 是否已配置（不打印密钥）
    bridge-mcp           以桥接 MCP 服务器 (stdio) 运行，只领取队列、不长轮询微信
    cursor-login         在浏览器中登录 Cursor 账号
    models               列出 Cursor 账号可用的 Grok 模型
    ask <text>           不经过微信，直接在终端问 Grok 一句话（测试后端）
    config [key] [value] 查看或修改配置 (${Object.keys(DEFAULT_CONFIG).join(", ")})
    logout               删除本地微信凭据与聊天记录

  install / login 选项:
    --cursor-key <key>   直接传入 Cursor API Key
    --xai-key <key>      直接传入 xAI API Key
    --non-interactive    不在终端提问（Grok Bot、脚本中使用）；没有终端时自动开启
    --verify-code <数字> 扫码时手机微信显示的数字验证码
    --wait <秒>          最多等待扫码多久，默认 480
    --daemon             绑定后在后台启动机器人（--non-interactive 时默认开启）
    --no-start           只完成绑定，不启动机器人
    --bot-binding <id>   bridge-init 使用的 Bot 绑定名（不是微信标识，也不是密钥）
    --scope <scope>      owner、confirm-send，撤销时还可以是 all
    --accept-unverified-direct
                         确认：缺失 group_id 不能证明是单聊，仍授权当前目录发送
    --rotate-token       重新生成桥接 MCP 令牌
    --outbound <id>      bridge-resolve 的出站任务
    --decision <close|allow-resend>
    --i-checked-wechat   确认微信里没有发出，才允许再提交一次

  退出码: 0 完成，1 出错，2 等待用户操作（扫码/验证码），重新运行同一条命令即可继续

  凭据查找顺序:
    CURSOR_API_KEY → CURSOR_API_KEY_FILE → CURSOR_SERVICE_ACCOUNT_KEY → XAI_API_KEY
    → ~/.grok-weixin/config.json → cursor-login 保存的登录

  其他环境变量:
    GROK_WEIXIN_PROVIDER  临时切换后端 (cursor / xai / grok-bot)
    GROK_WEIXIN_STATE_DIR 状态目录，默认 ~/.grok-weixin
    GROK_WEIXIN_ROUTINE_WEBHOOK_URL / GROK_WEIXIN_ROUTINE_WEBHOOK_TOKEN
                          只在 grok-bot 进程环境里提供，不要写进仓库或命令行
`);
}

async function runBridgeCommand(command, flags) {
  const dir = stateDir();
  if (command === "bridge-status") {
    const { bridgeSummary } = await import("./lib/bridge/queue.mjs");
    console.log(JSON.stringify({ provider: loadConfig().provider, ...bridgeSummary(dir) }, null, 2));
    return;
  }
  if (command === "bridge-mcp") {
    const { runBridgeMcp } = await import("./lib/bridge/tools.mjs");
    await runBridgeMcp({ dir });
    return;
  }
  if (command === "bridge-init") {
    const { assertBotBinding } = await import("./lib/bridge/policy.mjs");
    const { initBridge } = await import("./lib/bridge/queue.mjs");
    let binding;
    try {
      binding = assertBotBinding(flags["bot-binding"] || "");
    } catch (err) {
      error(err.message);
      process.exit(1);
    }
    try {
      const result = initBridge(dir, binding, { rotateToken: Boolean(flags["rotate-token"]) });
      log(`桥接已初始化。binding=${result.botBinding}`);
      log(`MCP 令牌文件（权限 600，命令不会打印令牌）: ${result.tokenFile}`);
      if (result.created) log("令牌已写入该文件。请在本机读取后配置到当前 Bot，不要贴进聊天、仓库或微信。");
      else log("沿用已有令牌。若要更换，请加 --rotate-token，并同步更新 Bot 侧配置。");
      log("自动发送仍关闭。说明文档里的历史许可不会对这个状态目录生效。");
    } catch (err) {
      error(err.message);
      process.exit(1);
    }
    return;
  }
  if (command === "bridge-authorize") {
    const scope = flags.scope;
    if (scope !== "owner" && scope !== "confirm-send") {
      error("scope 只能是 owner 或 confirm-send。不接受 *。");
      process.exit(1);
    }
    if (!flags["accept-unverified-direct"]) {
      error("公开的 iLink 说明只把 group_id 记为客户端类型中的可选字段。字段缺失不能证明是单聊。");
      error("自动发送保持关闭。若仍要授权当前这一个状态目录，请同时传入 --accept-unverified-direct。");
      error("带有 group_id 的消息仍会被拒绝。附件、旧配置或历史许可都不会自动生效。");
      process.exit(1);
    }
    const { authorizeConfirm, authorizeOwnerAuto } = await import("./lib/bridge/queue.mjs");
    try {
      if (scope === "owner") authorizeOwnerAuto(dir);
      else authorizeConfirm(dir);
    } catch (err) {
      error(err.message);
      process.exit(1);
    }
    log(`已为当前状态目录授权 ${scope}。范围只包括这一目录里、通过白名单且未被识别为群的会话。`);
    return;
  }
  if (command === "bridge-revoke") {
    const { revokeGrant } = await import("./lib/bridge/queue.mjs");
    try {
      revokeGrant(dir, flags.scope || "all");
    } catch (err) {
      error(err.message);
      process.exit(1);
    }
    log(`已撤销 ${flags.scope || "all"}。`);
    return;
  }
  if (command === "bridge-resolve") {
    if (flags.decision !== "close" && flags.decision !== "allow-resend") {
      error("decision 只能是 close 或 allow-resend。");
      process.exit(1);
    }
    if (flags.decision === "allow-resend" && !flags["i-checked-wechat"]) {
      error("结果不确定时不能直接重发。请先在微信里确认没有发出，再加 --i-checked-wechat。");
      process.exit(1);
    }
    if (!flags.outbound) {
      error("请传入 --outbound <id>。");
      process.exit(1);
    }
    const { resolveOutbound } = await import("./lib/bridge/queue.mjs");
    const result = await resolveOutbound(dir, flags.outbound, flags.decision, Date.now());
    if (!result.ok) {
      error(`无法处理: ${result.error || "unknown"}`);
      process.exit(1);
    }
    log(flags.decision === "close" ? "已关闭该出站，不会重发。" : "已允许再次领取原入站。桥接不会自动重发。");
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

function parseFlags() {
  try {
    return parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        "cursor-key": { type: "string" },
        "xai-key": { type: "string" },
        "non-interactive": { type: "boolean", default: false },
        "verify-code": { type: "string" },
        wait: { type: "string", default: "480" },
        daemon: { type: "boolean", default: false },
        "no-start": { type: "boolean", default: false },
        "bot-binding": { type: "string" },
        scope: { type: "string" },
        "accept-unverified-direct": { type: "boolean", default: false },
        "rotate-token": { type: "boolean", default: false },
        outbound: { type: "string" },
        decision: { type: "string" },
        "i-checked-wechat": { type: "boolean", default: false },
      },
    }).values;
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}

switch (command) {
  case "install":
  case "login": {
    const flags = parseFlags();
    const interactive = !flags["non-interactive"] && Boolean(process.stdin.isTTY);
    const waitSeconds = Math.max(10, Number(flags.wait) || 480);
    if (command === "install") {
      if (loadConfig().provider === "grok-bot") {
        log("provider=grok-bot：跳过 Cursor/xAI 凭据。桥接不调用模型，这次安装也不会打开自动发送。");
      } else {
        await setupCredentials({ cursorKey: flags["cursor-key"], xaiKey: flags["xai-key"], interactive });
      }
    }
    await connectWeixin({
      interactive,
      verifyCode: flags["verify-code"],
      waitSeconds,
      force: command === "login",
    });
    if (command === "install" && !flags["no-start"]) {
      if (flags.daemon || !interactive) await startDaemon();
      else await start();
    }
    break;
  }
  case "start":
    await start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    await status();
    break;
  case "mcp": {
    const { runMcpServer } = await import("./lib/mcp.mjs");
    await runMcpServer();
    break;
  }
  case "bridge-init":
  case "bridge-authorize":
  case "bridge-revoke":
  case "bridge-resolve":
  case "bridge-status":
  case "bridge-mcp":
    await runBridgeCommand(command, parseFlags());
    break;
  case "cursor-login":
    try {
      await cursorLogin();
    } catch (err) {
      error(`Cursor 登录失败: ${err.message}`);
      process.exit(1);
    }
    break;
  case "models":
  case "ask":
    try {
      if (command === "models") await listModels();
      else await ask(rest.join(" "));
    } catch (err) {
      error(err.message);
      process.exit(1);
    }
    break;
  case "config":
    configCmd(...rest);
    break;
  case "logout":
    clearAccount();
    log("已删除本地微信凭据与聊天记录");
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    if (command) error(`未知命令: ${command}`);
    help();
    process.exit(command ? 1 : 0);
}
