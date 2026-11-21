/**
 * A small, strict reader for the gateway's server-rendered pages.
 *
 * The legacy-twin walker loads each page in a real browser on staging and then reads the
 * DOM it ended with (`page.content()`). Reading that HTML here, instead of with selectors
 * evaluated inside the browser, means the same extractor runs in unit tests against the
 * gateway's real render functions, so a page change that breaks an extractor fails CI
 * rather than a staging walk.
 *
 * It handles what the gateway and a browser's serializer emit: well-formed elements,
 * attributes, text, comments, void elements, raw-text `script`/`style`, and character
 * references. It does not repair unclosed elements; it is not a general HTML parser.
 */

export interface Element {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly Node[];
}
export type Node = Element | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", middot: "·", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

interface Building { tag: string; attrs: Map<string, string>; children: Node[] }

export function parseHtml(html: string): Element {
  const root: Building = { tag: "#root", attrs: new Map(), children: [] };
  const stack: Building[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { pushText(top(), html.slice(i)); break; }
    if (lt > i) pushText(top(), html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const tag = html.slice(lt + 2, end === -1 ? html.length : end).trim().toLowerCase();
      const at = stack.map((b) => b.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const open = /^<([a-zA-Z][\w-]*)/.exec(html.slice(lt, lt + 64));
    if (!open) { pushText(top(), "<"); i = lt + 1; continue; }
    const tag = open[1]!.toLowerCase();
    let j = lt + open[0].length;
    const attrs = new Map<string, string>();
    for (;;) {
      while (j < html.length && /\s/.test(html[j]!)) j++;
      if (j >= html.length) break;
      if (html[j] === ">") { j++; break; }
      if (html.startsWith("/>", j)) { j += 2; break; }
      const name = /^[^\s=>/]+/.exec(html.slice(j))?.[0];
      if (!name) { j++; continue; }
      j += name.length;
      while (j < html.length && /\s/.test(html[j]!)) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < html.length && /\s/.test(html[j]!)) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = html.slice(j + 1, end === -1 ? html.length : end);
          j = end === -1 ? html.length : end + 1;
        } else {
          const bare = /^[^\s>]+/.exec(html.slice(j))?.[0] ?? "";
          value = bare;
          j += bare.length;
        }
      }
      if (!attrs.has(name.toLowerCase())) attrs.set(name.toLowerCase(), decodeEntities(value));
    }
    const element: Building = { tag, attrs, children: [] };
    top().children.push(element as Element);
    if (VOID.has(tag)) { i = j; continue; }
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, j);
      const raw = html.slice(j, end === -1 ? html.length : end);
      if (tag === "textarea" || tag === "title") element.children.push(decodeEntities(raw));
      const close = end === -1 ? html.length : html.indexOf(">", end);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    stack.push(element);
    i = j;
  }
  return root as Element;
}

function pushText(into: Building, raw: string): void {
  if (raw.length > 0) into.children.push(decodeEntities(raw));
}

export function isElement(node: Node): node is Element {
  return typeof node !== "string";
}

/** Text as a reader sees it: whitespace runs collapsed, scripts and hidden inputs ignored. */
export function textOf(node: Node): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (!isElement(n)) { parts.push(n); return; }
    if (n.tag === "script" || n.tag === "style" || n.tag === "template" || n.attrs.has("hidden")) return;
    if (["br", "p", "div", "li", "dt", "dd", "h1", "h2", "h3", "h4", "tr", "section"].includes(n.tag)) parts.push(" ");
    for (const c of n.children) walk(c);
    if (["p", "div", "li", "dt", "dd", "h1", "h2", "h3", "h4", "tr", "td", "th", "section"].includes(n.tag)) parts.push(" ");
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Simple selectors only: `tag`, `#id`, `.class`, `[attr]`, `[attr="v"]`, `[attr^="v"]`, combined, with descendant (space) and child (`>`) combinators. */
export function queryAll(root: Element, selector: string): Element[] {
  const steps = parseSelector(selector);
  let current: Element[] = [root];
  for (const step of steps) {
    const next: Element[] = [];
    const seen = new Set<Element>();
    for (const from of current) {
      const candidates = step.combinator === ">" ? from.children.filter(isElement) : descendants(from);
      for (const c of candidates) if (!seen.has(c) && matches(c, step)) { seen.add(c); next.push(c); }
    }
    current = next;
  }
  return current;
}

export function query(root: Element, selector: string): Element | undefined {
  return queryAll(root, selector)[0];
}

function descendants(from: Element): Element[] {
  const out: Element[] = [];
  const walk = (e: Element) => { for (const c of e.children) if (isElement(c)) { out.push(c); walk(c); } };
  walk(from);
  return out;
}

interface Step {
  readonly combinator: " " | ">";
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly attrs: readonly { readonly name: string; readonly op: "has" | "=" | "^="; readonly value: string }[];
}

function parseSelector(selector: string): Step[] {
  const steps: Step[] = [];
  const tokens = selector.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
  let combinator: " " | ">" = " ";
  for (const token of tokens) {
    if (token === ">") { combinator = ">"; continue; }
    const m = /^([a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:\^?=(?:"[^"]*"|[^\]]*))?\])*)$/i.exec(token);
    if (!m) throw new Error(`unsupported selector: ${selector}`);
    const rest = m[2] ?? "";
    // Classes and ids are read outside attribute expressions, so `[href="/a.html"]` is not a class.
    const outside = rest.replace(/\[[\w-]+(?:\^?=(?:"[^"]*"|[^\]]*))?\]/g, "");
    const id = /#([\w-]+)/.exec(outside)?.[1] ?? null;
    const classes = [...outside.matchAll(/\.([\w-]+)/g)].map((c) => c[1]!);
    const attrs = [...rest.matchAll(/\[([\w-]+)(?:(\^?=)(?:"([^"]*)"|([^\]]*)))?\]/g)].map((a) => ({
      name: a[1]!.toLowerCase(), op: (a[2] ?? "has") as "has" | "=" | "^=", value: a[3] ?? a[4] ?? "",
    }));
    steps.push({ combinator, tag: m[1]?.toLowerCase() ?? null, id, classes, attrs });
    combinator = " ";
  }
  return steps;
}

function matches(e: Element, s: Step): boolean {
  if (s.tag && e.tag !== s.tag) return false;
  if (s.id && e.attrs.get("id") !== s.id) return false;
  if (s.classes.length > 0) {
    const have = new Set((e.attrs.get("class") ?? "").split(/\s+/));
    if (!s.classes.every((c) => have.has(c))) return false;
  }
  for (const a of s.attrs) {
    const v = e.attrs.get(a.name);
    if (v === undefined) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
  }
  return true;
}
