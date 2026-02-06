"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
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
  store_id: string;
  sku: string;
  name?: string | null;
  title: string;
  product_type: ProductType;
  escala: string | null;
  clothing_type: string | null;
  accessory_type: string | null;
  catchy_phrase: string | null;
  is_active: boolean;
  created_at: string;
};

type CsvProduct = {
  sku: string;
  title: string;
  product_type: ProductType;
  escala: string | null;
  clothing_type: string | null;
  accessory_type: string | null;
  catchy_phrase: string | null;
  is_active: boolean;
};

const PRODUCT_TYPES: ProductType[] = ["ropa", "maquetas", "accesorios"];

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

function getProductSubtype(product: ProductRow, typeFilter: ProductTypeFilter): string {
  const targetType = typeFilter === "all" ? product.product_type : typeFilter;
  if (targetType === "maquetas") return product.escala || "-";
  if (targetType === "ropa") return product.clothing_type || "-";
  return product.accessory_type || "-";
}

function parseProductType(raw: string): ProductType | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "ropa" || normalized === "maquetas" || normalized === "accesorios") return normalized;
  return null;
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

function parseCsvProducts(csvText: string): { rows: CsvProduct[]; errors: string[] } {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: ["CSV vacio."] };
  }

  const delimiter = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const header = parseDelimitedLine(lines[0], delimiter).map((v) => v.toLowerCase());
  const skuIndex = header.indexOf("sku");
  const titleIndex = header.indexOf("title");
  const typeIndex = header.indexOf("product_type");
  const escalaIndex = header.indexOf("escala");
  const clothingTypeIndex = header.indexOf("clothing_type");
  const accessoryTypeIndex = header.indexOf("accessory_type");
  const phraseIndex = header.indexOf("catchy_phrase");
  const activeIndex = header.indexOf("is_active");

  if (skuIndex < 0 || titleIndex < 0) {
    return { rows: [], errors: ["El archivo debe incluir columnas sku,title (CSV o TSV)."] };
  }

  const rows: CsvProduct[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let lineNo = 1; lineNo < lines.length; lineNo += 1) {
    const cols = parseDelimitedLine(lines[lineNo], delimiter);
    const sku = (cols[skuIndex] || "").trim().toUpperCase();
    const title = (cols[titleIndex] || "").trim();
    const parsedType = typeIndex >= 0 ? parseProductType(cols[typeIndex] || "") : null;
    const productType = parsedType ?? "maquetas";
    const escalaRaw = escalaIndex >= 0 ? (cols[escalaIndex] || "").trim() : "";
    const clothingRaw = clothingTypeIndex >= 0 ? (cols[clothingTypeIndex] || "").trim() : "";
    const accessoryRaw = accessoryTypeIndex >= 0 ? (cols[accessoryTypeIndex] || "").trim() : "";
    const phraseRaw = phraseIndex >= 0 ? (cols[phraseIndex] || "").trim() : "";
    const activeRaw = activeIndex >= 0 ? (cols[activeIndex] || "").trim().toLowerCase() : "true";

    if (!sku || !title) {
      errors.push(`Fila ${lineNo + 1}: sku y title son obligatorios.`);
      continue;
    }

    if (typeIndex >= 0 && !parsedType) {
      errors.push(`Fila ${lineNo + 1}: product_type invalido. Usa ropa, maquetas o accesorios.`);
      continue;
    }

    if (seen.has(sku)) {
      errors.push(`Fila ${lineNo + 1}: sku repetido en el archivo (${sku}).`);
      continue;
    }
    seen.add(sku);

    const isActive = !(activeRaw === "false" || activeRaw === "0" || activeRaw === "no");

    rows.push({
      sku,
      title,
      product_type: productType,
      escala: productType === "maquetas" ? escalaRaw || null : null,
      clothing_type: productType === "ropa" ? clothingRaw || null : null,
      accessory_type: productType === "accesorios" ? accessoryRaw || null : null,
      catchy_phrase: phraseRaw || null,
      is_active: isActive,
    });
  }

  return { rows, errors };
}

function normalizeProductRow(row: Partial<ProductRow> & { id: string; store_id: string }): ProductRow {
  const normalizedTitle = (row.title ?? row.name ?? "").toString();
  const parsedType = parseProductType((row.product_type ?? "").toString()) ?? "maquetas";
  return {
    id: row.id,
    store_id: row.store_id,
    name: row.name ?? null,
    title: normalizedTitle,
    product_type: parsedType,
    escala: row.escala ?? null,
    clothing_type: row.clothing_type ?? null,
    accessory_type: row.accessory_type ?? null,
    catchy_phrase: row.catchy_phrase ?? null,
    is_active: Boolean(row.is_active),
    created_at: row.created_at ?? new Date().toISOString(),
    sku: (row.sku ?? "").toString(),
  };
}

export default function ProductsPage() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [stores, setStores] = useState<StoreOption[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>("");
  const [products, setProducts] = useState<ProductRow[]>([]);

  const [sku, setSku] = useState("");
  const [title, setTitle] = useState("");
  const [productType, setProductType] = useState<ProductType>("maquetas");
  const [escala, setEscala] = useState("");
  const [clothingType, setClothingType] = useState("");
  const [accessoryType, setAccessoryType] = useState("");
  const [catchyPhrase, setCatchyPhrase] = useState("");
  const [isActive, setIsActive] = useState(true);

  const [search, setSearch] = useState("");
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>("all");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSku, setEditSku] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editProductType, setEditProductType] = useState<ProductType>("maquetas");
  const [editEscala, setEditEscala] = useState("");
  const [editClothingType, setEditClothingType] = useState("");
  const [editAccessoryType, setEditAccessoryType] = useState("");
  const [editPhrase, setEditPhrase] = useState("");
  const [editActive, setEditActive] = useState(true);

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);

  const [loadingStores, setLoadingStores] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
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
        const relation = row.stores;
        const storeName = Array.isArray(relation) ? relation[0]?.name : relation?.name;
        return {
          id: row.store_id,
          name: storeName || "Tienda sin nombre",
        };
      });

      setStores(options);
      setSelectedStoreId((prev) => prev || options[0]?.id || "");
      if (options.length === 0) {
        setMsg("No tienes tiendas asignadas todavia.");
      }
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
        return;
      }

      setLoadingProducts(true);
      const { data, error } = await supabase
        .from("products")
        .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,is_active,created_at")
        .eq("store_id", selectedStoreId)
        .order("created_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        setMsg(error.message);
        setProducts([]);
        setLoadingProducts(false);
        return;
      }

      setProducts(((data ?? []) as Array<Partial<ProductRow> & { id: string; store_id: string }>).map(normalizeProductRow));
      setLoadingProducts(false);
    };

    loadProducts();
    return () => {
      cancelled = true;
    };
  }, [selectedStoreId, supabase]);

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((p) => {
      const typeMatch = productTypeFilter === "all" ? true : p.product_type === productTypeFilter;
      const textMatch =
        !term ||
        p.sku.toLowerCase().includes(term) ||
        p.title.toLowerCase().includes(term) ||
        getProductSubtype(p, "all").toLowerCase().includes(term);
      return typeMatch && textMatch;
    });
  }, [products, search, productTypeFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [selectedStoreId, search, pageSize, productTypeFilter]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setSelectedProductIds([]);
  }, [selectedStoreId]);

  const paginatedProducts = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredProducts.slice(start, start + pageSize);
  }, [filteredProducts, page, pageSize]);

  const isAllCurrentPageSelected = useMemo(() => {
    return paginatedProducts.length > 0 && paginatedProducts.every((p) => selectedProductIds.includes(p.id));
  }, [paginatedProducts, selectedProductIds]);

  const stats = useMemo(() => {
    const total = filteredProducts.length;
    const active = filteredProducts.filter((p) => p.is_active).length;
    return { total, active };
  }, [filteredProducts]);

  const downloadCsvTemplate = () => {
    const sample = [
      "sku,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,is_active",
      "MODEL-737,Maqueta B737,maquetas,1:400,,,Jet clasico,true",
      "CAMI-NEGRA,Camiseta Negra,ropa,,Camiseta,,Algodon premium,true",
      "CASE-LOGO,Accesorio Logo,accesorios,,,Llavero,Edicion limitada,true",
    ].join("\n");

    const blob = new Blob([sample], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "plantilla_productos.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateProduct = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    setCsvErrors([]);

    if (!selectedStoreId) {
      setMsg("Selecciona una tienda.");
      return;
    }

    const skuValue = sku.trim().toUpperCase();
    const titleValue = title.trim();
    const phraseValue = catchyPhrase.trim();
    const escalaValue = productType === "maquetas" ? escala.trim() : "";
    const clothingTypeValue = productType === "ropa" ? clothingType.trim() : "";
    const accessoryTypeValue = productType === "accesorios" ? accessoryType.trim() : "";

    if (!skuValue || !titleValue) {
      setMsg("SKU y titulo son obligatorios.");
      return;
    }

    setSaving(true);
    const { data, error } = await supabase
      .from("products")
      .insert({
        store_id: selectedStoreId,
        sku: skuValue,
        name: titleValue,
        title: titleValue,
        product_type: productType,
        escala: escalaValue || null,
        clothing_type: clothingTypeValue || null,
        accessory_type: accessoryTypeValue || null,
        catchy_phrase: phraseValue || null,
        is_active: isActive,
      })
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,is_active,created_at")
      .single();
    setSaving(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) => [normalizeProductRow(data as ProductRow), ...prev]);
    setSku("");
    setTitle("");
    setProductType("maquetas");
    setEscala("");
    setClothingType("");
    setAccessoryType("");
    setCatchyPhrase("");
    setIsActive(true);
    setMsg("Producto creado.");
  };

  const startEdit = (product: ProductRow) => {
    setEditingId(product.id);
    setEditSku(product.sku);
    setEditTitle(product.title);
    setEditProductType(product.product_type);
    setEditEscala(product.escala || "");
    setEditClothingType(product.clothing_type || "");
    setEditAccessoryType(product.accessory_type || "");
    setEditPhrase(product.catchy_phrase || "");
    setEditActive(product.is_active);
    setMsg("");
    setCsvErrors([]);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditSku("");
    setEditTitle("");
    setEditProductType("maquetas");
    setEditEscala("");
    setEditClothingType("");
    setEditAccessoryType("");
    setEditPhrase("");
    setEditActive(true);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !selectedStoreId) return;

    const skuValue = editSku.trim().toUpperCase();
    const titleValue = editTitle.trim();
    const phraseValue = editPhrase.trim();
    const escalaValue = editProductType === "maquetas" ? editEscala.trim() : "";
    const clothingTypeValue = editProductType === "ropa" ? editClothingType.trim() : "";
    const accessoryTypeValue = editProductType === "accesorios" ? editAccessoryType.trim() : "";

    if (!skuValue || !titleValue) {
      setMsg("SKU y titulo son obligatorios.");
      return;
    }

    setSavingEdit(true);
    const { data, error } = await supabase
      .from("products")
      .update({
        sku: skuValue,
        name: titleValue,
        title: titleValue,
        product_type: editProductType,
        escala: escalaValue || null,
        clothing_type: clothingTypeValue || null,
        accessory_type: accessoryTypeValue || null,
        catchy_phrase: phraseValue || null,
        is_active: editActive,
      })
      .eq("id", editingId)
      .eq("store_id", selectedStoreId)
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,is_active,created_at")
      .single();
    setSavingEdit(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) => prev.map((p) => (p.id === editingId ? normalizeProductRow(data as ProductRow) : p)));
    cancelEdit();
    setMsg("Producto actualizado.");
  };

  const handleSoftDelete = async (product: ProductRow) => {
    if (!selectedStoreId) return;

    const { data, error } = await supabase
      .from("products")
      .update({ is_active: false })
      .eq("id", product.id)
      .eq("store_id", selectedStoreId)
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,is_active,created_at")
      .single();

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) => prev.map((p) => (p.id === product.id ? normalizeProductRow(data as ProductRow) : p)));
    setMsg("Producto desactivado.");
  };

  const handleImportCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!selectedStoreId) {
      setMsg("Selecciona una tienda antes de importar.");
      e.target.value = "";
      return;
    }

    setMsg("");
    setCsvErrors([]);
    setImporting(true);

    const text = await file.text();
    const parsed = parseCsvProducts(text);

    if (parsed.errors.length > 0) {
      setImporting(false);
      setCsvErrors(parsed.errors);
      setMsg(`CSV invalido: ${parsed.errors.length} errores.`);
      e.target.value = "";
      return;
    }

    if (parsed.rows.length === 0) {
      setImporting(false);
      setMsg("No hay filas validas para importar.");
      e.target.value = "";
      return;
    }

    const payload = parsed.rows.map((row) => ({
      store_id: selectedStoreId,
      sku: row.sku,
      name: row.title,
      title: row.title,
      product_type: row.product_type,
      escala: row.escala,
      clothing_type: row.clothing_type,
      accessory_type: row.accessory_type,
      catchy_phrase: row.catchy_phrase,
      is_active: row.is_active,
    }));

    const chunkSize = 500;
    for (let start = 0; start < payload.length; start += chunkSize) {
      const chunk = payload.slice(start, start + chunkSize);
      const { error } = await supabase.from("products").upsert(chunk, {
        onConflict: "store_id,sku",
        ignoreDuplicates: false,
      });

      if (error) {
        setImporting(false);
        setMsg(error.message);
        e.target.value = "";
        return;
      }
    }

    const { data, error } = await supabase
      .from("products")
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,is_active,created_at")
      .eq("store_id", selectedStoreId)
      .order("created_at", { ascending: false });

    setImporting(false);
    e.target.value = "";

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts(((data ?? []) as Array<Partial<ProductRow> & { id: string; store_id: string }>).map(normalizeProductRow));
    setMsg(`Importacion completa: ${parsed.rows.length} filas procesadas.`);
  };

  const toggleProductSelection = (productId: string, checked: boolean) => {
    setSelectedProductIds((prev) => {
      if (checked) return prev.includes(productId) ? prev : [...prev, productId];
      return prev.filter((id) => id !== productId);
    });
  };

  const toggleSelectCurrentPage = (checked: boolean) => {
    const pageIds = paginatedProducts.map((p) => p.id);
    if (checked) {
      setSelectedProductIds((prev) => Array.from(new Set([...prev, ...pageIds])));
      return;
    }
    setSelectedProductIds((prev) => prev.filter((id) => !pageIds.includes(id)));
  };

  const handleBulkSetActive = async (nextActive: boolean) => {
    if (!selectedStoreId || selectedProductIds.length === 0) return;
    setMsg("");
    setBulkWorking(true);
    const { error } = await supabase
      .from("products")
      .update({ is_active: nextActive })
      .eq("store_id", selectedStoreId)
      .in("id", selectedProductIds);
    setBulkWorking(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) => prev.map((p) => (selectedProductIds.includes(p.id) ? { ...p, is_active: nextActive } : p)));
    setMsg(nextActive ? "Productos activados." : "Productos desactivados.");
    setSelectedProductIds([]);
  };

  const handleBulkDelete = async () => {
    if (!selectedStoreId || selectedProductIds.length === 0) return;
    const confirmed = window.confirm(`Eliminar ${selectedProductIds.length} producto(s)? Esta accion es permanente.`);
    if (!confirmed) return;

    setMsg("");
    setBulkWorking(true);
    const { error } = await supabase.from("products").delete().eq("store_id", selectedStoreId).in("id", selectedProductIds);
    setBulkWorking(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) => prev.filter((p) => !selectedProductIds.includes(p.id)));
    setMsg("Productos eliminados.");
    setSelectedProductIds([]);
  };

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Productos</h1>
        <p className="mt-1 text-sm text-slate-500">Crea y administra tu catalogo de productos por tienda.</p>

        <div className="mt-5 grid gap-4 md:grid-cols-5">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Productos (filtro)</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{stats.total}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Activos (filtro)</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{stats.active}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Tienda</label>
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
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Tipo</label>
            <select
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={productTypeFilter}
              onChange={(e) => setProductTypeFilter(e.target.value as ProductTypeFilter)}
            >
              <option value="all">Todos</option>
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {getTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Buscar</label>
            <input
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              placeholder="SKU o titulo"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Nuevo producto</h2>
          <p className="mt-1 text-sm text-slate-500">Usa SKU unico por tienda para evitar duplicados.</p>

          <form className="mt-5 space-y-4" onSubmit={handleCreateProduct}>
            <div>
              <label className="text-sm font-medium text-slate-700">SKU</label>
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Ej. GASEOSA-600ML"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">Titulo</label>
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Nombre estandarizado del producto"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">Tipo de producto</label>
              <select
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={productType}
                onChange={(e) => setProductType(e.target.value as ProductType)}
              >
                {PRODUCT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {getTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>

            {productType === "maquetas" && (
              <div>
                <label className="text-sm font-medium text-slate-700">Escala</label>
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={escala}
                  onChange={(e) => setEscala(e.target.value)}
                  placeholder="Ej. 1:400"
                />
              </div>
            )}

            {productType === "ropa" && (
              <div>
                <label className="text-sm font-medium text-slate-700">Tipo de ropa</label>
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={clothingType}
                  onChange={(e) => setClothingType(e.target.value)}
                  placeholder="Ej. Camiseta"
                />
              </div>
            )}

            {productType === "accesorios" && (
              <div>
                <label className="text-sm font-medium text-slate-700">Tipo de accesorio</label>
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={accessoryType}
                  onChange={(e) => setAccessoryType(e.target.value)}
                  placeholder="Ej. Llavero"
                />
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-slate-700">Frase comercial</label>
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={catchyPhrase}
                onChange={(e) => setCatchyPhrase(e.target.value)}
                placeholder="Ej. Refrescante y ligera"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input checked={isActive} onChange={(e) => setIsActive(e.target.checked)} type="checkbox" />
              Activo
            </label>

            <button
              className="w-full rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
              type="submit"
              disabled={saving || !selectedStoreId}
            >
              {saving ? "Guardando..." : "Crear producto"}
            </button>
          </form>

          <div className="mt-6 border-t border-slate-200 pt-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">Importar CSV</h3>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:border-indigo-200 hover:text-indigo-700"
                onClick={downloadCsvTemplate}
              >
                Descargar plantilla
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Requeridas: sku,title. Opcionales: product_type, escala, clothing_type, accessory_type, catchy_phrase, is_active.
            </p>
            <input
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
              type="file"
              accept=".csv,text/csv"
              onChange={handleImportCsv}
              disabled={importing || !selectedStoreId}
            />
            {importing && <p className="text-xs text-slate-500">Importando...</p>}
          </div>
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Catalogo</h2>
              <p className="mt-1 text-sm text-slate-500">Lista de productos registrados para la tienda seleccionada.</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-500">{selectedProductIds.length} seleccionados</span>
                <button
                  type="button"
                  className="rounded-full border border-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  onClick={() => handleBulkSetActive(true)}
                  disabled={selectedProductIds.length === 0 || bulkWorking}
                >
                  Activar
                </button>
                <button
                  type="button"
                  className="rounded-full border border-amber-200 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                  onClick={() => handleBulkSetActive(false)}
                  disabled={selectedProductIds.length === 0 || bulkWorking}
                >
                  Desactivar
                </button>
                <button
                  type="button"
                  className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                  onClick={handleBulkDelete}
                  disabled={selectedProductIds.length === 0 || bulkWorking}
                >
                  Eliminar
                </button>
              </div>
              <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Por pagina</label>
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

          {loadingProducts ? (
            <p className="mt-6 text-sm text-slate-500">Cargando productos...</p>
          ) : paginatedProducts.length === 0 ? (
            <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
              No hay productos para este filtro.
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
                        aria-label="Seleccionar pagina"
                      />
                    </th>
                    <th className="px-2 py-3">SKU</th>
                    <th className="px-2 py-3">Titulo</th>
                    <th className="px-2 py-3">Tipo</th>
                    <th className="px-2 py-3">{getSubtypeLabel(productTypeFilter)}</th>
                    <th className="px-2 py-3">Frase comercial</th>
                    <th className="px-2 py-3">Estado</th>
                    <th className="px-2 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedProducts.map((product) => {
                    const isEditing = editingId === product.id;

                    return (
                      <tr key={product.id} className="text-slate-700">
                        <td className="px-2 py-3">
                          <input
                            type="checkbox"
                            checked={selectedProductIds.includes(product.id)}
                            onChange={(e) => toggleProductSelection(product.id, e.target.checked)}
                            aria-label={`Seleccionar ${product.sku}`}
                          />
                        </td>
                        <td className="px-2 py-3 font-medium">
                          {isEditing ? (
                            <input
                              className="w-32 rounded-lg border border-slate-200 px-2 py-1"
                              value={editSku}
                              onChange={(e) => setEditSku(e.target.value)}
                            />
                          ) : (
                            product.sku
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              className="w-56 rounded-lg border border-slate-200 px-2 py-1"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                            />
                          ) : (
                            product.title
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <select
                              className="w-36 rounded-lg border border-slate-200 px-2 py-1"
                              value={editProductType}
                              onChange={(e) => setEditProductType(e.target.value as ProductType)}
                            >
                              {PRODUCT_TYPES.map((type) => (
                                <option key={type} value={type}>
                                  {getTypeLabel(type)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            getTypeLabel(product.product_type)
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            editProductType === "maquetas" ? (
                              <input
                                className="w-36 rounded-lg border border-slate-200 px-2 py-1"
                                value={editEscala}
                                onChange={(e) => setEditEscala(e.target.value)}
                              />
                            ) : editProductType === "ropa" ? (
                              <input
                                className="w-36 rounded-lg border border-slate-200 px-2 py-1"
                                value={editClothingType}
                                onChange={(e) => setEditClothingType(e.target.value)}
                              />
                            ) : (
                              <input
                                className="w-36 rounded-lg border border-slate-200 px-2 py-1"
                                value={editAccessoryType}
                                onChange={(e) => setEditAccessoryType(e.target.value)}
                              />
                            )
                          ) : (
                            getProductSubtype(product, productTypeFilter)
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <input
                              className="w-56 rounded-lg border border-slate-200 px-2 py-1"
                              value={editPhrase}
                              onChange={(e) => setEditPhrase(e.target.value)}
                            />
                          ) : (
                            product.catchy_phrase || "-"
                          )}
                        </td>
                        <td className="px-2 py-3">
                          {isEditing ? (
                            <label className="inline-flex items-center gap-2 text-xs">
                              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
                              Activo
                            </label>
                          ) : (
                            <span
                              className={
                                product.is_active
                                  ? "rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"
                                  : "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600"
                              }
                            >
                              {product.is_active ? "Activo" : "Inactivo"}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-3">
                          <div className="flex flex-wrap gap-2">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                                  onClick={handleSaveEdit}
                                  disabled={savingEdit}
                                >
                                  {savingEdit ? "Guardando" : "Guardar"}
                                </button>
                                <button
                                  type="button"
                                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                                  onClick={cancelEdit}
                                >
                                  Cancelar
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:border-indigo-200 hover:text-indigo-700"
                                  onClick={() => startEdit(product)}
                                >
                                  Editar
                                </button>
                                {product.is_active && (
                                  <button
                                    type="button"
                                    className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                                    onClick={() => handleSoftDelete(product)}
                                  >
                                    Desactivar
                                  </button>
                                )}
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
              Pagina {page} de {totalPages}
            </p>
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
      </div>

      {msg && <p className="text-sm text-slate-600">{msg}</p>}

      {csvErrors.length > 0 && (
        <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <h3 className="text-sm font-semibold text-rose-800">Errores de importacion CSV ({csvErrors.length})</h3>
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
