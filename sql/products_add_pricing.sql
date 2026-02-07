alter table public.products
  add column if not exists base_price numeric(12,2) not null default 0,
  add column if not exists woo_price numeric(12,2),
  add column if not exists etsy_price numeric(12,2);

