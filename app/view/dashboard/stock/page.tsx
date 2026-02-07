"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type ProductType = "ropa" | "maquetas" | "accesorios";
type ProductTypeFilter = "all" | ProductType;

type ProductRow = {
  id: string;
  sku: string;
  name?: string | null;
  title?: string | null;
  product_type?: ProductType | null;
  escala?: string | null;
  clothing_type?: string | null;
  accessory_type?: string | null;
  is_active?: boolean | null;
};

type MovementRow = {
  product_id: string;
  movement_type: "purchase" | "sale";
  quantity: number;
  qty_change?: number | null;
};

function getTypeLabel(type: ProductType | ProductTypeFilter): string {
  if (type === "ropa") return "Apparel";
  if (type === "maquetas") return "Models";
  if (type === "accesorios") return "Accessories";
  return "All";
}

function getSubtypeLabel(type: ProductTypeFilter): string {
  if (type === "maquetas") return "Scale";
  if (type === "ropa") return "Clothing type";
  if (type === "accesorios") return "Accessory type";
  return "Type detail";
}

function getSubtypeValue(product: ProductRow, typeFilter: ProductTypeFilter): string {
  const type = typeFilter === "all" ? product.product_type : typeFilter;
  if (type === "maquetas") return product.escala || "-";
  if (type === "ropa") return product.clothing_type || "-";
  if (type === "accesorios") return product.accessory_type || "-";
  return "-";
}

function escapeCsvValue(value: string | number | boolean | null | undefined): string {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export default function StockPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [selectedStoreId, setSelectedStoreId] = useState(searchParams.get("store") || "");
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);

  const [search, setSearch] = useState("");
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>("all");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [selectedSyncSkus, setSelectedSyncSkus] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncingMarketplaces, setSyncingMarketplaces] = useState(false);

  useEffect(() => {
    setSelectedStoreId(searchParams.get("store") || "");
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    const checkAuth = async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!userRes.user) {
        router.push("/view/login");
        return;
      }
    };
    checkAuth();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      if (!selectedStoreId) {
        setProducts([]);
        setMovements([]);
        setLoading(false);
        return;
      }
      setLoading(true);

      const [productsRes, movesRes] = await Promise.all([
        supabase
          .from("products")
          .select("id,sku,name,title,product_type,escala,clothing_type,accessory_type,is_active")
          .eq("store_id", selectedStoreId),
        supabase
          .from("stock_movements")
          .select("product_id,movement_type,quantity,qty_change")
          .eq("store_id", selectedStoreId),
      ]);

      if (cancelled) return;

      if (productsRes.error) {
        setMsg(productsRes.error.message);
        setLoading(false);
        return;
      }
      if (movesRes.error) {
        setMsg(movesRes.error.message);
        setLoading(false);
        return;
      }

      setProducts((productsRes.data ?? []) as ProductRow[]);
      setMovements((movesRes.data ?? []) as MovementRow[]);
      setLoading(false);
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, supabase]);

  const stockRows = useMemo(() => {
    const byProduct = new Map<string, { inQty: number; outQty: number; stock: number }>();

    for (const mv of movements) {
      const current = byProduct.get(mv.product_id) || { inQty: 0, outQty: 0, stock: 0 };
      const signedQty =
        typeof mv.qty_change === "number"
          ? mv.qty_change
          : mv.movement_type === "purchase"
          ? Number(mv.quantity || 0)
          : -Number(mv.quantity || 0);

      if (signedQty >= 0) current.inQty += signedQty;
      else current.outQty += Math.abs(signedQty);

      current.stock += signedQty;
      byProduct.set(mv.product_id, current);
    }

    return products.map((p) => {
      const agg = byProduct.get(p.id) || { inQty: 0, outQty: 0, stock: 0 };
      return {
        id: p.id,
        sku: p.sku,
        name: p.title || p.name || "-",
        product_type: (p.product_type || "maquetas") as ProductType,
        escala: p.escala || null,
        clothing_type: p.clothing_type || null,
        accessory_type: p.accessory_type || null,
        is_active: Boolean(p.is_active),
        inQty: agg.inQty,
        outQty: agg.outQty,
        stock: agg.stock,
      };
    });
  }, [products, movements]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return stockRows.filter((r) => {
      const typeMatch = productTypeFilter === "all" ? true : r.product_type === productTypeFilter;
      const subtype = getSubtypeValue(r, "all").toLowerCase();
      const textMatch =
        !term ||
        r.sku.toLowerCase().includes(term) ||
        r.name.toLowerCase().includes(term) ||
        subtype.includes(term);
      return typeMatch && textMatch;
    });
  }, [stockRows, search, productTypeFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [search, productTypeFilter, selectedStoreId, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setSelectedSyncSkus([]);
  }, [selectedStoreId]);

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

  const isAllCurrentPageSelected = useMemo(() => {
    return paginatedRows.length > 0 && paginatedRows.every((row) => selectedSyncSkus.includes(row.sku));
  }, [paginatedRows, selectedSyncSkus]);

  const totals = useMemo(() => {
    let inQty = 0;
    let outQty = 0;
    let stock = 0;
    for (const row of filteredRows) {
      inQty += row.inQty;
      outQty += row.outQty;
      stock += row.stock;
    }
    return { inQty, outQty, stock };
  }, [filteredRows]);

  const downloadFilteredStockCsv = () => {
    const headers = ["sku", "product", "type", "type_detail", "inflow", "outflow", "stock", "is_active"];
    const lines = filteredRows.map((row) =>
      [
        row.sku,
        row.name,
        row.product_type,
        getSubtypeValue(row, "all"),
        row.inQty.toFixed(0),
        row.outQty.toFixed(0),
        row.stock.toFixed(0),
        row.is_active,
      ]
        .map((value) => escapeCsvValue(value))
        .join(","),
    );
    const csv = [headers.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "stock_export.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const toggleSkuSelection = (sku: string, checked: boolean) => {
    setSelectedSyncSkus((prev) => {
      if (checked) return prev.includes(sku) ? prev : [...prev, sku];
      return prev.filter((value) => value !== sku);
    });
  };

  const toggleSelectCurrentPage = (checked: boolean) => {
    const pageSkus = paginatedRows.map((row) => row.sku);
    if (checked) {
      setSelectedSyncSkus((prev) => Array.from(new Set([...prev, ...pageSkus])));
      return;
    }
    setSelectedSyncSkus((prev) => prev.filter((sku) => !pageSkus.includes(sku)));
  };

  const handleSyncMarketplaces = async (skus?: string[]) => {
    if (!selectedStoreId) {
      setMsg("Select a store first.");
      return;
    }
    if (skus && skus.length === 0) {
      setMsg("Select at least one SKU to sync.");
      return;
    }

    setMsg("");
    setSyncingMarketplaces(true);
    setMsg("Sync in progress...");

    const { data: sessionRes } = await supabase.auth.getSession();
    const accessToken = sessionRes.session?.access_token;
    if (!accessToken) {
      setSyncingMarketplaces(false);
      setMsg("Session expired. Please sign in again.");
      return;
    }

    try {
      const res = await fetch("/api/stock/sync-marketplaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ storeId: selectedStoreId, skus }),
      });

      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        syncedSkuCount?: number;
        requestedSkuCount?: number | null;
        skippedRequestedSkuCount?: number;
        skippedRequestedSkus?: string[];
        woo?: { enabled?: boolean; updated?: number; missingSkuCount?: number; errors?: string[] };
        etsy?: {
          enabled?: boolean;
          updatedListings?: number;
          missingSkuCount?: number;
          missingSkus?: string[];
          errors?: string[];
        };
        errors?: string[];
      };

      setSyncingMarketplaces(false);

      if (!res.ok) {
        setMsg(payload.error || "Marketplace sync failed.");
        return;
      }

      const wooSummary = payload.woo?.enabled
        ? `Woo: ${payload.woo.updated || 0} updated, ${payload.woo.missingSkuCount || 0} missing SKU`
        : "Woo: not configured";
      const etsySummary = payload.etsy?.enabled
        ? `Etsy: ${payload.etsy.updatedListings || 0} listings updated, ${payload.etsy.missingSkuCount || 0} missing SKU map`
        : "Etsy: not configured";
      const hasErrors =
        Boolean((payload.woo?.errors?.length || 0) + (payload.etsy?.errors?.length || 0)) ||
        Boolean(payload.errors?.length);
      const firstError =
        payload.errors?.[0] || payload.woo?.errors?.[0] || payload.etsy?.errors?.[0] || "";
      const scopeSummary =
        payload.requestedSkuCount && payload.requestedSkuCount > 0
          ? `Scope: ${payload.syncedSkuCount || 0}/${payload.requestedSkuCount} selected SKU(s)`
          : `Scope: ${payload.syncedSkuCount || 0} SKU(s)`;
      const skippedSummary =
        payload.skippedRequestedSkuCount && payload.skippedRequestedSkuCount > 0
          ? ` ${payload.skippedRequestedSkuCount} selected SKU(s) were not found in this store (${(payload.skippedRequestedSkus || []).slice(0, 3).join(", ")}).`
          : "";
      const etsyMissingSku = payload.etsy?.missingSkus?.[0] || "";
      const etsyMissingSummary =
        (payload.etsy?.missingSkuCount || 0) > 0
          ? ` Missing Etsy SKU map for: ${etsyMissingSku || `${payload.etsy?.missingSkuCount} SKU(s)`}.`
          : "";
      setMsg(
        `Sync complete. ${scopeSummary}. ${wooSummary}. ${etsySummary}.${etsyMissingSummary}${skippedSummary}${hasErrors ? ` First issue: ${firstError}` : ""}`,
      );
      if (skus && skus.length > 0) setSelectedSyncSkus([]);
    } catch (error) {
      setSyncingMarketplaces(false);
      setMsg(error instanceof Error ? error.message : "Marketplace sync failed.");
    }
  };

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Stock</h1>
        <p className="mt-1 text-sm text-slate-500">Stock is calculated automatically from purchases and sales.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-5">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Inflow</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.inQty.toFixed(0)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Outflow</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.outQty.toFixed(0)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Current stock</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.stock.toFixed(0)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Type</label>
            <select
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={productTypeFilter}
              onChange={(e) => setProductTypeFilter(e.target.value as ProductTypeFilter)}
            >
              <option value="all">All</option>
              <option value="maquetas">Models</option>
              <option value="ropa">Apparel</option>
              <option value="accesorios">Accessories</option>
            </select>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Search</label>
            <input
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              placeholder="Search by SKU, name, or detail"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </header>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            className="rounded-full border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm transition hover:border-emerald-400 disabled:opacity-60"
            onClick={() => handleSyncMarketplaces(selectedSyncSkus)}
            disabled={!selectedStoreId || loading || syncingMarketplaces || selectedSyncSkus.length === 0}
          >
            {syncingMarketplaces ? "Syncing..." : `Sync selected (${selectedSyncSkus.length})`}
          </button>
          <button
            type="button"
            className="rounded-full border border-indigo-300 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 shadow-sm transition hover:border-indigo-400 disabled:opacity-60"
            onClick={() => handleSyncMarketplaces()}
            disabled={!selectedStoreId || loading || syncingMarketplaces}
          >
            {syncingMarketplaces ? "Syncing..." : "Sync all"}
          </button>
          <button
            type="button"
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 disabled:opacity-60"
            onClick={downloadFilteredStockCsv}
            disabled={!selectedStoreId || filteredRows.length === 0}
          >
            Export CSV
          </button>
          <select
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
          <span className="text-xs text-slate-500">{selectedSyncSkus.length} SKU(s) selected</span>
        </div>
        {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}

        {loading ? (
          <p className="mt-6 text-sm text-slate-500">Loading stock...</p>
        ) : paginatedRows.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No results for this filter.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-3">
                    <input
                      type="checkbox"
                      checked={isAllCurrentPageSelected}
                      onChange={(e) => toggleSelectCurrentPage(e.target.checked)}
                      aria-label="Select page"
                    />
                  </th>
                  <th className="px-2 py-3">SKU</th>
                  <th className="px-2 py-3">Product</th>
                  <th className="px-2 py-3">Type</th>
                  <th className="px-2 py-3">{getSubtypeLabel(productTypeFilter)}</th>
                  <th className="px-2 py-3">Inflow</th>
                  <th className="px-2 py-3">Outflow</th>
                  <th className="px-2 py-3">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedRows.map((row) => (
                  <tr key={row.id} className="text-slate-700">
                    <td className="px-2 py-3">
                      <input
                        type="checkbox"
                        checked={selectedSyncSkus.includes(row.sku)}
                        onChange={(e) => toggleSkuSelection(row.sku, e.target.checked)}
                        aria-label={`Select ${row.sku}`}
                      />
                    </td>
                    <td className="px-2 py-3 font-medium">{row.sku}</td>
                    <td className="px-2 py-3">{row.name}</td>
                    <td className="px-2 py-3">{getTypeLabel(row.product_type)}</td>
                    <td className="px-2 py-3">{getSubtypeValue(row, productTypeFilter)}</td>
                    <td className="px-2 py-3">{row.inQty.toFixed(0)}</td>
                    <td className="px-2 py-3">{row.outQty.toFixed(0)}</td>
                    <td className="px-2 py-3 font-semibold">{row.stock.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <p>Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-full border border-slate-200 px-3 py-1 font-semibold disabled:opacity-50"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1}
            >
              Prev
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-200 px-3 py-1 font-semibold disabled:opacity-50"
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={page >= totalPages}
            >
              Next
            </button>
          </div>
        </div>
      </article>

    </section>
  );
}
