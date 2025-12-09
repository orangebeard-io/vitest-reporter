import { describe, it, expect, recordArtifact } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Integration-style test: create a real artifact file so the configured
// OrangebeardVitestReporter can upload it as an attachment.
//
// When this test runs with the Orangebeard reporter enabled in vitest.config.ts
// and a valid Orangebeard configuration present, you should see an attachment
// on this test in Orangebeard.

describe('Orangebeard integration: artifacts', () => {
  it('creates a text artifact file and records it', async ({ task }) => {
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });

    const filePath = path.join(artifactsDir, `artifact-${Date.now()}.txt`);
    fs.writeFileSync(filePath, 'Artifact content for Orangebeard attachment test');

    await recordArtifact(task as any, {
      type: 'orangebeard:attachment',
      attachments: [
        {
          path: filePath,
          contentType: 'text/plain',
        },
      ],
    } as any);

    // Sanity check so the test has an assertion
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
