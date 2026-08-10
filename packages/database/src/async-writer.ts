import type { Disposable } from "@ccflare/core";
import { Logger } from "@ccflare/logger";

const logger = new Logger("async-db-writer");

type DbJob = () => void | Promise<void>;

export type DbWriteResult =
	| { data: true; error: null }
	| { data: null; error: Error };

interface QueuedDbJob {
	job: DbJob;
	resolve: (result: DbWriteResult) => void;
}

export class AsyncDbWriter implements Disposable {
	private queue: QueuedDbJob[] = [];
	private running = false;
	private intervalId: Timer | null = null;
	private failureCount = 0;
	private disposePromise: Promise<void> | null = null;
	private currentRunPromise: Promise<void> | null = null;

	constructor() {
		// Process queue every 100ms
		this.intervalId = setInterval(() => void this.processQueue(), 100);
	}

	enqueue(job: DbJob): Promise<DbWriteResult> {
		return new Promise((resolve) => {
			this.queue.push({ job, resolve });
			void this.processQueue();
		});
	}

	private async processQueue(): Promise<void> {
		if (this.running) {
			return this.currentRunPromise ?? Promise.resolve();
		}

		if (this.queue.length === 0) {
			return;
		}

		this.running = true;
		this.currentRunPromise = (async () => {
			try {
				while (this.queue.length > 0) {
					const queuedJob = this.queue.shift();
					if (!queuedJob) continue;
					try {
						await queuedJob.job();
						queuedJob.resolve({ data: true, error: null });
					} catch (error) {
						this.failureCount += 1;
						logger.error("Failed to execute DB job", error);
						queuedJob.resolve({
							data: null,
							error: error instanceof Error ? error : new Error(String(error)),
						});
					}
				}
			} finally {
				this.running = false;
				this.currentRunPromise = null;
			}
		})();

		return this.currentRunPromise;
	}

	isHealthy(): boolean {
		return this.failureCount === 0;
	}

	getFailureCount(): number {
		return this.failureCount;
	}

	getQueueSize(): number {
		return this.queue.length;
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}

		this.disposePromise = (async () => {
			logger.info("Flushing async DB writer queue...");

			// Stop the interval
			if (this.intervalId) {
				clearInterval(this.intervalId);
				this.intervalId = null;
			}

			// Process any remaining jobs
			await this.processQueue();

			logger.info("Async DB writer queue flushed", {
				remainingJobs: this.queue.length,
				failureCount: this.failureCount,
			});
		})();

		return this.disposePromise;
	}
}
