import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { assignPinCodes } from "../lib/checkin";

/**
 * Unit tests for the bulk PIN allocator used by the CSV member import.
 *
 * No database: `assignPinCodes` takes a `PoolClient`, so a stub that records
 * every statement lets us assert the part that actually matters — that a PIN is
 * never handed out twice, neither against PINs the tenant already holds nor
 * against others allocated in the same batch. A duplicate here would violate
 * `idx_member_tenant_pin_code` and roll back the whole import.
 */

type Recorded = { sql: string; params: unknown[] };

/** A stub PoolClient whose SELECT returns `taken` and which records every call. */
function stubClient(taken: string[] = []): {
  client: PoolClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*select pin_code/i.test(sql)) {
      return { rows: taken.map((pin_code) => ({ pin_code })) };
    }
    return { rows: [] };
  };
  return { client: { query } as unknown as PoolClient, calls };
}

/** Mirrors `randomPin` in lib/checkin so a stubbed Math.random maps to a known PIN. */
function pinFor(random: number): string {
  return Math.floor(random * 10 ** 6)
    .toString()
    .padStart(6, "0");
}

/** Feed Math.random a fixed sequence, repeating the last value once exhausted. */
function stubRandom(sequence: number[]): void {
  let i = 0;
  vi.spyOn(Math, "random").mockImplementation(
    () => sequence[Math.min(i++, sequence.length - 1)]!,
  );
}

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assignPinCodes", () => {
  it("does nothing at all for an empty batch", async () => {
    const { client, calls } = stubClient();
    await assignPinCodes(client, "tenant-1", []);
    // Not even the "which PINs are taken" read — an import that inserted no
    // rows must not cost a round-trip.
    expect(calls).toEqual([]);
  });

  it("writes every member's PIN in a single UPDATE", async () => {
    const { client, calls } = stubClient();
    await assignPinCodes(client, "tenant-1", [ID_A, ID_B, ID_C]);

    // One read of the taken PINs, then exactly one write — not two per member.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toEqual(["tenant-1"]);

    const update = calls[1]!;
    expect(update.sql).toContain("update member m");
    // Params alternate id, pin — three members, six bound values.
    expect(update.params).toHaveLength(6);
    expect(update.params.filter((_, i) => i % 2 === 0)).toEqual([ID_A, ID_B, ID_C]);

    const pins = update.params.filter((_, i) => i % 2 === 1) as string[];
    for (const pin of pins) expect(pin).toMatch(/^\d{6}$/);
    expect(new Set(pins).size).toBe(3);
  });

  it("never reuses a PIN the tenant already holds", async () => {
    const taken = pinFor(0.000042);
    // First draw collides with the existing PIN; the retry must be used instead.
    stubRandom([0.000042, 0.000043]);

    const { client, calls } = stubClient([taken]);
    await assignPinCodes(client, "tenant-1", [ID_A]);

    expect(calls[1]!.params).toEqual([ID_A, pinFor(0.000043)]);
  });

  it("never hands the same PIN to two members in one batch", async () => {
    // Both members draw the same number first; the second must retry.
    stubRandom([0.000777, 0.000777, 0.000778]);

    const { client, calls } = stubClient();
    await assignPinCodes(client, "tenant-1", [ID_A, ID_B]);

    expect(calls[1]!.params).toEqual([
      ID_A,
      pinFor(0.000777),
      ID_B,
      pinFor(0.000778),
    ]);
  });

  it("throws rather than writing a duplicate when it cannot find a free PIN", async () => {
    // Every draw returns a PIN the tenant already holds.
    stubRandom([0.000555]);
    const { client, calls } = stubClient([pinFor(0.000555)]);

    await expect(assignPinCodes(client, "tenant-1", [ID_A])).rejects.toThrow(
      /unique PIN codes/i,
    );
    // The read happened; no UPDATE was attempted. Throwing inside the import's
    // transaction rolls the whole thing back, which is the intended outcome.
    expect(calls).toHaveLength(1);
  });
});
