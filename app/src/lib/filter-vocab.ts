/**
 * The IUCN threat classification and how a threat code reads as a label.
 *
 * Once also the plain-English filter vocabulary for /browse, llms.txt and the
 * MCP server ("endangered", "birds", "Brazil" resolving to codes); those were
 * removed, and the threat labels are what the nearby-species panel still uses.
 */

// ─── Threats (IUCN threat classification) ────────────────────────────────

/** IUCN threat classification hierarchy (moved from RedListView). */
export const THREAT_CATEGORIES: { code: string; label: string; children: { code: string; label: string }[] }[] = [
  { code: "1", label: "Development", children: [
    { code: "1.1", label: "Housing & urban areas" }, { code: "1.2", label: "Commercial & industrial areas" }, { code: "1.3", label: "Tourism & recreation areas" },
  ]},
  { code: "2", label: "Agriculture", children: [
    { code: "2.1", label: "Crops" }, { code: "2.2", label: "Wood & pulp plantations" }, { code: "2.3", label: "Livestock farming & ranching" }, { code: "2.4", label: "Aquaculture" },
  ]},
  { code: "3", label: "Energy & Mining", children: [
    { code: "3.1", label: "Oil & gas drilling" }, { code: "3.2", label: "Mining & quarrying" }, { code: "3.3", label: "Renewable energy" },
  ]},
  { code: "4", label: "Transport", children: [
    { code: "4.1", label: "Roads & railroads" }, { code: "4.2", label: "Utility & service lines" }, { code: "4.3", label: "Shipping lanes" }, { code: "4.4", label: "Flight paths" },
  ]},
  { code: "5", label: "Harvesting", children: [
    { code: "5.1", label: "Hunting & trapping" }, { code: "5.2", label: "Gathering plants" }, { code: "5.3", label: "Logging & wood harvesting" }, { code: "5.4", label: "Fishing & harvesting" },
  ]},
  { code: "6", label: "Disturbance", children: [
    { code: "6.1", label: "Recreational activities" }, { code: "6.2", label: "War & military" }, { code: "6.3", label: "Work & other activities" },
  ]},
  { code: "7", label: "System modifications", children: [
    { code: "7.1", label: "Fire & fire suppression" }, { code: "7.2", label: "Dams & water management" }, { code: "7.3", label: "Other modifications" },
  ]},
  { code: "8", label: "Invasive species", children: [
    { code: "8.1", label: "Invasive non-native species" }, { code: "8.2", label: "Problematic native species" }, { code: "8.3", label: "Introduced genetic material" }, { code: "8.4", label: "Unknown origin species" }, { code: "8.5", label: "Viral/prion diseases" }, { code: "8.6", label: "Diseases of unknown cause" },
  ]},
  { code: "9", label: "Pollution", children: [
    { code: "9.1", label: "Domestic & urban waste water" }, { code: "9.2", label: "Industrial & military effluents" }, { code: "9.3", label: "Agricultural & forestry effluents" },
    { code: "9.4", label: "Garbage & solid waste" }, { code: "9.5", label: "Air-borne pollutants" }, { code: "9.6", label: "Excess energy (light, thermal, noise)" },
  ]},
  { code: "10", label: "Geological events", children: [
    { code: "10.1", label: "Volcanoes" }, { code: "10.2", label: "Earthquakes/tsunamis" }, { code: "10.3", label: "Avalanches/landslides" },
  ]},
  { code: "11", label: "Climate change", children: [
    { code: "11.1", label: "Habitat shifting & alteration" }, { code: "11.2", label: "Droughts" }, { code: "11.3", label: "Temperature extremes" }, { code: "11.4", label: "Storms & flooding" }, { code: "11.5", label: "Other impacts" },
  ]},
  { code: "12", label: "Other", children: [
    { code: "12.1", label: "Other threat" },
  ]},
];

/** code → label, including sub-codes. */
export const THREAT_LABEL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const c of THREAT_CATEGORIES) {
    m[c.code] = c.label;
    for (const sub of c.children) m[sub.code] = sub.label;
  }
  return m;
})();

/** Human label for a threat code, walking up to the nearest known parent for
 *  deep sub-codes (e.g. "5.4.1" → "Fishing & harvesting"). Never returns a bare
 *  number when a labelled ancestor exists. */
// Render a threat code with its top-level category for context, e.g.
// "11.4" → "Climate change (Storms & flooding)", "5.4.1" → "Harvesting (Fishing &
// harvesting)", "11" → "Climate change". Without the parent, a leaf like "Droughts"
// loses which of the 12 IUCN threat categories it belongs to.
export function threatDisplay(code: string): string {
  const top = THREAT_LABEL[code.split(".")[0]];
  // Most specific known label: exact, else the nearest known ancestor.
  let specific = THREAT_LABEL[code];
  if (!specific) {
    const parts = code.split(".");
    while (parts.length > 1 && !specific) {
      parts.pop();
      specific = THREAT_LABEL[parts.join(".")];
    }
  }
  if (top && specific && specific !== top) return `${top} (${specific})`;
  return top ?? specific ?? code;
}
