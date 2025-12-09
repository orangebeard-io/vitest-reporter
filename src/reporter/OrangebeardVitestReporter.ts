import type { UUID } from 'crypto';
import type {
  Reporter,
  TestCase,
  TestModule,
  TestSuite,
  TestRunEndReason,
  Vitest,
} from 'vitest/node';
import type { UserConsoleLog } from 'vitest';
import * as path from 'node:path';
import OrangebeardAsyncV3Client from '@orangebeard-io/javascript-client/dist/client/OrangebeardAsyncV3Client';
import type { OrangebeardParameters } from '@orangebeard-io/javascript-client/dist/client/models/OrangebeardParameters';
import { StartTest } from '@orangebeard-io/javascript-client/dist/client/models/StartTest';
import { FinishTest } from '@orangebeard-io/javascript-client/dist/client/models/FinishTest';
import { Log } from '@orangebeard-io/javascript-client/dist/client/models/Log';
import { Attachment } from '@orangebeard-io/javascript-client/dist/client/models/Attachment';
import { Attribute } from '@orangebeard-io/javascript-client/dist/client/models/Attribute';
import {
  ansiToMarkdown,
  determineTestType,
  formatConsoleLog,
  formatCoverageMarkdownTable,
  getBytes,
  getCodeSnippet,
  getTime,
  timeFromEpochMs,
  removeAnsi,
  testStatusMap,
} from './utils';
import TestStatus = FinishTest.Status;
import TestType = StartTest.TestType;
import LogLevel = Log.LogLevel;
import LogFormat = Log.LogFormat;

type BufferedConsoleLog = {
  log: UserConsoleLog;
};

export class OrangebeardVitestReporter implements Reporter {
  private readonly client: OrangebeardAsyncV3Client;
  private readonly config: OrangebeardParameters;

  private vitest?: Vitest;
  private testRunId!: UUID;

  private readonly suites = new Map<string, UUID>();
  private readonly tests = new Map<string, UUID>();
  private readonly steps = new Map<string, UUID>();
  private readonly promises: Promise<void>[] = [];
  private readonly bufferedLogs = new Map<string, BufferedConsoleLog[]>();
  private coverage: unknown | undefined;

  constructor() {
    this.client = new OrangebeardAsyncV3Client();
    this.config = this.client.config;
  }

  /**
   * Vitest is about to start; capture context for later if needed.
   */
  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  /**
   * Test run is starting – create Orangebeard test run.
   */
  onTestRunStart(): void {
    if (this.testRunId) {
      return;
    }

    this.testRunId = this.client.startTestRun({
      testSetName: this.config.testset,
      description: this.config.description ?? 'Vitest test run',
      startTime: getTime(),
      attributes: this.config.attributes,
    });
  }

  /**
   * A test case becomes ready to run – start a corresponding Orangebeard test.
   */
  onTestCaseReady(test: TestCase): void {
    this.ensureTestStarted(test);
  }

  /**
   * Final result for a test case – finish the Orangebeard test and log errors.
   */
  onTestCaseResult(test: TestCase): void {
    const testUUID = this.ensureTestStarted(test);
    const result = test.result();

    const status: TestStatus | undefined = result?.state
      ? testStatusMap[result.state]
      : undefined;

    if (result && Array.isArray(result.errors) && result.errors.length > 0) {
      for (const error of result.errors) {
        const message = ansiToMarkdown(removeAnsi(String((error as any).message ?? (error as any).name ?? 'Test failed')));
        this.client.log({
          logFormat: LogFormat.MARKDOWN,
          logLevel: LogLevel.ERROR,
          logTime: getTime(),
          message,
          testRunUUID: this.testRunId,
          testUUID,
        });

        const stack = (error as any).stack as string | undefined;
        if (stack) {
          this.client.log({
            logFormat: LogFormat.MARKDOWN,
            logLevel: LogLevel.ERROR,
            logTime: getTime(),
            message: '```text\n' + removeAnsi(stack) + '\n```',
            testRunUUID: this.testRunId,
            testUUID,
          });
        }

        const location = test.location as any;
        if (location && typeof location.line === 'number') {
          try {
            const file = (location as any).file ?? (location as any).fileName ?? undefined;
            if (file) {
              const snippet = getCodeSnippet(file, location.line);
              this.client.log({
                logFormat: LogFormat.MARKDOWN,
                logLevel: LogLevel.INFO,
                logTime: getTime(),
                message: snippet,
                testRunUUID: this.testRunId,
                testUUID,
              });
            }
          } catch {
            // best-effort: ignore snippet failures
          }
        }
      }
    }

    if (status) {
      this.client.finishTest(testUUID, {
        testRunUUID: this.testRunId,
        status,
        endTime: getTime(),
      });
    }

    this.tests.delete(test.id);
  }

  /**
   * Console output produced by tests – forward to Orangebeard as logs.
   */
  onUserConsoleLog(log: UserConsoleLog): void {
    const taskId = log.taskId;

    if (!taskId) {
      // Cannot map to a test – log a local warning.
      // eslint-disable-next-line no-console
      console.warn('[OrangebeardVitestReporter] Received console log without taskId; cannot send to Orangebeard.');
      return;
    }

    const testUUID = this.tests.get(taskId);

    if (!testUUID) {
      // Buffer until the test is started.
      const existing = this.bufferedLogs.get(taskId) ?? [];
      existing.push({ log });
      this.bufferedLogs.set(taskId, existing);
      return;
    }

    const { message, format, level } = formatConsoleLog(log);

    this.client.log({
      logFormat: format,
      logLevel: level,
      logTime: getTime(),
      message,
      testRunUUID: this.testRunId,
      testUUID,
    });
  }

  /**
   * Optional: handle recorded artifacts (screenshots, traces, etc.).
   *
   * Note: Vitest's TestArtifact type is broader than Orangebeard's Attachment.
   * We only process artifacts that expose a readable path.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onTestCaseArtifactRecord(test: TestCase, artifact: any): void {
    const testUUID = this.tests.get(test.id);
    if (!testUUID) return;

    const path = typeof artifact.path === 'string' ? artifact.path : undefined;
    const name = (artifact as any).file?.name ?? path ?? 'artifact';
    const contentType = (artifact as any).contentType ?? 'application/octet-stream';

    const logUUID = this.client.log({
      logFormat: LogFormat.MARKDOWN,
      logLevel: LogLevel.INFO,
      logTime: getTime(),
      message: `Attachment: ${name}`,
      testRunUUID: this.testRunId,
      testUUID,
    });

    if (path) {
      this.promises.push(this.logAttachmentFromPath(path, contentType, testUUID, logUUID));
    }
  }

  /**
   * Coverage results for the full run.
   */
  onCoverage(coverage: unknown): void {
    this.coverage = coverage;
  }

  /**
   * Test run finished – flush pending work and finish the Orangebeard run.
   */
  async onTestRunEnd(testModules: readonly TestModule[], _unhandledErrors: readonly unknown[], _reason: TestRunEndReason): Promise<void> {
    // Ensure all in-flight async work is done before finishing the run.
    await Promise.all(this.promises);

    // Report coverage summary as a dedicated AFTER test, if available.
    this.reportCoverageSummary();

    // Optionally, we could derive an overall status from testModules here.
    await this.client.finishTestRun(this.testRunId, {
      endTime: getTime(),
    });
  }

  private reportCoverageSummary(): void {
    if (!this.coverage) return;

    try {
      const suiteUUID = this.getOrStartCoverageSuite();
      const startTime = getTime();

      const testUUID = this.client.startTest({
        testType: TestType.AFTER,
        testRunUUID: this.testRunId,
        suiteUUID,
        testName: 'Coverage report',
        startTime,
        description: 'Aggregated coverage summary reported by Vitest.',
        attributes: [],
      });

      const markdownTable = formatCoverageMarkdownTable(this.coverage);

      this.client.log({
        logFormat: LogFormat.MARKDOWN,
        logLevel: LogLevel.INFO,
        logTime: getTime(),
        message: markdownTable,
        testRunUUID: this.testRunId,
        testUUID,
      });

      this.client.finishTest(testUUID, {
        testRunUUID: this.testRunId,
        status: TestStatus.PASSED,
        endTime: getTime(),
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[OrangebeardVitestReporter] Failed to report coverage summary', error);
    } finally {
      this.coverage = undefined;
    }
  }

  /**
   * The reporter should not print anything to Vitest stdio by default.
   */
  printsToStdio(): boolean {
    return false;
  }

  // Helpers

  private ensureTestStarted(test: TestCase): UUID {
    const existing = this.tests.get(test.id);
    if (existing) {
      return existing;
    }

    const suiteUUID = this.getOrStartSuiteForTest(test);

    const attributes: Attribute[] = [];
    const fullName = test.name ?? '';
    const testType: TestType = determineTestType(fullName);

    const description = this.getTestDescription(test);

    const testUUID = this.client.startTest({
      testType,
      testRunUUID: this.testRunId,
      suiteUUID,
      testName: test.name,
      startTime: getTime(),
      description,
      attributes,
    });

    this.tests.set(test.id, testUUID);
    this.flushBufferedLogs(test.id, testUUID);

    return testUUID;
  }

  private getOrStartSuiteForTest(test: TestCase): UUID {
    const path = this.buildSuitePath(test);
    const keyParts: string[] = [];
    let parentSuiteUUID: UUID | undefined;

    for (const segment of path) {
      keyParts.push(segment);
      const key = keyParts.join('|');
      const existing = this.suites.get(key);

      if (existing) {
        parentSuiteUUID = existing;
        continue;
      }

      const newSuites = this.client.startSuite({
        testRunUUID: this.testRunId,
        parentSuiteUUID,
        suiteNames: [segment],
      });

      if (newSuites && newSuites.length > 0) {
        parentSuiteUUID = newSuites[0];
        this.suites.set(key, parentSuiteUUID);
      }
    }

    if (!parentSuiteUUID) {
      throw new Error('Failed to create or resolve suite for test.');
    }

    return parentSuiteUUID;
  }

  private buildSuitePath(test: TestCase): string[] {
    const segments: string[] = [];

    const module: TestModule | undefined = (test as any).module;
    if (module) {
      const moduleId = (module as any).moduleId as string | undefined;
      let projectName: string | undefined;

      if (moduleId) {
        const rel = path.relative(process.cwd(), moduleId);
        projectName = rel && !rel.startsWith('..') ? rel : moduleId;
      } else {
        projectName = (module as any).projectName ?? (module as any).name;
      }

      segments.push(projectName ?? 'root');
    }

    let current: TestSuite | TestModule | undefined = (test as any).suite ?? (test as any).parent;
    while (current && (current as TestSuite).name) {
      segments.push((current as TestSuite).name);
      current = (current as TestSuite).parent as TestSuite | TestModule | undefined;
    }

    return segments.filter((s) => s && s.trim().length > 0);
  }

  private getOrStartCoverageSuite(): UUID {
    const key = '__orangebeard_coverage__';
    const existing = this.suites.get(key);
    if (existing) return existing;

    const suiteUUIDs = this.client.startSuite({
      testRunUUID: this.testRunId,
      parentSuiteUUID: undefined,
      suiteNames: ['Coverage'],
    });

    const uuid = suiteUUIDs && suiteUUIDs.length > 0 ? suiteUUIDs[0] : (undefined as unknown as UUID);
    if (uuid) {
      this.suites.set(key, uuid);
    }
    return uuid;
  }

  private getTestDescription(test: TestCase): string {
    const location = test.location as any;
    const parts: string[] = [];

    if (location && typeof location.line === 'number') {
      const file = location.file ?? location.fileName ?? undefined;
      if (file) {
        parts.push(`${file}:${location.line}`);
      }
    }

    return parts.join('\n');
  }

  private flushBufferedLogs(taskId: string, testUUID: UUID): void {
    const buffered = this.bufferedLogs.get(taskId);
    if (!buffered || buffered.length === 0) return;

    for (const entry of buffered) {
      const { message, format, level } = formatConsoleLog(entry.log);
      this.client.log({
        logFormat: format,
        logLevel: level,
        logTime: getTime(),
        message,
        testRunUUID: this.testRunId,
        testUUID,
      });
    }

    this.bufferedLogs.delete(taskId);
  }

  private async logAttachmentFromPath(path: string, contentType: string, testUUID: UUID, logUUID: UUID): Promise<void> {
    const content = await getBytes(path);

    const attachment: Attachment = {
      file: {
        name: path.split(/[\\/]/).pop() ?? 'attachment',
        content,
        contentType,
      },
      metaData: {
        testRunUUID: this.testRunId,
        testUUID,
        logUUID,
        attachmentTime: getTime(),
      },
    };

    this.client.sendAttachment(attachment);
  }
}
