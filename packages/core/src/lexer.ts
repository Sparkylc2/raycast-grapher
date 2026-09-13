export type TokenKind =
  | "number"
  | "ident"
  | "op"
  | "lparen"
  | "rparen"
  | "comma"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export class ParseError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

/** Multi-character operators must be tried before their single-char prefixes. */
const OPERATORS = ["<=", ">=", "==", "!=", "+", "-", "*", "/", "^", "=", "<", ">"] as const;

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c.charCodeAt(0) > 127;
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const c = source[i]!;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (i < source.length && isDigit(source[i]!)) i++;
      if (source[i] === ".") {
        i++;
        while (i < source.length && isDigit(source[i]!)) i++;
      }
      // Exponent form, e.g. 1.5e-3. Only consume `e` when digits actually follow,
      // otherwise `2e` should read as 2 * e (Euler's number).
      if (source[i] === "e" || source[i] === "E") {
        const save = i;
        i++;
        if (source[i] === "+" || source[i] === "-") i++;
        if (isDigit(source[i] ?? "")) {
          while (i < source.length && isDigit(source[i]!)) i++;
        } else {
          i = save;
        }
      }
      tokens.push({ kind: "number", text: source.slice(start, i), start, end: i });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      tokens.push({ kind: "ident", text: source.slice(start, i), start, end: i });
      continue;
    }

    if (c === "(" || c === "[" || c === "{") {
      tokens.push({ kind: "lparen", text: c, start: i, end: ++i });
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      tokens.push({ kind: "rparen", text: c, start: i, end: ++i });
      continue;
    }
    if (c === ",") {
      tokens.push({ kind: "comma", text: c, start: i, end: ++i });
      continue;
    }

    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", text: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }

    throw new ParseError(`Unexpected character ${JSON.stringify(c)}`, i, i + 1);
  }

  tokens.push({ kind: "eof", text: "", start: source.length, end: source.length });
  return tokens;
}
