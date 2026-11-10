export const MAX_BLEND_IMAGE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_BLEND_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type LeaseHeartbeatWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export interface SerializedLeaseHeartbeat {
  refreshNow: () => Promise<void>;
  throwIfFailed: () => void;
  stop: () => Promise<void>;
}

function waitForHeartbeat(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Runs one lease refresh at a time. Background failures are retained and
 * re-thrown by the next explicit checkpoint, while stop() aborts the pending
 * timer and awaits every queued refresh so no work escapes the request.
 */
export function startSerializedLeaseHeartbeat(
  refresh: () => Promise<void>,
  intervalMs: number,
  wait: LeaseHeartbeatWait = waitForHeartbeat,
): SerializedLeaseHeartbeat {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Lease heartbeat interval must be positive");
  }

  const abortController = new AbortController();
  let stopping = false;
  let failure: Error | null = null;
  let refreshTail: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | null = null;

  const rememberFailure = (error: unknown) => {
    if (!failure) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    abortController.abort();
  };

  const refreshNow = (): Promise<void> => {
    if (failure) return Promise.reject(failure);
    if (stopping) {
      return Promise.reject(new Error("Lease heartbeat is stopped"));
    }

    const attempt = refreshTail.then(async () => {
      if (failure) throw failure;
      await refresh();
    });
    // Attach the rejection handler immediately: callers still receive the
    // original attempt, while the internal tail always settles and records the
    // first failure without creating an unhandled rejection.
    refreshTail = attempt.then(
      () => undefined,
      (error) => rememberFailure(error),
    );
    return attempt;
  };

  const loopDone = (async () => {
    while (!stopping && !failure) {
      await wait(intervalMs, abortController.signal);
      if (stopping || failure || abortController.signal.aborted) break;
      try {
        await refreshNow();
      } catch {
        break;
      }
    }
  })().catch(rememberFailure);

  return {
    refreshNow,
    throwIfFailed: () => {
      if (failure) throw failure;
    },
    stop: () => {
      if (!stopPromise) {
        stopping = true;
        abortController.abort();
        stopPromise = (async () => {
          await loopDone;
          await refreshTail;
        })();
      }
      return stopPromise;
    },
  };
}

export interface BlendImageRecord {
  id: string;
  file_size: number | string;
  mime_type: string;
  storage_path: string | null;
}

export type ValidatedBlendImageRecord = BlendImageRecord & {
  storage_path: string;
};

export function validateBlendImageRecords(
  images: BlendImageRecord[] | null,
  ticketId: string,
): asserts images is ValidatedBlendImageRecord[] {
  if (!images || images.length < 1 || images.length > 20) {
    throw new Error("Blend ticket OCR requires 1 to 20 images");
  }
  const pathPattern = new RegExp(
    `^(?:[0-9]{4}/[0-9]{2}/)?${ticketId}/[1-9][0-9]*\\.(jpg|jpeg|png|webp)$`,
  );
  for (const image of images) {
    const fileSize = Number(image.file_size);
    if (
      !Number.isFinite(fileSize) ||
      fileSize < 1 ||
      fileSize > MAX_BLEND_IMAGE_BYTES ||
      !ALLOWED_BLEND_IMAGE_TYPES.has(image.mime_type) ||
      typeof image.storage_path !== "string" ||
      !pathPattern.test(image.storage_path)
    ) {
      throw new Error(
        `Invalid image metadata for blend ticket image ${image.id}`,
      );
    }
  }
}

export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Blend ticket image exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    throw new Error("Blend ticket image response has no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("image size limit exceeded");
      throw new Error(`Blend ticket image exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchSignedBlendImage(
  image: ValidatedBlendImageRecord,
  createSignedUrl: (path: string) => Promise<{
    data: { signedUrl?: string } | null;
    error: { message?: string } | null;
  }>,
  fetcher: typeof fetch = fetch,
  fetchTimeoutMs = 45_000,
  signTimeoutMs = fetchTimeoutMs,
): Promise<Uint8Array> {
  if (!Number.isFinite(signTimeoutMs) || signTimeoutMs <= 0) {
    throw new Error("Signed URL timeout must be positive");
  }

  let signTimeout: ReturnType<typeof setTimeout> | undefined;
  const signingTimedOut = new Promise<never>((_resolve, reject) => {
    signTimeout = setTimeout(() =>
      reject(
        new Error(
          `Timed out signing blend ticket image ${image.id} after ${signTimeoutMs}ms`,
        ),
      ), signTimeoutMs);
  });

  let signedResult: Awaited<ReturnType<typeof createSignedUrl>>;
  try {
    signedResult = await Promise.race([
      createSignedUrl(image.storage_path),
      signingTimedOut,
    ]);
  } finally {
    if (signTimeout !== undefined) clearTimeout(signTimeout);
  }

  const { data, error } = signedResult;
  if (error || !data?.signedUrl) {
    throw new Error(
      `Failed to sign blend ticket image ${image.id}: ${
        error?.message ?? "signed URL missing"
      }`,
    );
  }

  const response = await fetcher(data.signedUrl, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch image ${image.id}: ${response.status}`);
  }
  const responseType = response.headers.get("content-type")
    ?.split(";", 1)[0].trim().toLowerCase();
  if (!responseType || !ALLOWED_BLEND_IMAGE_TYPES.has(responseType)) {
    throw new Error(
      `Invalid image content type for blend ticket image ${image.id}`,
    );
  }
  return readBodyWithLimit(response, MAX_BLEND_IMAGE_BYTES);
}

export const REFERENCE_PAGE_SIZE = 1000;
// Live has about 1,050 active products. A list 50 times that is not a real
// catalog, so the scan fails loudly instead of running out of time or memory.
export const REFERENCE_MAX_ROWS = 50_000;

/**
 * Read every row of a reference list in id order, one page after another.
 * A single read stops at the PostgREST row cap (1,000), which silently hid
 * every product past it from OCR matching (KI-32). Paging on "id greater than
 * the last id read" never repeats or skips a row that exists for the whole
 * read, and stops only on an empty page, so a server cap below the requested
 * page size still reads everything. Any failed page throws: never a partial list.
 */
export async function readAllById<T extends { id: string }>(
  fetchPage: (
    afterId: string | null,
    limit: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await fetchPage(afterId, REFERENCE_PAGE_SIZE);
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("Reference read returned no list");
    if (data.length === 0) return rows;
    const lastId = data[data.length - 1].id;
    // A page that does not move past the last id would loop forever.
    if (typeof lastId !== "string" || (afterId !== null && lastId <= afterId)) {
      throw new Error("Reference read did not advance");
    }
    for (const row of data) rows.push(row);
    if (rows.length > REFERENCE_MAX_ROWS) {
      throw new Error(`Reference read passed ${REFERENCE_MAX_ROWS} rows`);
    }
    afterId = lastId;
  }
}
