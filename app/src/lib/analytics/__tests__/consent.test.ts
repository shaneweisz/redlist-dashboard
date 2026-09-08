import { describe, it, expect, vi } from "vitest";
import {
  ANALYTICS_POLICY_VERSION,
  getAnalyticsConsent,
  setAnalyticsConsent,
} from "../consent";

type Row = { consented: boolean; policy_version: string } | null;

function mockSupabase(row: Row, upsertError: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const upsert = vi.fn().mockResolvedValue({ error: upsertError });
  const from = vi.fn().mockReturnValue({ select, upsert });
  return {
    client: { from } as unknown as Parameters<typeof getAnalyticsConsent>[0],
    spies: { from, select, eq, maybeSingle, upsert },
  };
}

describe("getAnalyticsConsent", () => {
  it("returns null for a signed-out user without querying", async () => {
    const { client, spies } = mockSupabase(null);
    await expect(getAnalyticsConsent(client, null)).resolves.toBeNull();
    expect(spies.from).not.toHaveBeenCalled();
  });

  it("returns null when the user has never been asked", async () => {
    const { client } = mockSupabase(null);
    await expect(getAnalyticsConsent(client, "user-1")).resolves.toBeNull();
  });

  it("returns true when the user opted in under the current policy", async () => {
    const { client } = mockSupabase({
      consented: true,
      policy_version: ANALYTICS_POLICY_VERSION,
    });
    await expect(getAnalyticsConsent(client, "user-1")).resolves.toBe(true);
  });

  // The distinction the whole three-state model rests on: a stored false is
  // "asked and declined", which must not collapse into "never asked" or the
  // prompt would reappear on every page load.
  it("returns false — not null — when the user declined", async () => {
    const { client } = mockSupabase({
      consented: false,
      policy_version: ANALYTICS_POLICY_VERSION,
    });
    await expect(getAnalyticsConsent(client, "user-1")).resolves.toBe(false);
  });

  it("ignores an opt-in given under an older policy version", async () => {
    const { client } = mockSupabase({ consented: true, policy_version: "1970-01-01" });
    await expect(getAnalyticsConsent(client, "user-1")).resolves.toBeNull();
  });

  it("ignores a refusal given under an older policy version", async () => {
    const { client } = mockSupabase({ consented: false, policy_version: "1970-01-01" });
    await expect(getAnalyticsConsent(client, "user-1")).resolves.toBeNull();
  });

  it("queries analytics_consent filtered by user_id", async () => {
    const { client, spies } = mockSupabase(null);
    await getAnalyticsConsent(client, "user-1");
    expect(spies.from).toHaveBeenCalledWith("analytics_consent");
    expect(spies.eq).toHaveBeenCalledWith("user_id", "user-1");
  });
});

describe("setAnalyticsConsent", () => {
  it("upserts the decision stamped with the current policy version", async () => {
    const { client, spies } = mockSupabase(null);
    await expect(setAnalyticsConsent(client, "user-1", true)).resolves.toEqual({
      error: null,
    });
    expect(spies.from).toHaveBeenCalledWith("analytics_consent");
    const [row, options] = spies.upsert.mock.calls[0];
    expect(row).toMatchObject({
      user_id: "user-1",
      consented: true,
      policy_version: ANALYTICS_POLICY_VERSION,
    });
    // Set explicitly rather than left to the column default, which only fires
    // on insert — an update would otherwise keep the original timestamp.
    expect(typeof row.decided_at).toBe("string");
    expect(options).toEqual({ onConflict: "user_id" });
  });

  it("records a withdrawal as false rather than deleting the row", async () => {
    const { client, spies } = mockSupabase(null);
    await setAnalyticsConsent(client, "user-1", false);
    expect(spies.upsert.mock.calls[0][0]).toMatchObject({ consented: false });
  });

  it("surfaces the error message instead of throwing", async () => {
    const { client } = mockSupabase(null, { message: "permission denied" });
    await expect(setAnalyticsConsent(client, "user-1", true)).resolves.toEqual({
      error: "permission denied",
    });
  });
});
