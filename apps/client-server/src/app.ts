import type { IncomingMessage, ServerResponse } from 'node:http';
import { openClientState, type ClientApplicationState } from './store.js';

export interface ClientApplication {
  readonly state: ClientApplicationState;
  readonly seedServers: readonly string[];
  readonly fetch: typeof fetch;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateClientApplicationOptions {
  storeFile: string;
  seedServers?: readonly string[];
  fetch?: typeof fetch;
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function createClientApplication(options: CreateClientApplicationOptions): Promise<ClientApplication> {
  const state = await openClientState(options.storeFile);
  return {
    state,
    seedServers: [...(options.seedServers ?? [])],
    fetch: options.fetch ?? fetch,
    async handle(request, response) {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (!isApiPath(pathname)) return false;
      if (request.method === 'GET' && pathname === '/api/health') {
        writeJson(response, 200, { status: 'ok' });
        return true;
      }
      writeJson(response, 404, { error: 'not-found' });
      return true;
    },
    close: () => Promise.resolve()
  };
}
