import type {
  BinaryOp,
  ConditionAst,
  EntryAst,
  Expr,
  IntervalAst,
  RelationOp,
  Statement,
} from "./ast.js";
import { CONSTANTS, FUNCTIONS, arityRange } from "./builtins.js";
import { ParseError, type Token, tokenize } from "./lexer.js";

const RELATION_OPS: ReadonlySet<string> = new Set(["=", "==", "<", ">", "<=", ">="]);

/**
 * A differential in Leibniz notation: `d` or `∂` then a short variable name,
 * one letter with an optional subscript or digits. Short on purpose, so a
 * variable like `dist` is never mistaken for d(ist).
 */
const DIFFERENTIAL = /^[d∂]([A-Za-zͰ-Ͽ](?:_[A-Za-z0-9]+|[0-9]+)?)$/;
const OPERATOR_D: ReadonlySet<string> = new Set(["d", "∂"]);

/**
 * Recursive-descent parser with implicit multiplication.
 *
 * Precedence, loosest to tightest:
 *   relation  <  + -  <  * / and juxtaposition  <  unary -  <  ^ (right assoc)
 *
 * Juxtaposition sits at multiplicative level but takes a tighter operand, so
 * `2x^2` parses as 2*(x^2) rather than (2x)^2, and `-x^2` as -(x^2).
 */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private isOp(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "op" && t.text === text;
  }

  private expect(kind: Token["kind"], message: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new ParseError(message, t.start, t.end);
    return t;
  }

  parseEntry(): EntryAst {
    const statement = this.parseStatement();
    let intervals: IntervalAst[] | null = null;
    let conditions: ConditionAst[] | null = null;
    let axes: string[] | null = null;

    for (;;) {
      const t = this.peek();
      if (t.kind === "lbracket") {
        const group = this.parseBracketGroup();
        if (group.kind === "conditions") {
          if (conditions) throw new ParseError("Put all conditions in one [...]", t.start, t.end);
          conditions = group.conditions;
        } else {
          if (intervals) {
            throw new ParseError("Put all ranges in one [...], separated by ;", t.start, t.end);
          }
          intervals = group.intervals;
        }
      } else if (t.kind === "lbrace") {
        if (axes) throw new ParseError("Axes are already named", t.start, t.end);
        axes = this.parseAxes();
      } else if (t.kind === "eof") {
        break;
      } else {
        const what =
          t.kind === "rparen" ? "unmatched closing bracket" : `unexpected ${JSON.stringify(t.text)}`;
        throw new ParseError(`Could not parse: ${what}`, t.start, t.end);
      }
    }
    return { statement, intervals, conditions, axes };
  }

  private parseStatement(): Statement {
    const left = this.parseAdditive();
    const t = this.peek();
    if (t.kind === "op" && RELATION_OPS.has(t.text)) {
      this.next();
      const right = this.parseAdditive();
      const op = (t.text === "==" ? "=" : t.text) as RelationOp;
      return { kind: "relation", op, left, right };
    }
    return { kind: "expr", expr: left };
  }

  private parseBracketGroup():
    | { kind: "conditions"; conditions: ConditionAst[] }
    | { kind: "intervals"; intervals: IntervalAst[] } {
    const open = this.next();
    if (this.peek().kind === "rbracket") {
      throw new ParseError("Empty brackets", open.start, this.peek().end);
    }

    const rows: { left: Expr; right: Expr | null }[][] = [];
    let row: { left: Expr; right: Expr | null }[] = [];
    for (;;) {
      const left = this.parseAdditive();
      let right: Expr | null = null;
      const t = this.peek();
      if (t.kind === "op" && (t.text === "=" || t.text === "==")) {
        this.next();
        right = this.parseAdditive();
      } else if (t.kind === "op" && RELATION_OPS.has(t.text)) {
        throw new ParseError("Conditions use =", t.start, t.end);
      }
      row.push({ left, right });

      const sep = this.next();
      if (sep.kind === "comma") continue;
      if (sep.kind === "semicolon") {
        rows.push(row);
        row = [];
        continue;
      }
      if (sep.kind === "rbracket") {
        rows.push(row);
        break;
      }
      throw new ParseError("Expected , ; or ] here", sep.start, sep.end);
    }

    const items = rows.flat();
    const relations = items.filter((i) => i.right !== null).length;
    if (relations > 0 && relations < items.length) {
      throw new ParseError("Keep ranges and conditions in separate brackets", open.start, open.end);
    }
    if (relations > 0) {
      return {
        kind: "conditions",
        conditions: items.map((i) => ({ left: i.left, right: i.right! })),
      };
    }

    const intervals = rows.map((r): IntervalAst => {
      if (r.length !== 2 && r.length !== 3) {
        throw new ParseError(
          "A range is [low, high] or [low, high, step]; separate axes with ;",
          open.start,
          open.end,
        );
      }
      return { lo: r[0]!.left, hi: r[1]!.left, step: r[2]?.left ?? null };
    });
    return { kind: "intervals", intervals };
  }

  private parseAxes(): string[] {
    const open = this.next();
    const names: string[] = [];
    for (;;) {
      const t = this.expect("ident", "Axes are names, like {q, p}");
      if (FUNCTIONS[t.text] || CONSTANTS[t.text] !== undefined) {
        throw new ParseError(`${t.text} can't be an axis`, t.start, t.end);
      }
      if (names.includes(t.text)) throw new ParseError(`${t.text} is listed twice`, t.start, t.end);
      names.push(t.text);
      const sep = this.next();
      if (sep.kind === "comma") continue;
      if (sep.kind === "rbrace") break;
      throw new ParseError("Expected , or } here", sep.start, sep.end);
    }
    if (names.length < 2 || names.length > 3) {
      throw new ParseError("Name two or three axes, like {q, p}", open.start, open.end);
    }
    return names;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().text as BinaryOp;
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/")) {
        const op = this.next().text as BinaryOp;
        const right = this.parseUnary();
        left = { kind: "binary", op, left, right };
      } else if (this.startsImplicitFactor()) {
        const right = this.parseUnary();
        left = { kind: "binary", op: "*", left, right };
      } else {
        return left;
      }
    }
  }

  /** True when the next token begins a factor that was written without a `*`. */
  private startsImplicitFactor(): boolean {
    const t = this.peek();
    return t.kind === "number" || t.kind === "ident" || t.kind === "lparen";
  }

  private parseUnary(): Expr {
    if (this.isOp("-") || this.isOp("+")) {
      const op = this.next().text as "-" | "+";
      const arg = this.parseUnary();
      if (op === "+") return arg;
      // Fold the sign into literals so `-2` stays a single constant.
      if (arg.kind === "num") return { kind: "num", value: -arg.value };
      return { kind: "unary", op, arg };
    }
    return this.parsePower();
  }

  private parsePower(): Expr {
    const base = this.parsePrimary();
    if (this.isOp("^")) {
      this.next();
      const exponent = this.parseUnary();
      return { kind: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }

  private countPrimes(): number {
    let primes = 0;
    while (this.peek().kind === "prime") {
      this.next();
      primes++;
    }
    return primes;
  }

  private parseArgs(name: Token): Expr[] {
    const open = this.next();
    if (this.peek().kind === "rparen") {
      throw new ParseError(`${name.text}() needs an argument`, name.start, this.peek().end);
    }
    const args = [this.parseAdditive()];
    while (this.peek().kind === "comma") {
      this.next();
      args.push(this.parseAdditive());
    }
    const close = this.next();
    if (close.kind !== "rparen") {
      throw new ParseError(`Missing closing bracket for ${name.text}`, open.start, close.end);
    }
    return args;
  }

  private parsePrimary(): Expr {
    const t = this.next();

    if (t.kind === "number") {
      const value = Number(t.text);
      if (!Number.isFinite(value)) {
        throw new ParseError(`Invalid number ${JSON.stringify(t.text)}`, t.start, t.end);
      }
      return { kind: "num", value };
    }

    if (t.kind === "lparen") {
      const first = this.parseAdditive();
      if (this.peek().kind === "comma") {
        const items = [first];
        while (this.peek().kind === "comma") {
          this.next();
          items.push(this.parseAdditive());
        }
        const close = this.next();
        if (close.kind !== "rparen") throw new ParseError("Missing closing bracket", t.start, close.end);
        if (items.length > 3) {
          throw new ParseError("Points and parametric plots have 2 or 3 coordinates", t.start, close.end);
        }
        return { kind: "tuple", items };
      }
      const close = this.next();
      if (close.kind !== "rparen") throw new ParseError("Missing closing bracket", t.start, close.end);
      return first;
    }

    if (t.kind === "ident") {
      const leibniz = this.parseLeibniz(t);
      if (leibniz) return leibniz;

      const name = t.text;
      const primes = this.countPrimes();
      const fn = FUNCTIONS[name];

      if (fn) {
        let args: Expr[];
        if (this.peek().kind === "lparen") {
          args = this.parseArgs(t);
        } else if (this.startsImplicitFactor()) {
          // Bare application, e.g. `sin x` or `sqrt 2`.
          args = [this.parseUnary()];
        } else {
          throw new ParseError(`${name} needs an argument`, t.start, t.end);
        }

        const [min, max] = arityRange(fn);
        if (args.length < min || args.length > max) {
          const want = min === max ? `${min}` : `${min} to ${max}`;
          throw new ParseError(
            `${name} takes ${want} argument${max === 1 ? "" : "s"}, got ${args.length}`,
            t.start,
            t.end,
          );
        }
        return primes > 0 ? { kind: "apply", name, args, primes } : { kind: "call", name, args };
      }

      const constant = CONSTANTS[name];
      if (constant !== undefined && primes === 0) return { kind: "num", value: constant };

      if (this.peek().kind === "lparen") {
        return { kind: "apply", name, args: this.parseArgs(t), primes };
      }
      if (primes > 0) {
        return { kind: "deriv", expr: { kind: "var", name }, variable: null, order: primes };
      }
      return { kind: "var", name };
    }

    throw new ParseError(
      t.kind === "eof" ? "Expression is incomplete" : `Unexpected ${JSON.stringify(t.text)}`,
      t.start,
      t.end,
    );
  }

  /**
   * Leibniz derivatives, tried right after an identifier is read:
   *
   *   dp/dq             derivative of p with respect to q
   *   d^2p/dq^2         second derivative
   *   d/dx x^2          operator form, applied to the next factor
   *   d^2/dx^2 sin(x)   operator form, second order
   *
   * Each form is matched in full by lookahead first, so `d^2 + 1` and `d/2`
   * stay ordinary arithmetic.
   */
  private parseLeibniz(first: Token): Expr | null {
    const ident = (offset: number): Token | null => {
      const tok = this.peek(offset);
      return tok.kind === "ident" ? tok : null;
    };
    const integer = (offset: number): number | null => {
      const tok = this.peek(offset);
      if (tok.kind !== "number" || !/^\d+$/.test(tok.text)) return null;
      const value = Number(tok.text);
      return value >= 1 && value <= 8 ? value : null;
    };
    const differential = (offset: number): string | null => {
      const tok = ident(offset);
      return tok ? (DIFFERENTIAL.exec(tok.text)?.[1] ?? null) : null;
    };
    const operand = (): Expr => {
      if (!this.startsImplicitFactor() && !this.isOp("-")) {
        const t = this.peek();
        throw new ParseError("Say what to differentiate, like d/dx x^2", t.start, t.end);
      }
      return this.parseUnary();
    };

    if (OPERATOR_D.has(first.text)) {
      // d/dx f
      const wrt = this.isOp("/") ? differential(1) : null;
      if (wrt && !this.isOp("^", 2)) {
        this.pos += 2;
        return { kind: "deriv", expr: operand(), variable: wrt, order: 1 };
      }
      // d^n/dx^n f  and  d^n y/dx^n
      const order = this.isOp("^") ? integer(1) : null;
      if (order !== null) {
        const opVariable = differential(3);
        if (this.isOp("/", 2) && opVariable && this.isOp("^", 4) && integer(5) === order) {
          this.pos += 6;
          return { kind: "deriv", expr: operand(), variable: opVariable, order };
        }
        const target = ident(2);
        const variable = differential(4);
        if (
          target &&
          !FUNCTIONS[target.text] &&
          this.isOp("/", 3) &&
          variable &&
          this.isOp("^", 5) &&
          integer(6) === order
        ) {
          this.pos += 7;
          return { kind: "deriv", expr: { kind: "var", name: target.text }, variable, order };
        }
      }
      return null;
    }

    // dy/dx
    const target = DIFFERENTIAL.exec(first.text)?.[1];
    const wrt = target && this.isOp("/") ? differential(1) : null;
    if (target && wrt && !this.isOp("^", 2)) {
      this.pos += 2;
      return { kind: "deriv", expr: { kind: "var", name: target }, variable: wrt, order: 1 };
    }
    return null;
  }
}

/** Parses one line: a statement with optional ranges, conditions and axes. */
export function parseEntry(source: string): EntryAst {
  const trimmed = source.trim();
  if (trimmed === "") throw new ParseError("Empty expression", 0, 0);
  return new Parser(tokenize(trimmed)).parseEntry();
}

/**
 * Parses a bare statement. Kept for callers that only understand single
 * graphs, such as the WebGL viewer; lines with ranges, conditions or axes
 * need `parseEntry` and the document analyzer.
 */
export function parse(source: string): Statement {
  const entry = parseEntry(source);
  if (entry.intervals || entry.conditions || entry.axes) {
    throw new ParseError("Ranges, conditions and axes need the full document", 0, source.length);
  }
  return entry.statement;
}

export { ParseError } from "./lexer.js";
