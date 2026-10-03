// Eta's tokenizer matches `<%`/`%>` as raw substrings — it does not understand JS
// strings, regexes or block comments inside a tag — and Eta v3 dropped `<%#`.
// This walk mirrors that: tag bodies are deliberately not parsed as JS.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type EtaLintRule = 'unsupported-comment' | 'nested-tag-open' | 'unclosed-tag';

export type EtaLintIssue = {
  file?: string;
  line: number;
  column: number;
  rule: EtaLintRule;
  message: string;
};

export function lintEtaSource(source: string): EtaLintIssue[] {
  const issues: EtaLintIssue[] = [];

  let pos = 0;
  let line = 1;
  let column = 1;
  let inTag = false;
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
      if (source.startsWith('<%#', pos)) {
        issues.push({
          line,
          column,
          rule: 'unsupported-comment',
          message:
            'Eta v3+ does not support `<%# … %>` comment delimiters. Use `<% /* … */ %>` instead — and make sure the comment body does not contain `<%`, `<%=`, `<%~`, or `<%-` substrings.',
        });
        advance(3);
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
      if (source.startsWith('<%', pos)) {
        issues.push({
          line,
          column,
          rule: 'nested-tag-open',
          message:
            'Tag body contains a `<%` substring (looks like another tag opener). Eta\'s tokenizer scans for delimiters in raw text — string literals, regexes, and `/* … */` comments do not protect against this. Rewrite the comment or expression to avoid the substring.',
        });
        advance(2);
        continue;
      }
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

export function formatLintIssues(issues: EtaLintIssue[]): string {
  return issues
    .map((i) => {
      const loc = `${i.file ?? '<source>'}:${i.line}:${i.column}`;
      return `${loc}  ${i.rule}\n  ${i.message}`;
    })
    .join('\n\n');
}
