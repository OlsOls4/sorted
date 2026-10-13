// A tiny, safe markdown subset for assistant chat messages. It returns plain data (no HTML strings),
// so the React renderer only ever emits text nodes: raw HTML in a model reply is shown as text.
// Supported: GFM tables, bullet and numbered lists, "#" headings, **bold**, `code`, blank-line gaps.

export type Inline = { kind: "text" | "bold" | "code"; text: string };
export type Align = "left" | "center" | "right";
export type Block =
  | { type: "p"; inline: Inline[] }
  | { type: "h"; inline: Inline[] }
  | { type: "li"; marker: string | null; inline: Inline[] }
  | { type: "table"; header: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { type: "gap" };

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ kind: "text", text: s.slice(last, m.index) });
    if (m[3] !== undefined) out.push({ kind: "code", text: m[3] });
    else out.push({ kind: "bold", text: (m[1] ?? m[2]).replace(/\*\*/g, "") });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: "text", text: s.slice(last) });
  return out.length ? out : [{ kind: "text", text: "" }];
}

/** Split a table row on unescaped pipes, dropping the optional leading and trailing pipe. */
export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const SEP_CELL = /^:?-{1,}:?$/;
const isSeparator = (line: string) => {
  if (!line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => SEP_CELL.test(c.replace(/\s+/g, "")));
};
const looksLikeRow = (line: string) => line.includes("|") && line.trim().length > 1;

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1].type !== "gap") blocks.push({ type: "gap" });
      continue;
    }
    // GFM table: a header row, then a separator row like |---|:--:|
    if (looksLikeRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]).map((c) => {
        const t = c.replace(/\s+/g, "");
        return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : "left";
      });
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && looksLikeRow(lines[i]) && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length).map(parseInline));
        i++;
      }
      i--;
      blocks.push({ type: "table", header: header.map(parseInline), align: header.map((_, k) => align[k] ?? "left"), rows });
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      blocks.push({ type: "h", inline: parseInline(h[1]) });
      continue;
    }
    const li = /^\s*(?:([•\-*+])|(\d+[.)]))\s+(.*)$/.exec(line);
    if (li) {
      blocks.push({ type: "li", marker: li[2] ? li[2].replace(")", ".") : null, inline: parseInline(li[3]) });
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue; // horizontal rule
    blocks.push({ type: "p", inline: parseInline(line) });
  }
  while (blocks.length && blocks[blocks.length - 1].type === "gap") blocks.pop();
  return blocks;
}
