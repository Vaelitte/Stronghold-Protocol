// Bounded transfers for art: a shared queue avoids a burst of map textures and
// portraits competing over a slow tunnel. Deadlines cover response bodies too.
export const ART_RETRY_MS = Object.freeze([500, 1500]);
export const ART_TIMEOUT_MS = 45000;

/** @param {{ concurrency?: number, timeout?: number, retryDelays?: readonly number[], wait?: (ms:number)=>Promise<void> }} [options] */
export function createAssetNetwork(options = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const timeout = options.timeout ?? ART_TIMEOUT_MS;
  const delays = options.retryDelays ?? ART_RETRY_MS;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const queue = [];
  let active = 0;
  async function attempt(task) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => task(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => {
          reject(new Error('art transfer timed out'));
          controller.abort();
        }, timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function transfer(task) {
    for (let n = 0; ; n++) {
      try { return await attempt(task); }
      catch (error) {
        const status = error?.status;
        if (error?.permanent || (status >= 400 && status < 500 && status !== 408 && status !== 429) || n >= delays.length) throw error;
        await wait(delays[n]);
      }
    }
  }
  function pump() {
    while (active < concurrency && queue.length) queue.shift()();
  }
  return {
    /** @template T @param {(signal: AbortSignal) => Promise<T>} task @returns {Promise<T>} */
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          active++;
          transfer(task).then(resolve, reject).finally(() => { active--; pump(); });
        });
        pump();
      });
    },
  };
}

export const artNetwork = createAssetNetwork();

/** @param {string} url @param {{ type?: 'json'|'text'|'buffer', fetch?: typeof fetch, cache?: RequestCache }} [options] */
export function fetchArt(url, { type = 'json', fetch: fetcher = globalThis.fetch, cache = 'default' } = {}) {
  return artNetwork.run(async signal => {
    const response = await fetcher(url, { signal, cache });
    if (!response?.ok) throw Object.assign(new Error(`art HTTP ${response?.status}`), { status: response?.status });
    if (type === 'buffer') return response.arrayBuffer();
    if (type === 'text') return response.text();
    try { return await response.json(); }
    catch (error) {
      // A truncated response body is a transport failure, not malformed source data.
      if (error instanceof SyntaxError) throw Object.assign(error, { permanent: true });
      throw error;
    }
  });
}
