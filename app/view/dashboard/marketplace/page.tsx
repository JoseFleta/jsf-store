"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type Channel = "woocommerce" | "etsy";

type ProductRow = {
  id: string;
  sku: string;
  title: string | null;
  base_price: number | null;
  is_active: boolean | null;
};

type FingerprintRow = {
  product_id: string;
  local_payload_fingerprint: string;
  updated_at: string;
};

type SnapshotRow = {
  product_id: string;
  channel: string;
  sync_state: "published" | "needs_publish" | "unknown" | "error";
  last_local_payload_fingerprint: string | null;
  remote_payload_fingerprint: string | null;
  last_published_at: string | null;
  last_error: string | null;
  updated_at: string;
};

type WarningRow = {
  product_id: string;
  channel: string;
  warning_type: string;
  message: string | null;
  is_resolved: boolean;
  last_seen_at: string;
};

const CHANNELS: Channel[] = ["woocommerce", "etsy"];

function channelLabel(channel: Channel): string {
  return channel === "woocommerce" ? "WooCommerce" : "Etsy";
}

function statusStyle(status: string): string {
  if (status === "In sync") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "Needs publish") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "Error") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-300 bg-slate-100 text-slate-600";
}

export default function MarketplacePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const selectedStoreId = searchParams.get("store") || "";

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [fingerprintsByProductId, setFingerprintsByProductId] = useState<Record<string, FingerprintRow>>({});
  const [snapshotsByProductChannel, setSnapshotsByProductChannel] = useState<Record<string, SnapshotRow>>({});
  const [warningsByProductChannel, setWarningsByProductChannel] = useState<Record<string, WarningRow[]>>({});
  const [loading, setLoading] = useState(false);
  const [refreshingBaseline, setRefreshingBaseline] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    const checkAuth = async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!userRes.user) router.push("/view/login");
    };
    void checkAuth();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  const loadData = async () => {
    if (!selectedStoreId) {
      setProducts([]);
      setFingerprintsByProductId({});
      setSnapshotsByProductChannel({});
      setWarningsByProductChannel({});
      return;
    }

    setLoading(true);
    const [productsRes, fingerprintsRes, snapshotsRes, warningsRes] = await Promise.all([
      supabase
        .from("products")
        .select("id,sku,title,base_price,is_active")
        .eq("store_id", selectedStoreId)
        .order("title", { ascending: true }),
      supabase
        .from("product_marketplace_fingerprints")
        .select("product_id,local_payload_fingerprint,updated_at")
        .eq("store_id", selectedStoreId),
      supabase
        .from("marketplace_product_snapshots")
        .select("product_id,channel,sync_state,last_local_payload_fingerprint,remote_payload_fingerprint,last_published_at,last_error,updated_at")
        .eq("store_id", selectedStoreId),
      supabase
        .from("marketplace_sync_warnings")
        .select("product_id,channel,warning_type,message,is_resolved,last_seen_at")
        .eq("store_id", selectedStoreId)
        .eq("is_resolved", false),
    ]);

    if (productsRes.error) {
      setMsg(productsRes.error.message);
      setLoading(false);
      return;
    }
    if (fingerprintsRes.error || snapshotsRes.error || warningsRes.error) {
      setMsg(
        fingerprintsRes.error?.message ||
          snapshotsRes.error?.message ||
          warningsRes.error?.message ||
          "Marketplace data loading failed.",
      );
      setLoading(false);
      return;
    }

    const fingerprintMap: Record<string, FingerprintRow> = {};
    for (const row of (fingerprintsRes.data ?? []) as FingerprintRow[]) {
      fingerprintMap[row.product_id] = row;
    }

    const snapshotMap: Record<string, SnapshotRow> = {};
    for (const row of (snapshotsRes.data ?? []) as SnapshotRow[]) {
      snapshotMap[`${row.product_id}:${row.channel}`] = row;
    }

    const warningMap: Record<string, WarningRow[]> = {};
    for (const row of (warningsRes.data ?? []) as WarningRow[]) {
      const key = `${row.product_id}:${row.channel}`;
      if (!warningMap[key]) warningMap[key] = [];
      warningMap[key].push(row);
    }

    setProducts((productsRes.data ?? []) as ProductRow[]);
    setFingerprintsByProductId(fingerprintMap);
    setSnapshotsByProductChannel(snapshotMap);
    setWarningsByProductChannel(warningMap);
    setLoading(false);
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStoreId]);

  const productRows = useMemo(() => {
    return products.map((product) => {
      const local = fingerprintsByProductId[product.id];
      const channels = CHANNELS.map((channel) => {
        const snapshot = snapshotsByProductChannel[`${product.id}:${channel}`];
        const openWarnings = warningsByProductChannel[`${product.id}:${channel}`] || [];
        let status = "Not published";
        if (snapshot) {
          if (snapshot.sync_state === "error") status = "Error";
          else if (snapshot.sync_state === "published" && openWarnings.length === 0) status = "In sync";
          else if (snapshot.sync_state === "needs_publish") status = "Needs publish";
          else if (
            local?.local_payload_fingerprint &&
            snapshot.last_local_payload_fingerprint &&
            local.local_payload_fingerprint === snapshot.last_local_payload_fingerprint &&
            openWarnings.length === 0
          ) {
            status = "In sync";
          } else {
            status = "Needs publish";
          }
        }
        return {
          channel,
          status,
          publishedAt: snapshot?.last_published_at || null,
          warnings: openWarnings.length,
          firstIssue: openWarnings[0]?.message || snapshot?.last_error || "",
        };
      });

      const warningCount = channels.reduce((sum, entry) => sum + entry.warnings, 0);
      const needsPublish = channels.some((entry) => entry.status === "Needs publish");
      return { product, channels, warningCount, needsPublish };
    });
  }, [products, fingerprintsByProductId, snapshotsByProductChannel, warningsByProductChannel]);

  const stats = useMemo(() => {
    const total = productRows.length;
    const withWarnings = productRows.filter((row) => row.warningCount > 0).length;
    const needsPublish = productRows.filter((row) => row.needsPublish).length;
    const inSync = productRows.filter((row) => row.channels.every((channel) => channel.status === "In sync")).length;
    return { total, withWarnings, needsPublish, inSync };
  }, [productRows]);

  const handleRefreshBaseline = async () => {
    if (!selectedStoreId) return;
    setRefreshingBaseline(true);
    setMsg("");
    const { data: sessionRes } = await supabase.auth.getSession();
    const accessToken = sessionRes.session?.access_token;
    if (!accessToken) {
      setRefreshingBaseline(false);
      setMsg("Session expired. Please sign in again.");
      return;
    }

    const res = await fetch("/api/marketplace/snapshots/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ storeId: selectedStoreId }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      updatedFingerprints?: number;
      updatedSnapshots?: number;
      warningCount?: number;
      firstError?: string | null;
    };
    setRefreshingBaseline(false);
    if (!res.ok) {
      setMsg(payload.error || "Baseline refresh failed.");
      return;
    }
    setMsg(
      `Marketplace refreshed. Fingerprints: ${payload.updatedFingerprints || 0}. Snapshots: ${payload.updatedSnapshots || 0}. Warnings: ${payload.warningCount || 0}.${payload.firstError ? ` First issue: ${payload.firstError}` : ""}`,
    );
    await loadData();
  };

  return (
    <section className="space-y-6">
      <header className="relative overflow-hidden rounded-[28px] border border-slate-300 bg-gradient-to-br from-cyan-100 via-white to-emerald-100 p-6 shadow-sm">
        <div className="absolute -right-12 -top-16 h-40 w-40 rounded-full bg-cyan-300/30 blur-2xl" />
        <div className="absolute -bottom-16 left-20 h-36 w-36 rounded-full bg-emerald-300/30 blur-2xl" />
        <div className="relative">
          <h1 className="text-2xl font-semibold text-slate-900">Marketplace Control Tower</h1>
          <p className="mt-1 text-sm text-slate-600">
            Compare local catalog vs marketplaces, detect drift, and confirm real updates before publish.
          </p>
          <div className="mt-5 grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Products</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{stats.total}</p>
            </div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">In Sync</p>
              <p className="mt-1 text-xl font-semibold text-emerald-800">{stats.inSync}</p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-700">Needs Publish</p>
              <p className="mt-1 text-xl font-semibold text-amber-800">{stats.needsPublish}</p>
            </div>
            <div className="rounded-2xl border border-rose-200 bg-rose-50/80 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-rose-700">Open Warnings</p>
              <p className="mt-1 text-xl font-semibold text-rose-800">{stats.withWarnings}</p>
            </div>
          </div>
        </div>
      </header>

      <article className="rounded-3xl border border-slate-300 bg-gradient-to-b from-white to-slate-50/60 p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Channel Comparison</h2>
            <p className="mt-1 text-sm text-slate-500">Each channel shows if marketplace data is aligned with current local baseline.</p>
          </div>
          <button
            type="button"
            className="rounded-full border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 shadow-sm transition hover:bg-cyan-100 disabled:opacity-60"
            onClick={handleRefreshBaseline}
            disabled={refreshingBaseline || !selectedStoreId}
          >
            {refreshingBaseline ? "Refreshing..." : "Refresh Marketplace Data"}
          </button>
        </div>

        {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}

        {loading ? (
          <p className="mt-6 text-sm text-slate-500">Loading marketplace data...</p>
        ) : productRows.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No products in this store yet.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-3 text-left">Product</th>
                  <th className="px-3 py-3 text-left">Base Price</th>
                  <th className="px-3 py-3 text-left">WooCommerce</th>
                  <th className="px-3 py-3 text-left">Etsy</th>
                  <th className="px-3 py-3 text-left">Warnings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {productRows.map((row) => {
                  const woo = row.channels.find((entry) => entry.channel === "woocommerce")!;
                  const etsy = row.channels.find((entry) => entry.channel === "etsy")!;
                  return (
                    <tr key={row.product.id} className="align-top">
                      <td className="px-3 py-3">
                        <p className="font-medium text-slate-900">{row.product.title || "Product"}</p>
                        <p className="text-xs text-slate-500">{row.product.sku}</p>
                      </td>
                      <td className="px-3 py-3 text-slate-800">{Number(row.product.base_price || 0).toFixed(2)}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyle(woo.status)}`}>
                            {channelLabel("woocommerce")}: {woo.status}
                          </span>
                          {woo.publishedAt && <span className="text-[11px] text-slate-500">Last publish: {woo.publishedAt.slice(0, 10)}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyle(etsy.status)}`}>
                            {channelLabel("etsy")}: {etsy.status}
                          </span>
                          {etsy.publishedAt && <span className="text-[11px] text-slate-500">Last publish: {etsy.publishedAt.slice(0, 10)}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {row.warningCount === 0 ? (
                          <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                            Clean
                          </span>
                        ) : (
                          <div className="space-y-1">
                            <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700">
                              {row.warningCount} warning(s)
                            </span>
                            <p className="max-w-xs text-[11px] text-rose-700">{woo.firstIssue || etsy.firstIssue}</p>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </section>
  );
}
