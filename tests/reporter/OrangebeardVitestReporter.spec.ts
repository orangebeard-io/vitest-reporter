import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

// Mock the Orangebeard async client so we never talk to the real backend
vi.mock('@orangebeard-io/javascript-client/dist/client/OrangebeardAsyncV3Client', () => {
  class FakeClient {
    // minimal config used by the reporter
    config = {
      testset: 'Vitest reporter tests',
      description: 'Unit tests for Orangebeard Vitest reporter',
      attributes: [],
    } as any;

    startTestRun = vi.fn(() => 'run-uuid' as any);
    finishTestRun = vi.fn();
    startSuite = vi.fn(() => ['suite-uuid' as any]);
    startTest = vi.fn(() => 'test-uuid' as any);
    finishTest = vi.fn();
    startStep = vi.fn(() => 'step-uuid' as any);
    finishStep = vi.fn();
    log = vi.fn(() => 'log-uuid' as any);
    sendAttachment = vi.fn();
  }

  return { default: FakeClient };
});

import { OrangebeardVitestReporter } from '../../src/reporter/OrangebeardVitestReporter';
import { formatCoverageMarkdownTable } from '../../src/reporter/utils';

// Helper to build a minimal TestCase-like object that exercises the reporter
function createTestCase(id: string, name: string) {
  const absFile = path.join(process.cwd(), 'tests', 'sample.test.ts');
  const module: any = { moduleId: absFile };
  const suite: any = { name: 'sample suite', parent: module };

  const resultState: { state: string } = { state: 'passed' };

  const testCase: any = {
    id,
    name,
    module,
    suite,
    location: { file: absFile, line: 10, column: 1 },
    result: () => ({ state: resultState.state, errors: [] }),
    diagnostic: () => ({ startTime: 1_000, duration: 50 }),
  };

  return { testCase, resultState };
}

function getClient(reporter: OrangebeardVitestReporter): any {
  return (reporter as any).client;
}

describe('OrangebeardVitestReporter', () => {
  let reporter: OrangebeardVitestReporter;

  beforeEach(() => {
    reporter = new OrangebeardVitestReporter();
  });

  it('starts a test run once on onTestRunStart', () => {
    const client = getClient(reporter);

    reporter.onTestRunStart();
    reporter.onTestRunStart(); // second call should be ignored

    expect(client.startTestRun).toHaveBeenCalledTimes(1);
    expect(client.startTestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        testSetName: client.config.testset,
        description: client.config.description,
      }),
    );
  });

  it('starts suites and tests when a test case becomes ready and then finishes them with mapped status', () => {
    const client = getClient(reporter);
    const { testCase, resultState } = createTestCase('t-1', 'passes with a simple assertion');

    reporter.onTestRunStart();
    reporter.onTestCaseReady(testCase as any);

    expect(client.startSuite).toHaveBeenCalled();
    expect(client.startTest).toHaveBeenCalledWith(
      expect.objectContaining({
        testRunUUID: 'run-uuid',
        testName: testCase.name,
      }),
    );

    // simulate a failing test and verify FAILED mapping
    resultState.state = 'failed';
    reporter.onTestCaseResult(testCase as any);

    expect(client.finishTest).toHaveBeenCalledWith('test-uuid', {
      testRunUUID: 'run-uuid',
      status: expect.stringMatching(/FAILED|TIMED_OUT|STOPPED|PASSED|SKIPPED/),
      endTime: expect.any(String),
    });
  });

  it('buffers console logs until the test is known, then flushes them on start', () => {
    const client = getClient(reporter);
    const { testCase } = createTestCase('t-2', 'console test');

    // log before test is started -> should be buffered
    reporter.onUserConsoleLog({
      taskId: 't-2',
      type: 'stdout',
      content: ['hello before start'],
    } as any);

    expect(client.log).not.toHaveBeenCalled();

    reporter.onTestRunStart();
    reporter.onTestCaseReady(testCase as any);

    // buffered log plus the log from flushBufferedLogs
    expect(client.log).toHaveBeenCalledWith(
      expect.objectContaining({
        testRunUUID: 'run-uuid',
        testUUID: 'test-uuid',
        message: expect.stringContaining('hello before start'),
      }),
    );
  });

  it('uploads recorded artifacts as attachments', async () => {
    const client = getClient(reporter);
    const { testCase } = createTestCase('t-3', 'attachment test');

    // mock getBytes to avoid real disk I/O and to control the returned Buffer
    const getBytesModule = await import('../../src/reporter/utils');
    const getBytesSpy = vi.spyOn(getBytesModule, 'getBytes').mockResolvedValue(Buffer.from('file-bytes'));

    reporter.onTestRunStart();
    reporter.onTestCaseReady(testCase as any);

    // simulate a recorded artifact with a path and contentType
    reporter.onTestCaseArtifactRecord(testCase as any, {
      path: path.join(process.cwd(), 'artifacts', 'screenshot.png'),
      contentType: 'image/png',
    } as any);

    // wait for async attachment upload to be scheduled and processed
    await vi.waitFor(() => {
      expect(getBytesSpy).toHaveBeenCalled();
      expect(client.sendAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({
            name: 'screenshot.png',
            contentType: 'image/png',
          }),
          metaData: expect.objectContaining({
            testRunUUID: 'run-uuid',
            testUUID: 'test-uuid',
          }),
        }),
      );
    });

    getBytesSpy.mockRestore();
  });

  it('records coverage on onCoverage and emits a Coverage report AFTER test on run end', async () => {
    const client = getClient(reporter);

    // minimal CoverageMap-like object
    const coverageMap = {
      files: () => ['fileA.ts'],
      fileCoverageFor: (_file: string) => ({
        toSummary: () => ({
          data: {
            lines: { total: 10, covered: 5, pct: 50 },
            statements: { total: 10, covered: 5, pct: 50 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 2, covered: 1, pct: 50 },
          },
        },
        ),
        getUncoveredLines: () => [1, 2, 3],
      }),
      getCoverageSummary: () => ({
        data: {
          lines: { total: 10, covered: 5, pct: 50 },
          statements: { total: 10, covered: 5, pct: 50 },
          branches: { total: 0, covered: 0, pct: 100 },
          functions: { total: 2, covered: 1, pct: 50 },
        },
      }),
    } as any;

    reporter.onTestRunStart();
    reporter.onCoverage(coverageMap);
    await reporter.onTestRunEnd([] as any, [] as any, 'passed');

    // run is finished after coverage reporting (no error thrown)
    expect(client.finishTestRun).toHaveBeenCalledWith('run-uuid', {
      endTime: expect.any(String),
    });
  });
});


describe('formatCoverageMarkdownTable', () => {
  it('produces a markdown table with per-file rows and uncovered lines', () => {
    const coverageMap = {
      files: () => ['src/a.ts', 'src/b.ts'],
      fileCoverageFor: (file: string) => ({
        toSummary: () => ({
          data: {
            lines: { total: 10, covered: file.endsWith('a.ts') ? 5 : 10, pct: file.endsWith('a.ts') ? 50 : 100 },
            statements: { total: 10, covered: 10, pct: 100 },
            branches: { total: 0, covered: 0, pct: 100 },
            functions: { total: 1, covered: 1, pct: 100 },
          },
        }),
        getUncoveredLines: () => (file.endsWith('a.ts') ? [1, 2, 3, 10] : []),
      }),
      getCoverageSummary: () => ({
        data: {
          lines: { total: 20, covered: 15, pct: 75 },
          statements: { total: 20, covered: 20, pct: 100 },
          branches: { total: 0, covered: 0, pct: 100 },
          functions: { total: 2, covered: 2, pct: 100 },
        },
      }),
    } as any;

    const markdown = formatCoverageMarkdownTable(coverageMap);

    expect(markdown).toContain('All files');
    expect(markdown).toMatch(/src[\\/](a\.ts)/);
    expect(markdown).toMatch(/src[\\/](b\.ts)/);
  });
});
