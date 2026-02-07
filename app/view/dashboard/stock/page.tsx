"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type ProductType = "ropa" | "maquetas" | "accesorios";
type ProductTypeFilter = "all" | ProductType;
type SortDirection = "asc" | "desc";
type StockSortKey = "product" | "type" | "subtype" | "inflow" | "outflow" | "stock";

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

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
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
  const [sort, setSort] = useState<{ key: StockSortKey; direction: SortDirection } | null>({
    key: "stock",
    direction: "desc",
  });
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

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const next = [...filteredRows];
    next.sort((a, b) => {
      let cmp = 0;
      if (sort.key === "product") cmp = compareText(a.name || "", b.name || "");
      if (sort.key === "type") cmp = compareText(getTypeLabel(a.product_type), getTypeLabel(b.product_type));
      if (sort.key === "subtype") cmp = compareText(getSubtypeValue(a, productTypeFilter), getSubtypeValue(b, productTypeFilter));
      if (sort.key === "inflow") cmp = a.inQty - b.inQty;
      if (sort.key === "outflow") cmp = a.outQty - b.outQty;
      if (sort.key === "stock") cmp = a.stock - b.stock;
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return next;
  }, [filteredRows, sort, productTypeFilter]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));

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
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, page, pageSize]);

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
  const hasActiveFilters = productTypeFilter !== "all" || search.trim().length > 0;

  const toggleSort = (key: StockSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, direction: "asc" };
      return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
    });
  };

  const getSortArrow = (key: StockSortKey) => {
    if (!sort || sort.key !== key) return "↕";
    return sort.direction === "asc" ? "↑" : "↓";
  };

  const downloadFilteredStockCsv = () => {
    const headers = ["sku", "product", "type", "type_detail", "inflow", "outflow", "stock", "is_active"];
    const lines = sortedRows.map((row) =>
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
      <header className="relative overflow-hidden rounded-[28px] border border-slate-300 bg-gradient-to-br from-slate-100 via-white to-blue-100 p-6 shadow-sm">
        <div className="absolute -right-14 -top-16 h-40 w-40 rounded-full bg-slate-300/30 blur-2xl" />
        <div className="absolute -bottom-14 left-20 h-36 w-36 rounded-full bg-blue-300/25 blur-2xl" />
        <div className="relative">
        <h1 className="text-2xl font-semibold text-slate-900">Stock</h1>
        <p className="mt-1 text-sm text-slate-600">Stock is calculated automatically from purchases and sales.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Inflow</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.inQty.toFixed(0)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Outflow</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.outQty.toFixed(0)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Current stock</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.stock.toFixed(0)}</p>
          </div>
        </div>
        <div className="mt-4 rounded-2xl border border-slate-300 bg-gradient-to-br from-slate-50 via-white to-blue-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-700">Shared Filters</p>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                {hasActiveFilters ? "Filters active" : "No filters"}
              </span>
              {hasActiveFilters && (
                <button
                  type="button"
                  className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:border-slate-400"
                  onClick={() => {
                    setProductTypeFilter("all");
                    setSearch("");
                  }}
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
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
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Search</label>
              <div className="relative mt-2">
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 pr-10 text-sm text-slate-700"
                  placeholder="Search by name or detail"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search.trim().length > 0 && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-semibold leading-none text-slate-500 hover:text-slate-700"
                    onClick={() => setSearch("")}
                  >
                    x
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        </div>
      </header>

      <article className="rounded-3xl border border-slate-300 bg-gradient-to-b from-white to-slate-50/60 p-6 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            className="rounded-full border border-blue-300 bg-white px-4 py-2 text-sm font-semibold text-blue-700 shadow-sm transition hover:border-blue-400 disabled:opacity-60"
            onClick={() => handleSyncMarketplaces(selectedSyncSkus)}
            disabled={!selectedStoreId || loading || syncingMarketplaces || selectedSyncSkus.length === 0}
          >
            {syncingMarketplaces ? "Syncing..." : `Sync selected (${selectedSyncSkus.length})`}
          </button>
          <button
            type="button"
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 disabled:opacity-60"
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
          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-3">
                    <input
                      type="checkbox"
                      checked={isAllCurrentPageSelected}
                      onChange={(e) => toggleSelectCurrentPage(e.target.checked)}
                      aria-label="Select page"
                    />
                  </th>
                  <th className="px-2 py-3">
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("product")}>
                      Product <span>{getSortArrow("product")}</span>
                    </button>
                  </th>
                  <th className="px-2 py-3">
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("type")}>
                      Type <span>{getSortArrow("type")}</span>
                    </button>
                  </th>
                  <th className="px-2 py-3">
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("subtype")}>
                      {getSubtypeLabel(productTypeFilter)} <span>{getSortArrow("subtype")}</span>
                    </button>
                  </th>
                  <th className="px-2 py-3">
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("inflow")}>
                      Inflow <span>{getSortArrow("inflow")}</span>
                    </button>
                  </th>
                  <th className="px-2 py-3">
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("outflow")}>
                      Outflow <span>{getSortArrow("outflow")}</span>
                    </button>
                  </th>
                  <th className="px-2 py-3">
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("stock")}>
                      Stock <span>{getSortArrow("stock")}</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedRows.map((row) => (
                  <tr key={row.id} className="text-slate-700 transition-colors hover:bg-slate-50">
                    <td className="px-2 py-3">
                      <input
                        type="checkbox"
                        checked={selectedSyncSkus.includes(row.sku)}
                        onChange={(e) => toggleSkuSelection(row.sku, e.target.checked)}
                        aria-label={`Select ${row.sku}`}
                      />
                    </td>
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
