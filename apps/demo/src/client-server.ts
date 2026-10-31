import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ClientApplication } from '../../client-server/src/app.js';

export interface StartClientServerOptions {
  port: number;
  host?: string;
  root?: string;
  application?: ClientApplication;
}

export interface ClientServer {
  origin: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function staticAsset(staticRoot: string, pathname: string): { file: string; type: string } | undefined {
  if (pathname === '/' || pathname === '/index.html') {
    return { file: join(staticRoot, 'index.html'), type: CONTENT_TYPES['.html']! };
  }
  const match = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(pathname);
  if (match === null) return undefined;
  const name = match[1]!;
  if (name === '.' || name === '..') return undefined;
  const dot = name.lastIndexOf('.');
  const type = dot === -1 ? undefined : CONTENT_TYPES[name.slice(dot).toLowerCase()];
  if (type === undefined) return undefined;
  return { file: join(staticRoot, 'assets', name), type };
}

export async function startClientServer({ port, host = '127.0.0.1', root = process.cwd(), application }: StartClientServerOptions): Promise<ClientServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Client server port must be an integer from 0 to 65535');
  const staticRoot = resolve(root, 'dist/frontend');
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (application && await application.handle(request, response)) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
      const asset = staticAsset(staticRoot, pathname);
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
