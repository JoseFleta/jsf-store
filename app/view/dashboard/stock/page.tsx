"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type ProductType = "ropa" | "maquetas" | "accesorios";
type ProductTypeFilter = "all" | ProductType;

type StoreRow = {
  store_id: string;
  stores: { name: string } | { name: string }[] | null;
};

type StoreOption = {
  id: string;
  name: string;
};

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
  if (type === "ropa") return "Ropa";
  if (type === "maquetas") return "Maquetas";
  if (type === "accesorios") return "Accesorios";
  return "Todos";
}

function getSubtypeLabel(type: ProductTypeFilter): string {
  if (type === "maquetas") return "Escala";
  if (type === "ropa") return "Tipo de ropa";
  if (type === "accesorios") return "Tipo de accesorio";
  return "Detalle tipo";
}

function getSubtypeValue(product: ProductRow, typeFilter: ProductTypeFilter): string {
  const type = typeFilter === "all" ? product.product_type : typeFilter;
  if (type === "maquetas") return product.escala || "-";
  if (type === "ropa") return product.clothing_type || "-";
  if (type === "accesorios") return product.accessory_type || "-";
  return "-";
}

export default function StockPage() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);

  const [search, setSearch] = useState("");
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>("all");
  const [onlyActive, setOnlyActive] = useState(true);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadStores = async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!userRes.user) {
        router.push("/view/login");
        return;
      }

      const { data, error } = await supabase
        .from("store_memberships")
        .select("store_id, stores(name)")
        .eq("user_id", userRes.user.id);

      if (cancelled) return;
      if (error) {
        setMsg(error.message);
        setLoading(false);
        return;
      }

      const options = (data as StoreRow[]).map((row) => {
        const rel = row.stores;
        const name = Array.isArray(rel) ? rel[0]?.name : rel?.name;
        return { id: row.store_id, name: name || "Store" };
      });

      setStores(options);
      setSelectedStoreId((prev) => prev || options[0]?.id || "");
      setLoading(false);
    };

    loadStores();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      if (!selectedStoreId) return;
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
      const activeMatch = onlyActive ? r.is_active : true;
      const subtype = getSubtypeValue(r, "all").toLowerCase();
      const textMatch =
        !term ||
        r.sku.toLowerCase().includes(term) ||
        r.name.toLowerCase().includes(term) ||
        subtype.includes(term);
      return typeMatch && activeMatch && textMatch;
    });
  }, [stockRows, search, productTypeFilter, onlyActive]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [search, productTypeFilter, onlyActive, selectedStoreId, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

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

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Stock</h1>
        <p className="mt-1 text-sm text-slate-500">Stock calculado automaticamente desde Compras y Ventas.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Entradas</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.inQty.toFixed(2)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Salidas</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.outQty.toFixed(2)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Stock actual</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.stock.toFixed(2)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Tienda</label>
            <select
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={selectedStoreId}
              onChange={(e) => setSelectedStoreId(e.target.value)}
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <input
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            placeholder="Buscar por SKU, nombre o detalle"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            value={productTypeFilter}
            onChange={(e) => setProductTypeFilter(e.target.value as ProductTypeFilter)}
          >
            <option value="all">Todos</option>
            <option value="maquetas">Maquetas</option>
            <option value="ropa">Ropa</option>
            <option value="accesorios">Accesorios</option>
          </select>
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
            Solo activos
          </label>
          <select
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>

        {loading ? (
          <p className="mt-6 text-sm text-slate-500">Cargando stock...</p>
        ) : paginatedRows.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No hay resultados para este filtro.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-3">SKU</th>
                  <th className="px-2 py-3">Producto</th>
                  <th className="px-2 py-3">Tipo</th>
                  <th className="px-2 py-3">{getSubtypeLabel(productTypeFilter)}</th>
                  <th className="px-2 py-3">Entradas</th>
                  <th className="px-2 py-3">Salidas</th>
                  <th className="px-2 py-3">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedRows.map((row) => (
                  <tr key={row.id} className="text-slate-700">
                    <td className="px-2 py-3 font-medium">{row.sku}</td>
                    <td className="px-2 py-3">{row.name}</td>
                    <td className="px-2 py-3">{getTypeLabel(row.product_type)}</td>
                    <td className="px-2 py-3">{getSubtypeValue(row, productTypeFilter)}</td>
                    <td className="px-2 py-3">{row.inQty.toFixed(2)}</td>
                    <td className="px-2 py-3">{row.outQty.toFixed(2)}</td>
                    <td className="px-2 py-3 font-semibold">{row.stock.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <p>Pagina {page} de {totalPages}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-full border border-slate-200 px-3 py-1 font-semibold disabled:opacity-50"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1}
            >
              Anterior
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-200 px-3 py-1 font-semibold disabled:opacity-50"
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={page >= totalPages}
            >
              Siguiente
            </button>
          </div>
        </div>
      </article>

      {msg && <p className="text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
