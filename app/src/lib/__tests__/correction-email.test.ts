import { describe, it, expect } from "vitest";
import { buildBreakdownCorrectionBody, buildBreakdownCorrectionMailto, CORRECTIONS_EMAIL } from "@/lib/correction-email";

const rows = [
  { name: "Syngnathidae", count: 313, trueAssessed: 286, noMatch: 2, neCount: 25 },
  { name: "Solenostomidae", count: 7, trueAssessed: 4, noMatch: 0, neCount: 3 },
];
const input = {
  groupLabel: "Seahorses & Pipefishes",
  rankLabel: "Family",
  rows,
  sourceLabel: "COL26.6 XR",
  pageUrl: "https://www.dashforlife.org/?taxa=fishes",
};

function parse(link: string) {
  const [to, query] = link.replace(/^mailto:/, "").split("?");
  const params = Object.fromEntries(query.split("&").map((kv) => {
    const [k, v] = kv.split("=");
    return [k, decodeURIComponent(v)];
  }));
  return { to, subject: params.subject, body: params.body };
}

describe("buildBreakdownCorrectionBody", () => {
  it("writes out the current breakdown, then leaves room for the correction", () => {
    const body = buildBreakdownCorrectionBody(input);
    expect(body).toContain("Family: described / assessed / no 1:1 CoL match / not evaluated");
    expect(body).toContain("Syngnathidae: 313 / 286 / 2 / 25");
    expect(body).toContain("COL26.6 XR");
    expect(body.indexOf("Syngnathidae")).toBeLessThan(body.indexOf("I believe it should be:"));
  });

  it("records the page the report came from, and omits it when there isn't one", () => {
    expect(buildBreakdownCorrectionBody(input)).toContain("Reported from https://www.dashforlife.org/?taxa=fishes");
    expect(buildBreakdownCorrectionBody({ ...input, pageUrl: undefined })).not.toContain("Reported from");
  });
});

describe("buildBreakdownCorrectionMailto", () => {
  it("addresses the maintainer with the subject and body prefilled", () => {
    const { to, subject, body } = parse(buildBreakdownCorrectionMailto(input));
    expect(to).toBe(CORRECTIONS_EMAIL);
    expect(subject).toBe("Described-species breakdown for Seahorses & Pipefishes looks wrong");
    expect(body).toContain("Syngnathidae: 313 / 286 / 2 / 25");
  });

  // "&" would end the subject early, and "+" would show literally in most mail
  // clients, if the query weren't percent-encoded.
  it("percent-encodes the subject and body", () => {
    const link = buildBreakdownCorrectionMailto(input);
    expect(link).not.toContain("Seahorses & Pipefishes");
    expect(link).not.toContain("+");
    expect(link).toContain("%20");
  });

  it("cuts a long breakdown to fit the mailto length budget and says how much it kept", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ name: `Family${i}`, count: i, trueAssessed: i, noMatch: 0, neCount: 0 }));
    const link = buildBreakdownCorrectionMailto({ ...input, rows: many });
    expect(link.length).toBeLessThanOrEqual(1900);
    const { body } = parse(link);
    expect(body).toMatch(/\(first \d+ of 120 rows; the rest are on the page below\)/);
    expect(body).toContain("Family0: 0 / 0 / 0 / 0");
  });
});
