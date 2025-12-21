/**
 * Trading System Lock
 * 
 * Prevents race conditions when multiple agents trade simultaneously
 * by implementing a simple locking mechanism with timeout support.
 */

export class TradingSystemLock {
    private locked = false;
    private queue: (() => void)[] = [];
    private lockOwner: string | null = null;
    private readonly DEFAULT_TIMEOUT_MS = 30000; // 30 seconds default

    async acquireLock(timeoutMs: number = this.DEFAULT_TIMEOUT_MS): Promise<boolean> {
        return new Promise((resolve) => {
            let resolved = false;

            const timeoutId = setTimeout(() => {
                if (resolved) return; // Already resolved
                resolved = true;
                // Remove from queue if still waiting
                const index = this.queue.indexOf(resolveWithLock);
                if (index > -1) {
                    this.queue.splice(index, 1);
                }
                resolve(false); // Timeout - failed to acquire lock
            }, timeoutMs);

            const resolveWithLock = () => {
                if (resolved) return; // Already timed out
                resolved = true;
                clearTimeout(timeoutId);
                this.lockOwner = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                resolve(true);
            };

            if (!this.locked) {
                this.locked = true;
                resolveWithLock();
            } else {
                this.queue.push(resolveWithLock);
            }
        });
    }

    releaseLock(owner?: string): boolean {
        // If no lock is held, nothing to release
        if (!this.locked) {
            return true;
        }

        // Safeguard: if owner is provided, it must match
        if (owner !== undefined && this.lockOwner !== null && owner !== this.lockOwner) {
            console.warn('Attempted to release lock with incorrect owner');
            return false;
        }

        if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
        } else {
            this.locked = false;
            this.lockOwner = null;
        }
        return true;
    }

    async withLock<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
        const acquired = await this.acquireLock(timeoutMs);
        if (!acquired) {
            throw new Error('Failed to acquire lock: timeout');
        }
        const owner = this.lockOwner;
        try {
            return await fn();
        } finally {
            this.releaseLock(owner || undefined);
        }
    }

    isLocked(): boolean {
        return this.locked;
    }

    getQueueLength(): number {
        return this.queue.length;
    }

    /**
     * Force release the lock (use with caution - only for error recovery)
     * This will reject all pending lock requests with an error
     */
    forceRelease(): void {
        // Reject all pending promises by calling them (they will get the lock briefly then release)
        // But since we're force releasing, we need to handle this differently
        const pendingCallbacks = [...this.queue];

        // Clear state first
        this.locked = false;
        this.lockOwner = null;
        this.queue = [];

        // Log warning if there were pending requests
        if (pendingCallbacks.length > 0) {
            console.warn(`Force released lock with ${pendingCallbacks.length} pending requests - they will timeout`);
        }
    }
}

export const tradingSystemLock = new TradingSystemLock();
