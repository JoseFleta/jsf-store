import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }

  const { name } = await req.json();
  const storeName = (name || "").toString().trim();
  if (!storeName) {
    return NextResponse.json({ error: "Missing store name" }, { status: 400 });
  }

  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // validar token y obtener user
  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userRes?.user) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  // crear store
  const { data: store, error: storeErr } = await supabaseAdmin
    .from("stores")
    .insert({ name: storeName })
    .select("id,name,created_at")
    .single();

  if (storeErr) {
    return NextResponse.json({ error: storeErr.message }, { status: 400 });
  }

  // crear membership owner
  const { error: memErr } = await supabaseAdmin.from("store_memberships").insert({
    store_id: store.id,
    user_id: userRes.user.id,
    role: "owner",
  });

  if (memErr) {
    return NextResponse.json({ error: memErr.message }, { status: 400 });
  }

  return NextResponse.json({ store });
}
