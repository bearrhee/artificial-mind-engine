import type { Server } from 'node:http';

export interface SandboxAppOptions {
  /** Optional API key required via X-AME-API-Key on all endpoints except GET / and GET /v1/health. */
  apiKey?: string;
  /** Pluggable persistence mode: 'memory' (default), 'file', or 'postgres-redis'. */
  storageMode?: 'memory' | 'file' | 'postgres-redis';
  /** Target JSON persistence path when storageMode === 'file'. */
  storagePath?: string;
}

export declare function createSandboxApp(options?: SandboxAppOptions): Server;
