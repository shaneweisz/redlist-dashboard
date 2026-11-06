// ISO 3166-1 alpha-2 country code mappings.
// Extracted from WorldMap.tsx so other code can import these maps without
// pulling in the client-only map rendering deps.

// Country name (from TopoJSON) to ISO 3166-1 alpha-2 mapping for GBIF
export const NAME_TO_ALPHA2: Record<string, string> = {
  "Afghanistan": "AF", "Albania": "AL", "Algeria": "DZ", "Angola": "AO", "Argentina": "AR",
  "Armenia": "AM", "Australia": "AU", "Austria": "AT", "Azerbaijan": "AZ", "Bangladesh": "BD",
  "Belarus": "BY", "Belgium": "BE", "Benin": "BJ", "Bhutan": "BT", "Bolivia": "BO",
  "Bosnia and Herz.": "BA", "Botswana": "BW", "Brazil": "BR", "Brunei": "BN", "Bulgaria": "BG",
  "Burkina Faso": "BF", "Burundi": "BI", "Cambodia": "KH", "Cameroon": "CM", "Canada": "CA",
  "Central African Rep.": "CF", "Chad": "TD", "Chile": "CL", "China": "CN", "Colombia": "CO",
  "Congo": "CG", "Dem. Rep. Congo": "CD", "Costa Rica": "CR", "Côte d'Ivoire": "CI",
  "Croatia": "HR", "Cuba": "CU", "Cyprus": "CY", "Czechia": "CZ", "Denmark": "DK",
  "Djibouti": "DJ", "Dominican Rep.": "DO", "Ecuador": "EC", "Egypt": "EG", "El Salvador": "SV",
  "Eq. Guinea": "GQ", "Eritrea": "ER", "Estonia": "EE", "eSwatini": "SZ", "Ethiopia": "ET",
  "Fiji": "FJ", "Finland": "FI", "France": "FR", "Gabon": "GA", "Gambia": "GM", "Georgia": "GE",
  "Germany": "DE", "Ghana": "GH", "Greece": "GR", "Greenland": "GL", "Guatemala": "GT",
  "Guinea": "GN", "Guinea-Bissau": "GW", "Guyana": "GY", "Haiti": "HT", "Honduras": "HN",
  "Hungary": "HU", "Iceland": "IS", "India": "IN", "Indonesia": "ID", "Iran": "IR", "Iraq": "IQ",
  "Ireland": "IE", "Israel": "IL", "Italy": "IT", "Jamaica": "JM", "Japan": "JP", "Jordan": "JO",
  "Kazakhstan": "KZ", "Kenya": "KE", "North Korea": "KP", "South Korea": "KR", "Kuwait": "KW",
  "Kyrgyzstan": "KG", "Laos": "LA", "Latvia": "LV", "Lebanon": "LB", "Lesotho": "LS",
  "Liberia": "LR", "Libya": "LY", "Lithuania": "LT", "Luxembourg": "LU", "Madagascar": "MG",
  "Malawi": "MW", "Malaysia": "MY", "Mali": "ML", "Mauritania": "MR", "Mexico": "MX",
  "Moldova": "MD", "Mongolia": "MN", "Montenegro": "ME", "Morocco": "MA", "Mozambique": "MZ",
  "Myanmar": "MM", "Namibia": "NA", "Nepal": "NP", "Netherlands": "NL", "New Zealand": "NZ",
  "Nicaragua": "NI", "Niger": "NE", "Nigeria": "NG", "Norway": "NO", "Oman": "OM",
  "Pakistan": "PK", "Panama": "PA", "Papua New Guinea": "PG", "Paraguay": "PY", "Peru": "PE",
  "Philippines": "PH", "Poland": "PL", "Portugal": "PT", "Puerto Rico": "PR", "Qatar": "QA",
  "Romania": "RO", "Russia": "RU", "Rwanda": "RW", "Saudi Arabia": "SA", "Senegal": "SN",
  "Serbia": "RS", "Sierra Leone": "SL", "Singapore": "SG", "Slovakia": "SK", "Slovenia": "SI",
  "Solomon Is.": "SB", "Somalia": "SO", "South Africa": "ZA", "S. Sudan": "SS", "Spain": "ES",
  "Sri Lanka": "LK", "Sudan": "SD", "Suriname": "SR", "Sweden": "SE", "Switzerland": "CH",
  "Syria": "SY", "Taiwan": "TW", "Tajikistan": "TJ", "Tanzania": "TZ", "Thailand": "TH",
  "Timor-Leste": "TL", "Togo": "TG", "Trinidad and Tobago": "TT", "Tunisia": "TN",
  "Turkey": "TR", "Turkmenistan": "TM", "Uganda": "UG", "Ukraine": "UA",
  "United Arab Emirates": "AE", "United Kingdom": "GB", "United States of America": "US",
  "Uruguay": "UY", "Uzbekistan": "UZ", "Vanuatu": "VU", "Venezuela": "VE", "Vietnam": "VN",
  "Yemen": "YE", "Zambia": "ZM", "Zimbabwe": "ZW", "Palestine": "PS",
  "Macedonia": "MK", "New Caledonia": "NC", "W. Sahara": "EH", "Fr. S. Antarctic Lands": "TF",
  "Falkland Is.": "FK",
  // Small/micro nations not in the 50m TopoJSON at all — kept spelled out since
  // there's no shape to match against; only useful for search.
  "Andorra": "AD", "Bahamas": "BS", "Bahrain": "BH", "Barbados": "BB",
  "Belize": "BZ", "Comoros": "KM", "Dominica": "DM", "Grenada": "GD",
  "Kiribati": "KI", "Liechtenstein": "LI", "Maldives": "MV", "Malta": "MT",
  "Mauritius": "MU", "Micronesia": "FM", "Monaco": "MC", "Nauru": "NR", "Palau": "PW",
  "Samoa": "WS", "San Marino": "SM", "Seychelles": "SC", "Saint Lucia": "LC",
  "Tonga": "TO", "Tuvalu": "TV",
  // These ARE present in the 50m TopoJSON, just under an abbreviated/different
  // name than the long form above — keyed here by the exact shape name so the
  // map coloring lookup (NAME_TO_ALPHA2[geo.properties.name]) actually matches.
  // (Long display names still shown elsewhere via ALPHA2_TO_NAME's own overrides below.)
  "Antigua and Barb.": "AG", "Cabo Verde": "CV", "São Tomé and Principe": "ST",
  "St. Kitts and Nevis": "KN", "St. Vin. and Gren.": "VC", "Vatican": "VA",
  "Marshall Is.": "MH",
  // Additional territories present as their own shape in the 50m TopoJSON that
  // had no entry at all before (always rendered as "No data" regardless of the
  // underlying Red List data).
  "American Samoa": "AS", "Anguilla": "AI", "Aruba": "AW", "Bermuda": "BM",
  "Br. Indian Ocean Ter.": "IO", "British Virgin Is.": "VG", "Cayman Is.": "KY",
  "Cook Is.": "CK", "Curaçao": "CW", "Faeroe Is.": "FO", "Fr. Polynesia": "PF",
  "Guam": "GU", "Guernsey": "GG", "Heard I. and McDonald Is.": "HM", "Hong Kong": "HK",
  "Isle of Man": "IM", "Jersey": "JE", "Macao": "MO", "Montserrat": "MS",
  "N. Mariana Is.": "MP", "Niue": "NU", "Norfolk Island": "NF", "Pitcairn Is.": "PN",
  "S. Geo. and the Is.": "GS", "Saint Helena": "SH", "Sint Maarten": "SX",
  "St-Barthélemy": "BL", "St-Martin": "MF", "St. Pierre and Miquelon": "PM",
  "Turks and Caicos Is.": "TC", "U.S. Virgin Is.": "VI", "Wallis and Futuna Is.": "WF",
  "Åland": "AX",
  // Overseas territories the 50m TopoJSON draws *inside* another country's
  // shape rather than as their own (French Guiana inside France, and so on).
  // splitEmbeddedTerritories in map-territories.ts cuts each out into a
  // feature labelled with the name below, so these entries are what let the
  // map resolve it — see that module for why the split is needed at all.
  "French Guiana": "GF", "Guadeloupe": "GP", "Martinique": "MQ",
  "Réunion": "RE", "Mayotte": "YT", "Bonaire, Sint Eustatius and Saba": "BQ",
  "Svalbard and Jan Mayen": "SJ", "Tokelau": "TK",
  "Christmas Island": "CX", "Cocos (Keeling) Islands": "CC",
  // Ashmore and Cartier has no ISO alpha-2 of its own — ISO files the reefs
  // under Australia, so IUCN records anything found there as AU. Mapping the
  // shape keeps it coloured with Australia instead of reading as a data gap.
  // ("Siachen Glacier", the only other unmapped shape, stays unmapped: Natural
  // Earth deliberately attributes it to neither India nor Pakistan, and IUCN's
  // own location list has no code for it either, so neither do we.)
  "Ashmore and Cartier Is.": "AU",
  // Somaliland, N. Cyprus, and Kosovo are drawn as their own shape in the
  // TopoJSON, but IUCN's public presentation doesn't treat any of them as a
  // distinct country — fold each into its parent rather than leaving a
  // "no data" gap that reads as a bug.
  //
  // Somaliland/N. Cyprus: IUCN's own Red List country standard (ISO 3166-1 +
  // UN country names, per redlist.org/resources/country-codes) has no
  // distinct code for either — both fold into Somalia/Cyprus, the same way
  // IUCN's own species assessments do (e.g. the Gerenuk assessment's formal
  // country field lists "Somalia", even though its range-description text
  // separately mentions "Somaliland").
  //
  // Kosovo: unlike those two, IUCN's internal SIS database *does* carry a
  // distinct location code (YUG-KO, a legacy former-Yugoslavia sub-code, not
  // a modern ISO alpha-2) — which looked at first like grounds to treat it
  // as its own country. But checking IUCN's own public page for a
  // Kosovo-tagged species (Terranigra kosovica, iucnredlist.org/species/
  // 155681/222427224) shows the official "Geographic Range" field lists only
  // "Serbia" — Kosovo appears solely in the free-text range description,
  // exactly how other legacy sub-codes (RU-EU "European Russia", FRA-FR
  // "France (mainland)") behave: real in the internal data model, but never
  // surfaced as their own entry in IUCN's own public country-of-occurrence
  // presentation. So it gets the same treatment as Somaliland/N. Cyprus, not
  // the Palestine/Taiwan/W. Sahara treatment (which do have their own
  // "Geographic Range" line).
  "Somaliland": "SO", "N. Cyprus": "CY", "Kosovo": "RS",
};

// Complete ISO 3166-1 alpha-2 to country name mapping (for display)
// Includes all countries, territories, and small island nations
export const ALPHA2_TO_NAME: Record<string, string> = {
  // From TopoJSON (use these names for map consistency)
  ...Object.fromEntries(Object.entries(NAME_TO_ALPHA2).map(([name, code]) => [code, name])),
  // Additional countries and territories not in TopoJSON
  "AD": "Andorra", "AG": "Antigua and Barbuda", "AI": "Anguilla", "AQ": "Antarctica",
  "AS": "American Samoa", "AW": "Aruba", "AX": "Åland Islands", "BB": "Barbados",
  "BH": "Bahrain", "BL": "Saint Barthélemy", "BM": "Bermuda", "BQ": "Bonaire, Sint Eustatius and Saba",
  "BS": "Bahamas", "BV": "Bouvet Island", "BZ": "Belize", "CC": "Cocos (Keeling) Islands",
  "CK": "Cook Islands", "CV": "Cape Verde", "CW": "Curaçao", "CX": "Christmas Island",
  "DM": "Dominica", "FK": "Falkland Islands", "FM": "Micronesia", "FO": "Faroe Islands",
  "GD": "Grenada", "GF": "French Guiana", "GG": "Guernsey", "GI": "Gibraltar",
  "GP": "Guadeloupe", "GS": "South Georgia", "GU": "Guam", "HK": "Hong Kong Special Administrative Region of China",
  "HM": "Heard Island", "IM": "Isle of Man", "IO": "British Indian Ocean Territory",
  "JE": "Jersey", "KI": "Kiribati", "KM": "Comoros", "KN": "Saint Kitts and Nevis",
  "KY": "Cayman Islands", "LC": "Saint Lucia", "LI": "Liechtenstein", "MC": "Monaco",
  "MF": "Saint Martin", "MH": "Marshall Islands", "MK": "North Macedonia", "MO": "Macao Special Administrative Region of China", "MP": "Northern Mariana Islands",
  "MQ": "Martinique", "MS": "Montserrat", "MT": "Malta", "MU": "Mauritius", "MV": "Maldives",
  "NF": "Norfolk Island", "NR": "Naoero", "NU": "Niue", "PF": "French Polynesia",
  "PM": "Saint Pierre and Miquelon", "PN": "Pitcairn", "PW": "Palau", "RE": "Réunion",
  "SC": "Seychelles", "SH": "Saint Helena", "SJ": "Svalbard and Jan Mayen", "SM": "San Marino",
  // Overrides for names the spread above would otherwise win with: each of
  // these codes is also keyed by a shape that folds into it ("Somaliland",
  // "N. Cyprus", "Kosovo", "Ashmore and Cartier Is."), and the spread takes
  // the LAST key that maps to a code.
  "SO": "Somalia", "CY": "Cyprus", "RS": "Serbia", "AU": "Australia",
  // Current official names, where the shape still carries the older one
  // ("Turkey"). The shape names stay as keys above, so the old spellings
  // still resolve and still find the country in search.
  "TR": "Türkiye",
  // The shapes carry abbreviated labels ("Dem. Rep. Congo", "Solomon Is."),
  // and this table is what the list view, tooltip and filter chips show — so
  // spell them out. Names follow IUCN's own location_lookup, except that CD
  // keeps this table's natural word order rather than ISO's inverted
  // "Congo, The Democratic Republic of the".
  "BA": "Bosnia and Herzegovina", "CD": "Democratic Republic of the Congo",
  "CF": "Central African Republic", "DO": "Dominican Republic",
  "EH": "Western Sahara", "GQ": "Equatorial Guinea", "SB": "Solomon Islands",
  "SS": "South Sudan", "TF": "French Southern Territories",
  // Not an ISO code at all: IUCN's own location code for range that falls in
  // disputed territory, recorded alongside real countries (a South China Sea
  // coral lists DT next to CN, TW, VN and PH). 1,808 assessed species carry
  // it, so it needs a label rather than showing as a bare "DT" row — but it
  // has no shape on the map, and shouldn't have one.
  "DT": "Disputed Territory",
  "ST": "São Tomé and Príncipe", "SV": "El Salvador", "SX": "Sint Maarten",
  "TC": "Turks and Caicos", "TK": "Tokelau", "TO": "Tonga", "TV": "Tuvalu",
  "UM": "U.S. Minor Outlying Islands", "VA": "Vatican City", "VC": "Saint Vincent and the Grenadines",
  "VG": "British Virgin Islands", "VI": "U.S. Virgin Islands", "WF": "Wallis and Futuna",
  "WS": "Samoa", "YT": "Mayotte",
};

// --- Resolution helpers -------------------------------------------------

// Informal / common aliases not present as canonical names above.
const ALIAS_TO_ALPHA2: Record<string, string> = {
  "usa": "US", "u.s.a.": "US", "us": "US", "united states": "US", "america": "US",
  "uk": "GB", "u.k.": "GB", "britain": "GB", "great britain": "GB", "england": "GB",
  "drc": "CD", "dr congo": "CD", "democratic republic of the congo": "CD",
  "czech republic": "CZ", "swaziland": "SZ", "ivory coast": "CI",
  "turkiye": "TR", "macau": "MO",
};

const NAME_LOOKUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [name, code] of Object.entries(NAME_TO_ALPHA2)) m[name.toLowerCase()] = code;
  for (const [code, name] of Object.entries(ALPHA2_TO_NAME)) m[name.toLowerCase()] = code;
  for (const [k, v] of Object.entries(ALIAS_TO_ALPHA2)) m[k] = v;
  return m;
})();

/** Resolve a country code or human-readable name to an ISO alpha-2 code, or null. */
export function resolveCountryToAlpha2(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && ALPHA2_TO_NAME[upper]) return upper;
  return NAME_LOOKUP[v.toLowerCase()] ?? null;
}
