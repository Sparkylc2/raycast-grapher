import { FUNCTIONS, arityRange } from "./builtins.js";
import type { EntryAnalysis } from "./document.js";
import { type Token, tokenize } from "./lexer.js";

/**
 * Hints for the line being typed, in the manner of a completion menu with tab
 * stops.
 *
 * Raycast lets an extension replace the search text but not move the cursor,
 * which always ends up at the end. So a tab stop here is the end of the text:
 * Tab appends whatever comes before the next value to type, such as `[` or
 * `, ` or `] [y(0) = `, and the hint shows what is still to come.
 *
 * Nothing is remembered between keystrokes. Where you are is read from the
 * text itself: which brackets are open, how many separators they hold, and
 * what kind of line the statement before them is. Deleting, retyping or
 * pasting can never leave a stale menu behind.
 */

export interface HintPart {
  readonly text: string;
  /** A value to type, named by `text`, rather than text Tab inserts. */
  readonly stop: boolean;
}

export interface Hint {
  /** What is being written, such as `min(expression, variable, low, high)` or a line's kind. */
  readonly title: string;
  /** What can still follow the end of the text. */
  readonly parts: readonly HintPart[];
  /** The whole text after pressing Tab, or null when Tab has nothing to add. */
  readonly next: string | null;
}

export interface HintContext {
  /** Analyses a statement as a line of the current document. */
  readonly analyze: (statement: string) => EntryAnalysis | null;
  /** Defined functions and their parameter names. */
  readonly functions?: Readonly<Record<string, readonly string[]>>;
}

const text = (value: string): HintPart => ({ text: value, stop: false });
const stop = (name: string): HintPart => ({ text: name, stop: true });

/** The hint as one line of text, with values to type in angle quotes. */
export function formatHintParts(parts: readonly HintPart[]): string {
  return parts.map((p) => (p.stop ? `‹${p.text}›` : p.text)).join("");
}

const REDUCE = ["expression", "variable", "low", "high"];
const INTEGRAL = ["expression", "variable", "low", "high"];

/** Argument names for functions whose arguments aren't just x. */
const SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  min: REDUCE,
  max: REDUCE,
  argmin: REDUCE,
  argmax: REDUCE,
  int: INTEGRAL,
  integral: INTEGRAL,
  atan2: ["y", "x"],
  log: ["x", "base"],
  mod: ["a", "b"],
  hypot: ["a", "b"],
  pow: ["base", "exponent"],
  eye: ["n"],
  zeros: ["rows", "columns"],
  ones: ["rows", "columns"],
  dot: ["u", "v"],
  cross: ["u", "v"],
  det: ["matrix"],
  inv: ["matrix"],
  trace: ["matrix"],
  transpose: ["matrix"],
  eig: ["matrix"],
  expm: ["matrix"],
  norm: ["vector"],
  re: ["z"],
  im: ["z"],
  conj: ["z"],
  arg: ["z"],
};

/** A differential such as dx or dt_1, as in the parser. */
const DIFFERENTIAL = /^[d∂]([A-Za-zͰ-Ͽ](?:_[A-Za-z0-9]+|[0-9]+)?)$/;
/** Shorthands that expand to derivative operators: ddx is d/dx(, d2dx is d^2/dx^2(. */
const DERIVATIVE_TRIGGER = /^d([2-9])?d([A-Za-z])$/;

const OPERAND_END: ReadonlySet<Token["kind"]> = new Set(["number", "ident", "rparen", "rbracket", "rbrace", "prime"]);
const CLOSERS = /^[\s,;\])}]/;

interface Frame {
  readonly kind: "paren" | "matrix" | "group" | "axes";
  readonly open: Token;
  /** The function a parenthesis calls, if any. */
  readonly name: string | null;
  readonly separators: Token[];
  hasEquals: boolean;
}

interface Group {
  readonly kind: "range" | "conditions" | "axes";
  /** Each value's text, in order, across both , and ; separators. */
  readonly items: readonly string[];
}

interface Scan {
  /** Brackets still open, innermost last. */
  readonly stack: readonly Frame[];
  /** Finished groups after the statement. */
  readonly groups: readonly Group[];
  readonly statementEnd: number;
}

interface ItemTemplate {
  /** Text before this value: its separator, and any fixed text such as `y(0) = `. */
  readonly separator: string;
  readonly prefix: string;
  readonly stop: string;
}

interface GroupTemplate {
  readonly kind: "range" | "conditions";
  readonly items: readonly ItemTemplate[];
}

interface LineTemplate {
  readonly title: string;
  readonly groups: readonly GroupTemplate[];
}

export function hintFor(source: string, context: HintContext): Hint | null {
  if (source.trim() === "") return null;
  let tokens: Token[];
  try {
    tokens = tokenize(source).filter((t) => t.kind !== "eof");
  } catch {
    return null;
  }
  const scan = scanBrackets(source, tokens);

  const last = tokens[tokens.length - 1];
  if (last?.kind === "ident" && last.end === source.length) {
    const trigger = triggerHint(source, last, context);
    if (trigger) return trigger;
  }

  const top = scan.stack[scan.stack.length - 1];
  if (top?.kind === "paren") return callHint(source, top, context);
  if (top?.kind === "matrix") {
    return { title: "matrix: , or a space between entries, ; between rows", parts: [text("]")], next: append(source, "]") };
  }
  if (top?.kind === "axes") return { title: "axes, horizontal first, like {q, p}", parts: [text("}")], next: append(source, "}") };
  if (top) return groupHint(source, scan, top, context);
  return lineHint(source, scan, context);
}

function scanBrackets(source: string, tokens: readonly Token[]): Scan {
  const stack: Frame[] = [];
  const groups: Group[] = [];
  let statementEnd: number | null = null;

  tokens.forEach((token, i) => {
    const frame = (kind: Frame["kind"], name: string | null = null): Frame => ({
      kind,
      open: token,
      name,
      separators: [],
      hasEquals: false,
    });
    switch (token.kind) {
      case "lparen":
        stack.push(frame("paren", callName(tokens, i)));
        break;
      case "lbracket": {
        // As in the parser: after a finished value a bracket is a range or conditions, otherwise a matrix.
        const previous = tokens[i - 1];
        const group = stack.length === 0 && previous !== undefined && OPERAND_END.has(previous.kind);
        if (group) statementEnd ??= token.start;
        stack.push(frame(group ? "group" : "matrix"));
        break;
      }
      case "lbrace":
        if (stack.length === 0) statementEnd ??= token.start;
        stack.push(frame("axes"));
        break;
      case "rparen":
      case "rbracket":
      case "rbrace": {
        const closed = stack.pop();
        if (closed && stack.length === 0 && (closed.kind === "group" || closed.kind === "axes")) {
          groups.push({
            kind: closed.kind === "axes" ? "axes" : closed.hasEquals ? "conditions" : "range",
            items: itemsOf(source, closed, token.start),
          });
        }
        break;
      }
      case "comma":
      case "semicolon":
        stack[stack.length - 1]?.separators.push(token);
        break;
      case "op":
        if (token.text === "=" || token.text === "==") {
          const current = stack[stack.length - 1];
          if (current) current.hasEquals = true;
        }
        break;
      default:
        break;
    }
  });
  return { stack, groups, statementEnd: statementEnd ?? source.length };
}

function itemsOf(source: string, frame: Frame, end: number): string[] {
  const cuts = [frame.open.end, ...frame.separators.flatMap((s) => [s.start, s.end]), end];
  const items: string[] = [];
  for (let k = 0; k < cuts.length; k += 2) items.push(source.slice(cuts[k], cuts[k + 1]).trim());
  return items;
}

/** The name before a parenthesis: a function, or a derivative operator like d/dx. */
function callName(tokens: readonly Token[], i: number): string | null {
  const paren = tokens[i]!;
  let j = i - 1;
  if (!tokens[j] || tokens[j]!.end !== paren.start) return null;
  while (tokens[j]?.kind === "prime") j--;
  const at = (k: number): Token | undefined => tokens[k];
  const name = at(j);
  if (name?.kind === "ident") {
    const variable = DIFFERENTIAL.exec(name.text)?.[1];
    if (variable && at(j - 1)?.text === "/" && at(j - 2)?.text === "d") return `d/d${variable}`;
    return name.text;
  }
  if (name?.kind === "number" && at(j - 1)?.text === "^") {
    const variable = DIFFERENTIAL.exec(at(j - 2)?.text ?? "")?.[1];
    if (variable && at(j - 3)?.text === "/") return `d^${name.text}/d${variable}^${name.text}`;
  }
  return null;
}

function signatureOf(name: string | null, context: HintContext): readonly string[] | null {
  if (!name) return null;
  if (name.startsWith("d/d") || name.startsWith("d^")) return ["expression"];
  const known = SIGNATURES[name] ?? context.functions?.[name];
  if (known) return known;
  const builtin = FUNCTIONS[name];
  if (!builtin) return null;
  const count = arityRange(builtin)[1];
  return count === 1 ? ["x"] : ["a", "b", "c"].slice(0, count);
}

/** Text with `insert` added, without doubling spaces before a separator or closer. */
function append(source: string, insert: string): string {
  return (CLOSERS.test(insert) ? source.replace(/\s+$/, "") : source) + insert;
}

function argumentParts(params: readonly string[], from: number): HintPart[] {
  const parts: HintPart[] = [];
  params.slice(from).forEach((param, k) => {
    if (k > 0) parts.push(text(", "));
    parts.push(stop(param));
  });
  parts.push(text(")"));
  return parts;
}

/** The text of the value being typed in a bracket: everything after its last separator. */
function currentValue(source: string, frame: Frame): string {
  const last = frame.separators[frame.separators.length - 1];
  return source.slice(last ? last.end : frame.open.end).trim();
}

function callHint(source: string, frame: Frame, context: HintContext): Hint {
  const params = signatureOf(frame.name, context);
  if (!params) return { title: "brackets", parts: [text(")")], next: append(source, ")") };
  const index = frame.separators.length;
  const title = `${frame.name}(${params.join(", ")})`;
  if (index >= params.length) return { title, parts: [text(")")], next: append(source, ")") };
  // Once a value is under way, its own name would only trail after it.
  const parts =
    currentValue(source, frame) === ""
      ? argumentParts(params, index)
      : index + 1 < params.length
        ? [text(", "), ...argumentParts(params, index + 1)]
        : [text(")")];
  return { title, parts, next: append(source, index < params.length - 1 ? ", " : ")") };
}

/** Completion for the word just typed: a function name, or ddx for d/dx(. */
function triggerHint(source: string, word: Token, context: HintContext): Hint | null {
  const before = source.slice(0, word.start);
  const derivative = DERIVATIVE_TRIGGER.exec(word.text);
  if (derivative) {
    const [, order, variable] = derivative;
    const operator = order ? `d^${order}/d${variable}^${order}` : `d/d${variable}`;
    return {
      title: `${operator}(expression)`,
      parts: [text(`${operator}(`), stop("expression"), text(")")],
      next: `${before}${operator}(`,
    };
  }

  const names = [...new Set([...Object.keys(SIGNATURES), ...Object.keys(FUNCTIONS), ...Object.keys(context.functions ?? {})])];
  let match: string | undefined;
  if (names.includes(word.text)) {
    match = word.text;
  } else if (word.text.length >= 3) {
    // Short words are usually variable names, so only longer ones complete.
    match = names.filter((n) => n.startsWith(word.text)).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  if (!match) return null;
  const params = signatureOf(match, context) ?? ["x"];
  return {
    title: `${match}(${params.join(", ")})`,
    parts: [text(`${match.slice(word.text.length)}(`), ...argumentParts(params, 0)],
    next: `${before}${match}(`,
  };
}

function rangeTemplate(axes: readonly string[]): GroupTemplate {
  return {
    kind: "range",
    items: axes.flatMap((axis, i) => [
      { separator: i === 0 ? "" : "; ", prefix: "", stop: `${axis} from` },
      { separator: ", ", prefix: "", stop: `${axis} to` },
    ]),
  };
}

const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth"];

function templateFor(entry: EntryAnalysis, groups: readonly Group[]): LineTemplate | null {
  const typed = groups.find((g) => g.kind === "range")?.items ?? [];
  const shape = entry.shape;

  if (shape?.kind === "ode") {
    const { dependent: y, independent: x, order } = shape;
    // Starting values go at 0 unless the typed range leaves 0 out.
    const lo = Number(typed[0]);
    const hi = Number(typed[1]);
    const at = typed[0] && typed[1] && Number.isFinite(lo) && Number.isFinite(hi) && (lo > 0 || hi < 0) ? typed[0] : "0";
    const conditions = Array.from({ length: Math.max(order, 1) }, (_, k): ItemTemplate => {
      const name = `${y}${"'".repeat(k)}`;
      return { separator: k === 0 ? "" : ", ", prefix: `${name}(${at}) = `, stop: `${name} at ${at}` };
    });
    return {
      title: `${ORDINALS[order] ?? `${order}th`}-order differential equation in ${y}(${x})`,
      groups: [rangeTemplate([x]), { kind: "conditions", items: conditions }],
    };
  }

  if (shape?.kind === "pde") {
    const { dependent: u, space: x, time: t, timeOrder } = shape;
    const x0 = typed[0] || "-5";
    const x1 = typed[1] || "5";
    const t0 = typed[2] || "0";
    const conditions: ItemTemplate[] = [
      { separator: "", prefix: `${u}(${x}, ${t0}) = `, stop: "starting profile" },
      ...(timeOrder === 2 ? [{ separator: ", ", prefix: `${u}_${t}(${x}, ${t0}) = `, stop: "starting velocity" }] : []),
      { separator: ", ", prefix: `${u}(${x0}, ${t}) = `, stop: "left edge" },
      { separator: ", ", prefix: `${u}(${x1}, ${t}) = `, stop: "right edge" },
    ];
    return {
      title: `PDE for ${u}(${x}, ${t})`,
      groups: [rangeTemplate([x, t]), { kind: "conditions", items: conditions }],
    };
  }

  if (entry.error) return null;
  const only = (group: GroupTemplate): LineTemplate => ({ title: entry.description, groups: [group] });
  if (entry.kind === "slider") {
    return only({
      kind: "range",
      items: [
        { separator: "", prefix: "", stop: "low" },
        { separator: ", ", prefix: "", stop: "high" },
        { separator: ", ", prefix: "", stop: "step" },
      ],
    });
  }

  // Parameter names close descriptions such as "parametric surface in u and v".
  const params = /in (\S+?)(?: and (\S+))?$/.exec(entry.description)?.slice(1).filter(Boolean) ?? [];
  const axes = entry.axes;
  switch (entry.plots[0]?.kind ?? entry.surfaces[0]?.kind) {
    case "explicit":
      return only(rangeTemplate([axes[0]!]));
    case "field":
    case "explicitSurface":
      return only(rangeTemplate(axes.slice(0, 2)));
    case "implicitSurface":
      return only(rangeTemplate(axes.slice(0, 3)));
    case "parametric":
    case "curve3d":
      return only(rangeTemplate([params[0] ?? "t"]));
    case "parametricSurface":
      return only(rangeTemplate(params.length === 2 ? params : ["u", "v"]));
    default:
      return { title: entry.description, groups: [] };
  }
}

function itemParts(items: readonly ItemTemplate[]): HintPart[] {
  return items.flatMap((item) => [text(item.separator + item.prefix), stop(item.stop)]);
}

/** A finished statement: every group the line could still take. */
function lineHint(source: string, scan: Scan, context: HintContext): Hint | null {
  const statement = source.slice(0, scan.statementEnd).trim();
  const entry = statement ? context.analyze(statement) : null;
  if (!entry) return null;
  const template = templateFor(entry, scan.groups);
  if (!template) return null;
  const missing = template.groups.filter((g) => !scan.groups.some((done) => done.kind === g.kind));
  const first = missing[0];
  return {
    title: template.title,
    parts: missing.flatMap((g) => [text(" ["), ...itemParts(g.items), text("]")]),
    next: first ? append(source, ` [${first.items[0]!.prefix}`) : null,
  };
}

/** Inside a range or condition bracket: the value being typed and what follows it. */
function groupHint(source: string, scan: Scan, frame: Frame, context: HintContext): Hint {
  const statement = source.slice(0, scan.statementEnd).trim();
  const entry = statement ? context.analyze(statement) : null;
  const template = entry ? templateFor(entry, scan.groups) : null;
  const close = (title: string): Hint => ({ title, parts: [text("]")], next: append(source, "]") });
  if (!template) return close(entry?.description || "brackets");

  const pending = template.groups.filter((g) => !scan.groups.some((done) => done.kind === g.kind));
  const group = frame.hasEquals ? pending.find((g) => g.kind === "conditions") : pending[0];
  const index = frame.separators.length;
  const item = group?.items[index];
  if (!group || !item) return close(template.title);

  const current = currentValue(source, frame);
  const later = group.items.slice(index + 1);
  const following = pending[pending.indexOf(group) + 1];
  const needsPrefix = current === "" && item.prefix !== "";
  const atStop = current === "" || current === item.prefix.trim();

  let next: string;
  if (needsPrefix) next = append(source, item.prefix);
  else if (later[0]) next = append(source, later[0].separator + later[0].prefix);
  else next = append(source, following ? `] [${following.items[0]!.prefix}` : "]");

  return {
    title: template.title,
    parts: [...(needsPrefix ? [text(item.prefix)] : []), ...(atStop ? [stop(item.stop)] : []), ...itemParts(later), text("]")],
    next,
  };
}
