/**
 * The pin that decides whether Phases 2-4 re-run.
 *
 * It used to record only the XR release, which follows GBIF's occurrence index.
 * The CURATED checklist moves on its own schedule — `3LR` was COL26.6 in June and
 * COL26.8 by late August while the XR pin had not moved at all — and
 * build-backbone stamps in_checklist / checklist_parent_id / checklist_name from
 * it. Those carry claims the UI renders beside links to that release's pages, so
 * a checklist-only roll that doesn't trigger a rebuild leaves a rename showing
 * the old accepted name next to a page that now disagrees.
 *
 * These cover the reading side, which is what the gate consults. Writing goes
 * through writeReleaseMetadata, so both are exercised together.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { currentReleaseOnDisk, currentChecklistOnDisk, writeReleaseMetadata } from "../sync/inputs/fetch-col-xr";

const PIN = path.join(__dirname, "../../src/config/col-release.json");
const original = fs.readFileSync(PIN, "utf-8");
afterEach(() => fs.writeFileSync(PIN, original));

const XR = { key: "315557", alias: "COL26.6 XR", doi: "10.48580/dgy8b", issued: "2026-06-19" };

describe("col-release pin", () => {
  it("records both releases, so either moving can trigger a rebuild", () => {
    writeReleaseMetadata(XR, { key: "316115", alias: "COL26.8", issued: "2026-08-20" });
    expect(currentReleaseOnDisk()).toBe("315557");
    expect(currentChecklistOnDisk()).toBe("2026-08-20");
  });

  it("reports an unpinned checklist as unknown, not as current", () => {
    // A pin written before this field existed. Returning null makes the gate
    // rebuild: we cannot tell which checklist produced the backbone on disk, and
    // assuming it is current is exactly the stale-claim failure.
    fs.writeFileSync(PIN, JSON.stringify(XR, null, 2) + "\n");
    expect(currentReleaseOnDisk()).toBe("315557");
    expect(currentChecklistOnDisk()).toBeNull();
  });

  it("keeps the XR citation fields the frontend's Source link reads", () => {
    writeReleaseMetadata(XR, { key: "316115", alias: "COL26.8", issued: "2026-08-20" });
    const pin = JSON.parse(fs.readFileSync(PIN, "utf-8"));
    expect(pin.alias).toBe("COL26.6 XR");
    expect(pin.doi).toBe("10.48580/dgy8b");
    expect(pin.issued).toBe("2026-06-19");
    // The checklist is additive — it must not shadow the XR's own issued date.
    expect(pin.checklist.issued).toBe("2026-08-20");
  });
});
