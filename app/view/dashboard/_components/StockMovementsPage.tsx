"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type MovementType = "purchase" | "sale";
type ProductType = "ropa" | "maquetas" | "accesorios";
type ProductTypeFilter = "all" | ProductType;

type StockMovementsPageProps = {
  movementType: MovementType;
  pageTitle: string;
  pageSubtitle: string;
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
  product_type?: ProductType | null;
  escala?: string | null;
  clothing_type?: string | null;
  accessory_type?: string | null;
};

type MovementRow = {
  id: string;
  store_id: string;
  product_id: string;
  movement_type: MovementType;
  quantity: number;
  unit_price: number;
  channel: string | null;
  occurred_on: string;
  reference: string | null;
  notes: string | null;
  created_at: string;
  products: ProductRow | ProductRow[] | null;
};

type CsvMovementInput = {
  occurred_on: string;
  sku: string;
  quantity: number;
  total_amount: number;
  channel: string | null;
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

function getProductType(product: ProductRow | ProductRow[] | null): ProductType | null {
  const p = Array.isArray(product) ? product[0] : product;
  if (!p?.product_type) return null;
  if (p.product_type === "ropa" || p.product_type === "maquetas" || p.product_type === "accesorios") return p.product_type;
  return null;
}

function getProductSubtype(product: ProductRow | ProductRow[] | null, typeFilter: ProductTypeFilter): string {
  const p = Array.isArray(product) ? product[0] : product;
  if (!p) return "-";
  const productType = typeFilter === "all" ? getProductType(p) : typeFilter;
  if (productType === "maquetas") return p.escala || "-";
  if (productType === "ropa") return p.clothing_type || "-";
  if (productType === "accesorios") return p.accessory_type || "-";
  return "-";
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
  const amountIdx =
    header.indexOf("total_amount") >= 0
      ? header.indexOf("total_amount")
      : header.indexOf("unit_price") >= 0
      ? header.indexOf("unit_price")
      : header.indexOf("price");
  const channelIdx = header.indexOf("channel");
  const cpIdx = header.indexOf("counterparty");
  const supplierIdx = header.indexOf("proveedor");
  const channelAliasIdx = channelIdx >= 0 ? channelIdx : cpIdx >= 0 ? cpIdx : supplierIdx;
  const refIdx = header.indexOf("reference");
  const notesIdx = header.indexOf("notes");

  if (dateIdx < 0 || skuIdx < 0 || qtyIdx < 0 || amountIdx < 0) {
    return {
      rows: [],
      errors: ["El archivo debe incluir: date, sku, quantity, total_amount (acepta CSV o TSV)."],
    };
  }

  const rows: CsvMovementInput[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseDelimitedLine(lines[i], delimiter);
    const occurred_on = (cols[dateIdx] || "").trim();
    const sku = (cols[skuIdx] || "").trim().toUpperCase();
    const qtyRaw = (cols[qtyIdx] || "").trim();
    const amountRaw = (cols[amountIdx] || "").trim();
    const quantity = Number(qtyRaw);
    const total_amount = Number(amountRaw);

    if (!occurred_on || !sku || !qtyRaw || !amountRaw) {
      errors.push(`Fila ${i + 1}: date, sku, quantity y total_amount son obligatorios.`);
      continue;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`Fila ${i + 1}: quantity debe ser mayor a 0.`);
      continue;
    }
    if (!Number.isFinite(total_amount) || total_amount < 0) {
      errors.push(`Fila ${i + 1}: total_amount debe ser 0 o mayor.`);
      continue;
    }

    rows.push({
      occurred_on,
      sku,
      quantity,
      total_amount,
      channel: channelAliasIdx >= 0 ? (cols[channelAliasIdx] || "").trim() || null : null,
      reference: refIdx >= 0 ? (cols[refIdx] || "").trim() || null : null,
      notes: notesIdx >= 0 ? (cols[notesIdx] || "").trim() || null : null,
    });
  }

  return { rows, errors };
}

export default function StockMovementsPage(props: StockMovementsPageProps) {
  const { movementType, pageTitle, pageSubtitle } = props;

  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [rows, setRows] = useState<MovementRow[]>([]);

  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [reference, setReference] = useState("");
  const [channel, setChannel] = useState("");
  const [notes, setNotes] = useState("");

  const [search, setSearch] = useState("");
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>("all");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editOccurredOn, setEditOccurredOn] = useState("");
  const [editProductId, setEditProductId] = useState("");
  const [editQuantity, setEditQuantity] = useState("");
  const [editTotalAmount, setEditTotalAmount] = useState("");
  const [editChannel, setEditChannel] = useState("");
  const [editReference, setEditReference] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const [bulkOccurredOn, setBulkOccurredOn] = useState("");
  const [bulkTotalAmount, setBulkTotalAmount] = useState("");
  const [bulkChannel, setBulkChannel] = useState("");
  const [bulkReference, setBulkReference] = useState("");
  const [bulkNotes, setBulkNotes] = useState("");

  const [loadingStores, setLoadingStores] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [bulkWorking, setBulkWorking] = useState(false);
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
        .select("id,sku,name,title,product_type,escala,clothing_type,accessory_type")
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
          "id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,reference,notes,created_at,products(id,sku,name,title,product_type,escala,clothing_type,accessory_type)"
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
    if (!term) {
      return rows.filter((row) => (productTypeFilter === "all" ? true : getProductType(row.products) === productTypeFilter));
    }

    return rows.filter((row) => {
      const sku = getProductSku(row.products).toLowerCase();
      const name = getProductName(row.products).toLowerCase();
      const ch = (row.channel || "").toLowerCase();
      const ref = (row.reference || "").toLowerCase();
      const subtype = getProductSubtype(row.products, "all").toLowerCase();
      const type = getProductType(row.products);
      const typeMatch = productTypeFilter === "all" ? true : type === productTypeFilter;
      return typeMatch && (sku.includes(term) || name.includes(term) || ch.includes(term) || ref.includes(term) || subtype.includes(term));
    });
  }, [rows, search, productTypeFilter]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => (productTypeFilter === "all" ? true : p.product_type === productTypeFilter));
  }, [products, productTypeFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [selectedStoreId, search, pageSize, productTypeFilter]);

  useEffect(() => {
    if (filteredProducts.length === 0) {
      setProductId("");
      return;
    }
    if (!filteredProducts.some((p) => p.id === productId)) {
      setProductId(filteredProducts[0].id);
    }
  }, [filteredProducts, productId]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setSelectedRowIds([]);
    setEditingRowId(null);
  }, [selectedStoreId, movementType]);

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize]);

  const isAllCurrentPageSelected = useMemo(() => {
    return paginatedRows.length > 0 && paginatedRows.every((row) => selectedRowIds.includes(row.id));
  }, [paginatedRows, selectedRowIds]);

  const totals = useMemo(() => {
    let qty = 0;
    let amount = 0;
    for (const row of filteredRows) {
      qty += Number(row.quantity || 0);
      amount += Number(row.unit_price || 0);
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
    const amount = Number(totalAmount);

    if (!occurredOn) return setMsg("Date is required.");
    if (!Number.isFinite(qty) || qty <= 0) return setMsg("Quantity must be greater than 0.");
    if (!Number.isFinite(amount) || amount < 0) return setMsg("Total amount must be 0 or greater.");

    setSaving(true);
    const { data, error } = await supabase
      .from("stock_movements")
      .insert({
        store_id: selectedStoreId,
        product_id: productId,
        movement_type: movementType,
        quantity: qty,
        qty_change: movementType === "purchase" ? qty : -qty,
        unit_price: amount,
        channel: channel.trim() || null,
        occurred_on: occurredOn,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      })
      .select(
        "id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,reference,notes,created_at,products(id,sku,name,title,product_type,escala,clothing_type,accessory_type)"
      )
      .single();
    setSaving(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setRows((prev) => [data as MovementRow, ...prev]);
    setQuantity("");
    setTotalAmount("");
    setChannel("");
    setReference("");
    setNotes("");
    setMsg(movementType === "purchase" ? "Purchase added." : "Sale added.");
  };

  const downloadCsvTemplate = () => {
    const sample = [
      movementType === "purchase"
        ? "date,sku,quantity,total_amount,proveedor,reference,notes"
        : "date,sku,quantity,total_amount,channel,reference,notes",
      movementType === "purchase"
        ? "2026-02-06,AAS-TEST-001,10,255.00,Supplier XYZ,INV-1001,Initial stock"
        : "2026-02-06,AAS-TEST-001,2,79.98,Mercado Libre,SO-2001,Online sale",
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
          qty_change: movementType === "purchase" ? row.quantity : -row.quantity,
          unit_price: row.total_amount,
          channel: row.channel,
          occurred_on: row.occurred_on,
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
        "id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,reference,notes,created_at,products(id,sku,name,title,product_type,escala,clothing_type,accessory_type)"
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

  const toggleRowSelection = (rowId: string, checked: boolean) => {
    setSelectedRowIds((prev) => {
      if (checked) return prev.includes(rowId) ? prev : [...prev, rowId];
      return prev.filter((id) => id !== rowId);
    });
  };

  const toggleSelectCurrentPage = (checked: boolean) => {
    const pageIds = paginatedRows.map((row) => row.id);
    if (checked) {
      setSelectedRowIds((prev) => Array.from(new Set([...prev, ...pageIds])));
      return;
    }
    setSelectedRowIds((prev) => prev.filter((id) => !pageIds.includes(id)));
  };

  const startEditRow = (row: MovementRow) => {
    setEditingRowId(row.id);
    setEditOccurredOn(row.occurred_on);
    setEditProductId(row.product_id);
    setEditQuantity(String(row.quantity));
    setEditTotalAmount(String(row.unit_price));
    setEditChannel(row.channel || "");
    setEditReference(row.reference || "");
    setEditNotes(row.notes || "");
    setMsg("");
  };

  const cancelEditRow = () => {
    setEditingRowId(null);
    setEditOccurredOn("");
    setEditProductId("");
    setEditQuantity("");
    setEditTotalAmount("");
    setEditChannel("");
    setEditReference("");
    setEditNotes("");
  };

  const handleSaveRowEdit = async () => {
    if (!editingRowId || !selectedStoreId) return;
    const qty = Number(editQuantity);
    const amount = Number(editTotalAmount);
    if (!editOccurredOn) return setMsg("Date is required.");
    if (!editProductId) return setMsg("Product is required.");
    if (!Number.isFinite(qty) || qty <= 0) return setMsg("Quantity must be greater than 0.");
    if (!Number.isFinite(amount) || amount < 0) return setMsg("Total amount must be 0 or greater.");

    setSavingEdit(true);
    const { data, error } = await supabase
      .from("stock_movements")
      .update({
        occurred_on: editOccurredOn,
        product_id: editProductId,
        quantity: qty,
        qty_change: movementType === "purchase" ? qty : -qty,
        unit_price: amount,
        channel: editChannel.trim() || null,
        reference: editReference.trim() || null,
        notes: editNotes.trim() || null,
      })
      .eq("id", editingRowId)
      .eq("store_id", selectedStoreId)
      .eq("movement_type", movementType)
      .select(
        "id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,reference,notes,created_at,products(id,sku,name,title,product_type,escala,clothing_type,accessory_type)"
      )
      .single();
    setSavingEdit(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setRows((prev) => prev.map((row) => (row.id === editingRowId ? (data as MovementRow) : row)));
    cancelEditRow();
    setMsg("Record updated.");
  };

  const handleDeleteRow = async (rowId: string) => {
    if (!selectedStoreId) return;
    const confirmed = window.confirm("Delete this record?");
    if (!confirmed) return;

    const { error } = await supabase.from("stock_movements").delete().eq("id", rowId).eq("store_id", selectedStoreId).eq("movement_type", movementType);
    if (error) {
      setMsg(error.message);
      return;
    }

    setRows((prev) => prev.filter((row) => row.id !== rowId));
    setSelectedRowIds((prev) => prev.filter((id) => id !== rowId));
    setMsg("Record deleted.");
  };

  const handleBulkDelete = async () => {
    if (!selectedStoreId || selectedRowIds.length === 0) return;
    const confirmed = window.confirm(`Delete ${selectedRowIds.length} record(s)?`);
    if (!confirmed) return;

    setBulkWorking(true);
    const { error } = await supabase
      .from("stock_movements")
      .delete()
      .eq("store_id", selectedStoreId)
      .eq("movement_type", movementType)
      .in("id", selectedRowIds);
    setBulkWorking(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setRows((prev) => prev.filter((row) => !selectedRowIds.includes(row.id)));
    setSelectedRowIds([]);
    setMsg("Records deleted.");
  };

  const handleBulkEdit = async () => {
    if (!selectedStoreId || selectedRowIds.length === 0) return;

    const patch: Record<string, unknown> = {};
    if (bulkOccurredOn.trim()) patch.occurred_on = bulkOccurredOn.trim();
    if (bulkTotalAmount.trim()) {
      const amount = Number(bulkTotalAmount);
      if (!Number.isFinite(amount) || amount < 0) return setMsg("Total amount must be 0 or greater.");
      patch.unit_price = amount;
    }
    if (bulkChannel.trim()) patch.channel = bulkChannel.trim();
    if (bulkReference.trim()) patch.reference = bulkReference.trim();
    if (bulkNotes.trim()) patch.notes = bulkNotes.trim();

    if (Object.keys(patch).length === 0) {
      setMsg("Fill at least one bulk field.");
      return;
    }

    setBulkWorking(true);
    const { error } = await supabase
      .from("stock_movements")
      .update(patch)
      .eq("store_id", selectedStoreId)
      .eq("movement_type", movementType)
      .in("id", selectedRowIds);
    setBulkWorking(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setRows((prev) =>
      prev.map((row) => {
        if (!selectedRowIds.includes(row.id)) return row;
        return {
          ...row,
          occurred_on: (patch.occurred_on as string | undefined) ?? row.occurred_on,
          unit_price: (patch.unit_price as number | undefined) ?? row.unit_price,
          channel: (patch.channel as string | undefined) ?? row.channel,
          reference: (patch.reference as string | undefined) ?? row.reference,
          notes: (patch.notes as string | undefined) ?? row.notes,
        };
      })
    );

    setBulkOccurredOn("");
    setBulkTotalAmount("");
    setBulkChannel("");
    setBulkReference("");
    setBulkNotes("");
    setSelectedRowIds([]);
    setMsg("Records updated.");
  };

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">{pageTitle}</h1>
        <p className="mt-1 text-sm text-slate-500">{pageSubtitle}</p>

        <div className="mt-5 grid gap-4 md:grid-cols-5">
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
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Product type</label>
            <select
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={productTypeFilter}
              onChange={(e) => setProductTypeFilter(e.target.value as ProductTypeFilter)}
            >
              <option value="all">Todos</option>
              <option value="maquetas">Maquetas</option>
              <option value="ropa">Ropa</option>
              <option value="accesorios">Accesorios</option>
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
                disabled={loadingProducts || filteredProducts.length === 0}
              >
                {filteredProducts.map((p) => (
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
                <label className="text-sm font-medium text-slate-700">Total amount</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">Channel</label>
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder={movementType === "purchase" ? "Proveedor / canal" : "Marketplace / canal"}
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
              {movementType === "purchase"
                ? "Required columns: date, sku, quantity, total_amount. Optional: proveedor, reference, notes."
                : "Required columns: date, sku, quantity, total_amount. Optional: channel, reference, notes."}
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
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">{selectedRowIds.length} selected</p>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    className="rounded-full border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
                    onClick={handleBulkEdit}
                    disabled={selectedRowIds.length === 0 || bulkWorking}
                  >
                    Bulk edit
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 disabled:opacity-50"
                    onClick={handleBulkDelete}
                    disabled={selectedRowIds.length === 0 || bulkWorking}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Search</label>
                <input
                  className="mt-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  placeholder="SKU, product, channel, reference"
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

          <div className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-3">
            <input
              type="date"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              value={bulkOccurredOn}
              onChange={(e) => setBulkOccurredOn(e.target.value)}
              placeholder="Date"
            />
            <input
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              value={bulkTotalAmount}
              onChange={(e) => setBulkTotalAmount(e.target.value)}
              placeholder="Total amount"
            />
            {movementType === "sale" ? (
              <input
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                value={bulkChannel}
                onChange={(e) => setBulkChannel(e.target.value)}
                placeholder="Channel"
              />
            ) : (
              <div />
            )}
            <input
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              value={bulkChannel}
              onChange={(e) => setBulkChannel(e.target.value)}
              placeholder="Channel"
            />
            <input
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              value={bulkReference}
              onChange={(e) => setBulkReference(e.target.value)}
              placeholder="Reference"
            />
            <input
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              value={bulkNotes}
              onChange={(e) => setBulkNotes(e.target.value)}
              placeholder="Notes"
            />
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
                    <th className="px-2 py-3">
                      <input
                        type="checkbox"
                        checked={isAllCurrentPageSelected}
                        onChange={(e) => toggleSelectCurrentPage(e.target.checked)}
                        aria-label="Select page"
                      />
                    </th>
                    <th className="px-2 py-3">Date</th>
                    <th className="px-2 py-3">SKU</th>
                    <th className="px-2 py-3">Product</th>
                    <th className="px-2 py-3">Type</th>
                    <th className="px-2 py-3">{getSubtypeLabel(productTypeFilter)}</th>
                    <th className="px-2 py-3">Qty</th>
                    <th className="px-2 py-3">Total amount</th>
                    <th className="px-2 py-3">Channel</th>
                    <th className="px-2 py-3">Reference</th>
                    <th className="px-2 py-3">Notes</th>
                    <th className="px-2 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedRows.map((row) => {
                    const isEditing = editingRowId === row.id;
                    const qty = Number(row.quantity || 0);
                    const totalAmountValue = Number(row.unit_price || 0);
                    return (
                      <tr key={row.id} className="text-slate-700">
                        <td className="px-2 py-3">
                          <input
                            type="checkbox"
                            checked={selectedRowIds.includes(row.id)}
                            onChange={(e) => toggleRowSelection(row.id, e.target.checked)}
                            aria-label={`Select ${row.id}`}
                          />
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              type="date"
                              className="rounded-lg border border-slate-200 px-2 py-1"
                              value={editOccurredOn}
                              onChange={(e) => setEditOccurredOn(e.target.value)}
                            />
                          ) : (
                            row.occurred_on
                          )}
                        </td>
                        <td className="px-2 py-3 font-medium">{getProductSku(row.products)}</td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <select
                              className="rounded-lg border border-slate-200 px-2 py-1"
                              value={editProductId}
                              onChange={(e) => setEditProductId(e.target.value)}
                            >
                              {filteredProducts.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.sku} - {p.title || p.name || "Product"}
                                </option>
                              ))}
                            </select>
                          ) : (
                            getProductName(row.products)
                          )}
                        </td>
                        <td className="px-2 py-3">{getTypeLabel(getProductType(row.products) ?? "all")}</td>
                        <td className="px-2 py-3">{getProductSubtype(row.products, productTypeFilter)}</td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              className="w-24 rounded-lg border border-slate-200 px-2 py-1"
                              value={editQuantity}
                              onChange={(e) => setEditQuantity(e.target.value)}
                            />
                          ) : (
                            qty.toFixed(2)
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              className="w-24 rounded-lg border border-slate-200 px-2 py-1"
                              value={editTotalAmount}
                              onChange={(e) => setEditTotalAmount(e.target.value)}
                            />
                          ) : (
                            toCurrency(totalAmountValue)
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              className="w-28 rounded-lg border border-slate-200 px-2 py-1"
                              value={editChannel}
                              onChange={(e) => setEditChannel(e.target.value)}
                            />
                          ) : (
                            row.channel || "-"
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              className="w-28 rounded-lg border border-slate-200 px-2 py-1"
                              value={editReference}
                              onChange={(e) => setEditReference(e.target.value)}
                            />
                          ) : (
                            row.reference || "-"
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              className="w-28 rounded-lg border border-slate-200 px-2 py-1"
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                            />
                          ) : (
                            row.notes || "-"
                          )}
                        </td>
                        <td className="px-2 py-3">
                          <div className="flex gap-2">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  className="rounded-full bg-slate-900 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                                  onClick={handleSaveRowEdit}
                                  disabled={savingEdit}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="rounded-full border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700"
                                  onClick={cancelEditRow}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="rounded-full border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700"
                                  onClick={() => startEditRow(row)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="rounded-full border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700"
                                  onClick={() => handleDeleteRow(row.id)}
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
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
