#!/usr/bin/env node
import { createSandboxApp } from '../src/app.mjs';

const port = Number.parseInt(process.env.AME_PORT || '8090', 10);
const host = process.env.AME_HOST || '127.0.0.1';
const apiKey = process.env.AME_API_KEY || undefined;
const storageMode = process.env.AME_STORAGE_MODE || 'memory';
const storagePath = process.env.AME_STORAGE_PATH || './.ame-sandbox-state.json';

const server = createSandboxApp({ apiKey, storageMode, storagePath });

server.listen(port, host, () => {
  const addr = server.address();
  const activePort = typeof addr === 'object' && addr ? addr.port : port;
  console.log('====================================================================');
  console.log(' Artificial Mind Engine (AME) - Contract Sandbox Server');
  console.log(` Listening on http://${host}:${activePort}`);
  console.log(` Demo Console: http://${host}:${activePort}/`);
  console.log(
    ` Mode: sandbox-contract | Storage: ${storageMode}${storageMode === 'file' ? ` (${storagePath})` : ''} | Auth: ${apiKey ? 'X-AME-API-Key enabled' : 'open (zero-key local)'}`
  );
  console.log(' Notice: Simulates OpenAPI 3.1 contracts cleanly for local dev.');
  console.log('         Proprietary weights & equations stay inside Sealed Kernel.');
  console.log('====================================================================');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[ame-sandbox] Received ${signal}, shutting down gracefully...`);
  server.close((err) => {
    if (err) {
      console.error('[ame-sandbox] Shutdown error:', err);
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
