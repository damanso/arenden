import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './test/globalSetup.ts',
    setupFiles: ['./test/setup.ts'],
    // Testerna delar en riktig Postgres-databas (127.0.0.1:5436) — kör filerna
    // sekventiellt så att DROP/CREATE DATABASE i setup.ts aldrig kapplöper.
    fileParallelism: false,
    // Noll körda prov är aldrig grönt (FR-20, FR-40, B-17, Story 7.3). Fältet står uttryckligen, så att
    // garantin bor i repot och inte i vitests standardvärde.
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
