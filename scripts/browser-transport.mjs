import { createServer } from 'node:net';
import { Buffer } from 'node:buffer';

export function createSerializedDispatcher(dispatch) {
  let tail = Promise.resolve();
  return (request) => {
    const operation = tail.then(() => dispatch(request));
    tail = operation.catch(() => undefined);
    return operation;
  };
}

export function createJsonLineServer(dispatch, { maxRequestBytes = 1_000_000, maxResponseBytes = 2_000_000, timeoutMs = 15_000, formatError = (error) => error instanceof Error ? error.message : 'Browser command failed' } = {}) {
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    let content = '';
    let requestBytes = 0;
    let completed = false;
    connection.setEncoding('utf8');
    connection.setTimeout(timeoutMs, () => connection.destroy(new Error('Browser daemon connection timed out')));
    connection.on('error', (error) => {
      completed = true;
      if (!connection.destroyed) connection.destroy(error);
    });
    connection.on('data', (chunk) => {
      if (completed) return;
      requestBytes += Buffer.byteLength(chunk);
      if (requestBytes > maxRequestBytes) {
        completed = true;
        connection.end(JSON.stringify({ ok: false, error: 'Browser daemon request exceeded limit' }));
        return;
      }
      content += chunk;
    });
    connection.on('end', async () => {
      if (completed) return;
      completed = true;
      let request;
      try {
        request = JSON.parse(content.trim());
        const result = await dispatch(request);
        const response = JSON.stringify({ ok: true, ...(result?.closeAfterResponse ? {} : result ? { view: result } : {}) });
        if (Buffer.byteLength(response) > maxResponseBytes) throw new Error('Browser daemon response exceeded limit');
        if (result?.closeAfterResponse) connection.once('close', () => { server.emit('close-after-response'); });
        connection.end(response);
      } catch (error) {
        const message = formatError(error).slice(0, 500);
        connection.end(JSON.stringify({ ok: false, error: message }));
      }
    });
  });
  return server;
}
