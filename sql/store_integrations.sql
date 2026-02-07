create table if not exists public.store_integrations (
  store_id uuid primary key references public.stores(id) on delete cascade,
  enabled_marketplaces jsonb not null default '[]'::jsonb,
  woo_url text,
  woo_key text,
  woo_secret text,
  etsy_bearer text,
  etsy_refresh_token text,
  etsy_token_expires_at text,
  etsy_keystring text,
  etsy_shop_name text,
  etsy_skumap_json jsonb not null default '{}'::jsonb,
  amazon_seller_id text,
  amazon_access_key text,
  amazon_secret_key text,
  amazon_region text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_store_integrations_store_id on public.store_integrations(store_id);
