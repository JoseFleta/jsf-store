import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseAdminClient = any;

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

type ExistingSaleRow = {
  product_id: string;
  quantity: number | null;
  unit_price: number | null;
  channel: string | null;
  occurred_on: string;
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
  skuByListingId: Map<string, string>;
};

type EtsyRefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type WooOrder = {
  id: number;
  date_created?: string | null;
  date_paid?: string | null;
  date_completed?: string | null;
  line_items?: Array<{
    id?: number;
    sku?: string | null;
    product_id?: number | null;
    variation_id?: number | null;
    quantity?: number | string | null;
    total?: string | number | null;
    price?: string | number | null;
  }>;
};

type EtsyReceipt = {
  receipt_id?: number | string | null;
  created_timestamp?: number | null;
  create_timestamp?: number | null;
  was_paid?: boolean | null;
  transactions?: EtsyTransaction[] | null;
};

type EtsyTransaction = {
  transaction_id?: number | string | null;
  listing_id?: number | string | null;
  sku?: string[] | string | null;
  quantity?: number | string | null;
  price?: unknown;
};

type SaleCandidate = {
  sku: string;
  quantity: number;
  totalAmount: number;
  occurredOn: string;
  channel: "WooCommerce" | "Etsy";
  uniqueRemoteKey: string;
};

function normalizeSku(raw: string | null | undefined): string {
  return (raw || "").trim().toUpperCase();
}

function normalizeChannel(raw: string | null | undefined): string {
  return (raw || "").trim().toLowerCase();
}

function normalizeDateOnly(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function toIsoWithTimezone(dateOnly: string): string {
  return `${dateOnly}T00:00:00.000Z`;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
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

async function parseErrorBody(res: Response): Promise<string> {
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

function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeEtsyPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeEtsyPrice(item);
      if (normalized != null && Number.isFinite(normalized)) return normalized;
    }
  }
  if (value && typeof value === "object") {
    const v = value as { amount?: unknown; divisor?: unknown; value?: unknown };
    const amount = normalizeNumber(v.amount);
    const divisor = normalizeNumber(v.divisor);
    if (amount != null && divisor != null && divisor > 0) return amount / divisor;
    return normalizeEtsyPrice(v.value);
  }
  return null;
}

function extractSkus(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? normalizeSku(item) : "")).filter(Boolean);
  }
  if (typeof value === "string") {
    const sku = normalizeSku(value);
    return sku ? [sku] : [];
  }
  return [];
}

function resolveWooConfig(integration: StoreIntegrationRow | null): ResolvedWooConfig | null {
  const baseUrl = pickFirstNonEmpty(integration?.woo_url, process.env.WOO_URL);
  const key = pickFirstNonEmpty(integration?.woo_key, process.env.WOO_KEY);
  const secret = pickFirstNonEmpty(integration?.woo_secret, process.env.WOO_SECRET);
  if (!baseUrl || !key || !secret) return null;
  return { baseUrl, key, secret };
}

function buildWooUrl(config: ResolvedWooConfig, path: string, q?: Record<string, string>): string {
  const url = new URL(`/wp-json/wc/v3${path}`, config.baseUrl);
  url.searchParams.set("consumer_key", config.key);
  url.searchParams.set("consumer_secret", config.secret);
  if (q) {
    for (const [key, value] of Object.entries(q)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
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

  if (!bearer || !apiKey || !shopName) return null;

  const skuByListingId = new Map<string, string>();
  for (const [sku, entry] of Object.entries(mergedMap)) {
    const listingId = String(entry?.listing_id || "").trim();
    if (listingId) skuByListingId.set(listingId, normalizeSku(sku));
  }

  return { bearer, refreshToken, tokenExpiresAt, apiKey, shopName, skuByListingId };
}

function isEtsyInvalidTokenError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("401") && normalized.includes("invalid_token");
}

async function refreshEtsyAccessToken(config: ResolvedEtsyConfig): Promise<EtsyRefreshResponse> {
  if (!config.refreshToken) throw new Error("Etsy token refresh failed: refresh token missing.");

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
  supabaseAdmin: SupabaseAdminClient,
  storeId: string,
  config: ResolvedEtsyConfig,
) {
  await supabaseAdmin
    .from("store_integrations")
    .upsert(
      {
        store_id: storeId,
        etsy_bearer: config.bearer,
        etsy_refresh_token: config.refreshToken || null,
        etsy_token_expires_at: config.tokenExpiresAt,
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "store_id" },
    );
}

async function maybeRefreshEtsyToken(
  supabaseAdmin: SupabaseAdminClient,
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

async function fetchEtsyJsonWithAutoRefresh<T>(
  supabaseAdmin: SupabaseAdminClient,
  storeId: string,
  config: ResolvedEtsyConfig,
  url: string,
  contextLabel: string,
): Promise<T> {
  const run = async () => {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.bearer}`, "x-api-key": config.apiKey },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${contextLabel}: ${await parseErrorBody(res)}`);
    return (await res.json()) as T;
  };

  try {
    return await run();
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : String(error);
    if (!isEtsyInvalidTokenError(firstMessage) || !config.refreshToken) throw error;

    const refreshed = await refreshEtsyAccessToken(config);
    config.bearer = refreshed.access_token;
    if (refreshed.refresh_token) config.refreshToken = refreshed.refresh_token;
    if (refreshed.expires_in && Number.isFinite(refreshed.expires_in)) {
      config.tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    }
    await saveRefreshedEtsyToken(supabaseAdmin, storeId, config);
    return run();
  }
}

async function resolveEtsyShopId(
  supabaseAdmin: SupabaseAdminClient,
  storeId: string,
  config: ResolvedEtsyConfig,
): Promise<number> {
  if (/^\d+$/.test(config.shopName.trim())) return Number(config.shopName.trim());

  const lookupUrl = new URL("https://openapi.etsy.com/v3/application/shops");
  lookupUrl.searchParams.set("shop_name", config.shopName.trim());
  const lookup = await fetchEtsyJsonWithAutoRefresh<{ results?: Array<{ shop_id?: number }> }>(
    supabaseAdmin,
    storeId,
    config,
    lookupUrl.toString(),
    `Etsy shop lookup failed (${config.shopName})`,
  );
  const shopId = lookup.results?.[0]?.shop_id;
  if (!shopId) throw new Error(`Etsy shop lookup failed for ${config.shopName}.`);
  return shopId;
}

async function fetchWooOrders(config: ResolvedWooConfig, startDate: string) {
  const statuses = ["processing", "completed"];
  const orders: WooOrder[] = [];

  for (const status of statuses) {
    let page = 1;
    while (page <= 100) {
      const url = buildWooUrl(config, "/orders", {
        status,
        per_page: "100",
        page: String(page),
        orderby: "date",
        order: "desc",
        after: toIsoWithTimezone(startDate),
      });
      const res = await fetchWooWithFallback(url);
      if (!res.ok) throw new Error(`Woo orders fetch failed: ${await parseErrorBody(res)}`);
      const batch = (await res.json()) as WooOrder[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      orders.push(...batch);
      if (batch.length < 100) break;
      page += 1;
    }
  }

  return orders;
}

async function resolveWooLineSku(
  config: ResolvedWooConfig,
  line: NonNullable<WooOrder["line_items"]>[number],
  skuCache: Map<string, string>,
): Promise<string> {
  const lineSku = normalizeSku(line?.sku);
  if (lineSku) return lineSku;

  const productId = Number(line?.product_id || 0);
  const variationId = Number(line?.variation_id || 0);
  const cacheKey = `${productId}:${variationId}`;
  if (skuCache.has(cacheKey)) return skuCache.get(cacheKey) || "";
  if (!productId) {
    skuCache.set(cacheKey, "");
    return "";
  }

  const variationUrl =
    variationId > 0
      ? buildWooUrl(config, `/products/${productId}/variations/${variationId}`)
      : "";
  if (variationUrl) {
    const variationRes = await fetchWooWithFallback(variationUrl);
    if (variationRes.ok) {
      const variation = (await variationRes.json()) as { sku?: string | null };
      const resolved = normalizeSku(variation?.sku);
      skuCache.set(cacheKey, resolved);
      if (resolved) return resolved;
    }
  }

  const productUrl = buildWooUrl(config, `/products/${productId}`);
  const productRes = await fetchWooWithFallback(productUrl);
  if (productRes.ok) {
    const product = (await productRes.json()) as { sku?: string | null };
    const resolved = normalizeSku(product?.sku);
    skuCache.set(cacheKey, resolved);
    return resolved;
  }

  skuCache.set(cacheKey, "");
  return "";
}

async function buildWooCandidates(
  config: ResolvedWooConfig,
  orders: WooOrder[],
): Promise<{ candidates: SaleCandidate[]; skippedNoSku: number }> {
  const candidates: SaleCandidate[] = [];
  let skippedNoSku = 0;
  const skuCache = new Map<string, string>();

  for (const order of orders) {
    const occurredOn = normalizeDateOnly(order.date_paid || order.date_completed || order.date_created);
    if (!occurredOn) continue;

    const lines = Array.isArray(order.line_items) ? order.line_items : [];
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const sku = await resolveWooLineSku(config, line, skuCache);
      if (!sku) {
        skippedNoSku += 1;
        continue;
      }
      const qty = Math.round(normalizeNumber(line?.quantity) || 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;

      const total =
        roundMoney(normalizeNumber(line?.total) || 0) ||
        roundMoney((normalizeNumber(line?.price) || 0) * qty);

      candidates.push({
        sku,
        quantity: qty,
        totalAmount: roundMoney(Math.max(0, total)),
        occurredOn,
        channel: "WooCommerce",
        uniqueRemoteKey: `woo:${order.id}:${line?.id || idx}`,
      });
    }
  }

  return { candidates, skippedNoSku };
}

async function fetchEtsyReceipts(
  supabaseAdmin: SupabaseAdminClient,
  storeId: string,
  config: ResolvedEtsyConfig,
  shopId: number,
  startDate: string,
) {
  const receipts: EtsyReceipt[] = [];
  const minCreated = Math.floor(new Date(toIsoWithTimezone(startDate)).getTime() / 1000);
  let offset = 0;
  const limit = 100;

  while (offset <= 10_000) {
    const url = new URL(`https://openapi.etsy.com/v3/application/shops/${shopId}/receipts`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("was_paid", "true");
    url.searchParams.set("min_created", String(minCreated));

    const payload = await fetchEtsyJsonWithAutoRefresh<{ results?: EtsyReceipt[] }>(
      supabaseAdmin,
      storeId,
      config,
      url.toString(),
      "Etsy receipts fetch failed",
    );
    const batch = Array.isArray(payload.results) ? payload.results : [];
    if (batch.length === 0) break;

    receipts.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return receipts;
}

async function fetchEtsyReceiptTransactions(
  supabaseAdmin: SupabaseAdminClient,
  storeId: string,
  config: ResolvedEtsyConfig,
  shopId: number,
  receiptId: string,
): Promise<EtsyTransaction[]> {
  const url = `https://openapi.etsy.com/v3/application/shops/${shopId}/receipts/${receiptId}/transactions`;
  const payload = await fetchEtsyJsonWithAutoRefresh<{ results?: EtsyTransaction[] }>(
    supabaseAdmin,
    storeId,
    config,
    url,
    `Etsy receipt transactions fetch failed (${receiptId})`,
  );
  return Array.isArray(payload.results) ? payload.results : [];
}

async function buildEtsyCandidates(
  supabaseAdmin: SupabaseAdminClient,
  storeId: string,
  config: ResolvedEtsyConfig,
  shopId: number,
  receipts: EtsyReceipt[],
): Promise<{ candidates: SaleCandidate[]; skippedNoSku: number; transactionsCount: number }> {
  const candidates: SaleCandidate[] = [];
  let skippedNoSku = 0;
  let transactionsCount = 0;

  for (const receipt of receipts) {
    const receiptId = String(receipt.receipt_id || "").trim();
    if (!receiptId) continue;
    const occurredOnRaw = receipt.created_timestamp || receipt.create_timestamp;
    const occurredOn =
      typeof occurredOnRaw === "number" && Number.isFinite(occurredOnRaw)
        ? new Date(occurredOnRaw * 1000).toISOString().slice(0, 10)
        : "";
    if (!occurredOn) continue;

    let transactions = Array.isArray(receipt.transactions) ? receipt.transactions : [];
    if (transactions.length === 0) {
      try {
        transactions = await fetchEtsyReceiptTransactions(supabaseAdmin, storeId, config, shopId, receiptId);
      } catch {
        transactions = [];
      }
    }
    transactionsCount += transactions.length;

    for (let idx = 0; idx < transactions.length; idx += 1) {
      const tx = transactions[idx];
      const listingId = String(tx.listing_id || "").trim();
      const skus = extractSkus(tx.sku);
      const sku = skus[0] || (listingId ? config.skuByListingId.get(listingId) || "" : "");
      if (!sku) {
        skippedNoSku += 1;
        continue;
      }

      const qty = Math.round(normalizeNumber(tx.quantity) || 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;

      const unitPrice = normalizeEtsyPrice(tx.price) || 0;
      const totalAmount = roundMoney(Math.max(0, unitPrice * qty));
      const txId = String(tx.transaction_id || "").trim();

      candidates.push({
        sku,
        quantity: qty,
        totalAmount,
        occurredOn,
        channel: "Etsy",
        uniqueRemoteKey: `etsy:${receiptId}:${txId || idx}`,
      });
    }
  }

  return { candidates, skippedNoSku, transactionsCount };
}

function buildExistingSaleKey(productId: string, occurredOn: string, quantity: number, amount: number, channel: string): string {
  return `${productId}|${occurredOn}|${Math.round(quantity)}|${roundMoney(amount).toFixed(2)}|${normalizeChannel(channel)}`;
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeId?: string };
  const storeId = (body.storeId || "").trim();
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });

  const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userRes?.user) return NextResponse.json({ error: "Invalid session" }, { status: 401 });

  const { data: membership, error: membershipErr } = await supabaseAdmin
    .from("store_memberships")
    .select("role")
    .eq("store_id", storeId)
    .eq("user_id", userRes.user.id)
    .maybeSingle();
  if (membershipErr || !membership) return NextResponse.json({ error: "Store access denied" }, { status: 403 });

  const [productsRes, integrationsRes, existingSalesRes] = await Promise.all([
    supabaseAdmin.from("products").select("id,sku").eq("store_id", storeId),
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabaseAdmin
      .from("stock_movements")
      .select("product_id,quantity,unit_price,channel,occurred_on")
      .eq("store_id", storeId)
      .eq("movement_type", "sale"),
  ]);

  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (existingSalesRes.error) return NextResponse.json({ error: existingSalesRes.error.message }, { status: 400 });

  const products = (productsRes.data ?? []) as ProductRow[];
  const integrationRow = integrationsRes.error ? null : ((integrationsRes.data ?? null) as StoreIntegrationRow | null);
  const existingSales = (existingSalesRes.data ?? []) as ExistingSaleRow[];

  const skuToProductId = new Map<string, string>();
  for (const row of products) {
    const sku = normalizeSku(row.sku);
    if (sku) skuToProductId.set(sku, row.id);
  }

  const defaultStart = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let latestOccurred = "";
  for (const row of existingSales) {
    const date = normalizeDateOnly(row.occurred_on);
    if (!date) continue;
    if (!latestOccurred || date > latestOccurred) latestOccurred = date;
  }
  const startDate = latestOccurred || defaultStart;

  const existingKeys = new Set<string>();
  for (const row of existingSales) {
    if (!row.product_id) continue;
    const occurredOn = normalizeDateOnly(row.occurred_on);
    if (!occurredOn) continue;
    const qty = Math.round(normalizeNumber(row.quantity) || 0);
    const amount = roundMoney(normalizeNumber(row.unit_price) || 0);
    existingKeys.add(buildExistingSaleKey(row.product_id, occurredOn, qty, amount, row.channel || ""));
  }

  const errors: string[] = [];
  let wooOrdersCount = 0;
  let etsyReceiptsCount = 0;
  let etsyTransactionsCount = 0;
  let skippedMissingSku = 0;
  let skippedUnknownLocalProduct = 0;
  let dedupedCount = 0;

  const allCandidates: SaleCandidate[] = [];

  const wooConfig = resolveWooConfig(integrationRow);
  if (wooConfig) {
    try {
      const wooOrders = await fetchWooOrders(wooConfig, startDate);
      wooOrdersCount = wooOrders.length;
      const wooBuilt = await buildWooCandidates(wooConfig, wooOrders);
      allCandidates.push(...wooBuilt.candidates);
      skippedMissingSku += wooBuilt.skippedNoSku;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Woo sales sync failed.");
    }
  }

  const etsyConfig = resolveEtsyConfig(integrationRow);
  if (etsyConfig) {
    try {
      await maybeRefreshEtsyToken(supabaseAdmin, storeId, etsyConfig);
      const shopId = await resolveEtsyShopId(supabaseAdmin, storeId, etsyConfig);
      const receipts = await fetchEtsyReceipts(supabaseAdmin, storeId, etsyConfig, shopId, startDate);
      etsyReceiptsCount = receipts.length;
      const etsyBuilt = await buildEtsyCandidates(supabaseAdmin, storeId, etsyConfig, shopId, receipts);
      etsyTransactionsCount = etsyBuilt.transactionsCount;
      allCandidates.push(...etsyBuilt.candidates);
      skippedMissingSku += etsyBuilt.skippedNoSku;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Etsy sales sync failed.");
    }
  }

  const rowsToInsert: Array<{
    store_id: string;
    product_id: string;
    movement_type: "sale";
    quantity: number;
    qty_change: number;
    unit_price: number;
    channel: string;
    occurred_on: string;
  }> = [];

  const seenRemoteKeys = new Set<string>();
  for (const candidate of allCandidates) {
    if (seenRemoteKeys.has(candidate.uniqueRemoteKey)) continue;
    seenRemoteKeys.add(candidate.uniqueRemoteKey);

    const productId = skuToProductId.get(candidate.sku);
    if (!productId) {
      skippedUnknownLocalProduct += 1;
      continue;
    }

    const dedupeKey = buildExistingSaleKey(
      productId,
      candidate.occurredOn,
      candidate.quantity,
      candidate.totalAmount,
      candidate.channel,
    );
    if (existingKeys.has(dedupeKey)) {
      dedupedCount += 1;
      continue;
    }

    existingKeys.add(dedupeKey);
    rowsToInsert.push({
      store_id: storeId,
      product_id: productId,
      movement_type: "sale",
      quantity: candidate.quantity,
      qty_change: -Math.abs(candidate.quantity),
      unit_price: roundMoney(candidate.totalAmount),
      channel: candidate.channel,
      occurred_on: candidate.occurredOn,
    });
  }

  if (rowsToInsert.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      const chunk = rowsToInsert.slice(i, i + chunkSize);
      const { error } = await supabaseAdmin.from("stock_movements").insert(chunk);
      if (error) {
        return NextResponse.json(
          {
            error: error.message,
            inserted: i,
            attempted: rowsToInsert.length,
            errors: errors.slice(0, 25),
          },
          { status: 400 },
        );
      }
    }
  }

  return NextResponse.json({
    startDate,
    woo: { enabled: Boolean(wooConfig), orders: wooOrdersCount },
    etsy: { enabled: Boolean(etsyConfig), receipts: etsyReceiptsCount, transactions: etsyTransactionsCount },
    candidates: allCandidates.length,
    inserted: rowsToInsert.length,
    deduped: dedupedCount,
    skippedMissingSku,
    skippedUnknownLocalProduct,
    errors: errors.slice(0, 25),
  });
}
