import { describe, it, expect } from "vitest";
import { buildBreakdownCorrectionBody, buildBreakdownCorrectionMailto, CORRECTIONS_EMAIL } from "@/lib/correction-email";

const input = {
  groupLabel: "Snake Specialist Group",
  rankLabel: "Family",
  names: ["Boidae", "Colubridae", "Elapidae"],
  pageUrl: "https://www.dashforlife.org/?layout=ssc",
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
  it("says what the dashboard has, then asks what it should be", () => {
    const body = buildBreakdownCorrectionBody(input);
    expect(body).toContain("According to the dashboard, the Snake Specialist Group has the following 3 families: Boidae, Colubridae, Elapidae.");
    expect(body.indexOf("According to the dashboard")).toBeLessThan(body.indexOf("It should actually be:"));
  });

  it("uses the rank's plural, and drops 'the' for a plain taxon", () => {
    const body = buildBreakdownCorrectionBody({ ...input, groupLabel: "Anoles", rankLabel: "Genus", names: ["Anolis", "Norops"] });
    expect(body).toContain("According to the dashboard, Anoles has the following 2 genera: Anolis, Norops.");
  });

  it("describes a catch-all group by its scope, since it has no list of names", () => {
    const body = buildBreakdownCorrectionBody({ ...input, groupLabel: "Lizard and Tuatara Red List Authority", rankLabel: "Group", names: ["Lizard and Tuatara Red List Authority"], scopeText: "Lizards not claimed by any other group." });
    expect(body).toContain("According to the dashboard, the Lizard and Tuatara Red List Authority covers: Lizards not claimed by any other group.");
  });

  it("records the page the report came from, and omits it when there isn't one", () => {
    expect(buildBreakdownCorrectionBody(input)).toContain("Reported from https://www.dashforlife.org/?layout=ssc");
    expect(buildBreakdownCorrectionBody({ ...input, pageUrl: undefined })).not.toContain("Reported from");
  });
});

describe("buildBreakdownCorrectionMailto", () => {
  it("addresses the maintainer with a 'Suggested correction' subject", () => {
    const { to, subject, body } = parse(buildBreakdownCorrectionMailto(input));
    expect(to).toBe(CORRECTIONS_EMAIL);
    expect(subject).toBe("Suggested correction for the Snake Specialist Group");
    expect(body).toContain("Boidae, Colubridae, Elapidae");
  });

  // "&" would end the subject early, and "+" would show literally in most mail
  // clients, if the query weren't percent-encoded.
  it("percent-encodes the subject and body", () => {
    const link = buildBreakdownCorrectionMailto({ ...input, groupLabel: "Seahorses & Pipefishes" });
    expect(link).not.toContain("Seahorses & Pipefishes");
    expect(link).not.toContain("+");
  });

  it("cuts a long name list to fit the mailto length budget and says how many it left out", () => {
    const names = Array.from({ length: 300 }, (_, i) => `Familyname${i}`);
    const link = buildBreakdownCorrectionMailto({ ...input, names });
    expect(link.length).toBeLessThanOrEqual(1900);
    const { body } = parse(link);
    expect(body).toMatch(/has the following 300 families: Familyname0, .*, and \d+ more \(see the page below\)\./);
  });
});
