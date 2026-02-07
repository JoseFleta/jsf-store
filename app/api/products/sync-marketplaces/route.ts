import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type StoreIntegrationRow = {
  woo_url: string | null;
  woo_key: string | null;
  woo_secret: string | null;
  etsy_bearer: string | null;
  etsy_refresh_token: string | null;
  etsy_token_expires_at: string | null;
  etsy_keystring: string | null;
  etsy_shop_name: string | null;
  etsy_skumap_json: Record<string, { listing_id?: string }> | null;
};

type ProductRow = {
  id: string;
  sku: string | null;
  base_price: number | null;
  woo_price: number | null;
  etsy_price: number | null;
};

type WooProduct = { id: number; sku?: string | null };

type ResolvedWooConfig = { baseUrl: string; key: string; secret: string };

type ResolvedEtsyConfig = {
  bearer: string;
  refreshToken: string;
  tokenExpiresAt: string | null;
  apiKey: string;
  skuMap: Map<string, { listing_id?: string }>;
};

type EtsyProductWritable = {
  sku?: string[] | string | null;
  property_values?: unknown[];
  offerings?: Array<{
    quantity?: number | null;
    is_enabled?: boolean;
    price?: unknown;
    readiness_state_id?: number;
  }>;
};

function normalizeSku(raw: string | null | undefined): string {
  return (raw || "").trim().toUpperCase();
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
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

function normalizePrice(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.round(value * 100) / 100;
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
  if (!exactRes.ok) throw new Error(`Woo lookup failed for ${sku}: ${await parseErrorBody(exactRes)}`);
  const exactData = (await exactRes.json()) as WooProduct[];
  const exactMatches = (exactData || []).filter((p) => normalizeSku(p.sku) === sku);
  if (exactMatches.length > 0) return exactMatches;

  const searchUrl = buildWooUrl(config, "/products", { search: sku, per_page: "100" });
  const searchRes = await fetch(searchUrl, { method: "GET", cache: "no-store" });
  if (!searchRes.ok) throw new Error(`Woo search failed for ${sku}: ${await parseErrorBody(searchRes)}`);
  const searchData = (await searchRes.json()) as WooProduct[];
  return (searchData || []).filter((p) => normalizeSku(p.sku) === sku);
}

async function syncWooPrices(config: ResolvedWooConfig | null, skuToPrice: Map<string, number>) {
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

  for (const [sku, price] of skuToPrice.entries()) {
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
          body: JSON.stringify({ regular_price: price.toFixed(2) }),
        });
        if (!updateRes.ok) {
          errors.push(`Woo price update failed for ${sku} (id ${product.id}): ${await parseErrorBody(updateRes)}`);
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

function normalizeEtsyPrice(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeEtsyPrice(item);
      if (Number.isFinite(normalized) && normalized > 0) return normalized;
    }
  }
  if (value && typeof value === "object") {
    const v = value as { amount?: unknown; divisor?: unknown; value?: unknown };
    const amount = typeof v.amount === "number" ? v.amount : Number(v.amount);
    const divisor = typeof v.divisor === "number" ? v.divisor : Number(v.divisor);
    if (Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0) return amount / divisor;
    const nested = normalizeEtsyPrice(v.value);
    if (Number.isFinite(nested) && nested > 0) return nested;
  }
  return 0.01;
}

function extractSkus(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? normalizeSku(item) : ""))
      .filter((sku) => sku.length > 0);
  }
  if (typeof value === "string") {
    const sku = normalizeSku(value);
    return sku ? [sku] : [];
  }
  return [];
}

function sanitizeEtsyProducts(products: unknown[]): EtsyProductWritable[] {
  const sanitized: EtsyProductWritable[] = [];
  for (const raw of products) {
    if (!raw || typeof raw !== "object") continue;
    const product = raw as EtsyProductWritable;
    const offerings = Array.isArray(product.offerings)
      ? product.offerings.map((offering) => ({
          quantity: typeof offering?.quantity === "number" ? offering.quantity : 0,
          is_enabled: typeof offering?.is_enabled === "boolean" ? offering.is_enabled : true,
          price: normalizeEtsyPrice(offering?.price),
          readiness_state_id:
            typeof offering?.readiness_state_id === "number" && Number.isFinite(offering.readiness_state_id)
              ? offering.readiness_state_id
              : undefined,
        }))
      : [];

    sanitized.push({
      sku: product.sku ?? [],
      property_values: Array.isArray(product.property_values) ? product.property_values : [],
      offerings,
    });
  }
  return sanitized;
}

function resolveEtsyConfig(integration: StoreIntegrationRow | null): ResolvedEtsyConfig | null {
  const bearer = pickFirstNonEmpty(integration?.etsy_bearer, process.env.ETSY_BEARER);
  const refreshToken = pickFirstNonEmpty(integration?.etsy_refresh_token, process.env.ETSY_REFRESH_TOKEN);
  const tokenExpiresAt = pickFirstNonEmpty(integration?.etsy_token_expires_at, process.env.ETSY_TOKEN_EXPIRES_AT) || null;
  const apiKey = pickFirstNonEmpty(integration?.etsy_keystring, process.env.ETSY_KEYSTRING);
  const envMap = safeJsonParse<Record<string, { listing_id?: string }>>(process.env.ETSY_SKUMAP_JSON || "{}", {});
  const storeMap = integration?.etsy_skumap_json || {};
  const mergedMap = { ...envMap, ...storeMap };
  if (!bearer || !apiKey || Object.keys(mergedMap).length === 0) return null;
  const skuMap = new Map<string, { listing_id?: string }>();
  for (const [sku, entry] of Object.entries(mergedMap)) skuMap.set(normalizeSku(sku), entry || {});
  return { bearer, refreshToken, tokenExpiresAt, apiKey, skuMap };
}

async function syncEtsyPrices(config: ResolvedEtsyConfig | null, skuToPrice: Map<string, number>) {
  if (!config) {
    return {
      enabled: false,
      updatedListings: 0,
      missingSkus: [] as string[],
      errors: ["Etsy not configured for this store."],
    };
  }
  const missingSkus: string[] = [];
  const errors: string[] = [];
  const listingsToRefresh = new Map<string, Map<string, number>>();

  for (const [sku, price] of skuToPrice.entries()) {
    const mapEntry = config.skuMap.get(sku);
    if (!mapEntry?.listing_id) {
      missingSkus.push(sku);
      continue;
    }
    if (!listingsToRefresh.has(mapEntry.listing_id)) listingsToRefresh.set(mapEntry.listing_id, new Map<string, number>());
    listingsToRefresh.get(mapEntry.listing_id)!.set(sku, price);
  }

  let updatedListings = 0;
  for (const [listingId, skuPriceMap] of listingsToRefresh.entries()) {
    try {
      const inventoryUrl = `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`;
      const headers = { Authorization: `Bearer ${config.bearer}`, "x-api-key": config.apiKey };

      const getRes = await fetch(inventoryUrl, { method: "GET", headers, cache: "no-store" });
      if (!getRes.ok) {
        errors.push(`Etsy get inventory failed for listing ${listingId}: ${await parseErrorBody(getRes)}`);
        continue;
      }

      const inventory = (await getRes.json()) as {
        products?: unknown[];
        price_on_property?: number[];
        quantity_on_property?: number[];
        sku_on_property?: number[];
        readiness_state_on_property?: number[];
      };

      const products = sanitizeEtsyProducts(Array.isArray(inventory.products) ? inventory.products : []);
      let touched = false;

      for (const product of products) {
        const skus = extractSkus(product.sku);
        const matchingSku = skus.find((sku) => skuPriceMap.has(sku));
        if (!matchingSku) continue;
        const nextPrice = skuPriceMap.get(matchingSku)!;
        const offerings = Array.isArray(product.offerings) ? product.offerings : [];
        for (const offering of offerings) {
          offering.price = nextPrice;
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
          readiness_state_on_property: Array.isArray(inventory.readiness_state_on_property)
            ? inventory.readiness_state_on_property
            : [],
        }),
      });
      if (!putRes.ok) {
        errors.push(`Etsy price update failed for listing ${listingId}: ${await parseErrorBody(putRes)}`);
        continue;
      }
      updatedListings += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Etsy unknown error for listing ${listingId}`);
    }
  }

  return { enabled: true, updatedListings, missingSkus, errors };
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeId?: string; productIds?: string[] };
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

  const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id) => typeof id === "string" && id.trim()) : [];

  let productsQuery = supabaseAdmin
    .from("products")
    .select("id,sku,base_price,woo_price,etsy_price")
    .eq("store_id", storeId);
  if (productIds.length > 0) {
    productsQuery = productsQuery.in("id", productIds);
  }

  const [productsRes, integrationsRes] = await Promise.all([
    productsQuery,
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);

  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  const integrationRow = integrationsRes.error ? null : ((integrationsRes.data ?? null) as StoreIntegrationRow | null);

  const products = (productsRes.data ?? []) as ProductRow[];
  const wooMap = new Map<string, number>();
  const etsyMap = new Map<string, number>();
  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (!sku) continue;
    const base = normalizePrice(product.base_price);
    const woo = normalizePrice(product.woo_price) ?? base;
    const etsy = normalizePrice(product.etsy_price) ?? base;
    if (woo != null) wooMap.set(sku, woo);
    if (etsy != null) etsyMap.set(sku, etsy);
  }

  const wooConfig = resolveWooConfig(integrationRow);
  const etsyConfig = resolveEtsyConfig(integrationRow);
  const [wooResult, etsyResult] = await Promise.all([syncWooPrices(wooConfig, wooMap), syncEtsyPrices(etsyConfig, etsyMap)]);

  return NextResponse.json({
    syncedSkuCount: products.length,
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
      missingSkuCount: etsyResult.missingSkus.length,
      missingSkus: etsyResult.missingSkus.slice(0, 25),
      errors: etsyResult.errors.slice(0, 25),
    },
    errors: [...wooResult.errors, ...etsyResult.errors].slice(0, 25),
  });
}

