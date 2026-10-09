/**
 * Length-prefixed JSON message framing (T06).
 *
 * Wire format: a 4-byte big-endian unsigned length prefix followed by that
 * many bytes of UTF-8 encoded JSON. This is used for both directions of the
 * duplex IPC connection (client -> server requests, server -> client
 * responses/events).
 *
 * Bounded per solution.md §6 "bounded message framing": `FrameDecoder` never
 * buffers past `maxFrameBytes` worth of pending data for a single frame. If
 * the declared length prefix (or the amount of unparsed buffered data before
 * a length prefix is even known) would exceed that bound, decoding throws a
 * `FrameSizeExceededError` and the caller MUST close/destroy the connection
 * — the decoder does not attempt to resynchronize a corrupt/hostile stream.
 */

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB

const LENGTH_PREFIX_BYTES = 4;

export class FrameSizeExceededError extends Error {
  constructor(public readonly declaredLength: number, public readonly maxFrameBytes: number) {
    super(`Frame size ${declaredLength} exceeds maximum of ${maxFrameBytes} bytes`);
    this.name = "FrameSizeExceededError";
  }
}

export class FrameParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "FrameParseError";
  }
}

/**
 * Encode an arbitrary JSON-serializable value into a single length-prefixed
 * frame buffer ready to write to a socket.
 */
export function encodeFrame(obj: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  if (json.length > 0xffffffff) {
    throw new FrameSizeExceededError(json.length, 0xffffffff);
  }
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Incremental decoder: feed raw bytes via `push()`, receive fully decoded
 * JSON messages via the `onMessage` callback supplied at construction. Also
 * exposes an async-iterator interface (`for await (const msg of decoder)`)
 * for callers that prefer that style; both delivery mechanisms see every
 * message exactly once per decoder instance — do not mix them on the same
 * decoder.
 *
 * On a bounds violation or malformed frame, `onError` is invoked (and/or the
 * async iterator throws) and the decoder enters a permanently failed state:
 * further `push()` calls are no-ops. The owning connection must be closed by
 * the caller; this class never touches sockets directly.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private failed = false;
  private readonly maxFrameBytes: number;
  private readonly onMessage?: (msg: unknown) => void;
  private readonly onError?: (err: Error) => void;

  // Support for the async-iterator consumption style.
  private pendingWaiters: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (err: Error) => void;
  }> = [];
  private queued: unknown[] = [];
  private iterDone = false;
  private iterError: Error | null = null;

  constructor(options?: {
    maxFrameBytes?: number;
    onMessage?: (msg: unknown) => void;
    onError?: (err: Error) => void;
  }) {
    this.maxFrameBytes = options?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.onMessage = options?.onMessage;
    this.onError = options?.onError;
  }

  /** Feed newly received bytes. Safe to call repeatedly as data arrives. */
  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // Reject early if we've buffered more than the bound without a complete
    // frame yet (covers both a huge declared length and a client that never
    // sends a valid length prefix at all).
    if (this.buffer.length > this.maxFrameBytes + LENGTH_PREFIX_BYTES) {
      this.fail(new FrameSizeExceededError(this.buffer.length - LENGTH_PREFIX_BYTES, this.maxFrameBytes));
      return;
    }

    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) return;
      const length = this.buffer.readUInt32BE(0);
      if (length > this.maxFrameBytes) {
        this.fail(new FrameSizeExceededError(length, this.maxFrameBytes));
        return;
      }
      if (this.buffer.length < LENGTH_PREFIX_BYTES + length) return; // wait for more data

      const payload = this.buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
      this.buffer = this.buffer.subarray(LENGTH_PREFIX_BYTES + length);

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch (cause) {
        this.fail(new FrameParseError("Failed to parse frame payload as JSON", cause));
        return;
      }
      this.emit(parsed);
    }
  }

  private emit(msg: unknown): void {
    this.onMessage?.(msg);
    const waiter = this.pendingWaiters.shift();
    if (waiter) {
      waiter.resolve({ value: msg, done: false });
    } else {
      this.queued.push(msg);
    }
  }

  private fail(err: Error): void {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.iterError = err;
    this.onError?.(err);
    while (this.pendingWaiters.length > 0) {
      const waiter = this.pendingWaiters.shift()!;
      waiter.reject(err);
    }
  }

  /** Signal no more data will arrive (e.g. socket closed). Ends iteration cleanly. */
  end(): void {
    this.iterDone = true;
    while (this.pendingWaiters.length > 0) {
      const waiter = this.pendingWaiters.shift()!;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.queued.length > 0) {
          return Promise.resolve({ value: this.queued.shift(), done: false });
        }
        if (this.iterError) return Promise.reject(this.iterError);
        if (this.iterDone) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<unknown>>((resolve, reject) => {
          this.pendingWaiters.push({ resolve, reject });
        });
      },
    };
  }
}
