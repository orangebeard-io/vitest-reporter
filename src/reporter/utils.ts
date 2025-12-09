import { ZonedDateTime, Instant } from '@js-joda/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { FinishTest } from '@orangebeard-io/javascript-client/dist/client/models/FinishTest';
import { Log } from '@orangebeard-io/javascript-client/dist/client/models/Log';
import { StartTest } from '@orangebeard-io/javascript-client/dist/client/models/StartTest';
import type { UserConsoleLog } from 'vitest';

const stat = promisify(fs.stat);
const access = promisify(fs.access);

export function getTime(): string {
  return ZonedDateTime.now().withFixedOffsetZone().toString();
}

export function timeFromEpochMs(epochMs: number): string {
  // js-joda requires an integer millisecond value; Vitest diagnostics may use floats.
  const rounded = Math.round(epochMs);
  const instant = Instant.ofEpochMilli(rounded);
  // Use the same fixed-offset zone representation as getTime(),
  // so the resulting string looks like `2025-12-09T12:00:00.000+01:00[+01:00]`.
  const base = ZonedDateTime.now().withFixedOffsetZone();
  const zone = base.zone();
  return ZonedDateTime.ofInstant(instant, zone).toString();
}

export const testStatusMap: Record<string, FinishTest.Status> = {
  passed: FinishTest.Status.PASSED,
  failed: FinishTest.Status.FAILED,
  skipped: FinishTest.Status.SKIPPED,
  pending: FinishTest.Status.SKIPPED,
};

export function removeAnsi(ansiString: string): string {
  const parts = ansiString.split(/(\u001b\[[0-9;]*[mG])/);
  let result = '';
  for (const part of parts) {
    if (!part.startsWith('\u001b[')) {
      result += part;
    }
  }
  return result;
}

export function ansiToMarkdown(ansiString: string): string {
  let markdown = '';
  let currentStyle: { italic?: boolean; code?: boolean } = {};

  const ansiCodes: Record<string, { italic?: boolean; code?: boolean }> = {
    '31': { italic: true },
    '32': { italic: true },
    '39': { italic: false }, // reset styles
    '2': { code: true },
    '22': { code: false },
  };

  const parts = ansiString.split(/(\u001b\[[0-9;]*[mG])/);

  for (const part of parts) {
    if (part.startsWith('\u001b[')) {
      const code = part.slice(2, -1);
      const codes = code.split(';');
      for (const c of codes) {
        const style = ansiCodes[c];
        if (style) {
          currentStyle = { ...currentStyle, ...style };
        }
      }
    } else {
      let formattedPart = part.replace(/\n/g, '  \n');

      if (currentStyle.italic) {
        formattedPart = formattedPart.endsWith(' ')
          ? `*${formattedPart.trim()}* `
          : `*${formattedPart}*`;
      }
      if (currentStyle.code) {
        formattedPart = `${formattedPart}`;
      }

      markdown += formattedPart;
    }
  }

  return markdown;
}

/**
 * Reads a 3-line snippet from a file, centered around the specified line number.
 */
export function getCodeSnippet(filePath: string, lineNumber: number): string {
  if (lineNumber < 1) {
    throw new Error('Line number must be 1 or greater.');
  }

  const fileContent = fs.readFileSync(filePath, 'utf8');
  const lines = fileContent.split(/\r?\n/);

  const startLine = Math.max(0, lineNumber - 2);
  const endLine = Math.min(lines.length, lineNumber + 1);

  if (startLine >= lines.length) {
    throw new Error('Line number is out of range.');
  }

  let snippet = lines.slice(startLine, endLine);
  if (snippet.length > 0 && snippet[0].trim() === '') {
    snippet = snippet.slice(1);
  }

  return `\`\`\`js\n${snippet.join('\n')}\n\`\`\``;
}

const fileExists = async (filepath: string): Promise<boolean> => {
  try {
    await access(filepath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const waitForFile = async (filepath: string, interval = 1000, timeout = 60000): Promise<void> => {
  const start = Date.now();

  while (true) {
    const now = Date.now();
    if (now - start > timeout) {
      throw new Error(`Timeout: ${filepath} did not become available within ${timeout}ms`);
    }

    if (await fileExists(filepath)) {
      const stats = [] as fs.Stats[];
      for (let i = 0; i < 2; i++) {
        stats.push(await stat(filepath));
        await new Promise((resolve) => setTimeout(resolve, interval));
      }

      const [first, second] = stats;
      if (first.mtimeMs === second.mtimeMs && first.size === second.size) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

export const getBytes = async (filePath: string): Promise<Buffer> => {
  try {
    await waitForFile(filePath, 100, 5000);
    return fs.readFileSync(filePath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error reading file:', err);
    throw err;
  }
};

export function determineTestType(parentTitlePath: string): StartTest.TestType {
  const lower = parentTitlePath.toLowerCase();

  // BEFORE-like hooks and tests
  if (
    lower.includes('beforeall') ||
    lower.includes('before all') ||
    lower.includes('beforeeach') ||
    lower.includes('before each') ||
    lower.includes('setup')
  ) {
    return StartTest.TestType.BEFORE;
  }

  // AFTER-like hooks and tests
  if (
    lower.includes('afterall') ||
    lower.includes('after all') ||
    lower.includes('aftereach') ||
    lower.includes('after each') ||
    lower.includes('teardown')
  ) {
    return StartTest.TestType.AFTER;
  }

  return StartTest.TestType.TEST;
}

export function formatConsoleLog(log: UserConsoleLog): {
  message: string;
  format: Log.LogFormat;
  level: Log.LogLevel;
} {
  const text = Array.isArray(log.content)
    ? log.content.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join(' ')
    : String(log.content);

  const clean = removeAnsi(text);

  const type = (log as any).type ?? 'stdout';

  let level: Log.LogLevel;
  switch (type) {
    case 'stderr':
      level = Log.LogLevel.ERROR;
      break;
    case 'stdout':
    default:
      level = Log.LogLevel.INFO;
      break;
  }

  const hasMarkdown = clean.includes('```') || clean.includes('*');

  return {
    message: hasMarkdown ? clean : text,
    format: hasMarkdown ? Log.LogFormat.MARKDOWN : Log.LogFormat.PLAIN_TEXT,
    level,
  };
}

export function formatCoverageMarkdownTable(coverage: unknown): string {
  const anyCov = coverage as any;

  type TotalsLike = { total: number; covered: number; skipped?: number; pct: number };

  const normalizeTotals = (t: any | undefined): TotalsLike | undefined => {
    if (!t) return undefined;
    return {
      total: t.total ?? 0,
      covered: t.covered ?? 0,
      skipped: t.skipped ?? 0,
      pct: t.pct ?? 0,
    };
  };

  const formatTotalsCell = (t: TotalsLike | undefined): string => {
    if (!t) return 'n/a';
    return `${t.pct.toFixed(1)}% (${t.covered}/${t.total})`;
  };

  const rows: string[] = [
    '| File | Lines | Statements | Branches | Functions |',
    '| ---- | ----: | ---------: | -------: | --------: |',
  ];

  try {
    // CoverageMap from istanbul-lib-coverage
    if (anyCov && typeof anyCov.files === 'function' && typeof anyCov.fileCoverageFor === 'function') {
      // Overall summary row
      if (typeof anyCov.getCoverageSummary === 'function') {
        const s = anyCov.getCoverageSummary();
        const summary = (s && (s.data ?? (typeof s.toJSON === 'function' ? s.toJSON() : s))) ?? s;
        const lines = normalizeTotals(summary?.lines);
        const statements = normalizeTotals(summary?.statements);
        const branches = normalizeTotals(summary?.branches);
        const functions = normalizeTotals(summary?.functions);

        rows.push(
          `**All files** | ${formatTotalsCell(lines)} | ${formatTotalsCell(statements)} | ${formatTotalsCell(branches)} | ${formatTotalsCell(functions)}`,
        );
      }

      const files: string[] = anyCov.files();
      for (const file of files.sort()) {
        const fc = anyCov.fileCoverageFor(file);
        const s = typeof fc?.toSummary === 'function' ? fc.toSummary() : undefined;
        const data = (s && (s.data ?? (typeof s.toJSON === 'function' ? s.toJSON() : s))) ?? s;
        const lines = normalizeTotals(data?.lines);
        const statements = normalizeTotals(data?.statements);
        const branches = normalizeTotals(data?.branches);
        const functions = normalizeTotals(data?.functions);

        const relPath = (() => {
          try {
            const rel = path.relative(process.cwd(), file);
            return rel && !rel.startsWith('..') ? rel : file;
          } catch {
            return file;
          }
        })();

        rows.push(
          `\`${relPath}\` | ${formatTotalsCell(lines)} | ${formatTotalsCell(statements)} | ${formatTotalsCell(branches)} | ${formatTotalsCell(functions)}`,
        );
      }

      return rows.join('\n');
    }

    // Summary-only shape (no per-file info)
    if (
      anyCov &&
      anyCov.lines &&
      anyCov.statements &&
      anyCov.branches &&
      anyCov.functions
    ) {
      const lines = normalizeTotals(anyCov.lines);
      const statements = normalizeTotals(anyCov.statements);
      const branches = normalizeTotals(anyCov.branches);
      const functions = normalizeTotals(anyCov.functions);

      rows.push(
        `**All files** | ${formatTotalsCell(lines)} | ${formatTotalsCell(statements)} | ${formatTotalsCell(branches)} | ${formatTotalsCell(functions)}`,
      );

      return rows.join('\n');
    }
  } catch {
    // Fall through to JSON fallback below
  }

  // Fallback: still wrap the raw coverage object in a markdown section
  try {
    const json = JSON.stringify(coverage, null, 2) ?? 'null';
    return [
      '| Metric | Value |',
      '| ------ | ----- |',
      '| Coverage JSON | ```json',
      json.replace(/\|/g, '\\|'),
      '``` |',
    ].join('\n');
  } catch {
    return '| Metric | Value |\n| ------ | ----- |\n| Coverage | (unserializable) |';
  }
}
