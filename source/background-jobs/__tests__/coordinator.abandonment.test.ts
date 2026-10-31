import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCoordinator } from '../coordinator/service.js';
import { reserveCapacity } from '../coordinator/admission.js';
import { getPlatformAdapter } from '../platform/index.js';
import { normalizeLaunchSpec } from '../launch-spec/normalize.js';
import { hashLaunchSpecForConsent } from '../authorization/spec-hash.js';
import { IpcClient } from '../ipc/client.js';
import { withCoordinatorLock, withJobLock } from '../storage/single-writer-lock.js';
import { jobPath } from '../storage/paths.js';
import type { JobRecord, StartJobRequest } from '../types.js';
const session = { permissionMode: 'auto-accept' as const, headlessApprovedActions: [] };
let base: string;
let c: Awaited<ReturnType<typeof createCoordinator>>;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agav-ab-'));
  c = await createCoordinator({ root: base });
  vi.spyOn(IpcClient, 'connectWithRetry').mockRejectedValue(new Error('offline'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
async function seed(state: JobRecord['state'] = 'recovery-required') {
  const request: StartJobRequest = { requestId: randomUUID(), invocation: { mode: 'direct', executable: process.execPath, args: ['-e', 'process.exit(97)'] }, cwd: base, isolation: { backend: 'none', required: false } };
  const adapter = await getPlatformAdapter(), caps = await adapter.detectCapabilities();
  const spec = await normalizeLaunchSpec({ ...request, platform: adapter.platform, ownershipScope: caps.strongestOwnershipScope, canonicalizeCwd: p => adapter.canonicalizePath(p) });
  const { requestId, createdAt: _createdAt, ...consent } = spec;
  const record: JobRecord = { jobId: randomUUID(), requestId, specHash: hashLaunchSpecForConsent(consent), protocolVersion: 1, state, stopState: 'none', nonce: '', uncertaintyReason: 'ambiguous-dispatch' };
  await c.repositories.specs.put(spec);
  await c.repositories.jobs.create(record);
  return { record, request, spec };
}
const capacity = () => reserveCapacity(c.repositories, c.root, { maxConcurrentJobs: 4 });
describe('operator-abandonment', () => {
  it.each(['recovery-required', 'unknown'] as const)('retains-%s-evidence-releases-capacity-and-survives-restart-without-replay', async (state) => {
    const { record, request, spec } = await seed(state);
    for(let i = 0;
      i < 3;
      i++)
      await seed();
    expect(await capacity()).toEqual({ granted: false, activeCount: 4 });
    await expect(c.start({ ...request, requestId: randomUUID() }, session)).rejects.toMatchObject({ code: 'capacity-exceeded' });
    const summary = await c.abandonJob(record.jobId, true, session), saved = await c.repositories.jobs.get(record.jobId);
    expect(saved).toEqual({ ...record, abandonment: { abandonedAt: expect.any(String), acknowledgement: 'outcome-and-descendants-unverified', previousState: state, previousNonce: '' } });
    expect(Number.isNaN(Date.parse(saved!.abandonment!.abandonedAt))).toBe(false);
    expect(await capacity()).toEqual({ granted: true, activeCount: 3 });
    const bytes = await readFile(jobPath(c.root, record.jobId), 'utf8'), reopened = await createCoordinator({ root: base });
    expect(await reopened.abandonJob(record.jobId, true, session)).toMatchObject(summary);
    expect(await reopened.poll(record.jobId)).toMatchObject(summary);
    expect(await reopened.start(request, session)).toMatchObject(summary);
    await expect(reopened.start({ ...request, invocation: { mode: 'direct', executable: process.execPath, args: ['different'] } }, session)).rejects.toMatchObject({ code: 'spec-changed' });
    expect(await reopened.findByRequestId(request.requestId)).toMatchObject(summary);
    await reopened.reconcile({ olderThanMs: 0 });
    expect((await reopened.stop(record.jobId, session)).abandonment).toEqual(saved!.abandonment);
    await expect(reopened.cleanup(record.jobId, session)).rejects.toMatchObject({ code: 'not-found', message: expect.stringContaining('not in a terminal state') });
    await expect(reopened.deleteJob(record.jobId)).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(reopened.repositories.jobs.delete(record.jobId)).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(reopened.repositories.jobs.update(record.jobId, { state: 'completed' })).rejects.toMatchObject({ code: 'invalid-state' });
    expect(await readFile(jobPath(c.root, record.jobId), 'utf8')).toBe(bytes);
    expect(await reopened.repositories.specs.get(request.requestId)).toEqual(spec);
    expect(await reopened.repositories.events.listPending()).toEqual([]);
    expect(await reopened.repositories.controlIntents.listForJob(record.jobId)).toEqual([]);
    expect(await reopened.repositories.jobs.list()).toHaveLength(4);
  });
});
describe('abandonment-refusals-and-races', () => {
  it('requires-ack-full-ID-and-write-policy', async () => {
    const { record } = await seed();
    await expect(c.abandonJob(record.jobId, false, session)).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(c.abandonJob(record.jobId, true, { ...session, permissionMode: 'deny-writes' })).rejects.toMatchObject({ code: 'authorization-denied' });
    await expect(c.abandonJob(record.jobId.slice(0, 8), true, session)).rejects.toMatchObject({ code: 'invalid-state' });
    expect(await c.repositories.jobs.get(record.jobId)).toEqual(record);
  });
  it.each(['completed', 'failed', 'interrupted'] as const)('refuses-%s', async (state) => {
    const { record } = await seed(state);
    await expect(c.abandonJob(record.jobId, true, session)).rejects.toMatchObject({ code: 'invalid-state' });
    expect(await c.repositories.jobs.get(record.jobId)).toEqual(record);
  });
  it('refuses-fresh-reconnect-evidence', async () => {
    const { record } = await seed('unknown');
    const close = vi.fn(async () => { });
    vi.mocked(IpcClient.connectWithRetry).mockResolvedValue({ request: async () => ({ type: 'poll', job: { ...record, state: 'running' } }), close } as unknown as IpcClient);
    await expect(c.abandonJob(record.jobId, true, session)).rejects.toMatchObject({ code: 'invalid-state', message: expect.stringContaining('reconnected') });
    expect(close).toHaveBeenCalledOnce();
    expect(await c.repositories.jobs.get(record.jobId)).toEqual(record);
  });
  it('publication-failure-retains-capacity-and-is-retryable', async () => {
    const { record } = await seed();
    const update = vi.spyOn(c.repositories.jobs, 'update').mockRejectedValueOnce(new Error('injected-disk-failure'));
    await expect(c.abandonJob(record.jobId, true, session)).rejects.toThrow('injected-disk-failure');
    expect(await c.repositories.jobs.get(record.jobId)).toEqual(record);
    expect((await capacity()).activeCount).toBe(1);
    update.mockRestore();
    await c.abandonJob(record.jobId, true, session);
    expect((await capacity()).activeCount).toBe(0);
  });
  it.each(['coordinator', 'job'] as const)('refuses-fresh-%s-lock', async (kind) => {
    const { record } = await seed();
    const other = await createCoordinator({ root: base, admissionRetry: { maxAttempts: 1 } });
    let run!: () => void;
    const pending = new Promise<void>(resolve => {
      run = resolve;
    }).then(() => expect(other.abandonJob(record.jobId, true, session)).rejects.toMatchObject({ code: 'lock-held' }));
    const body = async () => {
      run();
      await pending;
    };
    if(kind === 'job')
      await withJobLock(c.root, record.jobId, body);
    else
      await withCoordinatorLock(c.root, body);
    expect(await c.repositories.jobs.get(record.jobId)).toEqual(record);
  });
  it.each([{ state: 'completed' as const, exitCode: 0 }, { nonce: 'new-handshake' }, { heartbeatAt: '2026-10-20T00:00:00Z' }])('rejects-concurrently-changed-evidence-%j', async (patch) => {
    const { record } = await seed('unknown');
    const get = c.repositories.jobs.get.bind(c.repositories.jobs);
    vi.mocked(IpcClient.connectWithRetry).mockImplementationOnce(async () => {
      await c.repositories.jobs.update(record.jobId, patch);
      throw new Error('offline-after-concurrent-publication');
    });
    await expect(c.abandonJob(record.jobId, true, session)).rejects.toMatchObject({ code: 'invalid-state' });
    expect(await get(record.jobId)).toEqual({ ...record, ...patch });
  });
});
