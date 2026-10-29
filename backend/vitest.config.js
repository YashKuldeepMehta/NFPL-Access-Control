import 'dotenv/config';
import { defineConfig } from 'vitest/config';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is not set (see .env.example). Tests wipe that database.');

export default defineConfig({
  test: {
    env: { DATABASE_URL: testUrl, NODE_ENV: 'test' },   // the app under test talks ONLY to the test database
    globalSetup: ['./tests/helpers/globalSetup.js'],      // rebuild schema + load sample data once per run
    setupFiles: ['./tests/helpers/teardown.js'],
    fileParallelism: false,                               // all files share one database
    testTimeout: 60_000,
    hookTimeout: 180_000,                                 // Neon may need time to wake up
  },
});
