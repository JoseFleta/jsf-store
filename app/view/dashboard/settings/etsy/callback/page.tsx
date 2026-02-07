"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../../../../../lib/supabaseBrowser";

const ETSY_OAUTH_STATE_KEY = "etsy_oauth_state";
const ETSY_OAUTH_STORE_ID_KEY = "etsy_oauth_store_id";
const ETSY_OAUTH_CODE_VERIFIER_KEY = "etsy_oauth_code_verifier";
const ETSY_OAUTH_REDIRECT_URI_KEY = "etsy_oauth_redirect_uri";
const ETSY_OAUTH_DONE_KEY = "etsy_oauth_done";

export default function EtsyOAuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [msg, setMsg] = useState("Connecting Etsy...");

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const error = searchParams.get("error");
      const errorDescription = searchParams.get("error_description");
      if (error) {
        if (!cancelled) setMsg(`Etsy authorization failed: ${errorDescription || error}`);
        return;
      }

      const code = searchParams.get("code") || "";
      const state = searchParams.get("state") || "";
      const savedState = window.localStorage.getItem(ETSY_OAUTH_STATE_KEY) || "";
      const savedStoreId = window.localStorage.getItem(ETSY_OAUTH_STORE_ID_KEY) || "";
      const savedVerifier = window.localStorage.getItem(ETSY_OAUTH_CODE_VERIFIER_KEY) || "";
      const savedRedirectUri = window.localStorage.getItem(ETSY_OAUTH_REDIRECT_URI_KEY) || "";

      if (!code || !state) {
        if (!cancelled) setMsg("Missing OAuth response parameters.");
        return;
      }
      if (!savedStoreId || !savedVerifier || !savedRedirectUri) {
        if (!cancelled) setMsg("Missing local OAuth context. Please start Connect Etsy again.");
        return;
      }
      if (state !== savedState) {
        if (!cancelled) setMsg("Invalid OAuth state. Please start Connect Etsy again.");
        return;
      }

      const { data: sessionRes } = await supabase.auth.getSession();
      const accessToken = sessionRes.session?.access_token;
      if (!accessToken) {
        if (!cancelled) setMsg("Session expired. Please sign in again.");
        return;
      }

      const res = await fetch("/api/integrations/etsy/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          storeId: savedStoreId,
          code,
          codeVerifier: savedVerifier,
          redirectUri: savedRedirectUri,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };

      window.localStorage.removeItem(ETSY_OAUTH_STATE_KEY);
      window.localStorage.removeItem(ETSY_OAUTH_STORE_ID_KEY);
      window.localStorage.removeItem(ETSY_OAUTH_CODE_VERIFIER_KEY);
      window.localStorage.removeItem(ETSY_OAUTH_REDIRECT_URI_KEY);

      if (!res.ok) {
        if (!cancelled) setMsg(payload.error || "Failed to connect Etsy.");
        return;
      }

      if (!cancelled) {
        window.localStorage.setItem(
          ETSY_OAUTH_DONE_KEY,
          JSON.stringify({ storeId: savedStoreId, ts: Date.now() }),
        );
        setMsg("Etsy connected. You can close this tab.");
        setTimeout(() => {
          window.close();
          router.replace(`/view/dashboard/settings?store=${encodeURIComponent(savedStoreId)}`);
        }, 900);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams, supabase]);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold text-slate-900">Etsy OAuth Callback</h1>
      <p className="mt-2 text-sm text-slate-600">{msg}</p>
    </section>
  );
}
