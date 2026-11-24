import type { Server } from 'node:http';

export interface SandboxAppOptions {
  /** Optional API key required via X-AME-API-Key on all endpoints except GET /v1/health. */
  apiKey?: string;
}

export declare function createSandboxApp(options?: SandboxAppOptions): Server;
