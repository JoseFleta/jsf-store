"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
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

type ProductImageRow = {
  product_id: string;
  storage_path: string;
  sort_order: number | null;
};

type FingerprintRow = {
  product_id: string;
  local_payload_fingerprint: string;
  updated_at: string;
};

type SnapshotRow = {
  product_id: string;
  sku: string;
  channel: string;
  external_id: string | null;
  title: string | null;
  status: string | null;
  currency: string | null;
  price: number | null;
  stock_qty: number | null;
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

type MovementRow = {
  product_id: string;
  movement_type: "purchase" | "sale";
  quantity: number;
  qty_change?: number | null;
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

function formatMarketplacePrice(_currency: string | null, price: number | null): string {
  if (price == null) return "-";
  const value = Number(price);
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function shouldIgnoreStockMismatch(channel: string, status: string | null, localStockQty: number): boolean {
  const normalizedStatus = (status || "").trim().toLowerCase();
  return channel === "etsy" && localStockQty <= 0 && normalizedStatus.length > 0 && normalizedStatus !== "active";
}

function formatUserWarningMessage(message: string | null, warningType: string): string {
  const raw = (message || "").trim();
  const normalized = raw.toLowerCase();
  if (warningType === "missing_mapping" || normalized.includes("missing etsy listing mapping")) {
    return "Not published in Etsy yet for this SKU.";
  }
  return raw || warningType.replace(/_/g, " ");
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
  const [primaryImageByProductId, setPrimaryImageByProductId] = useState<Record<string, string>>({});
  const [localStockByProductId, setLocalStockByProductId] = useState<Record<string, number>>({});
  const [selectedMarketplace, setSelectedMarketplace] = useState<Channel>("woocommerce");
  const [comparisonPage, setComparisonPage] = useState(1);
  const [comparisonPageSize, setComparisonPageSize] = useState(10);
  const [comparisonFilter, setComparisonFilter] = useState<"all" | "warnings">("all");
  const [comparisonSearch, setComparisonSearch] = useState("");
  const [marketplacePage, setMarketplacePage] = useState(1);
  const [marketplacePageSize, setMarketplacePageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [refreshingBaseline, setRefreshingBaseline] = useState(false);
  const [openIssueProductId, setOpenIssueProductId] = useState<string | null>(null);
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
      setPrimaryImageByProductId({});
      setLocalStockByProductId({});
      return;
    }

    setLoading(true);
    const [productsRes, imagesRes, movementsRes, fingerprintsRes, snapshotsRes, warningsRes] = await Promise.all([
      supabase
        .from("products")
        .select("id,sku,title,base_price,is_active")
        .eq("store_id", selectedStoreId)
        .order("title", { ascending: true }),
      supabase
        .from("product_images")
        .select("product_id,storage_path,sort_order")
        .eq("store_id", selectedStoreId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("stock_movements")
        .select("product_id,movement_type,quantity,qty_change")
        .eq("store_id", selectedStoreId),
      supabase
        .from("product_marketplace_fingerprints")
        .select("product_id,local_payload_fingerprint,updated_at")
        .eq("store_id", selectedStoreId),
      supabase
        .from("marketplace_product_snapshots")
        .select(
          "product_id,sku,channel,external_id,title,status,currency,price,stock_qty,sync_state,last_local_payload_fingerprint,remote_payload_fingerprint,last_published_at,last_error,updated_at",
        )
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
    if (imagesRes.error) {
      setMsg(imagesRes.error.message);
      setLoading(false);
      return;
    }
    if (movementsRes.error) {
      setMsg(movementsRes.error.message);
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

    const imageMap: Record<string, string> = {};
    for (const row of (imagesRes.data ?? []) as ProductImageRow[]) {
      if (!imageMap[row.product_id] && row.storage_path) imageMap[row.product_id] = row.storage_path;
    }
    const stockMap: Record<string, number> = {};
    for (const movement of (movementsRes.data ?? []) as MovementRow[]) {
      const signedQty =
        typeof movement.qty_change === "number"
          ? Number(movement.qty_change)
          : movement.movement_type === "purchase"
          ? Number(movement.quantity || 0)
          : -Number(movement.quantity || 0);
      stockMap[movement.product_id] = (stockMap[movement.product_id] || 0) + signedQty;
    }

    setProducts((productsRes.data ?? []) as ProductRow[]);
    setFingerprintsByProductId(fingerprintMap);
    setSnapshotsByProductChannel(snapshotMap);
    setWarningsByProductChannel(warningMap);
    setPrimaryImageByProductId(imageMap);
    setLocalStockByProductId(stockMap);
    setLoading(false);
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStoreId]);

  const getPublicImageUrl = (storagePath: string): string => {
    const { data } = supabase.storage.from("product-images").getPublicUrl(storagePath);
    return data.publicUrl;
  };

  const productRows = useMemo(() => {
    return products.map((product) => {
      const local = fingerprintsByProductId[product.id];
      const channels = CHANNELS.map((channel) => {
        const snapshot = snapshotsByProductChannel[`${product.id}:${channel}`];
        const openWarnings = warningsByProductChannel[`${product.id}:${channel}`] || [];
        const issues = openWarnings.map((warning) => formatUserWarningMessage(warning.message, warning.warning_type));
        if (snapshot?.sync_state === "error" && snapshot.last_error) issues.push(snapshot.last_error);
        const localStockQty = localStockByProductId[product.id] ?? 0;
        const stockMismatch =
          snapshot?.stock_qty != null &&
          snapshot.stock_qty !== localStockQty &&
          !shouldIgnoreStockMismatch(channel, snapshot?.status || null, localStockQty);
        if (stockMismatch) {
          issues.push(`Stock mismatch (${channelLabel(channel)}): local ${localStockQty}, marketplace ${snapshot?.stock_qty}.`);
        }
        let status = "Not published";
        if (snapshot) {
          if (snapshot.sync_state === "error") status = "Error";
          else if (stockMismatch) status = "Needs publish";
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
          warnings: issues.length,
          issues,
        };
      });

      const issueMessages = channels.flatMap((entry) => entry.issues);
      const warningCount = issueMessages.length;
      const needsPublish = channels.some((entry) => entry.status === "Needs publish");
      return { product, channels, warningCount, needsPublish, issueMessages };
    });
  }, [products, fingerprintsByProductId, snapshotsByProductChannel, warningsByProductChannel, localStockByProductId]);

  const stats = useMemo(() => {
    const total = productRows.length;
    const withWarnings = productRows.filter((row) => row.warningCount > 0).length;
    const needsPublish = productRows.filter((row) => row.needsPublish).length;
    const inSync = productRows.filter((row) => row.channels.every((channel) => channel.status === "In sync")).length;
    return { total, withWarnings, needsPublish, inSync };
  }, [productRows]);

  const filteredComparisonRows = useMemo(() => {
    const needle = comparisonSearch.trim().toLowerCase();
    return productRows.filter((row) => {
      if (comparisonFilter === "warnings" && row.warningCount === 0) return false;
      if (!needle) return true;
      const title = (row.product.title || "").toLowerCase();
      const sku = (row.product.sku || "").toLowerCase();
      return title.includes(needle) || sku.includes(needle);
    });
  }, [productRows, comparisonFilter, comparisonSearch]);

  const comparisonTotalPages = Math.max(1, Math.ceil(filteredComparisonRows.length / comparisonPageSize));
  const currentComparisonPage = Math.min(comparisonPage, comparisonTotalPages);

  const paginatedComparisonRows = useMemo(() => {
    const start = (currentComparisonPage - 1) * comparisonPageSize;
    return filteredComparisonRows.slice(start, start + comparisonPageSize);
  }, [filteredComparisonRows, currentComparisonPage, comparisonPageSize]);

  const comparisonStartIndex = filteredComparisonRows.length === 0 ? 0 : (currentComparisonPage - 1) * comparisonPageSize + 1;
  const comparisonEndIndex =
    filteredComparisonRows.length === 0 ? 0 : (currentComparisonPage - 1) * comparisonPageSize + paginatedComparisonRows.length;

  const lastRefreshedAt = useMemo(() => {
    let latest = 0;
    for (const snapshot of Object.values(snapshotsByProductChannel)) {
      const ts = Date.parse(snapshot.updated_at);
      if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    return latest > 0 ? new Date(latest) : null;
  }, [snapshotsByProductChannel]);

  const marketplaceSnapshotCounts = useMemo(() => {
    const counts: Record<Channel, number> = { woocommerce: 0, etsy: 0 };
    for (const row of Object.values(snapshotsByProductChannel)) {
      if ((row.channel === "woocommerce" || row.channel === "etsy") && row.remote_payload_fingerprint) {
        counts[row.channel] += 1;
      }
    }
    return counts;
  }, [snapshotsByProductChannel]);

  const productsById = useMemo(() => {
    const map: Record<string, ProductRow> = {};
    for (const product of products) map[product.id] = product;
    return map;
  }, [products]);

  const marketplaceRows = useMemo(() => {
    const rows: Array<{
      product: ProductRow | null;
      snapshot: SnapshotRow;
      syncStatus: string;
      warnings: string[];
    }> = [];

    for (const snapshot of Object.values(snapshotsByProductChannel)) {
      if (snapshot.channel !== selectedMarketplace) continue;
      if (!snapshot.remote_payload_fingerprint) continue;

      const local = fingerprintsByProductId[snapshot.product_id];
      const openWarnings = warningsByProductChannel[`${snapshot.product_id}:${selectedMarketplace}`] || [];
      const warningMessages = openWarnings.map((warning) => formatUserWarningMessage(warning.message, warning.warning_type));
      const product = productsById[snapshot.product_id] || null;
      const localStockQty = localStockByProductId[snapshot.product_id] ?? 0;
      const stockMismatch =
        snapshot.stock_qty != null &&
        snapshot.stock_qty !== localStockQty &&
        !shouldIgnoreStockMismatch(snapshot.channel, snapshot.status, localStockQty);
      if (stockMismatch) warningMessages.push(`Stock mismatch: local ${localStockQty}, marketplace ${snapshot.stock_qty}.`);
      if (snapshot.sync_state === "error" && snapshot.last_error) warningMessages.push(snapshot.last_error);

      let syncStatus = "Not published";
      if (snapshot.sync_state === "error") syncStatus = "Error";
      else if (stockMismatch) syncStatus = "Needs publish";
      else if (snapshot.sync_state === "published" && warningMessages.length === 0) syncStatus = "In sync";
      else if (snapshot.sync_state === "needs_publish") syncStatus = "Needs publish";
      else if (
        local?.local_payload_fingerprint &&
        snapshot.last_local_payload_fingerprint &&
        local.local_payload_fingerprint === snapshot.last_local_payload_fingerprint &&
        warningMessages.length === 0
      ) {
        syncStatus = "In sync";
      } else {
        syncStatus = "Needs publish";
      }

      rows.push({ product, snapshot, syncStatus, warnings: warningMessages });
    }

    rows.sort((a, b) =>
      (a.snapshot.title || a.product?.title || a.snapshot.sku).localeCompare(b.snapshot.title || b.product?.title || b.snapshot.sku),
    );

    return rows;
  }, [selectedMarketplace, snapshotsByProductChannel, fingerprintsByProductId, warningsByProductChannel, productsById, localStockByProductId]);

  const marketplaceTotalPages = Math.max(1, Math.ceil(marketplaceRows.length / marketplacePageSize));
  const currentMarketplacePage = Math.min(marketplacePage, marketplaceTotalPages);

  const paginatedMarketplaceRows = useMemo(() => {
    const start = (currentMarketplacePage - 1) * marketplacePageSize;
    return marketplaceRows.slice(start, start + marketplacePageSize);
  }, [marketplaceRows, currentMarketplacePage, marketplacePageSize]);

  const marketplaceStartIndex = marketplaceRows.length === 0 ? 0 : (currentMarketplacePage - 1) * marketplacePageSize + 1;
  const marketplaceEndIndex = marketplaceRows.length === 0 ? 0 : (currentMarketplacePage - 1) * marketplacePageSize + paginatedMarketplaceRows.length;

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
      errorCount?: number;
      firstError?: string | null;
    };
    setRefreshingBaseline(false);
    if (!res.ok) {
      setMsg(payload.error || "Baseline refresh failed.");
      return;
    }
    if ((payload.errorCount || 0) > 0) {
      setMsg(
        `Marketplace refresh completed with issues. Fingerprints: ${payload.updatedFingerprints || 0}. Snapshots: ${payload.updatedSnapshots || 0}. Warnings: ${payload.warningCount || 0}. Errors: ${payload.errorCount || 0}.${payload.firstError ? ` First issue: ${payload.firstError}` : ""}`,
      );
    } else {
      setMsg(
        `Marketplace refreshed. Fingerprints: ${payload.updatedFingerprints || 0}. Snapshots: ${payload.updatedSnapshots || 0}. Warnings: ${payload.warningCount || 0}.`,
      );
    }
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
          <p className="mt-2 text-xs text-slate-600">
            Last refreshed marketplace data: {lastRefreshedAt ? lastRefreshedAt.toLocaleString() : "Never"}
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
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Per page
              <select
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
                value={comparisonPageSize}
                onChange={(e) => {
                  setComparisonPageSize(Number(e.target.value));
                  setComparisonPage(1);
                }}
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Filter
              <select
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
                value={comparisonFilter}
                onChange={(e) => {
                  setComparisonFilter(e.target.value as "all" | "warnings");
                  setComparisonPage(1);
                }}
              >
                <option value="all">All products</option>
                <option value="warnings">Warnings only</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Product name
              <input
                type="text"
                className="min-w-[220px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium normal-case text-slate-800"
                value={comparisonSearch}
                onChange={(e) => {
                  setComparisonSearch(e.target.value);
                  setComparisonPage(1);
                }}
                placeholder="Search by name or SKU"
              />
            </label>
            <button
              type="button"
              className="rounded-full border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 shadow-sm transition hover:bg-cyan-100 disabled:opacity-60"
              onClick={handleRefreshBaseline}
              disabled={refreshingBaseline || !selectedStoreId}
            >
              {refreshingBaseline ? "Refreshing..." : "Refresh Marketplace Data"}
            </button>
          </div>
        </div>

        {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}

        {loading ? (
          <p className="mt-6 text-sm text-slate-500">Loading marketplace data...</p>
        ) : productRows.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No products in this store yet.
          </p>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-3 text-left">Picture</th>
                    <th className="px-3 py-3 text-left">Product</th>
                    <th className="px-3 py-3 text-left">Overview</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedComparisonRows.map((row) => {
                    const productImage = primaryImageByProductId[row.product.id];
                    return (
                      <tr key={row.product.id} className="align-top">
                        <td className="px-3 py-3">
                          {productImage ? (
                            <Image
                              src={getPublicImageUrl(productImage)}
                              alt={row.product.title || row.product.sku}
                              width={48}
                              height={48}
                              unoptimized
                              className="h-12 w-12 rounded-lg object-cover"
                            />
                          ) : (
                            <div className="h-12 w-12 rounded-lg border border-slate-200 bg-slate-100" />
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-medium text-slate-900">{row.product.title || "Product"}</p>
                          <p className="text-xs text-slate-500">{row.product.sku}</p>
                        </td>
                        <td className="px-3 py-3">
                          {row.warningCount === 0 ? (
                            <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                              All set
                            </span>
                          ) : (
                            <div className="space-y-1">
                              <button
                                type="button"
                                className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                                onClick={() => setOpenIssueProductId(openIssueProductId === row.product.id ? null : row.product.id)}
                              >
                                {row.warningCount} warning(s)
                              </button>
                              {openIssueProductId === row.product.id && (
                                <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-2">
                                  {row.issueMessages.map((issue, issueIndex) => (
                                    <p key={`${row.product.id}:issue:${issueIndex}`} className="text-[11px] text-rose-700">
                                      {issue}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                Showing {comparisonStartIndex}-{comparisonEndIndex} of {filteredComparisonRows.length}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
                  onClick={() => setComparisonPage(Math.max(1, currentComparisonPage - 1))}
                  disabled={currentComparisonPage <= 1}
                >
                  Prev
                </button>
                <span className="text-xs font-medium text-slate-600">
                  Page {currentComparisonPage} of {comparisonTotalPages}
                </span>
                <button
                  type="button"
                  className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
                  onClick={() => setComparisonPage(Math.min(comparisonTotalPages, currentComparisonPage + 1))}
                  disabled={currentComparisonPage >= comparisonTotalPages}
                >
                  Next
                </button>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Marketplace Database</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Select a marketplace to see only listings successfully retrieved from that marketplace.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Marketplace
                    <select
                      className="min-w-[210px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
                      value={selectedMarketplace}
                      onChange={(e) => {
                        setSelectedMarketplace(e.target.value as Channel);
                        setMarketplacePage(1);
                      }}
                    >
                      {CHANNELS.map((channel) => (
                        <option key={channel} value={channel}>
                          {channelLabel(channel)} ({marketplaceSnapshotCounts[channel]})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Per page
                    <select
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
                      value={marketplacePageSize}
                      onChange={(e) => {
                        setMarketplacePageSize(Number(e.target.value));
                        setMarketplacePage(1);
                      }}
                    >
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                  </label>
                </div>
              </div>

              {marketplaceRows.length === 0 ? (
                <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                  No {channelLabel(selectedMarketplace)} listings retrieved. Check credentials/connectivity and refresh again.
                </p>
              ) : (
                <>
                  <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-3 text-left">Local Product</th>
                          <th className="px-3 py-3 text-left">Marketplace Listing</th>
                          <th className="px-3 py-3 text-left">Status</th>
                          <th className="px-3 py-3 text-left">Price</th>
                          <th className="px-3 py-3 text-left">Stock</th>
                          <th className="px-3 py-3 text-left">Sync</th>
                          <th className="px-3 py-3 text-left">Updated</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {paginatedMarketplaceRows.map((row) => (
                          <tr key={`${row.snapshot.product_id}:${selectedMarketplace}`} className="align-top">
                            <td className="px-3 py-3">
                              <p className="font-medium text-slate-900">{row.product?.title || row.snapshot.title || "Product"}</p>
                              <p className="text-xs text-slate-500">{row.product?.sku || row.snapshot.sku}</p>
                            </td>
                            <td className="px-3 py-3">
                              <p className="font-medium text-slate-900">{row.snapshot.title || "Untitled listing"}</p>
                              <p className="text-xs text-slate-500">
                                {row.snapshot.external_id ? `ID: ${row.snapshot.external_id}` : "No external ID"}
                              </p>
                            </td>
                            <td className="px-3 py-3 text-slate-800">{row.snapshot.status || "-"}</td>
                            <td className="px-3 py-3 text-slate-800">{formatMarketplacePrice(row.snapshot.currency, row.snapshot.price)}</td>
                            <td className="px-3 py-3 text-slate-800">{row.snapshot.stock_qty ?? "-"}</td>
                            <td className="px-3 py-3">
                              <div className="space-y-1">
                                <span
                                  className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyle(row.syncStatus)}`}
                                >
                                  {row.syncStatus}
                                </span>
                                {row.warnings.length > 0 && (
                                  <p className="max-w-xs text-[11px] text-rose-700">
                                    {row.warnings.length} warning(s): {row.warnings[0] || "Check warning details."}
                                  </p>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-3 text-xs text-slate-600">
                              {row.snapshot.updated_at ? row.snapshot.updated_at.slice(0, 16).replace("T", " ") : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-slate-500">
                      Showing {marketplaceStartIndex}-{marketplaceEndIndex} of {marketplaceRows.length}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
                        onClick={() => setMarketplacePage(Math.max(1, currentMarketplacePage - 1))}
                        disabled={currentMarketplacePage <= 1}
                      >
                        Prev
                      </button>
                      <span className="text-xs font-medium text-slate-600">
                        Page {currentMarketplacePage} of {marketplaceTotalPages}
                      </span>
                      <button
                        type="button"
                        className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
                        onClick={() => setMarketplacePage(Math.min(marketplaceTotalPages, currentMarketplacePage + 1))}
                        disabled={currentMarketplacePage >= marketplaceTotalPages}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </article>
    </section>
  );
}

