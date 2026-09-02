export type NativeI18nSurface = "android" | "apple";

type NativeStringLiteral = { end: number; value: string };

const COMMON_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

function interpolationEnd(source: string, start: number, opening: "{" | "("): number | null {
  const closing = opening === "{" ? "}" : ")";
  let depth = 1;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === opening) {
      depth += 1;
    } else if (!quoted && character === closing && --depth === 0) {
      return index;
    }
  }
  return null;
}

function readEscapedLiteral(
  surface: NativeI18nSurface,
  source: string,
  start: number,
  closingQuote: boolean,
): NativeStringLiteral | null {
  let value = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    const opening =
      surface === "android" && character === "$" && next === "{"
        ? "{"
        : surface === "apple" && character === "\\" && next === "("
          ? "("
          : undefined;
    if (opening) {
      const end = interpolationEnd(source, index + 2, opening);
      if (end === null) {
        return null;
      }
      value += source.slice(index, end + 1);
      index = end;
      continue;
    }
    if (character === "\\") {
      if (next === undefined) {
        return null;
      }
      if (next === "u") {
        const unicode =
          surface === "android"
            ? source.slice(index + 2).match(/^([0-9a-f]{4})/iu)
            : source.slice(index + 2).match(/^\{([0-9a-f]{1,8})\}/iu);
        if (unicode) {
          const code = Number.parseInt(unicode[1] ?? "", 16);
          if (surface === "android" || (code <= 0x10ffff && (code < 0xd800 || code > 0xdfff))) {
            value += surface === "android" ? String.fromCharCode(code) : String.fromCodePoint(code);
            index += unicode[0].length + 1;
            continue;
          }
        }
      }
      const escaped =
        surface === "android" && next === "$"
          ? "$"
          : surface === "android" && next === "b"
            ? "\b"
            : surface === "apple" && next === "0"
              ? "\0"
              : COMMON_ESCAPES[next];
      // Consume each escape once: an escaped backslash must not start another escape.
      value += escaped ?? character + next;
      index += 1;
      continue;
    }
    if (closingQuote && character === '"') {
      return { end: index + 1, value };
    }
    value += character;
  }
  return closingQuote ? null : { end: source.length, value };
}

function swiftMultilineBody(raw: string): string {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  // Swift's closing delimiter defines the margin; extra content indentation is significant.
  const indent = lines.at(-1)?.length ?? 0;
  if (lines[0]?.trim() === "") {
    lines.shift();
  }
  if (lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  const deindented = lines.map((line) => line.slice(Math.min(indent, line.length)));
  return deindented
    .map((line, index) => {
      if (index === deindented.length - 1) {
        return line;
      }
      const trailingBackslashes = line.match(/\\+$/u)?.[0].length ?? 0;
      return trailingBackslashes % 2 === 1 ? line.slice(0, -1) : line + "\n";
    })
    .join("");
}

export function readNativeStringLiteral(
  surface: NativeI18nSurface,
  source: string,
  openingQuote: number,
): NativeStringLiteral | null {
  if (source[openingQuote] !== '"') {
    return null;
  }
  if (!source.startsWith('"""', openingQuote)) {
    return readEscapedLiteral(surface, source, openingQuote + 1, true);
  }
  const closingQuote = source.indexOf('"""', openingQuote + 3);
  if (closingQuote < 0) {
    return null;
  }
  const body = source.slice(openingQuote + 3, closingQuote);
  // Kotlin raw literals preserve whitespace; Swift multiline literals deindent and decode escapes.
  const value =
    surface === "android"
      ? body
      : readEscapedLiteral(surface, swiftMultilineBody(body), 0, false)?.value;
  return value === undefined ? null : { end: closingQuote + 3, value };
}
