export type Brand = {
  title: string;
  /** Tagline shown beneath the title; omitted brands render no subtitle. */
  subtitle?: string;
  description: string;
  /** Browser-tab title; falls back to `title` when omitted. */
  tabTitle?: string;
  /** Show the globe icon before the title. */
  showGlobe?: boolean;
};

// The one brand. dashforlife.org is the only domain the app is served on:
// every other host redirects there (see redirects() in next.config.ts), so
// there is no longer a per-host brand to choose.
export const BRAND: Brand = {
  title: "Dash for Life",
  subtitle: "A Dashboard for Conservation of Threatened Species",
  tabTitle: "Dash for Life",
  description: "A dashboard for biodiversity data about life on Earth",
  showGlobe: true,
};
