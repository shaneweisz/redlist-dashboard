/**
 * What to call a `taxa=` URL token on screen.
 *
 * A token is written for a URL, not for a reader: `flowering_plants~dioscoreales
 * ~dioscoreaceae` is a filter, "Dioscoreaceae" is what it means. Any page that
 * shows a taxon filter it was handed (rather than one the reader just picked
 * from a list of names) needs the second — see the narrative search's group
 * selector, which has to label whatever token the dashboard sent it.
 */
// taxonomy-utils before dynamic-taxon — see taxa-scope-sql.ts for why the order
// of these two imports matters.
import { findNode, expandTaxaToken } from "@/lib/taxonomy-utils";
import { isDynamicNodeId, dynamicNodeDisplayName } from "@/lib/dynamic-taxon";

export function taxaTokenLabel(token: string): string {
  const raw = token.trim();
  if (!raw) return "";
  const { taxa, subgroup } = expandTaxaToken(raw);
  const id = subgroup ?? taxa;
  const node = findNode(id);
  if (node) return node.name;
  // A live-drilldown node is named by its own deepest rank — the same leaf the
  // dashboard's breadcrumb shows, with the common name in brackets when CoL
  // knows one (on the server; the browser only has the curated overrides).
  if (isDynamicNodeId(id)) return dynamicNodeDisplayName(id);
  // An arbitrary rank nobody put in the tree (a genus, say): the token itself is
  // the scientific name, so capitalize it rather than invent anything.
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
