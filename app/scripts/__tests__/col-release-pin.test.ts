/**
 * src/config/col-release.json: the releases a sync was built from. The app cites
 * the XR from it (its "Source" link), and the sync stands on its XR when GBIF
 * can't be asked which release it indexes.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { writeColReleasePin } from "../sync/inputs/col";

const PIN = path.join(__dirname, "../../src/config/col-release.json");
const original = fs.readFileSync(PIN, "utf-8");
afterEach(() => fs.writeFileSync(PIN, original));

describe("col-release pin", () => {
  it("keeps the XR citation fields the app reads, with the checklist beside them", () => {
    writeColReleasePin(
      { key: "315557", alias: "COL26.6 XR", doi: "10.48580/dgy8b", issued: "2026-06-19" },
      { key: "316115", alias: "COL26.8", issued: "2026-08-20" },
    );
    const pin = JSON.parse(fs.readFileSync(PIN, "utf-8"));
    expect(pin).toMatchObject({ key: "315557", alias: "COL26.6 XR", doi: "10.48580/dgy8b", issued: "2026-06-19" });
    // The checklist's own date must not shadow the XR's.
    expect(pin.checklist).toEqual({ key: "316115", alias: "COL26.8", issued: "2026-08-20" });
  });
});
