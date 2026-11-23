// Inbound image download + AES-128-ECB decrypt, ported from
// @tencent-weixin/openclaw-weixin (src/cdn/pic-decrypt.ts, src/media/media-download.ts).

import { createDecipheriv } from "node:crypto";

import { CDN_BASE_URL } from "./ilink.mjs";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** aes_key is either base64(16 raw bytes) or base64(32-char hex string). */
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  throw new Error(`unsupported aes_key length ${decoded.length}`);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function sniffImageMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "image/jpeg";
}

/** Download an inbound ImageItem; returns { mimeType, data (base64) } or null. */
export async function downloadImage(imageItem) {
  const media = imageItem?.media;
  if (!media?.encrypt_query_param && !media?.full_url) return null;

  const url =
    media.full_url ||
    `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());

  const aesKeyBase64 = imageItem.aeskey
    ? Buffer.from(imageItem.aeskey, "hex").toString("base64")
    : media.aes_key;
  if (aesKeyBase64) buf = decryptAesEcb(buf, parseAesKey(aesKeyBase64));

  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${buf.length} bytes)`);
  return { mimeType: sniffImageMime(buf), data: buf.toString("base64") };
}
