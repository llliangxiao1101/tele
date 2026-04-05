alter table if exists public.app_chat_messages
add column if not exists platform text not null default 'web';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'app_chat_messages_platform_check'
  ) then
    alter table public.app_chat_messages
    add constraint app_chat_messages_platform_check
    check (platform in ('web', 'telegram'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.app_chat_messages') is not null then
    execute 'create index if not exists idx_app_chat_messages_platform_created on public.app_chat_messages (platform, created_at desc)';
  end if;
end $$;

create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

comment on column public.app_chat_messages.platform is 'Message source platform: web or telegram';
comment on table public.kv is 'Simple key-value state for poller and proactive scheduler';
