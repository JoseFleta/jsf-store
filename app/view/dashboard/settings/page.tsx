"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type Marketplace = "woocommerce" | "etsy" | "amazon";

type IntegrationConfig = {
  enabledMarketplaces: Marketplace[];
  wooUrl: string;
  wooKey: string;
  wooSecret: string;
  etsyBearer: string;
  etsyRefreshToken: string;
  etsyTokenExpiresAt: string;
  etsyKeystring: string;
  etsyShopName: string;
  etsySkumapJson: string;
  amazonSellerId: string;
  amazonAccessKey: string;
  amazonSecretKey: string;
  amazonRegion: string;
  updatedAt: string | null;
};

type ManualMarketplaceDraft = {
  wooUrl: string;
  wooKey: string;
  wooSecret: string;
  etsyKeystring: string;
  etsyBearer: string;
  etsyRefreshToken: string;
  etsyShopName: string;
  amazonSellerId: string;
  amazonAccessKey: string;
  amazonSecretKey: string;
  amazonRegion: string;
};

const EMPTY_CONFIG: IntegrationConfig = {
  enabledMarketplaces: [],
  wooUrl: "",
  wooKey: "",
  wooSecret: "",
  etsyBearer: "",
  etsyRefreshToken: "",
  etsyTokenExpiresAt: "",
  etsyKeystring: "",
  etsyShopName: "",
  etsySkumapJson: "{}",
  amazonSellerId: "",
  amazonAccessKey: "",
  amazonSecretKey: "",
  amazonRegion: "",
  updatedAt: null,
};

const EMPTY_MANUAL_DRAFT: ManualMarketplaceDraft = {
  wooUrl: "",
  wooKey: "",
  wooSecret: "",
  etsyKeystring: "",
  etsyBearer: "",
  etsyRefreshToken: "",
  etsyShopName: "",
  amazonSellerId: "",
  amazonAccessKey: "",
  amazonSecretKey: "",
  amazonRegion: "",
};

const ETSY_OAUTH_STATE_KEY = "etsy_oauth_state";
const ETSY_OAUTH_STORE_ID_KEY = "etsy_oauth_store_id";
const ETSY_OAUTH_CODE_VERIFIER_KEY = "etsy_oauth_code_verifier";
const ETSY_OAUTH_REDIRECT_URI_KEY = "etsy_oauth_redirect_uri";
const ETSY_OAUTH_DONE_KEY = "etsy_oauth_done";
const WOO_OAUTH_DONE_KEY = "woo_oauth_done";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(length = 64): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let output = "";
  for (let i = 0; i < bytes.length; i += 1) {
    output += alphabet[bytes[i] % alphabet.length];
  }
  return output;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
}

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [selectedStoreId, setSelectedStoreId] = useState(searchParams.get("store") || "");
  const [config, setConfig] = useState<IntegrationConfig>(EMPTY_CONFIG);
  const [savedConfig, setSavedConfig] = useState<IntegrationConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingSkuMap, setSyncingSkuMap] = useState(false);
  const [isEditing, setIsEditing] = useState(true);
  const [isAddMarketplaceModalOpen, setIsAddMarketplaceModalOpen] = useState(false);
  const [marketplaceToAdd, setMarketplaceToAdd] = useState<Marketplace>("woocommerce");
  const [marketplaceAddMode, setMarketplaceAddMode] = useState<"manual" | "connect">("manual");
  const [manualDraft, setManualDraft] = useState<ManualMarketplaceDraft>(EMPTY_MANUAL_DRAFT);
  const [msg, setMsg] = useState("");
  const [reloadConfigTick, setReloadConfigTick] = useState(0);

  useEffect(() => {
    setSelectedStoreId(searchParams.get("store") || "");
  }, [searchParams]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.newValue) return;
      try {
        const payload = JSON.parse(event.newValue) as { storeId?: string; ts?: number };
        const isEtsyDone = event.key === ETSY_OAUTH_DONE_KEY;
        const isWooDone = event.key === WOO_OAUTH_DONE_KEY;
        if ((isEtsyDone || isWooDone) && payload.storeId && payload.storeId === selectedStoreId) {
          if (isEtsyDone) setMsg("Etsy connected successfully.");
          if (isWooDone) setMsg("WooCommerce connected successfully.");
          setReloadConfigTick((prev) => prev + 1);
        }
      } catch {
        // Ignore malformed events.
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [selectedStoreId]);

  useEffect(() => {
    let cancelled = false;
    const checkAuth = async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!userRes.user) router.push("/view/login");
    };
    checkAuth();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      if (!selectedStoreId) {
        setConfig(EMPTY_CONFIG);
        setSavedConfig(EMPTY_CONFIG);
        setIsEditing(true);
        setLoading(false);
        return;
      }

      setLoading(true);
      setMsg("");
      const { data: sessionRes } = await supabase.auth.getSession();
      const accessToken = sessionRes.session?.access_token;
      if (!accessToken) {
        if (!cancelled) {
          setLoading(false);
          setMsg("Session expired. Please sign in again.");
        }
        return;
      }

      const res = await fetch(`/api/integrations/config?storeId=${encodeURIComponent(selectedStoreId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; config?: IntegrationConfig };

      if (cancelled) return;
      if (!res.ok) {
        setMsg(payload.error || "Failed to load settings.");
        setLoading(false);
        return;
      }

      const nextConfig = payload.config || EMPTY_CONFIG;
      const normalizedEnabled = new Set<Marketplace>((nextConfig.enabledMarketplaces || []) as Marketplace[]);
      if (nextConfig.wooUrl || nextConfig.wooKey || nextConfig.wooSecret) normalizedEnabled.add("woocommerce");
      if (nextConfig.etsyKeystring || nextConfig.etsyBearer || nextConfig.etsyRefreshToken) normalizedEnabled.add("etsy");
      if (nextConfig.amazonSellerId || nextConfig.amazonAccessKey || nextConfig.amazonSecretKey) normalizedEnabled.add("amazon");
      nextConfig.enabledMarketplaces = Array.from(normalizedEnabled);
      const hasPersistedValues =
        Boolean(nextConfig.updatedAt) ||
        (nextConfig.enabledMarketplaces || []).length > 0 ||
        Boolean(nextConfig.wooUrl) ||
        Boolean(nextConfig.wooKey) ||
        Boolean(nextConfig.wooSecret) ||
        Boolean(nextConfig.etsyBearer) ||
        Boolean(nextConfig.etsyRefreshToken) ||
        Boolean(nextConfig.etsyTokenExpiresAt) ||
        Boolean(nextConfig.etsyKeystring) ||
        Boolean(nextConfig.etsyShopName) ||
        (nextConfig.etsySkumapJson || "").trim() !== "{}" ||
        Boolean(nextConfig.amazonSellerId) ||
        Boolean(nextConfig.amazonAccessKey) ||
        Boolean(nextConfig.amazonSecretKey) ||
        Boolean(nextConfig.amazonRegion);

      setConfig(nextConfig);
      setSavedConfig(nextConfig);
      setIsEditing(!hasPersistedValues);
      setLoading(false);
    };

    loadConfig();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, supabase, reloadConfigTick]);

  const updateField = <K extends keyof IntegrationConfig>(key: K, value: IntegrationConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const addMarketplace = (marketplace: Marketplace) => {
    setConfig((prev) => {
      if (prev.enabledMarketplaces.includes(marketplace)) return prev;
      return { ...prev, enabledMarketplaces: [...prev.enabledMarketplaces, marketplace] };
    });
  };

  const removeMarketplace = (marketplace: Marketplace) => {
    setConfig((prev) => ({
      ...prev,
      enabledMarketplaces: prev.enabledMarketplaces.filter((entry) => entry !== marketplace),
    }));
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedStoreId) {
      setMsg("Select a store first.");
      return;
    }
    if (!isEditing) return;

    try {
      JSON.parse(config.etsySkumapJson || "{}");
    } catch {
      setMsg("ETSY sku map JSON is invalid.");
      return;
    }

    setSaving(true);
    setMsg("");

    const { data: sessionRes } = await supabase.auth.getSession();
    const accessToken = sessionRes.session?.access_token;
    if (!accessToken) {
      setSaving(false);
      setMsg("Session expired. Please sign in again.");
      return;
    }

    const res = await fetch("/api/integrations/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        storeId: selectedStoreId,
        enabledMarketplaces: config.enabledMarketplaces,
        wooUrl: config.wooUrl,
        wooKey: config.wooKey,
        wooSecret: config.wooSecret,
        etsyBearer: config.etsyBearer,
        etsyRefreshToken: config.etsyRefreshToken,
        etsyTokenExpiresAt: config.etsyTokenExpiresAt,
        etsyKeystring: config.etsyKeystring,
        etsyShopName: config.etsyShopName,
        etsySkumapJson: config.etsySkumapJson,
        amazonSellerId: config.amazonSellerId,
        amazonAccessKey: config.amazonAccessKey,
        amazonSecretKey: config.amazonSecretKey,
        amazonRegion: config.amazonRegion,
      }),
    });

    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    setSaving(false);

    if (!res.ok) {
      setMsg(payload.error || "Failed to save settings.");
      return;
    }

    const nextSaved = { ...config, updatedAt: new Date().toISOString() };
    setConfig(nextSaved);
    setSavedConfig(nextSaved);
    setIsEditing(false);
    setMsg("Settings saved.");
  };

  const handleEdit = () => {
    setMsg("");
    setIsEditing(true);
  };

  const handleCancel = () => {
    setConfig(savedConfig);
    setMsg("");
    setIsEditing(false);
  };

  const isReadOnly = loading || !isEditing;
  const showDisplayMode = !loading && !isEditing;

  const handleConnectEtsy = async () => {
    if (!selectedStoreId) {
      setMsg("Select a store first.");
      return;
    }

    const clientId = (config.etsyKeystring || "").trim();
    if (!clientId) {
      setMsg("Set ETSY Keystring first, save settings, then click Connect Etsy.");
      return;
    }

    const redirectUri = `${window.location.origin}/view/dashboard/settings/etsy/callback`;
    const verifier = randomVerifier(96);
    const challenge = await pkceChallenge(verifier);
    const state = crypto.randomUUID();

    window.localStorage.setItem(ETSY_OAUTH_STATE_KEY, state);
    window.localStorage.setItem(ETSY_OAUTH_STORE_ID_KEY, selectedStoreId);
    window.localStorage.setItem(ETSY_OAUTH_CODE_VERIFIER_KEY, verifier);
    window.localStorage.setItem(ETSY_OAUTH_REDIRECT_URI_KEY, redirectUri);

    const scope = "shops_r shops_w listings_r listings_w transactions_r";
    const authorizeUrl = new URL("https://www.etsy.com/oauth/connect");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const popup = window.open(authorizeUrl.toString(), "_blank", "noopener,noreferrer");
    if (!popup) {
      setMsg("Popup blocked. Please allow popups for this site and try again.");
      return;
    }
    setMsg("Etsy auth opened in a new tab. Complete it and come back.");
  };

  const handleConnectWoo = async () => {
    if (!selectedStoreId) {
      setMsg("Select a store first.");
      return;
    }

    const wooUrl = (config.wooUrl || "").trim();
    if (!wooUrl) {
      setMsg("Set Woo URL first, save settings, then click Connect WooCommerce.");
      return;
    }

    const { data: sessionRes } = await supabase.auth.getSession();
    const accessToken = sessionRes.session?.access_token;
    if (!accessToken) {
      setMsg("Session expired. Please sign in again.");
      return;
    }

    const res = await fetch("/api/integrations/woo/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ storeId: selectedStoreId, wooUrl }),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string; authorizeUrl?: string };
    if (!res.ok || !payload.authorizeUrl) {
      setMsg(payload.error || "Failed to start WooCommerce connection.");
      return;
    }

    const popup = window.open(payload.authorizeUrl, "_blank", "noopener,noreferrer");
    if (!popup) {
      setMsg("Popup blocked. Please allow popups for this site and try again.");
      return;
    }

    setMsg("WooCommerce auth opened in a new tab. Complete it and come back.");
  };

  const handleAutoFillEtsySkuMap = async () => {
    if (!selectedStoreId) {
      setMsg("Select a store first.");
      return;
    }

    const { data: sessionRes } = await supabase.auth.getSession();
    const accessToken = sessionRes.session?.access_token;
    if (!accessToken) {
      setMsg("Session expired. Please sign in again.");
      return;
    }

    setSyncingSkuMap(true);
    setMsg("Fetching Etsy listings and SKU map...");

    const res = await fetch("/api/integrations/etsy/sync-skumap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ storeId: selectedStoreId }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      listingCount?: number;
      discoveredSkuCount?: number;
      errorCount?: number;
      errors?: string[];
    };

    setSyncingSkuMap(false);
    if (!res.ok) {
      setMsg(payload.error || "Failed to auto-fill Etsy SKU map.");
      return;
    }

    setReloadConfigTick((prev) => prev + 1);
    setMsg(
      `Etsy SKU map updated. Listings scanned: ${payload.listingCount || 0}. SKUs discovered: ${payload.discoveredSkuCount || 0}.` +
        ((payload.errorCount || 0) > 0 ? ` Some listings failed: ${payload.errors?.[0] || ""}` : ""),
    );
  };

  const isWooConnected = Boolean(config.wooKey && config.wooSecret);
  const isEtsyConnected = Boolean(config.etsyBearer && config.etsyRefreshToken);

  useEffect(() => {
    if (!isAddMarketplaceModalOpen) return;
    setManualDraft({
      wooUrl: config.wooUrl || "",
      wooKey: config.wooKey || "",
      wooSecret: config.wooSecret || "",
      etsyKeystring: config.etsyKeystring || "",
      etsyBearer: config.etsyBearer || "",
      etsyRefreshToken: config.etsyRefreshToken || "",
      etsyShopName: config.etsyShopName || "",
      amazonSellerId: config.amazonSellerId || "",
      amazonAccessKey: config.amazonAccessKey || "",
      amazonSecretKey: config.amazonSecretKey || "",
      amazonRegion: config.amazonRegion || "",
    });
  }, [isAddMarketplaceModalOpen, marketplaceToAdd, config]);

  const updateManualDraft = <K extends keyof ManualMarketplaceDraft>(key: K, value: ManualMarketplaceDraft[K]) => {
    setManualDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleOpenAddMarketplace = () => {
    if (loading) return;
    if (!isEditing) setIsEditing(true);
    setMarketplaceAddMode("manual");
    setIsAddMarketplaceModalOpen(true);
  };

  const handleConfirmAddMarketplace = async () => {
    if (!isEditing) {
      setMsg("Click Edit first to modify marketplaces.");
      return;
    }
    if (marketplaceAddMode === "manual") {
      setConfig((prev) => {
        const next = {
          ...prev,
          enabledMarketplaces: prev.enabledMarketplaces.includes(marketplaceToAdd)
            ? prev.enabledMarketplaces
            : [...prev.enabledMarketplaces, marketplaceToAdd],
        };

        if (marketplaceToAdd === "woocommerce") {
          next.wooUrl = manualDraft.wooUrl.trim();
          next.wooKey = manualDraft.wooKey.trim();
          next.wooSecret = manualDraft.wooSecret.trim();
        }
        if (marketplaceToAdd === "etsy") {
          next.etsyKeystring = manualDraft.etsyKeystring.trim();
          next.etsyBearer = manualDraft.etsyBearer.trim();
          next.etsyRefreshToken = manualDraft.etsyRefreshToken.trim();
          next.etsyShopName = manualDraft.etsyShopName.trim();
        }
        if (marketplaceToAdd === "amazon") {
          next.amazonSellerId = manualDraft.amazonSellerId.trim();
          next.amazonAccessKey = manualDraft.amazonAccessKey.trim();
          next.amazonSecretKey = manualDraft.amazonSecretKey.trim();
          next.amazonRegion = manualDraft.amazonRegion.trim();
        }
        return next;
      });
      setIsAddMarketplaceModalOpen(false);
      setMsg("Marketplace details added. Click Save settings to persist.");
      return;
    }

    if (marketplaceToAdd === "amazon") {
      setMsg("Amazon connect flow is coming soon. Use Manual setup for now.");
      return;
    }

    addMarketplace(marketplaceToAdd);
    setIsAddMarketplaceModalOpen(false);

    if (marketplaceToAdd === "etsy") {
      await handleConnectEtsy();
      return;
    }
    if (marketplaceToAdd === "woocommerce") {
      await handleConnectWoo();
      return;
    }
    setMsg("Marketplace added.");
  };

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Configure marketplace credentials per store. These values are used by Stock sync.
        </p>
      </header>

      <form className="space-y-6" onSubmit={handleSave}>
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-end gap-3">
            <button
              type="button"
              className="rounded-full border border-indigo-300 bg-indigo-50 px-5 py-2 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-100"
              onClick={handleOpenAddMarketplace}
            >
              Add marketplace
            </button>
            <p className="text-xs text-slate-500">
              Added: {config.enabledMarketplaces.length > 0 ? config.enabledMarketplaces.join(", ") : "none"}
            </p>
          </div>
        </article>

        {config.enabledMarketplaces.includes("woocommerce") && (
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">WooCommerce</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={
                  isWooConnected
                    ? "rounded-full border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700 disabled:opacity-60"
                    : "rounded-full border border-indigo-300 bg-white px-4 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-60"
                }
                onClick={handleConnectWoo}
                disabled={loading || !selectedStoreId}
              >
                {isWooConnected ? "Connected" : "Connect WooCommerce"}
              </button>
              <button
                type="button"
                className="rounded-full border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-60"
                onClick={() => removeMarketplace("woocommerce")}
                disabled={loading || !isEditing}
              >
                Remove
              </button>
            </div>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="text-sm font-medium text-slate-700">Woo URL</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {config.wooUrl || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.wooUrl}
                  onChange={(e) => updateField("wooUrl", e.target.value)}
                  placeholder="https://www.example.com"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Woo Key</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.wooKey || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.wooKey}
                  onChange={(e) => updateField("wooKey", e.target.value)}
                  placeholder="ck_..."
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Woo Secret</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.wooSecret || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.wooSecret}
                  onChange={(e) => updateField("wooSecret", e.target.value)}
                  placeholder="cs_..."
                  readOnly={isReadOnly}
                />
              )}
            </div>
          </div>
        </article>
        )}

        {config.enabledMarketplaces.includes("etsy") && (
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Etsy</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={
                  isEtsyConnected
                    ? "rounded-full border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700 disabled:opacity-60"
                    : "rounded-full border border-indigo-300 bg-white px-4 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-60"
                }
                onClick={handleConnectEtsy}
                disabled={loading || !selectedStoreId}
              >
                {isEtsyConnected ? "Connected" : "Connect Etsy"}
              </button>
              <button
                type="button"
                className="rounded-full border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-60"
                onClick={() => removeMarketplace("etsy")}
                disabled={loading || !isEditing}
              >
                Remove
              </button>
            </div>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-slate-700">ETSY Bearer</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.etsyBearer || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.etsyBearer}
                  onChange={(e) => updateField("etsyBearer", e.target.value)}
                  placeholder="Bearer token"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">ETSY Refresh Token</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.etsyRefreshToken || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.etsyRefreshToken}
                  onChange={(e) => updateField("etsyRefreshToken", e.target.value)}
                  placeholder="Refresh token"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">ETSY Keystring</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.etsyKeystring || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.etsyKeystring}
                  onChange={(e) => updateField("etsyKeystring", e.target.value)}
                  placeholder="App key"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div className="md:col-span-2">
              <label className="text-sm font-medium text-slate-700">ETSY Token Expires At (optional)</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {config.etsyTokenExpiresAt || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.etsyTokenExpiresAt}
                  onChange={(e) => updateField("etsyTokenExpiresAt", e.target.value)}
                  placeholder="ISO datetime (optional)"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div className="md:col-span-2">
              <label className="text-sm font-medium text-slate-700">ETSY Shop Name (optional)</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {config.etsyShopName || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.etsyShopName}
                  onChange={(e) => updateField("etsyShopName", e.target.value)}
                  placeholder="AnAviationStore"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div className="md:col-span-2">
              <label className="text-sm font-medium text-slate-700">ETSY SKU Map JSON</label>
              <div className="mt-2">
                <button
                  type="button"
                  className="rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 disabled:opacity-60"
                  onClick={handleAutoFillEtsySkuMap}
                  disabled={loading || syncingSkuMap || !selectedStoreId}
                >
                  {syncingSkuMap ? "Loading Etsy listings..." : "Auto-fill SKU map from Etsy"}
                </button>
              </div>
              {showDisplayMode ? (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono text-slate-700">
                  {config.etsySkumapJson || "{}"}
                </pre>
              ) : (
                <textarea
                  className="mt-2 min-h-44 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono"
                  value={config.etsySkumapJson}
                  onChange={(e) => updateField("etsySkumapJson", e.target.value)}
                  readOnly={isReadOnly}
                />
              )}
              <p className="mt-2 text-xs text-slate-500">
                Example: {"{"}"AAS-SKU-1":{"{"}"listing_id":"123","state":"active"{"}"}{"}"}
              </p>
            </div>
          </div>
        </article>
        )}

        {config.enabledMarketplaces.includes("amazon") && (
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Amazon</h2>
            <button
              type="button"
              className="rounded-full border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-60"
              onClick={() => removeMarketplace("amazon")}
              disabled={loading || !isEditing}
            >
              Remove
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">Manual credentials for now. OAuth connect can be added later.</p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-slate-700">Amazon Seller ID</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.amazonSellerId || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.amazonSellerId}
                  onChange={(e) => updateField("amazonSellerId", e.target.value)}
                  placeholder="Seller ID"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Amazon Region</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.amazonRegion || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.amazonRegion}
                  onChange={(e) => updateField("amazonRegion", e.target.value)}
                  placeholder="eu-west-1 / us-east-1"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Amazon Access Key</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.amazonAccessKey || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.amazonAccessKey}
                  onChange={(e) => updateField("amazonAccessKey", e.target.value)}
                  placeholder="Access key"
                  readOnly={isReadOnly}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Amazon Secret Key</label>
              {showDisplayMode ? (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 break-all">
                  {config.amazonSecretKey || "-"}
                </div>
              ) : (
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={config.amazonSecretKey}
                  onChange={(e) => updateField("amazonSecretKey", e.target.value)}
                  placeholder="Secret key"
                  readOnly={isReadOnly}
                />
              )}
            </div>
          </div>
        </article>
        )}

        <div className="flex items-center gap-3">
          {isEditing ? (
            <>
              <button
                type="submit"
                className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
                disabled={loading || saving || !selectedStoreId}
              >
                {saving ? "Saving..." : "Save settings"}
              </button>
              <button
                type="button"
                className="rounded-full border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
                onClick={handleCancel}
                disabled={loading || saving}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded-full border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
              onClick={handleEdit}
              disabled={loading || !selectedStoreId}
            >
              Edit
            </button>
          )}
          {loading && <span className="text-sm text-slate-500">Loading settings...</span>}
        </div>
      </form>

      {msg && <p className="text-sm text-slate-700">{msg}</p>}

      {isAddMarketplaceModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setIsAddMarketplaceModalOpen(false)}
        >
          <article
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-slate-900">Add New Marketplace</h2>
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Marketplace</label>
                <select
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  value={marketplaceToAdd}
                  onChange={(e) => setMarketplaceToAdd(e.target.value as Marketplace)}
                >
                  <option value="woocommerce">WooCommerce</option>
                  <option value="etsy">Etsy</option>
                  <option value="amazon">Amazon</option>
                </select>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Setup mode</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={
                      marketplaceAddMode === "manual"
                        ? "rounded-full border border-slate-900 bg-slate-900 px-3 py-1 text-xs font-semibold text-white"
                        : "rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                    }
                    onClick={() => setMarketplaceAddMode("manual")}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    className={
                      marketplaceAddMode === "connect"
                        ? "rounded-full border border-slate-900 bg-slate-900 px-3 py-1 text-xs font-semibold text-white"
                        : "rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                    }
                    onClick={() => setMarketplaceAddMode("connect")}
                  >
                    Connect
                  </button>
                </div>
                {marketplaceToAdd === "amazon" && marketplaceAddMode === "connect" && (
                  <p className="mt-2 text-xs text-slate-500">Amazon connect is coming soon. Switch to Manual setup.</p>
                )}
              </div>

              {marketplaceAddMode === "manual" && marketplaceToAdd === "woocommerce" && (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">WooCommerce credentials</p>
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.wooUrl}
                    onChange={(e) => updateManualDraft("wooUrl", e.target.value)}
                    placeholder="Woo URL (https://...)"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.wooKey}
                    onChange={(e) => updateManualDraft("wooKey", e.target.value)}
                    placeholder="Woo key (ck_...)"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.wooSecret}
                    onChange={(e) => updateManualDraft("wooSecret", e.target.value)}
                    placeholder="Woo secret (cs_...)"
                  />
                </div>
              )}

              {marketplaceAddMode === "manual" && marketplaceToAdd === "etsy" && (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Etsy credentials</p>
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.etsyKeystring}
                    onChange={(e) => updateManualDraft("etsyKeystring", e.target.value)}
                    placeholder="Etsy keystring"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.etsyBearer}
                    onChange={(e) => updateManualDraft("etsyBearer", e.target.value)}
                    placeholder="Etsy bearer token"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.etsyRefreshToken}
                    onChange={(e) => updateManualDraft("etsyRefreshToken", e.target.value)}
                    placeholder="Etsy refresh token"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.etsyShopName}
                    onChange={(e) => updateManualDraft("etsyShopName", e.target.value)}
                    placeholder="Etsy shop name (optional)"
                  />
                </div>
              )}

              {marketplaceAddMode === "manual" && marketplaceToAdd === "amazon" && (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Amazon credentials</p>
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.amazonSellerId}
                    onChange={(e) => updateManualDraft("amazonSellerId", e.target.value)}
                    placeholder="Amazon seller ID"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.amazonAccessKey}
                    onChange={(e) => updateManualDraft("amazonAccessKey", e.target.value)}
                    placeholder="Amazon access key"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.amazonSecretKey}
                    onChange={(e) => updateManualDraft("amazonSecretKey", e.target.value)}
                    placeholder="Amazon secret key"
                  />
                  <input
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    value={manualDraft.amazonRegion}
                    onChange={(e) => updateManualDraft("amazonRegion", e.target.value)}
                    placeholder="Amazon region (us-east-1)"
                  />
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setIsAddMarketplaceModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={handleConfirmAddMarketplace}
              >
                Add
              </button>
            </div>
          </article>
        </div>
      )}
    </section>
  );
}
