# JSF Store

Inventory and marketplace management app for the JSF Labs product line.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Create local env file:

```bash
cp .env.example .env.local
```

3. Run the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Domain Setup for jsflabs.com

Recommended setup for multiple products:

- `www.jsflabs.com` -> product hub / company site
- `store.jsflabs.com` -> this JSF Store app
- `rest.jsflabs.com` -> JSF Rest app (separate project)

### DNS Records

Create these records in your DNS provider:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | `store` | `cname.vercel-dns.com` |
| CNAME | `rest` | `cname.vercel-dns.com` |
| CNAME or ALIAS/ANAME | `www` | `cname.vercel-dns.com` |

Note: If your DNS provider does not support CNAME on apex/root (`@`), use ALIAS/ANAME or provider-specific root flattening.

### Vercel Project Configuration (this repo)

1. Import this repo into Vercel.
2. In `Settings -> Domains`, add `store.jsflabs.com`.
3. In `Settings -> Environment Variables`, set:

- `APP_BASE_URL=https://store.jsflabs.com`
- `NEXT_PUBLIC_APP_URL=https://store.jsflabs.com`
- Supabase keys from your project (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`)

4. Redeploy after saving env vars.

## Create Initial Product (JSF Store)

You have two options.

### Option A: From UI

1. Log in.
2. Go to `Dashboard -> Products`.
3. Click create product and use:

- SKU: `JSF-STORE-001`
- Title: `JSF Store Core Plan`
- Type: `accesorios`
- Base price: `49.00`

### Option B: SQL Seed

Run `sql/seed_jsf_store_product.sql` in Supabase SQL Editor.

Before running, replace `TARGET_STORE_ID` in that SQL file with your actual store UUID.

## Notes

- This app should be deployed on a subdomain (`store.jsflabs.com`) instead of a subpath (`jsflabs.com/store`) because the codebase uses root-relative API paths.
- WooCommerce callback URL uses `APP_BASE_URL` and must be HTTPS.