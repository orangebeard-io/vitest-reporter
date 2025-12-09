<p align="center">
  <a href="https://orangebeard.io" target="_blank" rel="noreferrer">
    <img src=".github/logo.svg" alt="Orangebeard" height="80" />
  </a>
</p>

<h1 align="center">Vitest Orangebeard Reporter</h1>

<p align="center">
  Vitest reporter that streams test execution data and console output to
  <a href="https://orangebeard.io" target="_blank" rel="noreferrer">Orangebeard</a>
  using the <code>@orangebeard-io/javascript-client</code> listener API.
</p>

---

- Maps Vitest files, suites and tests to Orangebeard test runs, suites and tests.
- Forwards `console.log` / `console.error` and other console output as structured logs attached to the running test.
- Reports BEFORE / AFTER style tests (e.g. setup/teardown) as `TestType.BEFORE` / `TestType.AFTER`.
- When coverage is enabled, creates a single AFTER test named **"Coverage report"** that logs a markdown coverage table by file.

## Installation

Install the reporter and the Orangebeard JavaScript client:\r

```bash
npm install --save-dev vitest-orangebeard-reporter @orangebeard-io/javascript-client
```

For local development of this repo, run `npm install` in the project root instead.

## Configuring Orangebeard

This reporter uses `OrangebeardAsyncV3Client` from `@orangebeard-io/javascript-client`. Configure it the same way as other Orangebeard listeners (Jest, Playwright, etc.):

- Via an `orangebeard.json` file in your project root, **or**
- Via environment variables (URL, project, API key, testset, description, attributes, ...).

See the [Orangebeard documentation](https://docs.orangebeard.io/connecting-test-tools/listener-api-clients) for the full list of options.

## Using the reporter in Vitest

Add the reporter to your `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import OrangebeardVitestReporter from 'vitest-orangebeard-reporter';

export default defineConfig({
  test: {
    reporters: [new OrangebeardVitestReporter()],
  },
});
```

If you are using a monorepo or custom project configuration, make sure the reporter is added to the Vitest project where you want results to be sent to Orangebeard.

### Running with coverage

When running Vitest with coverage enabled (for example using the built-in v8 provider):

```bash
npx vitest run --coverage
```

The reporter will:

- Collect the aggregated coverage map from Vitest via `onCoverage`.
- At the end of the run, create a dedicated AFTER test called **"Coverage report"** in a top-level **Coverage** suite.
- Attach a markdown table log with one row per file, including line / statement / branch / function percentages.

This gives you a single place in Orangebeard where you can inspect per-file coverage for the run.

## Mapping Vitest to Orangebeard

The reporter follows these mapping rules:

- **Test run**
  - `onTestRunStart` creates an Orangebeard test run using the configured `testset`, `description` and `attributes` from the JavaScript client.
  - `onTestRunEnd` waits for any pending async work (attachments) and then finishes the test run.

- **Suites**
  - Each test file becomes a root suite, using the path relative to the current working directory (e.g. `tests/sample.test.ts`).
  - Nested `describe` blocks are represented as nested Orangebeard suites beneath the file suite.

- **Tests**
  - Each Vitest `it`/`test` becomes an Orangebeard test.
  - The test name is taken from `test.name`.
  - The description includes the source location when available, e.g. `sample.test.ts:10`.
  - Status is mapped from Vitest state (`passed`, `failed`, `skipped`, `pending`, ...) to `FinishTest.Status`.

- **BEFORE / AFTER classification**
  - Test names that contain `beforeAll`, `before all`, `beforeEach`, `before each` or `setup` are reported as `TestType.BEFORE`.
  - Test names that contain `afterAll`, `after all`, `afterEach`, `after each` or `teardown` are reported as `TestType.AFTER`.

- **Console logs**
  - `onUserConsoleLog` receives Vitest console events and forwards them as Orangebeard logs.
  - Logs are attached to the running test when possible (using the Vitest task id → test UUID mapping).
  - Logs emitted before a test has started are buffered and flushed as soon as the test is created.

- **Attachments**
  - When Vitest test artifacts are recorded (e.g. screenshots, traces written to disk), `onTestCaseArtifactRecord` logs a short summary entry and uploads the underlying file as an Orangebeard attachment.

## Running this package locally

1. Install dependencies:

```bash
npm install
```

2. Build the TypeScript sources:

```bash
npm run build
```

3. Run the unit tests (including the reporter integration tests):

```bash
npx vitest run --coverage
```

This will also exercise the Orangebeard integration (using the mocked client in tests) and generate a coverage report for the reporter itself.

## Sample project

The `tests/` folder in this repository contains sample tests that exercise:

- Passing, failing, skipped and todo tests.
- Global `beforeAll` / `afterAll` hooks.
- Per-test `beforeEach` / `afterEach` hooks.
- Console logging during tests and hooks.

When you run the sample suite with the reporter configured, you should see in Orangebeard:

- A single test run with a suite named `tests/sample.test.ts` and nested suite `sample suite`.
- Tests for each case and hook, with appropriate status and type (BEFORE / TEST / AFTER).
- Console log entries attached to the relevant tests.
- A **Coverage** suite with a **"Coverage report"** test containing a coverage table per file.
