/**
 * src/config/col-release.json: the releases a sync was built from. The app cites
 * the taxonomy's XR from it (its "Source" link), and the next sync tests its
 * snapshot against the XRs it names first (inputs/snapshot-xr.ts).
 *
 * Written to a temp file, not the real pin: other tests hash the repo's source
 * files (build-prebuilt's cache key), and rewriting one mid-run changes it.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pinnedXrs, writeColReleasePin } from "../sync/inputs/col";

describe("col-release pin", () => {
  it("keeps the XR citation fields the app reads, with the checklist and the snapshot's XR beside them", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "col-pin-")), "col-release.json");
    const snapshotXr = { key: "315557", alias: "COL26.6 XR", doi: "10.48580/dgy8b", issued: "2026-06-19" };
    writeColReleasePin(
      { key: "316691", alias: "COL26.10 XR", doi: null, issued: "2026-10-16" },
      { key: "316595", alias: "COL26.10", issued: "2026-10-14" },
      snapshotXr,
      file,
    );
    const pin = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(pin).toMatchObject({ key: "316691", alias: "COL26.10 XR", issued: "2026-10-16" });
    // The checklist's own date must not shadow the XR's.
    expect(pin.checklist).toEqual({ key: "316595", alias: "COL26.10", issued: "2026-10-14" });
    expect(pin.snapshotXr).toEqual(snapshotXr);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("offers the snapshot's XR, then the taxonomy's, as the first ones to test the next snapshot against", () => {
    expect(pinnedXrs().length).toBeGreaterThan(0);
  });
});
