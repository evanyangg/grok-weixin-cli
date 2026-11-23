#!/usr/bin/env node

import readline from "node:readline/promises";

import { createCursorBackend, loadSdk } from "./lib/backends/cursor.mjs";
import { createXaiBackend } from "./lib/backends/xai.mjs";
import { runBot } from "./lib/bot.mjs";
import { loginWithQr } from "./lib/login.mjs";
import {
  DEFAULT_CONFIG,
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

function log(msg) {
  console.log(`\x1b[36m[grok-weixin]\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m[grok-weixin]\x1b[0m ${msg}`);
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function ensureXaiApiKey() {
  if (loadConfig().apiKey) return;
  log("未配置 xAI API Key（可在 https://console.x.ai 获取）");
  const key = await prompt("请输入 XAI_API_KEY: ");
  if (!key) {
    error("未输入 API Key，已退出。也可以通过环境变量 XAI_API_KEY 提供。");
    process.exit(1);
  }
  saveConfig({ apiKey: key });
  log("API Key 已保存");
}

async function cursorLogin() {
  const sdk = await loadSdk();
  log("正在打开浏览器登录 Cursor...");
  try {
    const result = await sdk.Cursor.auth.login({
      apiKeyName: "grok-weixin-cli",
      onLoginUrl: (url) => log(`如果浏览器没有自动打开，请访问：\n${url}`),
    });
    log(`✅ 已登录 Cursor${result.email ? ` (${result.email})` : ""}`);
  } catch (err) {
    error(`Cursor 登录失败: ${err.message}`);
    process.exit(1);
  }
}

async function ensureCursorLogin() {
  if (loadConfig().cursorApiKey) return;
  const sdk = await loadSdk();
  if ((await sdk.Cursor.auth.status()).status === "logged-in") return;
  log("需要 Cursor 凭据（API Key 在 https://cursor.com/dashboard/integrations 创建）");
  const key = await prompt("粘贴 Cursor API Key，或直接回车改用浏览器登录: ");
  if (key) {
    saveConfig({ cursorApiKey: key });
    log("Cursor API Key 已保存");
  } else {
    await cursorLogin();
  }
}

async function listModels() {
  await ensureCursorLogin();
  const sdk = await loadSdk();
  const models = await sdk.Cursor.models.list({ apiKey: loadConfig().cursorApiKey || undefined });
  const grokModels = models.filter((m) => /grok/i.test(`${m.id} ${m.displayName}`));
  const shown = grokModels.length ? grokModels : models;
  if (!grokModels.length) log("没有找到 Grok 模型，以下是你的 Cursor 账号可用的全部模型：");
  for (const m of shown) console.log(`  ${m.id.padEnd(28)} ${m.displayName}`);
  console.log(`\n  切换模型: grok-weixin config cursorModel <id>`);
}

async function createBackend(config) {
  if (config.provider === "xai") return createXaiBackend(config);
  if (config.provider === "cursor") return createCursorBackend(config);
  throw new Error(`未知 provider: ${config.provider}（可选: cursor, xai）`);
}

async function login() {
  try {
    const result = await loginWithQr();
    if (result.alreadyConnected) {
      if (loadAccount()) {
        log("✅ 此微信已连接过，沿用本地凭据。");
        return;
      }
      error("服务端提示已绑定，但本地没有凭据。请先运行 `grok-weixin logout` 后重新扫码。");
      process.exit(1);
    }
    saveAccount(result);
    log(`✅ 已将 Grok 连接到微信 (bot=${result.accountId})`);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}

async function start() {
  const account = loadAccount();
  if (!account) {
    error("尚未连接微信，请先运行: grok-weixin login");
    process.exit(1);
  }
  const config = loadConfig();
  let backend;
  try {
    backend = await createBackend(config);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
  await runBot({ account, config, backend });
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

async function install() {
  const { provider } = loadConfig();
  if (provider === "xai") await ensureXaiApiKey();
  else await ensureCursorLogin();
  if (!loadAccount()) {
    await login();
  } else {
    log("已检测到本地微信凭据，跳过扫码（如需重新连接请运行 `grok-weixin login`）");
  }
  await start();
}

async function status() {
  const account = loadAccount();
  const config = loadConfig();
  console.log(`  状态目录: ${stateDir()}`);
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
  用法: grok-weixin <命令>

  命令:
    install              登录 Cursor（或配置 xAI Key）→ 扫码连接微信 → 启动机器人
    login                扫码连接（或重新连接）微信
    start                启动机器人，把微信消息转发给 Grok
    cursor-login         在浏览器中登录 Cursor 账号
    models               列出 Cursor 账号可用的 Grok 模型
    ask <text>           不经过微信，直接在终端问 Grok 一句话（测试后端）
    mcp                  以 MCP 服务器 (stdio) 运行，给 Grok Bot 等 MCP 客户端提供微信工具
    status               查看连接与配置状态
    config [key] [value] 查看或修改配置 (${Object.keys(DEFAULT_CONFIG).join(", ")})
    logout               删除本地微信凭据与聊天记录
    help                 显示帮助

  后端 (config provider):
    cursor（默认）       用 Cursor 账号额度调用 Grok，支持联网搜索
    xai                  用 xAI API Key 直接调用 Grok

  环境变量:
    CURSOR_API_KEY       Cursor API Key（优先于 config cursorApiKey，可代替 cursor-login）
    XAI_API_KEY          xAI API Key（provider=xai 时使用）
    GROK_WEIXIN_PROVIDER 临时切换后端 (cursor / xai)
    GROK_WEIXIN_STATE_DIR 状态目录，默认 ~/.grok-weixin
`);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "install":
    await install();
    break;
  case "login":
    await login();
    break;
  case "start":
    await start();
    break;
  case "status":
    await status();
    break;
  case "mcp": {
    const { runMcpServer } = await import("./lib/mcp.mjs");
    await runMcpServer();
    break;
  }
  case "cursor-login":
    await cursorLogin();
    break;
  case "models":
  case "ask":
    try {
      if (command === "models") await listModels();
      else await ask(args.join(" "));
    } catch (err) {
      error(err.message);
      process.exit(1);
    }
    break;
  case "config":
    configCmd(...args);
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
