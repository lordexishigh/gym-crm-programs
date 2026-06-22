import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureException,
  reportHandledError,
  newCorrelationId,
} from "../lib/observability/monitoring";

/**
 * Unit tests for error monitoring + alerting (beta-hardening-001).
 *
 * `fetch` and the console sinks are mocked — no real network. Covers the three
 * guarantees the acceptance criteria depend on:
 *   - every captured error is logged (structured, to stderr),
 *   - errors are forwarded to the monitoring webhook when configured,
 *   - `critical` severity additionally raises an alert,
 * plus that capturing never throws and `reportHandledError` routes through the
 * same path (so caught server-action errors are still monitored).
 */
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.MONITORING_WEBHOOK_URL;
  delete process.env.ALERT_WEBHOOK_URL;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("newCorrelationId", () => {
  it("returns a non-empty string", () => {
    expect(newCorrelationId().length).toBeGreaterThan(0);
  });
});

describe("captureException", () => {
  it("logs the error and returns a correlation id (no webhook configured)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const id = await captureException(new Error("boom"), { source: "test" });

    expect(id).toBeTruthy();
    expect(console.error).toHaveBeenCalledTimes(1); // structured error log line
    expect(fetchMock).not.toHaveBeenCalled(); // log-only when no sink set
  });

  it("reuses a provided correlation id (so client + server line up)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const id = await captureException(new Error("x"), {
      source: "client",
      correlationId: "digest-123",
    });
    expect(id).toBe("digest-123");
  });

  it("forwards every error to MONITORING_WEBHOOK_URL when set", async () => {
    process.env.MONITORING_WEBHOOK_URL = "https://monitor.example/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await captureException(new Error("boom"), { source: "test", severity: "error" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://monitor.example/hook");
    const payload = JSON.parse(init.body);
    expect(payload.type).toBe("exception");
    expect(payload.severity).toBe("error");
    expect(payload.error.message).toBe("boom");
  });

  it("raises an alert to ALERT_WEBHOOK_URL on critical severity", async () => {
    process.env.MONITORING_WEBHOOK_URL = "https://monitor.example/hook";
    process.env.ALERT_WEBHOOK_URL = "https://alert.example/page";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await captureException(new Error("invite send failed"), {
      source: "send-invite",
      severity: "critical",
    });

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://monitor.example/hook"); // monitored
    expect(urls).toContain("https://alert.example/page"); // alerted
    const alertCall = fetchMock.mock.calls.find((c) => c[0] === "https://alert.example/page");
    expect(JSON.parse(alertCall![1].body).alert).toBe(true);
  });

  it("flags the monitoring event as an alert when no dedicated alert sink is set", async () => {
    process.env.MONITORING_WEBHOOK_URL = "https://monitor.example/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await captureException(new Error("critical"), { severity: "critical" });

    // One plain event + one alert-flagged event, both to the monitoring URL.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some((c) => JSON.parse(c[1].body).alert === true)).toBe(true);
  });

  it("never throws even if the webhook delivery fails", async () => {
    process.env.MONITORING_WEBHOOK_URL = "https://monitor.example/hook";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(
      captureException(new Error("boom"), { source: "test" }),
    ).resolves.toBeTruthy();
  });

  it("normalises a non-Error thrown value", async () => {
    process.env.MONITORING_WEBHOOK_URL = "https://monitor.example/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await captureException("just a string", { source: "test" });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.error.name).toBe("NonError");
    expect(payload.error.message).toBe("just a string");
  });
});

describe("reportHandledError", () => {
  it("routes a caught error through captureException with the given source", async () => {
    process.env.MONITORING_WEBHOOK_URL = "https://monitor.example/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const id = await reportHandledError(new Error("db down"), "create-member", {
      tenantId: "t1",
    });

    expect(id).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.source).toBe("create-member");
    expect(payload.severity).toBe("error"); // monitored, not paged, by default
    expect(payload.context.tenantId).toBe("t1");
  });

  it("escalates to an alert when severity is overridden to critical", async () => {
    process.env.MONITORING_WEBHOOK_URL = "https://monitor.example/hook";
    process.env.ALERT_WEBHOOK_URL = "https://alert.example/page";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await reportHandledError(new Error("link failed"), "invite-accept-link", {
      severity: "critical",
    });

    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("https://alert.example/page");
  });
});
