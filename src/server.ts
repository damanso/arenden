// VIKTIGT: config importeras FÖRST — den laddar .env och fail-fastar på
// ofullständig miljö innan någon annan modul hinner läsa den.
import { config } from './config.js';
import { assertAppRollArBegransad, closePool } from './db/pool.js';
import { createApp } from './http/app.js';

// Fail-fast: vägra ta emot trafik om DATABASE_URL pekar på en för privilegierad
// roll — då vore append-only-spärren på events tyst avstängd.
try {
  await assertAppRollArBegransad();
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
  await closePool();
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`Ärende-API lyssnar på ${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} mottagen — stänger ner`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
