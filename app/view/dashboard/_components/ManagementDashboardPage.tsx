
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { supabaseBrowser } from "../../../../lib/supabaseBrowser";

type G = "daily" | "weekly" | "monthly";
type Sale = { id: string; product_id: string; quantity: number; unit_price: number; occurred_on: string; channel: string | null; products: { title?: string | null; name?: string | null } | { title?: string | null; name?: string | null }[] | null };
type Point = { key: string; label: string; revenue: number; units: number };

const toDate = (v: string) => new Date(`${v}T00:00:00`);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const wkStart = (d: Date) => { const n = new Date(d); const k = n.getDay() === 0 ? -6 : 1 - n.getDay(); n.setDate(n.getDate() + k); n.setHours(0,0,0,0); return n; };
const addDays = (d: Date, x: number) => { const n = new Date(d); n.setDate(n.getDate() + x); return n; };
const addMonths = (d: Date, x: number) => { const n = new Date(d); n.setMonth(n.getMonth() + x); return n; };
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthVal = (k: string) => { const [y,m] = k.split("-").map(Number); return y * 12 + m; };
const monthLabel = (k: string) => { const [y,m] = k.split("-").map(Number); return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(new Date(y, m - 1, 1)); };
const eur = (v: number) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v || 0);
const compact = (v: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v || 0);

function buildTrend(rows: Sale[], g: G): Point[] {
  const map = new Map<string, Point>();
  if (!rows.length) return [];
  rows.forEach((r) => {
    const d = toDate(r.occurred_on);
    const k = g === "daily" ? dayKey(d) : g === "weekly" ? dayKey(wkStart(d)) : monthKey(d);
    const l = g === "daily" ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(d)
      : g === "weekly" ? `Wk ${new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(wkStart(d))}`
      : new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit" }).format(new Date(d.getFullYear(), d.getMonth(), 1));
    const p = map.get(k) || { key: k, label: l, revenue: 0, units: 0 };
    p.revenue += Number(r.unit_price || 0);
    p.units += Number(r.quantity || 0);
    map.set(k, p);
  });
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export default function ManagementDashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const storeId = searchParams.get("store") || "";

  const [rows, setRows] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [g, setG] = useState<G>("weekly");
  const [hover, setHover] = useState<string | null>(null);

  const [dayRange, setDayRange] = useState<DateRange | undefined>();
  const [weekRange, setWeekRange] = useState<DateRange | undefined>();
  const [monthRange, setMonthRange] = useState<{ from?: string; to?: string }>({});
  const [monthYear, setMonthYear] = useState(new Date().getFullYear());
  const [openCal, setOpenCal] = useState(false);
  const [openMonth, setOpenMonth] = useState(false);
  const filterPopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      setLoading(true); setMsg("");
      const { data: u } = await supabase.auth.getUser();
      if (dead) return;
      if (!u.user) { router.push("/view/login"); return; }
      if (!storeId) { setRows([]); setLoading(false); return; }
      const { data, error } = await supabase
        .from("stock_movements")
        .select("id,product_id,quantity,unit_price,occurred_on,channel,products(title,name)")
        .eq("store_id", storeId)
        .eq("movement_type", "sale")
        .order("occurred_on", { ascending: true });
      if (dead) return;
      if (error) { setMsg(error.message); setRows([]); setLoading(false); return; }
      setRows((data || []) as Sale[]); setLoading(false);
    })();
    return () => { dead = true; };
  }, [router, storeId, supabase]);

  const trend = useMemo(() => buildTrend(rows, g), [rows, g]);

  useEffect(() => {
    if (!trend.length) return;
    if (g === "daily" && !dayRange?.from && !dayRange?.to) setDayRange({ from: toDate(trend[0].key), to: toDate(trend[trend.length - 1].key) });
    if (g === "weekly" && !weekRange?.from && !weekRange?.to) setWeekRange({ from: toDate(trend[0].key), to: addDays(toDate(trend[trend.length - 1].key), 6) });
    if (g === "monthly" && !monthRange.from && !monthRange.to) setMonthRange({ from: trend[0].key, to: trend[trend.length - 1].key });
  }, [trend, g, dayRange, weekRange, monthRange.from, monthRange.to]);

  useEffect(() => {
    if (!openCal && !openMonth) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = filterPopoverRef.current;
      if (!node) return;
      if (event.target instanceof Node && !node.contains(event.target)) {
        setOpenCal(false);
        setOpenMonth(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openCal, openMonth]);

  const shown = useMemo(() => {
    if (g === "daily") {
      const a = dayRange?.from?.getTime() ?? -Infinity; const b = dayRange?.to?.getTime() ?? Infinity;
      return trend.filter((p) => { const t = toDate(p.key).getTime(); return t >= a && t <= b; });
    }
    if (g === "weekly") {
      const a = weekRange?.from?.getTime() ?? -Infinity; const b = weekRange?.to?.getTime() ?? Infinity;
      return trend.filter((p) => { const t = toDate(p.key).getTime(); return t >= a && t <= b; });
    }
    const a = monthRange.from ? monthVal(monthRange.from) : -Infinity; const b = monthRange.to ? monthVal(monthRange.to) : Infinity;
    return trend.filter((p) => { const t = monthVal(p.key); return t >= a && t <= b; });
  }, [trend, g, dayRange, weekRange, monthRange]);

  const summary = useMemo(() => {
    const now = new Date(); now.setHours(0,0,0,0);
    const stW = wkStart(now); const stM = new Date(now.getFullYear(), now.getMonth(), 1);
    let total = 0, units = 0, today = 0, week = 0, month = 0;
    rows.forEach((r) => { const d = toDate(r.occurred_on); const rev = Number(r.unit_price || 0); const q = Number(r.quantity || 0); total += rev; units += q; if (d.getTime() === now.getTime()) today += rev; if (d >= stW) week += rev; if (d >= stM) month += rev; });
    const prevW = rows.reduce((s, r) => { const d = toDate(r.occurred_on); return d >= addDays(stW,-7) && d <= addDays(stW,-1) ? s + Number(r.unit_price || 0) : s; }, 0);
    const prevM = rows.reduce((s, r) => { const d = toDate(r.occurred_on); const a = new Date(stM.getFullYear(), stM.getMonth()-1, 1); const b = new Date(stM.getFullYear(), stM.getMonth(), 0); return d >= a && d <= b ? s + Number(r.unit_price || 0) : s; }, 0);
    const pct = (c: number, p: number) => p <= 0 ? (c <= 0 ? "0%" : "+100%") : `${c-p >= 0 ? "+" : ""}${(((c-p)/p)*100).toFixed(1)}%`;
    return { total, units, today, week, month, wp: pct(week, prevW), mp: pct(month, prevM) };
  }, [rows]);

  const filteredSalesRows = useMemo(() => {
    if (g === "daily") {
      const a = dayRange?.from?.getTime() ?? -Infinity;
      const b = dayRange?.to?.getTime() ?? Infinity;
      return rows.filter((r) => {
        const t = toDate(r.occurred_on).getTime();
        return t >= a && t <= b;
      });
    }
    if (g === "weekly") {
      const a = weekRange?.from?.getTime() ?? -Infinity;
      const b = weekRange?.to?.getTime() ?? Infinity;
      return rows.filter((r) => {
        const t = toDate(r.occurred_on).getTime();
        return t >= a && t <= b;
      });
    }
    const a = monthRange.from ? monthVal(monthRange.from) : -Infinity;
    const b = monthRange.to ? monthVal(monthRange.to) : Infinity;
    return rows.filter((r) => {
      const t = monthVal(monthKey(toDate(r.occurred_on)));
      return t >= a && t <= b;
    });
  }, [rows, g, dayRange, weekRange, monthRange]);

  const topProducts = useMemo(() => {
    const m = new Map<string, { name: string; units: number; revenue: number }>();
    filteredSalesRows.forEach((r) => {
      const p = Array.isArray(r.products) ? r.products[0] : r.products;
      const cur = m.get(r.product_id) || { name: p?.title || p?.name || "Unknown product", units: 0, revenue: 0 };
      cur.units += Number(r.quantity || 0); cur.revenue += Number(r.unit_price || 0); m.set(r.product_id, cur);
    });
    return Array.from(m.values()).sort((a,b)=>b.units-a.units).slice(0,8);
  }, [filteredSalesRows]);

  const channels = useMemo(() => {
    const m = new Map<string, number>();
    filteredSalesRows.forEach((r) => { const k = (r.channel || "Direct").trim() || "Direct"; m.set(k, (m.get(k) || 0) + Number(r.unit_price || 0)); });
    return Array.from(m.entries()).map(([channel,revenue])=>({channel,revenue})).sort((a,b)=>b.revenue-a.revenue).slice(0,5);
  }, [filteredSalesRows]);

  const maxRev = Math.max(1, ...shown.map((p) => p.revenue));
  const maxUnits = Math.max(1, ...shown.map((p) => p.units));
  const hovered = shown.find((p) => p.key === hover) || null;
  const w = 920, h = 300, x0 = 50, x1 = 900, y0 = 18, y1 = 260, pw = x1 - x0, ph = y1 - y0;
  const step = shown.length <= 1 ? 0 : pw / (shown.length - 1);
  const line = shown.map((p, i) => `${i === 0 ? "M" : "L"} ${(x0 + (shown.length <= 1 ? pw / 2 : i * step)).toFixed(1)} ${(y1 - (p.units / maxUnits) * ph).toFixed(1)}`).join(" ");

  const dayLbl = !dayRange?.from && !dayRange?.to ? "Select date range" : `${new Intl.DateTimeFormat("en-GB").format(dayRange?.from || new Date())}${dayRange?.to ? ` - ${new Intl.DateTimeFormat("en-GB").format(dayRange.to)}` : " - ..."}`;
  const weekLbl = !weekRange?.from && !weekRange?.to ? "Select week range" : `${new Intl.DateTimeFormat("en-GB").format(weekRange?.from || new Date())}${weekRange?.to ? ` - ${new Intl.DateTimeFormat("en-GB").format(weekRange.to)}` : " - ..."}`;
  const monthLbl = !monthRange.from && !monthRange.to ? "Select month range" : `${monthRange.from ? monthLabel(monthRange.from) : "..."}${monthRange.to ? ` - ${monthLabel(monthRange.to)}` : " - ..."}`;
  const activeModeLabel = g === "daily" ? "Daily" : g === "weekly" ? "Weekly" : "Monthly";
  const hasActiveFilter = g === "daily" ? Boolean(dayRange?.from || dayRange?.to) : g === "weekly" ? Boolean(weekRange?.from || weekRange?.to) : Boolean(monthRange.from || monthRange.to);

  if (loading) return <p className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading dashboard...</p>;

  return (
    <section className="space-y-6">
      <header className="relative overflow-hidden rounded-[28px] border border-cyan-200 bg-gradient-to-br from-cyan-100 via-white to-amber-100 p-6 shadow-sm">
        <div className="absolute -right-14 -top-16 h-40 w-40 rounded-full bg-cyan-300/30 blur-2xl" />
        <div className="absolute -bottom-14 left-20 h-36 w-36 rounded-full bg-amber-300/30 blur-2xl" />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-800">Management Dashboard</p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">Sales pulse, product winners, growth signals</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">Live sales analytics with calendar-based range controls.</p>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-4">
        <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs uppercase tracking-wide text-slate-500">Revenue Today</p><p className="mt-2 text-2xl font-semibold text-slate-900">{eur(summary.today)}</p></article>
        <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs uppercase tracking-wide text-slate-500">Revenue This Week</p><p className="mt-2 text-2xl font-semibold text-slate-900">{eur(summary.week)}</p><p className="mt-1 text-xs text-slate-500">vs last week: {summary.wp}</p></article>
        <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs uppercase tracking-wide text-slate-500">Revenue This Month</p><p className="mt-2 text-2xl font-semibold text-slate-900">{eur(summary.month)}</p><p className="mt-1 text-xs text-slate-500">vs last month: {summary.mp}</p></article>
        <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs uppercase tracking-wide text-slate-500">All-time Sales</p><p className="mt-2 text-2xl font-semibold text-slate-900">{eur(summary.total)}</p><p className="mt-1 text-xs text-slate-500">{compact(summary.units)} units sold</p></article>
      </section>

            <section className="rounded-3xl border border-cyan-200 bg-gradient-to-br from-cyan-50 via-white to-sky-50 p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-800">Shared Date Filter</p><span className="rounded-full border border-cyan-300 bg-cyan-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-900">{activeModeLabel} filter active</span></div>
        <div className="mt-3 flex w-fit rounded-full border border-slate-200 bg-white p-1">{(["daily","weekly","monthly"] as G[]).map((x)=><button key={x} type="button" onClick={()=>{setG(x);setOpenCal(false);setOpenMonth(false);}} className={x===g?"rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white":"rounded-full px-3 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900"}>{x}</button>)}</div>
        <div ref={filterPopoverRef} className="relative mt-3 max-w-md">
          {g !== "monthly" ? (<><button type="button" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 pr-10 text-left text-sm text-slate-700" onClick={()=>setOpenCal((p)=>!p)}>{g==="daily"?dayLbl:weekLbl}</button>{hasActiveFilter && <button type="button" aria-label="Clear date filter" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-semibold leading-none text-slate-500 hover:text-slate-700" onClick={(e)=>{e.preventDefault();e.stopPropagation();setDayRange(undefined);setWeekRange(undefined);setMonthRange({});setOpenCal(false);setOpenMonth(false);}}>x</button>}{openCal && <div className="absolute z-20 mt-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">{g==="daily" ? <DayPicker mode="range" numberOfMonths={1} className="text-sm" selected={dayRange} onSelect={(r,s)=>{if(!s)return; if(dayRange?.from&&dayRange?.to){setDayRange({from:s,to:undefined});return;} setDayRange(r); if(r?.from&&r?.to) setOpenCal(false);}}/> : <DayPicker mode="single" numberOfMonths={1} className="text-sm" showWeekNumber disabled={{ dayOfWeek: [0, 2, 3, 4, 5, 6] }} modifiersStyles={{ disabled: { opacity: 0.35, color: "#94a3b8" } }} selected={weekRange?.from ? wkStart(weekRange.from) : undefined} onSelect={(d)=>{if(!d)return; const picked=wkStart(d); if(!weekRange?.from||weekRange?.to){setWeekRange({from:picked,to:undefined});return;} const first=wkStart(weekRange.from); if(picked.getTime()<first.getTime()){setWeekRange({from:picked,to:undefined});return;} setWeekRange({from:first,to:addDays(picked,6)}); setOpenCal(false);}}/>}<div className="mt-2 flex justify-between"><button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700" onClick={()=>g==="daily"?setDayRange(undefined):setWeekRange(undefined)}>Clear</button><button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700" onClick={()=>setOpenCal(false)}>Close</button></div></div>}</>) : (<><button type="button" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 pr-10 text-left text-sm text-slate-700" onClick={()=>setOpenMonth((p)=>!p)}>{monthLbl}</button>{hasActiveFilter && <button type="button" aria-label="Clear date filter" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-semibold leading-none text-slate-500 hover:text-slate-700" onClick={(e)=>{e.preventDefault();e.stopPropagation();setDayRange(undefined);setWeekRange(undefined);setMonthRange({});setOpenCal(false);setOpenMonth(false);}}>x</button>}{openMonth && <div className="absolute z-20 mt-2 w-full rounded-2xl border border-slate-200 bg-white p-3 shadow-xl"><div className="mb-3 flex items-center justify-between"><button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700" onClick={()=>setMonthYear((y)=>y-1)}>Prev year</button><p className="text-sm font-semibold text-slate-800">{monthYear}</p><button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700" onClick={()=>setMonthYear((y)=>y+1)}>Next year</button></div><div className="grid grid-cols-3 gap-2">{["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((m,i)=>{const k=`${monthYear}-${String(i+1).padStart(2,"0")}`; const f=monthRange.from||""; const t=monthRange.to||""; const inR=f&&t&&monthVal(k)>=monthVal(f)&&monthVal(k)<=monthVal(t); const edge=k===f||k===t; return <button key={k} type="button" className={edge?"rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white":inR?"rounded-xl bg-slate-200 px-3 py-2 text-xs font-semibold text-slate-800":"rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"} onClick={()=>{if(!monthRange.from||(monthRange.from&&monthRange.to)){setMonthRange({from:k,to:undefined});return;} if(monthVal(k)<monthVal(monthRange.from)){setMonthRange({from:k,to:undefined});return;} setMonthRange({from:monthRange.from,to:k});setOpenMonth(false);}}>{m}</button>;})}</div><div className="mt-3 flex justify-between"><button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700" onClick={()=>setMonthRange({})}>Clear</button><button type="button" className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700" onClick={()=>setOpenMonth(false)}>Close</button></div></div>}</>) }
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-slate-900">Trend Explorer</h2><p className="mt-1 text-sm text-slate-500">Bars: revenue. Line: products sold. Hover for exact values.</p></div><span className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-800">{activeModeLabel} filter active</span></div><div className="relative mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-3">{hovered && <div className="absolute left-4 top-4 z-10 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow"><p className="font-semibold text-slate-800">{hovered.label}</p><p className="text-slate-600">Revenue: {eur(hovered.revenue)}</p><p className="text-slate-600">Units: {hovered.units.toFixed(0)}</p></div>}<svg viewBox={`0 0 ${w} ${h}`} className="h-[320px] w-full" onMouseLeave={()=>setHover(null)}>{[0,1,2,3,4].map((i)=><line key={i} x1={x0} y1={y0+(ph*i)/4} x2={x1} y2={y0+(ph*i)/4} stroke="#e2e8f0" strokeWidth="1"/>)}{shown.map((p,i)=>{const x=x0+(shown.length<=1?pw/2:i*step); const bw=Math.max(12,Math.min(38,pw/Math.max(3,shown.length)-6)); const bh=(p.revenue/maxRev)*ph; return <rect key={p.key} x={x-bw/2} y={y1-bh} width={bw} height={Math.max(2,bh)} rx="6" fill={hover===p.key?"#0ea5e9":"#22c55e"} opacity={hover===p.key?0.9:0.75}/>;})}{line && <path d={line} fill="none" stroke="#1d4ed8" strokeWidth="3" strokeLinecap="round"/>}{shown.map((p,i)=>{const x=x0+(shown.length<=1?pw/2:i*step); const y=y1-(p.units/maxUnits)*ph; return <circle key={`d-${p.key}`} cx={x} cy={y} r={hover===p.key?5:4} fill="#1d4ed8"/>;})}{shown.map((p,i)=>{if(i%Math.max(1,Math.ceil(shown.length/10))!==0&&i!==shown.length-1)return null; const x=x0+(shown.length<=1?pw/2:i*step); return <text key={`l-${p.key}`} x={x} y={288} textAnchor="middle" fontSize="11" fill="#64748b">{p.label}</text>;})}{shown.map((p,i)=>{const l=i===0?x0:x0+(shown.length<=1?0:(i-0.5)*step); const r=i===shown.length-1?x1:x0+(shown.length<=1?pw:(i+0.5)*step); return <rect key={`h-${p.key}`} x={l} y={y0} width={Math.max(8,r-l)} height={ph} fill="transparent" onMouseEnter={()=>setHover(p.key)}/>;})}</svg></div>
        </article>

        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold text-slate-900">Channel Breakdown</h2><span className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-800">{activeModeLabel} filter active</span></div><p className="mt-1 text-sm text-slate-500">Top sales channels by revenue.</p><div className="mt-4 space-y-3">{channels.length===0?<p className="text-sm text-slate-500">No sales data yet.</p>:channels.map((it)=><div key={it.channel} className="rounded-2xl border border-slate-100 bg-slate-50 p-3"><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold text-slate-800">{it.channel}</p><p className="text-sm font-semibold text-slate-900">{eur(it.revenue)}</p></div></div>)}</div></article>
      </section>

      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold text-slate-900">Most Sold Products</h2><span className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-800">{activeModeLabel} filter active</span></div><p className="mt-1 text-sm text-slate-500">Best performers ranked by units sold.</p>{topProducts.length===0?<p className="mt-4 text-sm text-slate-500">No product sales yet.</p>:<div className="mt-4 grid gap-3 md:grid-cols-2">{topProducts.map((it,i)=><div key={`${it.name}-${i}`} className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-slate-500">#{i+1}</p><p className="mt-1 text-sm font-semibold text-slate-900">{it.name}</p></div><div className="text-right"><p className="text-sm font-semibold text-slate-900">{it.units.toFixed(0)} units</p><p className="text-xs text-slate-500">{eur(it.revenue)}</p></div></div></div>)}</div>}</article>

      {msg && <p className="text-sm text-rose-600">{msg}</p>}
    </section>
  );
}






