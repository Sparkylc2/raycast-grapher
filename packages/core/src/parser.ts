import type { BinaryOp, Expr, RelationOp, Statement } from "./ast.js";
import { CONSTANTS, FUNCTIONS, arityRange } from "./builtins.js";
import { ParseError, type Token, tokenize } from "./lexer.js";

const RELATION_OPS: ReadonlySet<string> = new Set(["=", "==", "<", ">", "<=", ">="]);

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

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.text === text;
  }

  parseStatement(): Statement {
    const left = this.parseAdditive();
    const t = this.peek();

    if (t.kind === "op" && RELATION_OPS.has(t.text)) {
      this.next();
      const right = this.parseAdditive();
      this.expectEnd();
      const op = (t.text === "==" ? "=" : t.text) as RelationOp;
      return { kind: "relation", op, left, right };
    }

    this.expectEnd();
    return { kind: "expr", expr: left };
  }

  private expectEnd(): void {
    const t = this.peek();
    if (t.kind !== "eof") {
      const what = t.kind === "rparen" ? "unmatched closing bracket" : `unexpected ${JSON.stringify(t.text)}`;
      throw new ParseError(`Could not parse: ${what}`, t.start, t.end);
    }
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
      const inner = this.parseAdditive();
      const close = this.next();
      if (close.kind !== "rparen") {
        throw new ParseError("Missing closing bracket", t.start, close.end);
      }
      return inner;
    }

    if (t.kind === "ident") {
      const name = t.text;
      const fn = FUNCTIONS[name];

      if (fn) {
        const [min, max] = arityRange(fn);
        let args: Expr[];

        if (this.peek().kind === "lparen") {
          this.next();
          args = [];
          if (this.peek().kind !== "rparen") {
            args.push(this.parseAdditive());
            while (this.peek().kind === "comma") {
              this.next();
              args.push(this.parseAdditive());
            }
          }
          const close = this.next();
          if (close.kind !== "rparen") {
            throw new ParseError(`Missing closing bracket for ${name}`, t.start, close.end);
          }
        } else if (this.startsImplicitFactor()) {
          // Bare application, e.g. `sin x` or `sqrt 2`.
          args = [this.parseUnary()];
        } else {
          throw new ParseError(`${name} needs an argument`, t.start, t.end);
        }

        if (args.length < min || args.length > max) {
          const want = min === max ? `${min}` : `${min} to ${max}`;
          throw new ParseError(
            `${name} takes ${want} argument${max === 1 ? "" : "s"}, got ${args.length}`,
            t.start,
            t.end,
          );
        }
        return { kind: "call", name, args };
      }

      const constant = CONSTANTS[name];
      if (constant !== undefined) return { kind: "num", value: constant };

      return { kind: "var", name };
    }

    throw new ParseError(
      t.kind === "eof" ? "Expression is incomplete" : `Unexpected ${JSON.stringify(t.text)}`,
      t.start,
      t.end,
    );
  }
}

export function parse(source: string): Statement {
  const trimmed = source.trim();
  if (trimmed === "") throw new ParseError("Empty expression", 0, 0);
  return new Parser(tokenize(trimmed)).parseStatement();
}

export { ParseError } from "./lexer.js";
