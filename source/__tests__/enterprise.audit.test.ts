import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_SINK_ENV,
  buildAuditEvent,
  emitAuditEvent,
  recordAuditEvent,
  resolveAuditSink,
} from "../enterprise/audit.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveAuditSink", () => {
  it("prefers an explicit sink (org policy) over the env var", () => {
    const sink = resolveAuditSink({ sink: "https://siem.corp/ingest", env: { [AUDIT_SINK_ENV]: "https://env.corp" } });
    expect(sink).toBe("https://siem.corp/ingest");
  });

  it("falls back to the env var when no explicit sink is given", () => {
    expect(resolveAuditSink({ env: { [AUDIT_SINK_ENV]: "https://env.corp/ingest" } })).toBe("https://env.corp/ingest");
  });

  it("returns undefined when no sink is configured", () => {
    expect(resolveAuditSink({ env: {} })).toBeUndefined();
  });

  it("treats an insecure sink as not configured (never throws)", () => {
    expect(resolveAuditSink({ sink: "http://siem.corp/ingest", env: {} })).toBeUndefined();
  });

  it("treats a malformed sink as not configured", () => {
    expect(resolveAuditSink({ sink: "not a url", env: {} })).toBeUndefined();
  });

  it("allows http on loopback (self-hosted dev)", () => {
    expect(resolveAuditSink({ sink: "http://localhost:9000/ingest", env: {} })).toBe("http://localhost:9000/ingest");
  });
});

describe("buildAuditEvent", () => {
  it("stamps the time and source onto the event", () => {
    const event = buildAuditEvent({ action: "login.success", flow: "auth-code", subject: "a@corp" });
    expect(event.action).toBe("login.success");
    expect(event.flow).toBe("auth-code");
    expect(event.subject).toBe("a@corp");
    expect(event.source).toBe("agav-cli");
    expect(typeof event.at).toBe("string");
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });
});

describe("emitAuditEvent", () => {
  it("posts the event as JSON to the configured sink and reports delivery", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const event = buildAuditEvent({ action: "login.success", flow: "device", controlPlane: "https://auth.corp" });
    const ok = await emitAuditEvent(event, { sink: "https://siem.corp/ingest", fetchImpl });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://siem.corp/ingest");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      action: "login.success",
      flow: "device",
      controlPlane: "https://auth.corp",
      source: "agav-cli",
    });
  });

  it("drops the event (returns false) when no sink is configured", async () => {
    const fetchImpl = vi.fn();
    const event = buildAuditEvent({ action: "logout" });
    expect(await emitAuditEvent(event, { env: {}, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws when the sink is unreachable (best-effort)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const event = buildAuditEvent({ action: "login.failure", reason: "nope" });
    expect(await emitAuditEvent(event, { sink: "https://siem.corp/ingest", fetchImpl })).toBe(false);
  });

  it("returns false on a non-2xx sink response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    const event = buildAuditEvent({ action: "login.attempt" });
    expect(await emitAuditEvent(event, { sink: "https://siem.corp/ingest", fetchImpl })).toBe(false);
  });

  it("carries no secrets — only the documented safe fields", () => {
    const event = buildAuditEvent({
      action: "login.success",
      flow: "saml",
      controlPlane: "https://auth.corp",
      subject: "a@corp",
      reason: "ok",
    });
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(["action", "at", "controlPlane", "flow", "reason", "source", "subject"]);
  });
});

describe("recordAuditEvent", () => {
  it("builds and emits in one call, best-effort", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await recordAuditEvent(
      { action: "logout", controlPlane: "https://auth.corp" },
      { sink: "https://siem.corp/ingest", fetchImpl },
    );
    expect(ok).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toMatchObject({ action: "logout", source: "agav-cli" });
  });
});
