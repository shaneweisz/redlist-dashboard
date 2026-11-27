import { describe, it, expect } from "vitest";
import { decodeHtmlEntities, stripHtml } from "../html-text";

describe("decodeHtmlEntities", () => {
  it("decodes decimal numeric references", () => {
    expect(decodeHtmlEntities("known&#160;from 46 sites")).toBe("known from 46 sites");
  });

  it("decodes hex numeric references", () => {
    expect(decodeHtmlEntities("2&#xB0;C")).toBe("2°C");
  });

  it("decodes named references", () => {
    expect(decodeHtmlEntities("Rich &amp; Co &ndash; 2010")).toBe("Rich & Co – 2010");
  });

  it("decodes in a single pass, so escaped references survive", () => {
    expect(decodeHtmlEntities("&amp;#160;")).toBe("&#160;");
  });

  it("leaves unknown references alone", () => {
    expect(decodeHtmlEntities("&notanentity; &#xZZ;")).toBe("&notanentity; &#xZZ;");
  });
});

describe("stripHtml", () => {
  it("decodes the &#160; that IUCN narrative text is littered with", () => {
    const input =
      "The species is known&#160;from 46 sites, with around 2,300 individuals. " +
      "Thirty-three of the sites have less than ten plants (Rich <em>et al.</em>&#160;2010).";
    expect(stripHtml(input)).toBe(
      "The species is known from 46 sites, with around 2,300 individuals. " +
        "Thirty-three of the sites have less than ten plants (Rich et al. 2010)."
    );
  });

  it("turns block markup into line breaks", () => {
    expect(stripHtml("<p>One</p><p>Two<br/>Three</p>")).toBe("One\n\nTwo\nThree");
  });

  it("normalises literal non-breaking spaces", () => {
    expect(stripHtml("46 sites")).toBe("46 sites");
  });

  it("collapses runs of blank lines and trims", () => {
    expect(stripHtml("<p>A</p><p></p><p></p><p>B</p>  ")).toBe("A\n\nB");
  });
});
