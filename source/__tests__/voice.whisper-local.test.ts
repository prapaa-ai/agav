import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TECHNICAL_STT_PROMPT,
  LocalWhisperEngine,
  MIN_DECODE_SAMPLES,
  buildWhisperArgs,
  calculateOptimalThreads,
  deduplicateRepeatedPhrases,
  extractTranscriptionText,
  isHintEcho,
  isJunk,
  normalizeTechnicalTerms,
  padAudioIfNeeded,
  parseWavInfo,
  resolveWhisperBinary,
  resolveWhisperModel,
} from "../voice/index.js";

function createWavBuffer(sampleRate: number, numSamples: number): Buffer {
  const bytesPerSample = 2; // 16-bit
  const channels = 1; // mono
  const dataSize = numSamples * bytesPerSample * channels;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Fill with dummy PCM sample data
  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(1000, 44 + i * 2);
  }

  return buffer;
}

describe("Native Local Whisper STT Engine", () => {
  let testTempDir: string;

  beforeEach(async () => {
    testTempDir = join(
      tmpdir(),
      `agav_whisper_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testTempDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(testTempDir)) {
      await rm(testTempDir, { recursive: true, force: true }).catch(() => {});
    }
    vi.restoreAllMocks();
  });

  describe("Lexical Tuning & Normalization", () => {
    it("normalizes developer technical acronyms", () => {
      expect(normalizeTechnicalTerms("we need json b storage")).toBe("we need JSONB storage");
      expect(normalizeTechnicalTerms("create a jsonb column")).toBe("create a JSONB column");
      expect(normalizeTechnicalTerms("parse the jwt token")).toBe("parse the JWT token");
      expect(normalizeTechnicalTerms("j w t auth")).toBe("JWT auth");
      expect(normalizeTechnicalTerms("implement lru cache")).toBe("implement LRU cache");
      expect(normalizeTechnicalTerms("l r u eviction")).toBe("LRU eviction");
      expect(normalizeTechnicalTerms("mru cache policy")).toBe("MRU cache policy");
      expect(normalizeTechnicalTerms("lfu eviction")).toBe("LFU eviction");
      expect(normalizeTechnicalTerms("set ttl to 60 seconds")).toBe("set TTL to 60 seconds");
      expect(normalizeTechnicalTerms("measure ttft latency")).toBe("measure TTFT latency");
      expect(normalizeTechnicalTerms("guarantee our sla")).toBe("guarantee our SLA");
      expect(normalizeTechnicalTerms("monitor slo metrics")).toBe("monitor SLO metrics");
      expect(normalizeTechnicalTerms("high cpu usage detected")).toBe("high CPU usage detected");
      expect(normalizeTechnicalTerms("train model on gpu")).toBe("train model on GPU");
      expect(normalizeTechnicalTerms("deployed on tpu")).toBe("deployed on TPU");
      expect(normalizeTechnicalTerms("deliver assets via cdn")).toBe("deliver assets via CDN");
      expect(normalizeTechnicalTerms("build basic crud endpoints")).toBe(
        "build basic CRUD endpoints",
      );
      expect(normalizeTechnicalTerms("setup ci/cd pipeline")).toBe("setup CI/CD pipeline");
      expect(normalizeTechnicalTerms("ci cd automation")).toBe("CI/CD automation");
      expect(normalizeTechnicalTerms("traverse using dfs")).toBe("traverse using DFS");
      expect(normalizeTechnicalTerms("search using bfs")).toBe("search using BFS");
      expect(normalizeTechnicalTerms("build hnsw vector index")).toBe("build HNSW vector index");
      expect(normalizeTechnicalTerms("create a gin index")).toBe("create a GIN index");
    });

    it("normalizes system and developer tool names from phonetic variations", () => {
      // Redis
      expect(normalizeTechnicalTerms("connect to raditz")).toBe("connect to Redis");
      expect(normalizeTechnicalTerms("connect to radice")).toBe("connect to Redis");
      expect(normalizeTechnicalTerms("connect to radius")).toBe("connect to Redis");
      expect(normalizeTechnicalTerms("connect to reddis")).toBe("connect to Redis");
      expect(normalizeTechnicalTerms("connect to redis")).toBe("connect to Redis");

      // Kubernetes
      expect(normalizeTechnicalTerms("deploy to cubernetis cluster")).toBe(
        "deploy to Kubernetes cluster",
      );
      expect(normalizeTechnicalTerms("deploy to koobernetes")).toBe("deploy to Kubernetes");
      expect(normalizeTechnicalTerms("scale kubernetes pods")).toBe("scale Kubernetes pods");

      // Kafka
      expect(normalizeTechnicalTerms("produce to kafca topic")).toBe("produce to Kafka topic");
      expect(normalizeTechnicalTerms("produce to kaphka topic")).toBe("produce to Kafka topic");
      expect(normalizeTechnicalTerms("produce to kafka topic")).toBe("produce to Kafka topic");

      // PostgreSQL
      expect(normalizeTechnicalTerms("query postgress database")).toBe(
        "query PostgreSQL database",
      );
      expect(normalizeTechnicalTerms("connect to postgre sql")).toBe("connect to PostgreSQL");
      expect(normalizeTechnicalTerms("postgres instance")).toBe("PostgreSQL instance");

      // MongoDB
      expect(normalizeTechnicalTerms("query mongo db collection")).toBe(
        "query MongoDB collection",
      );
      expect(normalizeTechnicalTerms("mongodb replica set")).toBe("MongoDB replica set");

      // GraphQL & gRPC
      expect(normalizeTechnicalTerms("write grafql mutation")).toBe("write GraphQL mutation");
      expect(normalizeTechnicalTerms("graphql query")).toBe("GraphQL query");
      expect(normalizeTechnicalTerms("invoke g rpc endpoint")).toBe("invoke gRPC endpoint");
      expect(normalizeTechnicalTerms("grpc client")).toBe("gRPC client");

      // Nginx & SQLite
      expect(normalizeTechnicalTerms("configure engine x reverse proxy")).toBe(
        "configure Nginx reverse proxy",
      );
      expect(normalizeTechnicalTerms("restart n jinx server")).toBe("restart Nginx server");
      expect(normalizeTechnicalTerms("embedded sqllite db")).toBe("embedded SQLite db");
      expect(normalizeTechnicalTerms("sqlite file")).toBe("SQLite file");

      // ML frameworks
      expect(normalizeTechnicalTerms("pie torch model")).toBe("PyTorch model");
      expect(normalizeTechnicalTerms("pytorch tensor")).toBe("PyTorch tensor");
      expect(normalizeTechnicalTerms("tensor flow graph")).toBe("TensorFlow graph");
      expect(normalizeTechnicalTerms("tensorflow model")).toBe("TensorFlow model");
      expect(normalizeTechnicalTerms("lang chain agent")).toBe("LangChain agent");
      expect(normalizeTechnicalTerms("langchain prompt")).toBe("LangChain prompt");

      // Coding platforms & algorithms
      expect(normalizeTechnicalTerms("solve leat code problem")).toBe(
        "solve LeetCode problem",
      );
      expect(normalizeTechnicalTerms("study neet code 150")).toBe("study NeetCode 150");
      expect(normalizeTechnicalTerms("compete on code forces round")).toBe(
        "compete on Codeforces round",
      );
      expect(normalizeTechnicalTerms("dijkstra shortest path")).toBe("Dijkstra shortest path");
      expect(normalizeTechnicalTerms("deekstra algorithm")).toBe("Dijkstra algorithm");
    });

    it("normalizes caching policies and distributed consensus algorithms while preserving compound forms", () => {
      expect(normalizeTechnicalTerms("configure allkeys lru eviction")).toBe(
        "configure allkeys-lru eviction",
      );
      expect(normalizeTechnicalTerms("set allkeys random policy")).toBe(
        "set allkeys-random policy",
      );
      expect(normalizeTechnicalTerms("use volatile lru setting")).toBe(
        "use volatile-lru setting",
      );
      expect(normalizeTechnicalTerms("apply volatile ttl")).toBe("apply volatile-ttl");
      expect(normalizeTechnicalTerms("prevent thundering herd in cache")).toBe(
        "prevent thundering herd in cache",
      );
      expect(normalizeTechnicalTerms("mitigate cache stampede")).toBe("mitigate cache stampede");
      expect(normalizeTechnicalTerms("implement raft consensus")).toBe(
        "implement Raft consensus",
      );
      expect(normalizeTechnicalTerms("distributed paxos protocol")).toBe(
        "distributed Paxos protocol",
      );
    });

    it("normalizes distributed systems, database architectures, and algorithm patterns", () => {
      expect(normalizeTechnicalTerms("fast api endpoint")).toBe("FastAPI endpoint");
      expect(normalizeTechnicalTerms("docker container")).toBe("Docker container");
      expect(normalizeTechnicalTerms("time test augmentation")).toBe(
        "test-time augmentation (TTA)",
      );
      expect(normalizeTechnicalTerms("efficient net model")).toBe("EfficientNet model");
      expect(normalizeTechnicalTerms("cap theorem trade-offs")).toBe("CAP theorem trade-offs");
      expect(normalizeTechnicalTerms("acid properties in db")).toBe("ACID properties in db");
      expect(normalizeTechnicalTerms("consistent hashing ring")).toBe("Consistent Hashing ring");
      expect(normalizeTechnicalTerms("rate limiter middleware")).toBe("Rate Limiter middleware");
      expect(normalizeTechnicalTerms("circuit breaker pattern")).toBe("Circuit Breaker pattern");
      expect(normalizeTechnicalTerms("dynamo db table")).toBe("DynamoDB table");
      expect(normalizeTechnicalTerms("hash map lookup")).toBe("HashMap lookup");
      expect(normalizeTechnicalTerms("order of one time complexity")).toBe("O(1) time complexity");
      expect(normalizeTechnicalTerms("order of n search")).toBe("O(N) search");
      expect(normalizeTechnicalTerms("order of log n binary search")).toBe("O(log N) binary search");
      expect(normalizeTechnicalTerms("two pointers approach")).toBe("Two Pointers approach");
      expect(normalizeTechnicalTerms("sliding window maximum")).toBe("Sliding Window maximum");
      expect(normalizeTechnicalTerms("dynamic programming memoization")).toBe(
        "Dynamic Programming memoization",
      );
    });

    it("normalizes common conversational code-switching transitions", () => {
      expect(normalizeTechnicalTerms("ye hum kal car in gay")).toBe("ye hum kal karenge");
      expect(normalizeTechnicalTerms("kaam ho jaega")).toBe("kaam ho jayega");
      expect(normalizeTechnicalTerms("hum implement kar sakte hain")).toBe(
        "hum implement kar sakte hain",
      );
      expect(normalizeTechnicalTerms("isko optimize kaise karein")).toBe(
        "isko optimize kaise karein",
      );
    });
  });

  describe("isJunk Acoustic Artifact Filtering", () => {
    it("detects empty or whitespace-only strings as junk", () => {
      expect(isJunk("")).toBe(true);
      expect(isJunk("   ")).toBe(true);
      expect(isJunk("\n\t\r")).toBe(true);
    });

    it("detects bracketed, parenthesized, asterisk, and musical token annotations as junk", () => {
      expect(isJunk("[BLANK_AUDIO]")).toBe(true);
      expect(isJunk("(coughs)")).toBe(true);
      expect(isJunk("(coughing)")).toBe(true);
      expect(isJunk("*music*")).toBe(true);
      expect(isJunk("*applause*")).toBe(true);
      expect(isJunk("♪")).toBe(true);
      expect(isJunk("♪♪ [BLANK_AUDIO] (coughs) *music* ♪")).toBe(true);
    });

    it("detects strings without alphanumeric content as junk", () => {
      expect(isJunk("...")).toBe(true);
      expect(isJunk("---")).toBe(true);
      expect(isJunk("!?,. :;")).toBe(true);
    });

    it("preserves genuine speech even if annotations are present", () => {
      expect(isJunk("[BLANK_AUDIO] Hello world")).toBe(false);
      expect(isJunk("Deploy to Kubernetes (coughs)")).toBe(false);
      expect(isJunk("Setup Redis cache")).toBe(false);
    });
  });

  describe("isHintEcho Regurgitation Detection", () => {
    it("returns true when text contains only hint section labels", () => {
      const hint = "Technical terms: Redis, Kafka, Kubernetes, PostgreSQL";
      expect(isHintEcho("Technical terms:", hint)).toBe(true);
      expect(isHintEcho("Technical terms", hint)).toBe(true);
      expect(isHintEcho("Keywords:", "Keywords: Python, Docker")).toBe(true);
      expect(isHintEcho("Context:", "Context: Development")).toBe(true);
      expect(isHintEcho("Vocabulary:", "Vocabulary: gRPC, GraphQL")).toBe(true);
    });

    it("returns true when >= 3 hint items are echoed back comprising >= 50% of word count", () => {
      const hint = "Technical terms: Redis, Kafka, Kubernetes, PostgreSQL, GraphQL";
      // 3 items out of 3 words (100% >= 50%)
      expect(isHintEcho("Redis, Kafka, Kubernetes", hint)).toBe(true);
      // 4 items out of 4 words (100% >= 50%)
      expect(isHintEcho("Redis Kafka Kubernetes PostgreSQL", hint)).toBe(true);
      // 3 items out of 4 words (75% >= 50%)
      expect(isHintEcho("Redis Kafka Kubernetes now", hint)).toBe(true);
    });

    it("returns false for genuine speech that mentions technical terms", () => {
      const hint = "Technical terms: Redis, Kafka, Kubernetes, PostgreSQL";
      // 2 terms in 10 words
      expect(
        isHintEcho("Can you help me connect to Redis and Kafka in this project?", hint),
      ).toBe(false);

      // 3 terms in 16 words (3/16 = 18.75% < 50%)
      expect(
        isHintEcho(
          "We are designing a microservices architecture using Redis, Kafka, and Kubernetes for high scalability.",
          hint,
        ),
      ).toBe(false);
    });

    it("returns false if hint is not provided or empty", () => {
      expect(isHintEcho("Redis Kafka Kubernetes", "")).toBe(false);
      expect(isHintEcho("Redis Kafka Kubernetes", undefined as any)).toBe(false);
    });
  });

  describe("deduplicateRepeatedPhrases Hallucination Loop Suppression", () => {
    it("collapses pathological Whisper repetition loops into a single phrase", () => {
      const repetitiveInput =
        "all the academic activities that I could do from that webcastarenser " +
        "of the website of the website of the website of the website of the website of the website of";

      const cleaned = deduplicateRepeatedPhrases(repetitiveInput);
      expect(cleaned).toBe(
        "all the academic activities that I could do from that webcastarenser of the website",
      );
    });

    it("collapses single word repetition loops occurring 3 or more times", () => {
      expect(deduplicateRepeatedPhrases("this website website website is great")).toBe(
        "this website is great",
      );
      expect(deduplicateRepeatedPhrases("testing test test test test done")).toBe(
        "testing test done",
      );
    });

    it("preserves legitimate repeated speech (e.g. 2 repeats of common words)", () => {
      expect(deduplicateRepeatedPhrases("this is very very good")).toBe("this is very very good");
      expect(deduplicateRepeatedPhrases("no no I disagree")).toBe("no no I disagree");
    });

    it("handles empty or short input cleanly", () => {
      expect(deduplicateRepeatedPhrases("")).toBe("");
      expect(deduplicateRepeatedPhrases("hello")).toBe("hello");
      expect(deduplicateRepeatedPhrases("hello world")).toBe("hello world");
    });
  });

  describe("Audio Duration & Utterance Padding", () => {
    it("correctly parses valid WAV header and calculates duration", () => {
      const sampleRate = 16000;
      const numSamples = 32000; // 2.0s
      const buffer = createWavBuffer(sampleRate, numSamples);

      const info = parseWavInfo(buffer);
      expect(info).not.toBeNull();
      expect(info?.sampleRate).toBe(16000);
      expect(info?.numSamples).toBe(32000);
      expect(info?.durationSecs).toBe(2.0);
    });

    it("pads short audio utterances (<1.1s / 17600 samples) with silence up to MIN_DECODE_SAMPLES", async () => {
      const sampleRate = 16000;
      const numSamples = 8000; // 0.5s < 1.1s
      const shortWavPath = join(testTempDir, "short.wav");
      await writeFile(shortWavPath, createWavBuffer(sampleRate, numSamples));

      const result = await padAudioIfNeeded(shortWavPath);
      expect(result.isTemp).toBe(true);
      expect(result.wavPath).not.toBe(shortWavPath);
      expect(result.durationSecs).toBeCloseTo(1.1, 2);

      // Verify padded file on disk
      expect(existsSync(result.wavPath)).toBe(true);
      const paddedBuffer = await import("node:fs/promises").then((fs) =>
        fs.readFile(result.wavPath),
      );
      const paddedInfo = parseWavInfo(paddedBuffer);
      expect(paddedInfo?.numSamples).toBe(MIN_DECODE_SAMPLES);

      // Verify the added samples are zeroes (silence)
      const originalDataBytes = numSamples * 2;
      const paddingStartOffset = 44 + originalDataBytes;
      for (let offset = paddingStartOffset; offset < paddedBuffer.length; offset += 2) {
        expect(paddedBuffer.readInt16LE(offset)).toBe(0);
      }

      // Cleanup
      await import("node:fs/promises").then((fs) => fs.unlink(result.wavPath));
    });

    it("does not pad audio utterances with duration >= 1.1s", async () => {
      const sampleRate = 16000;
      const numSamples = 32000; // 2.0s >= 1.1s
      const normalWavPath = join(testTempDir, "normal.wav");
      await writeFile(normalWavPath, createWavBuffer(sampleRate, numSamples));

      const result = await padAudioIfNeeded(normalWavPath);
      expect(result.isTemp).toBe(false);
      expect(result.wavPath).toBe(normalWavPath);
      expect(result.durationSecs).toBe(2.0);
    });
  });

  describe("Decoding Parameter Tuning", () => {
    it("calculates optimal thread count clamping to physical cores", () => {
      expect(calculateOptimalThreads(1)).toBe(1);
      expect(calculateOptimalThreads(2)).toBe(1);
      expect(calculateOptimalThreads(4)).toBe(2);
      expect(calculateOptimalThreads(8)).toBe(4);
      expect(calculateOptimalThreads(12)).toBe(6);
      expect(calculateOptimalThreads(16)).toBe(6);
      expect(calculateOptimalThreads(32)).toBe(6);
    });

    it("selects beam-size 2 for short prompts (<= 8.0s)", () => {
      const args = buildWhisperArgs({
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        audioPath: "test.wav",
        durationSecs: 4.5,
      });

      expect(args).toContain("-bs");
      const bsIndex = args.indexOf("-bs");
      expect(args[bsIndex + 1]).toBe("2");
      expect(args).not.toContain("-bo");
    });

    it("selects greedy search (beam-size 1, best-of 1) for long prompts (> 8.0s)", () => {
      const args = buildWhisperArgs({
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        audioPath: "test.wav",
        durationSecs: 12.0,
      });

      expect(args).toContain("-bs");
      const bsIndex = args.indexOf("-bs");
      expect(args[bsIndex + 1]).toBe("1");
      expect(args).toContain("-bo");
      const boIndex = args.indexOf("-bo");
      expect(args[boIndex + 1]).toBe("1");
    });

    it("truncates audio context window via -ac to save decode latency", () => {
      // 2.0s: Math.round((2.0 / 30.0) * 1500) + 64 = 100 + 64 = 164 -> clamped to min 512
      const argsShort = buildWhisperArgs({
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        audioPath: "test.wav",
        durationSecs: 2.0,
      });
      expect(argsShort).toContain("-ac");
      const acShortIdx = argsShort.indexOf("-ac");
      expect(argsShort[acShortIdx + 1]).toBe("512");

      // 15.0s: Math.round((15.0 / 30.0) * 1500) + 64 = 750 + 64 = 814
      const argsMid = buildWhisperArgs({
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        audioPath: "test.wav",
        durationSecs: 15.0,
      });
      expect(argsMid).toContain("-ac");
      const acMidIdx = argsMid.indexOf("-ac");
      expect(argsMid[acMidIdx + 1]).toBe("814");

      // 30.0s: Math.round((30.0 / 30.0) * 1500) + 64 = 1564 -> clamped to max 1500 -> no -ac passed
      const argsLong = buildWhisperArgs({
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        audioPath: "test.wav",
        durationSecs: 30.0,
      });
      expect(argsLong).not.toContain("-ac");
    });

    it("includes required stability and accuracy flags (-nf, -sns, -nth 0.6, -nt)", () => {
      const args = buildWhisperArgs({
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        audioPath: "test.wav",
        durationSecs: 5.0,
      });

      expect(args).toContain("-nf"); // no fallback
      expect(args).toContain("-sns"); // suppress non-speech tokens
      expect(args).toContain("-nt"); // no timestamps
      expect(args).toContain("-nth"); // no speech threshold
      const nthIndex = args.indexOf("-nth");
      expect(args[nthIndex + 1]).toBe("0.6");
      expect(args).toContain("-mc"); // no text context
      const mcIndex = args.indexOf("-mc");
      expect(args[mcIndex + 1]).toBe("0");
    });

    it("cleans and truncates prompt conditioning hints", () => {
      const dirtyPrompt = "Terms:\0Redis\0Kafka\0" + "x".repeat(600);
      const args = buildWhisperArgs({
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        audioPath: "test.wav",
        durationSecs: 5.0,
        prompt: dirtyPrompt,
      });

      expect(args).toContain("--prompt");
      const promptIndex = args.indexOf("--prompt");
      const passedPrompt = args[promptIndex + 1];
      expect(passedPrompt).not.toContain("\0");
      expect(passedPrompt.length).toBeLessThanOrEqual(500);
      expect(passedPrompt.startsWith("Terms:RedisKafka")).toBe(true);
    });
  });

  describe("extractTranscriptionText", () => {
    it("filters diagnostic and log lines from stdout", () => {
      const stdout = [
        "load_backend: loaded CPU backend",
        "whisper_init_from_file_with_params_no_state: loading model",
        "read_audio_data: reading audio data from 'test.wav'",
        "system_info: n_threads = 4",
        "main: processing 'test.wav'",
        "Deploy the Redis cluster to Kubernetes",
        "whisper_print_timings: load time = 100ms",
      ].join("\n");

      const text = extractTranscriptionText(stdout);
      expect(text).toBe("Deploy the Redis cluster to Kubernetes");
    });
  });

  describe("End-to-End LocalWhisperEngine Execution", () => {
    it("successfully transcribes audio with mocked execution and applies lexical normalization", async () => {
      const dummyBinPath = join(testTempDir, "whisper-cli.exe");
      const dummyModelPath = join(testTempDir, "ggml-model.bin");
      const testWavPath = join(testTempDir, "test.wav");

      await writeFile(dummyBinPath, "MOCK_BIN");
      await writeFile(dummyModelPath, "MOCK_MODEL");
      await writeFile(testWavPath, createWavBuffer(16000, 32000)); // 2.0s

      const mockExecFile = vi.fn().mockResolvedValue({
        stdout: "load_backend: cpu\nconnect to raditz and deploy to cubernetis\n",
        stderr: "",
      });

      const engine = new LocalWhisperEngine({
        binaryPath: dummyBinPath,
        modelPath: dummyModelPath,
        execFileFn: mockExecFile,
      });

      expect(await engine.isAvailable()).toBe(true);

      const result = await engine.transcribe(testWavPath);
      expect(mockExecFile).toHaveBeenCalledTimes(1);

      // Verify lexical normalization was applied: raditz -> Redis, cubernetis -> Kubernetes
      expect(result.text).toBe("connect to Redis and deploy to Kubernetes");
      expect(result.provider).toBe("local");
      expect(result.model).toBe("ggml-model");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("filters junk annotations and returns empty string", async () => {
      const dummyBinPath = join(testTempDir, "whisper-cli.exe");
      const dummyModelPath = join(testTempDir, "ggml-model.bin");
      const testWavPath = join(testTempDir, "test.wav");

      await writeFile(dummyBinPath, "MOCK_BIN");
      await writeFile(dummyModelPath, "MOCK_MODEL");
      await writeFile(testWavPath, createWavBuffer(16000, 32000));

      const mockExecFile = vi.fn().mockResolvedValue({
        stdout: "[BLANK_AUDIO]\n",
        stderr: "",
      });

      const engine = new LocalWhisperEngine({
        binaryPath: dummyBinPath,
        modelPath: dummyModelPath,
        execFileFn: mockExecFile,
      });

      const result = await engine.transcribe(testWavPath);
      expect(result.text).toBe("");
    });

    it("filters prompt hint echo and returns empty string", async () => {
      const dummyBinPath = join(testTempDir, "whisper-cli.exe");
      const dummyModelPath = join(testTempDir, "ggml-model.bin");
      const testWavPath = join(testTempDir, "test.wav");

      await writeFile(dummyBinPath, "MOCK_BIN");
      await writeFile(dummyModelPath, "MOCK_MODEL");
      await writeFile(testWavPath, createWavBuffer(16000, 32000));

      const hint = "Technical terms: Redis, Kafka, Kubernetes, PostgreSQL";
      const mockExecFile = vi.fn().mockResolvedValue({
        stdout: "Redis, Kafka, Kubernetes\n",
        stderr: "",
      });

      const engine = new LocalWhisperEngine({
        binaryPath: dummyBinPath,
        modelPath: dummyModelPath,
        execFileFn: mockExecFile,
      });

      const result = await engine.transcribe(testWavPath, { prompt: hint });
      expect(result.text).toBe("");
    });

    it("cleans up temporary padded WAV file after transcription", async () => {
      const dummyBinPath = join(testTempDir, "whisper-cli.exe");
      const dummyModelPath = join(testTempDir, "ggml-model.bin");
      const shortWavPath = join(testTempDir, "short.wav");

      await writeFile(dummyBinPath, "MOCK_BIN");
      await writeFile(dummyModelPath, "MOCK_MODEL");
      // 0.5s audio needs padding
      await writeFile(shortWavPath, createWavBuffer(16000, 8000));

      let audioArgPassed = "";
      const mockExecFile = vi.fn().mockImplementation((_bin, args) => {
        const fileIdx = args.indexOf("-f");
        audioArgPassed = args[fileIdx + 1];
        return Promise.resolve({
          stdout: "hello world\n",
          stderr: "",
        });
      });

      const engine = new LocalWhisperEngine({
        binaryPath: dummyBinPath,
        modelPath: dummyModelPath,
        execFileFn: mockExecFile,
      });

      const result = await engine.transcribe(shortWavPath);
      expect(result.text).toBe("hello world");

      // Verify the passed audio path was a temp padded file and was cleaned up
      expect(audioArgPassed).not.toBe(shortWavPath);
      expect(existsSync(audioArgPassed)).toBe(false);
    });

    it("throws error when binary or model is missing", async () => {
      const engine = new LocalWhisperEngine({
        binaryPath: "/non/existent/bin",
        modelPath: "/non/existent/model",
      });

      expect(await engine.isAvailable()).toBe(false);
      await expect(engine.transcribe("some.wav")).rejects.toThrow(
        "Local Whisper STT is not ready",
      );
    });

    it("handles binary resolution and model resolution overrides and fallbacks", () => {
      const dummyBinPath = join(testTempDir, "my-whisper.exe");
      expect(resolveWhisperBinary(dummyBinPath)).toBeNull(); // Doesn't exist yet

      const dummyModelPath = join(testTempDir, "my-model.bin");
      expect(resolveWhisperModel(dummyModelPath)).toBeNull(); // Doesn't exist yet

      const engine = new LocalWhisperEngine({
        binaryPath: dummyBinPath,
        modelPath: dummyModelPath,
      });
      const info = engine.getEngineInfo();
      expect(info.isReady).toBe(false);
    });

    it("prioritizes environment variables and config over automatic resolution", async () => {
      const explicitModel = join(testTempDir, "explicit.bin");
      await writeFile(explicitModel, "EXPLICIT_MODEL");

      process.env.AGAV_WHISPER_MODEL = explicitModel;
      try {
        expect(resolveWhisperModel()).toBe(explicitModel);
      } finally {
        delete process.env.AGAV_WHISPER_MODEL;
      }

      const configModel = join(testTempDir, "config.bin");
      await writeFile(configModel, "CONFIG_MODEL");
      expect(resolveWhisperModel(undefined, { whisperModelPath: configModel })).toBe(configModel);
    });

    it("passes DEFAULT_TECHNICAL_STT_PROMPT to Whisper decoder when no prompt is provided", async () => {
      const dummyBinPath = join(testTempDir, "whisper-cli.exe");
      const dummyModelPath = join(testTempDir, "ggml-model.bin");
      const testWavPath = join(testTempDir, "test.wav");

      await writeFile(dummyBinPath, "MOCK_BIN");
      await writeFile(dummyModelPath, "MOCK_MODEL");
      await writeFile(testWavPath, createWavBuffer(16000, 32000));

      let promptArgPassed = "";
      const mockExecFile = vi.fn().mockImplementation((_bin, args) => {
        const promptIdx = args.indexOf("--prompt");
        if (promptIdx !== -1) {
          promptArgPassed = args[promptIdx + 1];
        }
        return Promise.resolve({
          stdout: "show me open issues\n",
          stderr: "",
        });
      });

      const engine = new LocalWhisperEngine({
        binaryPath: dummyBinPath,
        modelPath: dummyModelPath,
        execFileFn: mockExecFile,
      });

      const result = await engine.transcribe(testWavPath);
      expect(result.text).toBe("show me open issues");
      expect(promptArgPassed).toBe(DEFAULT_TECHNICAL_STT_PROMPT);
    });
  });
});
