import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:";

function deriveKey(): Buffer {
  const material = `${homedir()}:${userInfo().username}:agav-keyring`;
  return createHash("sha256").update(material).digest();
}

export function encrypt(plaintext: string): string {
  if (!plaintext || plaintext.startsWith(PREFIX)) return plaintext;
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return PREFIX + payload;
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext || !ciphertext.startsWith(PREFIX)) return ciphertext;
  try {
    const raw = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const key = deriveKey();
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
  } catch {
    return ciphertext;
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function maskApiKey(key: string): string {
  const plain = key.startsWith(PREFIX) ? "(encrypted)" : key;
  if (plain === "(encrypted)") return plain;
  if (plain.length <= 8) return "****";
  return plain.slice(0, 5) + "..." + plain.slice(-3);
}
