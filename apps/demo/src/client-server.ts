import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ClientApplication } from '../../client-server/src/app.js';

export interface ClientServerConfig {
  origins: { authority: string; policy: string; simulation: string };
  actors?: { registry: string; home: string; player: string; policy: string; simulation: string };
}

export interface StartClientServerOptions {
  port: number;
  host?: string;
  config: ClientServerConfig;
  root?: string;
  application?: ClientApplication;
}

export interface ClientServer {
  origin: string;
  close(): Promise<void>;
}

export async function startClientServer({ port, host = '127.0.0.1', config, root = process.cwd(), application }: StartClientServerOptions): Promise<ClientServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Client server port must be an integer from 0 to 65535');
  const staticRoot = resolve(root);
  const allowed: Record<string, { file: string; type: string }> = {
    '/': { file: resolve(staticRoot, 'apps/client/index.html'), type: 'text/html; charset=utf-8' },
    '/index.html': { file: resolve(staticRoot, 'apps/client/index.html'), type: 'text/html; charset=utf-8' },
    '/styles.css': { file: resolve(staticRoot, 'apps/client/styles.css'), type: 'text/css; charset=utf-8' },
    '/dist/client/main.js': { file: resolve(staticRoot, 'dist/client/main.js'), type: 'text/javascript; charset=utf-8' }
  };
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (application && await application.handle(request, response)) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
      if (pathname === '/config.json') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(config));
        return;
      }
      const asset = allowed[pathname];
      if (!asset) { response.writeHead(404); response.end(); return; }
      const content = await readFile(asset.file);
      response.writeHead(200, { 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : content);
    })().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!response.headersSent) { response.writeHead(404); response.end(); }
        return;
      }
      if (!response.headersSent) { response.writeHead(500); response.end(); }
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Client server did not bind to a TCP address');
  let closed = false;
  return {
    origin: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      if (server.listening) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  };
}
