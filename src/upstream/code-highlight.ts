// OpenIDEA v0.1.46, editor/lsp/markdown.ts. Apache-2.0. See NOTICE.
import { LanguageDescription, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightTree } from "@lezer/highlight";

const langCache = new Map<string, LanguageDescription | null>();

function findLanguage(name: string): LanguageDescription | null {
  const key = name.toLowerCase();
  if (!langCache.has(key)) langCache.set(key, LanguageDescription.matchLanguageName(languages, key, true));
  return langCache.get(key) ?? null;
}

export interface CodeToken {
  from: number;
  to: number;
  /** Lezer `classHighlighter` classes (`tok-string` …). */
  cls: string;
}

/** Highlighted ranges of `text`; empty when the language is unknown or its grammar fails to load. */
export async function highlightTokens(text: string, language: string | null): Promise<CodeToken[]> {
  return (await codeHighlighter(text, language))?.(0, text.length) ?? [];
}

/**
 * Parses `text` once; the result gives the highlighted ranges (positions in
 * `text`) between `from` and `to`, so a line is coloured with the whole file
 * as context. Null when the language is unknown or its grammar fails to load.
 */
export async function codeHighlighter(
  text: string,
  language: string | null,
): Promise<((from: number, to: number) => CodeToken[]) | null> {
  const desc = language ? findLanguage(language) : null;
  if (!desc) return null;
  try {
    const support = desc.support ?? (await desc.load());
    const tree = await parseSliced(support.language.parser, text);
    return (from, to) => {
      const out: CodeToken[] = [];
      highlightTree(
        tree,
        classHighlighter,
        (a, b, cls) => {
          const s = Math.max(a, from);
          const e = Math.min(b, to);
          if (e > s) out.push({ from: s, to: e, cls });
        },
        from,
        to,
      );
      return out;
    };
  } catch {
    return null;
  }
}

/** Parse budget per task: a whole file (up to ~1s) yields to input and rendering in between. */
const PARSE_SLICE_MS = 8;

async function parseSliced(parser: Language["parser"], text: string): Promise<ReturnType<Language["parser"]["parse"]>> {
  const parse = parser.startParse(text);
  for (;;) {
    const start = performance.now();
    while (performance.now() - start < PARSE_SLICE_MS) {
      const tree = parse.advance();
      if (tree) return tree;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Replaces `el`'s text with highlighted spans (no-op when the language is unknown). */
export async function highlightInto(el: HTMLElement, text: string, language: string | null): Promise<void> {
  const tokens = await highlightTokens(text, language);
  if (!tokens.length) return;
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const t of tokens) {
    if (t.from > pos) frag.appendChild(document.createTextNode(text.slice(pos, t.from)));
    const span = document.createElement("span");
    span.className = t.cls;
    span.textContent = text.slice(t.from, t.to);
    frag.appendChild(span);
    pos = t.to;
  }
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  el.replaceChildren(frag);
}
