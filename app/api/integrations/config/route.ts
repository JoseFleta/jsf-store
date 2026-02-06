import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type ConfigPayload = {
  storeId?: string;
  wooUrl?: string;
  wooKey?: string;
  wooSecret?: string;
  etsyBearer?: string;
  etsyKeystring?: string;
  etsyShopName?: string;
  etsySkumapJson?: string;
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
    .select("woo_url,woo_key,woo_secret,etsy_bearer,etsy_keystring,etsy_shop_name,etsy_skumap_json,updated_at")
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
        wooKey: data.woo_key || "",
        wooSecret: data.woo_secret || "",
        etsyBearer: data.etsy_bearer || "",
        etsyKeystring: data.etsy_keystring || "",
        etsyShopName: data.etsy_shop_name || "",
        etsySkumapJson: data.etsy_skumap_json ? JSON.stringify(data.etsy_skumap_json, null, 2) : "{}",
        updatedAt: data.updated_at || null,
      }
    : {
        wooUrl: "",
        wooKey: "",
        wooSecret: "",
        etsyBearer: "",
        etsyKeystring: "",
        etsyShopName: "",
        etsySkumapJson: "{}",
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
    woo_url: normalizeOptional(body.wooUrl),
    woo_key: normalizeOptional(body.wooKey),
    woo_secret: normalizeOptional(body.wooSecret),
    etsy_bearer: normalizeOptional(body.etsyBearer),
    etsy_keystring: normalizeOptional(body.etsyKeystring),
    etsy_shop_name: normalizeOptional(body.etsyShopName),
    etsy_skumap_json: parsedSkuMap,
    updated_at: new Date().toISOString(),
  };

  const { error } = await auth.supabaseAdmin.from("store_integrations").upsert(payload, { onConflict: "store_id" });
  if (error?.message.includes("Could not find the table 'public.store_integrations'")) {
    return NextResponse.json(
      { error: "Missing DB table: public.store_integrations. Run sql/store_integrations.sql in Supabase SQL Editor." },
      { status: 400 },
    );
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
