import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

let sharedState: string[] = [];

beforeAll(() => {
  // Global setup hook, should be visible in logs
  console.log('beforeAll: global test setup');
  sharedState.push('global-setup');
});

afterAll(() => {
  // Global teardown hook, should be visible in logs
  console.log('afterAll: global test teardown');
  sharedState.push('global-teardown');
});

describe('sample suite', () => {
  beforeEach(() => {
    console.log('beforeEach: per-test setup');
    sharedState.push('each-setup');
  });

  afterEach(() => {
    console.log('afterEach: per-test teardown');
    sharedState.push('each-teardown');
  });

  it('beforeEach hook for sample suite', () => {
    console.log('Executing BEFORE hook logic for sample suite');
    expect(sharedState).toContain('each-setup');
  });

  it('passes with a simple assertion', () => {
    console.log('This is a passing test log');
    expect(1 + 1).toBe(2);
  });

  it('fails with an error', () => {
    console.error('This is an error log before failure');
    expect(() => {
      throw new Error('Expected failure in sample test');
    }).toThrowError('different message');
  });

  it.skip('is skipped', () => {
    console.log('This should not run');
  });

  it.todo('is marked as todo');

  it('afterAll hook for sample suite', () => {
    console.log('Executing AFTER hook logic for sample suite');
    expect(sharedState).toContain('global-teardown');
  });

  it('afterEach hook for sample suite', () => {
    console.log('Executing AFTER EACH hook logic for sample suite');
    expect(sharedState).toContain('each-teardown');
  });
});
