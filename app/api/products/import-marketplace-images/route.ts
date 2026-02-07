import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type ImportPlatform = "woocommerce" | "etsy";

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
  sort_order: number;
};

type WooProduct = {
  id: number;
  sku?: string | null;
  images?: Array<{ src?: string | null }>;
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

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function detectExtension(url: string, contentType: string | null): string {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("image/jpeg")) return "jpg";
  if (ct.includes("image/png")) return "png";
  if (ct.includes("image/webp")) return "webp";
  if (ct.includes("image/gif")) return "gif";
  if (ct.includes("image/avif")) return "avif";

  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
  if (match) return sanitizeFileName(match[1].toLowerCase());
  return "jpg";
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
  if (!res.ok) {
    throw new Error(`Etsy token refresh failed: ${await parseErrorBody(res)}`);
  }

  const payload = (await res.json()) as EtsyRefreshResponse;
  if (!payload.access_token) throw new Error("Etsy token refresh failed: access_token missing in response.");
  return payload;
}

async function resolveEtsyShopId(config: ResolvedEtsyConfig): Promise<number> {
  if (/^\d+$/.test(config.shopName.trim())) return Number(config.shopName.trim());

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

  const payload = (await lookupRes.json()) as {
    results?: Array<{ shop_id?: number }>;
  };
  const shopId = payload.results?.[0]?.shop_id;
  if (!shopId) throw new Error(`Etsy shop lookup failed: could not resolve shop '${config.shopName}'.`);
  return shopId;
}

async function fetchEtsyListingImageUrls(config: ResolvedEtsyConfig, listingId: string, shopId: number | null): Promise<string[]> {
  const headers = {
    Authorization: `Bearer ${config.bearer}`,
    "x-api-key": config.apiKey,
  };
  const shopEndpoint =
    shopId != null ? `https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images` : "";
  const listingEndpoint = `https://openapi.etsy.com/v3/application/listings/${listingId}/images`;
  const targets = [shopEndpoint, listingEndpoint].filter((url) => Boolean(url));

  let lastError = "";
  for (const target of targets) {
    const res = await fetch(target, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      lastError = await parseErrorBody(res);
      continue;
    }

    const payload = (await res.json()) as {
      results?: Array<{ url_fullxfull?: string; url_570xN?: string; url_300x300?: string }>;
    };
    const urls = (payload.results || [])
      .map((row) => row.url_fullxfull || row.url_570xN || row.url_300x300 || "")
      .filter((url) => typeof url === "string" && url.trim().length > 0);

    if (urls.length > 0) return urls;
  }

  if (lastError) throw new Error(`Etsy images fetch failed for listing ${listingId}: ${lastError}`);
  return [];
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

async function fetchEtsyListingImageUrlsWithRefresh(
  supabaseAdmin: ReturnType<typeof createClient>,
  storeId: string,
  config: ResolvedEtsyConfig,
  listingId: string,
  shopId: number | null,
): Promise<string[]> {
  try {
    return await fetchEtsyListingImageUrls(config, listingId, shopId);
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
    return fetchEtsyListingImageUrls(config, listingId, shopId);
  }
}

async function fetchImageBytes(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`Image download failed: ${await parseErrorBody(res)}`);
  const contentType = res.headers.get("content-type");
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType };
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    storeId?: string;
    productIds?: string[];
    platform?: ImportPlatform;
    fallbackPlatform?: ImportPlatform | null;
  };
  const storeId = (body.storeId || "").trim();
  const platform = body.platform === "woocommerce" || body.platform === "etsy" ? body.platform : null;
  const fallbackPlatformRaw =
    body.fallbackPlatform === "woocommerce" || body.fallbackPlatform === "etsy" ? body.fallbackPlatform : null;
  const fallbackPlatform = fallbackPlatformRaw && fallbackPlatformRaw !== platform ? fallbackPlatformRaw : null;
  const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id) => typeof id === "string" && id.trim()) : [];

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

  const [productsRes, integrationsRes, currentImagesRes] = await Promise.all([
    supabaseAdmin.from("products").select("id,sku").eq("store_id", storeId).in("id", productIds),
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabaseAdmin
      .from("product_images")
      .select("product_id,sort_order")
      .eq("store_id", storeId)
      .in("product_id", productIds),
  ]);

  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (currentImagesRes.error) return NextResponse.json({ error: currentImagesRes.error.message }, { status: 400 });

  const products = (productsRes.data ?? []) as ProductRow[];
  const integrationRow = integrationsRes.error ? null : ((integrationsRes.data ?? null) as StoreIntegrationRow | null);
  const imageRows = (currentImagesRes.data ?? []) as ProductImageRow[];

  const sortMap = new Map<string, number>();
  for (const row of imageRows) {
    const prev = sortMap.get(row.product_id) ?? -1;
    sortMap.set(row.product_id, Math.max(prev, row.sort_order));
  }

  const wooConfig = resolveWooConfig(integrationRow);
  const etsyConfig = resolveEtsyConfig(integrationRow);
  if (platform === "woocommerce" && !wooConfig) {
    return NextResponse.json({ error: "WooCommerce is not configured for this store." }, { status: 400 });
  }
  if (platform === "etsy" && !etsyConfig) {
    return NextResponse.json({ error: "Etsy is not configured or SKU map is missing for this store." }, { status: 400 });
  }
  if (fallbackPlatform === "woocommerce" && !wooConfig) {
    return NextResponse.json({ error: "Fallback WooCommerce is not configured for this store." }, { status: 400 });
  }
  if (fallbackPlatform === "etsy" && !etsyConfig) {
    return NextResponse.json({ error: "Fallback Etsy is not configured or SKU map is missing for this store." }, { status: 400 });
  }

  if (platform === "etsy" || fallbackPlatform === "etsy") {
    try {
      await maybeRefreshEtsyToken(supabaseAdmin, storeId, etsyConfig!);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Etsy token refresh failed." },
        { status: 400 },
      );
    }
  }

  let etsyShopId: number | null = null;
  if (platform === "etsy" || fallbackPlatform === "etsy") {
    try {
      etsyShopId = await resolveEtsyShopId(etsyConfig!);
    } catch {
      etsyShopId = null;
    }
  }

  const errors: string[] = [];
  let importedProducts = 0;
  let totalImagesImported = 0;
  let missingSkuCount = 0;
  let missingImageCount = 0;

  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (!sku) {
      missingSkuCount += 1;
      continue;
    }

    try {
      const fetchImageUrlsBySource = async (
        source: ImportPlatform,
      ): Promise<{ urls: string[]; missingSku: boolean }> => {
        if (source === "woocommerce") {
          const matches = await findWooProductsBySku(wooConfig!, sku);
          const sourceProduct = matches.find((item) => Array.isArray(item.images) && item.images.length > 0) || matches[0];
          const urls = (sourceProduct?.images || [])
            .map((image) => (typeof image?.src === "string" ? image.src.trim() : ""))
            .filter((url) => url.length > 0);
          return { urls, missingSku: matches.length === 0 };
        }

        const listingId = etsyConfig!.skuMap.get(sku)?.listing_id;
        if (!listingId) {
          return { urls: [], missingSku: true };
        }
        const urls = await fetchEtsyListingImageUrlsWithRefresh(
          supabaseAdmin,
          storeId,
          etsyConfig!,
          listingId,
          etsyShopId,
        );
        return { urls, missingSku: false };
      };

      const primaryResult = await fetchImageUrlsBySource(platform);
      let sourceImageUrls = primaryResult.urls;
      let usedSource = platform;

      if (sourceImageUrls.length === 0 && fallbackPlatform) {
        const fallbackResult = await fetchImageUrlsBySource(fallbackPlatform);
        if (fallbackResult.urls.length > 0) {
          sourceImageUrls = fallbackResult.urls;
          usedSource = fallbackPlatform;
        } else if (primaryResult.missingSku || fallbackResult.missingSku) {
          missingSkuCount += 1;
        }
      } else if (sourceImageUrls.length === 0 && primaryResult.missingSku) {
        missingSkuCount += 1;
      }

      if (sourceImageUrls.length === 0) {
        missingImageCount += 1;
        continue;
      }

      let nextSortOrder = (sortMap.get(product.id) ?? -1) + 1;
      const imageRowsToUpsert: Array<{
        store_id: string;
        product_id: string;
        storage_path: string;
        sort_order: number;
        is_primary: boolean;
      }> = [];
      let productImported = 0;

      for (let index = 0; index < sourceImageUrls.length; index += 1) {
        const sourceUrl = sourceImageUrls[index];
        const downloaded = await fetchImageBytes(sourceUrl);
        const ext = detectExtension(sourceUrl, downloaded.contentType);
        const filename = `import-${usedSource}-${hashText(sourceUrl)}-${index}.${ext}`;
        const storagePath = `${storeId}/${product.id}/${sanitizeFileName(filename)}`;

        const uploadRes = await supabaseAdmin.storage.from("product-images").upload(storagePath, downloaded.bytes, {
          upsert: true,
          contentType: downloaded.contentType || undefined,
        });
        if (uploadRes.error) {
          errors.push(`Upload failed for ${sku}: ${uploadRes.error.message}`);
          continue;
        }

        imageRowsToUpsert.push({
          store_id: storeId,
          product_id: product.id,
          storage_path: storagePath,
          sort_order: nextSortOrder,
          is_primary: nextSortOrder === 0,
        });
        nextSortOrder += 1;
        productImported += 1;
      }

      if (imageRowsToUpsert.length > 0) {
        const { error: upsertErr } = await supabaseAdmin
          .from("product_images")
          .upsert(imageRowsToUpsert, { onConflict: "product_id,storage_path" });
        if (upsertErr) {
          errors.push(`product_images upsert failed for ${sku}: ${upsertErr.message}`);
          continue;
        }
      }

      if (productImported > 0) {
        importedProducts += 1;
        totalImagesImported += productImported;
        sortMap.set(product.id, nextSortOrder - 1);
      } else {
        missingImageCount += 1;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Unknown import error for ${sku}`);
    }
  }

  return NextResponse.json({
    processedProducts: products.length,
    importedProducts,
    totalImagesImported,
    missingSkuCount,
    missingImageCount,
    errors: errors.slice(0, 25),
  });
}
