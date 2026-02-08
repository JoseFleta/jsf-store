import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type IntegrationRow = {
  woo_url: string | null;
  woo_key: string | null;
  woo_secret: string | null;
  etsy_bearer: string | null;
  etsy_keystring: string | null;
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

type WooProduct = {
  id: number;
  sku?: string | null;
  regular_price?: string | null;
  price?: string | null;
  status?: string | null;
  images?: Array<{ src?: string | null }>;
};

type EtsyInventoryResponse = {
  products?: Array<{
    sku?: string[] | string | null;
    offerings?: Array<{ price?: unknown }>;
  }>;
};

type EtsyImagesResponse = {
  results?: Array<{ rank?: number | string | null }>;
};

function normalizeSku(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
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

async function parseError(res: Response): Promise<string> {
  const text = await res.text();
  return text ? `${res.status} ${text}` : `${res.status} ${res.statusText}`;
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
  const res = await fetch(buildWooUrl(baseUrl, key, secret, "/products", { sku, per_page: "100" }), {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Woo lookup failed for ${sku}: ${await parseError(res)}`);
  const rows = ((await res.json()) as WooProduct[]).filter((row) => normalizeSku(row.sku) === sku);
  if (rows.length > 0) return rows;

  const res2 = await fetch(buildWooUrl(baseUrl, key, secret, "/products", { search: sku, per_page: "100" }), {
    method: "GET",
    cache: "no-store",
  });
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

  const [productsRes, imagesRes, integrationRes] = await Promise.all([
    productsQuery,
    imagesQuery,
    supabaseAdmin
      .from("store_integrations")
      .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_keystring,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);
  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (imagesRes.error) return NextResponse.json({ error: imagesRes.error.message }, { status: 400 });

  const products = (productsRes.data ?? []) as ProductRow[];
  const images = (imagesRes.data ?? []) as ProductImageRow[];
  const integration = (integrationRes.data ?? null) as IntegrationRow | null;

  const wooUrl = pick(integration?.woo_url, process.env.WOO_URL);
  const wooKey = pick(integration?.woo_key, process.env.WOO_KEY);
  const wooSecret = pick(integration?.woo_secret, process.env.WOO_SECRET);
  const wooEnabled = Boolean(wooUrl && wooKey && wooSecret);

  const etsyBearer = pick(integration?.etsy_bearer, process.env.ETSY_BEARER);
  const etsyApiKey = pick(integration?.etsy_keystring, process.env.ETSY_KEYSTRING);
  const etsyMap = new Map<string, string>();
  for (const [mapSku, entry] of Object.entries(integration?.etsy_skumap_json || {})) {
    const normalized = normalizeSku(mapSku);
    const listingId = entry?.listing_id?.toString().trim();
    if (normalized && listingId) etsyMap.set(normalized, listingId);
  }
  const etsyEnabled = Boolean(etsyBearer && etsyApiKey);

  const imageCountByProductId: Record<string, number> = {};
  for (const image of images) imageCountByProductId[image.product_id] = (imageCountByProductId[image.product_id] || 0) + 1;

  const nowIso = new Date().toISOString();
  const fingerprintRows: Array<Record<string, unknown>> = [];
  const snapshotRows: Array<Record<string, unknown>> = [];
  const warningRows: Array<Record<string, unknown>> = [];
  const firstErrors: string[] = [];

  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (!sku) continue;
    const localImageCount = imageCountByProductId[product.id] || 0;
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
          const remoteImageCount = Array.isArray(woo.images) ? woo.images.length : 0;
          const priceMismatch = localWooPrice !== remotePrice;
          const photoMismatch = localImageCount !== remoteImageCount;
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
            stock_qty: null,
            remote_payload_fingerprint: hashText(JSON.stringify({ price: remotePrice, image_count: remoteImageCount, status: woo.status || null })),
            last_local_payload_fingerprint: localFp,
            sync_state: priceMismatch || photoMismatch ? "needs_publish" : "published",
            last_error: null,
            last_published_at: priceMismatch || photoMismatch ? null : nowIso,
            updated_at: nowIso,
            raw_json: woo,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Woo fetch failed.";
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
          message: "Missing Etsy listing mapping for this SKU.",
          local_value: { sku },
          remote_value: {},
          is_resolved: false,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
        });
      } else {
        try {
          const [listingRes, inventoryRes, imagesResRemote] = await Promise.all([
            fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}`, {
              method: "GET",
              headers: { Authorization: `Bearer ${etsyBearer}`, "x-api-key": etsyApiKey },
              cache: "no-store",
            }),
            fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`, {
              method: "GET",
              headers: { Authorization: `Bearer ${etsyBearer}`, "x-api-key": etsyApiKey },
              cache: "no-store",
            }),
            fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}/images`, {
              method: "GET",
              headers: { Authorization: `Bearer ${etsyBearer}`, "x-api-key": etsyApiKey },
              cache: "no-store",
            }),
          ]);
          if (!listingRes.ok) throw new Error(`Etsy listing fetch failed for ${listingId}: ${await parseError(listingRes)}`);
          if (!inventoryRes.ok) throw new Error(`Etsy inventory fetch failed for ${listingId}: ${await parseError(inventoryRes)}`);
          if (!imagesResRemote.ok) throw new Error(`Etsy images fetch failed for ${listingId}: ${await parseError(imagesResRemote)}`);

          const listing = (await listingRes.json()) as { title?: string; state?: string };
          const inventory = (await inventoryRes.json()) as EtsyInventoryResponse;
          const etsyImages = (await imagesResRemote.json()) as EtsyImagesResponse;
          const sortedImages = Array.isArray(etsyImages.results) ? etsyImages.results.sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0)) : [];
          const remoteImageCount = sortedImages.length;
          let remotePrice: number | null = null;
          for (const variant of inventory.products || []) {
            const skus = extractSkus(variant.sku);
            if (skus.length > 0 && !skus.includes(sku)) continue;
            for (const offering of variant.offerings || []) {
              remotePrice = normalizePrice(offering.price);
              if (remotePrice != null) break;
            }
            if (remotePrice != null) break;
          }

          const priceMismatch = localEtsyPrice !== remotePrice;
          const photoMismatch = localImageCount !== remoteImageCount;
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
            stock_qty: null,
            remote_payload_fingerprint: hashText(JSON.stringify({ price: remotePrice, image_count: remoteImageCount, status: listing.state || null })),
            last_local_payload_fingerprint: localFp,
            sync_state: priceMismatch || photoMismatch ? "needs_publish" : "published",
            last_error: null,
            last_published_at: priceMismatch || photoMismatch ? null : nowIso,
            updated_at: nowIso,
            raw_json: { listing, inventory, images_count: remoteImageCount },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Etsy fetch failed.";
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
