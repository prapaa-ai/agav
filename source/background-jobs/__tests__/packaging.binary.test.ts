import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SUPERVISOR_INTERNAL_FLAG } from '../packaging/manifest.js';

const mocks = vi.hoisted(() => ({ standalone: false, assertAsset: vi.fn(), launch: vi.fn() }));
vi.mock('../packaging/manifest.js', async importOriginal => ({ ...await importOriginal<typeof import('../packaging/manifest.js')>(), isStandaloneBinary: () => mocks.standalone }));
vi.mock('../packaging/locator.js', () => ({ resolveSupervisorEntryPath: () => 'C:/package/build/background-jobs/supervisor/entry.js', assertSupervisorAssetExists: mocks.assertAsset }));
vi.mock('../platform/index.js', () => ({ getPlatformAdapter: async () => ({ platform: process.platform, launchDetachedSupervisor: mocks.launch }) }));
import { launchSupervisorForJob } from '../coordinator/launcher.js';
import type { Repositories } from '../types.js';

// Use the real pure detector separately from the launcher's mocked runtime.
const { isStandaloneBinary: detect } = await vi.importActual<typeof import('../packaging/manifest.js')>('../packaging/manifest.js');
describe('standalone binary supervisor packaging', () => {
  beforeEach(() => { mocks.standalone = false; mocks.assertAsset.mockReset(); mocks.launch.mockReset(); });
  it.each(['file:///$bunfs/root/agav', 'file:///B:/~BUN/root/agav.exe', 'file:///B:/%7EBUN/root/agav.exe'])('recognizes virtual URL %s', url => { expect(detect(url)).toBe(true); });
  it.each(['file:///C:/repo/source/cli.tsx', 'file:///usr/bin/bun', 'file:///repo/build/cli.js', 'file:///C:/repo/~BUN/file.js'])('does not confuse disk URL %s with standalone execution', url => { expect(detect(url)).toBe(false); });
  it('reexecutes the current executable with a private flag and unchanged job arguments; never checks virtual assets', async () => {
    mocks.standalone = true;
    await launchSupervisorForJob({ jobId: 'job-fixture', requestId: 'request-fixture', root: process.cwd(), repositories: {} as Repositories });
    expect(mocks.assertAsset).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledOnce();
    const args = mocks.launch.mock.calls[0]![0];
    expect(args.supervisorEntry).toBe(SUPERVISOR_INTERNAL_FLAG);
    expect(args.argv.slice(0, 3)).toEqual(['job-fixture', 'request-fixture', process.cwd()]);
    expect(args.argv).toHaveLength(4);
  });
  it('preserves the Node/source on-disk entry and mandatory prelaunch capability check', async () => {
    await launchSupervisorForJob({ jobId: 'job-fixture', requestId: 'request-fixture', root: process.cwd(), repositories: {} as Repositories });
    expect(mocks.assertAsset).toHaveBeenCalledWith('C:/package/build/background-jobs/supervisor/entry.js');
    expect(mocks.launch.mock.calls[0]![0].supervisorEntry).toBe('C:/package/build/background-jobs/supervisor/entry.js');
  });
  it('still refuses missing Node assets rather than launching an invalid entry', async () => {
    mocks.assertAsset.mockRejectedValue(new Error('missing fixture'));
    await expect(launchSupervisorForJob({ jobId: 'job-fixture', requestId: 'request-fixture', root: process.cwd(), repositories: {} as Repositories })).rejects.toThrow('missing fixture');
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
