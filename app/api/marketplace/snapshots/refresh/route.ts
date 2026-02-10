import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type IntegrationRow = {
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
  title: string | null;
  base_price: number | null;
  woo_price: number | null;
  etsy_price: number | null;
  is_active: boolean | null;
};

type ProductImageRow = {
  product_id: string;
  storage_path: string;
};

type MovementRow = {
  product_id: string;
  movement_type: "purchase" | "sale";
  quantity: number;
  qty_change?: number | null;
};

type WooProduct = {
  id: number;
  sku?: string | null;
  regular_price?: string | null;
  price?: string | null;
  status?: string | null;
  stock_quantity?: number | null;
  stock_status?: string | null;
  images?: Array<{ src?: string | null }>;
};

type EtsyInventoryResponse = {
  products?: Array<{
    sku?: string[] | string | null;
    offerings?: Array<{ price?: unknown; quantity?: unknown }>;
  }>;
};

type EtsyImagesResponse = {
  results?: Array<{ rank?: number | string | null }>;
};

type EtsyRefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

function normalizeSku(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function pick(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function normalizePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100) / 100;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed * 100) / 100;
  }
  if (value && typeof value === "object") {
    const obj = value as { amount?: unknown; divisor?: unknown; value?: unknown };
    const amount = typeof obj.amount === "number" ? obj.amount : Number(obj.amount);
    const divisor = typeof obj.divisor === "number" ? obj.divisor : Number(obj.divisor);
    if (Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0) return Math.round((amount / divisor) * 100) / 100;
    return normalizePrice(obj.value);
  }
  return null;
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
}

async function parseError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `${res.status} ${res.statusText}`;
  const parsed = safeJsonParse<Record<string, unknown> | string>(text, text);
  if (typeof parsed === "string") return `${res.status} ${parsed}`;
  const msg =
    (typeof parsed.message === "string" && parsed.message) ||
    (typeof parsed.error_description === "string" && parsed.error_description) ||
    (typeof parsed.error === "string" && parsed.error) ||
    text;
  return `${res.status} ${msg}`;
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

async function fetchWooWithFallback(url: string): Promise<Response> {
  try {
    return await fetch(url, { method: "GET", cache: "no-store" });
  } catch (primaryError) {
    if (!isDnsLookupError(primaryError)) throw primaryError;
    const fallbackUrl = toggleWwwHost(url);
    if (!fallbackUrl) throw primaryError;
    try {
      return await fetch(fallbackUrl, { method: "GET", cache: "no-store" });
    } catch (fallbackError) {
      throw new Error(`DNS resolution failed for Woo URL (${formatUnknownError(primaryError)}; fallback failed: ${formatUnknownError(fallbackError)})`);
    }
  }
}

function isEtsyInvalidTokenError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("401") && normalized.includes("invalid_token");
}

async function refreshEtsyAccessToken(refreshToken: string, apiKey: string): Promise<EtsyRefreshResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", apiKey);
  body.set("refresh_token", refreshToken);

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Etsy token refresh failed: ${await parseError(res)}`);
  const payload = (await res.json()) as EtsyRefreshResponse;
  if (!payload.access_token) throw new Error("Etsy token refresh failed: access_token missing in response.");
  return payload;
}

async function persistEtsyToken(
  supabaseAdmin: any,
  storeId: string,
  bearer: string,
  refreshToken: string,
  tokenExpiresAt: string | null,
) {
  await supabaseAdmin
    .from("store_integrations")
    .upsert(
      {
        store_id: storeId,
        etsy_bearer: bearer,
        etsy_refresh_token: refreshToken,
        etsy_token_expires_at: tokenExpiresAt,
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "store_id" },
    );
}

function buildWooUrl(baseUrl: string, key: string, secret: string, path: string, q?: Record<string, string>): string {
  const url = new URL(`/wp-json/wc/v3${path}`, baseUrl);
  url.searchParams.set("consumer_key", key);
  url.searchParams.set("consumer_secret", secret);
  if (q) {
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  }
  return url.toString();
}

async function findWooBySku(baseUrl: string, key: string, secret: string, sku: string): Promise<WooProduct[]> {
  const res = await fetchWooWithFallback(buildWooUrl(baseUrl, key, secret, "/products", { sku, per_page: "100", status: "any" }));
  if (!res.ok) throw new Error(`Woo lookup failed for ${sku}: ${await parseError(res)}`);
  const rows = ((await res.json()) as WooProduct[]).filter((row) => normalizeSku(row.sku) === sku);
  if (rows.length > 0) return rows;

  const res2 = await fetchWooWithFallback(buildWooUrl(baseUrl, key, secret, "/products", { search: sku, per_page: "100", status: "any" }));
  if (!res2.ok) throw new Error(`Woo search failed for ${sku}: ${await parseError(res2)}`);
  return ((await res2.json()) as WooProduct[]).filter((row) => normalizeSku(row.sku) === sku);
}

function extractSkus(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? normalizeSku(v) : "")).filter(Boolean);
  if (typeof value === "string") return normalizeSku(value) ? [normalizeSku(value)] : [];
  return [];
}

function localFingerprint(product: ProductRow, imageCount: number): string {
  return hashText(
    JSON.stringify({
      sku: normalizeSku(product.sku),
      title: product.title || "",
      base_price: Number(product.base_price || 0),
      woo_price: product.woo_price == null ? null : Number(product.woo_price),
      etsy_price: product.etsy_price == null ? null : Number(product.etsy_price),
      is_active: Boolean(product.is_active),
      image_count: imageCount,
    }),
  );
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeId?: string; productIds?: string[] };
  const storeId = (body.storeId || "").trim();
  const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id) => typeof id === "string" && id.trim()) : [];
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });

  const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userRes?.user) return NextResponse.json({ error: "Invalid session" }, { status: 401 });

  const { data: membership } = await supabaseAdmin
    .from("store_memberships")
    .select("role")
    .eq("store_id", storeId)
    .eq("user_id", userRes.user.id)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: "Store access denied" }, { status: 403 });

  let productsQuery = supabaseAdmin
    .from("products")
    .select("id,sku,title,base_price,woo_price,etsy_price,is_active")
    .eq("store_id", storeId);
  if (productIds.length > 0) productsQuery = productsQuery.in("id", productIds);

  let imagesQuery = supabaseAdmin.from("product_images").select("product_id,storage_path").eq("store_id", storeId);
  if (productIds.length > 0) imagesQuery = imagesQuery.in("product_id", productIds);
  let movementsQuery = supabaseAdmin.from("stock_movements").select("product_id,movement_type,quantity,qty_change").eq("store_id", storeId);
  if (productIds.length > 0) movementsQuery = movementsQuery.in("product_id", productIds);

  const [productsRes, imagesRes, movementsRes, integrationRes] = await Promise.all([
    productsQuery,
    imagesQuery,
    movementsQuery,
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);
  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (imagesRes.error) return NextResponse.json({ error: imagesRes.error.message }, { status: 400 });
  if (movementsRes.error) return NextResponse.json({ error: movementsRes.error.message }, { status: 400 });

  const products = (productsRes.data ?? []) as ProductRow[];
  const images = (imagesRes.data ?? []) as ProductImageRow[];
  const movements = (movementsRes.data ?? []) as MovementRow[];
  const integration = (integrationRes.data ?? null) as IntegrationRow | null;

  const wooUrl = pick(integration?.woo_url, process.env.WOO_URL);
  const wooKey = pick(integration?.woo_key, process.env.WOO_KEY);
  const wooSecret = pick(integration?.woo_secret, process.env.WOO_SECRET);
  const wooEnabled = Boolean(wooUrl && wooKey && wooSecret);

  let etsyBearer = pick(integration?.etsy_bearer, process.env.ETSY_BEARER);
  let etsyRefreshToken = pick(integration?.etsy_refresh_token, process.env.ETSY_REFRESH_TOKEN);
  let etsyTokenExpiresAt = pick(integration?.etsy_token_expires_at, process.env.ETSY_TOKEN_EXPIRES_AT) || null;
  const etsyApiKey = pick(integration?.etsy_keystring, process.env.ETSY_KEYSTRING);
  const etsyShopName = pick(integration?.etsy_shop_name, process.env.ETSY_SHOP_NAME);
  const etsyMap = new Map<string, string>();
  for (const [mapSku, entry] of Object.entries(integration?.etsy_skumap_json || {})) {
    const normalized = normalizeSku(mapSku);
    const listingId = entry?.listing_id?.toString().trim();
    if (normalized && listingId) etsyMap.set(normalized, listingId);
  }
  const etsyEnabled = Boolean(etsyBearer && etsyApiKey);

  if (etsyEnabled && etsyRefreshToken && etsyTokenExpiresAt) {
    const expiresAtMs = Date.parse(etsyTokenExpiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() < 60_000) {
      try {
        const refreshed = await refreshEtsyAccessToken(etsyRefreshToken, etsyApiKey);
        etsyBearer = refreshed.access_token;
        if (refreshed.refresh_token) etsyRefreshToken = refreshed.refresh_token;
        if (refreshed.expires_in && Number.isFinite(refreshed.expires_in)) {
          etsyTokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
        }
        await persistEtsyToken(supabaseAdmin, storeId, etsyBearer, etsyRefreshToken, etsyTokenExpiresAt);
      } catch {
        // best effort; request-level retry will try refresh again if a 401 invalid token is returned.
      }
    }
  }

  const imageCountByProductId: Record<string, number> = {};
  for (const image of images) imageCountByProductId[image.product_id] = (imageCountByProductId[image.product_id] || 0) + 1;
  const localStockByProductId: Record<string, number> = {};
  for (const movement of movements) {
    const signedQty =
      typeof movement.qty_change === "number"
        ? movement.qty_change
        : movement.movement_type === "purchase"
        ? Number(movement.quantity || 0)
        : -Number(movement.quantity || 0);
    localStockByProductId[movement.product_id] = (localStockByProductId[movement.product_id] || 0) + signedQty;
  }

  const fetchEtsyJsonWithAutoRefresh = async <T>(url: string, errorLabel: string): Promise<T> => {
    const doFetch = async (): Promise<Response> =>
      fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${etsyBearer}`, "x-api-key": etsyApiKey },
        cache: "no-store",
      });

    let res = await doFetch();
    if (res.ok) return (await res.json()) as T;

    const firstError = await parseError(res);
    if (isEtsyInvalidTokenError(firstError) && etsyRefreshToken) {
      const refreshed = await refreshEtsyAccessToken(etsyRefreshToken, etsyApiKey);
      etsyBearer = refreshed.access_token;
      if (refreshed.refresh_token) etsyRefreshToken = refreshed.refresh_token;
      if (refreshed.expires_in && Number.isFinite(refreshed.expires_in)) {
        etsyTokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      }
      await persistEtsyToken(supabaseAdmin, storeId, etsyBearer, etsyRefreshToken, etsyTokenExpiresAt);

      res = await doFetch();
      if (res.ok) return (await res.json()) as T;
      throw new Error(`${errorLabel}: ${await parseError(res)}`);
    }

    throw new Error(`${errorLabel}: ${firstError}`);
  };

  let mappingDiscoveryError: string | null = null;

  const discoverEtsyMappingsForMissingSkus = async (missingSkus: Set<string>): Promise<void> => {
    if (!etsyEnabled || missingSkus.size === 0 || !etsyShopName) return;

    const resolveShopId = async (): Promise<number> => {
      if (/^\d+$/.test(etsyShopName)) return Number(etsyShopName);
      const lookup = await fetchEtsyJsonWithAutoRefresh<{ results?: Array<{ shop_id?: number }> }>(
        `https://openapi.etsy.com/v3/application/shops?shop_name=${encodeURIComponent(etsyShopName)}`,
        `Etsy shop lookup failed (${etsyShopName})`,
      );
      const shopId = lookup.results?.[0]?.shop_id;
      if (!shopId) throw new Error(`Etsy shop lookup failed for ${etsyShopName}`);
      return shopId;
    };

    const shopId = await resolveShopId();
    const pageSize = 100;
    const states = ["active", "inactive", "draft", "sold_out", "expired"];
    const listingIds = new Set<string>();

    for (const state of states) {
      for (let offset = 0; offset < 5000; offset += pageSize) {
        let rows: Array<{ listing_id?: number }> = [];
        try {
          const payload = await fetchEtsyJsonWithAutoRefresh<{ results?: Array<{ listing_id?: number }> }>(
            `https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${state}?limit=${pageSize}&offset=${offset}`,
            `Etsy listings fetch failed (${state})`,
          );
          rows = payload.results || [];
        } catch {
          const payload = await fetchEtsyJsonWithAutoRefresh<{ results?: Array<{ listing_id?: number }> }>(
            `https://openapi.etsy.com/v3/application/shops/${shopId}/listings?state=${state}&limit=${pageSize}&offset=${offset}`,
            `Etsy listings fetch failed (${state})`,
          );
          rows = payload.results || [];
        }

        for (const row of rows) {
          if (row.listing_id) listingIds.add(String(row.listing_id));
        }
        if (rows.length < pageSize) break;
      }
    }

    const discovered = new Map<string, string>();
    for (const listingId of listingIds) {
      if (discovered.size >= missingSkus.size) break;
      const inventory = await fetchEtsyJsonWithAutoRefresh<EtsyInventoryResponse>(
        `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`,
        `Etsy inventory fetch failed for ${listingId}`,
      );
      for (const variant of inventory.products || []) {
        for (const variantSku of extractSkus(variant.sku)) {
          const normalized = normalizeSku(variantSku);
          if (missingSkus.has(normalized) && !discovered.has(normalized)) {
            discovered.set(normalized, listingId);
          }
        }
      }
    }

    if (discovered.size === 0) return;

    for (const [sku, listingId] of discovered.entries()) {
      etsyMap.set(sku, listingId);
    }
    const mergedMapObject = Object.fromEntries(Array.from(etsyMap.entries()).map(([sku, listingId]) => [sku, { listing_id: listingId }]));
    await supabaseAdmin
      .from("store_integrations")
      .upsert({ store_id: storeId, etsy_skumap_json: mergedMapObject, updated_at: new Date().toISOString() } as any, { onConflict: "store_id" });
  };

  if (etsyEnabled && etsyShopName) {
    const missingSkus = new Set<string>();
    for (const product of products) {
      const sku = normalizeSku(product.sku);
      if (sku && !etsyMap.has(sku)) missingSkus.add(sku);
    }
    if (missingSkus.size > 0) {
      try {
        await discoverEtsyMappingsForMissingSkus(missingSkus);
      } catch (error) {
        mappingDiscoveryError = `Etsy mapping auto-discovery failed: ${formatUnknownError(error)}`;
      }
    }
  }

  const nowIso = new Date().toISOString();
  const fingerprintRows: Array<Record<string, unknown>> = [];
  const snapshotRows: Array<Record<string, unknown>> = [];
  const warningRows: Array<Record<string, unknown>> = [];
  const firstErrors: string[] = [];
  if (mappingDiscoveryError) firstErrors.push(mappingDiscoveryError);

  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (!sku) continue;
    const localImageCount = imageCountByProductId[product.id] || 0;
    const localStockQty = localStockByProductId[product.id] || 0;
    const localFp = localFingerprint(product, localImageCount);
    const localWooPrice = normalizePrice(product.woo_price) ?? normalizePrice(product.base_price);
    const localEtsyPrice = normalizePrice(product.etsy_price) ?? normalizePrice(product.base_price);

    fingerprintRows.push({
      store_id: storeId,
      product_id: product.id,
      sku,
      local_price_fingerprint: hashText(JSON.stringify({ base: product.base_price, woo: product.woo_price, etsy: product.etsy_price })),
      local_media_fingerprint: hashText(String(localImageCount)),
      local_payload_fingerprint: localFp,
      local_snapshot_json: { sku, image_count: localImageCount, base_price: product.base_price, woo_price: product.woo_price, etsy_price: product.etsy_price },
      updated_at: nowIso,
    });

    if (wooEnabled) {
      try {
        const rows = await findWooBySku(wooUrl, wooKey, wooSecret, sku);
        if (rows.length === 0) {
          snapshotRows.push({
            store_id: storeId,
            product_id: product.id,
            sku,
            channel: "woocommerce",
            external_id: null,
            title: null,
            status: null,
            currency: null,
            price: null,
            stock_qty: null,
            remote_payload_fingerprint: null,
            last_local_payload_fingerprint: localFp,
            sync_state: "needs_publish",
            last_error: null,
            last_published_at: null,
            updated_at: nowIso,
            raw_json: {},
          });
          warningRows.push({
            store_id: storeId,
            product_id: product.id,
            sku,
            channel: "woocommerce",
            warning_type: "not_published",
            severity: "warning",
            message: "Product not found in WooCommerce by SKU.",
            local_value: { sku },
            remote_value: {},
            is_resolved: false,
            first_seen_at: nowIso,
            last_seen_at: nowIso,
          });
        } else {
          const woo = rows[0];
          const remotePrice = normalizePrice(woo.regular_price) ?? normalizePrice(woo.price);
          const remoteStockQty =
            normalizeInteger(woo.stock_quantity) ?? (woo.stock_status?.toLowerCase() === "outofstock" ? 0 : null);
          const remoteImageCount = Array.isArray(woo.images) ? woo.images.length : 0;
          const priceMismatch = localWooPrice !== remotePrice;
          const photoMismatch = localImageCount !== remoteImageCount;
          const stockMismatch = remoteStockQty != null && remoteStockQty !== localStockQty;
          if (priceMismatch) {
            warningRows.push({
              store_id: storeId,
              product_id: product.id,
              sku,
              channel: "woocommerce",
              warning_type: "price_mismatch",
              severity: "warning",
              message: "Price mismatch between local catalog and WooCommerce.",
              local_value: { price: localWooPrice },
              remote_value: { price: remotePrice },
              is_resolved: false,
              first_seen_at: nowIso,
              last_seen_at: nowIso,
            });
          }
          if (photoMismatch) {
            warningRows.push({
              store_id: storeId,
              product_id: product.id,
              sku,
              channel: "woocommerce",
              warning_type: "photo_mismatch",
              severity: "warning",
              message: "Image count mismatch in WooCommerce.",
              local_value: { image_count: localImageCount },
              remote_value: { image_count: remoteImageCount },
              is_resolved: false,
              first_seen_at: nowIso,
              last_seen_at: nowIso,
            });
          }
          if (stockMismatch) {
            warningRows.push({
              store_id: storeId,
              product_id: product.id,
              sku,
              channel: "woocommerce",
              warning_type: "stock_mismatch",
              severity: "warning",
              message: "Stock mismatch between local catalog and WooCommerce.",
              local_value: { stock_qty: localStockQty },
              remote_value: { stock_qty: remoteStockQty },
              is_resolved: false,
              first_seen_at: nowIso,
              last_seen_at: nowIso,
            });
          }
          snapshotRows.push({
            store_id: storeId,
            product_id: product.id,
            sku,
            channel: "woocommerce",
            external_id: String(woo.id),
            title: product.title || null,
            status: woo.status || null,
            currency: null,
            price: remotePrice,
            stock_qty: remoteStockQty,
            remote_payload_fingerprint: hashText(
              JSON.stringify({ price: remotePrice, stock_qty: remoteStockQty, image_count: remoteImageCount, status: woo.status || null }),
            ),
            last_local_payload_fingerprint: localFp,
            sync_state: priceMismatch || photoMismatch || stockMismatch ? "needs_publish" : "published",
            last_error: null,
            last_published_at: priceMismatch || photoMismatch || stockMismatch ? null : nowIso,
            updated_at: nowIso,
            raw_json: woo,
          });
        }
      } catch (error) {
        const message = `Woo fetch failed for SKU ${sku}: ${formatUnknownError(error)}`;
        if (firstErrors.length < 5) firstErrors.push(message);
        snapshotRows.push({
          store_id: storeId,
          product_id: product.id,
          sku,
          channel: "woocommerce",
          external_id: null,
          title: null,
          status: null,
          currency: null,
          price: null,
          stock_qty: null,
          remote_payload_fingerprint: null,
          last_local_payload_fingerprint: localFp,
          sync_state: "error",
          last_error: message,
          last_published_at: null,
          updated_at: nowIso,
          raw_json: {},
        });
      }
    }

    if (etsyEnabled) {
      const listingId = etsyMap.get(sku);
      if (!listingId) {
        snapshotRows.push({
          store_id: storeId,
          product_id: product.id,
          sku,
          channel: "etsy",
          external_id: null,
          title: null,
          status: null,
          currency: "USD",
          price: null,
          stock_qty: null,
          remote_payload_fingerprint: null,
          last_local_payload_fingerprint: localFp,
          sync_state: "needs_publish",
          last_error: null,
          last_published_at: null,
          updated_at: nowIso,
          raw_json: {},
        });
        warningRows.push({
          store_id: storeId,
          product_id: product.id,
          sku,
          channel: "etsy",
          warning_type: "missing_mapping",
          severity: "warning",
          message: "Not published in Etsy yet for this SKU.",
          local_value: { sku },
          remote_value: {},
          is_resolved: false,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
        });
      } else {
        try {
          const listing = await fetchEtsyJsonWithAutoRefresh<{ title?: string; state?: string }>(
            `https://openapi.etsy.com/v3/application/listings/${listingId}`,
            `Etsy listing fetch failed for ${listingId}`,
          );
          const inventory = await fetchEtsyJsonWithAutoRefresh<EtsyInventoryResponse>(
            `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`,
            `Etsy inventory fetch failed for ${listingId}`,
          );
          const etsyImages = await fetchEtsyJsonWithAutoRefresh<EtsyImagesResponse>(
            `https://openapi.etsy.com/v3/application/listings/${listingId}/images`,
            `Etsy images fetch failed for ${listingId}`,
          );
          const sortedImages = Array.isArray(etsyImages.results) ? etsyImages.results.sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0)) : [];
          const remoteImageCount = sortedImages.length;
          let remotePrice: number | null = null;
          let remoteStockQty: number | null = null;
          for (const variant of inventory.products || []) {
            const skus = extractSkus(variant.sku);
            if (skus.length > 0 && !skus.includes(sku)) continue;
            let variantStock = 0;
            let hasVariantStockValue = false;
            for (const offering of variant.offerings || []) {
              remotePrice = normalizePrice(offering.price);
              const offeringQty = normalizeInteger(offering.quantity);
              if (offeringQty != null) {
                variantStock += offeringQty;
                hasVariantStockValue = true;
              }
              if (remotePrice != null) break;
            }
            if (hasVariantStockValue) remoteStockQty = variantStock;
            if (remotePrice != null) break;
          }

          const priceMismatch = localEtsyPrice !== remotePrice;
          const photoMismatch = localImageCount !== remoteImageCount;
          const etsyState = (listing.state || "").trim().toLowerCase();
          const isEtsyNonActiveWithNoLocalStock = localStockQty <= 0 && etsyState.length > 0 && etsyState !== "active";
          const stockMismatch = remoteStockQty != null && remoteStockQty !== localStockQty && !isEtsyNonActiveWithNoLocalStock;
          if (priceMismatch) {
            warningRows.push({
              store_id: storeId,
              product_id: product.id,
              sku,
              channel: "etsy",
              warning_type: "price_mismatch",
              severity: "warning",
              message: "Price mismatch between local catalog and Etsy.",
              local_value: { price: localEtsyPrice },
              remote_value: { price: remotePrice },
              is_resolved: false,
              first_seen_at: nowIso,
              last_seen_at: nowIso,
            });
          }
          if (photoMismatch) {
            warningRows.push({
              store_id: storeId,
              product_id: product.id,
              sku,
              channel: "etsy",
              warning_type: "photo_mismatch",
              severity: "warning",
              message: "Image count mismatch in Etsy.",
              local_value: { image_count: localImageCount },
              remote_value: { image_count: remoteImageCount },
              is_resolved: false,
              first_seen_at: nowIso,
              last_seen_at: nowIso,
            });
          }
          if (stockMismatch) {
            warningRows.push({
              store_id: storeId,
              product_id: product.id,
              sku,
              channel: "etsy",
              warning_type: "stock_mismatch",
              severity: "warning",
              message: "Stock mismatch between local catalog and Etsy.",
              local_value: { stock_qty: localStockQty },
              remote_value: { stock_qty: remoteStockQty },
              is_resolved: false,
              first_seen_at: nowIso,
              last_seen_at: nowIso,
            });
          }
          snapshotRows.push({
            store_id: storeId,
            product_id: product.id,
            sku,
            channel: "etsy",
            external_id: listingId,
            title: listing.title || product.title || null,
            status: listing.state || null,
            currency: "USD",
            price: remotePrice,
            stock_qty: remoteStockQty,
            remote_payload_fingerprint: hashText(
              JSON.stringify({ price: remotePrice, stock_qty: remoteStockQty, image_count: remoteImageCount, status: listing.state || null }),
            ),
            last_local_payload_fingerprint: localFp,
            sync_state: priceMismatch || photoMismatch || stockMismatch ? "needs_publish" : "published",
            last_error: null,
            last_published_at: priceMismatch || photoMismatch || stockMismatch ? null : nowIso,
            updated_at: nowIso,
            raw_json: { listing, inventory, images_count: remoteImageCount },
          });
        } catch (error) {
          const message = `Etsy fetch failed for listing ${listingId} (SKU ${sku}): ${formatUnknownError(error)}`;
          if (firstErrors.length < 5) firstErrors.push(message);
          snapshotRows.push({
            store_id: storeId,
            product_id: product.id,
            sku,
            channel: "etsy",
            external_id: listingId,
            title: null,
            status: null,
            currency: "USD",
            price: null,
            stock_qty: null,
            remote_payload_fingerprint: null,
            last_local_payload_fingerprint: localFp,
            sync_state: "error",
            last_error: message,
            last_published_at: null,
            updated_at: nowIso,
            raw_json: {},
          });
        }
      }
    }
  }

  const targetProductIds = products.map((product) => product.id);

  if (fingerprintRows.length > 0) {
    const { error } = await supabaseAdmin.from("product_marketplace_fingerprints").upsert(fingerprintRows, { onConflict: "store_id,product_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (snapshotRows.length > 0) {
    const { error } = await supabaseAdmin.from("marketplace_product_snapshots").upsert(snapshotRows, { onConflict: "store_id,product_id,channel" });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (targetProductIds.length > 0) {
    await supabaseAdmin
      .from("marketplace_sync_warnings")
      .update({ is_resolved: true, resolved_at: nowIso, last_seen_at: nowIso })
      .eq("store_id", storeId)
      .in("product_id", targetProductIds)
      .in("channel", ["woocommerce", "etsy"])
      .eq("is_resolved", false);
  }
  if (warningRows.length > 0) {
    const { error } = await supabaseAdmin.from("marketplace_sync_warnings").insert(warningRows);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    processedProducts: products.length,
    updatedFingerprints: fingerprintRows.length,
    updatedSnapshots: snapshotRows.length,
    warningCount: warningRows.length,
    needsPublishCount: snapshotRows.filter((row) => row.sync_state === "needs_publish").length,
    errorCount: snapshotRows.filter((row) => row.sync_state === "error").length,
    firstError: firstErrors[0] || null,
  });
}
