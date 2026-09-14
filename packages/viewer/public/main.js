// ../core/dist/theme.js
var KANAGAWA_DRAGON = {
  name: "Kanagawa Dragon",
  appearance: "dark",
  background: "#181616",
  // dragonBlack3
  surface: "#0d0c0c",
  // dragonBlack0
  grid: "#625e5a",
  // the LineNr grey; gridlines are line numbers by another name
  axis: "#a6a69c",
  // dragonGray
  text: "#a6a69c",
  // dragonGray, legible at bitmap-font sizes where the grey is not
  error: "#e46876",
  series: [
    "#8ba4b0",
    // dragonBlue2
    "#c4746e",
    // dragonRed
    "#8a9a7b",
    // dragonGreen2
    "#c4b28a",
    // dragonYellow
    "#a292a3",
    // dragonPink
    "#b6927b",
    // dragonOrange
    "#8ea4a2"
    // dragonAqua
  ]
};
var KANAGAWA_LOTUS = {
  name: "Kanagawa Lotus",
  appearance: "light",
  background: "#f2ecbc",
  surface: "#e7dba0",
  grid: "#8a8980",
  axis: "#545464",
  text: "#545464",
  error: "#c84053",
  series: ["#4d699b", "#c84053", "#6f894e", "#77713f", "#624c83", "#cc6d00", "#597b75"]
};
var DEFAULT_THEME = KANAGAWA_DRAGON;
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m)
    return [139, 164, 176];
  const n = parseInt(m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function hexToRgbUnit(hex) {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}
function seriesColor(theme2, index) {
  return theme2.series[index % theme2.series.length];
}

// ../core/dist/ast.js
var num = (value) => ({ kind: "num", value });
var binary = (op, left, right) => ({
  kind: "binary",
  op,
  left,
  right
});
function freeVars(expr, constants) {
  const out = /* @__PURE__ */ new Set();
  const add = (name) => {
    if (!constants.has(name))
      out.add(name);
  };
  const walk = (n) => {
    switch (n.kind) {
      case "num":
        return;
      case "var":
        add(n.name);
        return;
      case "unary":
        walk(n.arg);
        return;
      case "binary":
        walk(n.left);
        walk(n.right);
        return;
      case "call":
        for (const a of n.args)
          walk(a);
        return;
      case "apply":
        add(n.name);
        for (const a of n.args)
          walk(a);
        return;
      case "deriv":
        walk(n.expr);
        if (n.variable)
          add(n.variable);
        return;
      case "tuple":
        for (const item of n.items)
          walk(item);
        return;
    }
  };
  walk(expr);
  return out;
}
function someNode(expr, test) {
  if (test(expr))
    return true;
  switch (expr.kind) {
    case "num":
    case "var":
      return false;
    case "unary":
      return someNode(expr.arg, test);
    case "binary":
      return someNode(expr.left, test) || someNode(expr.right, test);
    case "call":
    case "apply":
      return expr.args.some((a) => someNode(a, test));
    case "deriv":
      return someNode(expr.expr, test);
    case "tuple":
      return expr.items.some((i) => someNode(i, test));
  }
}

// ../core/dist/builtins.js
var CONSTANTS = {
  pi: Math.PI,
  "\u03C0": Math.PI,
  tau: Math.PI * 2,
  "\u03C4": Math.PI * 2,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity
};
var CONSTANT_NAMES = new Set(Object.keys(CONSTANTS));
function realPow(a, b) {
  if (a >= 0 || Number.isInteger(b))
    return Math.pow(a, b);
  const inv = 1 / b;
  const r = Math.round(inv);
  if (Math.abs(inv - r) < 1e-9 && Math.abs(r % 2) === 1)
    return -Math.pow(-a, b);
  return NaN;
}
var floorMod = (a, b) => a - b * Math.floor(a / b);
var FUNCTIONS = {
  sin: { arity: 1, js: "Math.sin($0)", glsl: "sin($0)", fn: Math.sin },
  cos: { arity: 1, js: "Math.cos($0)", glsl: "cos($0)", fn: Math.cos },
  tan: { arity: 1, js: "Math.tan($0)", glsl: "tan($0)", fn: Math.tan },
  asin: { arity: 1, js: "Math.asin($0)", glsl: "asin($0)", fn: Math.asin },
  acos: { arity: 1, js: "Math.acos($0)", glsl: "acos($0)", fn: Math.acos },
  atan: { arity: 1, js: "Math.atan($0)", glsl: "atan($0)", fn: Math.atan },
  atan2: { arity: 2, js: "Math.atan2($0, $1)", glsl: "atan($0, $1)", fn: Math.atan2 },
  sinh: { arity: 1, js: "Math.sinh($0)", glsl: "sinh($0)", fn: Math.sinh },
  cosh: { arity: 1, js: "Math.cosh($0)", glsl: "cosh($0)", fn: Math.cosh },
  tanh: { arity: 1, js: "Math.tanh($0)", glsl: "tanh($0)", fn: Math.tanh },
  exp: { arity: 1, js: "Math.exp($0)", glsl: "exp($0)", fn: Math.exp },
  ln: { arity: 1, js: "Math.log($0)", glsl: "log($0)", fn: Math.log },
  log: {
    arity: [1, 2],
    js: "__log($0, $1)",
    glsl: "gr_log($0, $1)",
    fn: (a, b) => b === void 0 ? Math.log10(a) : Math.log(a) / Math.log(b)
  },
  sqrt: { arity: 1, js: "Math.sqrt($0)", glsl: "sqrt($0)", fn: Math.sqrt },
  cbrt: { arity: 1, js: "Math.cbrt($0)", glsl: "gr_cbrt($0)", fn: Math.cbrt },
  abs: { arity: 1, js: "Math.abs($0)", glsl: "abs($0)", fn: Math.abs },
  sign: { arity: 1, js: "Math.sign($0)", glsl: "sign($0)", fn: Math.sign },
  floor: { arity: 1, js: "Math.floor($0)", glsl: "floor($0)", fn: Math.floor },
  ceil: { arity: 1, js: "Math.ceil($0)", glsl: "ceil($0)", fn: Math.ceil },
  round: { arity: 1, js: "Math.round($0)", glsl: "floor($0 + 0.5)", fn: Math.round },
  min: { arity: 2, js: "Math.min($0, $1)", glsl: "min($0, $1)", fn: Math.min },
  max: { arity: 2, js: "Math.max($0, $1)", glsl: "max($0, $1)", fn: Math.max },
  mod: { arity: 2, js: "__mod($0, $1)", glsl: "mod($0, $1)", fn: floorMod },
  hypot: { arity: 2, js: "Math.hypot($0, $1)", glsl: "length(vec2($0, $1))", fn: Math.hypot },
  pow: { arity: 2, js: "__pow($0, $1)", glsl: "gr_pow($0, $1)", fn: realPow }
};
var FUNCTION_NAMES = new Set(Object.keys(FUNCTIONS));
function arityRange(fn) {
  return typeof fn.arity === "number" ? [fn.arity, fn.arity] : [fn.arity[0], fn.arity[1]];
}

// ../core/dist/lexer.js
var ParseError = class extends Error {
  start;
  end;
  constructor(message, start, end) {
    super(message);
    this.start = start;
    this.end = end;
    this.name = "ParseError";
  }
};
var OPERATORS = [
  "<=",
  ">=",
  "==",
  "!=",
  "+",
  "-",
  "*",
  "/",
  "^",
  "=",
  "<",
  ">"
];
var OPERATOR_ALIASES = {
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2212": "-",
  "\xD7": "*",
  "\xB7": "*",
  "\xF7": "/"
};
var SINGLE = {
  "(": "lparen",
  ")": "rparen",
  "[": "lbracket",
  "]": "rbracket",
  "{": "lbrace",
  "}": "rbrace",
  ",": "comma",
  ";": "semicolon",
  "'": "prime",
  "\u2032": "prime"
};
var isDigit = (c) => c >= "0" && c <= "9";
var isIdentStart = (c) => c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c === "_" || c.charCodeAt(0) > 127 && !(c in OPERATOR_ALIASES) && !(c in SINGLE);
var isIdentPart = (c) => isIdentStart(c) || isDigit(c);
function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (isDigit(c) || c === "." && isDigit(source[i + 1] ?? "")) {
      const start = i;
      while (i < source.length && isDigit(source[i]))
        i++;
      if (source[i] === ".") {
        i++;
        while (i < source.length && isDigit(source[i]))
          i++;
      }
      if (source[i] === "e" || source[i] === "E") {
        const save = i;
        i++;
        if (source[i] === "+" || source[i] === "-")
          i++;
        if (isDigit(source[i] ?? "")) {
          while (i < source.length && isDigit(source[i]))
            i++;
        } else {
          i = save;
        }
      }
      tokens.push({
        kind: "number",
        text: source.slice(start, i),
        start,
        end: i
      });
      continue;
    }
    const single = SINGLE[c];
    if (single) {
      tokens.push({ kind: single, text: c, start: i, end: ++i });
      continue;
    }
    const alias = OPERATOR_ALIASES[c];
    if (alias) {
      tokens.push({ kind: "op", text: alias, start: i, end: ++i });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i]))
        i++;
      tokens.push({
        kind: "ident",
        text: source.slice(start, i),
        start,
        end: i
      });
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
  tokens.push({
    kind: "eof",
    text: "",
    start: source.length,
    end: source.length
  });
  return tokens;
}

// ../core/dist/parser.js
var RELATION_OPS = /* @__PURE__ */ new Set(["=", "==", "<", ">", "<=", ">="]);
var DIFFERENTIAL = /^[d∂]([A-Za-zͰ-Ͽ](?:_[A-Za-z0-9]+|[0-9]+)?)$/;
var OPERATOR_D = /* @__PURE__ */ new Set(["d", "\u2202"]);
var Parser = class {
  tokens;
  pos = 0;
  constructor(tokens) {
    this.tokens = tokens;
  }
  peek(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  next() {
    return this.tokens[this.pos++];
  }
  isOp(text, offset = 0) {
    const t = this.peek(offset);
    return t.kind === "op" && t.text === text;
  }
  expect(kind, message) {
    const t = this.next();
    if (t.kind !== kind)
      throw new ParseError(message, t.start, t.end);
    return t;
  }
  parseEntry() {
    const statement = this.parseStatement();
    let intervals = null;
    let conditions = null;
    let axes = null;
    for (; ; ) {
      const t = this.peek();
      if (t.kind === "lbracket") {
        const group = this.parseBracketGroup();
        if (group.kind === "conditions") {
          if (conditions)
            throw new ParseError("Put all conditions in one [...]", t.start, t.end);
          conditions = group.conditions;
        } else {
          if (intervals) {
            throw new ParseError("Put all ranges in one [...], separated by ;", t.start, t.end);
          }
          intervals = group.intervals;
        }
      } else if (t.kind === "lbrace") {
        if (axes)
          throw new ParseError("Axes are already named", t.start, t.end);
        axes = this.parseAxes();
      } else if (t.kind === "eof") {
        break;
      } else {
        const what = t.kind === "rparen" ? "unmatched closing bracket" : `unexpected ${JSON.stringify(t.text)}`;
        throw new ParseError(`Could not parse: ${what}`, t.start, t.end);
      }
    }
    return { statement, intervals, conditions, axes };
  }
  parseStatement() {
    const left = this.parseAdditive();
    const t = this.peek();
    if (t.kind === "op" && RELATION_OPS.has(t.text)) {
      this.next();
      const right = this.parseAdditive();
      const op = t.text === "==" ? "=" : t.text;
      return { kind: "relation", op, left, right };
    }
    return { kind: "expr", expr: left };
  }
  parseBracketGroup() {
    const open = this.next();
    if (this.peek().kind === "rbracket") {
      throw new ParseError("Empty brackets", open.start, this.peek().end);
    }
    const rows = [];
    let row = [];
    for (; ; ) {
      const left = this.parseAdditive();
      let right = null;
      const t = this.peek();
      if (t.kind === "op" && (t.text === "=" || t.text === "==")) {
        this.next();
        right = this.parseAdditive();
      } else if (t.kind === "op" && RELATION_OPS.has(t.text)) {
        throw new ParseError("Conditions use =", t.start, t.end);
      }
      row.push({ left, right });
      const sep = this.next();
      if (sep.kind === "comma")
        continue;
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
        conditions: items.map((i) => ({ left: i.left, right: i.right }))
      };
    }
    const intervals = rows.map((r) => {
      if (r.length !== 2 && r.length !== 3) {
        throw new ParseError("A range is [low, high] or [low, high, step]; separate axes with ;", open.start, open.end);
      }
      return { lo: r[0].left, hi: r[1].left, step: r[2]?.left ?? null };
    });
    return { kind: "intervals", intervals };
  }
  parseAxes() {
    const open = this.next();
    const names = [];
    for (; ; ) {
      const t = this.expect("ident", "Axes are names, like {q, p}");
      if (FUNCTIONS[t.text] || CONSTANTS[t.text] !== void 0) {
        throw new ParseError(`${t.text} can't be an axis`, t.start, t.end);
      }
      if (names.includes(t.text))
        throw new ParseError(`${t.text} is listed twice`, t.start, t.end);
      names.push(t.text);
      const sep = this.next();
      if (sep.kind === "comma")
        continue;
      if (sep.kind === "rbrace")
        break;
      throw new ParseError("Expected , or } here", sep.start, sep.end);
    }
    if (names.length < 2 || names.length > 3) {
      throw new ParseError("Name two or three axes, like {q, p}", open.start, open.end);
    }
    return names;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().text;
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseUnary();
    for (; ; ) {
      if (this.isOp("*") || this.isOp("/")) {
        const op = this.next().text;
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
  startsImplicitFactor() {
    const t = this.peek();
    return t.kind === "number" || t.kind === "ident" || t.kind === "lparen";
  }
  parseUnary() {
    if (this.isOp("-") || this.isOp("+")) {
      const op = this.next().text;
      const arg = this.parseUnary();
      if (op === "+")
        return arg;
      if (arg.kind === "num")
        return { kind: "num", value: -arg.value };
      return { kind: "unary", op, arg };
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePrimary();
    if (this.isOp("^")) {
      this.next();
      const exponent = this.parseUnary();
      return { kind: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }
  countPrimes() {
    let primes = 0;
    while (this.peek().kind === "prime") {
      this.next();
      primes++;
    }
    return primes;
  }
  parseArgs(name) {
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
  parsePrimary() {
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
        const close2 = this.next();
        if (close2.kind !== "rparen")
          throw new ParseError("Missing closing bracket", t.start, close2.end);
        if (items.length > 3) {
          throw new ParseError("Points and parametric plots have 2 or 3 coordinates", t.start, close2.end);
        }
        return { kind: "tuple", items };
      }
      const close = this.next();
      if (close.kind !== "rparen")
        throw new ParseError("Missing closing bracket", t.start, close.end);
      return first;
    }
    if (t.kind === "ident") {
      const leibniz = this.parseLeibniz(t);
      if (leibniz)
        return leibniz;
      const name = t.text;
      const primes = this.countPrimes();
      const fn = FUNCTIONS[name];
      if (fn) {
        let args;
        if (this.peek().kind === "lparen") {
          args = this.parseArgs(t);
        } else if (this.startsImplicitFactor()) {
          args = [this.parseUnary()];
        } else {
          throw new ParseError(`${name} needs an argument`, t.start, t.end);
        }
        const [min, max] = arityRange(fn);
        if (args.length < min || args.length > max) {
          const want = min === max ? `${min}` : `${min} to ${max}`;
          throw new ParseError(`${name} takes ${want} argument${max === 1 ? "" : "s"}, got ${args.length}`, t.start, t.end);
        }
        return primes > 0 ? { kind: "apply", name, args, primes } : { kind: "call", name, args };
      }
      const constant = CONSTANTS[name];
      if (constant !== void 0 && primes === 0)
        return { kind: "num", value: constant };
      if (this.peek().kind === "lparen") {
        return { kind: "apply", name, args: this.parseArgs(t), primes };
      }
      if (primes > 0) {
        return { kind: "deriv", expr: { kind: "var", name }, variable: null, order: primes };
      }
      return { kind: "var", name };
    }
    throw new ParseError(t.kind === "eof" ? "Expression is incomplete" : `Unexpected ${JSON.stringify(t.text)}`, t.start, t.end);
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
  parseLeibniz(first) {
    const ident = (offset) => {
      const tok = this.peek(offset);
      return tok.kind === "ident" ? tok : null;
    };
    const integer = (offset) => {
      const tok = this.peek(offset);
      if (tok.kind !== "number" || !/^\d+$/.test(tok.text))
        return null;
      const value = Number(tok.text);
      return value >= 1 && value <= 8 ? value : null;
    };
    const differential = (offset) => {
      const tok = ident(offset);
      return tok ? DIFFERENTIAL.exec(tok.text)?.[1] ?? null : null;
    };
    const operand = () => {
      if (!this.startsImplicitFactor() && !this.isOp("-")) {
        const t = this.peek();
        throw new ParseError("Say what to differentiate, like d/dx x^2", t.start, t.end);
      }
      return this.parseUnary();
    };
    if (OPERATOR_D.has(first.text)) {
      const wrt2 = this.isOp("/") ? differential(1) : null;
      if (wrt2 && !this.isOp("^", 2)) {
        this.pos += 2;
        return { kind: "deriv", expr: operand(), variable: wrt2, order: 1 };
      }
      const order = this.isOp("^") ? integer(1) : null;
      if (order !== null) {
        const opVariable = differential(3);
        if (this.isOp("/", 2) && opVariable && this.isOp("^", 4) && integer(5) === order) {
          this.pos += 6;
          return { kind: "deriv", expr: operand(), variable: opVariable, order };
        }
        const target2 = ident(2);
        const variable = differential(4);
        if (target2 && !FUNCTIONS[target2.text] && this.isOp("/", 3) && variable && this.isOp("^", 5) && integer(6) === order) {
          this.pos += 7;
          return { kind: "deriv", expr: { kind: "var", name: target2.text }, variable, order };
        }
      }
      return null;
    }
    const target = DIFFERENTIAL.exec(first.text)?.[1];
    const wrt = target && this.isOp("/") ? differential(1) : null;
    if (target && wrt && !this.isOp("^", 2)) {
      this.pos += 2;
      return { kind: "deriv", expr: { kind: "var", name: target }, variable: wrt, order: 1 };
    }
    return null;
  }
};
function parseEntry(source) {
  const trimmed = source.trim();
  if (trimmed === "")
    throw new ParseError("Empty expression", 0, 0);
  return new Parser(tokenize(trimmed)).parseEntry();
}
function parse(source) {
  const entry = parseEntry(source);
  if (entry.intervals || entry.conditions || entry.axes) {
    throw new ParseError("Ranges, conditions and axes need the full document", 0, source.length);
  }
  return entry.statement;
}

// ../core/dist/classify.js
var COORDS = /* @__PURE__ */ new Set(["x", "y", "z"]);
var subtract = (left, right) => right.kind === "num" && right.value === 0 ? left : binary("-", left, right);
var negate = (e) => binary("-", num(0), e);
var isVar = (e, name) => e.kind === "var" && e.name === name;
function dimensionOf(graph) {
  return graph.type === "surface3d" || graph.type === "implicit3d" ? 3 : 2;
}
function classify(statement) {
  const sides = statement.kind === "expr" ? [statement.expr] : [statement.left, statement.right];
  if (sides.some((e) => someNode(e, (n) => n.kind === "apply" || n.kind === "deriv" || n.kind === "tuple"))) {
    throw new ParseError("Functions, derivatives and parametric plots need the full document", 0, 0);
  }
  const graph = toGraph(statement);
  const fieldExpr = graph.type === "explicit2d" || graph.type === "surface3d" ? graph.fn : graph.field;
  const vars = freeVars(fieldExpr, CONSTANT_NAMES);
  const parameters = [...vars].filter((v) => !COORDS.has(v)).sort();
  return { graph, dimension: dimensionOf(graph), parameters };
}
function toGraph(statement) {
  if (statement.kind === "expr") {
    const vars = freeVars(statement.expr, CONSTANT_NAMES);
    if (vars.has("z"))
      return { type: "implicit3d", field: statement.expr };
    if (vars.has("y"))
      return { type: "implicit2d", field: statement.expr };
    return { type: "explicit2d", fn: statement.expr };
  }
  const { op, left, right } = statement;
  if (op === "=") {
    const explicit = solveFor(left, right);
    if (explicit)
      return explicit;
    const field2 = subtract(left, right);
    const vars = freeVars(field2, CONSTANT_NAMES);
    return vars.has("z") ? { type: "implicit3d", field: field2 } : { type: "implicit2d", field: field2 };
  }
  const strict = op === "<" || op === ">";
  const raw = subtract(left, right);
  const field = op === "<" || op === "<=" ? raw : negate(raw);
  if (freeVars(field, CONSTANT_NAMES).has("z")) {
    throw new ParseError("3D inequalities are not supported yet", 0, 0);
  }
  return { type: "inequality2d", field, strict };
}
function solveFor(left, right) {
  for (const [a, b] of [
    [left, right],
    [right, left]
  ]) {
    const other = freeVars(b, CONSTANT_NAMES);
    if (isVar(a, "y") && !other.has("y") && !other.has("z")) {
      return { type: "explicit2d", fn: b };
    }
    if (isVar(a, "z") && !other.has("z")) {
      return { type: "surface3d", fn: b };
    }
  }
  return null;
}

// ../core/dist/compile-glsl.js
var GLSL_PRELUDE = `
float gr_nan() { return uintBitsToFloat(0x7fc00000u); }

float gr_cbrt(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }

// pow() is undefined for negative bases, but graphs need x^3 and x^(1/3) to
// behave, so integer powers and odd integer roots are handled explicitly.
float gr_pow(float a, float b) {
  if (a >= 0.0) return pow(a, b);
  float n = floor(b + 0.5);
  if (abs(b - n) < 1e-6) {
    float m = pow(-a, b);
    return mod(abs(n), 2.0) < 0.5 ? m : -m;
  }
  float inv = 1.0 / b;
  float k = floor(inv + 0.5);
  if (abs(inv - k) < 1e-6 && mod(abs(k), 2.0) > 0.5) return -pow(-a, b);
  return gr_nan();
}
`;
function glslFloat(value) {
  if (Number.isNaN(value))
    return "gr_nan()";
  if (!Number.isFinite(value))
    return value > 0 ? "3.402823e+38" : "-3.402823e+38";
  if (Number.isInteger(value) && Math.abs(value) < 1e7)
    return `${value}.0`;
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}
var fill = (template, args) => template.replace(/\$(\d+)/g, (_, i) => args[Number(i)] ?? "0.0");
function toGlslSource(expr, options = {}) {
  const prefix = options.uniformPrefix ?? "u_";
  const go = (n) => {
    switch (n.kind) {
      case "num":
        return glslFloat(n.value);
      case "var":
        return n.name === "x" || n.name === "y" || n.name === "z" ? n.name : `${prefix}${n.name}`;
      case "unary":
        return `(-${go(n.arg)})`;
      case "binary": {
        const l = go(n.left);
        const r = go(n.right);
        return n.op === "^" ? `gr_pow(${l}, ${r})` : `(${l} ${n.op} ${r})`;
      }
      case "call": {
        const args = n.args.map(go);
        if (n.name === "log") {
          return args.length === 1 ? `(log(${args[0]}) / 2.302585092994046)` : `(log(${args[0]}) / log(${args[1]}))`;
        }
        const fn = FUNCTIONS[n.name];
        if (fn.glsl === null) {
          throw new Error(`${n.name} cannot be evaluated on the GPU`);
        }
        return fill(fn.glsl, args);
      }
      case "apply":
      case "deriv":
      case "tuple":
        throw new Error("Resolve functions, derivatives and tuples before compiling to GLSL");
    }
  };
  return go(expr);
}

// ../core/dist/camera.js
var DEFAULT_CAMERA_2D = { cx: 0, cy: 0, spanY: 10 };
var DEFAULT_CAMERA_3D = {
  target: [0, 0, 0],
  distance: 14,
  yaw: Math.PI * 0.25,
  pitch: Math.PI * 0.18,
  fovY: Math.PI / 4
};
var PITCH_LIMIT = Math.PI / 2 - 1e-3;
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function panBy(camera2, dxWorld, dyWorld) {
  return { ...camera2, cx: camera2.cx - dxWorld, cy: camera2.cy - dyWorld };
}
function zoomAbout(camera2, factor, anchorX, anchorY) {
  const spanY = clamp(camera2.spanY * factor, 1e-9, 1e9);
  const k = spanY / camera2.spanY;
  return {
    spanY,
    cx: anchorX + (camera2.cx - anchorX) * k,
    cy: anchorY + (camera2.cy - anchorY) * k
  };
}
function bounds2D(camera2, aspect) {
  const halfY = camera2.spanY / 2;
  const halfX = halfY * aspect;
  return {
    minX: camera2.cx - halfX,
    maxX: camera2.cx + halfX,
    minY: camera2.cy - halfY,
    maxY: camera2.cy + halfY
  };
}

// ../core/dist/scene.js
var SERIES_COLORS = DEFAULT_THEME.series;
function emptyScene() {
  return {
    version: 1,
    mode: "2d",
    expressions: [],
    camera2d: DEFAULT_CAMERA_2D,
    camera3d: DEFAULT_CAMERA_3D,
    parameters: {}
  };
}
function parseScene(raw) {
  const base = emptyScene();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof data !== "object" || data === null)
    return base;
  const d = data;
  return {
    version: 1,
    mode: d.mode === "3d" ? "3d" : "2d",
    expressions: Array.isArray(d.expressions) ? d.expressions.filter(isExpressionEntry) : base.expressions,
    camera2d: { ...base.camera2d, ...d.camera2d ?? {} },
    camera3d: { ...base.camera3d, ...d.camera3d ?? {} },
    parameters: typeof d.parameters === "object" && d.parameters !== null ? d.parameters : {}
  };
}
function isExpressionEntry(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const e = value;
  return typeof e.id === "string" && typeof e.source === "string";
}

// ../core/dist/font.js
var GLYPH_WIDTH = 5;
var GLYPH_ADVANCE = GLYPH_WIDTH + 1;

// ../core/dist/render.js
function niceStep(span, pixels, targetPx = 70) {
  const target = span / Math.max(pixels, 1) * targetPx;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const norm = target / magnitude;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
}

// ../core/dist/typeface.js
var EMPTY_GLYPH = { width: 0, height: 0, left: 0, top: 0, coverage: new Float32Array(0) };

// ../core/dist/ode.js
var SCAN = (() => {
  const count = 96;
  const reach = Math.asinh(1e3);
  return Float64Array.from({ length: count }, (_, i) => Math.sinh(-reach + 2 * reach * i / (count - 1)));
})();

// ../core/dist/document.js
var TWO_PI = 2 * Math.PI;

// ../core/dist/render3d.js
var DEFAULT_ORBIT = {
  target: [0, 0, 0],
  distance: 5.4,
  yaw: -Math.PI / 3,
  pitch: 0.5,
  fovY: Math.PI / 4
};

// src/gl.ts
function createProgram(gl2, vertex, fragment2) {
  const program = gl2.createProgram();
  for (const [type, source] of [
    [gl2.VERTEX_SHADER, vertex],
    [gl2.FRAGMENT_SHADER, fragment2]
  ]) {
    const shader = gl2.createShader(type);
    gl2.shaderSource(shader, source);
    gl2.compileShader(shader);
    if (!gl2.getShaderParameter(shader, gl2.COMPILE_STATUS)) {
      const log = gl2.getShaderInfoLog(shader) ?? "unknown shader error";
      gl2.deleteShader(shader);
      throw new Error(log.trim());
    }
    gl2.attachShader(program, shader);
    gl2.deleteShader(shader);
  }
  gl2.linkProgram(program);
  if (!gl2.getProgramParameter(program, gl2.LINK_STATUS)) {
    throw new Error(gl2.getProgramInfoLog(program) ?? "link failed");
  }
  return program;
}
var VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// src/shaders.ts
var CURVE_BODY = `
  float v = field(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  float g = length(vec2(dFdx(v), dFdy(v)));
  if (g < 1e-20) discard;
  float d = abs(v) / g;
  float a = 1.0 - smoothstep(u_width - 1.0, u_width + 1.0, d);
  if (a <= 0.0) discard;
  fragColor = vec4(u_color, a);
`;
var REGION_BODY = `
  float v = field(p.x, p.y);
  if (isnan(v)) discard;
  float g = length(vec2(dFdx(v), dFdy(v)));
  float d = g > 1e-20 ? v / g : (v < 0.0 ? -1e9 : 1e9);
  float inside = 1.0 - smoothstep(-1.0, 1.0, d);
  float edge = u_strict > 0.5 ? 0.0 : 1.0 - smoothstep(u_width - 1.0, u_width + 1.0, abs(d));
  float a = max(inside * 0.2, edge);
  if (a <= 0.0) discard;
  fragColor = vec4(u_color, a);
`;
function fragment(fieldSource, body) {
  return `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_bounds;
uniform vec3 u_color;
uniform float u_width;
uniform float u_strict;
out vec4 fragColor;
${GLSL_PRELUDE}
float field(float x, float y) {
  return ${fieldSource};
}
void main() {
  vec2 p = mix(u_bounds.xy, u_bounds.zw, gl_FragCoord.xy / u_resolution);
${body}
}`;
}
function fragmentFor(graph) {
  switch (graph.type) {
    case "explicit2d":
      return fragment(`y - (${toGlslSource(graph.fn)})`, CURVE_BODY);
    case "implicit2d":
      return fragment(toGlslSource(graph.field), CURVE_BODY);
    case "inequality2d":
      return fragment(toGlslSource(graph.field), REGION_BODY);
    default:
      return null;
  }
}
var GRID_FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_bounds;
uniform float u_step;
uniform vec3 u_grid;
uniform vec3 u_axis;
out vec4 fragColor;

// Distance in pixels from p to the nearest multiple of the step on each axis.
vec2 gridDistance(vec2 p, vec2 unitsPerPixel, float step) {
  vec2 m = abs(mod(p + 0.5 * step, step) - 0.5 * step);
  return m / unitsPerPixel;
}

void main() {
  vec2 p = mix(u_bounds.xy, u_bounds.zw, gl_FragCoord.xy / u_resolution);
  vec2 unitsPerPixel = (u_bounds.zw - u_bounds.xy) / u_resolution;

  float minor = 1.0 - smoothstep(0.0, 1.0, min(gridDistance(p, unitsPerPixel, u_step).x,
                                               gridDistance(p, unitsPerPixel, u_step).y));
  vec2 major = gridDistance(p, unitsPerPixel, u_step * 5.0);
  float bold = 1.0 - smoothstep(0.0, 1.0, min(major.x, major.y));
  vec2 axisPx = abs(p) / unitsPerPixel;
  float axis = 1.0 - smoothstep(0.0, 1.4, min(axisPx.x, axisPx.y));

  // Kept in step with the CPU renderer's gridline alphas on purpose: the two
  // surfaces are meant to produce the same picture.
  float a = max(minor * 0.3, bold * 0.55);
  vec3 color = mix(u_grid, u_axis, axis);
  a = max(a, axis * 0.9);
  if (a <= 0.0) discard;
  fragColor = vec4(color, a);
}`;
var gridStep = niceStep;

// src/main.ts
var prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
var themeFor = (dark) => dark ? KANAGAWA_DRAGON : KANAGAWA_LOTUS;
var theme = themeFor(prefersDark.matches);
var canvas = document.querySelector("#stage");
var hud = document.querySelector("#hud");
var gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
if (!gl) {
  hud.innerHTML = `<span id="err">WebGL2 is unavailable in this window.</span>`;
  throw new Error("WebGL2 unavailable");
}
var scene = readScene();
var camera = scene.camera2d;
var layers = [];
var errors = [];
var cursor = null;
var needsDraw = true;
function readScene() {
  const hash = location.hash.slice(1);
  if (hash) return parseScene(decodeURIComponent(hash));
  const demo = ["y = sin(x) + 0.4 x", "x^2 + y^2 = 9", "3x + 5 = 7", "y < 0.3 x^2 - 4"];
  return {
    ...emptyScene(),
    expressions: demo.map((source, i) => ({
      id: String(i),
      source,
      color: seriesColor(theme, i),
      visible: true
    }))
  };
}
function rebuild() {
  for (const layer of layers) gl.deleteProgram(layer.program);
  layers = [];
  errors = [];
  for (const entry of scene.expressions) {
    if (!entry.visible) continue;
    try {
      const { graph } = classify(parse(entry.source));
      const fragment2 = fragmentFor(graph);
      if (!fragment2) {
        errors.push(`${entry.source} \u2014 3D rendering is not wired up yet`);
        continue;
      }
      layers.push({
        source: entry.source,
        program: createProgram(gl, VERTEX_SHADER, fragment2),
        color: hexToRgbUnit(entry.color),
        strict: graph.type === "inequality2d" && graph.strict
      });
    } catch (error) {
      errors.push(`${entry.source} \u2014 ${error.message}`);
    }
  }
  needsDraw = true;
}
var gridProgram = createProgram(gl, VERTEX_SHADER, GRID_FRAGMENT);
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    needsDraw = true;
  }
}
function draw() {
  resize();
  if (!needsDraw) return;
  needsDraw = false;
  const { width, height } = canvas;
  const aspect = width / height;
  const b = bounds2D(camera, aspect);
  const boundsVec = [b.minX, b.minY, b.maxX, b.maxY];
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(gridProgram);
  setCommon(gridProgram, width, height, boundsVec);
  gl.uniform1f(gl.getUniformLocation(gridProgram, "u_step"), gridStep(camera.spanY, height));
  gl.uniform3fv(gl.getUniformLocation(gridProgram, "u_grid"), new Float32Array(hexToRgbUnit(theme.grid)));
  gl.uniform3fv(gl.getUniformLocation(gridProgram, "u_axis"), new Float32Array(hexToRgbUnit(theme.axis)));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  for (const layer of layers) {
    gl.useProgram(layer.program);
    setCommon(layer.program, width, height, boundsVec);
    gl.uniform3fv(gl.getUniformLocation(layer.program, "u_color"), new Float32Array(layer.color));
    gl.uniform1f(gl.getUniformLocation(layer.program, "u_width"), 1.6);
    gl.uniform1f(gl.getUniformLocation(layer.program, "u_strict"), layer.strict ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  updateHud();
}
function setCommon(program, width, height, bounds) {
  gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), width, height);
  gl.uniform4f(
    gl.getUniformLocation(program, "u_bounds"),
    bounds[0],
    bounds[1],
    bounds[2],
    bounds[3]
  );
}
function updateHud() {
  const lines = layers.map((l) => l.source);
  if (cursor) lines.push(`(${cursor.x.toFixed(3)}, ${cursor.y.toFixed(3)})`);
  const errorHtml = errors.length ? `
<span id="err">${errors.map(escapeHtml).join("\n")}</span>` : "";
  hud.innerHTML = escapeHtml(lines.join("\n")) + errorHtml;
}
var escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
function toWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const b = bounds2D(camera, rect.width / rect.height);
  return {
    x: b.minX + (clientX - rect.left) / rect.width * (b.maxX - b.minX),
    y: b.maxY - (clientY - rect.top) / rect.height * (b.maxY - b.minY)
  };
}
var dragging = null;
canvas.addEventListener("pointerdown", (event) => {
  dragging = toWorld(event.clientX, event.clientY);
  canvas.classList.add("dragging");
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  cursor = toWorld(event.clientX, event.clientY);
  if (dragging) {
    camera = panBy(camera, cursor.x - dragging.x, cursor.y - dragging.y);
    dragging = toWorld(event.clientX, event.clientY);
    persist();
  }
  needsDraw = true;
});
for (const type of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(type, () => {
    dragging = null;
    canvas.classList.remove("dragging");
  });
}
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const anchor = toWorld(event.clientX, event.clientY);
    camera = zoomAbout(camera, Math.exp(event.deltaY * 2e-3), anchor.x, anchor.y);
    needsDraw = true;
    persist();
  },
  { passive: false }
);
var persistTimer = 0;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    scene = { ...scene, camera2d: camera };
    history.replaceState(null, "", `#${encodeURIComponent(JSON.stringify(scene))}`);
  }, 250);
}
window.addEventListener("hashchange", () => {
  scene = readScene();
  camera = scene.camera2d;
  rebuild();
});
prefersDark.addEventListener("change", (event) => {
  theme = themeFor(event.matches);
  applyThemeToPage();
  needsDraw = true;
});
function applyThemeToPage() {
  const root = document.documentElement.style;
  root.setProperty("--ground", theme.background);
  root.setProperty("--panel", theme.surface);
  root.setProperty("--ink", theme.text);
  root.setProperty("--error", theme.error);
}
applyThemeToPage();
rebuild();
(function loop() {
  draw();
  requestAnimationFrame(loop);
})();
