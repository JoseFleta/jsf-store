"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const WOO_OAUTH_DONE_KEY = "woo_oauth_done";

export default function WooOAuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [msg, setMsg] = useState("Processing WooCommerce connection...");

  useEffect(() => {
    const success = searchParams.get("success");
    const storeId = searchParams.get("store") || "";

    if (success !== "1") {
      setMsg("WooCommerce authorization failed or was cancelled.");
      return;
    }

    if (!storeId) {
      setMsg("Missing store context.");
      return;
    }

    localStorage.setItem(WOO_OAUTH_DONE_KEY, JSON.stringify({ storeId, ts: Date.now() }));
    setMsg("WooCommerce connected. You can close this tab.");

    setTimeout(() => {
      window.close();
      router.replace(`/view/dashboard/settings?store=${encodeURIComponent(storeId)}`);
    }, 900);
  }, [router, searchParams]);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold text-slate-900">WooCommerce OAuth Callback</h1>
      <p className="mt-2 text-sm text-slate-600">{msg}</p>
    </section>
  );
}
