import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type EtsySkuMapEntry = {
  listing_id?: string;
  state?: string;
};

type StoreIntegrationRow = {
  etsy_bearer: string | null;
  etsy_keystring: string | null;
  etsy_shop_name: string | null;
  etsy_skumap_json: Record<string, EtsySkuMapEntry> | null;
};

function normalizeSku(raw: string | null | undefined): string {
  return (raw || "").trim().toUpperCase();
}

function isPlaceholderSku(sku: string): boolean {
  // Etsy can return placeholder single-digit values in some inventories.
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

function pickFirstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `${res.status} ${res.statusText}`;
  return `${res.status} ${text}`;
}

async function resolveEtsyShopId(bearer: string, apiKey: string, shopNameOrId: string): Promise<number> {
  if (/^\d+$/.test(shopNameOrId.trim())) return Number(shopNameOrId.trim());

  const url = new URL("https://openapi.etsy.com/v3/application/shops");
  url.searchParams.set("shop_name", shopNameOrId.trim());
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}`, "x-api-key": apiKey },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Etsy shop lookup failed: ${await parseErrorBody(res)}`);
  const payload = (await res.json()) as { results?: Array<{ shop_id?: number }> };
  const shopId = payload.results?.[0]?.shop_id;
  if (!shopId) throw new Error(`Etsy shop lookup failed: could not resolve '${shopNameOrId}'.`);
  return shopId;
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

  const { data: membership, error: memErr } = await supabaseAdmin
    .from("store_memberships")
    .select("role")
    .eq("store_id", storeId)
    .eq("user_id", userRes.user.id)
    .maybeSingle();
  if (memErr || !membership) return NextResponse.json({ error: "Store access denied" }, { status: 403 });

  const [integrationRes, productsRes] = await Promise.all([
    supabaseAdmin
      .from("store_integrations")
      .select("etsy_bearer,etsy_keystring,etsy_shop_name,etsy_skumap_json")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabaseAdmin.from("products").select("sku").eq("store_id", storeId),
  ]);

  const integration = integrationRes.data;
  const integrationErr = integrationRes.error;

  if (integrationErr?.message.includes("Could not find the table 'public.store_integrations'")) {
    return NextResponse.json(
      { error: "Missing DB table: public.store_integrations. Run sql/store_integrations.sql in Supabase SQL Editor." },
      { status: 400 },
    );
  }
  if (integrationErr) return NextResponse.json({ error: integrationErr.message }, { status: 400 });
  if (productsRes.error) return NextResponse.json({ error: productsRes.error.message }, { status: 400 });

  const row = (integration ?? null) as StoreIntegrationRow | null;
  const localSkuSet = new Set(
    ((productsRes.data ?? []) as Array<{ sku: string | null }>)
      .map((p) => normalizeSku(p.sku))
      .filter((sku) => sku.length > 0),
  );
  const bearer = pickFirstNonEmpty(row?.etsy_bearer, process.env.ETSY_BEARER);
  const apiKey = pickFirstNonEmpty(row?.etsy_keystring, process.env.ETSY_KEYSTRING);
  const shopName = pickFirstNonEmpty(row?.etsy_shop_name, process.env.ETSY_SHOP_NAME);
  if (!bearer || !apiKey || !shopName) {
    return NextResponse.json({ error: "Missing Etsy bearer, keystring, or shop name in settings." }, { status: 400 });
  }

  let shopId = 0;
  try {
    shopId = await resolveEtsyShopId(bearer, apiKey, shopName);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Etsy shop lookup failed." }, { status: 400 });
  }

  const listingIds = new Map<string, string>();
  const pageSize = 100;

  const fetchStateListings = async (state: string) => {
    let usedFallbackQuery = false;

    const runPaged = async (buildUrl: (offset: number) => URL) => {
      for (let offset = 0; offset < 5000; offset += pageSize) {
        const res = await fetch(buildUrl(offset).toString(), {
          method: "GET",
          headers: { Authorization: `Bearer ${bearer}`, "x-api-key": apiKey },
          cache: "no-store",
        });
        if (!res.ok) {
          return { ok: false as const, error: await parseErrorBody(res) };
        }

        const payload = (await res.json()) as {
          results?: Array<{ listing_id?: number; state?: string }>;
        };
        const results = payload.results || [];
        for (const listing of results) {
          if (listing.listing_id) {
            listingIds.set(String(listing.listing_id), listing.state || state);
          }
        }
        if (results.length < pageSize) break;
      }
      return { ok: true as const };
    };

    const statePathResult = await runPaged((offset) => {
      const url = new URL(`https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${state}`);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      return url;
    });
    if (statePathResult.ok) return { ok: true as const, usedFallbackQuery };

    usedFallbackQuery = true;
    const stateQueryResult = await runPaged((offset) => {
      const url = new URL(`https://openapi.etsy.com/v3/application/shops/${shopId}/listings`);
      url.searchParams.set("state", state);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      return url;
    });
    if (stateQueryResult.ok) return { ok: true as const, usedFallbackQuery };

    return { ok: false as const, error: `state=${state}: ${stateQueryResult.error}` };
  };

  const listingStates = ["active", "inactive", "draft"];
  for (const state of listingStates) {
    const stateResult = await fetchStateListings(state);
    if (!stateResult.ok) {
      return NextResponse.json({ error: `Etsy listings fetch failed (${stateResult.error})` }, { status: 400 });
    }
  }

  const generatedMap: Record<string, EtsySkuMapEntry> = {};
  let skuCount = 0;
  let ignoredNonStoreSkuCount = 0;
  const errors: string[] = [];

  for (const [listingId, listingState] of listingIds.entries()) {
    const invRes = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}`, "x-api-key": apiKey },
      cache: "no-store",
    });
    if (!invRes.ok) {
      errors.push(`Inventory fetch failed for listing ${listingId}: ${await parseErrorBody(invRes)}`);
      continue;
    }

    const inventory = (await invRes.json()) as {
      products?: Array<{ sku?: string[] | string | null }>;
    };

    for (const product of inventory.products || []) {
      for (const sku of extractSkus(product.sku)) {
        if (!sku) continue;
        if (isPlaceholderSku(sku)) continue;
        if (!localSkuSet.has(sku)) {
          ignoredNonStoreSkuCount += 1;
          continue;
        }
        if (!generatedMap[sku]) skuCount += 1;
        generatedMap[sku] = { listing_id: listingId, state: listingState || "active" };
      }
    }
  }

  const existing = row?.etsy_skumap_json || {};
  const cleanedExisting = Object.fromEntries(
    Object.entries(existing).filter(([rawSku]) => {
      const sku = normalizeSku(rawSku);
      return sku.length > 0 && !isPlaceholderSku(sku) && localSkuSet.has(sku);
    }),
  );
  const merged = { ...cleanedExisting, ...generatedMap };
  const { error: saveErr } = await supabaseAdmin
    .from("store_integrations")
    .upsert({ store_id: storeId, etsy_skumap_json: merged, updated_at: new Date().toISOString() } as any, { onConflict: "store_id" });
  if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    listingCount: listingIds.size,
    discoveredSkuCount: skuCount,
    ignoredNonStoreSkuCount,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
}
