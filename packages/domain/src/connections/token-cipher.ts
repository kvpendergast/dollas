import { err, ok, type Result } from "neverthrow";
import { TokenEncryptionError } from "../errors";

/**
 * Versioned AES-256-GCM key ring. The env value is comma-separated
 * `version:base64` entries. Each decoded key is 32 bytes. The highest version
 * encrypts new tokens; older versions stay so existing ciphertext still decrypts.
 * Ciphertext is `v{version}.{base64url iv}.{base64url ciphertext+tag}` and is
 * bound to the household id, so a copied blob does not decrypt for someone else.
 */
export const BANK_CONNECTION_KEYS_ENV = "BANK_CONNECTION_KEYS";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_TOKEN_CHARS = 4_096;
const ENTRY = /^([1-9][0-9]{0,8}):([A-Za-z0-9+/_-]+={0,2})$/;
const PACKED = /^v([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{16,})$/;

export type TokenKeyRing = {
  current: number;
  keys: ReadonlyMap<number, Uint8Array>;
};

export type EncryptedToken = {
  ciphertext: string;
  keyVersion: number;
};

export type TokenAudience = {
  householdId: string;
};

type AesParams = {
  name: "AES-GCM";
  iv: Uint8Array;
  additionalData: Uint8Array;
  tagLength: number;
};

type SubtleAes = {
  importKey(
    format: "raw",
    key: Uint8Array,
    algorithm: "AES-GCM",
    extractable: false,
    usages: readonly ["encrypt"] | readonly ["decrypt"],
  ): Promise<unknown>;
  encrypt(algorithm: AesParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: AesParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
};

type WebCrypto = {
  subtle: SubtleAes;
  getRandomValues(bytes: Uint8Array): Uint8Array;
};

export function parseTokenKeyRing(raw: string | undefined | null): Result<TokenKeyRing, TokenEncryptionError> {
  if (raw == null || raw.trim() === "") {
    return err(
      new TokenEncryptionError(
        `${BANK_CONNECTION_KEYS_ENV} is required. Set comma-separated version:base64 entries of 32-byte keys. Connection tokens are not stored in plaintext.`,
      ),
    );
  }
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return err(invalidKeyMessage());
  const keys = new Map<number, Uint8Array>();
  for (const part of parts) {
    const match = ENTRY.exec(part);
    if (!match) return err(invalidKeyMessage());
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || keys.has(version)) return err(invalidKeyMessage());
    const bytes = decodeBase64(match[2]);
    if (!bytes || bytes.length !== KEY_BYTES) return err(invalidKeyMessage());
    keys.set(version, bytes);
  }
  return ok({ current: Math.max(...keys.keys()), keys });
}

export async function encryptToken(
  plaintext: string,
  ring: TokenKeyRing,
  audience: TokenAudience,
): Promise<Result<EncryptedToken, TokenEncryptionError>> {
  if (plaintext.length === 0 || plaintext.length > MAX_TOKEN_CHARS || plaintext.includes("\0")) {
    return err(new TokenEncryptionError("That connection token cannot be stored."));
  }
  const key = ring.keys.get(ring.current);
  if (!key || key.length !== KEY_BYTES) {
    return err(new TokenEncryptionError("The current connection encryption key is missing."));
  }
  const aad = audienceBytes(audience);
  const crypto = webCrypto();
  const encoded = utf8(plaintext);
  if (!aad || !crypto || !encoded) {
    return err(new TokenEncryptionError("Connection tokens cannot be encrypted in this runtime."));
  }
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      cryptoKey,
      encoded,
    );
    const ivText = encodeBase64Url(iv);
    const bodyText = encodeBase64Url(new Uint8Array(encrypted));
    if (!ivText || !bodyText) {
      return err(new TokenEncryptionError("Could not encrypt that connection token."));
    }
    const ciphertext = `v${ring.current}.${ivText}.${bodyText}`;
    if (!PACKED.test(ciphertext) || (plaintext.length >= 12 && ciphertext.includes(plaintext))) {
      return err(new TokenEncryptionError("Refusing to store a connection token that is not encrypted."));
    }
    return ok({ ciphertext, keyVersion: ring.current });
  } catch {
    return err(new TokenEncryptionError("Could not encrypt that connection token."));
  }
}

export async function decryptToken(
  ciphertext: string,
  ring: TokenKeyRing,
  audience: TokenAudience,
): Promise<Result<string, TokenEncryptionError>> {
  const match = PACKED.exec(ciphertext);
  if (!match) return err(new TokenEncryptionError("That connection token could not be decrypted."));
  const version = Number(match[1]);
  const key = ring.keys.get(version);
  if (!key) {
    return err(
      new TokenEncryptionError(
        `No ${BANK_CONNECTION_KEYS_ENV} entry decrypts version ${version}. Keep old key versions until those tokens are re-encrypted.`,
      ),
    );
  }
  const iv = decodeBase64(match[2]);
  const body = decodeBase64(match[3]);
  const aad = audienceBytes(audience);
  const crypto = webCrypto();
  if (!iv || iv.length !== IV_BYTES || !body || !aad || !crypto) {
    return err(new TokenEncryptionError("That connection token could not be decrypted."));
  }
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      cryptoKey,
      body,
    );
    const text = utf8Decode(new Uint8Array(plain));
    if (text == null) return err(new TokenEncryptionError("That connection token could not be decrypted."));
    return ok(text);
  } catch {
    return err(new TokenEncryptionError("That connection token could not be decrypted."));
  }
}

/** Decrypt with whichever version sealed the blob, then seal it with the current key. */
export async function reencryptToken(
  ciphertext: string,
  ring: TokenKeyRing,
  audience: TokenAudience,
): Promise<Result<EncryptedToken, TokenEncryptionError>> {
  const plain = await decryptToken(ciphertext, ring, audience);
  if (plain.isErr()) return err(plain.error);
  return encryptToken(plain.value, ring, audience);
}

function invalidKeyMessage(): TokenEncryptionError {
  return new TokenEncryptionError(
    `${BANK_CONNECTION_KEYS_ENV} must be comma-separated version:base64 entries. Each version is a positive integer and each key is 32 bytes. Connection tokens are not stored in plaintext.`,
  );
}

function audienceBytes(audience: TokenAudience): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(audience.householdId)) return null;
  return utf8(`household:${audience.householdId}`);
}

function webCrypto(): WebCrypto | null {
  const crypto = (globalThis as unknown as { crypto?: Partial<WebCrypto> }).crypto;
  if (!crypto?.subtle || !crypto.getRandomValues) return null;
  return crypto as WebCrypto;
}

function encodeBase64Url(bytes: Uint8Array): string | null {
  const encode = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!encode) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return encode(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > 20_000) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(standard)) return null;
  const remainder = standard.length % 4;
  const padded = remainder === 0 ? standard : standard + "=".repeat(4 - remainder);
  const decode = (globalThis as { atob?: (value: string) => string }).atob;
  if (!decode) return null;
  try {
    const binary = decode(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function utf8(value: string): Uint8Array | null {
  const Encoder = (globalThis as { TextEncoder?: new () => { encode(input: string): Uint8Array } }).TextEncoder;
  if (!Encoder) return null;
  return new Encoder().encode(value);
}

function utf8Decode(bytes: Uint8Array): string | null {
  const Decoder = (globalThis as { TextDecoder?: new () => { decode(input: Uint8Array): string } }).TextDecoder;
  if (!Decoder) return null;
  return new Decoder().decode(bytes);
}
