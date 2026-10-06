import { CsvImportError } from "../errors";

/**
 * How a mapped CSV row becomes an import fingerprint.
 *
 * The hash is SHA-256 of the JSON array of normalized rows, in file order:
 * `[occurredOn, payee, amountCents, accountName, categoryName]`.
 * Each row's fingerprint is `${hash}:${index}` where `index` is its place in
 * that array. Identical lines stay distinct because the index differs.
 *
 * Notes are not hashed. A notes-only change does not invent a second copy of
 * a transaction that was already imported under this scheme, including files
 * imported before notes existed.
 *
 * Account and category names are the mapped text (the cell, or the Dollas
 * account name when one account is chosen for the file), not the resolved
 * category after payee rules. Payee rules can change the category that is
 * saved without changing the fingerprint.
 *
 * Rows that fail validation are omitted. The same file with the same mapping
 * omits the same rows, so the hash and the indexes stay the same and a second
 * import adds nothing. A mapping change that repairs a row changes the list,
 * and therefore every fingerprint in the file, which is the same whole-file
 * rule the fixed-column importer already used.
 *
 * A soft-deleted row keeps its fingerprint, so it still counts as imported.
 * Undo hard-deletes only that import's batch, which drops those fingerprints.
 */
export async function fingerprintNormalizedRows(
  rows: readonly {
    occurredOn: string;
    payee: string;
    amountCents: number;
    accountName: string;
    categoryName: string;
  }[],
): Promise<string[]> {
  const canonical = JSON.stringify(
    rows.map((row) => [row.occurredOn, row.payee, row.amountCents, row.accountName, row.categoryName]),
  );
  const contentSha256 = await sha256Hex(canonical);
  return rows.map((_, index) => `${contentSha256}:${index}`);
}

type SubtleDigest = {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
};

export async function sha256Hex(value: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleDigest } }).crypto?.subtle;
  if (!subtle) {
    throw new CsvImportError("Could not fingerprint that CSV.");
  }
  const digest = await subtle.digest("SHA-256", utf8Bytes(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}
