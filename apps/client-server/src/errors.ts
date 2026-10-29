export class UpstreamError extends Error {
  constructor(message = 'Upstream request failed') {
    super(message);
  }
}

export function boundedFetcher(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetcher(input, init);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError();
    }
  };
}
