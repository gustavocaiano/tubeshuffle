import { createHash, timingSafeEqual } from "node:crypto";

// Only explicitly opted-in playlist and suggestion handlers may use this
// credential. One paired Mac holds the token; the server stores its digest.
export function personalImportAuthorization(request: Request): "not-personal" | "allowed" | "invalid" | "unavailable" {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^TubeShuffleDevice(?:\s|$)/i.test(authorization)) return "not-personal";

  const match = /^TubeShuffleDevice ([A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match) return "invalid";
  const token = match[1];
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== token) return "invalid";

  const expected = process.env.TUBESHUFFLE_PERSONAL_IMPORT_TOKEN_SHA256;
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return "unavailable";
  const actual = createHash("sha256").update(token, "ascii").digest();
  return timingSafeEqual(actual, Buffer.from(expected, "hex")) ? "allowed" : "invalid";
}
