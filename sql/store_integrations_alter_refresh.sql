alter table if exists public.store_integrations
  add column if not exists etsy_refresh_token text;

alter table if exists public.store_integrations
  add column if not exists etsy_token_expires_at text;

alter table if exists public.store_integrations
  add column if not exists enabled_marketplaces jsonb not null default '[]'::jsonb;

alter table if exists public.store_integrations
  add column if not exists amazon_seller_id text;

alter table if exists public.store_integrations
  add column if not exists amazon_access_key text;

alter table if exists public.store_integrations
  add column if not exists amazon_secret_key text;

alter table if exists public.store_integrations
  add column if not exists amazon_region text;
