import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type Channel = "woocommerce" | "etsy" | "amazon" | "shopify";

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
  sort_order: number;
};

const ALLOWED_CHANNELS: Channel[] = ["woocommerce", "etsy", "amazon", "shopify"];

function normalizeSku(raw: string | null | undefined): string {
  return (raw || "").trim().toUpperCase();
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function computeLocalPayloadFingerprint(product: ProductRow, images: ProductImageRow[]): string {
  const payload = {
    sku: normalizeSku(product.sku),
    title: product.title || "",
    base_price: Number(product.base_price || 0),
    woo_price: product.woo_price == null ? null : Number(product.woo_price),
    etsy_price: product.etsy_price == null ? null : Number(product.etsy_price),
    is_active: Boolean(product.is_active),
    media_paths: images.map((image) => image.storage_path),
  };
  return hashText(JSON.stringify(payload));
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    storeId?: string;
    productIds?: string[];
    channels?: string[];
  };
  const storeId = (body.storeId || "").trim();
  const productIds = Array.isArray(body.productIds)
    ? body.productIds.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
  const channels = Array.isArray(body.channels)
    ? body.channels.filter((channel): channel is Channel => ALLOWED_CHANNELS.includes(channel as Channel))
    : [];
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });
  if (productIds.length === 0) return NextResponse.json({ error: "Select at least one product." }, { status: 400 });
  if (channels.length === 0) return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });

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

  const [productsRes, imagesRes] = await Promise.all([
    supabaseAdmin
      .from("products")
      .select("id,sku,title,base_price,woo_price,etsy_price,is_active")
      .eq("store_id", storeId)
      .in("id", productIds),
    supabaseAdmin
      .from("product_images")
      .select("product_id,storage_path,sort_order")
      .eq("store_id", storeId)
      .in("product_id", productIds)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);
  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });
  if (imagesRes.error) return NextResponse.json({ error: imagesRes.error.message }, { status: 400 });

  const products = (productsRes.data ?? []) as ProductRow[];
  const images = (imagesRes.data ?? []) as ProductImageRow[];

  const imagesByProductId = new Map<string, ProductImageRow[]>();
  for (const row of images) {
    if (!imagesByProductId.has(row.product_id)) imagesByProductId.set(row.product_id, []);
    imagesByProductId.get(row.product_id)!.push(row);
  }

  const nowIso = new Date().toISOString();
  const fingerprintRows = products.map((product) => {
    const rows = imagesByProductId.get(product.id) || [];
    const payload = {
      sku: normalizeSku(product.sku),
      title: product.title || "",
      base_price: Number(product.base_price || 0),
      woo_price: product.woo_price == null ? null : Number(product.woo_price),
      etsy_price: product.etsy_price == null ? null : Number(product.etsy_price),
      is_active: Boolean(product.is_active),
      media_paths: rows.map((image) => image.storage_path),
    };
    const localPayloadFingerprint = computeLocalPayloadFingerprint(product, rows);
    return {
      store_id: storeId,
      product_id: product.id,
      sku: normalizeSku(product.sku),
      local_price_fingerprint: hashText(
        JSON.stringify({
          base_price: Number(product.base_price || 0),
          woo_price: product.woo_price == null ? null : Number(product.woo_price),
          etsy_price: product.etsy_price == null ? null : Number(product.etsy_price),
          is_active: Boolean(product.is_active),
        }),
      ),
      local_media_fingerprint: hashText(rows.map((image) => image.storage_path.trim().toLowerCase()).join("|")),
      local_payload_fingerprint: localPayloadFingerprint,
      local_snapshot_json: payload,
      updated_at: nowIso,
    };
  });

  if (fingerprintRows.length > 0) {
    const { error: fingerprintErr } = await supabaseAdmin
      .from("product_marketplace_fingerprints")
      .upsert(fingerprintRows, { onConflict: "store_id,product_id" });
    if (fingerprintErr) return NextResponse.json({ error: fingerprintErr.message }, { status: 400 });
  }

  const snapshotRows = products.flatMap((product) => {
    const localFingerprint = computeLocalPayloadFingerprint(product, imagesByProductId.get(product.id) || []);
    return channels.map((channel) => ({
      store_id: storeId,
      product_id: product.id,
      sku: normalizeSku(product.sku),
      channel,
      title: product.title || "",
      status: Boolean(product.is_active) ? "active" : "inactive",
      currency: channel === "etsy" ? "EUR" : null,
      price:
        channel === "woocommerce"
          ? product.woo_price ?? product.base_price ?? 0
          : channel === "etsy"
          ? product.etsy_price ?? product.base_price ?? 0
          : product.base_price ?? 0,
      remote_payload_fingerprint: localFingerprint,
      last_local_payload_fingerprint: localFingerprint,
      sync_state: "published",
      last_error: null,
      last_published_at: nowIso,
      updated_at: nowIso,
    }));
  });

  if (snapshotRows.length > 0) {
    const { error: snapshotErr } = await supabaseAdmin
      .from("marketplace_product_snapshots")
      .upsert(snapshotRows, { onConflict: "store_id,product_id,channel" });
    if (snapshotErr) return NextResponse.json({ error: snapshotErr.message }, { status: 400 });
  }

  await supabaseAdmin
    .from("marketplace_sync_warnings")
    .update({ is_resolved: true, resolved_at: nowIso, last_seen_at: nowIso })
    .eq("store_id", storeId)
    .in("product_id", productIds)
    .in("channel", channels)
    .eq("is_resolved", false);

  return NextResponse.json({
    ok: true,
    markedProducts: products.length,
    channels,
  });
}
