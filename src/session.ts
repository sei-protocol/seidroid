import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

/** MAX_SESSION is the most a packed session may weigh; a pull request's session packs to well under 1 MiB after a dozen reviews. */
export const MAX_SESSION = 8 << 20;
/** MAX_UNPACKED is the most a packed session may unpack to. */
const MAX_UNPACKED = 64 << 20;
const BLOCK = 512;

const padding = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK;

/** safeName is whether name is a relative path that stays inside the directory it unpacks to. */
const safeName = (name: string): boolean =>
  name !== "" && !name.includes("\0") && !name.includes("\\") && name.split("/").every((s) => s !== "" && s !== "." && s !== "..");

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name) > 100) throw new Error(`${name} has too long a name to pack`);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\x0000", 257);
  h.write(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** pack is the regular files under dir as a zstd-compressed tar, which is all a session holds. */
export function pack(dir: string): Buffer {
  const parts: Buffer[] = [];
  for (const rel of (readdirSync(dir, { recursive: true }) as string[]).sort()) {
    const st = lstatSync(path.join(dir, rel));
    if (st.isDirectory()) continue;
    if (!st.isFile()) throw new Error(`${rel} is not a regular file`);
    const body = readFileSync(path.join(dir, rel));
    parts.push(header(rel.split(path.sep).join("/"), body.length), body, Buffer.alloc(padding(body.length)));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return zstdCompressSync(Buffer.concat(parts));
}

/** files reads a packed session, refusing anything but regular files and directories that stay inside it. */
export function files(packed: Buffer): Map<string, Buffer> {
  if (packed.length > MAX_SESSION) throw new Error(`the session is over ${MAX_SESSION} bytes`);
  const tar = zstdDecompressSync(packed, { maxOutputLength: MAX_UNPACKED });
  const out = new Map<string, Buffer>();
  for (let at = 0; ; ) {
    if (at + BLOCK > tar.length) throw new Error("the session ends early");
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) return out;
    const field = (from: number, len: number) => h.subarray(from, from + len).toString("latin1").replace(/\0[\s\S]*$/, "");
    const sum = h.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
    if (parseInt(field(148, 8), 8) !== sum) throw new Error("the session has a corrupt header");
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)).replace(/\/$/, "");
    const size = /^[0-7]{1,11}\s*$/.test(field(124, 12)) ? parseInt(field(124, 12), 8) : NaN;
    const type = String.fromCharCode(h[156]!);
    if (!safeName(name)) throw new Error(`the session holds ${JSON.stringify(name)}, which is outside it`);
    if (!["0", "\0", "5"].includes(type)) throw new Error(`the session holds ${name}, which is not a regular file`);
    if (!Number.isSafeInteger(size) || at + BLOCK + size > tar.length) throw new Error(`the session holds ${name} cut short`);
    if (type !== "5") {
      if (out.has(name)) throw new Error(`the session holds ${name} twice`);
      out.set(name, tar.subarray(at + BLOCK, at + BLOCK + size));
    }
    at += BLOCK + size + padding(size);
  }
}

/** unpack writes a packed session into the empty directory dir. */
export function unpack(packed: Buffer, dir: string): void {
  for (const [name, body] of files(packed)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body, { flag: "wx" });
  }
}
