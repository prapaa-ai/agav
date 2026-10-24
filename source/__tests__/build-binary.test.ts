import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(platform = 'win32', failure = true, args: string[] = [], powershellFailure = false, realPowerShell = false, spacedRoot = false) {
  const root = mkdtempSync(join(tmpdir(), spacedRoot ? 'agav build diagnostic ' : 'agav-build-diagnostic-'));
  roots.push(root);
  for (const dir of ['scripts', 'source/voice']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync('scripts/build-binary.mjs', join(root, 'scripts/build-binary.mjs'));
  writeFileSync(join(root, 'source/voice/bundled-runtime.ts'), 'original stub\n');
  writeFileSync(join(root, 'scripts/gen-bundled-skills.mjs'), '');
  // Simulate the build host while keeping filesystem paths native to the real host.
  const preload = join(root, 'mock-bun.mjs');
  writeFileSync(preload, `
    import cp from 'node:child_process';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    os.tmpdir = () => ${JSON.stringify(root)};
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      if (command === 'powershell.exe') {
        if (${realPowerShell}) return original(command, args, options);
        const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
        writeFileSync(${JSON.stringify(join(root, 'powershell-script.txt'))}, script);
        return { status: ${powershellFailure ? 1 : 0}, stderr: ${powershellFailure ? JSON.stringify('access denied') : JSON.stringify('')}, stdout: '' };
      }
      if (command !== 'bun' && command !== 'bun.exe') return original(command, args, options);
      if (args[0] === '--version') return { status: 0 };
      const output = args[args.indexOf('--outfile') + 1];
      if (${failure}) {
        process.stderr.write('failed to move executable to ' + output + ': EPERM\\n');
        return { status: 1 };
      }
      writeFileSync(output, 'compiled executable');
      return { status: 0 };
    };
    syncBuiltinESMExports();
  `);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts/build-binary.mjs'), 'native', ...args], {
    encoding: 'utf8', env: { ...process.env, AGAV_VOICE_HELPER_PATH: '', AGAV_VOICE_HELPER_DIR: '' },
  });
  return { root, result };
}

describe('binary build failure diagnostics', () => {
  it('explains Windows target locks without hiding the Bun error or reporting success', () => {
    const { root, result } = fixture();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to move executable to ' + join(root, 'dist/agav.exe') + ': EPERM');
    expect(result.stderr).toContain('bun.exe failed (1)');
    expect(result.stderr).toContain('Close Agav sessions and background supervisors running from this path');
    expect(result.stderr).toContain('permissions and antivirus');
    expect(result.stdout).not.toContain('Built:');
    expect(readFileSync(join(root, 'source/voice/bundled-runtime.ts'), 'utf8')).toBe('original stub\n');
  });

  it('only invokes worker termination with the explicit flag and checks the exact output path and worker modes', () => {
    const { root, result } = fixture('win32', false, ['--force-kill-workers']);
    expect(result.status, result.stderr).toBe(0);
    const script = readFileSync(join(root, 'powershell-script.txt'), 'utf8');
    expect(script).toContain(`$target = '${join(root, 'dist/agav.exe')}'`);
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain('[string]::Equals($candidate.ExecutablePath, $target');
    expect(script).toContain('--internal-background-jobs-supervisor');
    expect(script).toContain('--internal-background-jobs-tick');
    expect(script).toContain('--internal-workflow-runner');
    expect(script).toContain('Stop-Process -Id $worker.ProcessId -Force');
    expect(script).toContain('$current.CreationDate -ne $worker.CreationDate');
  });

  it('matches the first argument exactly instead of searching the whole command line', () => {
    const { root, result } = fixture('win32', false, ['--force-kill-workers']);
    expect(result.status, result.stderr).toBe(0);
    const script = readFileSync(join(root, 'powershell-script.txt'), 'utf8');
    expect(script).toContain('function Get-FirstArgument');
    expect(script).toContain('[string]::Equals($first, $flag, [StringComparison]::Ordinal)');
    expect(script).not.toMatch(/-match|-like\s+['"]\*/);
    // Identity recheck repeats the executable, command line and CreationDate checks, failing closed.
    expect(script).toContain('-not (Test-WorkerMode $current)');
    expect(script).toContain('[string]::Equals($current.CommandLine, $worker.CommandLine');
    expect(script).toContain('$current.CreationDate -ne $worker.CreationDate');
    expect(script).toContain('[string]::Equals($current.ExecutablePath, $target');
    expect(script).toContain('refusing to stop it');
  });

  describe.skipIf(process.platform !== 'win32')('real PowerShell worker selection (processes are mocked, nothing is stopped)', () => {
    type Proc = { id: number; path?: string; line: string; created?: string };
    const psq = (value: string) => `'${value.replaceAll("'", "''")}'`;

    function runSelection(spaced: boolean, build: (target: string) => Proc[], recheck: (target: string) => Record<number, Partial<Proc>> = () => ({})) {
      const { root, result: buildResult } = fixture('win32', false, ['--force-kill-workers'], false, false, spaced);
      expect(buildResult.status, buildResult.stderr).toBe(0);
      const script = readFileSync(join(root, 'powershell-script.txt'), 'utf8');
      const target = join(root, 'dist/agav.exe');
      const items = build(target).map(p => `[pscustomobject]@{ ProcessId = ${p.id}; ExecutablePath = ${psq(p.path ?? target)}; CommandLine = ${psq(p.line)}; CreationDate = ${psq(p.created ?? 'created-1')} }`);
      const changes = Object.entries(recheck(target)).map(([id, p]) => `${id} = [pscustomobject]@{ ProcessId = ${id}; ExecutablePath = ${psq(p.path ?? target)}; CommandLine = ${psq(p.line ?? build(target).find(x => x.id === Number(id))!.line)}; CreationDate = ${psq(p.created ?? 'created-1')} }`);
      const stub = `
$script:items = @(${items.join(',\n')})
$script:changed = @{ ${changes.join('; ')} }
function Get-CimInstance {
  param($Class, $Filter)
  if ($Filter -like 'ProcessId*') {
    $id = [int]($Filter -split ' = ')[1]
    if ($script:changed.ContainsKey($id)) { return $script:changed[$id] }
    return $script:items | Where-Object ProcessId -eq $id
  }
  return $script:items
}
function Stop-Process { param($Id, [switch]$Force, $ErrorAction); Write-Output "mock stop $Id" }
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(stub + script, 'utf16le').toString('base64')], { encoding: 'utf8' });
      const stopped = [...result.stdout.matchAll(/mock stop (\d+)/g)].map(m => Number(m[1]));
      return { result, stopped, target };
    }

    const modes = ['--internal-background-jobs-supervisor', '--internal-background-jobs-tick', '--internal-workflow-runner'];

    for (const spaced of [false, true]) {
      const label = spaced ? ' (executable path with spaces)' : '';

      it(`selects real workers and never foreground commands that merely mention a worker flag${label}`, () => {
        const { result, stopped } = runSelection(spaced, t => [
          { id: 101, line: `"${t}" ${modes[0]} id` },
          { id: 102, line: `"${t}" ${modes[1]}` },
          { id: 103, line: `"${t}" ${modes[2]} run-1` },
          { id: 104, line: `"${t}"\t${modes[2]}\trun-2` },
          { id: 105, line: `"${t}"   "${modes[2]}" run-3` },
          { id: 106, line: `${t} ${modes[0]} id` },
          { id: 107, line: `"${t}" run "please debug --internal-workflow-runner today"` },
          { id: 108, line: `"${t}" run please debug ${modes[2]} today` },
          { id: 109, line: `"${t}" run ${modes[0]}` },
          { id: 110, line: `"${t}" "${modes[2]} today"` },
          { id: 111, line: `"${t}" ${modes[2]}-extra` },
          { id: 112, line: `"${t}" --INTERNAL-WORKFLOW-RUNNER x` },
          { id: 113, line: `"${t}" \\"${modes[2]}\\" x` },
          { id: 114, line: `"${t}" "\\"${modes[2]}" x` },
          { id: 115, line: `"${t}" --version` },
          { id: 116, line: `"${t}"` },
          { id: 117, line: `"${t}" "" ${modes[1]}` },
          { id: 118, line: `agav.exe run "please debug --internal-workflow-runner today"` },
          { id: 119, path: 'C:\\other\\agav.exe', line: `"C:\\other\\agav.exe" ${modes[1]}` },
        ]);
        expect(result.status, result.stderr).toBe(0);
        // 106 is unquoted: with spaces in the path only the exact-target prefix may identify the executable.
        expect(stopped).toEqual([101, 102, 103, 104, 105, 106]);
      });

      it(`does not stop the foreground prompt example from the review${label}`, () => {
        const { result, stopped } = runSelection(spaced, t => [
          { id: 201, line: `"${t}" run "please debug --internal-workflow-runner today"` },
        ]);
        expect(result.status, result.stderr).toBe(0);
        expect(stopped).toEqual([]);
      });

      it(`fails closed if a selected worker changes identity before it is stopped${label}`, () => {
        const worker = (t: string): Proc[] => [{ id: 301, line: `"${t}" ${modes[2]} run-1` }];
        const cases: Record<string, (t: string) => Partial<Proc>> = {
          'CreationDate': () => ({ created: 'created-2' }),
          'foreground command line': t => ({ line: `"${t}" run "please debug --internal-workflow-runner today"` }),
          'different command line': t => ({ line: `"${t}" ${modes[2]} run-2` }),
          'executable path': () => ({ path: 'C:\\other\\agav.exe' }),
        };
        for (const [name, change] of Object.entries(cases)) {
          const { result, stopped } = runSelection(spaced, worker, t => ({ 301: change(t) }));
          expect(result.status, name).not.toBe(0);
          expect(result.stderr, name).toContain('changed identity');
          expect(stopped, name).toEqual([]);
        }
      });
    }
  });

  it.skipIf(process.platform !== 'win32')('runs the real PowerShell worker query for an isolated output path', () => {
    const { root, result } = fixture('win32', false, ['--force-kill-workers'], false, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Built: dist/agav.exe');
    expect(readFileSync(join(root, 'dist/agav.exe'), 'utf8')).toBe('compiled executable');
  });

  it('fails closed if workers cannot be enumerated or stopped', () => {
    const { root, result } = fixture('win32', false, ['--force-kill-workers'], true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('access denied');
    expect(result.stdout).not.toContain('Built:');
    expect(readFileSync(join(root, 'source/voice/bundled-runtime.ts'), 'utf8')).toBe('original stub\n');
  });

  it('rejects the force flag on non-Windows hosts', () => {
    const { result } = fixture('linux', false, ['--force-kill-workers']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only supported on Windows');
  });

  it('keeps non-Windows failures unchanged', () => {
    const { result } = fixture('linux');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bun failed (1)');
    expect(result.stderr).not.toContain('Close Agav');
  });

  it('still publishes the expected artifact path on success', () => {
    const { root, result } = fixture('win32', false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Built: dist/agav.exe');
    expect(readFileSync(join(root, 'dist/agav.exe'), 'utf8')).toBe('compiled executable');
  });
});