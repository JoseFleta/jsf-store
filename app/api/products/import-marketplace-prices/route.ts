import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type ImportPlatform = "woocommerce" | "etsy" | "both";

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
};

type WooProduct = {
  id: number;
  sku?: string | null;
  regular_price?: string | null;
  price?: string | null;
};

type ResolvedWooConfig = { baseUrl: string; key: string; secret: string };

type ResolvedEtsyConfig = {
  bearer: string;
  refreshToken: string;
  tokenExpiresAt: string | null;
  apiKey: string;
  shopName: string;
  skuMap: Map<string, { listing_id?: string }>;
};

type EtsyRefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type EtsyOfferingWritable = {
  price?: unknown;
};

type EtsyProductWritable = {
  sku?: string[] | string | null;
  offerings?: EtsyOfferingWritable[];
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

async function fetchWithDnsFallback(url: string): Promise<Response> {
  try {
    return await fetch(url, { method: "GET", cache: "no-store" });
  } catch (primaryError) {
    if (!isDnsLookupError(primaryError)) {
      throw new Error(`Network request failed: ${formatUnknownError(primaryError)}`);
    }
    const fallbackUrl = toggleWwwHost(url);
    if (!fallbackUrl) {
      throw new Error(`DNS resolution failed: ${formatUnknownError(primaryError)}`);
    }
    try {
      return await fetch(fallbackUrl, { method: "GET", cache: "no-store" });
    } catch (fallbackError) {
      throw new Error(`DNS resolution failed (${formatUnknownError(primaryError)}; fallback failed: ${formatUnknownError(fallbackError)})`);
    }
  }
}

function isInvalidTokenMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("401") && normalized.includes("invalid_token");
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

function normalizePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null;
    return Math.round(value * 100) / 100;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * 100) / 100;
  }
  return null;
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
  return 0;
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
    sanitized.push({
      sku: product.sku ?? [],
      offerings: Array.isArray(product.offerings) ? product.offerings : [],
    });
  }
  return sanitized;
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
  const exactRes = await fetchWithDnsFallback(exactUrl);
  if (!exactRes.ok) throw new Error(`Woo lookup failed for ${sku}: ${await parseErrorBody(exactRes)}`);
  const exactData = (await exactRes.json()) as WooProduct[];
  const exactMatches = (exactData || []).filter((p) => normalizeSku(p.sku) === sku);
  if (exactMatches.length > 0) return exactMatches;

  const searchUrl = buildWooUrl(config, "/products", { search: sku, per_page: "100" });
  const searchRes = await fetchWithDnsFallback(searchUrl);
  if (!searchRes.ok) throw new Error(`Woo search failed for ${sku}: ${await parseErrorBody(searchRes)}`);
  const searchData = (await searchRes.json()) as WooProduct[];
  return (searchData || []).filter((p) => normalizeSku(p.sku) === sku);
}

function resolveEtsyConfig(integration: StoreIntegrationRow | null): ResolvedEtsyConfig | null {
  const bearer = pickFirstNonEmpty(integration?.etsy_bearer, process.env.ETSY_BEARER);
  const refreshToken = pickFirstNonEmpty(integration?.etsy_refresh_token, process.env.ETSY_REFRESH_TOKEN);
  const tokenExpiresAt = pickFirstNonEmpty(integration?.etsy_token_expires_at, process.env.ETSY_TOKEN_EXPIRES_AT) || null;
  const apiKey = pickFirstNonEmpty(integration?.etsy_keystring, process.env.ETSY_KEYSTRING);
  const shopName = pickFirstNonEmpty(integration?.etsy_shop_name, process.env.ETSY_SHOP_NAME);
  const envMap = safeJsonParse<Record<string, { listing_id?: string }>>(process.env.ETSY_SKUMAP_JSON || "{}", {});
  const storeMap = integration?.etsy_skumap_json || {};
  const mergedMap = { ...envMap, ...storeMap };
  if (!bearer || !refreshToken || !apiKey || !shopName || Object.keys(mergedMap).length === 0) return null;
  const skuMap = new Map<string, { listing_id?: string }>();
  for (const [sku, entry] of Object.entries(mergedMap)) skuMap.set(normalizeSku(sku), entry || {});
  return { bearer, refreshToken, tokenExpiresAt, apiKey, shopName, skuMap };
}

async function refreshEtsyAccessToken(config: ResolvedEtsyConfig): Promise<EtsyRefreshResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", config.apiKey);
  body.set("refresh_token", config.refreshToken);

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Etsy token refresh failed: ${await parseErrorBody(res)}`);
  const payload = (await res.json()) as EtsyRefreshResponse;
  if (!payload.access_token) throw new Error("Etsy token refresh failed: access_token missing in response.");
  return payload;
}

async function saveRefreshedEtsyToken(
  supabaseAdmin: any,
  storeId: string,
  config: ResolvedEtsyConfig,
) {
  await supabaseAdmin
    .from("store_integrations")
    .upsert(
      {
        store_id: storeId,
        etsy_bearer: config.bearer,
        etsy_refresh_token: config.refreshToken,
        etsy_token_expires_at: config.tokenExpiresAt,
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "store_id" },
    );
}

async function maybeRefreshEtsyToken(
  supabaseAdmin: any,
  storeId: string,
  config: ResolvedEtsyConfig,
): Promise<void> {
  const nowMs = Date.now();
  const expiresMs = config.tokenExpiresAt ? Date.parse(config.tokenExpiresAt) : NaN;
  const shouldRefresh = Number.isFinite(expiresMs) ? expiresMs - nowMs < 60_000 : false;
  if (!shouldRefresh) return;

  const refreshed = await refreshEtsyAccessToken(config);
  config.bearer = refreshed.access_token;
  if (refreshed.refresh_token) config.refreshToken = refreshed.refresh_token;
  if (refreshed.expires_in && Number.isFinite(refreshed.expires_in)) {
    config.tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  }
  await saveRefreshedEtsyToken(supabaseAdmin, storeId, config);
}

async function fetchEtsyListingInventory(config: ResolvedEtsyConfig, listingId: string) {
  const inventoryUrl = `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`;
  const res = await fetch(inventoryUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.bearer}`,
      "x-api-key": config.apiKey,
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Etsy inventory fetch failed for listing ${listingId}: ${await parseErrorBody(res)}`);
  return (await res.json()) as { products?: unknown[] };
}

async function fetchEtsyListingInventoryWithRefresh(
  supabaseAdmin: any,
  storeId: string,
  config: ResolvedEtsyConfig,
  listingId: string,
) {
  try {
    return await fetchEtsyListingInventory(config, listingId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isInvalidTokenMessage(message)) throw error;
    const refreshed = await refreshEtsyAccessToken(config);
    config.bearer = refreshed.access_token;
    if (refreshed.refresh_token) config.refreshToken = refreshed.refresh_token;
    if (refreshed.expires_in && Number.isFinite(refreshed.expires_in)) {
      config.tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    }
    await saveRefreshedEtsyToken(supabaseAdmin, storeId, config);
    return fetchEtsyListingInventory(config, listingId);
  }
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    storeId?: string;
    productIds?: string[];
    platform?: ImportPlatform;
    updateBasePrice?: boolean;
  };
  const storeId = (body.storeId || "").trim();
  const platform =
    body.platform === "woocommerce" || body.platform === "etsy" || body.platform === "both" ? body.platform : null;
  const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id) => typeof id === "string" && id.trim()) : [];
  const updateBasePrice = Boolean(body.updateBasePrice);

  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });
  if (!platform) return NextResponse.json({ error: "Missing platform" }, { status: 400 });
  if (productIds.length === 0) return NextResponse.json({ error: "Select at least one product." }, { status: 400 });

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

  const [productsRes, integrationsRes] = await Promise.all([
    supabaseAdmin.from("products").select("id,sku").eq("store_id", storeId).in("id", productIds),
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);
  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });

  const products = (productsRes.data ?? []) as ProductRow[];
  const integrationRow = integrationsRes.error ? null : ((integrationsRes.data ?? null) as StoreIntegrationRow | null);

  const wooConfig = resolveWooConfig(integrationRow);
  const etsyConfig = resolveEtsyConfig(integrationRow);
  if ((platform === "woocommerce" || platform === "both") && !wooConfig) {
    return NextResponse.json({ error: "WooCommerce is not configured for this store." }, { status: 400 });
  }
  if ((platform === "etsy" || platform === "both") && !etsyConfig) {
    return NextResponse.json({ error: "Etsy is not configured or SKU map is missing for this store." }, { status: 400 });
  }

  if (platform === "etsy" || platform === "both") {
    try {
      await maybeRefreshEtsyToken(supabaseAdmin, storeId, etsyConfig!);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Etsy token refresh failed." },
        { status: 400 },
      );
    }
  }

  let updatedProducts = 0;
  let updatedWooProducts = 0;
  let updatedEtsyProducts = 0;
  let missingSkuCount = 0;
  let missingPriceCount = 0;
  const errors: string[] = [];

  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (!sku) {
      missingSkuCount += 1;
      continue;
    }

    try {
      let importedWooPrice: number | null = null;
      let importedEtsyPrice: number | null = null;

      if (platform === "woocommerce" || platform === "both") {
        const matches = await findWooProductsBySku(wooConfig!, sku);
        const source = matches[0];
        importedWooPrice = normalizePrice(source?.regular_price) ?? normalizePrice(source?.price);
      }
      if (platform === "etsy" || platform === "both") {
        const listingId = etsyConfig!.skuMap.get(sku)?.listing_id;
        if (!listingId) {
          missingSkuCount += 1;
          if (platform === "etsy") {
            continue;
          }
        } else {
          const inventory = await fetchEtsyListingInventoryWithRefresh(supabaseAdmin, storeId, etsyConfig!, listingId);
          const productsWritable = sanitizeEtsyProducts(Array.isArray(inventory.products) ? inventory.products : []);
          for (const item of productsWritable) {
            const skus = extractSkus(item.sku);
            if (!skus.includes(sku)) continue;
            const offerings = Array.isArray(item.offerings) ? item.offerings : [];
            for (const offering of offerings) {
              const next = normalizePrice(normalizeEtsyPrice(offering?.price));
              if (next != null) {
                importedEtsyPrice = next;
                break;
              }
            }
            if (importedEtsyPrice != null) break;
          }
        }
      }

      if (platform === "both" && importedWooPrice == null && importedEtsyPrice == null) {
        missingPriceCount += 1;
        continue;
      }
      if (platform === "woocommerce" && importedWooPrice == null) {
        missingPriceCount += 1;
        continue;
      }
      if (platform === "etsy" && importedEtsyPrice == null) {
        missingPriceCount += 1;
        continue;
      }

      const payload: { woo_price?: number; etsy_price?: number; base_price?: number } = {};
      if (importedWooPrice != null) payload.woo_price = importedWooPrice;
      if (importedEtsyPrice != null) payload.etsy_price = importedEtsyPrice;
      if (updateBasePrice) {
        const baseFromWooFirst = importedWooPrice ?? importedEtsyPrice;
        if (baseFromWooFirst != null) payload.base_price = baseFromWooFirst;
      }

      const { error: updateErr } = await supabaseAdmin
        .from("products")
        .update(payload)
        .eq("store_id", storeId)
        .eq("id", product.id);
      if (updateErr) {
        errors.push(`Price update failed for ${sku}: ${updateErr.message}`);
        continue;
      }
      updatedProducts += 1;
      if (importedWooPrice != null) updatedWooProducts += 1;
      if (importedEtsyPrice != null) updatedEtsyProducts += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Unknown price import error for ${sku}`);
    }
  }

  return NextResponse.json({
    processedProducts: products.length,
    updatedProducts,
    updatedWooProducts,
    updatedEtsyProducts,
    missingSkuCount,
    missingPriceCount,
    errors: errors.slice(0, 25),
  });
}
