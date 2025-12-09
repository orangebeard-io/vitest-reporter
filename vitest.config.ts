import { defineConfig } from 'vitest/config';
import OrangebeardVitestReporter from './dist';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    reporters: [new OrangebeardVitestReporter(), 'default'],
    coverage: {
      enabled: false,
      include: ['src/**/*.{ts,tsx}']
    }
  },
});
