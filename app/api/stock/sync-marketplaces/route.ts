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
  is_active: boolean | null;
};

type StoreIntegrationRow = {
  woo_url: string | null;
  woo_key: string | null;
  woo_secret: string | null;
  etsy_bearer: string | null;
  etsy_refresh_token: string | null;
  etsy_token_expires_at: string | null;
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
  refreshToken: string;
  tokenExpiresAt: string | null;
  apiKey: string;
  shopName: string;
  skuMap: Map<string, EtsySkuMapEntry>;
};

type EtsyRefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type SnapshotRow = {
  product_id: string;
  channel: "woocommerce" | "etsy";
  stock_qty: number | null;
  status: string | null;
};

function normalizeSku(raw: string | null | undefined): string {
  return (raw || "").trim().toUpperCase();
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

type EtsyOfferingWritable = {
  quantity?: number | null;
  is_enabled?: boolean;
  price?: unknown;
  readiness_state_id?: number;
};

type EtsyProductWritable = {
  sku?: string[] | string | null;
  property_values?: unknown[];
  offerings?: EtsyOfferingWritable[];
};

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
    if (Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0) {
      return amount / divisor;
    }
    const nested = normalizeEtsyPrice(v.value);
    if (Number.isFinite(nested) && nested > 0) return nested;
  }
  return 0.01;
}

function sanitizeEtsyProducts(products: unknown[]): EtsyProductWritable[] {
  const sanitized: EtsyProductWritable[] = [];

  for (const raw of products) {
    if (!raw || typeof raw !== "object") continue;
    const product = raw as {
      sku?: string[] | string | null;
      property_values?: unknown[];
      offerings?: Array<{
        quantity?: number | null;
        is_enabled?: boolean;
        price?: unknown;
        readiness_state_id?: number | null;
      }>;
    };

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

    const fallbackReadinessStateId = offerings.find((offering) => typeof offering.readiness_state_id === "number")
      ?.readiness_state_id;
    if (typeof fallbackReadinessStateId === "number") {
      for (const offering of offerings) {
        if (typeof offering.readiness_state_id !== "number") {
          offering.readiness_state_id = fallbackReadinessStateId;
        }
      }
    }

    sanitized.push({
      sku: product.sku ?? [],
      property_values: Array.isArray(product.property_values) ? product.property_values : [],
      offerings,
    });
  }

  return sanitized;
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

function formatUnknownError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [];
  if (error.message) parts.push(error.message);

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeObj = cause as { code?: unknown; errno?: unknown; message?: unknown };
    const causeBits: string[] = [];
    if (typeof causeObj.code === "string" && causeObj.code.trim()) causeBits.push(causeObj.code.trim());
    if (typeof causeObj.errno === "number") causeBits.push(`errno ${causeObj.errno}`);
    if (typeof causeObj.message === "string" && causeObj.message.trim()) causeBits.push(causeObj.message.trim());
    if (causeBits.length > 0) parts.push(causeBits.join(" | "));
  } else if (typeof cause === "string" && cause.trim()) {
    parts.push(cause.trim());
  }

  return parts.filter(Boolean).join(" :: ") || "Unknown error";
}

function isDnsLookupError(error: unknown): boolean {
  const normalized = formatUnknownError(error).toLowerCase();
  return normalized.includes("enotfound") || normalized.includes("eai_again") || normalized.includes("getaddrinfo");
}

function toggleWwwHost(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase().startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return url.toString();
    }
    url.hostname = `www.${url.hostname}`;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchWooWithFallback(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { cache: "no-store", ...(init || {}) });
  } catch (primaryError) {
    if (!isDnsLookupError(primaryError)) throw primaryError;
    const fallbackUrl = toggleWwwHost(url);
    if (!fallbackUrl) throw primaryError;
    try {
      return await fetch(fallbackUrl, { cache: "no-store", ...(init || {}) });
    } catch (fallbackError) {
      throw new Error(`DNS resolution failed for Woo URL (${formatUnknownError(primaryError)}; fallback failed: ${formatUnknownError(fallbackError)})`);
    }
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

function isInvalidTokenMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("401") && normalized.includes("invalid_token");
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
  const exactRes = await fetchWooWithFallback(exactUrl, { method: "GET" });
  if (!exactRes.ok) {
    throw new Error(`Woo lookup failed for ${sku}: ${await parseErrorBody(exactRes)}`);
  }
  const exactData = (await exactRes.json()) as WooProduct[];
  const exactMatches = (exactData || []).filter((p) => normalizeSku(p.sku) === sku);
  if (exactMatches.length > 0) return exactMatches;

  const searchUrl = buildWooUrl(config, "/products", { search: sku, per_page: "100" });
  const searchRes = await fetchWooWithFallback(searchUrl, { method: "GET" });
  if (!searchRes.ok) {
    throw new Error(`Woo search failed for ${sku}: ${await parseErrorBody(searchRes)}`);
  }
  const searchData = (await searchRes.json()) as WooProduct[];
  return (searchData || []).filter((p) => normalizeSku(p.sku) === sku);
}

type SyncSkuRow = {
  stockQty: number;
  shouldBeActive: boolean;
};

async function syncWooStock(config: ResolvedWooConfig | null, rowsBySku: Map<string, SyncSkuRow>) {
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

  for (const [sku, row] of rowsBySku.entries()) {
    try {
      const products = await findWooProductsBySku(config, sku);
      if (products.length === 0) {
        missingSkus.push(sku);
        continue;
      }

      for (const product of products) {
        const updateUrl = buildWooUrl(config, `/products/${product.id}`);
        const updateRes = await fetchWooWithFallback(updateUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manage_stock: true,
            stock_quantity: row.stockQty,
            stock_status: row.stockQty > 0 ? "instock" : "outofstock",
            status: row.shouldBeActive ? "publish" : "draft",
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
  const refreshToken = pickFirstNonEmpty(integration?.etsy_refresh_token, process.env.ETSY_REFRESH_TOKEN);
  const tokenExpiresAt = pickFirstNonEmpty(integration?.etsy_token_expires_at, process.env.ETSY_TOKEN_EXPIRES_AT) || null;
  const apiKey = pickFirstNonEmpty(integration?.etsy_keystring, process.env.ETSY_KEYSTRING);
  const shopName = pickFirstNonEmpty(integration?.etsy_shop_name, process.env.ETSY_SHOP_NAME);
  const envMap = safeJsonParse<Record<string, EtsySkuMapEntry>>(process.env.ETSY_SKUMAP_JSON || "{}", {});
  const storeMap = integration?.etsy_skumap_json || {};
  const mergedMap = { ...envMap, ...storeMap };
  if (!bearer || !apiKey || !shopName || Object.keys(mergedMap).length === 0) return null;

  const skuMap = new Map<string, EtsySkuMapEntry>();
  for (const [sku, entry] of Object.entries(mergedMap)) {
    skuMap.set(normalizeSku(sku), entry || {});
  }
  return { bearer, refreshToken, tokenExpiresAt, apiKey, shopName, skuMap };
}

function shouldIgnoreStockMismatch(channel: string, status: string | null, localStockQty: number): boolean {
  const normalizedStatus = (status || "").trim().toLowerCase();
  return channel === "etsy" && localStockQty <= 0 && normalizedStatus.length > 0 && normalizedStatus !== "active";
}

async function refreshEtsyAccessToken(config: ResolvedEtsyConfig): Promise<EtsyRefreshResponse> {
  if (!config.refreshToken) {
    throw new Error("Etsy access token is invalid and ETSY refresh token is missing.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", config.apiKey);
  body.set("refresh_token", config.refreshToken);

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Etsy token refresh failed: ${await parseErrorBody(res)}`);
  }

  const payload = (await res.json()) as EtsyRefreshResponse;
  if (!payload.access_token) {
    throw new Error("Etsy token refresh failed: access_token missing in response.");
  }
  return payload;
}

async function resolveEtsyShopId(config: ResolvedEtsyConfig): Promise<number> {
  // Etsy listing update endpoints require a numeric shop_id.
  // Accept either a numeric shop id or a shop name in settings.
  if (/^\d+$/.test(config.shopName.trim())) {
    return Number(config.shopName.trim());
  }

  const lookupUrl = new URL("https://openapi.etsy.com/v3/application/shops");
  lookupUrl.searchParams.set("shop_name", config.shopName.trim());
  const lookupRes = await fetch(lookupUrl.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.bearer}`,
      "x-api-key": config.apiKey,
    },
    cache: "no-store",
  });
  if (!lookupRes.ok) {
    throw new Error(`Etsy shop lookup failed: ${await parseErrorBody(lookupRes)}`);
  }

  const lookupPayload = (await lookupRes.json()) as {
    results?: Array<{ shop_id?: number; shop_name?: string }>;
  };
  const shopId = lookupPayload.results?.[0]?.shop_id;
  if (!shopId) {
    throw new Error(`Etsy shop lookup failed: could not resolve shop '${config.shopName}'.`);
  }
  return shopId;
}

async function updateEtsyListingState(
  config: ResolvedEtsyConfig,
  shopId: number,
  listingId: string,
  shouldBeActive: boolean,
) {
  const state = shouldBeActive ? "active" : "inactive";
  const body = new URLSearchParams();
  body.set("state", state);

  const res = await fetch(`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${config.bearer}`,
      "x-api-key": config.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Etsy listing state update failed for ${listingId}: ${await parseErrorBody(res)}`);
  }
}

async function syncEtsyStock(config: ResolvedEtsyConfig | null, rowsBySku: Map<string, SyncSkuRow>) {
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
  const listingsToRefresh = new Map<string, Map<string, SyncSkuRow>>();

  for (const [sku, row] of rowsBySku.entries()) {
    const mapEntry = config.skuMap.get(sku);
    if (!mapEntry?.listing_id) {
      missingSkus.push(sku);
      continue;
    }
    if (!listingsToRefresh.has(mapEntry.listing_id)) {
      listingsToRefresh.set(mapEntry.listing_id, new Map<string, SyncSkuRow>());
    }
    listingsToRefresh.get(mapEntry.listing_id)!.set(sku, row);
  }

  let shopId: number | null = null;
  try {
    shopId = await resolveEtsyShopId(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Etsy shop lookup failed.";
    if (isInvalidTokenMessage(message)) {
      try {
        const refreshed = await refreshEtsyAccessToken(config);
        config.bearer = refreshed.access_token;
        if (refreshed.refresh_token) config.refreshToken = refreshed.refresh_token;
        if (refreshed.expires_in && Number.isFinite(refreshed.expires_in)) {
          config.tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
        }
        shopId = await resolveEtsyShopId(config);
      } catch (refreshError) {
        errors.push(refreshError instanceof Error ? refreshError.message : "Etsy token refresh failed.");
      }
    } else {
      errors.push(message);
    }
  }

  let updatedListings = 0;

  for (const [listingId, skuQtyMap] of listingsToRefresh.entries()) {
    try {
      const shouldBeActive = Array.from(skuQtyMap.values()).some((value) => value.stockQty > 0);

      if (!shouldBeActive) {
        if (shopId) {
          try {
            await updateEtsyListingState(config, shopId, listingId, false);
            updatedListings += 1;
          } catch (error) {
            errors.push(error instanceof Error ? error.message : `Etsy listing state update failed for ${listingId}`);
          }
        } else {
          errors.push(`Etsy listing ${listingId} could not be deactivated because shop id resolution failed.`);
        }
        continue;
      }

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
        products?: Array<{ sku?: string[] | string | null; offerings?: Array<{ quantity?: number | null }> }>;
        price_on_property?: number[];
        quantity_on_property?: number[];
        sku_on_property?: number[];
        readiness_state_on_property?: number[];
      };

      const products = sanitizeEtsyProducts(Array.isArray(inventory.products) ? inventory.products : []);
      let touched = false;

      for (const product of products) {
        const skus = extractSkus(product.sku);
        const matchingSku = skus.find((sku) => skuQtyMap.has(sku));
        if (!matchingSku) continue;

        const nextQty = skuQtyMap.get(matchingSku)!.stockQty;
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
          readiness_state_on_property: Array.isArray(inventory.readiness_state_on_property)
            ? inventory.readiness_state_on_property
            : [],
        }),
      });
      if (!putRes.ok) {
        errors.push(`Etsy update failed for listing ${listingId}: ${await parseErrorBody(putRes)}`);
        continue;
      }

      if (shopId) {
        try {
          await updateEtsyListingState(config, shopId, listingId, true);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `Etsy listing state update failed for ${listingId}`);
        }
      }

      updatedListings += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Etsy unknown error for listing ${listingId}`);
    }
  }

  return {
    enabled: true,
    updatedListings,
    mappedSkus: Array.from(rowsBySku.keys()).filter((sku) => config.skuMap.has(sku)).length,
    missingSkus,
    errors,
  };
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeId?: string; skus?: string[]; syncOnlyMismatches?: boolean };
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

  const [productsRes, movementsRes, integrationsRes, snapshotsRes] = await Promise.all([
    supabaseAdmin.from("products").select("id,sku,is_active").eq("store_id", storeId),
    supabaseAdmin.from("stock_movements").select("product_id,movement_type,quantity,qty_change").eq("store_id", storeId),
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabaseAdmin
      .from("marketplace_product_snapshots")
      .select("product_id,channel,stock_qty,status")
      .eq("store_id", storeId)
      .in("channel", ["woocommerce", "etsy"]),
  ]);

  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (movementsRes.error) return NextResponse.json({ error: movementsRes.error.message }, { status: 400 });
  if (snapshotsRes.error) return NextResponse.json({ error: snapshotsRes.error.message }, { status: 400 });

  const integrationRow = integrationsRes.error ? null : ((integrationsRes.data ?? null) as StoreIntegrationRow | null);
  const integrationReadError = integrationsRes.error?.message
    ? integrationsRes.error.message.includes("Could not find the table 'public.store_integrations'")
      ? "Missing DB table: public.store_integrations. Run sql/store_integrations.sql in Supabase SQL Editor."
      : integrationsRes.error.message
    : null;

  const products = (productsRes.data ?? []) as ProductRow[];
  const movements = (movementsRes.data ?? []) as StockMovementRow[];
  const snapshots = (snapshotsRes.data ?? []) as SnapshotRow[];
  const productById = new Map(products.map((product) => [product.id, product]));

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

  const stockBySku = new Map<string, SyncSkuRow>();
  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (!sku) continue;
    const stockQty = toIntegerStock(stockByProductId.get(product.id) || 0);
    const shouldBeActive = stockQty > 0;
    stockBySku.set(sku, { stockQty, shouldBeActive });
  }

  const requestedSkuSet = new Set(
    Array.isArray(body.skus) ? body.skus.map((sku) => normalizeSku(sku)).filter((sku) => sku.length > 0) : [],
  );
  const syncOnlyMismatches = body.syncOnlyMismatches !== false;
  const mismatchSkuSet = new Set<string>();
  for (const snapshot of snapshots) {
    const product = productById.get(snapshot.product_id);
    if (!product) continue;
    const sku = normalizeSku(product.sku);
    if (!sku) continue;
    if (snapshot.stock_qty == null || !Number.isFinite(Number(snapshot.stock_qty))) continue;
    const localStockQty = toIntegerStock(stockByProductId.get(snapshot.product_id) || 0);
    const marketplaceQty = toIntegerStock(Number(snapshot.stock_qty));
    if (localStockQty === marketplaceQty) continue;
    if (shouldIgnoreStockMismatch(snapshot.channel, snapshot.status, localStockQty)) continue;
    mismatchSkuSet.add(sku);
  }

  const stockBySkuToSync = new Map<string, SyncSkuRow>();
  const skippedRequestedSkus: string[] = [];

  if (requestedSkuSet.size > 0) {
    for (const sku of requestedSkuSet) {
      if (!stockBySku.has(sku)) {
        skippedRequestedSkus.push(sku);
        continue;
      }
      stockBySkuToSync.set(sku, stockBySku.get(sku)!);
    }
  } else if (syncOnlyMismatches) {
    for (const sku of mismatchSkuSet) {
      const row = stockBySku.get(sku);
      if (row) stockBySkuToSync.set(sku, row);
    }
  } else {
    for (const [sku, qty] of stockBySku.entries()) stockBySkuToSync.set(sku, qty);
  }

  const wooConfig = resolveWooConfig(integrationRow);
  const etsyConfig = resolveEtsyConfig(integrationRow);

  const [wooResult, etsyResult] = await Promise.all([
    syncWooStock(wooConfig, stockBySkuToSync),
    syncEtsyStock(etsyConfig, stockBySkuToSync),
  ]);

  if (etsyConfig && integrationRow) {
    const bearerChanged = etsyConfig.bearer !== (integrationRow.etsy_bearer || "");
    const refreshChanged = etsyConfig.refreshToken !== (integrationRow.etsy_refresh_token || "");
    const expiresChanged = (etsyConfig.tokenExpiresAt || "") !== (integrationRow.etsy_token_expires_at || "");
    if (bearerChanged || refreshChanged || expiresChanged) {
      await supabaseAdmin
        .from("store_integrations")
        .upsert(
          {
            store_id: storeId,
            etsy_bearer: etsyConfig.bearer,
            etsy_refresh_token: etsyConfig.refreshToken || null,
            etsy_token_expires_at: etsyConfig.tokenExpiresAt,
            updated_at: new Date().toISOString(),
          } as any,
          { onConflict: "store_id" },
        );
    }
  }

  const extraErrors = integrationReadError ? [integrationReadError] : [];

  return NextResponse.json({
    ok: true,
    syncMode: requestedSkuSet.size > 0 ? "selected" : syncOnlyMismatches ? "mismatches" : "all",
    mismatchSkuCount: mismatchSkuSet.size,
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
