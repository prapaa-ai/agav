import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCoordinator } from '../background-jobs/coordinator/service.js';
import { runJobCli } from '../cli/job-cli.js';
import { jobCommand } from '../commands/job.js';
import { __setSharedCoordinatorForTests } from '../background-jobs-integration.js';
import { formatJobSummary, describeStopResult } from '../resources/job-adapters.js';
import type { CommandContext } from '../commands/types.js';
let root: string, id: string, c: Awaited<ReturnType<typeof createCoordinator>>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agav-ac-'));
  c = await createCoordinator({ root });
  id = randomUUID();
  await c.repositories.jobs.create({ jobId: id, requestId: randomUUID(), specHash: 'fixture', protocolVersion: 1, state: 'recovery-required', stopState: 'none', nonce: '', uncertaintyReason: 'ambiguous' });
  __setSharedCoordinatorForTests(c);
});
afterEach(async () => {
  __setSharedCoordinatorForTests(null);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const context = (permissionMode = 'auto-accept', enabled = true) => ({ config: { permissionMode, backgroundJobsEnabled: enabled } } as unknown as CommandContext);
async function cli(args: string[], permissionMode: 'auto-accept' | 'deny-writes' = 'auto-accept', enabled = true) {
  let out = '', err = '';
  const code = await runJobCli(args, {
    getCoordinator: async () => c, loadConfig: async () => ({ permissionMode, backgroundJobsEnabled: enabled }), stdout: s => {
      out += s;
    }, stderr: s => {
      err += s;
    }
  });
  return { code, out, err };
}
async function slash(args: string, ctx = context()) {
  const result = await jobCommand.execute(args, ctx);
  expect(result.type).toBe('message');
  return result.type === 'message' ? result.text : '';
}
describe('abandon-command-guards', () => {
  it.each(['cli', 'slash'])('requires-explicit-ack-and-exact-full-ID-in-%s', async (kind) => {
    for(const args of [['abandon', id], ['abandon', id, '--wrong'], ['abandon', id, '--acknowledge-unverified', 'extra'], ['abandon', id.slice(0, 8), '--acknowledge-unverified']]) {
      if(kind === 'cli') {
        const r = await cli(args);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/Usage|exact.full/i);
      }
      else
        expect(await slash(args.join(' '))).toMatch(/Usage|exact.full/i);
      expect((await c.repositories.jobs.get(id))?.abandonment).toBeUndefined();
    }
  });
  it.each(['cli', 'slash'])('deny-writes-and-opt-in-gate-apply-in-%s', async (kind) => {
    const args = ['abandon', id, '--acknowledge-unverified'];
    if(kind === 'cli') {
      expect((await cli(args, 'deny-writes')).code).toBe(1);
      expect((await cli(args, 'auto-accept', false)).err).toContain('not enabled');
    }
    else {
      expect(await slash(args.join(' '), context('deny-writes'))).toContain('deny-writes');
      expect(await slash(args.join(' '), context('auto-accept', false))).toContain('not enabled');
    } expect((await c.repositories.jobs.get(id))?.abandonment).toBeUndefined();
  });
  it.each(['cli', 'slash'])('success-in-%s-warns-truthfully-and-does-not-delete-or-stop', async (kind) => {
    const args = ['abandon', id, '--acknowledge-unverified'];
    let text: string;
    if(kind === 'cli') {
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      text = r.out;
    }
    else
      text = await slash(args.join(' '));
    expect(text).toMatch(/Capacity released/i);
    expect(text).toMatch(/outcome and descendants remain unverified/i);
    expect(text).toMatch(/no processes were stopped/i);
    expect(text).toContain('tombstone retained');
    const job = await c.repositories.jobs.get(id);
    expect(job?.state).toBe('recovery-required');
    expect(job?.stopState).toBe('none');
    const summary = await c.poll(id);
    expect(formatJobSummary(summary)).toContain('abandonedAt:');
    expect(describeStopResult(summary)).toContain('no stop was dispatched');
  });
});
