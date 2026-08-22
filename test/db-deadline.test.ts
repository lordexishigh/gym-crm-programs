import { describe, expect, it } from "vitest";
import { TransactionDeadlineError, withDeadline } from "@/lib/db";

/**
 * `withDeadline` is what turns a stalled `withTenantContext`/`withAdminContext`
 * call into a bounded, catchable failure instead of an indefinite hang (issue
 * #26: a submit button stuck on "Assigning…" forever with no error). Tested here
 * as the pure racing primitive, independent of any real database connection.
 */
describe("withDeadline", () => {
  it("resolves with the value when the promise settles before the deadline", async () => {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 5));
    await expect(withDeadline(fast, 200)).resolves.toBe("ok");
  });

  it("rejects with TransactionDeadlineError when the promise outruns the deadline", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("too late"), 200));
    await expect(withDeadline(slow, 5)).rejects.toBeInstanceOf(TransactionDeadlineError);
  });

  it("carries the configured deadline on the error", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("x"), 200));
    await expect(withDeadline(slow, 5)).rejects.toMatchObject({ ms: 5 });
  });

  it("propagates the promise's own rejection when it loses before the deadline", async () => {
    const failsFast = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("boom")), 5),
    );
    await expect(withDeadline(failsFast, 200)).rejects.toThrow("boom");
  });

  it("does not fire the timer once the promise has already settled", async () => {
    // Regression guard: an uncleared timer would otherwise reject a *later*,
    // unrelated await sharing the event loop once it eventually fires.
    const fast = Promise.resolve("done");
    await expect(withDeadline(fast, 5)).resolves.toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
