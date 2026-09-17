import type {
  BinaryOp,
  ConditionAst,
  EntryAst,
  Expr,
  IntervalAst,
  ReduceBound,
  ReduceOp,
  RelationOp,
  Statement,
} from "./ast.js";
import { CONSTANTS, FUNCTIONS, arityRange } from "./builtins.js";
import { ParseError, type Token, tokenize } from "./lexer.js";

const RELATION_OPS: ReadonlySet<string> = new Set(["=", "==", "<", ">", "<=", ">="]);
const MULTIPLICATIVE: ReadonlySet<string> = new Set(["*", "/", ".*", "./", "\\"]);
const REDUCTIONS: ReadonlySet<string> = new Set(["min", "max", "argmin", "argmax"]);
/** Stands in as the right side of a bare `periodic` condition. */
export const PERIODIC = "#periodic";

/**
 * A differential in Leibniz notation: `d` or `∂` then a short variable name,
 * one letter with an optional subscript or digits. Short on purpose, so a
 * variable like `dist` is never mistaken for d(ist).
 */
const DIFFERENTIAL = /^[d∂]([A-Za-zͰ-Ͽ](?:_[A-Za-z0-9]+|[0-9]+)?)$/;
const OPERATOR_D: ReadonlySet<string> = new Set(["d", "∂"]);

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/**
 * Recursive-descent parser with implicit multiplication.
 *
 * Precedence, loosest to tightest:
 *   relation  <  + -  <  * / .* ./ \ and juxtaposition  <  unary -  <  ^ .^ (right assoc)
 *
 * Juxtaposition sits at multiplicative level but takes a tighter operand, so
 * `2x^2` parses as 2*(x^2) rather than (2x)^2, and `-x^2` as -(x^2).
 *
 * Inside a matrix literal, spaces separate entries as they do in MATLAB:
 * `[1 -2]` has two entries, `[1 - 2]` has one, and `[2x 3]` multiplies only
 * where there is no space.
 */
class Parser {
  private pos = 0;
  /** Whether the innermost open bracket is a matrix, where spaces separate entries. */
  private readonly contexts: ("matrix" | "group")[] = [];

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

  private inMatrix(): boolean {
    return this.contexts[this.contexts.length - 1] === "matrix";
  }

  /** True when whitespace separates the token at `offset` from the one before it. */
  private gapBefore(offset = 0): boolean {
    const index = Math.min(this.pos + offset, this.tokens.length - 1);
    const previous = this.tokens[index - 1];
    return previous !== undefined && this.tokens[index]!.start > previous.end;
  }

  private within<T>(context: "matrix" | "group", body: () => T): T {
    this.contexts.push(context);
    try {
      return body();
    } finally {
      this.contexts.pop();
    }
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
    this.within("group", () => {
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
    });

    const items = rows.flat();
    // `periodic` and `periodic(x)` stand alone among a PDE's conditions.
    const flag = (i: { left: Expr; right: Expr | null }): boolean =>
      i.right === null && (i.left.kind === "var" || i.left.kind === "apply") && i.left.name === "periodic";
    const relations = items.filter((i) => i.right !== null || flag(i)).length;
    if (relations > 0 && relations < items.length) {
      throw new ParseError("Keep ranges and conditions in separate brackets", open.start, open.end);
    }
    if (relations > 0) {
      return {
        kind: "conditions",
        conditions: items.map((i) => ({ left: i.left, right: i.right ?? { kind: "var", name: PERIODIC } })),
      };
    }

    const intervals = rows.map((r): IntervalAst => {
      if (r.length !== 2 && r.length !== 3) {
        // A bracket after a finished statement is a range, so a matrix there needs an operator.
        const hint = r.length === 1 ? " To multiply by a matrix, put * before it." : "";
        throw new ParseError(
          `A range is [low, high] or [low, high, step]; separate axes with ;.${hint}`,
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
    // Four names are for PDEs over space and time, like {x, y, z, t} or {x, y, t, u}.
    if (names.length < 2 || names.length > 4) {
      throw new ParseError("Name two to four axes, like {q, p}", open.start, open.end);
    }
    return names;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      // In a matrix, a sign that follows a space but touches its number starts a new entry.
      if (this.inMatrix() && this.gapBefore() && !this.gapBefore(1)) break;
      const op = this.next().text as BinaryOp;
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && MULTIPLICATIVE.has(t.text)) {
        const op = this.next().text as BinaryOp;
        const right = this.parseUnary();
        left = { kind: "binary", op, left, right };
      } else if (this.startsImplicitFactor() && !(this.inMatrix() && this.gapBefore())) {
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
    let base = this.parsePrimary();
    // Primes after a bracket, as in (A B)' or [1 2]': a transpose for matrices.
    if (base.kind !== "var" && base.kind !== "deriv" && base.kind !== "apply" && this.peek().kind === "prime") {
      base = { kind: "deriv", expr: base, variable: null, order: this.countPrimes() };
    }
    if (this.isOp("^") || this.isOp(".^")) {
      const op = this.next().text as BinaryOp;
      const exponent = this.parseUnary();
      return { kind: "binary", op, left: base, right: exponent };
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
    return this.within("group", () => {
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
    });
  }

  private parseMatrix(open: Token): Expr {
    return this.within("matrix", () => {
      if (this.peek().kind === "rbracket") throw new ParseError("Empty matrix", open.start, this.peek().end);
      const rows: Expr[][] = [[]];
      for (;;) {
        rows[rows.length - 1]!.push(this.parseAdditive());
        const t = this.peek();
        if (t.kind === "comma") {
          this.next();
          continue;
        }
        if (t.kind === "semicolon") {
          this.next();
          rows.push([]);
          continue;
        }
        if (t.kind === "rbracket") {
          this.next();
          break;
        }
        const startsEntry =
          t.kind === "number" ||
          t.kind === "ident" ||
          t.kind === "lparen" ||
          t.kind === "lbracket" ||
          (t.kind === "op" && (t.text === "-" || t.text === "+"));
        if (startsEntry && this.gapBefore()) continue;
        throw new ParseError(
          t.kind === "eof" ? "Missing ] to close the matrix" : "Expected , ; or ] in a matrix",
          t.start,
          t.end,
        );
      }
      // A trailing semicolon, as in [1; 2;], is allowed.
      if (rows.length > 1 && rows[rows.length - 1]!.length === 0) rows.pop();
      if (rows.some((row) => row.length === 0)) throw new ParseError("A matrix row is empty", open.start, open.end);
      return { kind: "matrix", rows };
    });
  }

  private reduction(name: Token, op: ReduceOp, args: Expr[]): Expr {
    const usage = `${op} over a range takes an expression, then a name, low and high for each variable, like ${op}(f(x), x, -2, 2)`;
    if (args.length < 4 || (args.length - 1) % 3 !== 0) throw new ParseError(usage, name.start, name.end);
    return { kind: "reduce", op, expr: args[0]!, bounds: this.boundsOf(name, op, args.slice(1), 1, usage), component: null };
  }

  /** Name, low, high triples, where `offset` is the position of the first in the call. */
  private boundsOf(name: Token, op: string, items: readonly Expr[], offset: number, usage: string): ReduceBound[] {
    const bounds: ReduceBound[] = [];
    for (let i = 0; i < items.length; i += 3) {
      const v = items[i]!;
      if (v.kind !== "var") {
        const position = i + offset;
        throw new ParseError(`The ${ORDINALS[position] ?? `${position + 1}th`} argument of ${op} should be a variable name. ${usage}`, name.start, name.end);
      }
      if (bounds.some((b) => b.variable === v.name)) {
        throw new ParseError(`${v.name} appears twice in ${op}`, name.start, name.end);
      }
      bounds.push({ variable: v.name, lo: items[i + 1]!, hi: items[i + 2]! });
    }
    if (bounds.length > 3) throw new ParseError(`${op} works over at most three variables`, name.start, name.end);
    return bounds;
  }

  /**
   * `int(expr, x, lo, hi, ...)`, bounds innermost first, with an optional region
   * as the second argument: `int(1, x^2 + y^2 < 1, x, -1, 1, y, -1, 1)`.
   */
  private parseIntegral(name: Token): Expr {
    const op = name.text;
    const usage = `${op} takes an expression, then a name, low and high for each variable, innermost first, like ${op}(x^2, x, 0, 1)`;
    const open = this.next();
    return this.within("group", () => {
      const expr = this.parseAdditive();
      let region: Expr | null = null;
      const rest: Expr[] = [];
      while (this.peek().kind === "comma") {
        this.next();
        const item = this.parseAdditive();
        const t = this.peek();
        if (t.kind === "op" && RELATION_OPS.has(t.text)) {
          if (rest.length > 0 || region || t.text === "=" || t.text === "==") {
            throw new ParseError("A region goes second, as an inequality like x^2 + y^2 < 1", t.start, t.end);
          }
          this.next();
          const right = this.parseAdditive();
          // Stored as F with the region where F <= 0.
          region = t.text.startsWith("<") ? { kind: "binary", op: "-", left: item, right } : { kind: "binary", op: "-", left: right, right: item };
        } else {
          rest.push(item);
        }
      }
      const close = this.next();
      if (close.kind !== "rparen") throw new ParseError(`Missing closing bracket for ${op}`, open.start, close.end);
      if (rest.length < 3 || rest.length % 3 !== 0) throw new ParseError(usage, name.start, name.end);
      const bounds = this.boundsOf(name, op, rest, region ? 2 : 1, usage);
      return { kind: "integral", expr, bounds, region } satisfies Expr;
    });
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

    if (t.kind === "lbracket") return this.parseMatrix(t);

    if (t.kind === "lparen") {
      return this.within("group", () => {
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
          return { kind: "tuple", items } satisfies Expr;
        }
        const close = this.next();
        if (close.kind !== "rparen") throw new ParseError("Missing closing bracket", t.start, close.end);
        return first;
      });
    }

    if (t.kind === "ident") {
      const leibniz = this.parseLeibniz(t);
      if (leibniz) return leibniz;

      const name = t.text;
      const primes = this.countPrimes();

      if ((name === "int" || name === "integral") && primes === 0 && this.peek().kind === "lparen") {
        return this.parseIntegral(t);
      }

      // min and max with two arguments compare values; with a variable and a range they optimise.
      if (REDUCTIONS.has(name) && primes === 0 && this.peek().kind === "lparen") {
        const args = this.parseArgs(t);
        if ((name === "min" || name === "max") && args.length === 2) return { kind: "call", name, args };
        return this.reduction(t, name as ReduceOp, args);
      }

      const fn = FUNCTIONS[name];

      if (fn) {
        let args: Expr[];
        if (this.peek().kind === "lparen") {
          args = this.parseArgs(t);
        } else if (this.startsImplicitFactor()) {
          // Bare application, e.g. `sin x` or `sqrt 2`. A built-in can't stand alone,
          // so this reads across a space even in a matrix, as in [cos t, -sin t].
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

      // In a matrix, `a (1)` is two entries; a call or index touches its name.
      if (this.peek().kind === "lparen" && !(this.inMatrix() && this.gapBefore())) {
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
