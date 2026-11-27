"use client";

import { createContext, useContext } from "react";
import type { Brand } from "../config/brand";

const BrandContext = createContext<Brand>({
  title: "Dash of Life",
  subtitle: "A Dashboard for Conservation of Threatened Species",
  description: "A dashboard for conservation of threatened species",
  showGlobe: true,
});

export function BrandProvider({
  brand,
  children,
}: {
  brand: Brand;
  children: React.ReactNode;
}) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}
