// Wire format: 4-byte big-endian length prefix + UTF-8 JSON, in both directions.
// FrameDecoder never buffers past `maxFrameBytes` per frame; on a violation the caller
// MUST close the connection (no attempt is made to resynchronize a corrupt/hostile stream).

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
 * Feed bytes via `push()`; messages arrive via `onMessage` or the async iterator
 * (don't mix the two on one decoder). After a bounds violation or malformed frame the
 * decoder is permanently failed and further `push()` calls are no-ops.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private failed = false;
  private readonly maxFrameBytes: number;
  private readonly onMessage?: (msg: unknown) => void;
  private readonly onError?: (err: Error) => void;

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

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // Reject early once over the bound without a complete frame.
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

  /** Call when the socket closes; ends iteration cleanly. */
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
