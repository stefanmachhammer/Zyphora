/**
 * Eta template linter.
 *
 * Eta's tokenizer scans for delimiters (`<%`, `%>`, etc.) as raw substrings —
 * it doesn't understand JS string literals, regex literals, or block comments.
 * That makes a handful of edits silently produce a broken template whose only
 * symptom is a compiled-JS SyntaxError pointing nowhere useful:
 *
 *   1. `<%# … %>` — Eta v3 dropped the hash-comment delimiter, so the `#`
 *      leaks into compiled JS and throws on render.
 *   2. A tag body that mentions another opener (`<% /* contains <%= … *\/ %>`)
 *      — the inner `<%` is matched as a new tag opening and the parser
 *      desynchronizes from there.
 *   3. An open `<%` without a matching `%>` anywhere.
 *
 * This module scans an Eta source string and emits structured issues with
 * line/column info, so the renderer and installer can surface a real error
 * before Eta itself crashes. It is intentionally conservative: rules only
 * cover the failure modes we've actually been bitten by, so we don't generate
 * false positives in legitimate templates.
 *
 * See repository issue #5 for the original symptoms and reproduction.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Stable identifiers so callers can branch on rule type rather than message text. */
export type EtaLintRule = 'unsupported-comment' | 'nested-tag-open' | 'unclosed-tag';

/**
 * A single problem found by the linter, with enough context to point a human
 * at the exact source location. `file` is filled in by `lintTemplatesDir` —
 * the raw `lintEtaSource` function doesn't know the filename and leaves it
 * for the caller to attach.
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
 * Scan a single template's source and return any issues found.
 *
 * Walks the source character-by-character with a tiny two-state machine
 * (`outside-tag` / `inside-tag`). Doesn't try to parse the JS inside a tag —
 * mirroring Eta's own tokenizer behaviour is the whole point, so a substring
 * that *looks* like a delimiter is treated as a delimiter even if it's "really"
 * inside a string literal.
 */
export function lintEtaSource(source: string): EtaLintIssue[] {
  const issues: EtaLintIssue[] = [];

  let pos = 0;
  let line = 1;
  let column = 1;
  let inTag = false;
  // Position of the most recent `<%` so we can point at the right line for
  // an unclosed-tag report at EOF.
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
      // Rule 1: `<%#` is a v2-era comment delimiter Eta v3+ no longer
      // recognises. Report and skip past so we don't also fire rule 2.
      if (source.startsWith('<%#', pos)) {
        issues.push({
          line,
          column,
          rule: 'unsupported-comment',
          message:
            'Eta v3+ does not support `<%# … %>` comment delimiters. Use `<% /* … */ %>` instead — and make sure the comment body does not contain `<%`, `<%=`, `<%~`, or `<%-` substrings.',
        });
        advance(3);
        // Skip until the matching `%>` so the rest of the file lints
        // sensibly even with this broken comment in the middle.
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
      // Rule 2: another opener inside the current tag body. This is the
      // exact case the issue's "<% /* … <%= … */ %>" example trips.
      if (source.startsWith('<%', pos)) {
        issues.push({
          line,
          column,
          rule: 'nested-tag-open',
          message:
            'Tag body contains a `<%` substring (looks like another tag opener). Eta\'s tokenizer scans for delimiters in raw text — string literals, regexes, and `/* … */` comments do not protect against this. Rewrite the comment or expression to avoid the substring.',
        });
        // Keep scanning past this opener so we surface every problem in
        // one pass, not one error per invocation.
        advance(2);
        continue;
      }
      // Eta accepts `-%>` and `_%>` (whitespace-slurping close variants) as
      // well as plain `%>`. All three end the tag for our purposes.
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

  // Rule 3: EOF reached with a tag still open. Point at the offending open,
  // not the end of the file — that's the line the author actually needs.
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

/**
 * Recursively walk a directory and return every `.eta` file path. Used by
 * the renderer and installer to lint a whole theme at once.
 */
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
 * Lint every `.eta` file in `templatesDir`. Returned issues carry a `file`
 * field with a path relative to `templatesDir` so error messages stay short
 * and stable even when the absolute path is deep (`/var/.../themes/foo/...`).
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
 * Render a list of issues as a multi-line string suitable for an error
 * message or stderr. Format is deliberately editor-friendly:
 *
 *   templates/post.eta:12:23  nested-tag-open
 *     Tag body contains a `<%` substring (looks like another tag opener)…
 */
export function formatLintIssues(issues: EtaLintIssue[]): string {
  return issues
    .map((i) => {
      const loc = `${i.file ?? '<source>'}:${i.line}:${i.column}`;
      return `${loc}  ${i.rule}\n  ${i.message}`;
    })
    .join('\n\n');
}
