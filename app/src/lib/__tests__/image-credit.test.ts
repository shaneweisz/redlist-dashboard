import { describe, expect, it } from "vitest";
import { formatLicense, gbifImageCredit } from "../image-credit";

describe("formatLicense", () => {
  it("shortens a CC licence URL", () => {
    expect(formatLicense("http://creativecommons.org/licenses/by-nc/4.0/legalcode")).toBe("CC BY-NC 4.0");
  });
  it("names CC0", () => {
    expect(formatLicense("http://creativecommons.org/publicdomain/zero/1.0/legalcode")).toBe("CC0");
  });
  it("passes anything else through", () => {
    expect(formatLicense("All rights reserved")).toBe("All rights reserved");
  });
});

describe("gbifImageCredit", () => {
  it("names the creator and the licence", () => {
    expect(gbifImageCredit({ creator: "A. Botanist", license: "http://creativecommons.org/licenses/by/4.0/" })).toBe("© A. Botanist · CC BY 4.0");
  });
  it("falls back to the rights holder when there's no creator", () => {
    expect(gbifImageCredit({ rightsHolder: "Natural History Museum", license: "http://creativecommons.org/licenses/by/4.0/" })).toBe("© Natural History Museum · CC BY 4.0");
  });
  it("keeps the licence alone when no one is named", () => {
    expect(gbifImageCredit({ license: "http://creativecommons.org/publicdomain/zero/1.0/" })).toBe("CC0");
  });
  it("is null when the record carries nothing", () => {
    expect(gbifImageCredit({})).toBeNull();
  });
});
