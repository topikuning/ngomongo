-- CreateTable
CREATE TABLE "ai_providers" (
    "id" SERIAL NOT NULL,
    "nama" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_roles" (
    "id" SERIAL NOT NULL,
    "nama" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whitelisted_numbers" (
    "id" SERIAL NOT NULL,
    "wa_number" TEXT NOT NULL,
    "display_name" TEXT,
    "initial_context" TEXT,
    "initial_summary_ready" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "role_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whitelisted_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "wa_number" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_logs" (
    "id" SERIAL NOT NULL,
    "wa_number" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_snapshots" (
    "id" SERIAL NOT NULL,
    "wa_number" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "is_initial" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whitelisted_numbers_wa_number_key" ON "whitelisted_numbers"("wa_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_wa_number_key" ON "users"("wa_number");

-- CreateIndex
CREATE INDEX "conversation_logs_wa_number_created_at_idx" ON "conversation_logs"("wa_number", "created_at");

-- CreateIndex
CREATE INDEX "memory_snapshots_wa_number_created_at_idx" ON "memory_snapshots"("wa_number", "created_at");

-- AddForeignKey
ALTER TABLE "whitelisted_numbers" ADD CONSTRAINT "whitelisted_numbers_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "ai_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
