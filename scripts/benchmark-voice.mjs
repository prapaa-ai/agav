#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export function parseArgs(args) {
  const options = { runs: 1, backend: 'auto' };
  const names = new Set(['helper', 'model', 'wav', 'runs', 'threads', 'backend']);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.slice(2);
    const value = args[i + 1];
    if (!args[i]?.startsWith('--') || !names.has(name) || !value || value.startsWith('--') || value.includes('\0')) throw new Error('Expected --helper --model --wav [--runs N] [--threads N] [--backend cpu|auto].');
    options[name] = value;
  }
  for (const name of ['helper', 'model', 'wav']) if (!options[name]) throw new Error(`Missing --${name}.`);
  for (const name of ['runs', 'threads']) {
    if (options[name] === undefined) continue;
    if (!/^[1-9]\d*$/.test(String(options[name])) || !Number.isSafeInteger(Number(options[name]))) throw new Error(`--${name} must be a positive integer.`);
    options[name] = Number(options[name]);
    if (name === "threads" && options[name] > 16) throw new Error("--threads must be between 1 and 16.");
  }
  if (!['cpu', 'auto'].includes(options.backend)) throw new Error('--backend must be cpu or auto.');
  return options;
}

/** Replay is a cold, fresh-process measurement. It does not measure warm pool reuse. */
export function measureRun(options, spawnHelper = spawn) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timings = {};
    const telemetry = [];
    let sampleEnd = null;
    let transcript;
    let pending = '';
    let stderrPending = '';
    let stderr = '';
    let bytes = 0;
    let failure;
    let settled = false;
    let escalation;
    const decoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const child = spawnHelper(options.helper, ['--model', options.model, '--input-wav', options.wav, '--replay'], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGAV_VOICE_PROFILE: '1', AGAV_VOICE_BACKEND: options.backend,
        ...(options.threads === undefined ? {} : { AGAV_VOICE_THREADS: String(options.threads) }) },
    });
    const kill = signal => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      try { child.kill(signal); } catch { /* Exit can race signals. */ }
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(escalation);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve({ ...timings, totalMs: performance.now() - started,
        transcript, sampleEnd, nativeTelemetry: telemetry,
        cpu: telemetry.filter(item => Number.isFinite(item.cpuMs)).at(-1)?.cpuMs ?? null,
        peakRss: telemetry.filter(item => Number.isFinite(item.peakRssBytes)).at(-1)?.peakRssBytes ?? null,
        resourceMetrics: 'Native accumulated CPU milliseconds and peak resident/working-set bytes; GPU memory is not included.'  });
    };
    const fail = error => {
      if (failure || settled) return;
      failure = error;
      kill('SIGTERM');
      escalation = setTimeout(() => { kill('SIGKILL'); finish(error); }, 1000);
    };
    const deadline = setTimeout(() => fail(new Error('Voice replay timed out after 300 seconds.')), 300000);
    const line = text => {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object') throw new Error('Invalid replay event.');
      if (transcript !== undefined) throw new Error('Replay output after transcript.');
      const ms = performance.now() - started;
      if (value.type === 'phase' && ['preparing', 'recording', 'transcribing'].includes(value.phase)) timings[`${value.phase}Ms`] ??= ms;
      else if (value.type === 'partial' && typeof value.text === 'string') timings.firstPartialMs ??= ms;
      else if (value.type === 'transcript' && typeof value.text === 'string' && value.text.trim()) { transcript = value.text; timings.transcriptMs = ms; }
      else if (value.type === 'level' && Number.isFinite(value.level) && value.level >= 0 && value.level <= 1) { /* Capture meter is not a latency metric. */ }
      else if (value.type === 'error' && typeof value.message === 'string') throw new Error(value.message);
      else throw new Error('Invalid replay event.');
    };
    const stderrLine = text => {
      // Native profiling is stderr-only. Preserve JSON telemetry verbatim; never
      // substitute the parent's cpuUsage() for subprocess CPU consumption.
      try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          telemetry.push(value);
          if (Number.isFinite(value.sampleEnd)) sampleEnd = value.sampleEnd;
        }
      } catch { /* Ordinary whisper diagnostics are not telemetry. */ }
    };
    child.stdout.on('data', chunk => {
      if (failure || settled) return;
      try {
        bytes += chunk.length;
        if (bytes > 4 * 1024 ** 2) throw new Error('Replay output exceeds 4 MiB.');
        pending += decoder.write(chunk);
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const text = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (Buffer.byteLength(text) > 65536) throw new Error('Replay line exceeds 64 KiB.');
          line(text);
        }
        if (Buffer.byteLength(pending) > 65536) throw new Error('Replay line exceeds 64 KiB.');
      } catch (error) { fail(error); }
    });
    child.stderr.on('data', chunk => {
      if (settled) return;
      stderr = (stderr + chunk.toString()).slice(-8192);
      stderrPending += stderrDecoder.write(chunk);
      let newline;
      while ((newline = stderrPending.indexOf('\n')) !== -1) {
        if (telemetry.length < 1024) stderrLine(stderrPending.slice(0, newline));
        stderrPending = stderrPending.slice(newline + 1);
      }
      stderrPending = stderrPending.slice(-65536);
    });
    child.on('error', error => { if (!child.pid) finish(error); else fail(error); });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', fail);
    child.on('exit', () => {
      if (!settled) { clearTimeout(escalation); escalation = setTimeout(() => finish(failure ?? new Error('Replay exited without closing pipes.')), 500); }
    });
    child.on('close', (code, signal) => {
      if (stderrPending) stderrLine(stderrPending + stderrDecoder.end());
      if (failure) finish(failure);
      else if (code !== 0) finish(new Error(`Voice replay failed (${code ?? signal}): ${stderr}`));
      else if (pending || decoder.end() || transcript === undefined) finish(new Error('Incomplete replay transcript.'));
      else finish();
    });
    // Keep stdin open: EOF is cancellation in the native helper, not stop.
  });
}

export async function benchmark(options, spawnHelper) {
  const runs = [];
  for (let i = 0; i < options.runs; i++) runs.push(await measureRun(options, spawnHelper));
  return { mode: 'cold-process-wav-replay', warmReuseMeasured: false, runs,
    meanTotalMs: runs.reduce((sum, run) => sum + run.totalMs, 0) / runs.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await benchmark(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
