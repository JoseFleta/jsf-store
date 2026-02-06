"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
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

type CsvMovementInput = {
  occurred_on: string;
  sku: string;
  quantity: number;
  unit_price: number;
  counterparty: string | null;
  reference: string | null;
  notes: string | null;
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

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function parseCsvMovements(text: string): { rows: CsvMovementInput[]; errors: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: ["CSV vacio."] };
  }

  const delimiter = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const header = parseDelimitedLine(lines[0], delimiter).map((v) => v.toLowerCase());

  const dateIdx = header.indexOf("date") >= 0 ? header.indexOf("date") : header.indexOf("occurred_on");
  const skuIdx = header.indexOf("sku");
  const qtyIdx = header.indexOf("quantity") >= 0 ? header.indexOf("quantity") : header.indexOf("qty");
  const priceIdx = header.indexOf("unit_price") >= 0 ? header.indexOf("unit_price") : header.indexOf("price");
  const cpIdx = header.indexOf("counterparty");
  const refIdx = header.indexOf("reference");
  const notesIdx = header.indexOf("notes");

  if (dateIdx < 0 || skuIdx < 0 || qtyIdx < 0 || priceIdx < 0) {
    return {
      rows: [],
      errors: ["El archivo debe incluir: date, sku, quantity, unit_price (acepta CSV o TSV)."],
    };
  }

  const rows: CsvMovementInput[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseDelimitedLine(lines[i], delimiter);
    const occurred_on = (cols[dateIdx] || "").trim();
    const sku = (cols[skuIdx] || "").trim().toUpperCase();
    const qtyRaw = (cols[qtyIdx] || "").trim();
    const priceRaw = (cols[priceIdx] || "").trim();
    const quantity = Number(qtyRaw);
    const unit_price = Number(priceRaw);

    if (!occurred_on || !sku || !qtyRaw || !priceRaw) {
      errors.push(`Fila ${i + 1}: date, sku, quantity y unit_price son obligatorios.`);
      continue;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`Fila ${i + 1}: quantity debe ser mayor a 0.`);
      continue;
    }
    if (!Number.isFinite(unit_price) || unit_price < 0) {
      errors.push(`Fila ${i + 1}: unit_price debe ser 0 o mayor.`);
      continue;
    }

    rows.push({
      occurred_on,
      sku,
      quantity,
      unit_price,
      counterparty: cpIdx >= 0 ? (cols[cpIdx] || "").trim() || null : null,
      reference: refIdx >= 0 ? (cols[refIdx] || "").trim() || null : null,
      notes: notesIdx >= 0 ? (cols[notesIdx] || "").trim() || null : null,
    });
  }

  return { rows, errors };
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
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);

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
    setCsvErrors([]);

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

  const downloadCsvTemplate = () => {
    const sample = [
      "date,sku,quantity,unit_price,counterparty,reference,notes",
      movementType === "purchase"
        ? "2026-02-06,AAS-TEST-001,10,25.50,Supplier XYZ,INV-1001,Initial stock"
        : "2026-02-06,AAS-TEST-001,2,39.99,Customer ABC,SO-2001,Online sale",
    ].join("\n");

    const blob = new Blob([sample], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = movementType === "purchase" ? "plantilla_compras.csv" : "plantilla_ventas.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg("");
    setCsvErrors([]);

    if (!selectedStoreId) {
      setMsg("Select a store before importing.");
      e.target.value = "";
      return;
    }

    setImporting(true);
    const text = await file.text();
    const parsed = parseCsvMovements(text);

    if (parsed.errors.length > 0) {
      setImporting(false);
      setCsvErrors(parsed.errors);
      setMsg(`CSV invalido: ${parsed.errors.length} errores.`);
      e.target.value = "";
      return;
    }
    if (parsed.rows.length === 0) {
      setImporting(false);
      setMsg("No valid rows to import.");
      e.target.value = "";
      return;
    }

    const skuToProductId = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]));
    const missingSkuErrors: string[] = [];
    const payload = parsed.rows
      .map((row, index) => {
        const product_id = skuToProductId.get(row.sku);
        if (!product_id) {
          missingSkuErrors.push(`Fila ${index + 2}: sku no existe en la tienda (${row.sku}).`);
          return null;
        }
        return {
          store_id: selectedStoreId,
          product_id,
          movement_type: movementType,
          quantity: row.quantity,
          unit_price: row.unit_price,
          occurred_on: row.occurred_on,
          counterparty: row.counterparty,
          reference: row.reference,
          notes: row.notes,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    if (missingSkuErrors.length > 0) {
      setImporting(false);
      setCsvErrors(missingSkuErrors);
      setMsg(`CSV invalido: ${missingSkuErrors.length} SKU(s) no encontrados.`);
      e.target.value = "";
      return;
    }

    const chunkSize = 500;
    for (let start = 0; start < payload.length; start += chunkSize) {
      const chunk = payload.slice(start, start + chunkSize);
      const { error } = await supabase.from("stock_movements").insert(chunk);
      if (error) {
        setImporting(false);
        setMsg(error.message);
        e.target.value = "";
        return;
      }
    }

    const { data, error } = await supabase
      .from("stock_movements")
      .select(
        "id,store_id,product_id,movement_type,quantity,unit_price,occurred_on,reference,counterparty,notes,created_at,products(id,sku,name,title)"
      )
      .eq("store_id", selectedStoreId)
      .eq("movement_type", movementType)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false });

    setImporting(false);
    e.target.value = "";

    if (error) {
      setMsg(error.message);
      return;
    }

    setRows((data ?? []) as MovementRow[]);
    setMsg(`Import complete: ${payload.length} rows processed.`);
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

          <div className="mt-6 border-t border-slate-200 pt-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">Import CSV</h3>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:border-indigo-200 hover:text-indigo-700"
                onClick={downloadCsvTemplate}
              >
                Download template
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Required columns: date, sku, quantity, unit_price. Optional: counterparty, reference, notes.
            </p>
            <input
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
              type="file"
              accept=".csv,text/csv"
              onChange={handleImportCsv}
              disabled={importing || !selectedStoreId}
            />
            {importing && <p className="text-xs text-slate-500">Importing...</p>}
          </div>
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

      {csvErrors.length > 0 && (
        <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <h3 className="text-sm font-semibold text-rose-800">CSV errors ({csvErrors.length})</h3>
          <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-rose-200 bg-white p-3">
            <ul className="space-y-1 text-xs text-rose-700">
              {csvErrors.map((error, idx) => (
                <li key={`${idx}-${error}`}>{error}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </section>
  );
}
