/**
 * Bounded stream reading for Bun subprocess pipes.
 *
 * A subagent is a `pi` process whose own tools spawn further processes. Those
 * grandchildren inherit the child's stdout/stderr, so the pipe stays open
 * after the direct child has exited. Verified under Bun: after `exited`
 * resolves, `await new Response(proc.stdout).text()` never settles, and
 * `proc.stdout.cancel()` then throws `Cannot cancel a locked ReadableStream`
 * because the pending `Response` owns the lock.
 *
 * The fix is to own the reader instead of handing the stream to `Response`, so
 * the lock can be released explicitly once the child is gone:
 *
 *   const reader = stream.getReader();       // we hold the lock
 *   ...                                     // pump, bounded by a grace period
 *   await reader.cancel();                  // always safe: we own it
 *
 * Partial output is preserved: the pump accumulates everything it read before
 * the deadline, so a hung grandchild costs us the tail, not the whole log.
 */

/** How long to keep reading a pipe after the child has exited. */
const DEFAULT_DRAIN_GRACE_MS = 500;

export interface CollectedStream {
	/** Everything read before the pump finished or the grace period expired. */
	text: string;
	/** True when the pipe reached EOF on its own. */
	complete: boolean;
}

/**
 * Pump a stream to EOF, bounded by `graceMs`, in one call.
 *
 * Only for streams whose writer has already exited: `release` is called
 * immediately, so the grace bounds a post-exit drain. Using this on a live
 * child would race the grace against the child's whole lifetime and silently
 * discard everything the child prints after it. Live children need
 * {@link createStreamPump} plus a `release` after `exited` resolves.
 */
export async function collectStream(
	stream: { getReader(): ReaderLike } | null,
	graceMs: number = DEFAULT_DRAIN_GRACE_MS,
	onChunk?: (text: string) => void,
): Promise<CollectedStream> {
	const pump = createStreamPump(stream, onChunk);
	await pump.release(graceMs);
	return { text: pump.text, complete: pump.complete };
}

interface ReaderLike {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
	releaseLock(): void;
}

export interface StreamPump {
	/** Resolves when the pipe reaches EOF. */
	finished: Promise<void>;
	/** Everything decoded so far. */
	readonly text: string;
	/** True once the pipe closed on its own. */
	readonly complete: boolean;
	/**
	 * Stop waiting for EOF after `graceMs`, then release the lock. Safe to call
	 * once, after the child has exited. Partial output collected so far is kept.
	 */
	release(graceMs?: number): Promise<void>;
}

/**
 * Start consuming a pipe immediately, handing each chunk to `onChunk` as it
 * arrives.
 *
 * The runner needs this (not {@link collectStream}) because the JSONL parser
 * has to see events while the child is still alive: a subagent that runs for
 * minutes must emit `onUpdate` progress throughout, not after it exits.
 */
export function createStreamPump(
	stream: { getReader(): ReaderLike } | null,
	onChunk?: (text: string) => void,
): StreamPump {
	const pump: StreamPump = {
		text: "",
		complete: !stream,
		finished: Promise.resolve(),
		release: async () => {},
	};
	if (!stream) return pump;

	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let complete = false;

	// A consumer callback must never stop consumption: a throwing `onChunk`
	// (the background registry lock under contention, for example) would
	// otherwise trip the read loop's catch, deadhead the pipe, and block the
	// child forever. Consumer errors are swallowed per chunk; the outer catch
	// stays for genuine read failures (a pipe torn down mid-read).
	const deliver = (chunk: string) => {
		text += chunk;
		try {
			onChunk?.(chunk);
		} catch {
			// One bad consumer must not stall the producer.
		}
	};

	const finished = (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					// Flush the decoder so a multibyte character split across the
					// last chunk boundary is not dropped.
					const tail = decoder.decode();
					if (tail) deliver(tail);
					complete = true;
					return;
				}
				if (!value) continue;
				deliver(decoder.decode(value, { stream: true }));
			}
		} catch {
			// A pipe torn down mid-read is not an error here: keep what we read.
		}
	})();

	let released = false;
	pump.finished = finished;
	pump.release = async (graceMs = DEFAULT_DRAIN_GRACE_MS) => {
		if (released) return;
		released = true;
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, graceMs);
			timer.unref?.();
		});
		try {
			await Promise.race([finished, deadline]);
		} finally {
			if (timer) clearTimeout(timer);
			// Cancelling releases the pipe and the lock. We own the lock, so this
			// cannot throw the "locked ReadableStream" error that `stream.cancel()`
			// does when a `Response` holds it.
			await reader.cancel().catch(() => {});
			try {
				reader.releaseLock();
			} catch {
				// A read still pending on a cancelled stream can make releaseLock
				// throw; the lock is being torn down regardless.
			}
		}
	};

	return {
		finished,
		get text() {
			return text;
		},
		get complete() {
			return complete;
		},
		release: (graceMs) => pump.release(graceMs),
	};
}
