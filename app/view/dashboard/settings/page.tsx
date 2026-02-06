"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type IntegrationConfig = {
  wooUrl: string;
  wooKey: string;
  wooSecret: string;
  etsyBearer: string;
  etsyKeystring: string;
  etsyShopName: string;
  etsySkumapJson: string;
  updatedAt: string | null;
};

const EMPTY_CONFIG: IntegrationConfig = {
  wooUrl: "",
  wooKey: "",
  wooSecret: "",
  etsyBearer: "",
  etsyKeystring: "",
  etsyShopName: "",
  etsySkumapJson: "{}",
  updatedAt: null,
};

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [selectedStoreId, setSelectedStoreId] = useState(searchParams.get("store") || "");
  const [config, setConfig] = useState<IntegrationConfig>(EMPTY_CONFIG);
  const [savedConfig, setSavedConfig] = useState<IntegrationConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setSelectedStoreId(searchParams.get("store") || "");
  }, [searchParams]);

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
      const hasPersistedValues =
        Boolean(nextConfig.updatedAt) ||
        Boolean(nextConfig.wooUrl) ||
        Boolean(nextConfig.wooKey) ||
        Boolean(nextConfig.wooSecret) ||
        Boolean(nextConfig.etsyBearer) ||
        Boolean(nextConfig.etsyKeystring) ||
        Boolean(nextConfig.etsyShopName) ||
        (nextConfig.etsySkumapJson || "").trim() !== "{}";

      setConfig(nextConfig);
      setSavedConfig(nextConfig);
      setIsEditing(!hasPersistedValues);
      setLoading(false);
    };

    loadConfig();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, supabase]);

  const updateField = <K extends keyof IntegrationConfig>(key: K, value: IntegrationConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
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
        wooUrl: config.wooUrl,
        wooKey: config.wooKey,
        wooSecret: config.wooSecret,
        etsyBearer: config.etsyBearer,
        etsyKeystring: config.etsyKeystring,
        etsyShopName: config.etsyShopName,
        etsySkumapJson: config.etsySkumapJson,
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
          <h2 className="text-lg font-semibold text-slate-900">WooCommerce</h2>
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

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Etsy</h2>
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
    </section>
  );
}
