-- Tambah kolom system_prompt per nomor. Konsep "role global" di tab Role AI
-- diretire — setiap nomor punya persona-nya sendiri.
ALTER TABLE "whitelisted_numbers" ADD COLUMN "system_prompt" TEXT;

-- Migrate: salin systemPrompt dari role yang sebelumnya di-link via role_id
UPDATE "whitelisted_numbers" w
SET system_prompt = r.system_prompt
FROM "ai_roles" r
WHERE w.role_id = r.id;
