import { Suspense } from "react";
import MarketplacePageClient from "./MarketplacePageClient";

export const dynamic = "force-dynamic";

export default function MarketplacePage() {
  return (
    <Suspense fallback={<section className="p-6 text-sm text-slate-500">Loading marketplace...</section>}>
      <MarketplacePageClient />
    </Suspense>
  );
}