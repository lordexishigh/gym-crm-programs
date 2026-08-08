import { describe, expect, it } from "vitest";
import { isPoolExhaustion } from "@/lib/db";

/**
 * `isPoolExhaustion` decides whether a failed `connect()` gets retried, so its
 * job is to separate "the pooler has no slot right now" (transient, worth a
 * second attempt) from every other failure (real, must propagate immediately).
 *
 * Getting this wrong is costly in both directions: too narrow and the member
 * portal renders an error boundary for a burst that a ~50ms wait would have
 * absorbed — the production failure this classifier was added for; too broad and
 * a genuine fault (bad password, unreachable host) is retried instead of
 * surfacing, turning a fast, clear error into a slow, vague one.
 */
describe("isPoolExhaustion", () => {
  it("matches Supabase's session-mode pooler rejection", () => {
    // The verbatim shape observed in production logs (level FATAL, code XX000).
    const err = Object.assign(
      new Error("max clients reached in session mode - max clients are limited to pool_size: 15"),
      { code: "XX000", severity: "FATAL" },
    );
    expect(isPoolExhaustion(err)).toBe(true);
  });

  it("matches the EMAXCONNSESSION marker even when the wording changes", () => {
    // Guard against relying on the prose: the code is the stable part.
    const err = new Error("error: (EMAXCONNSESSION) something reworded upstream");
    expect(isPoolExhaustion(err)).toBe(true);
  });

  it("matches a direct Postgres running out of connection slots", () => {
    const err = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
    expect(isPoolExhaustion(err)).toBe(true);
  });

  it("matches SQLSTATE 53300 regardless of message", () => {
    expect(isPoolExhaustion(Object.assign(new Error("localised text"), { code: "53300" }))).toBe(
      true,
    );
  });

  it("does NOT match failures that must fail fast rather than retry", () => {
    for (const err of [
      Object.assign(new Error("password authentication failed for user"), { code: "28P01" }),
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("timeout exceeded when trying to connect"), { code: undefined }),
      Object.assign(new Error('relation "members" does not exist'), { code: "42P01" }),
      Object.assign(new Error("permission denied to set role"), { code: "42501" }),
    ]) {
      expect(isPoolExhaustion(err), err.message).toBe(false);
    }
  });

  it("tolerates non-error values instead of throwing", () => {
    // A rejected promise can carry anything; the classifier runs in a catch block
    // and must never itself throw.
    for (const value of [null, undefined, "string", 42, {}, []]) {
      expect(isPoolExhaustion(value)).toBe(false);
    }
  });
});
