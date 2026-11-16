/**
 * @fileoverview Tests for the `content[]` Markdown encoders: every value class
 * read back through a real GFM parse in each slot the tools put it in, and the
 * encoders' cost held linear in the input.
 * @module tests/tools/markdown-encoding.test
 */

import { describe, expect, it } from 'vitest';
import { codeLiteral, markdownValue, quotedNotice } from '@/mcp-server/tools/markdown-encoding.js';
import {
  readBlockquotes,
  readFences,
  readInlines,
  readParagraphs,
  readTables,
} from '../helpers/markdown-read-back.js';

/** Each `\\` is one literal backslash in the value. */
const VALUE_CLASSES: [string, string][] = [
  ['a pipe', 'A|B'],
  ['a backslash before a star', 'x\\*y'],
  ['a backslash before a pipe', 'x\\|y'],
  ['backticks', 'a`b`c'],
  ['emphasis', '*a* and _b_'],
  ['a link', '[x](y)'],
  ['an autolink', '<https://example.com>'],
  ['raw HTML', '<b>x</b>'],
  ['strikethrough', '~~s~~'],
  ['an entity-shaped run', 'AT&amp;T'],
  ['named and numeric references', '&amp; &copy; &#38;'],
  ['edge spaces', '  lead and trail  '],
  ['edge tabs and non-breaking spaces', '\t\u00a0x\u00a0\t'],
  ['a trailing backslash', 'C:\\tmp\\'],
  ['a closing ATX sequence', 'abc #'],
  ['a heading marker', '# h'],
  ['a list marker', '- item'],
  ['an ordered list marker', '1. one'],
  ['a quote marker', '> q'],
  ['a thematic break', '---'],
  ['a table delimiter', ':-'],
  ['an LF', 'line1\nline2'],
  ['a lone CR', 'line1\rline2'],
  ['a CRLF', 'line1\r\nline2'],
  ['line breaks at the edges and in a row', '\nmid\n\n'],
  ['block markers on later lines', 'a\n# b\n- c\n> d\n    e'],
  ['non-ASCII text', 'Côte d’Ivoire — 50%'],
  ['the empty string', ''],
];

describe('markdownValue', () => {
  it.each(VALUE_CLASSES)('reads %s back exactly in a table cell and a header cell', (_, value) => {
    const cell = markdownValue(value);
    const [table] = readTables(
      `| left | ${cell} | right |\n| --- | --- | --- |\n| l | ${cell} | r |`,
    );

    expect(table?.header).toEqual(['left', value, 'right']);
    expect(table?.rows).toEqual([['l', value, 'r']]);
  });

  it.each(VALUE_CLASSES)('reads %s back exactly after a label', (_, value) => {
    expect(readParagraphs(`**Label:** ${markdownValue(value)} (after)`)).toEqual([
      `⟦strong_open⟧Label:⟦strong_close⟧ ${value} (after)`,
    ]);
  });

  it.each(VALUE_CLASSES)('reads %s back exactly as a heading and in a list item', (_, value) => {
    const encoded = markdownValue(value);

    expect(readInlines(`### ${encoded}\n- Label: ${encoded} (after)`)).toEqual([
      value,
      `Label: ${value} (after)`,
    ]);
  });

  it('writes no raw line break, so a table row cannot end inside a value', () => {
    expect(markdownValue('a\nb\rc\r\nd')).not.toMatch(/[\r\n]/);
  });
});

describe('quotedNotice', () => {
  it.each(VALUE_CLASSES.filter(([, value]) => value !== ''))(
    'reads %s back exactly as one block quote',
    (_, value) => {
      expect(readBlockquotes(quotedNotice(value))).toEqual([value]);
    },
  );

  it('keeps text after it out of the quote once a blank line follows', () => {
    const text = `${quotedNotice('a notice')}\n\n**12 total**`;

    expect(readBlockquotes(text)).toEqual(['a notice']);
    expect(readParagraphs(text)).toEqual(['⟦strong_open⟧12 total⟦strong_close⟧']);
  });
});

describe('codeLiteral', () => {
  it.each([
    ['plain text', 'record_date:gte:2024-01-01'],
    ['a backtick inside', 'country:eq:Cote D`Ivoire'],
    ['a backtick run', 'a``b```c'],
    ['a leading backtick', '`lead'],
    ['a trailing backtick', 'trail`'],
    ['spaces at both ends', ' both '],
    ['spaces only', '   '],
    ['a pipe and markup', '|*a*|<b>'],
  ])('reads a value with %s back as one code span', (_, value) => {
    expect(readParagraphs(`**Filter:** ${codeLiteral(value)}`)).toEqual([
      `⟦strong_open⟧Filter:⟦strong_close⟧ ⟦code_inline:${value}⟧`,
    ]);
  });

  it('reads the empty value back as nothing after the label', () => {
    expect(readParagraphs(`**Filter:** ${codeLiteral('')}`)).toEqual([
      '⟦strong_open⟧Filter:⟦strong_close⟧',
    ]);
  });

  it.each([
    ['an LF', 'line1\nline2', 'line1\nline2'],
    ['a fence-length backtick run', 'a\n```\nb', 'a\n```\nb'],
    ['a CRLF, read back as LF', 'line1\r\nline2', 'line1\nline2'],
  ])('fences a value with %s on lines of its own', (_, value, readBack) => {
    const text = `**Endpoint:** ${codeLiteral(value)}\n**Rows:** 1`;

    expect(readFences(text)).toEqual([`${readBack}\n`]);
    expect(readParagraphs(text)).toEqual([
      '⟦strong_open⟧Endpoint:⟦strong_close⟧',
      '⟦strong_open⟧Rows:⟦strong_close⟧ 1',
    ]);
  });
});

/**
 * Every encoder here runs over caller- and upstream-sized text, so its cost is
 * held linear against the worst shapes for the escaper and the line splitter:
 * runs of one escapable character, openers with no closer, nested and
 * overlapping prefixes, and two line-break layouts — one long line ending in a
 * break (where a lazy `.*?` goes quadratic) and breaks throughout (where a
 * whole-text multiline scan or a per-token `\s*` does).
 *
 * Measured in this thread's CPU time, never wall clock, which counts every
 * moment a loaded machine deschedules the worker. A small input is timed per
 * call over a batch, since one 5k call sits below the timer's resolution; each
 * size keeps the least of several measurements, since a garbage-collection
 * pause only ever adds time; and the baseline is re-timed beside every larger
 * size, so the two halves of a ratio share a core. Inputs double from 5k and
 * the bound is checked at each size before the next, so a quadratic fails in
 * seconds rather than hanging on the largest step. Each test body is
 * synchronous, so its vitest timeout is 0: vitest cannot interrupt it, and the
 * CPU bound is what stops a super-linear mutant.
 */
describe('encoder cost', () => {
  const BASE_CHARS = 5_000;
  /** A 64× span: linear growth reads 64, a quadratic 4,096. */
  const MAX_CHARS = 320_000;
  /** Headroom over linear growth at every size — 256 across the full span. */
  const SLACK = 4;
  /** CPU time per input character no linear encoder here approaches, on any load. */
  const MAX_MICROS_PER_CHAR = 1;
  /** CPU time one measurement spans, so a call far below the timer's resolution is timed over a batch. */
  const MIN_BATCH_MICROS = 2_000;
  const MEASUREMENTS = 5;

  /**
   * CPU microseconds this thread spends per call of `encode` on `input`, over
   * the smallest doubling batch of calls that spans {@link MIN_BATCH_MICROS}.
   * A call that alone outlasts it — a super-linear one on a large input — is
   * timed once.
   */
  function cpuMicrosPerCall(encode: (input: string) => string, input: string): number {
    for (let calls = 1; ; calls *= 2) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < calls; i++) encode(input);
      const used = process.threadCpuUsage(start);
      const micros = used.user + used.system;
      if (micros >= MIN_BATCH_MICROS) return micros / calls;
    }
  }

  function expectLinear(
    encode: (input: string) => string,
    shape: (chars: number) => string,
    maxChars = MAX_CHARS,
  ): void {
    const base = shape(BASE_CHARS);
    encode(base);
    for (let chars = BASE_CHARS * 2; chars <= maxChars; chars *= 2) {
      const input = shape(chars);
      const span = input.length / base.length;
      let growth = Number.POSITIVE_INFINITY;
      for (let i = 0; i < MEASUREMENTS; i++) {
        const baseMicros = cpuMicrosPerCall(encode, base);
        const micros = cpuMicrosPerCall(encode, input);
        expect(micros, `${input.length} chars: CPU µs per call`).toBeLessThan(
          MAX_MICROS_PER_CHAR * input.length,
        );
        growth = Math.min(growth, micros / baseMicros);
      }
      expect(growth, `${input.length} chars: growth over ${base.length}`).toBeLessThan(
        SLACK * span,
      );
    }
  }

  const half = (chars: number) => Math.floor(chars / 2);
  const quarter = (chars: number) => Math.floor(chars / 4);

  const VALUE_SHAPES: [string, (chars: number) => string][] = [
    ['a digit run', (n) => '1'.repeat(n)],
    ['a backslash run', (n) => '\\'.repeat(n)],
    ['a pipe run', (n) => '|'.repeat(n)],
    ['a backtick run', (n) => '`'.repeat(n)],
    ['a hash run', (n) => '#'.repeat(n)],
    ['a space run before text', (n) => `${' '.repeat(n)}x`],
    ['repeated openers with no closer', (n) => '<'.repeat(n)],
    ['nested openers', (n) => `${'<a'.repeat(quarter(n))}${'>'.repeat(half(n))}`],
    ['an email autolink with no closer', (n) => `<${'1@'.repeat(half(n))}`],
    ['overlapping reference prefixes', (n) => '&#'.repeat(half(n))],
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(quarter(n))}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(quarter(n))],
  ];

  it.each(VALUE_SHAPES)(
    'markdownValue stays linear on %s',
    (_, shape) => {
      expectLinear(markdownValue, shape);
    },
    0,
  );

  it.each(VALUE_SHAPES.slice(-2))(
    'quotedNotice stays linear on %s',
    (_, shape) => {
      expectLinear(quotedNotice, shape);
    },
    0,
  );

  it.each([
    ['a digit run', (n: number) => '1'.repeat(n)],
    ['a backtick run', (n: number) => '`'.repeat(n)],
    ['alternating backtick runs', (n: number) => '`a'.repeat(half(n))],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(quarter(n))}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(quarter(n))],
  ])(
    'codeLiteral stays linear on %s',
    (_, shape) => {
      expectLinear(codeLiteral, shape);
    },
    0,
  );
});
