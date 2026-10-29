export async function withDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Operation timed out'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
