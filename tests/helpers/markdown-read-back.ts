/**
 * @fileoverview Reads `content[]` Markdown the way a client renders it: a
 * markdown-it 15 parse (GFM tables, raw HTML on) turned back into the text a
 * reader sees. Live syntax — emphasis, a link, raw HTML, a code span — reads
 * back as a `⟦token⟧` marker, so a value that rendered as anything but itself
 * fails a comparison against the value it came from.
 * @module tests/helpers/markdown-read-back
 */
import MarkdownIt, { type Token } from 'markdown-it';

/**
 * One value holding most of what a parse can misread: edge spaces, a pipe,
 * emphasis, a code span, a link, raw HTML, an entity, a hash, a backslash before
 * a CRLF, a list marker opening the next line, and a trailing backslash.
 */
export const HOSTILE_VALUE = '  A|B *em* _u_ `c` [l](u) <b>x</b> &amp; # \\\r\n- next\\';

/** Raw HTML on, so an unescaped tag surfaces as an `html_inline` token instead of text. */
const parser = new MarkdownIt('default', { html: true });

/** One parsed GFM table: header cells and body rows, each cell read back. */
export interface ReadTable {
  header: string[];
  rows: string[][];
}

/**
 * The text an inline token's children render. A line break of either kind
 * reads as LF; a code span and raw HTML carry their content inside the marker.
 */
export function readInline(children: readonly Token[]): string {
  return children
    .map((token) => {
      switch (token.type) {
        case 'text':
          return token.content;
        case 'softbreak':
        case 'hardbreak':
          return '\n';
        case 'code_inline':
        case 'html_inline':
          return `⟦${token.type}:${token.content}⟧`;
        default:
          return `⟦${token.type}⟧`;
      }
    })
    .join('');
}

/** The token stream a client's parse of `markdown` produces, for structural assertions. */
export function parseMarkdown(markdown: string): Token[] {
  return parser.parse(markdown, {});
}

/** Every inline run in `markdown` — a heading's text, a list item's, a cell's — read back in document order. */
export function readInlines(markdown: string): string[] {
  return parser
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .map((token) => readInline(token.children ?? []));
}

/** Every GFM table in `markdown`, in document order. */
export function readTables(markdown: string): ReadTable[] {
  const tables: ReadTable[] = [];
  let current: ReadTable | undefined;
  let row: string[] | undefined;
  let inHead = false;
  for (const token of parser.parse(markdown, {})) {
    switch (token.type) {
      case 'table_open':
        current = { header: [], rows: [] };
        break;
      case 'thead_open':
        inHead = true;
        break;
      case 'thead_close':
        inHead = false;
        break;
      case 'tr_open':
        row = [];
        break;
      case 'tr_close':
        if (current && row) {
          if (inHead) current.header = row;
          else current.rows.push(row);
        }
        row = undefined;
        break;
      case 'inline':
        row?.push(readInline(token.children ?? []));
        break;
      case 'table_close':
        if (current) tables.push(current);
        current = undefined;
        break;
    }
  }
  return tables;
}

/** The read-back text of every top-level paragraph in `markdown`. */
export function readParagraphs(markdown: string): string[] {
  const paragraphs: string[] = [];
  let depth = 0;
  const tokens = parser.parse(markdown, {});
  tokens.forEach((token, i) => {
    if (token.type === 'blockquote_open') depth++;
    if (token.type === 'blockquote_close') depth--;
    if (token.type === 'paragraph_open' && depth === 0) {
      paragraphs.push(readInline(tokens[i + 1]?.children ?? []));
    }
  });
  return paragraphs;
}

/** The read-back text of every top-level block quote, its paragraphs joined by a blank line. */
export function readBlockquotes(markdown: string): string[] {
  const quotes: string[] = [];
  let depth = 0;
  let paragraphs: string[] = [];
  const tokens = parser.parse(markdown, {});
  tokens.forEach((token, i) => {
    if (token.type === 'blockquote_open' && depth++ === 0) paragraphs = [];
    if (token.type === 'blockquote_close' && --depth === 0) quotes.push(paragraphs.join('\n\n'));
    if (token.type === 'paragraph_open' && depth === 1) {
      paragraphs.push(readInline(tokens[i + 1]?.children ?? []));
    }
  });
  return quotes;
}

/** The content of every fenced code block, with the line feed before the closing fence. */
export function readFences(markdown: string): string[] {
  return parser
    .parse(markdown, {})
    .filter((token) => token.type === 'fence')
    .map((token) => token.content);
}

/** Every text block of a `content[]` array, concatenated as a client that joins them shows them. */
export function contentText(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}
