/** Display text from an untrusted peer: drops control and bidi-override characters, trims and bounds it. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Drop control and bidi-override characters so a name cannot spoof layout.
  const clean = Array.from(value)
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return !(
        n < 0x20 ||
        (n >= 0x7f && n <= 0x9f) ||
        n === 0x200e ||
        n === 0x200f ||
        (n >= 0x202a && n <= 0x202e) ||
        (n >= 0x2066 && n <= 0x2069)
      );
    })
    .join("")
    .trim();
  return clean ? Array.from(clean).slice(0, max).join("") : null;
}
