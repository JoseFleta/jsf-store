import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

function buildPriceFingerprint(product: ProductRow): string {
  const payload = JSON.stringify({
    base_price: Number(product.base_price || 0),
    woo_price: product.woo_price == null ? null : Number(product.woo_price),
    etsy_price: product.etsy_price == null ? null : Number(product.etsy_price),
    is_active: Boolean(product.is_active),
  });
  return hashText(payload);
}

function buildMediaFingerprint(images: ProductImageRow[]): string {
  const joined = images.map((row) => row.storage_path.trim().toLowerCase()).join("|");
  return hashText(joined);
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeId?: string; productIds?: string[] };
  const storeId = (body.storeId || "").trim();
  const productIds = Array.isArray(body.productIds)
    ? body.productIds.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
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

  let productsQuery = supabaseAdmin
    .from("products")
    .select("id,sku,title,base_price,woo_price,etsy_price,is_active")
    .eq("store_id", storeId);
  if (productIds.length > 0) productsQuery = productsQuery.in("id", productIds);

  let imagesQuery = supabaseAdmin
    .from("product_images")
    .select("product_id,storage_path,sort_order")
    .eq("store_id", storeId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (productIds.length > 0) imagesQuery = imagesQuery.in("product_id", productIds);

  const [productsRes, imagesRes] = await Promise.all([productsQuery, imagesQuery]);
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
  const rows = products.map((product) => {
    const productImages = imagesByProductId.get(product.id) || [];
    const priceFingerprint = buildPriceFingerprint(product);
    const mediaFingerprint = buildMediaFingerprint(productImages);
    const payloadSnapshot = {
      sku: normalizeSku(product.sku),
      title: product.title || "",
      base_price: Number(product.base_price || 0),
      woo_price: product.woo_price == null ? null : Number(product.woo_price),
      etsy_price: product.etsy_price == null ? null : Number(product.etsy_price),
      is_active: Boolean(product.is_active),
      media_paths: productImages.map((image) => image.storage_path),
    };
    const payloadFingerprint = hashText(JSON.stringify(payloadSnapshot));

    return {
      store_id: storeId,
      product_id: product.id,
      sku: normalizeSku(product.sku),
      local_price_fingerprint: priceFingerprint,
      local_media_fingerprint: mediaFingerprint,
      local_payload_fingerprint: payloadFingerprint,
      local_snapshot_json: payloadSnapshot,
      updated_at: nowIso,
    };
  });

  if (rows.length > 0) {
    const { error: upsertErr } = await supabaseAdmin
      .from("product_marketplace_fingerprints")
      .upsert(rows, { onConflict: "store_id,product_id" });
    if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    processedProducts: products.length,
    updatedFingerprints: rows.length,
  });
}
