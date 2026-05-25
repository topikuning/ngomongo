-- Tabel prompt template yang bisa diedit admin dari dashboard.
-- Default content di-seed di kode saat startup kalau key belum ada.
CREATE TABLE "prompt_templates" (
  "id"          SERIAL  NOT NULL,
  "key"         TEXT    NOT NULL,
  "label"       TEXT    NOT NULL,
  "description" TEXT    NOT NULL,
  "content"     TEXT    NOT NULL,
  "is_custom"   BOOLEAN NOT NULL DEFAULT false,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prompt_templates_key_key" ON "prompt_templates"("key");
