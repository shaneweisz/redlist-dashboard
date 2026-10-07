import { describe, it, expect } from "vitest";
import {
  backupFileName,
  buildEditsBackup,
  readEditsBackup,
  summariseBackup,
  EDITS_BACKUP_VERSION,
} from "../edits-backup";

const georeference = {
  gbifID: 1,
  decimalLatitude: 4.55,
  decimalLongitude: -75.5,
  coordinateUncertaintyInMeters: 5000,
  georeferencedDate: "2026-08-27T00:00:00.000Z",
};

const backup = () =>
  buildEditsBackup({
    speciesKey: "6CX6F",
    scientificName: "Dioscorea biplicata",
    savedAt: "2026-08-27T09:30:00.000Z",
    georeferences: { 1: georeference },
    exclusions: {
      2: { gbifID: 2, justification: "Cultivated", excludedAt: "2026-08-27T09:00:00.000Z" },
    },
    dates: { 3: { gbifID: 3, eventDate: "1974", addedAt: "2026-08-27T09:10:00.000Z" } },
    pointFile: null,
  });

describe("the saved-work file", () => {
  it("round-trips everything the browser was holding", () => {
    const read = readEditsBackup(JSON.stringify(backup()), "6CX6F");
    expect("backup" in read).toBe(true);
    if (!("backup" in read)) return;
    expect(read.backup.georeferences[1]).toEqual(georeference);
    expect(read.backup.exclusions[2].justification).toBe("Cultivated");
    expect(read.backup.dates[3].eventDate).toBe("1974");
    expect(read.backup.version).toBe(EDITS_BACKUP_VERSION);
  });

  it("links duplicates an older build saved only as wording", () => {
    const old = {
      ...backup(),
      exclusions: {
        4: { gbifID: 4, justification: "Duplicate of GBIF 5", excludedAt: "2026-08-27T09:00:00.000Z" },
      },
    };
    const read = readEditsBackup(JSON.stringify(old), "6CX6F");
    if (!("backup" in read)) throw new Error(read.error);
    expect(read.backup.exclusions[4].duplicateOf).toBe(5);
  });

  it("refuses another species' work, which would be a quiet disaster", () => {
    const read = readEditsBackup(JSON.stringify(backup()), "ANOTHER");
    expect(read).toEqual({ error: expect.stringContaining("Dioscorea biplicata") });
  });

  it("refuses a file from a newer dashboard than this one", () => {
    const future = { ...backup(), version: EDITS_BACKUP_VERSION + 1 };
    expect(readEditsBackup(JSON.stringify(future), "6CX6F")).toEqual({
      error: expect.stringContaining("newer version"),
    });
  });

  it("refuses a file that isn't ours, and one that isn't JSON", () => {
    expect(readEditsBackup(JSON.stringify({ hello: "world" }), "6CX6F")).toEqual({
      error: expect.stringContaining("isn't a saved-work file"),
    });
    expect(readEditsBackup("not json at all", "6CX6F")).toEqual({
      error: expect.stringContaining("isn't JSON"),
    });
  });

  it("survives a file with a store missing rather than restoring undefined", () => {
    const partial = { ...backup(), dates: undefined } as unknown as Record<string, unknown>;
    const read = readEditsBackup(JSON.stringify(partial), "6CX6F");
    expect("backup" in read && read.backup.dates).toEqual({});
  });

  it("says what it holds, in the plural only when it should", () => {
    expect(summariseBackup(backup())).toBe("1 georeference, 1 exclusion, 1 date");
    const many = { ...backup(), dates: {} };
    expect(summariseBackup(many)).toContain("0 dates");
  });

  it("counts an imported point file among the work", () => {
    const point = { row: 2, latitude: 0, longitude: 0, gbifID: null, fields: {} };
    const withFile = {
      ...backup(),
      pointFile: {
        fileName: "f.csv",
        importedAt: "",
        points: [point, { ...point, row: 3 }],
        errors: [],
        extraColumns: [],
      },
    };
    expect(summariseBackup(withFile)).toContain("2 imported points");
  });

  it("names the file after the species and the moment it was saved", () => {
    expect(backupFileName("Dioscorea biplicata", "2026-08-27T09:30:00.000Z")).toBe(
      "dioscorea_biplicata_dashboard_work_2026-08-27T09-30-00Z.json"
    );
  });

  it("keeps two saves in one day apart, and in order", () => {
    // The whole point: a date-only name collided on the second save of a
    // sitting and left the browser to invent "(1)".
    const morning = backupFileName("Dioscorea biplicata", "2026-08-27T09:30:00.000Z");
    const evening = backupFileName("Dioscorea biplicata", "2026-08-27T18:05:42.000Z");
    expect(morning).not.toBe(evening);
    // Lexicographic order is chronological order, so a file listing sorts right.
    expect([evening, morning].sort()).toEqual([morning, evening]);
  });

  it("carries no character a filesystem would refuse", () => {
    expect(backupFileName("Dioscorea biplicata", "2026-08-27T09:30:00.000Z")).not.toMatch(/[:*?"<>|]/);
  });
});

describe("the pins in the saved file", () => {
  const pin = {
    id: "pin-1",
    name: "the ridge the 1987 collections came from",
    context: "",
    lat: 1.25,
    lng: -70.23,
  };

  const withPins = () =>
    buildEditsBackup({
      speciesKey: "6CX6F",
      scientificName: "Dioscorea biplicata",
      savedAt: "2026-08-28T09:30:00.000Z",
      georeferences: {},
      exclusions: {},
      dates: {},
      pointFile: null,
      pins: [pin, { ...pin, id: "pin-2", name: "Mitú", nameHidden: true }],
    });

  it("carries a pin a gazetteer could never find again", () => {
    const read = readEditsBackup(JSON.stringify(withPins()), "6CX6F");
    expect("backup" in read).toBe(true);
    if (!("backup" in read)) return;
    expect(read.backup.pins?.[0]).toEqual(pin);
  });

  it("remembers which names were folded away", () => {
    const read = readEditsBackup(JSON.stringify(withPins()), "6CX6F");
    if (!("backup" in read)) throw new Error("expected a backup");
    expect(read.backup.pins?.[1].nameHidden).toBe(true);
  });

  it("counts them where the dialog asks whether to restore", () => {
    expect(summariseBackup(withPins())).toContain("2 pins");
  });

  it("says one pin, not one pins", () => {
    expect(summariseBackup({ ...withPins(), pins: [pin] })).toMatch(/\b1 pin$/);
  });

  it("says nothing about pins where none were placed", () => {
    expect(summariseBackup({ ...withPins(), pins: [] })).not.toContain("pin");
  });

  it("reads a file written before pins were in it", () => {
    const older = { ...withPins(), pins: undefined };
    const read = readEditsBackup(JSON.stringify(older), "6CX6F");
    if (!("backup" in read)) throw new Error("expected a backup");
    expect(read.backup.pins).toEqual([]);
  });
});

describe("the locality notes in the saved file", () => {
  const note = {
    gbifID: 4,
    text: "Two villages of this name; the collector's route says the eastern one",
    addedAt: "2026-08-28T10:00:00.000Z",
  };

  const withNotes = () =>
    buildEditsBackup({
      speciesKey: "6CX6F",
      scientificName: "Dioscorea biplicata",
      savedAt: "2026-08-28T09:30:00.000Z",
      georeferences: {},
      exclusions: {},
      dates: {},
      notes: { 4: note },
      pointFile: null,
    });

  it("carries the reasoning for a locality that was never placed", () => {
    const read = readEditsBackup(JSON.stringify(withNotes()), "6CX6F");
    if (!("backup" in read)) throw new Error("expected a backup");
    expect(read.backup.notes?.[4]).toEqual(note);
  });

  it("counts them where the dialog asks whether to restore", () => {
    expect(summariseBackup(withNotes())).toContain("1 locality note");
  });

  it("says nothing about notes where there are none", () => {
    expect(summariseBackup({ ...withNotes(), notes: {} })).not.toContain("locality note");
  });

  it("reads a file written before notes were in it", () => {
    const older = { ...withNotes(), notes: undefined };
    const read = readEditsBackup(JSON.stringify(older), "6CX6F");
    if (!("backup" in read)) throw new Error("expected a backup");
    expect(read.backup.notes).toEqual({});
  });
});
