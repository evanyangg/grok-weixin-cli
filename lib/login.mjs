// QR-code login, ported from @tencent-weixin/openclaw-weixin (src/auth/login-qr.ts).

import { DEFAULT_BASE_URL, apiGet, apiPost } from "./ilink.mjs";
import { loadAccount } from "./store.mjs";

const BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 480_000;
const MAX_QR_REFRESH_COUNT = 3;

export async function fetchQRCode() {
  const existing = loadAccount();
  const raw = await apiPost({
    baseUrl: DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    body: { local_token_list: existing?.token ? [existing.token] : [] },
    timeoutMs: 15_000,
    label: "fetchQRCode",
  });
  return JSON.parse(raw);
}

export async function pollQRStatus(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const raw = await apiGet({
      baseUrl,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    return JSON.parse(raw);
  } catch {
    // Long-poll timeouts and gateway errors (e.g. 524) just mean "keep waiting".
    return { status: "wait" };
  }
}

async function displayQRCode(url) {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(url, { small: true });
  } catch {}
  process.stdout.write(`若二维码未能显示或无法使用，请访问以下链接：\n${url}\n`);
}

function readLine(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

/**
 * Interactive QR login. Resolves with { accountId, token, baseUrl, userId }
 * on success, { alreadyConnected: true } when this bot is already bound, or throws.
 */
export async function loginWithQr() {
  let qr = await fetchQRCode();
  process.stdout.write("用手机微信扫描以下二维码，以连接 Grok：\n");
  await displayQRCode(qr.qrcode_img_content);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let pollBaseUrl = DEFAULT_BASE_URL;
  let refreshCount = 1;
  let scannedPrinted = false;
  let pendingVerifyCode;

  const refresh = async () => {
    refreshCount++;
    if (refreshCount > MAX_QR_REFRESH_COUNT) {
      throw new Error("二维码多次失效，连接流程已停止，请稍后再试。");
    }
    process.stdout.write(`\n⏳ 正在刷新二维码...(${refreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
    qr = await fetchQRCode();
    scannedPrinted = false;
    await displayQRCode(qr.qrcode_img_content);
  };

  while (Date.now() < deadline) {
    const status = await pollQRStatus(pollBaseUrl, qr.qrcode, pendingVerifyCode);

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        pendingVerifyCode = undefined;
        if (!scannedPrinted) {
          process.stdout.write("\n已扫码，正在验证...\n");
          scannedPrinted = true;
        }
        break;
      case "need_verifycode":
        pendingVerifyCode = await readLine(
          pendingVerifyCode
            ? "❌ 你输入的数字不匹配，请重新输入："
            : "输入手机微信显示的数字，以继续连接：",
        );
        continue;
      case "verify_code_blocked":
        process.stdout.write("\n⛔ 多次输入错误。\n");
        pendingVerifyCode = undefined;
        await refresh();
        break;
      case "expired":
        process.stdout.write("\n⏳ 二维码已过期。\n");
        await refresh();
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) pollBaseUrl = `https://${status.redirect_host}`;
        break;
      case "binded_redirect":
        return { alreadyConnected: true };
      case "confirmed":
        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error("登录失败：服务器未返回 ilink_bot_id / bot_token。");
        }
        return {
          accountId: status.ilink_bot_id,
          token: status.bot_token,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          userId: status.ilink_user_id,
        };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("登录超时，请重试。");
}
