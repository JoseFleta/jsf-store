"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type MovementType = "purchase" | "sale";
type ProductType = "ropa" | "maquetas" | "accesorios";
type ProductTypeFilter = "all" | ProductType;
type SortDirection = "asc" | "desc";
type MovementSortKey = "date" | "product" | "type" | "subtype" | "qty" | "amount" | "channel";

type StockMovementsPageProps = {
  movementType: MovementType;
  pageTitle: string;
  pageSubtitle: string;
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
  created_at: string;
  products: ProductRow | ProductRow[] | null;
};

type MovementDbRow = Omit<MovementRow, "products">;

type CsvMovementInput = {
  occurred_on: string;
  sku: string;
  quantity: number;
  total_amount: number;
  channel: string | null;
};

const CACHE_VERSION = "v1";
const MOVEMENT_ROWS_CACHE_PREFIX = `stock_movements_rows_${CACHE_VERSION}`;
const PRODUCTS_META_CACHE_PREFIX = `stock_products_meta_${CACHE_VERSION}`;
const ACTIVE_PRODUCTS_CACHE_PREFIX = `stock_active_products_${CACHE_VERSION}`;

function readCache<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors and keep runtime behavior.
  }
}

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
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(value);
}

function escapeCsvValue(value: string | number | boolean | null | undefined): string {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatRangeLabel(range: DateRange | undefined): string {
  if (!range?.from && !range?.to) return "Select range";
  const fmt = new Intl.DateTimeFormat("en-GB");
  if (range.from && range.to) return `${fmt.format(range.from)} - ${fmt.format(range.to)}`;
  if (range.from) return `${fmt.format(range.from)} - ...`;
  return "...";
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
    return { rows: [], errors: ["Empty CSV file."] };
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
  const supplierIdx = header.indexOf("supplier");
  const proveedorIdx = header.indexOf("proveedor");
  const channelAliasIdx = channelIdx >= 0 ? channelIdx : cpIdx >= 0 ? cpIdx : supplierIdx >= 0 ? supplierIdx : proveedorIdx;

  if (dateIdx < 0 || skuIdx < 0 || qtyIdx < 0 || amountIdx < 0) {
    return {
      rows: [],
      errors: ["The file must include: date, sku, quantity, total_amount (CSV or TSV)."],
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
      errors.push(`Row ${i + 1}: date, sku, quantity, and total_amount are required.`);
      continue;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`Row ${i + 1}: quantity must be greater than 0.`);
      continue;
    }
    if (!Number.isFinite(total_amount) || total_amount < 0) {
      errors.push(`Row ${i + 1}: total_amount must be 0 or greater.`);
      continue;
    }

    rows.push({
      occurred_on,
      sku,
      quantity,
      total_amount,
      channel: channelAliasIdx >= 0 ? (cols[channelAliasIdx] || "").trim() || null : null,
    });
  }

  return { rows, errors };
}

export default function StockMovementsPage(props: StockMovementsPageProps) {
  const { movementType, pageTitle, pageSubtitle } = props;

  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [productMeta, setProductMeta] = useState<ProductRow[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState(searchParams.get("store") || "");
  const [rows, setRows] = useState<MovementRow[]>([]);

  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [channel, setChannel] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [isDateRangeOpen, setIsDateRangeOpen] = useState(false);
  const dateRangePopoverRef = useRef<HTMLDivElement | null>(null);
  const [channelFilter, setChannelFilter] = useState("all");
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>("all");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: MovementSortKey; direction: SortDirection } | null>({
    key: "date",
    direction: "desc",
  });
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editOccurredOn, setEditOccurredOn] = useState("");
  const [editProductId, setEditProductId] = useState("");
  const [editQuantity, setEditQuantity] = useState("");
  const [editTotalAmount, setEditTotalAmount] = useState("");
  const [editChannel, setEditChannel] = useState("");

  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);

  const rowsCacheKey = useMemo(
    () => (selectedStoreId ? `${MOVEMENT_ROWS_CACHE_PREFIX}:${selectedStoreId}:${movementType}` : ""),
    [selectedStoreId, movementType]
  );
  const metaCacheKey = useMemo(
    () => (selectedStoreId ? `${PRODUCTS_META_CACHE_PREFIX}:${selectedStoreId}` : ""),
    [selectedStoreId]
  );
  const activeProductsCacheKey = useMemo(
    () => (selectedStoreId ? `${ACTIVE_PRODUCTS_CACHE_PREFIX}:${selectedStoreId}` : ""),
    [selectedStoreId]
  );

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

    const loadProductMeta = async () => {
      if (!selectedStoreId) {
        setProductMeta([]);
        return;
      }

      const cached = readCache<ProductRow[]>(metaCacheKey);
      if (cached) {
        setProductMeta(cached);
        return;
      }

      const { data, error } = await supabase
        .from("products")
        .select("id,sku,name,title,product_type,escala,clothing_type,accessory_type")
        .eq("store_id", selectedStoreId);

      if (cancelled) return;

      if (error) {
        setMsg(error.message);
        setProductMeta([]);
        return;
      }

      const nextMeta = (data ?? []) as ProductRow[];
      setProductMeta(nextMeta);
      writeCache(metaCacheKey, nextMeta);
    };

    loadProductMeta();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, supabase, metaCacheKey]);

  useEffect(() => {
    let cancelled = false;

    const loadActiveProducts = async () => {
      if (!selectedStoreId) {
        setProducts([]);
        setProductId("");
        return;
      }

      const cached = readCache<ProductRow[]>(activeProductsCacheKey);
      if (cached) {
        setProducts(cached);
        setProductId((prev) => prev || cached[0]?.id || "");
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
      writeCache(activeProductsCacheKey, list);
      setLoadingProducts(false);
    };

    loadActiveProducts();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, supabase, activeProductsCacheKey]);

  const productIndex = useMemo(() => {
    return new Map(productMeta.map((p) => [p.id, p]));
  }, [productMeta]);

  const hydrateRowsWithProducts = (rowsData: MovementDbRow[]): MovementRow[] => {
    return rowsData.map((row) => ({
      ...row,
      products: productIndex.get(row.product_id) || null,
    }));
  };

  const persistRows = (nextRows: MovementRow[]) => {
    setRows(nextRows);
    if (rowsCacheKey) writeCache(rowsCacheKey, nextRows);
  };

  useEffect(() => {
    let cancelled = false;

    const loadRows = async () => {
      if (!selectedStoreId) {
        setRows([]);
        return;
      }

      const cached = readCache<MovementRow[]>(rowsCacheKey);
      if (cached) {
        setRows(cached);
        return;
      }

      setLoadingRows(true);
      const { data, error } = await supabase
        .from("stock_movements")
        .select("id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,created_at")
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

      const hydrated = hydrateRowsWithProducts((data ?? []) as MovementDbRow[]);
      persistRows(hydrated);
      setLoadingRows(false);
    };

    loadRows();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, movementType, supabase, productIndex, rowsCacheKey]);

  const channelOptions = useMemo(() => {
    return Array.from(
      new Set(
        rows
          .map((row) => (row.channel || "").trim())
          .filter((value) => value.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const hasCompleteRange = Boolean(dateRange?.from && dateRange?.to);
    const dateFrom = hasCompleteRange && dateRange?.from ? toIsoDate(dateRange.from) : "";
    const dateTo = hasCompleteRange && dateRange?.to ? toIsoDate(dateRange.to) : "";

    return rows.filter((row) => {
      const sku = getProductSku(row.products).toLowerCase();
      const name = getProductName(row.products).toLowerCase();
      const ch = (row.channel || "").toLowerCase();
      const subtype = getProductSubtype(row.products, "all").toLowerCase();
      const type = getProductType(row.products);
      const typeMatch = productTypeFilter === "all" ? true : type === productTypeFilter;
      const channelMatch = channelFilter === "all" ? true : (row.channel || "").trim() === channelFilter;
      const fromMatch = !dateFrom || row.occurred_on >= dateFrom;
      const toMatch = !dateTo || row.occurred_on <= dateTo;
      return typeMatch && channelMatch && fromMatch && toMatch && (sku.includes(term) || name.includes(term) || ch.includes(term) || subtype.includes(term));
    });
  }, [rows, search, productTypeFilter, channelFilter, dateRange]);
  const hasActiveFilters =
    search.trim().length > 0 ||
    productTypeFilter !== "all" ||
    channelFilter !== "all" ||
    Boolean(dateRange?.from || dateRange?.to);

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const next = [...filteredRows];
    next.sort((a, b) => {
      let cmp = 0;
      if (sort.key === "date") cmp = compareText(a.occurred_on || "", b.occurred_on || "");
      if (sort.key === "product") cmp = compareText(getProductName(a.products), getProductName(b.products));
      if (sort.key === "type") cmp = compareText(getTypeLabel(getProductType(a.products) ?? "all"), getTypeLabel(getProductType(b.products) ?? "all"));
      if (sort.key === "subtype") cmp = compareText(getProductSubtype(a.products, productTypeFilter), getProductSubtype(b.products, productTypeFilter));
      if (sort.key === "qty") cmp = Number(a.quantity || 0) - Number(b.quantity || 0);
      if (sort.key === "amount") cmp = Number(a.unit_price || 0) - Number(b.unit_price || 0);
      if (sort.key === "channel") cmp = compareText(a.channel || "", b.channel || "");
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return next;
  }, [filteredRows, sort, productTypeFilter]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => (productTypeFilter === "all" ? true : p.product_type === productTypeFilter));
  }, [products, productTypeFilter]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [selectedStoreId, search, pageSize, productTypeFilter, dateRange, channelFilter]);

  useEffect(() => {
    if (!isDateRangeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = dateRangePopoverRef.current;
      if (!node) return;
      if (event.target instanceof Node && !node.contains(event.target)) {
        setIsDateRangeOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isDateRangeOpen]);

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
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, page, pageSize]);

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

  const toggleSort = (key: MovementSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, direction: "asc" };
      return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
    });
  };

  const getSortArrow = (key: MovementSortKey) => {
    if (!sort || sort.key !== key) return "↕";
    return sort.direction === "asc" ? "↑" : "↓";
  };

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
      })
      .select("id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,created_at")
      .single();
    setSaving(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    const newRow = hydrateRowsWithProducts([data as MovementDbRow])[0];
    persistRows([newRow, ...rows]);
    setQuantity("");
    setTotalAmount("");
    setChannel("");
    setIsCreateModalOpen(false);
    setMsg(movementType === "purchase" ? "Purchase added." : "Sale added.");
  };

  const downloadCsvTemplate = () => {
    const sample = [
      movementType === "purchase"
        ? "date,sku,quantity,total_amount,supplier"
        : "date,sku,quantity,total_amount,channel",
      movementType === "purchase"
        ? "2026-02-06,AAS-TEST-001,10,255.00,Supplier XYZ"
        : "2026-02-06,AAS-TEST-001,2,79.98,Mercado Libre",
    ].join("\n");

    const blob = new Blob([sample], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = movementType === "purchase" ? "plantilla_compras.csv" : "plantilla_ventas.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadFilteredRowsCsv = () => {
    const headers = ["date", "sku", "product", "type", "type_detail", "quantity", "total_amount", "channel"];
    const lines = sortedRows.map((row) =>
      [
        row.occurred_on,
        getProductSku(row.products),
        getProductName(row.products),
        getProductType(row.products) || "",
        getProductSubtype(row.products, "all"),
        Number(row.quantity || 0).toFixed(0),
        Number(row.unit_price || 0),
        row.channel || "",
      ]
        .map((value) => escapeCsvValue(value))
        .join(","),
    );
    const csv = [headers.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = movementType === "purchase" ? "purchases_export.csv" : "sales_export.csv";
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
      setMsg(`Invalid CSV: ${parsed.errors.length} error(s).`);
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
          missingSkuErrors.push(`Row ${index + 2}: sku not found in this store (${row.sku}).`);
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
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    if (missingSkuErrors.length > 0) {
      setImporting(false);
      setCsvErrors(missingSkuErrors);
      setMsg(`Invalid CSV: ${missingSkuErrors.length} SKU(s) not found.`);
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
      .select("id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,created_at")
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

    persistRows(hydrateRowsWithProducts((data ?? []) as MovementDbRow[]));
    setMsg(`Import complete: ${payload.length} rows processed.`);
    setIsImportModalOpen(false);
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
    setMsg("");
  };

  const cancelEditRow = () => {
    setEditingRowId(null);
    setEditOccurredOn("");
    setEditProductId("");
    setEditQuantity("");
    setEditTotalAmount("");
    setEditChannel("");
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
      })
      .eq("id", editingRowId)
      .eq("store_id", selectedStoreId)
      .eq("movement_type", movementType)
      .select("id,store_id,product_id,movement_type,quantity,unit_price,channel,occurred_on,created_at")
      .single();
    setSavingEdit(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    const updated = hydrateRowsWithProducts([data as MovementDbRow])[0];
    persistRows(rows.map((row) => (row.id === editingRowId ? updated : row)));
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

    persistRows(rows.filter((row) => row.id !== rowId));
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

    persistRows(rows.filter((row) => !selectedRowIds.includes(row.id)));
    setSelectedRowIds([]);
    setMsg("Records deleted.");
  };

  return (
    <section className="space-y-6">
      <header className="relative overflow-hidden rounded-[28px] border border-slate-300 bg-gradient-to-br from-slate-100 via-white to-blue-100 p-6 shadow-sm">
        <div className="absolute -right-14 -top-16 h-40 w-40 rounded-full bg-slate-300/30 blur-2xl" />
        <div className="absolute -bottom-14 left-20 h-36 w-36 rounded-full bg-blue-300/25 blur-2xl" />
        <div className="relative">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{pageTitle}</h1>
            <p className="mt-1 text-sm text-slate-500">{pageSubtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
              onClick={() => setIsCreateModalOpen(true)}
              disabled={!selectedStoreId || filteredProducts.length === 0}
            >
              Add new record
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 disabled:opacity-60"
              onClick={downloadFilteredRowsCsv}
              disabled={!selectedStoreId || filteredRows.length === 0}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 disabled:opacity-60"
              onClick={() => setIsImportModalOpen(true)}
              disabled={!selectedStoreId}
            >
              Import CSV
            </button>
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
                    setDateRange(undefined);
                    setProductTypeFilter("all");
                    setChannelFilter("all");
                    setSearch("");
                    setIsDateRangeOpen(false);
                  }}
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-6">
          <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {movementType === "sale" ? "Total sales" : "Total purchases"}
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{toCurrency(totals.amount)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Quantity</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{totals.qty.toFixed(0)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Date range</label>
            <div ref={dateRangePopoverRef} className="relative mt-2">
              <button
                type="button"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 pr-10 text-left text-sm text-slate-700"
                onClick={() => setIsDateRangeOpen((prev) => !prev)}
              >
                {formatRangeLabel(dateRange)}
              </button>
              {(dateRange?.from || dateRange?.to) && (
                <button
                  type="button"
                  aria-label="Clear date range"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-semibold leading-none text-slate-500 hover:text-slate-700"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDateRange(undefined);
                  }}
                >
                  x
                </button>
              )}
              {isDateRangeOpen && (
                <div className="absolute z-20 mt-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
                  <DayPicker
                    mode="range"
                    min={1}
                    selected={dateRange}
                    onSelect={(range, selectedDay) => {
                      if (dateRange?.from && dateRange?.to) {
                        setDateRange({ from: selectedDay, to: undefined });
                        return;
                      }
                      setDateRange(range);
                      if (range?.from && range?.to) setIsDateRangeOpen(false);
                    }}
                  />
                  <div className="mt-2 flex justify-between">
                    <button
                      type="button"
                      className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                      onClick={() => setDateRange(undefined)}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                      onClick={() => setIsDateRangeOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/85 px-4 py-3">
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
          <div className="rounded-2xl border border-slate-200 bg-white/85 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Search</label>
            <input
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              placeholder="Product, type detail, or channel"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/85 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Channel</label>
            <select
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
            >
              <option value="all">All channels</option>
              {channelOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
        </div>
      </header>

      <article className="rounded-3xl border border-slate-300 bg-gradient-to-b from-white to-slate-50/60 p-6 shadow-sm">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{pageTitle}</h2>
              <p className="mt-1 text-sm text-slate-500">Date, product, quantity and price.</p>
            </div>
            <div className="flex items-end gap-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">{selectedRowIds.length} selected</p>
                <div className="mt-1 flex gap-2">
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
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("date")}>
                        Date <span>{getSortArrow("date")}</span>
                      </button>
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
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("qty")}>
                        Qty <span>{getSortArrow("qty")}</span>
                      </button>
                    </th>
                    <th className="px-2 py-3">
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("amount")}>
                        Total amount <span>{getSortArrow("amount")}</span>
                      </button>
                    </th>
                    <th className="px-2 py-3">
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("channel")}>
                        Channel <span>{getSortArrow("channel")}</span>
                      </button>
                    </th>
                    <th className="px-2 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedRows.map((row) => {
                    const isEditing = editingRowId === row.id;
                    const qty = Number(row.quantity || 0);
                    const totalAmountValue = Number(row.unit_price || 0);
                    return (
                    <tr key={row.id} className="text-slate-700 transition-colors hover:bg-slate-50">
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
                            qty.toFixed(0)
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

      {msg && <p className="text-sm text-slate-600">{msg}</p>}

      {isCreateModalOpen && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-4"
          onClick={() => setIsCreateModalOpen(false)}
        >
          <article
            className="mx-auto my-6 w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Add new record</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {movementType === "purchase" ? "Complete purchase details." : "Complete sale details."}
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                onClick={() => setIsCreateModalOpen(false)}
              >
                Close
              </button>
            </div>

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
                <label className="text-sm font-medium text-slate-700">{movementType === "purchase" ? "Supplier" : "Channel"}</label>
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder={movementType === "purchase" ? "Supplier" : "Marketplace / channel"}
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
        </div>
      )}

      {isImportModalOpen && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-4"
          onClick={() => setIsImportModalOpen(false)}
        >
          <article
            className="mx-auto my-6 w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Import CSV</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {movementType === "purchase"
                    ? "Required: date, sku, quantity, total_amount. Optional: supplier."
                    : "Required: date, sku, quantity, total_amount. Optional: channel."}
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                onClick={() => setIsImportModalOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:border-indigo-200 hover:text-indigo-700"
                onClick={downloadCsvTemplate}
              >
                Download template
              </button>
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
        </div>
      )}

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
