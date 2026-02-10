import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type ConfigPayload = {
  storeId?: string;
  enabledMarketplaces?: string[];
  wooUrl?: string;
  wooKey?: string;
  wooSecret?: string;
  etsyBearer?: string;
  etsyRefreshToken?: string;
  etsyTokenExpiresAt?: string;
  etsyKeystring?: string;
  etsyShopName?: string;
  etsySkumapJson?: string;
  amazonSellerId?: string;
  amazonAccessKey?: string;
  amazonSecretKey?: string;
  amazonRegion?: string;
};

function normalizeOptional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function resolveRequestAuth(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return { error: NextResponse.json({ error: "Missing bearer token" }, { status: 401 }) };

  const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userRes?.user) return { error: NextResponse.json({ error: "Invalid session" }, { status: 401 }) };
  return { supabaseAdmin, userId: userRes.user.id, token };
}

async function verifyMembership(supabaseAdmin: any, storeId: string, userId: string) {
  const { data: membership, error: memErr } = await supabaseAdmin
    .from("store_memberships")
    .select("role")
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memErr || !membership) return false;
  return true;
}

export async function GET(req: Request) {
  const auth = await resolveRequestAuth(req);
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const storeId = (url.searchParams.get("storeId") || "").trim();
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });

  const hasAccess = await verifyMembership(auth.supabaseAdmin, storeId, auth.userId);
  if (!hasAccess) return NextResponse.json({ error: "Store access denied" }, { status: 403 });

  const { data, error } = await auth.supabaseAdmin
    .from("store_integrations")
    .select("enabled_marketplaces,woo_url,woo_key,woo_secret,etsy_bearer,etsy_refresh_token,etsy_token_expires_at,etsy_keystring,etsy_shop_name,etsy_skumap_json,amazon_seller_id,amazon_access_key,amazon_secret_key,amazon_region,updated_at")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error?.message.includes("Could not find the table 'public.store_integrations'")) {
    return NextResponse.json(
      { error: "Missing DB table: public.store_integrations. Run sql/store_integrations.sql in Supabase SQL Editor." },
      { status: 400 },
    );
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const config = data
    ? {
        wooUrl: data.woo_url || "",
        enabledMarketplaces: Array.isArray(data.enabled_marketplaces) ? data.enabled_marketplaces : [],
        wooKey: data.woo_key || "",
        wooSecret: data.woo_secret || "",
        etsyBearer: data.etsy_bearer || "",
        etsyRefreshToken: data.etsy_refresh_token || "",
        etsyTokenExpiresAt: data.etsy_token_expires_at || "",
        etsyKeystring: data.etsy_keystring || "",
        etsyShopName: data.etsy_shop_name || "",
        etsySkumapJson: data.etsy_skumap_json ? JSON.stringify(data.etsy_skumap_json, null, 2) : "{}",
        amazonSellerId: data.amazon_seller_id || "",
        amazonAccessKey: data.amazon_access_key || "",
        amazonSecretKey: data.amazon_secret_key || "",
        amazonRegion: data.amazon_region || "",
        updatedAt: data.updated_at || null,
      }
    : {
        enabledMarketplaces: [],
        wooUrl: "",
        wooKey: "",
        wooSecret: "",
        etsyBearer: "",
        etsyRefreshToken: "",
        etsyTokenExpiresAt: "",
        etsyKeystring: "",
        etsyShopName: "",
        etsySkumapJson: "{}",
        amazonSellerId: "",
        amazonAccessKey: "",
        amazonSecretKey: "",
        amazonRegion: "",
        updatedAt: null,
      };

  return NextResponse.json({ config });
}

export async function POST(req: Request) {
  const auth = await resolveRequestAuth(req);
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as ConfigPayload;
  const storeId = (body.storeId || "").trim();
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });

  const hasAccess = await verifyMembership(auth.supabaseAdmin, storeId, auth.userId);
  if (!hasAccess) return NextResponse.json({ error: "Store access denied" }, { status: 403 });

  const parsedSkuMapText = typeof body.etsySkumapJson === "string" ? body.etsySkumapJson.trim() : "";
  let parsedSkuMap: Record<string, unknown> = {};
  if (parsedSkuMapText) {
    try {
      parsedSkuMap = JSON.parse(parsedSkuMapText) as Record<string, unknown>;
      if (typeof parsedSkuMap !== "object" || Array.isArray(parsedSkuMap) || parsedSkuMap === null) {
        return NextResponse.json({ error: "ETSY sku map JSON must be an object." }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid ETSY sku map JSON." }, { status: 400 });
    }
  }

  const payload = {
    store_id: storeId,
    enabled_marketplaces: Array.isArray(body.enabledMarketplaces) ? body.enabledMarketplaces : [],
    woo_url: normalizeOptional(body.wooUrl),
    woo_key: normalizeOptional(body.wooKey),
    woo_secret: normalizeOptional(body.wooSecret),
    etsy_bearer: normalizeOptional(body.etsyBearer),
    etsy_refresh_token: normalizeOptional(body.etsyRefreshToken),
    etsy_token_expires_at: normalizeOptional(body.etsyTokenExpiresAt),
    etsy_keystring: normalizeOptional(body.etsyKeystring),
    etsy_shop_name: normalizeOptional(body.etsyShopName),
    etsy_skumap_json: parsedSkuMap,
    amazon_seller_id: normalizeOptional(body.amazonSellerId),
    amazon_access_key: normalizeOptional(body.amazonAccessKey),
    amazon_secret_key: normalizeOptional(body.amazonSecretKey),
    amazon_region: normalizeOptional(body.amazonRegion),
    updated_at: new Date().toISOString(),
  };

  const { error } = await auth.supabaseAdmin.from("store_integrations").upsert(payload as any, { onConflict: "store_id" });
  if (error?.message.includes("Could not find the table 'public.store_integrations'")) {
    return NextResponse.json(
      { error: "Missing DB table: public.store_integrations. Run sql/store_integrations.sql in Supabase SQL Editor." },
      { status: 400 },
    );
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
