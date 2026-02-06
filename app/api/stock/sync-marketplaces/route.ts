import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type StockMovementRow = {
  product_id: string;
  movement_type: "purchase" | "sale";
  quantity: number | null;
  qty_change: number | null;
};

type ProductRow = {
  id: string;
  sku: string | null;
};

type StoreIntegrationRow = {
  woo_url: string | null;
  woo_key: string | null;
  woo_secret: string | null;
  etsy_bearer: string | null;
  etsy_keystring: string | null;
  etsy_shop_name: string | null;
  etsy_skumap_json: Record<string, EtsySkuMapEntry> | null;
};

type EtsySkuMapEntry = {
  listing_id?: string;
  state?: string;
};

type WooProduct = {
  id: number;
  sku?: string | null;
};

type ResolvedWooConfig = {
  baseUrl: string;
  key: string;
  secret: string;
};

type ResolvedEtsyConfig = {
  bearer: string;
  apiKey: string;
  skuMap: Map<string, EtsySkuMapEntry>;
};

function normalizeSku(raw: string | null | undefined): string {
  return (raw || "").trim().toUpperCase();
}

function toIntegerStock(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `${res.status} ${res.statusText}`;
  const parsed = safeJsonParse<Record<string, unknown> | string>(text, text);
  if (typeof parsed === "string") return `${res.status} ${parsed}`;
  const msg =
    (typeof parsed.message === "string" && parsed.message) ||
    (typeof parsed.error === "string" && parsed.error) ||
    text;
  return `${res.status} ${msg}`;
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function resolveWooConfig(integration: StoreIntegrationRow | null): ResolvedWooConfig | null {
  const baseUrl = pickFirstNonEmpty(integration?.woo_url, process.env.WOO_URL);
  const key = pickFirstNonEmpty(integration?.woo_key, process.env.WOO_KEY);
  const secret = pickFirstNonEmpty(integration?.woo_secret, process.env.WOO_SECRET);
  if (!baseUrl || !key || !secret) return null;
  return { baseUrl, key, secret };
}

function buildWooUrl(config: ResolvedWooConfig, path: string, search?: Record<string, string>) {
  const url = new URL(`/wp-json/wc/v3${path}`, config.baseUrl);
  url.searchParams.set("consumer_key", config.key);
  url.searchParams.set("consumer_secret", config.secret);
  if (search) {
    for (const [key, value] of Object.entries(search)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function findWooProductsBySku(config: ResolvedWooConfig, sku: string): Promise<WooProduct[]> {
  const exactUrl = buildWooUrl(config, "/products", { sku, per_page: "100" });
  const exactRes = await fetch(exactUrl, { method: "GET", cache: "no-store" });
  if (!exactRes.ok) {
    throw new Error(`Woo lookup failed for ${sku}: ${await parseErrorBody(exactRes)}`);
  }
  const exactData = (await exactRes.json()) as WooProduct[];
  const exactMatches = (exactData || []).filter((p) => normalizeSku(p.sku) === sku);
  if (exactMatches.length > 0) return exactMatches;

  const searchUrl = buildWooUrl(config, "/products", { search: sku, per_page: "100" });
  const searchRes = await fetch(searchUrl, { method: "GET", cache: "no-store" });
  if (!searchRes.ok) {
    throw new Error(`Woo search failed for ${sku}: ${await parseErrorBody(searchRes)}`);
  }
  const searchData = (await searchRes.json()) as WooProduct[];
  return (searchData || []).filter((p) => normalizeSku(p.sku) === sku);
}

async function syncWooStock(config: ResolvedWooConfig | null, stockBySku: Map<string, number>) {
  if (!config) {
    return {
      enabled: false,
      updated: 0,
      missingSkus: [] as string[],
      errors: ["Woo not configured for this store."],
    };
  }

  const missingSkus: string[] = [];
  const errors: string[] = [];
  let updated = 0;

  for (const [sku, stockQty] of stockBySku.entries()) {
    try {
      const products = await findWooProductsBySku(config, sku);
      if (products.length === 0) {
        missingSkus.push(sku);
        continue;
      }

      for (const product of products) {
        const updateUrl = buildWooUrl(config, `/products/${product.id}`);
        const updateRes = await fetch(updateUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manage_stock: true,
            stock_quantity: stockQty,
            stock_status: stockQty > 0 ? "instock" : "outofstock",
          }),
        });
        if (!updateRes.ok) {
          errors.push(`Woo update failed for ${sku} (id ${product.id}): ${await parseErrorBody(updateRes)}`);
          continue;
        }
        updated += 1;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Woo unknown error for ${sku}`);
    }
  }

  return { enabled: true, updated, missingSkus, errors };
}

function resolveEtsyConfig(integration: StoreIntegrationRow | null): ResolvedEtsyConfig | null {
  const bearer = pickFirstNonEmpty(integration?.etsy_bearer, process.env.ETSY_BEARER);
  const apiKey = pickFirstNonEmpty(integration?.etsy_keystring, process.env.ETSY_KEYSTRING);
  const envMap = safeJsonParse<Record<string, EtsySkuMapEntry>>(process.env.ETSY_SKUMAP_JSON || "{}", {});
  const storeMap = integration?.etsy_skumap_json || {};
  const mergedMap = { ...envMap, ...storeMap };
  if (!bearer || !apiKey || Object.keys(mergedMap).length === 0) return null;

  const skuMap = new Map<string, EtsySkuMapEntry>();
  for (const [sku, entry] of Object.entries(mergedMap)) {
    skuMap.set(normalizeSku(sku), entry || {});
  }
  return { bearer, apiKey, skuMap };
}

async function syncEtsyStock(config: ResolvedEtsyConfig | null, stockBySku: Map<string, number>) {
  if (!config) {
    return {
      enabled: false,
      updatedListings: 0,
      mappedSkus: 0,
      missingSkus: [] as string[],
      errors: ["Etsy not configured for this store."],
    };
  }

  const missingSkus: string[] = [];
  const errors: string[] = [];
  const listingsToRefresh = new Map<string, Map<string, number>>();

  for (const [sku, qty] of stockBySku.entries()) {
    const mapEntry = config.skuMap.get(sku);
    if (!mapEntry?.listing_id) {
      missingSkus.push(sku);
      continue;
    }
    if (mapEntry.state && mapEntry.state !== "active") continue;
    if (!listingsToRefresh.has(mapEntry.listing_id)) {
      listingsToRefresh.set(mapEntry.listing_id, new Map<string, number>());
    }
    listingsToRefresh.get(mapEntry.listing_id)!.set(sku, qty);
  }

  let updatedListings = 0;

  for (const [listingId, skuQtyMap] of listingsToRefresh.entries()) {
    try {
      const inventoryUrl = `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`;
      const headers = {
        Authorization: `Bearer ${config.bearer}`,
        "x-api-key": config.apiKey,
      };

      const getRes = await fetch(inventoryUrl, { method: "GET", headers, cache: "no-store" });
      if (!getRes.ok) {
        errors.push(`Etsy get inventory failed for listing ${listingId}: ${await parseErrorBody(getRes)}`);
        continue;
      }

      const inventory = (await getRes.json()) as {
        products?: Array<{ sku?: string[] | null; offerings?: Array<{ quantity?: number | null }> }>;
        price_on_property?: number[];
        quantity_on_property?: number[];
        sku_on_property?: number[];
      };

      const products = Array.isArray(inventory.products) ? inventory.products : [];
      let touched = false;

      for (const product of products) {
        const skus = Array.isArray(product.sku) ? product.sku.map(normalizeSku).filter(Boolean) : [];
        const matchingSku = skus.find((sku) => skuQtyMap.has(sku));
        if (!matchingSku) continue;

        const nextQty = skuQtyMap.get(matchingSku)!;
        const offerings = Array.isArray(product.offerings) ? product.offerings : [];
        for (const offering of offerings) {
          offering.quantity = nextQty;
          touched = true;
        }
      }

      if (!touched) continue;

      const putRes = await fetch(inventoryUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          products,
          price_on_property: Array.isArray(inventory.price_on_property) ? inventory.price_on_property : [],
          quantity_on_property: Array.isArray(inventory.quantity_on_property) ? inventory.quantity_on_property : [],
          sku_on_property: Array.isArray(inventory.sku_on_property) ? inventory.sku_on_property : [],
        }),
      });
      if (!putRes.ok) {
        errors.push(`Etsy update failed for listing ${listingId}: ${await parseErrorBody(putRes)}`);
        continue;
      }

      updatedListings += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Etsy unknown error for listing ${listingId}`);
    }
  }

  return {
    enabled: true,
    updatedListings,
    mappedSkus: Array.from(stockBySku.keys()).filter((sku) => config.skuMap.has(sku)).length,
    missingSkus,
    errors,
  };
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeId?: string; skus?: string[] };
  const storeId = (body.storeId || "").trim();
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });

  const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userRes?.user) return NextResponse.json({ error: "Invalid session" }, { status: 401 });

  const { data: membership, error: memErr } = await supabaseAdmin
    .from("store_memberships")
    .select("role")
    .eq("store_id", storeId)
    .eq("user_id", userRes.user.id)
    .maybeSingle();
  if (memErr || !membership) return NextResponse.json({ error: "Store access denied" }, { status: 403 });

  const [productsRes, movementsRes, integrationsRes] = await Promise.all([
    supabaseAdmin.from("products").select("id,sku").eq("store_id", storeId),
    supabaseAdmin.from("stock_movements").select("product_id,movement_type,quantity,qty_change").eq("store_id", storeId),
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);

  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (movementsRes.error) return NextResponse.json({ error: movementsRes.error.message }, { status: 400 });

  const integrationRow = integrationsRes.error ? null : ((integrationsRes.data ?? null) as StoreIntegrationRow | null);
  const integrationReadError = integrationsRes.error?.message
    ? integrationsRes.error.message.includes("Could not find the table 'public.store_integrations'")
      ? "Missing DB table: public.store_integrations. Run sql/store_integrations.sql in Supabase SQL Editor."
      : integrationsRes.error.message
    : null;

  const products = (productsRes.data ?? []) as ProductRow[];
  const movements = (movementsRes.data ?? []) as StockMovementRow[];

  const stockByProductId = new Map<string, number>();
  for (const mv of movements) {
    const current = stockByProductId.get(mv.product_id) || 0;
    const signedQty =
      typeof mv.qty_change === "number"
        ? mv.qty_change
        : mv.movement_type === "purchase"
          ? Number(mv.quantity || 0)
          : -Number(mv.quantity || 0);
    stockByProductId.set(mv.product_id, current + signedQty);
  }

  const stockBySku = new Map<string, number>();
  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (!sku) continue;
    stockBySku.set(sku, toIntegerStock(stockByProductId.get(product.id) || 0));
  }

  const requestedSkuSet = new Set(
    Array.isArray(body.skus) ? body.skus.map((sku) => normalizeSku(sku)).filter((sku) => sku.length > 0) : [],
  );

  const stockBySkuToSync = new Map<string, number>();
  const skippedRequestedSkus: string[] = [];

  if (requestedSkuSet.size > 0) {
    for (const sku of requestedSkuSet) {
      if (!stockBySku.has(sku)) {
        skippedRequestedSkus.push(sku);
        continue;
      }
      stockBySkuToSync.set(sku, stockBySku.get(sku)!);
    }
  } else {
    for (const [sku, qty] of stockBySku.entries()) {
      stockBySkuToSync.set(sku, qty);
    }
  }

  const wooConfig = resolveWooConfig(integrationRow);
  const etsyConfig = resolveEtsyConfig(integrationRow);

  const [wooResult, etsyResult] = await Promise.all([
    syncWooStock(wooConfig, stockBySkuToSync),
    syncEtsyStock(etsyConfig, stockBySkuToSync),
  ]);

  const extraErrors = integrationReadError ? [integrationReadError] : [];

  return NextResponse.json({
    ok: true,
    stockSkuCount: stockBySku.size,
    syncedSkuCount: stockBySkuToSync.size,
    requestedSkuCount: requestedSkuSet.size || null,
    skippedRequestedSkuCount: skippedRequestedSkus.length,
    skippedRequestedSkus: skippedRequestedSkus.slice(0, 25),
    woo: {
      enabled: wooResult.enabled,
      updated: wooResult.updated,
      missingSkuCount: wooResult.missingSkus.length,
      missingSkus: wooResult.missingSkus.slice(0, 25),
      errors: wooResult.errors.slice(0, 25),
    },
    etsy: {
      enabled: etsyResult.enabled,
      updatedListings: etsyResult.updatedListings,
      mappedSkus: etsyResult.mappedSkus,
      missingSkuCount: etsyResult.missingSkus.length,
      missingSkus: etsyResult.missingSkus.slice(0, 25),
      errors: etsyResult.errors.slice(0, 25),
    },
    errors: extraErrors,
  });
}
