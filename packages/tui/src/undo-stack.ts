/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/** Push a deep clone of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/**
	 * Push a snapshot the caller has already detached from live state.
	 * No clone is performed — the caller hands over ownership, and the
	 * snapshot must not share mutable state with anything the caller
	 * keeps mutating afterwards. Use when the snapshot is built from
	 * cheap immutable shares (string arrays, immutable payload objects)
	 * and a deep clone would copy large payloads on every push.
	 */
	pushDetached(state: S): void {
		this.stack.push(state);
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
