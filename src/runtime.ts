import type { Client } from 'discord.js';
import type { JobQueue } from './queue/queue.js';
import type { ReadymodeService } from './readymode/port.js';

/**
 * The handful of long-lived objects the process owns.
 *
 * Set once during boot and read by the pieces that need them — a slash command
 * reporting queue depth, the health endpoint probing the browser session. It
 * is here rather than passed down through every call because the alternative
 * is threading three arguments through the entire Discord layer, and it is
 * here rather than as module-level singletons in those modules because that
 * creates import cycles between the queue, the Discord client and the browser
 * service.
 */

interface Runtime {
  client?: Client;
  queue?: JobQueue;
  readymode?: ReadymodeService;
  startedAt: string;
}

const runtime: Runtime = { startedAt: new Date().toISOString() };

export function setClient(client: Client | undefined): void {
  runtime.client = client;
}

export function setQueue(queue: JobQueue | undefined): void {
  runtime.queue = queue;
}

export function setReadymodeService(service: ReadymodeService | undefined): void {
  runtime.readymode = service;
}

export function getClient(): Client | undefined {
  return runtime.client;
}

export function getQueue(): JobQueue | undefined {
  return runtime.queue;
}

export function getReadymodeService(): ReadymodeService | undefined {
  return runtime.readymode;
}

export function startedAt(): string {
  return runtime.startedAt;
}

export function uptimeSeconds(): number {
  return Math.floor((Date.now() - Date.parse(runtime.startedAt)) / 1000);
}

/** Test helper. */
export function resetRuntime(): void {
  runtime.client = undefined;
  runtime.queue = undefined;
  runtime.readymode = undefined;
  runtime.startedAt = new Date().toISOString();
}
