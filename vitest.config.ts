import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // config.ts validates DOCVAULT_AUTH_SECRET_KEY at import time. Provide a
    // dummy 32-byte hex key so unit tests (and CI, which has no .env) can load
    // modules that import config without standing up a real environment.
    env: {
      DOCVAULT_AUTH_SECRET_KEY: 'a'.repeat(64),
    },
  },
});
