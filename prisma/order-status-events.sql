create table if not exists order_status_events (
  id text primary key,
  shop text not null,
  shopify_order_id text not null,
  from_status text,
  to_status text not null,
  actor text not null,
  occurred_at timestamptz not null,
  portrait_version_id text,
  modification_request_id text,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists order_status_events_order_idx
  on order_status_events (shop, shopify_order_id, occurred_at);

grant select, insert, update, delete
on public.order_status_events
to service_role;
