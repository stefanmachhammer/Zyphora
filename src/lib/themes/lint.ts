/**
 * Eta template linter.
 *
 * Eta's tokenizer scans for delimiters (`<%`, `%>`) as raw substrings — it
 * doesn't understand JS strings, regexes, or block comments. So a few edits
 * silently break a template with only a compiled-JS SyntaxError to show for it.
 * The three caught failure modes:
 *   1. `<%# … %>` — Eta v3 dropped the hash-comment delimiter; `#` leaks into
 *      compiled JS and throws.
 *   2. A tag body containing another `<%` opener — the parser desyncs from there.
 *   3. An open `<%` with no matching `%>`.
 *
 * Emits structured line/column issues so the renderer and installer can report
 * a real error before Eta crashes. Deliberately conservative — only the modes
 * we've been bitten by, to avoid false positives. See issue #5.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Stable identifiers so callers can branch on rule type rather than message text. */
export type EtaLintRule = 'unsupported-comment' | 'nested-tag-open' | 'unclosed-tag';

/**
 * A single linter problem with source location. `file` is attached by
 * `lintTemplatesDir`; `lintEtaSource` doesn't know the filename.
 */
export type EtaLintIssue = {
  file?: string;
  /** 1-based line number, matching what editors show in the gutter. */
  line: number;
  /** 1-based column number. */
  column: number;
  rule: EtaLintRule;
  message: string;
};

/**
 * Scan one template's source for issues via a two-state (outside/inside-tag)
 * character walk. It intentionally does NOT parse the JS inside a tag —
 * mirroring Eta's tokenizer, a delimiter-looking substring counts as a
 * delimiter even inside a string literal.
 */
export function lintEtaSource(source: string): EtaLintIssue[] {
  const issues: EtaLintIssue[] = [];

  let pos = 0;
  let line = 1;
  let column = 1;
  let inTag = false;
  // Most recent `<%` position, so an EOF unclosed-tag report points at the open.
  let tagOpenLine = 1;
  let tagOpenColumn = 1;

  const advance = (n: number) => {
    for (let i = 0; i < n; i++) {
      if (source[pos] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
      pos++;
    }
  };

  while (pos < source.length) {
    if (!inTag) {
      // Rule 1: `<%#` — a v2-era comment delimiter Eta v3+ rejects. Skip past
      // so we don't also fire rule 2.
      if (source.startsWith('<%#', pos)) {
        issues.push({
          line,
          column,
          rule: 'unsupported-comment',
          message:
            'Eta v3+ does not support `<%# … %>` comment delimiters. Use `<% /* … */ %>` instead — and make sure the comment body does not contain `<%`, `<%=`, `<%~`, or `<%-` substrings.',
        });
        advance(3);
        // Skip to the matching `%>` so the rest of the file still lints sensibly.
        while (pos < source.length && !source.startsWith('%>', pos)) {
          advance(1);
        }
        if (pos < source.length) advance(2);
        continue;
      }
      if (source.startsWith('<%', pos)) {
        inTag = true;
        tagOpenLine = line;
        tagOpenColumn = column;
        advance(2);
        continue;
      }
      advance(1);
    } else {
      // Rule 2: another `<%` opener inside the current tag body.
      if (source.startsWith('<%', pos)) {
        issues.push({
          line,
          column,
          rule: 'nested-tag-open',
          message:
            'Tag body contains a `<%` substring (looks like another tag opener). Eta\'s tokenizer scans for delimiters in raw text — string literals, regexes, and `/* … */` comments do not protect against this. Rewrite the comment or expression to avoid the substring.',
        });
        // Keep scanning past it so one pass surfaces every problem.
        advance(2);
        continue;
      }
      // Eta closes tags with `%>`, `-%>`, or `_%>` (whitespace-slurping variants).
      if (
        source.startsWith('-%>', pos) ||
        source.startsWith('_%>', pos)
      ) {
        inTag = false;
        advance(3);
        continue;
      }
      if (source.startsWith('%>', pos)) {
        inTag = false;
        advance(2);
        continue;
      }
      advance(1);
    }
  }

  // Rule 3: EOF with a tag still open. Point at the open, not EOF.
  if (inTag) {
    issues.push({
      line: tagOpenLine,
      column: tagOpenColumn,
      rule: 'unclosed-tag',
      message: 'Template tag opened with `<%` but never closed with `%>`.',
    });
  }

  return issues;
}

/** Recursively collect every `.eta` file path under `dir`. */
function walkEtaFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkEtaFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.eta')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Lint every `.eta` file in `templatesDir`. Issues carry `file` relative to
 * `templatesDir`, keeping messages short regardless of the absolute path depth.
 */
export function lintTemplatesDir(templatesDir: string): EtaLintIssue[] {
  const issues: EtaLintIssue[] = [];
  for (const abs of walkEtaFiles(templatesDir)) {
    const source = readFileSync(abs, 'utf8');
    for (const issue of lintEtaSource(source)) {
      issues.push({ ...issue, file: relative(templatesDir, abs).replace(/\\/g, '/') });
    }
  }
  return issues;
}

/**
 * Format issues as a multi-line, editor-friendly string for errors/stderr:
 *
 *   templates/post.eta:12:23  nested-tag-open
 *     Tag body contains a `<%` substring…
 */
export function formatLintIssues(issues: EtaLintIssue[]): string {
  return issues
    .map((i) => {
      const loc = `${i.file ?? '<source>'}:${i.line}:${i.column}`;
      return `${loc}  ${i.rule}\n  ${i.message}`;
    })
    .join('\n\n');
}
