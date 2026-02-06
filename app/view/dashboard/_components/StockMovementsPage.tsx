"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type MovementType = "purchase" | "sale";

type StockMovementsPageProps = {
  movementType: MovementType;
  pageTitle: string;
  pageSubtitle: string;
  counterpartyLabel: string;
};

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
};

type MovementRow = {
  id: string;
  store_id: string;
  product_id: string;
  movement_type: MovementType;
  quantity: number;
  unit_price: number;
  occurred_on: string;
  reference: string | null;
  counterparty: string | null;
  notes: string | null;
  created_at: string;
  products: ProductRow | ProductRow[] | null;
};

function getProductName(product: ProductRow | ProductRow[] | null): string {
  const p = Array.isArray(product) ? product[0] : product;
  if (!p) return "-";
  return p.title || p.name || "-";
}

function getProductSku(product: ProductRow | ProductRow[] | null): string {
  const p = Array.isArray(product) ? product[0] : product;
  return p?.sku || "-";
}

function toCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export default function StockMovementsPage(props: StockMovementsPageProps) {
  const { movementType, pageTitle, pageSubtitle, counterpartyLabel } = props;

  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [rows, setRows] = useState<MovementRow[]>([]);

  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [reference, setReference] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [notes, setNotes] = useState("");

  const [search, setSearch] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);

  const [loadingStores, setLoadingStores] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

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
        setLoadingStores(false);
        return;
      }

      const options = (data as StoreRow[]).map((row) => {
        const rel = row.stores;
        const name = Array.isArray(rel) ? rel[0]?.name : rel?.name;
        return { id: row.store_id, name: name || "Store" };
      });

      setStores(options);
      setSelectedStoreId((prev) => prev || options[0]?.id || "");
      setLoadingStores(false);
    };

    loadStores();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  useEffect(() => {
    let cancelled = false;

    const loadProducts = async () => {
      if (!selectedStoreId) {
        setProducts([]);
        setProductId("");
        return;
      }

      setLoadingProducts(true);
      const { data, error } = await supabase
        .from("products")
        .select("id,sku,name,title")
        .eq("store_id", selectedStoreId)
        .eq("is_active", true)
        .order("sku", { ascending: true });

      if (cancelled) return;

      if (error) {
        setMsg(error.message);
        setProducts([]);
        setLoadingProducts(false);
        return;
      }

      const list = (data ?? []) as ProductRow[];
      setProducts(list);
      setProductId((prev) => prev || list[0]?.id || "");
      setLoadingProducts(false);
    };

    loadProducts();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, supabase]);

  useEffect(() => {
    let cancelled = false;

    const loadRows = async () => {
      if (!selectedStoreId) {
        setRows([]);
        return;
      }

      setLoadingRows(true);
      const { data, error } = await supabase
        .from("stock_movements")
        .select(
          "id,store_id,product_id,movement_type,quantity,unit_price,occurred_on,reference,counterparty,notes,created_at,products(id,sku,name,title)"
        )
        .eq("store_id", selectedStoreId)
        .eq("movement_type", movementType)
        .order("occurred_on", { ascending: false })
        .order("created_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        setMsg(error.message);
        setRows([]);
        setLoadingRows(false);
        return;
      }

      setRows((data ?? []) as MovementRow[]);
      setLoadingRows(false);
    };

    loadRows();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, movementType, supabase]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;

    return rows.filter((row) => {
      const sku = getProductSku(row.products).toLowerCase();
      const name = getProductName(row.products).toLowerCase();
      const ref = (row.reference || "").toLowerCase();
      const cp = (row.counterparty || "").toLowerCase();
      return sku.includes(term) || name.includes(term) || ref.includes(term) || cp.includes(term);
    });
  }, [rows, search]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [selectedStoreId, search, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

  const totals = useMemo(() => {
    let qty = 0;
    let amount = 0;
    for (const row of filteredRows) {
      qty += Number(row.quantity || 0);
      amount += Number(row.quantity || 0) * Number(row.unit_price || 0);
    }
    return { qty, amount };
  }, [filteredRows]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!selectedStoreId) return setMsg("Select a store.");
    if (!productId) return setMsg("Select a product.");

    const qty = Number(quantity);
    const price = Number(unitPrice);

    if (!occurredOn) return setMsg("Date is required.");
    if (!Number.isFinite(qty) || qty <= 0) return setMsg("Quantity must be greater than 0.");
    if (!Number.isFinite(price) || price < 0) return setMsg("Unit price must be 0 or greater.");

    setSaving(true);
    const { data, error } = await supabase
      .from("stock_movements")
      .insert({
        store_id: selectedStoreId,
        product_id: productId,
        movement_type: movementType,
        quantity: qty,
        unit_price: price,
        occurred_on: occurredOn,
        reference: reference.trim() || null,
        counterparty: counterparty.trim() || null,
        notes: notes.trim() || null,
      })
      .select(
        "id,store_id,product_id,movement_type,quantity,unit_price,occurred_on,reference,counterparty,notes,created_at,products(id,sku,name,title)"
      )
      .single();
    setSaving(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setRows((prev) => [data as MovementRow, ...prev]);
    setQuantity("");
    setUnitPrice("");
    setReference("");
    setCounterparty("");
    setNotes("");
    setMsg(movementType === "purchase" ? "Purchase added." : "Sale added.");
  };

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">{pageTitle}</h1>
        <p className="mt-1 text-sm text-slate-500">{pageSubtitle}</p>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Records (filter)</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{filteredRows.length}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Qty (filter)</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.qty.toFixed(2)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Amount (filter)</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{toCurrency(totals.amount)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Store</label>
            <select
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={selectedStoreId}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              disabled={loadingStores || stores.length === 0}
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

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">New record</h2>

          <form className="mt-5 space-y-4" onSubmit={handleCreate}>
            <div>
              <label className="text-sm font-medium text-slate-700">Date</label>
              <input
                type="date"
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">Product</label>
              <select
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                disabled={loadingProducts || products.length === 0}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} - {p.title || p.name || "Product"}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-slate-700">Quantity</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Unit price</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">{counterpartyLabel}</label>
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                placeholder={movementType === "purchase" ? "Supplier" : "Customer"}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">Reference</label>
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Invoice, receipt, order number"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">Notes</label>
              <textarea
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
              disabled={saving || !selectedStoreId || !productId}
            >
              {saving ? "Saving..." : movementType === "purchase" ? "Add purchase" : "Add sale"}
            </button>
          </form>
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">History</h2>
              <p className="mt-1 text-sm text-slate-500">Date, SKU, product, quantity and price.</p>
            </div>
            <div className="flex items-end gap-3">
              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Search</label>
                <input
                  className="mt-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  placeholder="SKU, product, reference"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Per page</label>
                <select
                  className="ml-2 rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </div>
            </div>
          </div>

          {loadingRows ? (
            <p className="mt-6 text-sm text-slate-500">Loading records...</p>
          ) : paginatedRows.length === 0 ? (
            <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
              No records.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-2 py-3">Date</th>
                    <th className="px-2 py-3">SKU</th>
                    <th className="px-2 py-3">Product</th>
                    <th className="px-2 py-3">Qty</th>
                    <th className="px-2 py-3">Unit price</th>
                    <th className="px-2 py-3">Total</th>
                    <th className="px-2 py-3">{counterpartyLabel}</th>
                    <th className="px-2 py-3">Reference</th>
                    <th className="px-2 py-3">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedRows.map((row) => {
                    const qty = Number(row.quantity || 0);
                    const price = Number(row.unit_price || 0);
                    const total = qty * price;
                    return (
                      <tr key={row.id} className="text-slate-700">
                        <td className="px-2 py-3">{row.occurred_on}</td>
                        <td className="px-2 py-3 font-medium">{getProductSku(row.products)}</td>
                        <td className="px-2 py-3">{getProductName(row.products)}</td>
                        <td className="px-2 py-3">{qty.toFixed(2)}</td>
                        <td className="px-2 py-3">{toCurrency(price)}</td>
                        <td className="px-2 py-3">{toCurrency(total)}</td>
                        <td className="px-2 py-3">{row.counterparty || "-"}</td>
                        <td className="px-2 py-3">{row.reference || "-"}</td>
                        <td className="px-2 py-3">{row.notes || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
            <p>
              Page {page} of {totalPages}
            </p>
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
      </div>

      {msg && <p className="text-sm text-slate-600">{msg}</p>}
    </section>
  );
}
