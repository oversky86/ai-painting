-- One business write across supplier tables. Shopify calls stay outside.
create or replace function public.apply_supplier_transition(payload jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_order public.supplier_orders%rowtype;
  v_from text := payload->>'from_status';
  v_to text := payload->>'to_status';
  v_row_id text := payload->>'order_row_id';
  v_event_id text := payload->>'event_id';
  v_version_id text := nullif(payload->>'portrait_version_id', '');
  v_request_id text := nullif(payload->>'modification_request_id', '');
  v_note jsonb;
  v_index int := 0;
begin
  update public.supplier_orders
  set business_status = v_to,
      updated_at = now()
  where id = v_row_id
    and business_status = v_from
  returning * into v_order;

  if not found then
    return jsonb_build_object('ok', false);
  end if;

  delete from public.portrait_versions
  where id in (
    select value
    from jsonb_array_elements_text(coalesce(payload->'stale_version_ids', '[]'::jsonb))
  );

  delete from public.modification_requests
  where id in (
    select value
    from jsonb_array_elements_text(coalesce(payload->'stale_request_ids', '[]'::jsonb))
  );

  if payload ? 'portrait' and payload->'portrait' <> 'null'::jsonb then
    insert into public.portrait_versions (
      id, shop, shopify_order_id, version_number, image_path, video_path, created_at
    ) values (
      v_version_id,
      v_order.shop,
      v_order.shopify_order_id,
      (payload->'portrait'->>'version_number')::int,
      payload->'portrait'->>'image_path',
      nullif(payload->'portrait'->>'video_path', ''),
      now()
    );
  else
    v_version_id := null;
  end if;

  if payload ? 'modification' and payload->'modification' <> 'null'::jsonb then
    insert into public.modification_requests (
      id, shop, shopify_order_id, against_version, created_at
    ) values (
      v_request_id,
      v_order.shop,
      v_order.shopify_order_id,
      (payload->'modification'->>'against_version')::int,
      now()
    );
    for v_note in
      select value from jsonb_array_elements(coalesce(payload->'modification'->'notes', '[]'::jsonb))
    loop
      v_index := v_index + 1;
      insert into public.modification_notes (
        id, request_id, note_index, text, x, y, width, height
      ) values (
        payload->>'note_id_prefix' || v_index::text,
        v_request_id,
        v_index,
        left(v_note->>'text', 2000),
        (v_note->'selection'->>'x')::numeric,
        (v_note->'selection'->>'y')::numeric,
        (v_note->'selection'->>'width')::numeric,
        (v_note->'selection'->>'height')::numeric
      );
    end loop;
  else
    v_request_id := null;
  end if;

  insert into public.order_status_events (
    id, shop, shopify_order_id, from_status, to_status, actor, occurred_at,
    portrait_version_id, modification_request_id, detail
  ) values (
    v_event_id,
    v_order.shop,
    v_order.shopify_order_id,
    v_from,
    v_to,
    payload->>'actor',
    coalesce((payload->>'occurred_at')::timestamptz, now()),
    v_version_id,
    v_request_id,
    coalesce(payload->'detail', '{}'::jsonb)
  );

  return jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'portrait_version_id', v_version_id,
    'modification_request_id', v_request_id,
    'order', to_jsonb(v_order)
  );
end;
$$;

create or replace function public.revert_supplier_transition(payload jsonb)
returns void
language plpgsql
as $$
begin
  update public.supplier_orders
  set business_status = payload->>'from_status',
      updated_at = now()
  where id = payload->>'order_row_id'
    and business_status = payload->>'to_status';

  if nullif(payload->>'portrait_version_id', '') is not null then
    delete from public.portrait_versions
    where id = payload->>'portrait_version_id';
  end if;

  if nullif(payload->>'modification_request_id', '') is not null then
    delete from public.modification_requests
    where id = payload->>'modification_request_id';
  end if;

  if nullif(payload->>'event_id', '') is not null then
    delete from public.order_status_events
    where id = payload->>'event_id';
  end if;
end;
$$;

create or replace function public.ensure_status_trail(payload jsonb)
returns void
language plpgsql
as $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.order_status_events
  where shop = payload->>'shop'
    and shopify_order_id = payload->>'shopify_order_id';
  if v_count > 0 then
    return;
  end if;

  insert into public.order_status_events (
    id, shop, shopify_order_id, from_status, to_status, actor, occurred_at, detail
  ) values (
    payload->>'placed_event_id',
    payload->>'shop',
    payload->>'shopify_order_id',
    null,
    'order_placed',
    'system',
    coalesce((payload->>'placed_at')::timestamptz, now()),
    '{"backfill": true}'::jsonb
  );

  if payload->>'current_status' is distinct from 'order_placed' then
    insert into public.order_status_events (
      id, shop, shopify_order_id, from_status, to_status, actor, occurred_at, detail
    ) values (
      payload->>'current_event_id',
      payload->>'shop',
      payload->>'shopify_order_id',
      null,
      payload->>'current_status',
      'system',
      coalesce((payload->>'updated_at')::timestamptz, (payload->>'placed_at')::timestamptz, now()),
      '{"backfill": true, "gap": true}'::jsonb
    );
  end if;
end;
$$;

create or replace function public.record_order_placed(payload jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.supplier_orders (
    id, shop, shopify_order_id, order_name, customer_email, business_status,
    version_count, modification_count, placed_at, updated_at
  ) values (
    payload->>'order_row_id',
    payload->>'shop',
    payload->>'shopify_order_id',
    coalesce(payload->>'order_name', '#' || (payload->>'shopify_order_id')),
    nullif(payload->>'customer_email', ''),
    coalesce(payload->>'business_status', 'order_placed'),
    0,
    0,
    coalesce((payload->>'placed_at')::timestamptz, now()),
    now()
  )
  on conflict (shop, shopify_order_id) do update
  set order_name = excluded.order_name,
      customer_email = coalesce(excluded.customer_email, public.supplier_orders.customer_email);

  if payload->>'skip_event' = 'true' then
    return;
  end if;

  if exists (
    select 1 from public.order_status_events
    where shop = payload->>'shop'
      and shopify_order_id = payload->>'shopify_order_id'
      and to_status = 'order_placed'
  ) then
    return;
  end if;

  insert into public.order_status_events (
    id, shop, shopify_order_id, from_status, to_status, actor, occurred_at, detail
  ) values (
    payload->>'event_id',
    payload->>'shop',
    payload->>'shopify_order_id',
    null,
    'order_placed',
    'system',
    coalesce((payload->>'placed_at')::timestamptz, now()),
    coalesce(payload->'detail', '{}'::jsonb)
  );
end;
$$;

revoke all on function public.apply_supplier_transition(jsonb) from public;
revoke all on function public.revert_supplier_transition(jsonb) from public;
revoke all on function public.ensure_status_trail(jsonb) from public;
revoke all on function public.record_order_placed(jsonb) from public;

grant execute on function public.apply_supplier_transition(jsonb) to service_role;
grant execute on function public.revert_supplier_transition(jsonb) to service_role;
grant execute on function public.ensure_status_trail(jsonb) to service_role;
grant execute on function public.record_order_placed(jsonb) to service_role;
