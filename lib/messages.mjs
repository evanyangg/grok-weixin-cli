// Shared helpers for turning WeixinMessages into text/images and Grok replies into WeChat text.

import { MessageItemType, sendText } from "./ilink.mjs";
import { StreamingMarkdownFilter } from "./markdown-filter.mjs";
import { downloadImage } from "./media.mjs";

const MAX_REPLY_CHUNK = 2000;

export function itemText(item) {
  if (item?.type === MessageItemType.TEXT) return item.text_item?.text ?? "";
  if (item?.type === MessageItemType.VOICE) return item.voice_item?.text ?? "";
  return "";
}

function quotedText(msg) {
  const ref = msg.item_list?.find((i) => i.ref_msg)?.ref_msg;
  if (!ref) return "";
  return [ref.title?.trim(), itemText(ref.message_item)].filter(Boolean).join(" | ");
}

/** Extract { text, images: [{ mimeType, data }] } from a WeixinMessage. */
export async function buildUserInput(msg, { onError } = {}) {
  const texts = [];
  const images = [];
  const unsupported = [];

  for (const item of msg.item_list ?? []) {
    switch (item.type) {
      case MessageItemType.TEXT:
        if (item.text_item?.text) texts.push(item.text_item.text);
        break;
      case MessageItemType.VOICE:
        if (item.voice_item?.text) texts.push(item.voice_item.text);
        else unsupported.push("语音");
        break;
      case MessageItemType.IMAGE:
        try {
          const image = await downloadImage(item.image_item);
          if (image) images.push(image);
        } catch (err) {
          onError?.(`图片下载失败: ${err.message}`);
          unsupported.push("图片(下载失败)");
        }
        break;
      case MessageItemType.VIDEO:
        unsupported.push("视频");
        break;
      case MessageItemType.FILE:
        unsupported.push(`文件 ${item.file_item?.file_name ?? ""}`.trim());
        break;
    }
  }

  const quote = quotedText(msg);
  if (quote) texts.unshift(`[引用: ${quote}]`);
  if (unsupported.length) texts.push(`[用户发送了暂不支持的内容: ${unsupported.join(", ")}]`);

  return { text: texts.join("\n").trim(), images };
}

export function toPlainText(markdown) {
  const f = new StreamingMarkdownFilter();
  return (f.feed(markdown) + f.flush()).trim();
}

export function splitReply(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > MAX_REPLY_CHUNK) {
    let cut = rest.lastIndexOf("\n", MAX_REPLY_CHUNK);
    if (cut < MAX_REPLY_CHUNK / 2) cut = MAX_REPLY_CHUNK;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

/** Markdown-filter, split, and send a reply; returns the number of WeChat messages sent. */
export async function sendReply({ account, to, text, contextToken }) {
  const chunks = splitReply(toPlainText(text));
  for (const chunk of chunks) {
    await sendText({ baseUrl: account.baseUrl, token: account.token, to, text: chunk, contextToken });
  }
  return chunks.length;
}

/** allowFrom: empty = only the account owner, "*" = anyone. */
export function createSenderFilter(config, account) {
  if (config.allowFrom.includes("*")) return () => true;
  const allowed = new Set(config.allowFrom.length ? config.allowFrom : [account.userId]);
  return (userId) => allowed.has(userId);
}
