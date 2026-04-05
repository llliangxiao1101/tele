# Dual Platform Dialog Server (Web + Telegram)

## 1) Setup

1. Copy `.env.example` to `.env` and fill real values.
2. Ensure `public.app_chat_messages` already exists in your project.
3. Run SQL in `sql/supabase_schema.sql` on Supabase SQL editor.
it only does:
- add `platform` column to `app_chat_messages` (default `'web'`)
- create/keep `kv` table
4. Install dependencies:

```bash
npm install
```

5. Start:

```bash
npm start
```

## 2) Telegram pre-check

1. Use `@BotFather` to create bot and get `TELEGRAM_BOT_TOKEN`.
2. In Telegram, open your bot and send `/start` once.
3. Get your Telegram numeric chat id, fill `TG_ALLOWED_CHAT_ID`.
4. Start server and watch logs for `[poller] started`.
5. Optional mini app panel:
  - deploy your server to an HTTPS URL
  - set `TG_MINIAPP_URL=https://your-domain/miniapp`
  - restart server, then bot menu will expose mini app settings button

## 3) Behavior in test phase

- Telegram:
  - Immediate reply is ON by default (`kv.tg_immediate_reply_enabled = true`)
  - Proactive wake-up loop is also ON by default (`PROACTIVE_ENABLED=true`)
  - `chat_id / message_id / update_id` are saved in `app_chat_messages.metadata_json`
  - Runtime config can be changed in Telegram chat directly:
    - `/cfg`
    - `/panel` (open mini app URL)
    - `/set_model <model>`
    - `/set_base <openai_compatible_base_url>`
    - `/set_key <api_key>`
    - `/set_prompt <text>`
    - `/set_immediate on|off`
- Web:
  - Real-time only, no proactive message.
  - default `platform='web'`

## 4) Future switch

To disable Telegram immediate reply and keep storage-only + proactive mode:

```sql
update public.kv
set value = 'false'::jsonb, updated_at = now()
where key = 'tg_immediate_reply_enabled';
```
