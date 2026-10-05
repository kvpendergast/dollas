import { describe, expect, it } from "vitest";
import { TokenEncryptionError } from "../errors";
import { decryptToken, encryptToken, parseTokenKeyRing, reencryptToken, type TokenKeyRing } from "./token-cipher";

const household = { householdId: "house-a" };
const secret = "simplefin-access-url-SECRET-value";

function keyMaterial(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (globalThis as { btoa: (value: string) => string }).btoa(binary);
}

function ring(fill: number, version = 1, extra: Array<{ version: number; fill: number }> = []): TokenKeyRing {
  const entries = [{ version, fill }, ...extra];
  const raw = entries.map((entry) => `${entry.version}:${keyMaterial(entry.fill)}`).join(",");
  const parsed = parseTokenKeyRing(raw);
  if (parsed.isErr()) throw parsed.error;
  return parsed.value;
}

describe("connection token encryption", () => {
  it("round-trips a token and does not leave it in the ciphertext", async () => {
    const keys = ring(7);
    const first = await encryptToken(secret, keys, household);
    const second = await encryptToken(secret, keys, household);
    if (first.isErr()) throw first.error;
    if (second.isErr()) throw second.error;
    expect(first.value.keyVersion).toBe(1);
    expect(first.value.ciphertext.startsWith("v1.")).toBe(true);
    expect(first.value.ciphertext).not.toContain(secret);
    expect(first.value.ciphertext).not.toBe(second.value.ciphertext);
    const plain = await decryptToken(first.value.ciphertext, keys, household);
    if (plain.isErr()) throw plain.error;
    expect(plain.value).toBe(secret);
  });

  it("rejects a tampered ciphertext", async () => {
    const keys = ring(7);
    const encrypted = await encryptToken(secret, keys, household);
    if (encrypted.isErr()) throw encrypted.error;
    const parts = encrypted.value.ciphertext.split(".");
    const body = parts[2];
    const index = 4;
    const flipped = body[index] === "A" ? "B" : "A";
    parts[2] = body.slice(0, index) + flipped + body.slice(index + 1);
    const decrypted = await decryptToken(parts.join("."), keys, household);
    expect(decrypted.isErr()).toBe(true);
    if (decrypted.isOk()) return;
    expect(decrypted.error).toBeInstanceOf(TokenEncryptionError);
    expect(decrypted.error.message).not.toContain(secret);
  });

  it("rejects a different key and a different household", async () => {
    const keys = ring(7);
    const encrypted = await encryptToken(secret, keys, household);
    if (encrypted.isErr()) throw encrypted.error;
    const wrongKey = await decryptToken(encrypted.value.ciphertext, ring(9), household);
    const wrongHousehold = await decryptToken(encrypted.value.ciphertext, keys, { householdId: "house-b" });
    expect(wrongKey.isErr()).toBe(true);
    expect(wrongHousehold.isErr()).toBe(true);
    if (wrongKey.isOk() || wrongHousehold.isOk()) return;
    expect(wrongKey.error).toBeInstanceOf(TokenEncryptionError);
    expect(wrongHousehold.error).toBeInstanceOf(TokenEncryptionError);
    expect(wrongKey.error.message).not.toContain(secret);
  });

  it("re-encrypts with the highest key version and still reads older ones", async () => {
    const original = ring(7);
    const encrypted = await encryptToken(secret, original, household);
    if (encrypted.isErr()) throw encrypted.error;
    const rotated = ring(7, 1, [{ version: 2, fill: 8 }]);
    expect(rotated.current).toBe(2);
    const next = await reencryptToken(encrypted.value.ciphertext, rotated, household);
    if (next.isErr()) throw next.error;
    expect(next.value.keyVersion).toBe(2);
    expect(next.value.ciphertext.startsWith("v2.")).toBe(true);
    const plain = await decryptToken(next.value.ciphertext, rotated, household);
    if (plain.isErr()) throw plain.error;
    expect(plain.value).toBe(secret);
    const onlyNew = ring(8, 2);
    const oldBlob = await decryptToken(encrypted.value.ciphertext, onlyNew, household);
    const newBlob = await decryptToken(next.value.ciphertext, onlyNew, household);
    expect(oldBlob.isErr()).toBe(true);
    if (oldBlob.isOk()) return;
    expect(oldBlob.error.message).toContain("version 1");
    if (newBlob.isErr()) throw newBlob.error;
    expect(newBlob.value).toBe(secret);
  });

  it("fails closed when the key is missing or not 32 bytes", () => {
    const missing = parseTokenKeyRing(undefined);
    const empty = parseTokenKeyRing("   ");
    const short = parseTokenKeyRing("1:YQ==");
    const unversioned = parseTokenKeyRing(keyMaterial(1));
    const zero = parseTokenKeyRing(`0:${keyMaterial(1)}`);
    const duplicate = parseTokenKeyRing(["1", "1"].map((version) => `${version}:${keyMaterial(1)}`).join(","));
    for (const result of [missing, empty, short, unversioned, zero, duplicate]) {
      expect(result.isErr()).toBe(true);
      if (result.isOk()) continue;
      expect(result.error).toBeInstanceOf(TokenEncryptionError);
      expect(result.error.message).toContain("BANK_CONNECTION_KEYS");
      expect(result.error.message.toLowerCase()).toContain("plaintext");
      expect(result.error.message).not.toContain("YQ==");
    }
  });
});
