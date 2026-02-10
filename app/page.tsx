import Link from "next/link";
import { headers } from "next/headers";
import StoreHomeRedirect from "./_components/StoreHomeRedirect";

const HUB_HOSTS = new Set(["www.jsflabs.com", "jsflabs.com"]);

function normalizeHost(rawHost: string | null): string {
  const host = (rawHost || "").trim().toLowerCase();
  if (!host) return "";
  return host.split(":")[0];
}

export default async function Home() {
  const requestHeaders = await headers();
  const host = normalizeHost(requestHeaders.get("x-forwarded-host") || requestHeaders.get("host"));
  const isHubHost = HUB_HOSTS.has(host);

  if (!isHubHost) return <StoreHomeRedirect />;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-20">
        <div className="space-y-4">
          <p className="inline-flex rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
            JSF Labs
          </p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Product Hub</h1>
          <p className="max-w-2xl text-sm text-slate-300 sm:text-base">
            Choose a product to continue. Each product runs on its own subdomain and deployment.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Link
            href="https://store.jsflabs.com"
            className="rounded-2xl border border-cyan-700/60 bg-cyan-950/40 p-6 transition hover:border-cyan-500 hover:bg-cyan-900/40"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Live</p>
            <h2 className="mt-2 text-2xl font-semibold text-cyan-100">JSF Store</h2>
            <p className="mt-2 text-sm text-cyan-200/80">Inventory and marketplace operations platform.</p>
          </Link>

          <Link
            href="https://rest.jsflabs.com"
            className="rounded-2xl border border-violet-700/60 bg-violet-950/40 p-6 transition hover:border-violet-500 hover:bg-violet-900/40"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-300">Coming Soon</p>
            <h2 className="mt-2 text-2xl font-semibold text-violet-100">JSF Rest</h2>
            <p className="mt-2 text-sm text-violet-200/80">Restaurant-focused operations product.</p>
          </Link>
        </div>
      </section>
    </main>
  );
}