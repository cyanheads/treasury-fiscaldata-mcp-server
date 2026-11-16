/**
 * @fileoverview Encoders that put text the tools did not author — upstream
 * values, column names, caller input — into `content[]` Markdown so a GFM parse
 * reads it back exactly as `structuredContent` carries it.
 * @module mcp-server/tools/markdown-encoding
 */

import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * `value` as one line of inline Markdown that reads back byte for byte in any
 * inline slot: a GFM table cell or header cell, after a label, an ATX heading,
 * a list item, a block quote. Each line goes through `escapeMarkdownInline`,
 * and each line break is written as its numeric reference (`&#10;`, `&#13;`).
 * The escaper alone writes a break as a hard break, which ends a table row or a
 * heading, and reads CR and CRLF back as LF; a `<br>` reads back as the tag.
 */
export function markdownValue(value: string): string {
  return value
    .split(/(\r\n|\r|\n)/)
    .map((part, i) =>
      i % 2 === 0 ? escapeMarkdownInline(part) : part.replace('\r', '&#13;').replace('\n', '&#10;'),
    )
    .join('');
}

/**
 * `value` as a code literal an agent can copy back into a call with no escape
 * to strip: a code span whose delimiter outgrows the value's longest backtick
 * run (nothing at all for the empty value), or, for a value holding a line
 * break — which a span reads back as a space — a fenced block on lines of its
 * own. A fence reads CR and CRLF back as LF.
 */
export function codeLiteral(value: string): string {
  if (!/[\r\n]/.test(value)) return markdown().inlineCode(value).build();
  return `\n${markdown().codeBlock(value).build()}\n`;
}

/**
 * An enrichment `notice` as the one-line block quote the framework would
 * render, with the notice encoded by {@link markdownValue}. The framework quotes
 * a notice as live Markdown, and these notices embed caller and upstream text —
 * an endpoint path, a security type, a country name. Escaping here, at render
 * time, leaves `structuredContent.notice` exactly as composed.
 */
export function quotedNotice(notice: string): string {
  return `> ${markdownValue(notice)}`;
}
