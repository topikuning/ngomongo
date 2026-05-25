-- Tambah kolom is_default ke ai_providers (default false)
ALTER TABLE "ai_providers" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

-- Migrate data: provider yang sebelumnya is_active=true otomatis jadi is_default=true
UPDATE "ai_providers" SET "is_default" = true WHERE "is_active" = true;

-- Hapus kolom is_active. Konsep "active" hilang — semua provider yang
-- tercatat di tabel ini selalu enabled. Yang membedakan hanyalah satu
-- provider yang ditandai is_default = true (dipakai untuk nomor yang
-- tidak mengoverride provider mereka sendiri).
ALTER TABLE "ai_providers" DROP COLUMN "is_active";

-- Tambah kolom provider_id ke whitelisted_numbers untuk override
-- per nomor. NULL artinya pakai provider default.
ALTER TABLE "whitelisted_numbers" ADD COLUMN "provider_id" INTEGER;

-- Foreign key (ON DELETE SET NULL supaya hapus provider tidak menghapus nomor)
ALTER TABLE "whitelisted_numbers" ADD CONSTRAINT "whitelisted_numbers_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
