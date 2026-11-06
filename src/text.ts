/** oneLine collapses every run of whitespace, newlines included, to one space. */
export const oneLine = (s: string): string => s.split(/\s+/).filter((w) => w !== "").join(" ");

/** clip cuts s to at most max UTF-8 bytes, on a character boundary, marking the cut. */
export function clip(s: string, max: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + "…";
}

/** byteLength is the length of s in UTF-8 bytes, the unit every budget here counts in. */
export const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");
