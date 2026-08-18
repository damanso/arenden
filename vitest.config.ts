import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './test/globalSetup.ts',
    setupFiles: ['./test/setup.ts'],
    // Testerna delar en riktig Postgres-databas (127.0.0.1:5436) — kör filerna
    // sekventiellt så att DROP/CREATE DATABASE i setup.ts aldrig kapplöper.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
