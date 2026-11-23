// QR-code login, ported from @tencent-weixin/openclaw-weixin (src/auth/login-qr.ts).
// The QR session is persisted (pending-login.json) so a login can span several runs:
// `install --non-interactive` can time out, then be re-run (optionally with --verify-code)
// against the same QR code.

import QRCode from "qrcode";

import { DEFAULT_BASE_URL, apiGet, apiPost } from "./ilink.mjs";
import {
  clearPendingLogin,
  loadAccount,
  loadPendingLogin,
  loginQrPngPath,
  savePendingLogin,
} from "./store.mjs";

const BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_TTL_MS = 5 * 60_000;
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

export async function pollQRStatus(baseUrl, qrcode, verifyCode, timeoutMs = QR_LONG_POLL_TIMEOUT_MS) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const raw = await apiGet({
      baseUrl,
      endpoint,
      timeoutMs: Math.min(timeoutMs, QR_LONG_POLL_TIMEOUT_MS),
      label: "pollQRStatus",
    });
    return JSON.parse(raw);
  } catch {
    // Long-poll timeouts and gateway errors (e.g. 524) just mean "keep waiting".
    return { status: "wait" };
  }
}

export function isPendingLoginFresh(pending) {
  return Boolean(pending) && Date.now() - pending.startedAt < QR_TTL_MS;
}

/** Fetch a new QR code, persist it as the pending login, and write the PNG. */
export async function startPendingLogin() {
  const qr = await fetchQRCode();
  const pending = {
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    pollBaseUrl: DEFAULT_BASE_URL,
    startedAt: Date.now(),
  };
  savePendingLogin(pending);
  await QRCode.toFile(loginQrPngPath(), pending.qrcodeUrl, { width: 360, margin: 2 });
  return pending;
}

async function displayQRCode(pending) {
  const qrterm = await import("qrcode-terminal");
  qrterm.default.generate(pending.qrcodeUrl, { small: true });
  process.stdout.write(
    [
      "用手机微信扫描上面的二维码（5 分钟内有效）。二维码无法显示时可以打开图片或链接：",
      `QR_PNG=${loginQrPngPath()}`,
      `QR_URL=${pending.qrcodeUrl}`,
      "",
    ].join("\n"),
  );
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
 * QR login. Reuses a fresh pending QR code from an earlier run.
 *
 * Resolves with one of:
 *   { status: "connected", account }
 *   { status: "already_connected" }
 *   { status: "need_verify_code", retry: boolean }   (non-interactive only)
 *   { status: "timeout", scanned: boolean }          (pending QR kept for the next run)
 * Throws on unrecoverable failures.
 */
export async function loginWithQr({ interactive = true, verifyCode, waitMs = 480_000 } = {}) {
  let pending = loadPendingLogin();
  if (isPendingLoginFresh(pending)) {
    process.stdout.write("继续使用上次生成、仍然有效的二维码。\n");
  } else {
    pending = await startPendingLogin();
  }
  await displayQRCode(pending);

  const deadline = Date.now() + waitMs;
  let refreshCount = 1;
  let scanned = false;
  let code = verifyCode;
  let codeTried = false;

  const refresh = async () => {
    refreshCount++;
    if (refreshCount > MAX_QR_REFRESH_COUNT) {
      clearPendingLogin();
      throw new Error("二维码多次失效，连接流程已停止，请稍后再试。");
    }
    process.stdout.write(`\n⏳ 正在刷新二维码...(${refreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
    pending = await startPendingLogin();
    scanned = false;
    process.stdout.write("STATUS=qr_refreshed\n");
    await displayQRCode(pending);
  };

  while (Date.now() < deadline) {
    const status = await pollQRStatus(
      pending.pollBaseUrl,
      pending.qrcode,
      code,
      Math.max(1000, deadline - Date.now()),
    );

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        code = undefined;
        if (!scanned) {
          process.stdout.write("\n已扫码，等待在手机上确认...\nSTATUS=scanned\n");
          scanned = true;
        }
        break;
      case "need_verifycode": {
        const retry = codeTried;
        if (code && !codeTried) {
          codeTried = true;
          continue;
        }
        if (!interactive) {
          process.stdout.write("STATUS=need_verify_code\n");
          return { status: "need_verify_code", retry };
        }
        code = await readLine(
          retry ? "❌ 你输入的数字不匹配，请重新输入：" : "输入手机微信显示的数字，以继续连接：",
        );
        codeTried = true;
        continue;
      }
      case "verify_code_blocked":
        process.stdout.write("\n⛔ 验证码多次输入错误。\n");
        code = undefined;
        codeTried = false;
        await refresh();
        break;
      case "expired":
        process.stdout.write("\n⏳ 二维码已过期。\n");
        await refresh();
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          pending.pollBaseUrl = `https://${status.redirect_host}`;
          savePendingLogin(pending);
        }
        break;
      case "binded_redirect":
        clearPendingLogin();
        return { status: "already_connected" };
      case "confirmed":
        clearPendingLogin();
        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error("登录失败：服务器未返回 ilink_bot_id / bot_token。");
        }
        return {
          status: "connected",
          account: {
            accountId: status.ilink_bot_id,
            token: status.bot_token,
            baseUrl: status.baseurl || DEFAULT_BASE_URL,
            userId: status.ilink_user_id,
          },
        };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("STATUS=timeout\n");
  return { status: "timeout", scanned };
}
