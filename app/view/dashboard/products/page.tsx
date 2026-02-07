"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type ProductType = "ropa" | "maquetas" | "accesorios";
type ProductTypeFilter = "all" | ProductType;
type ViewMode = "card" | "table";
type BulkImportPlatform = "woocommerce" | "etsy";
type BulkPriceImportPlatform = "woocommerce" | "etsy" | "both";
type SortDirection = "asc" | "desc";
type ProductSortKey = "sku" | "title" | "type" | "subtype" | "tagline";

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
  base_price: number;
  woo_price: number | null;
  etsy_price: number | null;
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
  base_price?: number;
  woo_price?: number | null;
  etsy_price?: number | null;
  is_active: boolean;
};

type ProductImageRow = {
  id: string;
  store_id: string;
  product_id: string;
  storage_path: string;
  sort_order: number;
  is_primary: boolean;
  created_at: string;
};

const PRODUCT_TYPES: ProductType[] = ["ropa", "maquetas", "accesorios"];

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

function escapeCsvValue(value: string | number | boolean | null | undefined): string {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildMediaStoragePath(storeId: string, productId: string, fileName: string): string {
  const salt = Math.random().toString(36).slice(2, 8);
  return `${storeId}/${productId}/${Date.now()}-${salt}-${sanitizeFileName(fileName)}`;
}

function parsePriceInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = Number(trimmed);
  if (!Number.isFinite(normalized) || normalized < 0) return null;
  return Math.round(normalized * 100) / 100;
}

function parseCsvProducts(csvText: string): { rows: CsvProduct[]; errors: string[] } {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: ["Empty CSV file."] };
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
  const basePriceIndex = header.indexOf("base_price");
  const wooPriceIndex = header.indexOf("woo_price");
  const etsyPriceIndex = header.indexOf("etsy_price");
  const activeIndex = header.indexOf("is_active");

  if (skuIndex < 0 || titleIndex < 0) {
    return { rows: [], errors: ["The file must include columns sku,title (CSV or TSV)."] };
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
    const basePriceRaw = basePriceIndex >= 0 ? (cols[basePriceIndex] || "").trim() : "";
    const wooPriceRaw = wooPriceIndex >= 0 ? (cols[wooPriceIndex] || "").trim() : "";
    const etsyPriceRaw = etsyPriceIndex >= 0 ? (cols[etsyPriceIndex] || "").trim() : "";
    const activeRaw = activeIndex >= 0 ? (cols[activeIndex] || "").trim().toLowerCase() : "true";

    if (!sku || !title) {
      errors.push(`Row ${lineNo + 1}: sku and title are required.`);
      continue;
    }

    if (typeIndex >= 0 && !parsedType) {
      errors.push(`Row ${lineNo + 1}: invalid product_type. Use ropa, maquetas, or accesorios.`);
      continue;
    }
    const parsedBasePrice = basePriceRaw ? Number(basePriceRaw) : 0;
    const parsedWooPrice = wooPriceRaw ? Number(wooPriceRaw) : null;
    const parsedEtsyPrice = etsyPriceRaw ? Number(etsyPriceRaw) : null;
    if (!Number.isFinite(parsedBasePrice) || parsedBasePrice < 0) {
      errors.push(`Row ${lineNo + 1}: base_price must be 0 or greater.`);
      continue;
    }
    if (parsedWooPrice != null && (!Number.isFinite(parsedWooPrice) || parsedWooPrice < 0)) {
      errors.push(`Row ${lineNo + 1}: woo_price must be 0 or greater when present.`);
      continue;
    }
    if (parsedEtsyPrice != null && (!Number.isFinite(parsedEtsyPrice) || parsedEtsyPrice < 0)) {
      errors.push(`Row ${lineNo + 1}: etsy_price must be 0 or greater when present.`);
      continue;
    }

    if (seen.has(sku)) {
      errors.push(`Row ${lineNo + 1}: duplicated sku in file (${sku}).`);
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
      base_price: Math.round(parsedBasePrice * 100) / 100,
      woo_price: parsedWooPrice == null ? null : Math.round(parsedWooPrice * 100) / 100,
      etsy_price: parsedEtsyPrice == null ? null : Math.round(parsedEtsyPrice * 100) / 100,
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
    base_price: Number(row.base_price ?? 0) || 0,
    woo_price: row.woo_price == null ? null : Number(row.woo_price),
    etsy_price: row.etsy_price == null ? null : Number(row.etsy_price),
    is_active: Boolean(row.is_active),
    created_at: row.created_at ?? new Date().toISOString(),
    sku: (row.sku ?? "").toString(),
  };
}

export default function ProductsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [selectedStoreId, setSelectedStoreId] = useState<string>(searchParams.get("store") || "");
  const [products, setProducts] = useState<ProductRow[]>([]);

  const [sku, setSku] = useState("");
  const [title, setTitle] = useState("");
  const [productType, setProductType] = useState<ProductType>("maquetas");
  const [escala, setEscala] = useState("");
  const [clothingType, setClothingType] = useState("");
  const [accessoryType, setAccessoryType] = useState("");
  const [catchyPhrase, setCatchyPhrase] = useState("");
  const [basePrice, setBasePrice] = useState("0.00");
  const [wooPrice, setWooPrice] = useState("");
  const [etsyPrice, setEtsyPrice] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

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
  const [editBasePrice, setEditBasePrice] = useState("");
  const [editWooPrice, setEditWooPrice] = useState("");
  const [editEtsyPrice, setEditEtsyPrice] = useState("");
  const [editActive, setEditActive] = useState(true);

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: ProductSortKey; direction: SortDirection } | null>({
    key: "title",
    direction: "asc",
  });
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [previewGallery, setPreviewGallery] = useState<{ urls: string[]; title: string; index: number } | null>(null);
  const [createMediaFiles, setCreateMediaFiles] = useState<File[]>([]);
  const [isAdvancedModalOpen, setIsAdvancedModalOpen] = useState(false);
  const [bulkBasePrice, setBulkBasePrice] = useState("");
  const [bulkWooPrice, setBulkWooPrice] = useState("");
  const [bulkEtsyPrice, setBulkEtsyPrice] = useState("");
  const [bulkImportPlatform, setBulkImportPlatform] = useState<BulkImportPlatform>("etsy");
  const [bulkPriceImportPlatform, setBulkPriceImportPlatform] = useState<BulkPriceImportPlatform>("both");
  const [bulkPriceImportToBase, setBulkPriceImportToBase] = useState(false);
  const [applyingBulkPrices, setApplyingBulkPrices] = useState(false);
  const [importingMarketplaceImages, setImportingMarketplaceImages] = useState(false);
  const [importingMarketplacePrices, setImportingMarketplacePrices] = useState(false);
  const [progressModal, setProgressModal] = useState<{ title: string; detail: string; percent: number } | null>(null);
  const [isImageImportPromptOpen, setIsImageImportPromptOpen] = useState(false);
  const [useImageFallback, setUseImageFallback] = useState(true);
  const [successModal, setSuccessModal] = useState<{ title: string; message: string } | null>(null);

  const [loadingProducts, setLoadingProducts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [syncingPrices, setSyncingPrices] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [productImagesByProductId, setProductImagesByProductId] = useState<Record<string, ProductImageRow[]>>({});
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaReordering, setMediaReordering] = useState(false);
  const [draggingImageId, setDraggingImageId] = useState<string | null>(null);
  const [dragOverImageId, setDragOverImageId] = useState<string | null>(null);
  const [mediaMsg, setMediaMsg] = useState("");

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

    const loadProducts = async () => {
      if (!selectedStoreId) {
        setProducts([]);
        return;
      }

      setLoadingProducts(true);
      const { data, error } = await supabase
        .from("products")
        .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,base_price,woo_price,etsy_price,is_active,created_at")
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

  useEffect(() => {
    let cancelled = false;

    const loadProductImages = async () => {
      if (!selectedStoreId) {
        setProductImagesByProductId({});
        return;
      }

      setMediaLoading(true);
      const { data, error } = await supabase
        .from("product_images")
        .select("id,store_id,product_id,storage_path,sort_order,is_primary,created_at")
        .eq("store_id", selectedStoreId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (cancelled) return;

      if (error) {
        setMediaLoading(false);
        setMediaMsg(error.message);
        return;
      }

      const grouped: Record<string, ProductImageRow[]> = {};
      for (const row of (data ?? []) as ProductImageRow[]) {
        if (!grouped[row.product_id]) grouped[row.product_id] = [];
        grouped[row.product_id].push(row);
      }
      setProductImagesByProductId(grouped);
      setMediaLoading(false);
    };

    loadProductImages();
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

  const sortedProducts = useMemo(() => {
    if (!sort) return filteredProducts;
    const next = [...filteredProducts];
    next.sort((a, b) => {
      let cmp = 0;
      if (sort.key === "sku") cmp = compareText(a.sku || "", b.sku || "");
      if (sort.key === "title") cmp = compareText(a.title || "", b.title || "");
      if (sort.key === "type") cmp = compareText(getTypeLabel(a.product_type), getTypeLabel(b.product_type));
      if (sort.key === "subtype") cmp = compareText(getProductSubtype(a, productTypeFilter), getProductSubtype(b, productTypeFilter));
      if (sort.key === "tagline") cmp = compareText(a.catchy_phrase || "", b.catchy_phrase || "");
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return next;
  }, [filteredProducts, sort, productTypeFilter]);

  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / pageSize));

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
    return sortedProducts.slice(start, start + pageSize);
  }, [sortedProducts, page, pageSize]);
  const isAllCurrentPageSelected = useMemo(() => {
    return paginatedProducts.length > 0 && paginatedProducts.every((p) => selectedProductIds.includes(p.id));
  }, [paginatedProducts, selectedProductIds]);
  const isAllFilteredSelected = useMemo(() => {
    if (filteredProducts.length === 0) return false;
    return filteredProducts.every((product) => selectedProductIds.includes(product.id));
  }, [filteredProducts, selectedProductIds]);

  const stats = useMemo(() => {
    const total = filteredProducts.length;
    const active = filteredProducts.filter((p) => p.is_active).length;
    return { total, active };
  }, [filteredProducts]);
  const hasActiveFilters = productTypeFilter !== "all" || search.trim().length > 0;
  const editingProduct = useMemo(
    () => (editingId ? products.find((product) => product.id === editingId) || null : null),
    [editingId, products],
  );
  const currentMediaList = editingProduct ? productImagesByProductId[editingProduct.id] || [] : [];
  const anyAdvancedWorking = applyingBulkPrices || importingMarketplaceImages || importingMarketplacePrices;

  const getPublicImageUrl = (storagePath: string) => {
    const { data } = supabase.storage.from("product-images").getPublicUrl(storagePath);
    return data.publicUrl;
  };
  const showSuccess = (title: string, message: string) => {
    setSuccessModal({ title, message });
  };
  const fallbackPlatform = bulkImportPlatform === "etsy" ? "woocommerce" : "etsy";
  const openImagePreview = (images: ProductImageRow[], title: string, selectedPath: string) => {
    if (images.length === 0) return;
    const urls = images.map((image) => getPublicImageUrl(image.storage_path));
    const selectedIndex = images.findIndex((image) => image.storage_path === selectedPath);
    setPreviewGallery({
      urls,
      title,
      index: selectedIndex >= 0 ? selectedIndex : 0,
    });
  };

  const downloadCsvTemplate = () => {
    const sample = [
      "sku,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,base_price,woo_price,etsy_price,is_active",
      "MODEL-737,Maqueta B737,maquetas,1:400,,,Jet clasico,49.99,52.99,54.99,true",
      "CAMI-NEGRA,Camiseta Negra,ropa,,Camiseta,,Algodon premium,19.90,21.50,22.00,true",
      "CASE-LOGO,Accesorio Logo,accesorios,,,Llavero,Edicion limitada,6.50,,,true",
    ].join("\n");

    const blob = new Blob([sample], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "plantilla_productos.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadFilteredProductsCsv = () => {
    const headers = ["sku", "title", "product_type", "type_detail", "tagline", "base_price", "woo_price", "etsy_price", "is_active", "created_at"];
    const lines = sortedProducts.map((product) =>
      [
        product.sku,
        product.title,
        product.product_type,
        getProductSubtype(product, "all"),
        product.catchy_phrase || "",
        product.base_price,
        product.woo_price ?? "",
        product.etsy_price ?? "",
        product.is_active,
        product.created_at,
      ]
        .map((value) => escapeCsvValue(value))
        .join(","),
    );
    const csv = [headers.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "products_export.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateProduct = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    setCsvErrors([]);

    if (!selectedStoreId) {
      setMsg("Select a store.");
      return;
    }

    const skuValue = sku.trim().toUpperCase();
    const titleValue = title.trim();
    const phraseValue = catchyPhrase.trim();
    const basePriceValue = parsePriceInput(basePrice);
    const wooPriceValue = parsePriceInput(wooPrice);
    const etsyPriceValue = parsePriceInput(etsyPrice);
    const escalaValue = productType === "maquetas" ? escala.trim() : "";
    const clothingTypeValue = productType === "ropa" ? clothingType.trim() : "";
    const accessoryTypeValue = productType === "accesorios" ? accessoryType.trim() : "";

    if (!skuValue || !titleValue) {
      setMsg("SKU and title are required.");
      return;
    }
    if (basePriceValue == null) {
      setMsg("Base price is required and must be 0 or greater.");
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
        base_price: basePriceValue,
        woo_price: wooPriceValue,
        etsy_price: etsyPriceValue,
        is_active: isActive,
      })
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,base_price,woo_price,etsy_price,is_active,created_at")
      .single();

    if (error) {
      setSaving(false);
      setMsg(error.message);
      return;
    }

    let createMediaSummary = "";
    if (createMediaFiles.length > 0) {
      const uploadResult = await uploadMediaFilesForProduct(data.id, createMediaFiles);
      if (uploadResult.uploadedCount > 0) {
        await refreshProductImages();
        createMediaSummary = ` ${uploadResult.uploadedCount} image(s) uploaded.`;
      }
      if (uploadResult.errors.length > 0) {
        createMediaSummary = ` Product created, but media upload had issues: ${uploadResult.errors[0]}`;
      }
    }

    setProducts((prev) => [normalizeProductRow(data as ProductRow), ...prev]);
    setSku("");
    setTitle("");
    setProductType("maquetas");
    setEscala("");
    setClothingType("");
    setAccessoryType("");
    setCatchyPhrase("");
    setBasePrice("0.00");
    setWooPrice("");
    setEtsyPrice("");
    setIsActive(true);
    setCreateMediaFiles([]);
    setIsCreateModalOpen(false);
    setMsg(`Product created.${createMediaSummary}`);
    setSaving(false);
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
    setEditBasePrice(product.base_price.toFixed(2));
    setEditWooPrice(product.woo_price == null ? "" : product.woo_price.toFixed(2));
    setEditEtsyPrice(product.etsy_price == null ? "" : product.etsy_price.toFixed(2));
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
    setEditBasePrice("");
    setEditWooPrice("");
    setEditEtsyPrice("");
    setEditActive(true);
    setMediaMsg("");
  };

  const handleSaveEdit = async () => {
    if (!editingId || !selectedStoreId) return;

    const skuValue = editSku.trim().toUpperCase();
    const titleValue = editTitle.trim();
    const phraseValue = editPhrase.trim();
    const basePriceValue = parsePriceInput(editBasePrice);
    const wooPriceValue = parsePriceInput(editWooPrice);
    const etsyPriceValue = parsePriceInput(editEtsyPrice);
    const escalaValue = editProductType === "maquetas" ? editEscala.trim() : "";
    const clothingTypeValue = editProductType === "ropa" ? editClothingType.trim() : "";
    const accessoryTypeValue = editProductType === "accesorios" ? editAccessoryType.trim() : "";

    if (!skuValue || !titleValue) {
      setMsg("SKU and title are required.");
      return;
    }
    if (basePriceValue == null) {
      setMsg("Base price is required and must be 0 or greater.");
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
        base_price: basePriceValue,
        woo_price: wooPriceValue,
        etsy_price: etsyPriceValue,
        is_active: editActive,
      })
      .eq("id", editingId)
      .eq("store_id", selectedStoreId)
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,base_price,woo_price,etsy_price,is_active,created_at")
      .single();
    setSavingEdit(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) => prev.map((p) => (p.id === editingId ? normalizeProductRow(data as ProductRow) : p)));
    cancelEdit();
    setMsg("Product updated.");
  };

  const handleSoftDelete = async (product: ProductRow) => {
    if (!selectedStoreId) return;

    const { data, error } = await supabase
      .from("products")
      .update({ is_active: false })
      .eq("id", product.id)
      .eq("store_id", selectedStoreId)
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,base_price,woo_price,etsy_price,is_active,created_at")
      .single();

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) => prev.map((p) => (p.id === product.id ? normalizeProductRow(data as ProductRow) : p)));
    setMsg("Product deactivated.");
  };

  const handleImportCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!selectedStoreId) {
      setMsg("Select a store before importing.");
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
      base_price: row.base_price ?? 0,
      woo_price: row.woo_price ?? null,
      etsy_price: row.etsy_price ?? null,
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
      .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,base_price,woo_price,etsy_price,is_active,created_at")
      .eq("store_id", selectedStoreId)
      .order("created_at", { ascending: false });

    setImporting(false);
    e.target.value = "";

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts(((data ?? []) as Array<Partial<ProductRow> & { id: string; store_id: string }>).map(normalizeProductRow));
    setMsg(`Import complete: ${parsed.rows.length} row(s) processed.`);
    setIsImportModalOpen(false);
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
  const toggleSelectAllFiltered = (checked: boolean) => {
    if (checked) {
      setSelectedProductIds(filteredProducts.map((product) => product.id));
      return;
    }
    setSelectedProductIds([]);
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
    setMsg(nextActive ? "Products activated." : "Products deactivated.");
    setSelectedProductIds([]);
  };

  const handleBulkDelete = async () => {
    if (!selectedStoreId || selectedProductIds.length === 0) return;
    const confirmed = window.confirm(`Delete ${selectedProductIds.length} product(s)? This action is permanent.`);
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
    setMsg("Products deleted.");
    setSelectedProductIds([]);
  };

  const handleBulkUpdatePrices = async () => {
    if (!selectedStoreId || selectedProductIds.length === 0) return;

    const nextBasePrice = bulkBasePrice.trim() === "" ? undefined : parsePriceInput(bulkBasePrice);
    const nextWooPrice = bulkWooPrice.trim() === "" ? undefined : parsePriceInput(bulkWooPrice);
    const nextEtsyPrice = bulkEtsyPrice.trim() === "" ? undefined : parsePriceInput(bulkEtsyPrice);

    if (nextBasePrice === null || nextWooPrice === null || nextEtsyPrice === null) {
      setMsg("Bulk price values must be empty or numbers >= 0.");
      return;
    }

    const payload: Record<string, number | null> = {};
    if (nextBasePrice !== undefined) payload.base_price = nextBasePrice;
    if (nextWooPrice !== undefined) payload.woo_price = nextWooPrice;
    if (nextEtsyPrice !== undefined) payload.etsy_price = nextEtsyPrice;

    if (Object.keys(payload).length === 0) {
      setMsg("Add at least one price to apply in bulk.");
      return;
    }

    setApplyingBulkPrices(true);
    const { error } = await supabase
      .from("products")
      .update(payload)
      .eq("store_id", selectedStoreId)
      .in("id", selectedProductIds);
    setApplyingBulkPrices(false);

    if (error) {
      setMsg(error.message);
      return;
    }

    setProducts((prev) =>
      prev.map((product) => {
        if (!selectedProductIds.includes(product.id)) return product;
        return {
          ...product,
          base_price: payload.base_price == null ? product.base_price : payload.base_price,
          woo_price: payload.woo_price === undefined ? product.woo_price : payload.woo_price,
          etsy_price: payload.etsy_price === undefined ? product.etsy_price : payload.etsy_price,
        };
      }),
    );

    setMsg(`Bulk prices updated for ${selectedProductIds.length} product(s).`);
    showSuccess("Prices Applied", `Bulk prices updated for ${selectedProductIds.length} product(s).`);
  };

  const handleBulkImportMarketplaceImages = () => {
    if (!selectedStoreId || selectedProductIds.length === 0) return;
    setUseImageFallback(true);
    setIsImageImportPromptOpen(true);
  };

  const runBulkImportMarketplaceImages = async (withFallback: boolean) => {
    if (!selectedStoreId || selectedProductIds.length === 0) return;

    try {
      setImportingMarketplaceImages(true);
      setMsg("");
      const { data: sessionRes } = await supabase.auth.getSession();
      const accessToken = sessionRes.session?.access_token;
      if (!accessToken) {
        setImportingMarketplaceImages(false);
        setProgressModal(null);
        setMsg("Not authenticated.");
        return;
      }

      const ids = [...selectedProductIds];
      const total = ids.length;
      let processedProducts = 0;
      let importedProducts = 0;
      let totalImagesImported = 0;
      let missingSkuCount = 0;
      let missingImageCount = 0;
      const allErrors: string[] = [];

      for (let i = 0; i < ids.length; i += 1) {
        const productId = ids[i];
        const pctBefore = Math.round((i / total) * 100);
        setProgressModal({
          title: "Importing Images",
          detail: `Processing ${i + 1} of ${total} (${bulkImportPlatform}${withFallback ? ` -> fallback ${fallbackPlatform}` : ""})`,
          percent: pctBefore,
        });

        const res = await fetch("/api/products/import-marketplace-images", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            storeId: selectedStoreId,
            productIds: [productId],
            platform: bulkImportPlatform,
            fallbackPlatform: withFallback ? fallbackPlatform : null,
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          processedProducts?: number;
          importedProducts?: number;
          totalImagesImported?: number;
          missingSkuCount?: number;
          missingImageCount?: number;
          errors?: string[];
        };

        if (!res.ok) {
          allErrors.push(payload.error || `Import failed for item ${i + 1}.`);
        } else {
          processedProducts += payload.processedProducts || 0;
          importedProducts += payload.importedProducts || 0;
          totalImagesImported += payload.totalImagesImported || 0;
          missingSkuCount += payload.missingSkuCount || 0;
          missingImageCount += payload.missingImageCount || 0;
          if (payload.errors?.length) allErrors.push(...payload.errors);
        }
      }

      setProgressModal({
        title: "Importing Images",
        detail: "Finalizing...",
        percent: 100,
      });

      await refreshProductImages();
      const firstError = allErrors[0] ? ` First issue: ${allErrors[0]}` : "";
      const noImportHint =
        importedProducts === 0
          ? " No images were imported. Check Etsy token, shop name, SKU map/listing IDs, and listing images."
          : "";
      setMsg(
        `Image import complete (${bulkImportPlatform}). Products: ${importedProducts}/${processedProducts}. Images: ${totalImagesImported}. Missing SKU map: ${missingSkuCount}. Missing images: ${missingImageCount}.${firstError}${noImportHint}`,
      );
      if (importedProducts > 0) {
        showSuccess(
          "Images Imported",
          `${totalImagesImported} image(s) imported across ${importedProducts} product(s).`,
        );
      }
    } catch (error) {
      setImportingMarketplaceImages(false);
      setProgressModal(null);
      setMsg(error instanceof Error ? error.message : "Bulk image import failed.");
      return;
    }
    setImportingMarketplaceImages(false);
    setProgressModal(null);
  };

  const handleBulkImportMarketplacePrices = async () => {
    if (!selectedStoreId || selectedProductIds.length === 0) return;

    try {
      setImportingMarketplacePrices(true);
      setMsg("");
      const { data: sessionRes } = await supabase.auth.getSession();
      const accessToken = sessionRes.session?.access_token;
      if (!accessToken) {
        setImportingMarketplacePrices(false);
        setProgressModal(null);
        setMsg("Not authenticated.");
        return;
      }

      const ids = [...selectedProductIds];
      const total = ids.length;
      let processedProducts = 0;
      let updatedProducts = 0;
      let updatedWooProducts = 0;
      let updatedEtsyProducts = 0;
      let missingSkuCount = 0;
      let missingPriceCount = 0;
      const allErrors: string[] = [];

      for (let i = 0; i < ids.length; i += 1) {
        const productId = ids[i];
        const pctBefore = Math.round((i / total) * 100);
        setProgressModal({
          title: "Importing Prices",
          detail: `Processing ${i + 1} of ${total} (${bulkPriceImportPlatform})`,
          percent: pctBefore,
        });

        const res = await fetch("/api/products/import-marketplace-prices", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            storeId: selectedStoreId,
            productIds: [productId],
            platform: bulkPriceImportPlatform,
            updateBasePrice: bulkPriceImportToBase,
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          processedProducts?: number;
          updatedProducts?: number;
          updatedWooProducts?: number;
          updatedEtsyProducts?: number;
          missingSkuCount?: number;
          missingPriceCount?: number;
          errors?: string[];
        };

        if (!res.ok) {
          allErrors.push(payload.error || `Import failed for item ${i + 1}.`);
        } else {
          processedProducts += payload.processedProducts || 0;
          updatedProducts += payload.updatedProducts || 0;
          updatedWooProducts += payload.updatedWooProducts || 0;
          updatedEtsyProducts += payload.updatedEtsyProducts || 0;
          missingSkuCount += payload.missingSkuCount || 0;
          missingPriceCount += payload.missingPriceCount || 0;
          if (payload.errors?.length) allErrors.push(...payload.errors);
        }
      }

      setProgressModal({
        title: "Importing Prices",
        detail: "Finalizing...",
        percent: 100,
      });

      const { data: refreshedProducts, error: refreshErr } = await supabase
        .from("products")
        .select("id,store_id,sku,name,title,product_type,escala,clothing_type,accessory_type,catchy_phrase,base_price,woo_price,etsy_price,is_active,created_at")
        .eq("store_id", selectedStoreId);
      if (!refreshErr && refreshedProducts) {
        setProducts(
          (refreshedProducts as Array<Partial<ProductRow> & { id: string; store_id: string }>).map(normalizeProductRow),
        );
      }

      const firstError = allErrors[0] ? ` First issue: ${allErrors[0]}` : "";
      const noImportHint =
        updatedProducts === 0
          ? " No prices were imported. Check token, SKU map/listing IDs, and marketplace product prices."
          : "";
      const breakdown =
        bulkPriceImportPlatform === "both"
          ? ` Woo updated: ${updatedWooProducts}. Etsy updated: ${updatedEtsyProducts}.`
          : "";
      setMsg(
        `Price import complete (${bulkPriceImportPlatform}). Updated: ${updatedProducts}/${processedProducts}.${breakdown} Missing SKU map: ${missingSkuCount}. Missing price: ${missingPriceCount}.${firstError}${noImportHint}`,
      );
      if (updatedProducts > 0) {
        showSuccess(
          "Prices Imported",
          bulkPriceImportPlatform === "both"
            ? `Updated ${updatedProducts} product(s). Woo: ${updatedWooProducts}, Etsy: ${updatedEtsyProducts}.`
            : `Updated ${updatedProducts} product(s) from ${bulkPriceImportPlatform}.`,
        );
      }
    } catch (error) {
      setImportingMarketplacePrices(false);
      setProgressModal(null);
      setMsg(error instanceof Error ? error.message : "Bulk price import failed.");
      return;
    }
    setImportingMarketplacePrices(false);
    setProgressModal(null);
  };

  const handleSyncPrices = async () => {
    if (!selectedStoreId) return;
    setMsg("");
    setSyncingPrices(true);

    const productIds =
      selectedProductIds.length > 0 ? selectedProductIds : filteredProducts.map((product) => product.id);

    const { data: sessionRes } = await supabase.auth.getSession();
    const accessToken = sessionRes.session?.access_token;
    if (!accessToken) {
      setSyncingPrices(false);
      setMsg("Session expired. Please sign in again.");
      return;
    }

    try {
      const res = await fetch("/api/products/sync-marketplaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ storeId: selectedStoreId, productIds }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        syncedSkuCount?: number;
        woo?: { enabled?: boolean; updated?: number; missingSkuCount?: number; errors?: string[] };
        etsy?: { enabled?: boolean; updatedListings?: number; missingSkuCount?: number; errors?: string[] };
        errors?: string[];
      };

      setSyncingPrices(false);
      if (!res.ok) {
        setMsg(payload.error || "Price sync failed.");
        return;
      }

      const wooSummary = payload.woo?.enabled
        ? `Woo: ${payload.woo.updated || 0} updated, ${payload.woo.missingSkuCount || 0} missing SKU`
        : "Woo: not configured";
      const etsySummary = payload.etsy?.enabled
        ? `Etsy: ${payload.etsy.updatedListings || 0} listings updated, ${payload.etsy.missingSkuCount || 0} missing SKU map`
        : "Etsy: not configured";
      const firstError = payload.errors?.[0] || payload.woo?.errors?.[0] || payload.etsy?.errors?.[0] || "";
      setMsg(
        `Price sync complete. Scope: ${payload.syncedSkuCount || 0} SKU(s). ${wooSummary}. ${etsySummary}.${firstError ? ` First issue: ${firstError}` : ""}`,
      );
    } catch (error) {
      setSyncingPrices(false);
      setMsg(error instanceof Error ? error.message : "Price sync failed.");
    }
  };

  const refreshProductImages = async () => {
    if (!selectedStoreId) return;
    const { data, error } = await supabase
      .from("product_images")
      .select("id,store_id,product_id,storage_path,sort_order,is_primary,created_at")
      .eq("store_id", selectedStoreId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      setMediaMsg(error.message);
      return;
    }

    const grouped: Record<string, ProductImageRow[]> = {};
    for (const row of (data ?? []) as ProductImageRow[]) {
      if (!grouped[row.product_id]) grouped[row.product_id] = [];
      grouped[row.product_id].push(row);
    }
    setProductImagesByProductId(grouped);
  };

  const uploadMediaFilesForProduct = async (productId: string, files: File[]) => {
    if (!selectedStoreId || files.length === 0) {
      return { uploadedCount: 0, errors: [] as string[] };
    }

    const currentList = productImagesByProductId[productId] || [];
    const startOrder = currentList.length;
    let nextOrder = startOrder;
    let uploadedCount = 0;
    const errors: string[] = [];

    for (const file of files) {
      const path = buildMediaStoragePath(selectedStoreId, productId, file.name);
      const uploadRes = await supabase.storage.from("product-images").upload(path, file, {
        upsert: false,
      });

      if (uploadRes.error) {
        errors.push(uploadRes.error.message);
        continue;
      }

      const { error: insertError } = await supabase.from("product_images").insert({
        store_id: selectedStoreId,
        product_id: productId,
        storage_path: path,
        sort_order: nextOrder,
        is_primary: startOrder === 0 && nextOrder === 0,
      });

      if (insertError) {
        errors.push(insertError.message);
        continue;
      }

      nextOrder += 1;
      uploadedCount += 1;
    }

    return { uploadedCount, errors };
  };

  const handleUploadMedia = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!editingProduct || !selectedStoreId || files.length === 0) return;

    setMediaUploading(true);
    setMediaMsg("");
    const result = await uploadMediaFilesForProduct(editingProduct.id, files);

    await refreshProductImages();
    setMediaUploading(false);
    e.target.value = "";
    if (result.errors.length > 0) {
      setMediaMsg(result.errors[0]);
      return;
    }
    if (result.uploadedCount > 0) {
      setMediaMsg(`${result.uploadedCount} image(s) uploaded.`);
    }
  };

  const handleSetPrimaryImage = async (image: ProductImageRow) => {
    if (!editingProduct || !selectedStoreId) return;
    setMediaMsg("");

    const { error: clearError } = await supabase
      .from("product_images")
      .update({ is_primary: false })
      .eq("store_id", selectedStoreId)
      .eq("product_id", editingProduct.id);

    if (clearError) {
      setMediaMsg(clearError.message);
      return;
    }

    const { error: setError } = await supabase
      .from("product_images")
      .update({ is_primary: true })
      .eq("id", image.id)
      .eq("store_id", selectedStoreId);

    if (setError) {
      setMediaMsg(setError.message);
      return;
    }

    await refreshProductImages();
    setMediaMsg("Cover image updated.");
  };

  const handleDeleteImage = async (image: ProductImageRow) => {
    if (!editingProduct || !selectedStoreId) return;
    setMediaMsg("");

    const { error: storageError } = await supabase.storage.from("product-images").remove([image.storage_path]);
    if (storageError) {
      setMediaMsg(storageError.message);
      return;
    }

    const { error: rowError } = await supabase
      .from("product_images")
      .delete()
      .eq("id", image.id)
      .eq("store_id", selectedStoreId);

    if (rowError) {
      setMediaMsg(rowError.message);
      return;
    }

    await refreshProductImages();
    setMediaMsg("Image deleted.");
  };

  const handleReorderImages = async (draggedImageId: string, targetImageId: string) => {
    if (!editingProduct || !selectedStoreId) return;
    const currentList = productImagesByProductId[editingProduct.id] || [];
    if (draggedImageId === targetImageId) return;
    const fromIndex = currentList.findIndex((img) => img.id === draggedImageId);
    const toIndex = currentList.findIndex((img) => img.id === targetImageId);
    if (fromIndex < 0 || toIndex < 0) return;

    const reordered = [...currentList];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    setMediaReordering(true);
    setMediaMsg("Updating image order...");
    const updates = reordered.map((img, sortOrder) =>
      supabase
        .from("product_images")
        .update({ sort_order: sortOrder })
        .eq("id", img.id)
        .eq("store_id", selectedStoreId),
    );
    const results = await Promise.all(updates);
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      setMediaReordering(false);
      setMediaMsg(failed.error.message);
      setDraggingImageId(null);
      setDragOverImageId(null);
      return;
    }
    await refreshProductImages();
    setMediaReordering(false);
    setDraggingImageId(null);
    setDragOverImageId(null);
    setMediaMsg("Image order updated.");
  };

  return (
    <section className="space-y-6">
      <header className="relative overflow-hidden rounded-[28px] border border-slate-300 bg-gradient-to-br from-slate-100 via-white to-blue-100 p-6 shadow-sm">
        <div className="absolute -right-14 -top-16 h-40 w-40 rounded-full bg-slate-300/30 blur-2xl" />
        <div className="absolute -bottom-14 left-20 h-36 w-36 rounded-full bg-blue-300/25 blur-2xl" />
        <div className="relative">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Products</h1>
            <p className="mt-1 text-sm text-slate-600">Create and manage your product catalog by store.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
              onClick={() => setIsCreateModalOpen(true)}
              disabled={!selectedStoreId}
            >
              Add new record
            </button>
            <button
              type="button"
              className="rounded-full border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 disabled:opacity-60"
              onClick={downloadFilteredProductsCsv}
              disabled={!selectedStoreId || filteredProducts.length === 0}
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
            <button
              type="button"
              className="rounded-full border border-blue-300 bg-white px-5 py-2 text-sm font-semibold text-blue-700 shadow-sm transition hover:border-blue-400 disabled:opacity-60"
              onClick={handleSyncPrices}
              disabled={!selectedStoreId || syncingPrices || filteredProducts.length === 0}
            >
              {syncingPrices ? "Syncing..." : `Sync prices${selectedProductIds.length > 0 ? ` (${selectedProductIds.length})` : ""}`}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Products (filter)</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{stats.total}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active (filter)</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{stats.active}</p>
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
                {PRODUCT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {getTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Search</label>
              <div className="relative mt-2">
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 pr-10 text-sm text-slate-700"
                  placeholder="SKU or title"
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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Products</h2>
            <p className="mt-1 text-sm text-slate-500">Visual catalog view. Open details to edit full product info.</p>
            <div className="mt-3 inline-flex rounded-full border border-slate-200 bg-white p-1 shadow-sm">
              <button
                type="button"
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${viewMode === "card" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                onClick={() => {
                  setViewMode("card");
                  setSelectedProductIds([]);
                }}
              >
                Card view
              </button>
              <button
                type="button"
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${viewMode === "table" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                onClick={() => setViewMode("table")}
              >
                Table view
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {viewMode === "table" && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-500">{selectedProductIds.length} selected</span>
                <button
                  type="button"
                  className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  onClick={() => toggleSelectAllFiltered(!isAllFilteredSelected)}
                  disabled={filteredProducts.length === 0}
                >
                  {isAllFilteredSelected ? "Clear all" : `Select all (${filteredProducts.length})`}
                </button>
                <button
                  type="button"
                  className="rounded-full border border-blue-200 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                  onClick={() => handleBulkSetActive(true)}
                  disabled={selectedProductIds.length === 0 || bulkWorking}
                >
                  Activate
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  onClick={() => handleBulkSetActive(false)}
                  disabled={selectedProductIds.length === 0 || bulkWorking}
                >
                  Deactivate
                </button>
                <button
                  type="button"
                  className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                  onClick={handleBulkDelete}
                  disabled={selectedProductIds.length === 0 || bulkWorking}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="rounded-full border border-indigo-200 px-3 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                  onClick={() => setIsAdvancedModalOpen(true)}
                  disabled={selectedProductIds.length === 0 || bulkWorking}
                >
                  Advanced
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Sort</label>
              <select
                className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                value={sort?.key || "title"}
                onChange={(e) =>
                  setSort((prev) => ({
                    key: e.target.value as ProductSortKey,
                    direction: prev?.direction || "asc",
                  }))
                }
              >
                <option value="title">Title</option>
                <option value="sku">SKU</option>
                <option value="type">Type</option>
                <option value="subtype">{getSubtypeLabel(productTypeFilter)}</option>
                <option value="tagline">Tagline</option>
              </select>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                onClick={() => sort && setSort({ key: sort.key, direction: sort.direction === "asc" ? "desc" : "asc" })}
              >
                {sort?.direction === "asc" ? "Asc" : "Desc"}
              </button>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Per page</label>
              <select
                className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
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
          <p className="mt-6 text-sm text-slate-500">Loading products...</p>
        ) : paginatedProducts.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No products for this filter.
          </p>
        ) : viewMode === "card" ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {paginatedProducts.map((product) => {
              const mediaList = productImagesByProductId[product.id] || [];
              const primaryImage = mediaList.find((image) => image.is_primary) || mediaList[0];
              return (
                <article key={product.id} className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="relative h-56 w-full bg-slate-100">
                    {primaryImage ? (
                      <>
                        <img
                          src={getPublicImageUrl(primaryImage.storage_path)}
                          alt={product.title}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          className="absolute right-3 top-3 rounded-full border border-slate-200 bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:border-slate-400"
                          onClick={() => openImagePreview(mediaList, product.title, primaryImage.storage_path)}
                        >
                          View
                        </button>
                      </>
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-sm text-slate-500">
                        No image
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 p-4">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">{product.sku}</p>
                      <h3 className="mt-1 line-clamp-2 text-lg font-semibold text-slate-900">{product.title}</h3>
                    </div>
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-slate-500">Base price</p>
                        <p className="text-2xl font-semibold text-slate-900">{product.base_price.toFixed(2)}</p>
                      </div>
                      <div className="text-right text-xs text-slate-500">
                        <p>{getTypeLabel(product.product_type)}</p>
                        <p>{mediaList.length} image(s)</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:border-slate-400"
                        onClick={() => startEdit(product)}
                      >
                        Details
                      </button>
                      {product.is_active && (
                        <button
                          type="button"
                          className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                          onClick={() => handleSoftDelete(product)}
                        >
                          Deactivate
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-3 text-left">
                    <input
                      type="checkbox"
                      checked={isAllCurrentPageSelected}
                      onChange={(e) => toggleSelectCurrentPage(e.target.checked)}
                      aria-label="Select all on page"
                    />
                  </th>
                  <th className="px-3 py-3 text-left">Photo</th>
                  <th className="px-3 py-3 text-left">Title</th>
                  <th className="px-3 py-3 text-left">SKU</th>
                  <th className="px-3 py-3 text-left">Type</th>
                  <th className="px-3 py-3 text-left">Base price</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedProducts.map((product) => {
                  const mediaList = productImagesByProductId[product.id] || [];
                  const primaryImage = mediaList.find((image) => image.is_primary) || mediaList[0];
                  return (
                    <tr key={product.id} className="align-middle">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selectedProductIds.includes(product.id)}
                          onChange={(e) => toggleProductSelection(product.id, e.target.checked)}
                          aria-label={`Select ${product.sku}`}
                        />
                      </td>
                      <td className="px-3 py-3">
                        {primaryImage ? (
                          <div className="relative h-16 w-16 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                            <img src={getPublicImageUrl(primaryImage.storage_path)} alt={product.title} className="h-full w-full object-cover" />
                            <button
                              type="button"
                              className="absolute right-1 top-1 rounded-full border border-slate-200 bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 shadow-sm"
                              onClick={() => openImagePreview(mediaList, product.title, primaryImage.storage_path)}
                            >
                              View
                            </button>
                          </div>
                        ) : (
                          <div className="h-16 w-16 rounded-lg border border-dashed border-slate-300 bg-slate-50" />
                        )}
                      </td>
                      <td className="px-3 py-3 font-medium text-slate-900">{product.title}</td>
                      <td className="px-3 py-3 text-slate-600">{product.sku}</td>
                      <td className="px-3 py-3 text-slate-600">{getTypeLabel(product.product_type)}</td>
                      <td className="px-3 py-3 text-slate-900">{product.base_price.toFixed(2)}</td>
                      <td className="px-3 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:border-slate-400"
                            onClick={() => startEdit(product)}
                          >
                            Details
                          </button>
                          {product.is_active && (
                            <button
                              type="button"
                              className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                              onClick={() => handleSoftDelete(product)}
                            >
                              Deactivate
                            </button>
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

      {successModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/45 p-4" onClick={() => setSuccessModal(null)}>
          <article
            className="w-full max-w-md rounded-3xl border border-emerald-200 bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              Success
            </div>
            <h3 className="mt-3 text-lg font-semibold text-slate-900">{successModal.title}</h3>
            <p className="mt-2 text-sm text-slate-600">{successModal.message}</p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={() => setSuccessModal(null)}
              >
                Great
              </button>
            </div>
          </article>
        </div>
      )}

      {progressModal && (
        <div className="fixed inset-0 z-[69] flex items-center justify-center bg-slate-900/40 p-4">
          <article className="w-full max-w-md rounded-3xl border border-indigo-200 bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-900">{progressModal.title}</h3>
            <p className="mt-2 text-sm text-slate-600">{progressModal.detail}</p>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                style={{ width: `${Math.max(5, progressModal.percent)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {progressModal.percent}% complete. Please wait, this can take a bit for large selections.
            </p>
          </article>
        </div>
      )}

      {isImageImportPromptOpen && (
        <div className="fixed inset-0 z-[71] flex items-center justify-center bg-slate-900/45 p-4" onClick={() => setIsImageImportPromptOpen(false)}>
          <article
            className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-900">Image Import Fallback</h3>
            <p className="mt-2 text-sm text-slate-600">
              If an image is not found in <span className="font-semibold">{bulkImportPlatform}</span>, should we try{" "}
              <span className="font-semibold">{fallbackPlatform}</span>?
            </p>
            <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={useImageFallback}
                onChange={(e) => setUseImageFallback(e.target.checked)}
              />
              Yes, use fallback marketplace when source has no image.
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setIsImageImportPromptOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  setIsImageImportPromptOpen(false);
                  void runBulkImportMarketplaceImages(useImageFallback);
                }}
              >
                Start import
              </button>
            </div>
          </article>
        </div>
      )}

      {isAdvancedModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-4" onClick={() => setIsAdvancedModalOpen(false)}>
          <article
            className="mx-auto my-6 w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Advanced Bulk Actions</h2>
                <p className="mt-1 text-sm text-slate-500">{selectedProductIds.length} product(s) selected.</p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                onClick={() => setIsAdvancedModalOpen(false)}
              >
                Close
              </button>
            </div>

            <section className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Bulk prices</h3>
              <p className="mt-1 text-xs text-slate-500">Only filled values are applied. Empty fields are left unchanged.</p>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  placeholder="Base price"
                  inputMode="decimal"
                  value={bulkBasePrice}
                  onChange={(e) => setBulkBasePrice(e.target.value)}
                />
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  placeholder="Woo price"
                  inputMode="decimal"
                  value={bulkWooPrice}
                  onChange={(e) => setBulkWooPrice(e.target.value)}
                />
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  placeholder="Etsy price"
                  inputMode="decimal"
                  value={bulkEtsyPrice}
                  onChange={(e) => setBulkEtsyPrice(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="mt-3 rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                onClick={handleBulkUpdatePrices}
                disabled={anyAdvancedWorking || selectedProductIds.length === 0}
              >
                {applyingBulkPrices ? "Applying..." : "Apply prices"}
              </button>
            </section>

            <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Import prices from marketplace</h3>
              <p className="mt-1 text-xs text-slate-500">
                Pulls price by SKU and updates Woo/Etsy price fields for selected products.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Source</label>
                <select
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  value={bulkPriceImportPlatform}
                  onChange={(e) => setBulkPriceImportPlatform(e.target.value as BulkPriceImportPlatform)}
                >
                  <option value="both">Etsy + WooCommerce</option>
                  <option value="etsy">Etsy</option>
                  <option value="woocommerce">WooCommerce</option>
                </select>
                <label className="ml-2 flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={bulkPriceImportToBase}
                    onChange={(e) => setBulkPriceImportToBase(e.target.checked)}
                  />
                  Also overwrite base price
                </label>
                <button
                  type="button"
                  className="rounded-full border border-emerald-200 px-4 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  onClick={handleBulkImportMarketplacePrices}
                  disabled={anyAdvancedWorking || selectedProductIds.length === 0}
                >
                  {importingMarketplacePrices ? "Importing..." : "Import prices"}
                </button>
              </div>
            </section>

            <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Import images from marketplace</h3>
              <p className="mt-1 text-xs text-slate-500">
                Pulls product images by SKU mapping from the selected platform and attaches them to selected products.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Source</label>
                <select
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  value={bulkImportPlatform}
                  onChange={(e) => setBulkImportPlatform(e.target.value as BulkImportPlatform)}
                >
                  <option value="etsy">Etsy</option>
                  <option value="woocommerce">WooCommerce</option>
                </select>
                <button
                  type="button"
                  className="rounded-full border border-indigo-200 px-4 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                  onClick={handleBulkImportMarketplaceImages}
                  disabled={anyAdvancedWorking || selectedProductIds.length === 0}
                >
                  {importingMarketplaceImages ? "Importing..." : "Import images"}
                </button>
              </div>
            </section>
          </article>
        </div>
      )}

      {isCreateModalOpen && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-4"
          onClick={() => {
            setIsCreateModalOpen(false);
            setCreateMediaFiles([]);
          }}
        >
          <article
            className="mx-auto my-6 w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Add new record</h2>
                <p className="mt-1 text-sm text-slate-500">Fill in the fields to create a new product.</p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                onClick={() => {
                  setIsCreateModalOpen(false);
                  setCreateMediaFiles([]);
                }}
              >
                Close
              </button>
            </div>

            <form className="mt-5 space-y-4" onSubmit={handleCreateProduct}>
              <div>
                <label className="text-sm font-medium text-slate-700">SKU</label>
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="e.g. SODA-600ML"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700">Title</label>
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Standardized product name"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700">Product type</label>
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
                  <label className="text-sm font-medium text-slate-700">Scale</label>
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    value={escala}
                    onChange={(e) => setEscala(e.target.value)}
                    placeholder="e.g. 1:400"
                  />
                </div>
              )}

              {productType === "ropa" && (
                <div>
                  <label className="text-sm font-medium text-slate-700">Clothing type</label>
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    value={clothingType}
                    onChange={(e) => setClothingType(e.target.value)}
                    placeholder="e.g. T-shirt"
                  />
                </div>
              )}

              {productType === "accesorios" && (
                <div>
                  <label className="text-sm font-medium text-slate-700">Accessory type</label>
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    value={accessoryType}
                    onChange={(e) => setAccessoryType(e.target.value)}
                    placeholder="e.g. Keychain"
                  />
                </div>
              )}

              <div>
                <label className="text-sm font-medium text-slate-700">Tagline</label>
                <input
                  className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={catchyPhrase}
                  onChange={(e) => setCatchyPhrase(e.target.value)}
                    placeholder="e.g. Refreshing and light"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label className="text-sm font-medium text-slate-700">Base price</label>
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    value={basePrice}
                    onChange={(e) => setBasePrice(e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Woo price (optional)</label>
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    value={wooPrice}
                    onChange={(e) => setWooPrice(e.target.value)}
                    placeholder="Use base price"
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Etsy price (optional)</label>
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    value={etsyPrice}
                    onChange={(e) => setEtsyPrice(e.target.value)}
                    placeholder="Use base price"
                    inputMode="decimal"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Media (optional)</label>
                <input
                  className="mt-2 block w-full text-sm text-slate-700 file:mr-3 file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => setCreateMediaFiles(Array.from(e.target.files || []))}
                  disabled={saving}
                />
                <p className="mt-2 text-xs text-slate-500">
                  {createMediaFiles.length > 0
                    ? `${createMediaFiles.length} image(s) selected. They will upload after product creation.`
                    : "You can add product images now and keep editing details later."}
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input checked={isActive} onChange={(e) => setIsActive(e.target.checked)} type="checkbox" />
                Active
              </label>

              <button
                className="w-full rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
                type="submit"
                disabled={saving || !selectedStoreId}
              >
                {saving ? "Saving..." : "Create product"}
              </button>
            </form>
          </article>
        </div>
      )}

      {editingProduct && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-4" onClick={cancelEdit}>
          <article
            className="mx-auto my-6 w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Product Details</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {editingProduct.sku} - {editingProduct.title}
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
                onClick={cancelEdit}
              >
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-slate-700">SKU</label>
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={editSku}
                  onChange={(e) => setEditSku(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Title</label>
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Type</label>
                <select
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={editProductType}
                  onChange={(e) => setEditProductType(e.target.value as ProductType)}
                >
                  {PRODUCT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {getTypeLabel(type)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">{getSubtypeLabel(editProductType)}</label>
                {editProductType === "maquetas" ? (
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={editEscala}
                    onChange={(e) => setEditEscala(e.target.value)}
                  />
                ) : editProductType === "ropa" ? (
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={editClothingType}
                    onChange={(e) => setEditClothingType(e.target.value)}
                  />
                ) : (
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={editAccessoryType}
                    onChange={(e) => setEditAccessoryType(e.target.value)}
                  />
                )}
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium text-slate-700">Tagline</label>
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={editPhrase}
                  onChange={(e) => setEditPhrase(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Base price</label>
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={editBasePrice}
                  onChange={(e) => setEditBasePrice(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Woo price (optional)</label>
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={editWooPrice}
                  onChange={(e) => setEditWooPrice(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Etsy price (optional)</label>
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  value={editEtsyPrice}
                  onChange={(e) => setEditEtsyPrice(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              <div className="flex items-center">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
                  Active
                </label>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-900">Media</h3>
                <p className="text-xs text-slate-500">{currentMediaList.length} image(s)</p>
              </div>
              <input
                className="mt-3 block w-full text-sm text-slate-700 file:mr-3 file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
                type="file"
                accept="image/*"
                multiple
                onChange={handleUploadMedia}
                disabled={mediaUploading || mediaReordering}
              />
              {mediaUploading && <p className="mt-2 text-xs text-slate-500">Uploading images...</p>}
              {mediaReordering && <p className="mt-2 text-xs text-slate-500">Reordering images...</p>}
              {mediaLoading && <p className="mt-2 text-xs text-slate-500">Loading existing images...</p>}
              {mediaMsg && <p className="mt-2 text-xs text-slate-600">{mediaMsg}</p>}
              {currentMediaList.length > 1 && <p className="mt-2 text-xs text-slate-500">Drag and drop images to reorder them.</p>}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {currentMediaList.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">
                    No images uploaded yet.
                  </p>
                ) : (
                  currentMediaList.map((image) => (
                    <article
                      key={image.id}
                      className={`rounded-2xl border bg-white p-3 transition ${
                        dragOverImageId === image.id ? "border-indigo-400 ring-2 ring-indigo-100" : "border-slate-200"
                      }`}
                      draggable={!mediaReordering}
                      onDragStart={() => setDraggingImageId(image.id)}
                      onDragEnd={() => {
                        setDraggingImageId(null);
                        setDragOverImageId(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (draggingImageId && draggingImageId !== image.id) setDragOverImageId(image.id);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!draggingImageId || draggingImageId === image.id) return;
                        void handleReorderImages(draggingImageId, image.id);
                      }}
                    >
                      <div className="relative">
                        <img
                          src={getPublicImageUrl(image.storage_path)}
                          alt={`${editingProduct.title} media`}
                          className="h-40 w-full rounded-xl border border-slate-200 object-cover"
                        />
                        <button
                          type="button"
                          className="absolute right-2 top-2 rounded-full border border-slate-200 bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:border-slate-400"
                          onClick={() => openImagePreview(currentMediaList, editingProduct.title, image.storage_path)}
                        >
                          View
                        </button>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-500">
                          {image.is_primary ? "Cover image" : "Image"} {draggingImageId === image.id ? "(moving...)" : ""}
                        </span>
                        <div className="flex gap-2">
                          {!image.is_primary && (
                            <button
                              type="button"
                              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:border-slate-400"
                              onClick={() => handleSetPrimaryImage(image)}
                            >
                              Set cover
                            </button>
                          )}
                          <button
                            type="button"
                            className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                            onClick={() => handleDeleteImage(image)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
                onClick={cancelEdit}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                onClick={handleSaveEdit}
                disabled={savingEdit}
              >
                {savingEdit ? "Saving..." : "Save changes"}
              </button>
            </div>
          </article>
        </div>
      )}

      {previewGallery && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/80 p-4" onClick={() => setPreviewGallery(null)}>
          <article className="relative w-full max-w-5xl rounded-2xl border border-slate-700 bg-slate-950 p-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="absolute right-3 top-3 rounded-full border border-slate-500 bg-slate-900/80 px-3 py-1 text-xs font-semibold text-slate-100 hover:border-slate-300"
              onClick={() => setPreviewGallery(null)}
            >
              Close
            </button>
            <div className="absolute left-3 top-3 rounded-full border border-slate-600 bg-slate-900/80 px-3 py-1 text-xs font-semibold text-slate-100">
              {previewGallery.index + 1} / {previewGallery.urls.length}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded-full border border-slate-500 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-300 disabled:opacity-40"
                disabled={previewGallery.index === 0}
                onClick={() =>
                  setPreviewGallery((prev) =>
                    prev ? { ...prev, index: Math.max(0, prev.index - 1) } : prev,
                  )
                }
              >
                Prev
              </button>
              <img
                src={previewGallery.urls[previewGallery.index]}
                alt={previewGallery.title}
                className="max-h-[82vh] w-full rounded-xl object-contain"
              />
              <button
                type="button"
                className="rounded-full border border-slate-500 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-100 hover:border-slate-300 disabled:opacity-40"
                disabled={previewGallery.index >= previewGallery.urls.length - 1}
                onClick={() =>
                  setPreviewGallery((prev) =>
                    prev ? { ...prev, index: Math.min(prev.urls.length - 1, prev.index + 1) } : prev,
                  )
                }
              >
                Next
              </button>
            </div>
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
                  Required: sku,title. Optional: product_type, escala, clothing_type, accessory_type, catchy_phrase, is_active.
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
          <h3 className="text-sm font-semibold text-rose-800">CSV import errors ({csvErrors.length})</h3>
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

