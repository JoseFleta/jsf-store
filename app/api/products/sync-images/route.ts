import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const WOO_IMAGE_SIGNATURE_META_KEY = "_aas_sync_image_signature";

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

type ProductImageRow = {
  product_id: string;
  storage_path: string;
  sort_order: number;
};

type WooProduct = {
  id: number;
  sku?: string | null;
  images?: Array<{ id?: number; src?: string | null; alt?: string | null; name?: string | null }>;
  meta_data?: Array<{ id?: number; key?: string | null; value?: unknown }>;
};
type ResolvedWooConfig = { baseUrl: string; key: string; secret: string };

type ResolvedEtsyConfig = {
  bearer: string;
  refreshToken: string;
  tokenExpiresAt: string | null;
  apiKey: string;
  shopName: string | null;
  skuMap: Map<string, { listing_id?: string }>;
};

type EtsyRefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
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

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${error.message}; cause: ${cause.message}`;
    if (typeof cause === "string" && cause.trim()) return `${error.message}; cause: ${cause}`;
    return error.message;
  }
  return String(error || "unknown error");
}

function isDnsLookupError(error: unknown): boolean {
  const message = describeUnknownError(error).toLowerCase();
  return message.includes("enotfound") || message.includes("eai_again") || message.includes("getaddrinfo");
}

function toRequestUrlString(input: RequestInfo | URL): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return null;
}

function maybeBuildWooNoWwwFallbackUrl(input: RequestInfo | URL, label?: string): string | null {
  if (!label || !label.toLowerCase().includes("woo")) return null;
  const rawUrl = toRequestUrlString(input);
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.toLowerCase().startsWith("www.")) return null;
    url.hostname = url.hostname.slice(4);
    return url.toString();
  } catch {
    return null;
  }
}

function isPlaceholderSku(sku: string): boolean {
  return /^[0-9]$/.test(sku);
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

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function buildImageFingerprint(storagePath: string): string {
  return hashText(storagePath.toLowerCase());
}

function extractComparableImageToken(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  let pathLike = raw;
  try {
    pathLike = new URL(raw).pathname;
  } catch {
    pathLike = raw;
  }

  const fileName = decodeURIComponent(pathLike.split("/").pop() || "").toLowerCase();
  if (!fileName) return "";

  // Remove extension and common Woo/WordPress suffixes so `img-1.jpg` and `img.jpg` compare equal.
  const withoutExt = fileName.replace(/\.[a-z0-9]{2,5}$/i, "");
  const withoutSizeSuffix = withoutExt.replace(/-\d+x\d+$/i, "");
  const withoutDupSuffix = withoutSizeSuffix.replace(/-\d+$/i, "");
  return withoutDupSuffix;
}

function buildWooImageSignature(localImages: ProductImageRow[]): string {
  const joined = localImages.map((image) => image.storage_path.trim().toLowerCase()).join("|");
  return hashText(joined);
}

function getWooImageSignature(product: WooProduct): string {
  const meta = Array.isArray(product.meta_data) ? product.meta_data : [];
  const row = meta.find((item) => (item?.key || "").trim() === WOO_IMAGE_SIGNATURE_META_KEY);
  if (!row) return "";
  const raw = row.value;
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

function buildWooSignatureMetaData(
  product: WooProduct,
  signature: string,
): Array<{ id?: number; key: string; value: string }> {
  const meta = Array.isArray(product.meta_data) ? product.meta_data : [];
  const existing = meta.find((item) => (item?.key || "").trim() === WOO_IMAGE_SIGNATURE_META_KEY);
  if (existing?.id && Number.isFinite(existing.id)) {
    return [{ id: existing.id, key: WOO_IMAGE_SIGNATURE_META_KEY, value: signature }];
  }
  return [{ key: WOO_IMAGE_SIGNATURE_META_KEY, value: signature }];
}

function extractSyncFingerprintFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/sync-([a-f0-9]+)-\d+\.[a-z0-9]{2,5}$/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function extractSyncFingerprintFromAltText(altText: string | null | undefined): string | null {
  if (!altText) return null;
  const match = altText.match(/AAS_SYNC:([a-f0-9]+)/i);
  return match?.[1]?.toLowerCase() || null;
}

function getEtsyImageFingerprint(image: {
  url_fullxfull?: string;
  url_570xN?: string;
  url_300x300?: string;
  alt_text?: string | null;
}): string | null {
  const byAlt = extractSyncFingerprintFromAltText(image.alt_text);
  if (byAlt) return byAlt;
  return extractSyncFingerprintFromUrl(image.url_fullxfull || image.url_570xN || image.url_300x300 || "");
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: { retries?: number; retryDelayMs?: number; label?: string },
): Promise<Response> {
  const retries = Math.max(0, options?.retries ?? 2);
  const retryDelayMs = Math.max(100, options?.retryDelayMs ?? 350);
  const label = options?.label ? `${options.label}: ` : "";

  const attemptFetch = async (target: RequestInfo | URL): Promise<Response> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetch(target, init);
      } catch (error) {
        lastError = error;
        if (attempt >= retries) break;
        await waitMs(retryDelayMs * (attempt + 1));
      }
    }
    throw lastError ?? new Error("unknown error");
  };

  let primaryError: unknown = null;
  try {
    return await attemptFetch(input);
  } catch (error) {
    primaryError = error;
  }

  const fallbackUrl = maybeBuildWooNoWwwFallbackUrl(input, options?.label);
  if (fallbackUrl && isDnsLookupError(primaryError)) {
    try {
      return await attemptFetch(fallbackUrl);
    } catch (fallbackError) {
      const primaryMessage = describeUnknownError(primaryError);
      const fallbackMessage = describeUnknownError(fallbackError);
      throw new Error(`${label}fetch failed (${primaryMessage}; Woo no-www fallback failed: ${fallbackMessage})`);
    }
  }

  const message = describeUnknownError(primaryError);
  throw new Error(`${label}fetch failed (${message})`);
}

async function downloadProductImageBlobWithRetry(
  supabaseAdmin: ReturnType<typeof createClient>,
  storagePath: string,
  retries = 2,
): Promise<Blob> {
  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const downloaded = await supabaseAdmin.storage.from("product-images").download(storagePath);
      if (!downloaded.error && downloaded.data) return downloaded.data;
      lastError = downloaded.error?.message || "unknown error";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retries) await waitMs(300 * (attempt + 1));
  }
  throw new Error(`Storage download failed for ${storagePath}: ${lastError}`);
}

function extractExtensionFromPath(storagePath: string): string {
  const fileName = storagePath.split("/").pop() || "";
  const match = fileName.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match?.[1]?.toLowerCase() || "jpg";
}

function isInvalidTokenMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("401") && normalized.includes("invalid_token");
}

async function discoverEtsyListingIdsForSkus(
  supabaseAdmin: ReturnType<typeof createClient>,
  storeId: string,
  config: ResolvedEtsyConfig,
  shopId: number,
  targetSkus: Set<string>,
): Promise<Map<string, string>> {
  const discovered = new Map<string, string>();
  if (targetSkus.size === 0) return discovered;

  const pageSize = 100;
  const listingIds = new Set<string>();
  const states = ["active", "inactive", "draft"];

  const fetchListingsForState = async (state: string): Promise<void> => {
    const runPaged = async (buildUrl: (offset: number) => URL) => {
      for (let offset = 0; offset < 5000; offset += pageSize) {
        const res = await fetchWithRetry(
          buildUrl(offset).toString(),
          {
            method: "GET",
            headers: { Authorization: `Bearer ${config.bearer}`, "x-api-key": config.apiKey },
            cache: "no-store",
          },
          { label: `Etsy listings fetch (${state})` },
        );
        if (!res.ok) {
          throw new Error(`Etsy listings fetch failed (${state}): ${await parseErrorBody(res)}`);
        }
        const payload = (await res.json()) as { results?: Array<{ listing_id?: number }> };
        const rows = payload.results || [];
        for (const row of rows) {
          if (row.listing_id) listingIds.add(String(row.listing_id));
        }
        if (rows.length < pageSize) break;
      }
    };

    try {
      await runPaged((offset) => {
        const url = new URL(`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${state}`);
        url.searchParams.set("limit", String(pageSize));
        url.searchParams.set("offset", String(offset));
        return url;
      });
    } catch {
      await runPaged((offset) => {
        const url = new URL(`https://openapi.etsy.com/v3/application/shops/${shopId}/listings`);
        url.searchParams.set("state", state);
        url.searchParams.set("limit", String(pageSize));
        url.searchParams.set("offset", String(offset));
        return url;
      });
    }
  };

  for (const state of states) {
    await fetchListingsForState(state);
  }

  for (const listingId of listingIds) {
    if (discovered.size >= targetSkus.size) break;
    const invRes = await fetchWithRetry(
      `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${config.bearer}`, "x-api-key": config.apiKey },
        cache: "no-store",
      },
      { label: `Etsy inventory fetch (${listingId})` },
    );
    if (!invRes.ok) continue;

    const inventory = (await invRes.json()) as {
      products?: Array<{ sku?: string[] | string | null }>;
    };
    for (const product of inventory.products || []) {
      for (const rawSku of extractSkus(product.sku)) {
        const sku = normalizeSku(rawSku);
        if (!sku || isPlaceholderSku(sku)) continue;
        if (targetSkus.has(sku) && !discovered.has(sku)) discovered.set(sku, listingId);
      }
    }
  }

  if (discovered.size > 0) {
    const existing = config.skuMap;
    for (const [sku, listingId] of discovered.entries()) {
      existing.set(sku, { listing_id: listingId });
    }
    const mergedJson = Object.fromEntries(Array.from(existing.entries()));
    await supabaseAdmin
      .from("store_integrations")
      .upsert({ store_id: storeId, etsy_skumap_json: mergedJson, updated_at: new Date().toISOString() }, { onConflict: "store_id" });
  }

  return discovered;
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
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function findWooProductsBySku(config: ResolvedWooConfig, sku: string): Promise<WooProduct[]> {
  const exactUrl = buildWooUrl(config, "/products", { sku, per_page: "100" });
  const exactRes = await fetchWithRetry(
    exactUrl,
    { method: "GET", cache: "no-store" },
    { label: `Woo SKU lookup (${sku})`, retries: 4, retryDelayMs: 450 },
  );
  if (!exactRes.ok) throw new Error(`Woo lookup failed for ${sku}: ${await parseErrorBody(exactRes)}`);
  const exactData = (await exactRes.json()) as WooProduct[];
  const exactMatches = (exactData || []).filter((p) => normalizeSku(p.sku) === sku);
  if (exactMatches.length > 0) return exactMatches;

  const searchUrl = buildWooUrl(config, "/products", { search: sku, per_page: "100" });
  const searchRes = await fetchWithRetry(
    searchUrl,
    { method: "GET", cache: "no-store" },
    { label: `Woo SKU search (${sku})`, retries: 4, retryDelayMs: 450 },
  );
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
  if (!bearer || !refreshToken || !apiKey || Object.keys(mergedMap).length === 0) return null;

  const skuMap = new Map<string, { listing_id?: string }>();
  for (const [sku, entry] of Object.entries(mergedMap)) skuMap.set(normalizeSku(sku), entry || {});
  return { bearer, refreshToken, tokenExpiresAt, apiKey, shopName: shopName || null, skuMap };
}

async function refreshEtsyAccessToken(config: ResolvedEtsyConfig): Promise<EtsyRefreshResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", config.apiKey);
  body.set("refresh_token", config.refreshToken);

  const res = await fetchWithRetry(
    "https://api.etsy.com/v3/public/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    { label: "Etsy token refresh" },
  );
  if (!res.ok) throw new Error(`Etsy token refresh failed: ${await parseErrorBody(res)}`);

  const payload = (await res.json()) as EtsyRefreshResponse;
  if (!payload.access_token) throw new Error("Etsy token refresh failed: access_token missing in response.");
  return payload;
}

async function saveRefreshedEtsyToken(
  supabaseAdmin: ReturnType<typeof createClient>,
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
      },
      { onConflict: "store_id" },
    );
}

async function maybeRefreshEtsyToken(
  supabaseAdmin: ReturnType<typeof createClient>,
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

async function resolveEtsyShopId(config: ResolvedEtsyConfig): Promise<number> {
  if (!config.shopName) throw new Error("Etsy shop name is not configured.");
  if (/^\d+$/.test(config.shopName.trim())) return Number(config.shopName.trim());

  const lookupUrl = new URL("https://openapi.etsy.com/v3/application/shops");
  lookupUrl.searchParams.set("shop_name", config.shopName.trim());
  const lookupRes = await fetchWithRetry(
    lookupUrl.toString(),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.bearer}`,
        "x-api-key": config.apiKey,
      },
      cache: "no-store",
    },
    { label: "Etsy shop lookup" },
  );
  if (!lookupRes.ok) throw new Error(`Etsy shop lookup failed: ${await parseErrorBody(lookupRes)}`);

  const payload = (await lookupRes.json()) as { results?: Array<{ shop_id?: number }> };
  const shopId = payload.results?.[0]?.shop_id;
  if (!shopId) throw new Error(`Etsy shop lookup failed: could not resolve shop '${config.shopName}'.`);
  return shopId;
}

async function resolveEtsyShopIdFromListing(config: ResolvedEtsyConfig, listingId: string): Promise<number | null> {
  const endpoint = `https://openapi.etsy.com/v3/application/listings/${listingId}`;
  const res = await fetchWithRetry(
    endpoint,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.bearer}`,
        "x-api-key": config.apiKey,
      },
      cache: "no-store",
    },
    { label: `Etsy listing lookup (${listingId})` },
  );
  if (!res.ok) throw new Error(`Etsy listing lookup failed for ${listingId}: ${await parseErrorBody(res)}`);
  const payload = (await res.json()) as { shop_id?: number | string };
  const rawShopId = payload.shop_id;
  const shopId = typeof rawShopId === "number" ? rawShopId : Number(rawShopId);
  if (!Number.isFinite(shopId) || shopId <= 0) return null;
  return shopId;
}

async function withEtsyRefresh<T>(
  supabaseAdmin: ReturnType<typeof createClient>,
  storeId: string,
  config: ResolvedEtsyConfig,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
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
    return execute();
  }
}

async function uploadEtsyListingImageBinary(
  config: ResolvedEtsyConfig,
  shopId: number | null,
  listingId: string,
  fileName: string,
  fileBlob: Blob,
  rank: number,
  fingerprint: string,
  overwrite = false,
): Promise<number | null> {
  const endpoints = [
    ...(shopId != null ? [`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`] : []),
    `https://openapi.etsy.com/v3/application/listings/${listingId}/images`,
  ];
  const payloadVariants = [
    { includeAltText: true },
    { includeAltText: false },
  ];
  let lastError = "";
  for (const endpoint of endpoints) {
    for (const variant of payloadVariants) {
      const body = new FormData();
      body.append("image", fileBlob, fileName);
      body.append("rank", String(rank));
      if (overwrite) body.append("overwrite", "true");
      if (variant.includeAltText) body.append("alt_text", `AAS_SYNC:${fingerprint}`);
      const res = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.bearer}`,
            "x-api-key": config.apiKey,
          },
          body,
        },
        { label: `Etsy image binary upload (${listingId})` },
      );
      if (res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          listing_image_id?: number | string;
          image_id?: number | string;
        };
        const rawId = payload.listing_image_id ?? payload.image_id;
        const parsed = typeof rawId === "number" ? rawId : Number(rawId);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
      lastError = await parseErrorBody(res);
    }
  }
  throw new Error(`Etsy image upload failed for listing ${listingId}: ${lastError || "unknown error"}`);
}

async function uploadEtsyListingImageUrl(
  config: ResolvedEtsyConfig,
  shopId: number | null,
  listingId: string,
  imageUrl: string,
  rank: number,
  fingerprint: string,
  overwrite = false,
): Promise<number | null> {
  const endpoints = [
    ...(shopId != null ? [`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`] : []),
    `https://openapi.etsy.com/v3/application/listings/${listingId}/images`,
  ];
  const payloadVariants = [
    { includeAltText: true },
    { includeAltText: false },
  ];
  let lastError = "";
  for (const endpoint of endpoints) {
    for (const variant of payloadVariants) {
      const body = new FormData();
      body.append("image_url", imageUrl);
      body.append("rank", String(rank));
      if (overwrite) body.append("overwrite", "true");
      if (variant.includeAltText) body.append("alt_text", `AAS_SYNC:${fingerprint}`);
      const res = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.bearer}`,
            "x-api-key": config.apiKey,
          },
          body,
        },
        { label: `Etsy image URL upload (${listingId})` },
      );
      if (res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          listing_image_id?: number | string;
          image_id?: number | string;
        };
        const rawId = payload.listing_image_id ?? payload.image_id;
        const parsed = typeof rawId === "number" ? rawId : Number(rawId);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
      lastError = await parseErrorBody(res);
    }
  }
  throw new Error(`Etsy image URL upload failed for listing ${listingId}: ${lastError || "unknown error"}`);
}

type EtsyListingImageRow = {
  listing_image_id: number;
  url_fullxfull?: string;
  url_570xN?: string;
  url_300x300?: string;
  alt_text?: string | null;
  rank?: number | string | null;
};

function getEtsyImageRank(image: EtsyListingImageRow): number | null {
  const raw = image.rank;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function sortEtsyImagesByRank(images: EtsyListingImageRow[]): EtsyListingImageRow[] {
  return [...images].sort((a, b) => {
    const rankA = getEtsyImageRank(a);
    const rankB = getEtsyImageRank(b);
    if (rankA != null && rankB != null && rankA !== rankB) return rankA - rankB;
    if (rankA != null && rankB == null) return -1;
    if (rankA == null && rankB != null) return 1;
    return a.listing_image_id - b.listing_image_id;
  });
}

function hasEtsyTargetRanks(images: EtsyListingImageRow[], targetCount: number): boolean {
  const ranks = new Set<number>();
  for (const image of images) {
    const rank = getEtsyImageRank(image);
    if (rank != null) ranks.add(rank);
  }
  if (ranks.size === 0) return images.length >= targetCount;
  for (let expected = 1; expected <= targetCount; expected += 1) {
    if (!ranks.has(expected)) return false;
  }
  return true;
}

async function fetchEtsyListingImages(
  config: ResolvedEtsyConfig,
  shopId: number | null,
  listingId: string,
): Promise<EtsyListingImageRow[]> {
  const endpoints = [
    ...(shopId != null ? [`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`] : []),
    `https://openapi.etsy.com/v3/application/listings/${listingId}/images`,
  ];
  let lastError = "";
  for (const endpoint of endpoints) {
    const res = await fetchWithRetry(
      endpoint,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.bearer}`,
          "x-api-key": config.apiKey,
        },
        cache: "no-store",
      },
      { label: `Etsy listing images fetch (${listingId})` },
    );
    if (!res.ok) {
      lastError = await parseErrorBody(res);
      continue;
    }
    const payload = (await res.json()) as { results?: EtsyListingImageRow[] };
    return Array.isArray(payload.results) ? payload.results : [];
  }
  throw new Error(`Etsy listing images fetch failed for listing ${listingId}: ${lastError || "unknown error"}`);
}

async function deleteEtsyListingImage(
  config: ResolvedEtsyConfig,
  shopId: number | null,
  listingId: string,
  imageId: number,
): Promise<void> {
  const endpoints = [
    ...(shopId != null
      ? [`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images/${imageId}`]
      : []),
    `https://openapi.etsy.com/v3/application/listings/${listingId}/images/${imageId}`,
  ];
  let lastError = "";
  for (const endpoint of endpoints) {
    const res = await fetchWithRetry(
      endpoint,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${config.bearer}`,
          "x-api-key": config.apiKey,
        },
        cache: "no-store",
      },
      { label: `Etsy image delete (${listingId}:${imageId})` },
    );
    if (res.ok) return;
    lastError = await parseErrorBody(res);
  }
  throw new Error(`Etsy image delete failed for listing ${listingId}: ${lastError || "unknown error"}`);
}

function buildUploadFileName(storagePath: string, fingerprint: string, index: number): string {
  const ext = extractExtensionFromPath(storagePath);
  return `sync-${fingerprint}-${index + 1}.${ext}`;
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeId?: string; productIds?: string[] };
  const storeId = (body.storeId || "").trim();
  const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id) => typeof id === "string" && id.trim()) : [];
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });
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

  const [productsRes, imagesRes, integrationRes] = await Promise.all([
    supabaseAdmin.from("products").select("id,sku").eq("store_id", storeId).in("id", productIds),
    supabaseAdmin
      .from("product_images")
      .select("product_id,storage_path,sort_order")
      .eq("store_id", storeId)
      .in("product_id", productIds)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("store_integrations")
      .select(
        "woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json",
      )
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);
  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (imagesRes.error) return NextResponse.json({ error: imagesRes.error.message }, { status: 400 });

  const products = (productsRes.data ?? []) as ProductRow[];
  const images = (imagesRes.data ?? []) as ProductImageRow[];
  const integration = integrationRes.error ? null : ((integrationRes.data ?? null) as StoreIntegrationRow | null);

  const imagesByProductId = new Map<string, ProductImageRow[]>();
  for (const row of images) {
    if (!imagesByProductId.has(row.product_id)) imagesByProductId.set(row.product_id, []);
    imagesByProductId.get(row.product_id)!.push(row);
  }

  const wooConfig = resolveWooConfig(integration);
  const etsyConfig = resolveEtsyConfig(integration);
  const wooEnabled = Boolean(wooConfig);
  const etsyEnabled = Boolean(etsyConfig);
  let etsyShopId: number | null = null;

  const errors: string[] = [];
  if (etsyConfig) {
    try {
      await maybeRefreshEtsyToken(supabaseAdmin, storeId, etsyConfig);
      if (etsyConfig.shopName) {
        etsyShopId = await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () => resolveEtsyShopId(etsyConfig));
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Etsy is configured but shop resolution failed.");
    }
  }

  if (etsyEnabled && etsyConfig && etsyShopId != null) {
    try {
      const selectedSkus = new Set(
        products
          .map((product) => normalizeSku(product.sku))
          .filter((sku) => sku.length > 0),
      );
      const missingSkus = new Set(
        Array.from(selectedSkus).filter((sku) => !etsyConfig.skuMap.get(sku)?.listing_id),
      );
      if (missingSkus.size > 0) {
        await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
          discoverEtsyListingIdsForSkus(supabaseAdmin, storeId, etsyConfig, etsyShopId!, missingSkus),
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Etsy SKU map auto-discovery failed.");
    }
  }

  let processedProducts = 0;
  let updatedWooProducts = 0;
  let wooAlreadySyncedProducts = 0;
  let updatedEtsyListings = 0;
  let etsyAlreadySyncedListings = 0;
  let skippedNoSku = 0;
  let skippedNoLocalImages = 0;
  let missingEtsySkuMapCount = 0;

  for (const product of products) {
    processedProducts += 1;
    const sku = normalizeSku(product.sku);
    if (!sku) {
      skippedNoSku += 1;
      continue;
    }

    const localImages = imagesByProductId.get(product.id) || [];
    if (localImages.length === 0) {
      skippedNoLocalImages += 1;
      continue;
    }

    try {
      const urls = localImages.map((image) => supabaseAdmin.storage.from("product-images").getPublicUrl(image.storage_path).data.publicUrl);

      if (wooConfig) {
        try {
          const targetWooTokens = localImages.map((image) => extractComparableImageToken(image.storage_path));
          const targetWooSignature = buildWooImageSignature(localImages);
          const wooProducts = await findWooProductsBySku(wooConfig, sku);
          if (wooProducts.length === 0) {
            errors.push(`Woo product not found for SKU ${sku}`);
          } else {
            let syncedAnyWoo = false;
            for (const woo of wooProducts) {
              const existingWooImages = Array.isArray(woo.images) ? woo.images : [];
              const existingWooTokens = existingWooImages
                .map((image) => (typeof image?.src === "string" ? extractComparableImageToken(image.src) : ""))
                .filter((token) => token.length > 0);
              const existingWooSignature = getWooImageSignature(woo);
              const isWooAlreadySynced =
                existingWooTokens.length === targetWooTokens.length &&
                existingWooTokens.every((token, idx) => token === targetWooTokens[idx]);

              if (existingWooSignature && existingWooSignature === targetWooSignature) {
                wooAlreadySyncedProducts += 1;
                continue;
              }

              if (!existingWooSignature && existingWooImages.length === targetWooTokens.length) {
                const bootstrapUrl = buildWooUrl(wooConfig, `/products/${woo.id}`);
                const bootstrapRes = await fetchWithRetry(
                  bootstrapUrl,
                  {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      meta_data: buildWooSignatureMetaData(woo, targetWooSignature),
                    }),
                  },
                  { label: `Woo signature bootstrap (${sku}:${woo.id})` },
                );
                if (!bootstrapRes.ok) {
                  errors.push(`Woo signature bootstrap failed for ${sku} (id ${woo.id}): ${await parseErrorBody(bootstrapRes)}`);
                } else {
                  wooAlreadySyncedProducts += 1;
                }
                continue;
              }

              if (isWooAlreadySynced) {
                wooAlreadySyncedProducts += 1;
                continue;
              }

              const updateUrl = buildWooUrl(wooConfig, `/products/${woo.id}`);
              const updateRes = await fetchWithRetry(
                updateUrl,
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    images: urls.map((src, idx) => ({ src, position: idx })),
                    meta_data: buildWooSignatureMetaData(woo, targetWooSignature),
                  }),
                },
                { label: `Woo image update (${sku}:${woo.id})` },
              );
              if (!updateRes.ok) {
                errors.push(`Woo image sync failed for ${sku} (id ${woo.id}): ${await parseErrorBody(updateRes)}`);
                continue;
              }
              syncedAnyWoo = true;
            }
            if (syncedAnyWoo) updatedWooProducts += 1;
          }
        } catch (wooError) {
          errors.push(`Woo sync failed for SKU ${sku}: ${describeUnknownError(wooError)}`);
        }
      }

      if (etsyEnabled && etsyConfig) {
        const listingId = etsyConfig.skuMap.get(sku)?.listing_id;
        if (!listingId) {
          missingEtsySkuMapCount += 1;
        } else {
          let listingShopId = etsyShopId;
          if (listingShopId == null) {
            try {
              listingShopId = await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
                resolveEtsyShopIdFromListing(etsyConfig, listingId),
              );
            } catch (shopError) {
              errors.push(`Etsy shop resolution failed for ${sku}: ${shopError instanceof Error ? shopError.message : "unknown error"}`);
            }
          }
          if (listingShopId == null) {
            errors.push(`Etsy shop id unavailable for ${sku}; skipping Etsy image sync for this product.`);
            continue;
          }

          const etsyMaxImages = 20;
          const targetCount = Math.min(localImages.length, etsyMaxImages);
          if (localImages.length > etsyMaxImages) {
            errors.push(
              `Etsy supports up to ${etsyMaxImages} images per listing. SKU ${sku} has ${localImages.length}; syncing first ${etsyMaxImages}.`,
            );
          }

          const targetLocalImages = localImages.slice(0, targetCount);
          const targetFingerprints = targetLocalImages.map((image) => buildImageFingerprint(image.storage_path));

          if (targetCount === 0) {
            etsyAlreadySyncedListings += 1;
            continue;
          }

          let etsyImages = await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
            fetchEtsyListingImages(etsyConfig, listingShopId, listingId),
          );
          const existingFingerprints = sortEtsyImagesByRank(etsyImages).map((image) => getEtsyImageFingerprint(image));
          const isExactSynced =
            existingFingerprints.length === targetFingerprints.length &&
            existingFingerprints.every((fingerprint, idx) => fingerprint === targetFingerprints[idx]);
          if (isExactSynced) {
            etsyAlreadySyncedListings += 1;
            continue;
          }

          let changed = false;
          let actionsOk = true;

          // Step 1: overwrite Etsy rank slots directly from local image order.
          for (let index = 0; index < targetCount; index += 1) {
            const fingerprint = targetFingerprints[index];
            const image = targetLocalImages[index];
            const publicUrl = urls[index];

            let blob: Blob;
            try {
              blob = await downloadProductImageBlobWithRetry(supabaseAdmin, image.storage_path);
            } catch (downloadError) {
              actionsOk = false;
              errors.push(
                `Storage download failed for ${sku}: ${downloadError instanceof Error ? downloadError.message : "unknown error"}`,
              );
              break;
            }
            const contentType = blob.type || "application/octet-stream";
            const uploadBlob = new Blob([await blob.arrayBuffer()], { type: contentType });
            const fileName = buildUploadFileName(image.storage_path, fingerprint, index);

            try {
              await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
                uploadEtsyListingImageBinary(
                  etsyConfig,
                  listingShopId,
                  listingId,
                  fileName,
                  uploadBlob,
                  index + 1,
                  fingerprint,
                  true,
                ),
              );
              changed = true;
            } catch (binaryError) {
              try {
                await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
                  uploadEtsyListingImageUrl(
                    etsyConfig,
                    listingShopId,
                    listingId,
                    publicUrl,
                    index + 1,
                    fingerprint,
                    true,
                  ),
                );
                changed = true;
              } catch (urlError) {
                actionsOk = false;
                errors.push(
                  `Etsy image upload failed for ${sku}: ${urlError instanceof Error ? urlError.message : binaryError instanceof Error ? binaryError.message : "unknown error"}`,
                );
                break;
              }
            }
          }

          if (actionsOk) {
            // Step 2: wait for Etsy processing before any destructive cleanup.
            let settled = false;
            for (let attempt = 0; attempt < 6; attempt += 1) {
              etsyImages = await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
                fetchEtsyListingImages(etsyConfig, listingShopId, listingId),
              );
              const sortedImages = sortEtsyImagesByRank(etsyImages);
              const hasExpectedCount = sortedImages.length >= targetCount;
              const hasExpectedRanks = hasEtsyTargetRanks(sortedImages, targetCount);
              if (hasExpectedCount && hasExpectedRanks) {
                etsyImages = sortedImages;
                settled = true;
                break;
              }
              await waitMs(500 * (attempt + 1));
            }
            if (!settled) {
              actionsOk = false;
              errors.push(
                `Etsy image sync incomplete for ${sku}: expected ${targetCount} ranked images after upload.`,
              );
            }
          }

          if (actionsOk) {
            // Step 3: trim extra Etsy images so listing exactly mirrors local source of truth.
            const sortedImages = sortEtsyImagesByRank(etsyImages);
            const hasRankData = sortedImages.some((image) => getEtsyImageRank(image) != null);
            const extraImages = hasRankData
              ? sortedImages.filter((image) => {
                  const rank = getEtsyImageRank(image);
                  return rank != null && rank > targetCount;
                })
              : sortedImages.slice(targetCount);

            for (const extraImage of extraImages) {
              if (!extraImage.listing_image_id) continue;
              try {
                await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
                  deleteEtsyListingImage(etsyConfig, listingShopId, listingId, extraImage.listing_image_id),
                );
              } catch (deleteError) {
                actionsOk = false;
                errors.push(
                  `Etsy image delete failed for ${sku}: ${deleteError instanceof Error ? deleteError.message : "unknown error"}`,
                );
                break;
              }
            }
          }

          if (actionsOk) {
            let finalSynced = false;
            for (let attempt = 0; attempt < 4; attempt += 1) {
              const finalImages = await withEtsyRefresh(supabaseAdmin, storeId, etsyConfig, () =>
                fetchEtsyListingImages(etsyConfig, listingShopId, listingId),
              );
              const sortedFinalImages = sortEtsyImagesByRank(finalImages);
              const hasExpectedCount = sortedFinalImages.length === targetCount;
              const hasExpectedRanks = hasEtsyTargetRanks(sortedFinalImages, targetCount);
              if (hasExpectedCount && hasExpectedRanks) {
                finalSynced = true;
                break;
              }
              await waitMs(400 * (attempt + 1));
            }
            if (!finalSynced) {
              actionsOk = false;
              errors.push(`Etsy image sync incomplete for ${sku}: final listing does not match local image set.`);
            }
          }

          if (actionsOk && changed) updatedEtsyListings += 1;
          else if (actionsOk && !changed) etsyAlreadySyncedListings += 1;
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Image sync failed for ${sku}`);
    }
  }

  return NextResponse.json({
    processedProducts,
    wooEnabled,
    etsyEnabled,
    updatedWooProducts,
    wooAlreadySyncedProducts,
    updatedEtsyListings,
    etsyAlreadySyncedListings,
    missingEtsySkuMapCount,
    skippedNoSku,
    skippedNoLocalImages,
    errors: errors.slice(0, 25),
  });
}
