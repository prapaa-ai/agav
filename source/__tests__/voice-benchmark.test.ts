import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The standalone CLI is intentionally JavaScript, outside the production TS tree.
// @ts-expect-error standalone benchmark has no declaration file
import { benchmark, measureRun, parseArgs } from "../../scripts/benchmark-voice.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const args = ["--helper", "helper with spaces", "--model", "model", "--wav", "fixture.wav"];
function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), "agav-replay-")); roots.push(root);
  const script = join(root, "replay.mjs"); writeFileSync(script, code);
  return vi.fn((_bin: string, argv: string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath, [script, ...argv], options));
}
describe("offline WAV replay benchmark", () => {
  it("validates arguments and positive runs/threads", () => {
    expect(parseArgs([...args, "--runs", "2", "--threads", "4", "--backend", "cpu"])).toMatchObject({ runs: 2, threads: 4, backend: "cpu" });
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
      expect(() => parseArgs([...args, "--runs", value])).toThrow(/positive integer/);
      expect(() => parseArgs([...args, "--threads", value])).toThrow(/positive integer/);
    }
    expect(() => parseArgs([...args, "--backend", "gpu"])).toThrow(/cpu or auto/);
    expect(() => parseArgs(["--helper", "helper"])).toThrow(/Missing/);
    expect(() => parseArgs([...args, "--unknown", "x"])).toThrow(/Expected/);
  });
  it("measures incremental events with real fixtures and never claims warm or parent CPU metrics", async () => {
    const dispatch = fixture(`
      const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
      if(!process.argv.includes('--replay')||!process.argv.includes('--input-wav')||process.env.AGAV_VOICE_PROFILE!=='1')process.exit(3);
      process.stdin.on('end',()=>process.exit(4));process.stdin.resume();
      emit({type:'phase',phase:'preparing'});
      setTimeout(()=>{emit({type:'phase',phase:'recording'});emit({type:'partial',text:'first'});},10);
      setTimeout(()=>{emit({type:'partial',text:'revised'});emit({type:'phase',phase:'transcribing'});},20);
      setTimeout(()=>{
        process.stderr.write(JSON.stringify({inferenceMs:3,sampleEnd:16000})+'\\n');
        const bytes=Buffer.from(JSON.stringify({type:'transcript',text:'Hello 世界'})+'\\n');
        for(const byte of bytes)process.stdout.write(Buffer.from([byte]));
        process.exitCode=0;process.stdin.destroy();
      },30);
    `);
    const summary = await benchmark(parseArgs([...args, "--runs", "2", "--threads", "2", "--backend", "cpu"]), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith("helper with spaces", ["--model", "model", "--input-wav", "fixture.wav", "--replay"], expect.objectContaining({ shell: false,
      env: expect.objectContaining({ AGAV_VOICE_PROFILE: "1", AGAV_VOICE_THREADS: "2", AGAV_VOICE_BACKEND: "cpu" }) }));
    expect(summary.warmReuseMeasured).toBe(false); expect(summary.mode).toBe("cold-process-wav-replay");
    for (const run of summary.runs) {
      expect(run.transcript).toBe("Hello 世界"); expect(run.sampleEnd).toBe(16000);
      expect(run.nativeTelemetry).toEqual([{ inferenceMs: 3, sampleEnd: 16000 }]);
      expect(run.firstPartialMs).toBeGreaterThanOrEqual(run.recordingMs);
      expect(run.transcriptMs).toBeGreaterThanOrEqual(run.transcribingMs);
      expect(run.totalMs).toBeGreaterThanOrEqual(run.transcriptMs);
      expect(run.cpu).toBeNull(); expect(run.peakRss).toBeNull();
    }
    expect(summary.meanTotalMs).toBeGreaterThan(0);
  });
  it.each(["malformed", "truncated", "missing", "nonzero", "native error"])("rejects %s replay rather than reporting success", async kind => {
    const output = kind === "malformed" ? "not JSON\n" : kind === "truncated" ? '{"type":' : "";
    const dispatch = fixture(`
      process.stdout.write(${JSON.stringify(output)});
      ${kind === "native error" ? "console.log(JSON.stringify({type:'error',message:'bad wav'}));" : ""}
      process.exitCode=${kind === "nonzero" ? 2 : 0};
    `);
    await expect(measureRun(parseArgs(args), dispatch)).rejects.toThrow();
  });
});
