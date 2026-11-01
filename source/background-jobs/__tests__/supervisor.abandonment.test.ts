import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCoordinator } from '../coordinator/service.js';
import { JobSupervisor } from '../supervisor/lifecycle.js';
import { SegmentedLogWriter } from '../logging/segment-writer.js';
import { IpcClient } from '../ipc/client.js';
import { getSocketPath } from '../ipc/socket-path.js';
import { DEFAULT_RESOURCE_LIMITS, type LaunchSpec } from '../types.js';
const session = { permissionMode: 'auto-accept' as const, headlessApprovedActions: [] };
let base: string, c: Awaited<ReturnType<typeof createCoordinator>>, s: JobSupervisor, spec: LaunchSpec, id: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agav-af-'));
  c = await createCoordinator({ root: base, admissionRetry: { maxAttempts: 1 } });
  id = randomUUID();
  spec = { requestId: randomUUID(), invocation: { mode: 'direct', executable: process.execPath, args: ['-e', "require('fs').writeFileSync('spawned','bad')"] }, cwd: base, env: {}, credentialRefs: [], isolation: { backend: 'none', required: false }, ownershipScope: 'unverified', limits: DEFAULT_RESOURCE_LIMITS, headless: false, createdAt: new Date().toISOString() };
  await c.repositories.specs.put(spec);
  await c.repositories.jobs.create({ jobId: id, requestId: spec.requestId, specHash: 'fixture', protocolVersion: 1, state: 'unknown', stopState: 'none', nonce: '' });
  s = new JobSupervisor({ jobId: id, requestId: spec.requestId, root: c.root, repositories: c.repositories, socketPath: getSocketPath(c.root, 'job-' + id), logOperationTimeoutMs: 5000 });
  vi.spyOn(IpcClient, 'connectWithRetry').mockRejectedValue(new Error('offline'));
});
afterEach(async () => {
  await s.shutdown();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const exit = () => (s as unknown as {
  handleChildExit(code: number, signal: null): Promise<void>;
}).handleChildExit(0, null);
describe('supervisor-abandonment-fences', () => {
  it('delayed-start-and-late-completion-preserve-tombstone-without-spawn-or-event', async () => {
    await c.abandonJob(id, true, session);
    const saved = await c.repositories.jobs.get(id);
    await s.start(spec);
    await exit();
    expect(await c.repositories.jobs.get(id)).toEqual(saved);
    expect(await c.repositories.events.listPending()).toEqual([]);
    await expect(access(join(base, 'spawned'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rechecks-fence-after-slow-log-initialization-before-spawning', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    }), ready = new Promise<void>(r => {
      entered = r;
    });
    const init = SegmentedLogWriter.prototype.init;
    vi.spyOn(SegmentedLogWriter.prototype, 'init').mockImplementation(async function(this: SegmentedLogWriter) {
      entered();
      await gate;
      await init.call(this);
    });
    const started = s.start(spec);
    try {
      await ready;
      await c.abandonJob(id, true, session);
      const saved = await c.repositories.jobs.get(id);
      release();
      await started;
      expect(await c.repositories.jobs.get(id)).toEqual(saved);
      expect(await c.repositories.events.listPending()).toEqual([]);
      await expect(access(join(base, 'spawned'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    finally {
      release();
      await started;
    }
  });
  it('holds-job-lock-through-event-and-terminal-publication', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    }), ready = new Promise<void>(r => {
      entered = r;
    });
    const create = c.repositories.events.create.bind(c.repositories.events);
    vi.spyOn(c.repositories.events, 'create').mockImplementation(async (event) => {
      entered();
      await gate;
      await create(event);
    });
    const publication = exit();
    try {
      await ready;
      await expect(c.abandonJob(id, true, session)).rejects.toMatchObject({ code: 'lock-held' });
    }
    finally {
      release();
      await publication;
    } await expect(c.abandonJob(id, true, session)).rejects.toMatchObject({ code: 'invalid-state' });
    const job = await c.repositories.jobs.get(id);
    expect(job?.state).toBe('completed');
    expect(job?.abandonment).toBeUndefined();
    expect((await c.repositories.events.listPending()).map(e => e.eventId)).toEqual([job?.resultEventId]);
  });
  it('failed-event-publication-does-not-invent-terminal-outcome', async () => {
    vi.spyOn(c.repositories.events, 'create').mockRejectedValueOnce(new Error('event-disk-failure'));
    await expect(exit()).rejects.toThrow('event-disk-failure');
    expect((await c.repositories.jobs.get(id))?.state).toBe('unknown');
    expect(await c.repositories.events.listPending()).toEqual([]);
    await c.abandonJob(id, true, session);
    await exit();
    expect(await c.repositories.events.listPending()).toEqual([]);
  });
});
