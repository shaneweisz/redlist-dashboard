/**
 * A species' default iNaturalist photo, once per name per page.
 *
 * The dashboard's species table has shown these for a long time, keyed by
 * scientific name through our own proxy route (which shares Vercel's edge
 * cache rather than every browser asking iNaturalist afresh). This is the
 * client-side half of that: the same name asked for twice — two lists, or one
 * list scrolled away and back — makes one request.
 */
export type InatThumbnail = { squareUrl: string | null; mediumUrl: string | null } | null;

const cache = new Map<string, InatThumbnail>();
const inFlight = new Map<string, Promise<InatThumbnail>>();

/**
 * At most a few in the air at once, the rest queued.
 *
 * Rows ask as they are scrolled to, so a reader dragging the scrollbar down a
 * hundred-species list could otherwise put a hundred requests in flight inside
 * a couple of seconds. Most are absorbed by the edge cache in front of the
 * route, but the first person to look at a species is a real call to
 * iNaturalist, and they ask politely for fewer than sixty a minute. Four at a
 * time is invisible to a reader — the photos still fill in ahead of the scroll
 * — and bounds what we can do to them however fast the list is dragged.
 */
const MAX_IN_FLIGHT = 4;
let running = 0;
const queue: (() => void)[] = [];

function withLimit<T>(work: () => Promise<T>): Promise<T> {
  const start = () => {
    running += 1;
    return work().finally(() => {
      running -= 1;
      queue.shift()?.();
    });
  };
  if (running < MAX_IN_FLIGHT) return start();
  return new Promise<T>((resolve, reject) => {
    queue.push(() => start().then(resolve, reject));
  });
}

/** What is already held for this name, if it has been asked for. */
export function cachedThumbnail(name: string): InatThumbnail | undefined {
  return cache.get(name);
}

export function loadThumbnail(name: string): Promise<InatThumbnail> {
  const held = cache.get(name);
  if (held !== undefined) return Promise.resolve(held);
  const already = inFlight.get(name);
  if (already) return already;

  const p = withLimit(() => fetch(`/api/inat/thumbnail?name=${encodeURIComponent(name)}`))
    .then((r) => (r.ok ? r.json() : { inatDefaultImage: null }))
    .then((body) => {
      const image = (body?.inatDefaultImage ?? null) as InatThumbnail;
      cache.set(name, image);
      return image;
    })
    // A species iNaturalist has no photo for and a request that failed look the
    // same to the reader — an icon — so a failure is cached like an absence
    // rather than retried on every scroll.
    .catch(() => {
      cache.set(name, null);
      return null;
    })
    .finally(() => inFlight.delete(name));

  inFlight.set(name, p);
  return p;
}
