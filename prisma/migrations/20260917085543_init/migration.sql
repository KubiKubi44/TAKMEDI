-- CreateEnum
CREATE TYPE "role" AS ENUM ('DOCTOR', 'NURSE', 'PRACTICE_ADMIN');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "package_status" AS ENUM ('DRAFT', 'READY', 'HANDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "package_document_kind" AS ENUM ('TEMPLATE', 'UPLOAD');

-- CreateEnum
CREATE TYPE "activation_status" AS ENUM ('ACTIVE', 'CLAIMED', 'EXPIRED', 'CANCELLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "token_channel" AS ENUM ('NFC', 'EMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "verification_type" AS ENUM ('NONE', 'PIN', 'DOB');

-- CreateEnum
CREATE TYPE "email_status" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('USER', 'PATIENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'TOTP_FAILED', 'TOTP_ENROLLED', 'LOGOUT', 'SESSION_EXPIRED', 'PACKAGE_CREATED', 'PACKAGE_UPDATED', 'PACKAGE_PRINTED', 'HANDOFF_ACTIVATED', 'HANDOFF_CODE_FAILED', 'HANDOFF_LOCKED', 'HANDOFF_CLAIMED', 'HANDOFF_CANCELLED', 'TOKEN_ISSUED', 'TOKEN_REVOKED', 'PATIENT_PAGE_VIEWED', 'PATIENT_VERIFY_FAILED', 'DOCUMENT_DOWNLOADED', 'EMAIL_SENT', 'EMAIL_FAILED', 'TEMPLATE_UPLOADED', 'TEMPLATE_ARCHIVED', 'PROBLEM_CREATED', 'PROBLEM_UPDATED', 'USER_CREATED', 'USER_UPDATED', 'USER_DISABLED', 'NFC_TAG_CREATED', 'NFC_TAG_REVOKED', 'SETTINGS_CHANGED', 'FILES_PURGED');

-- CreateTable
CREATE TABLE "practice" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "address_line" VARCHAR(200),
    "link_ttl_days" INTEGER NOT NULL DEFAULT 30,
    "handoff_ttl_seconds" INTEGER NOT NULL DEFAULT 180,
    "max_code_attempts" INTEGER NOT NULL DEFAULT 5,
    "session_idle_minutes" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "roles" "role"[],
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "totp_secret_enc" BYTEA,
    "totp_confirmed_at" TIMESTAMPTZ(6),
    "recovery_code_hashes" TEXT[],
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "totp_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "ip" INET,
    "user_agent" VARCHAR(500),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nfc_tag" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "secret_hmac" VARCHAR(64) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "nfc_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "icd10" VARCHAR(16),
    "note" VARCHAR(500),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_document" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "problem_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "current_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "template_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_document_version" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "template_document_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "page_count" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "dek_wrapped" BYTEA NOT NULL,
    "content_iv" BYTEA NOT NULL,
    "content_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_document_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "problem_id" UUID,
    "patient_label_enc" BYTEA,
    "note_enc" BYTEA,
    "status" "package_status" NOT NULL DEFAULT 'DRAFT',
    "expires_at" TIMESTAMPTZ(6),
    "purged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_document" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "kind" "package_document_kind" NOT NULL,
    "template_version_id" UUID,
    "uploaded_file_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploaded_file" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "package_id" UUID,
    "storage_key" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "page_count" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "dek_wrapped" BYTEA NOT NULL,
    "content_iv" BYTEA NOT NULL,
    "content_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "uploaded_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handoff_activation" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "nfc_tag_id" UUID,
    "code_hmac" VARCHAR(64) NOT NULL,
    "status" "activation_status" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "patient_access_token_id" UUID,

    CONSTRAINT "handoff_activation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_access_token" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "channel" "token_channel" NOT NULL,
    "verification_type" "verification_type" NOT NULL DEFAULT 'NONE',
    "verification_hmac" VARCHAR(64),
    "verify_attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "first_accessed_at" TIMESTAMPTZ(6),
    "last_accessed_at" TIMESTAMPTZ(6),
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_dispatch" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "patient_access_token_id" UUID NOT NULL,
    "recipient_enc" BYTEA NOT NULL,
    "recipient_hash" VARCHAR(64) NOT NULL,
    "status" "email_status" NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" VARCHAR(255),
    "error" VARCHAR(500),
    "sent_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_dispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "practice_id" UUID,
    "seq" BIGINT,
    "action" "audit_action" NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_user_id" UUID,
    "package_id" UUID,
    "token_id" UUID,
    "document_id" UUID,
    "ip" INET,
    "user_agent" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "prev_hash" VARCHAR(64),
    "hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit" (
    "key" VARCHAR(128) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "practice_slug_key" ON "practice"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_practice_id_idx" ON "user"("practice_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_idle_expires_at_idx" ON "session"("idle_expires_at");

-- CreateIndex
CREATE INDEX "nfc_tag_practice_id_idx" ON "nfc_tag"("practice_id");

-- CreateIndex
CREATE INDEX "problem_practice_id_archived_at_idx" ON "problem"("practice_id", "archived_at");

-- CreateIndex
CREATE INDEX "problem_practice_id_icd10_idx" ON "problem"("practice_id", "icd10");

-- CreateIndex
CREATE UNIQUE INDEX "template_document_current_version_id_key" ON "template_document"("current_version_id");

-- CreateIndex
CREATE INDEX "template_document_practice_id_problem_id_archived_at_idx" ON "template_document"("practice_id", "problem_id", "archived_at");

-- CreateIndex
CREATE INDEX "template_document_version_practice_id_idx" ON "template_document_version"("practice_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_document_version_template_document_id_version_key" ON "template_document_version"("template_document_id", "version");

-- CreateIndex
CREATE INDEX "package_practice_id_created_at_idx" ON "package"("practice_id", "created_at");

-- CreateIndex
CREATE INDEX "package_practice_id_status_idx" ON "package"("practice_id", "status");

-- CreateIndex
CREATE INDEX "package_expires_at_idx" ON "package"("expires_at");

-- CreateIndex
CREATE INDEX "package_document_practice_id_idx" ON "package_document"("practice_id");

-- CreateIndex
CREATE INDEX "package_document_package_id_sort_order_idx" ON "package_document"("package_id", "sort_order");

-- CreateIndex
CREATE INDEX "uploaded_file_practice_id_idx" ON "uploaded_file"("practice_id");

-- CreateIndex
CREATE INDEX "uploaded_file_package_id_idx" ON "uploaded_file"("package_id");

-- CreateIndex
CREATE UNIQUE INDEX "handoff_activation_patient_access_token_id_key" ON "handoff_activation"("patient_access_token_id");

-- CreateIndex
CREATE INDEX "handoff_activation_practice_id_status_idx" ON "handoff_activation"("practice_id", "status");

-- CreateIndex
CREATE INDEX "handoff_activation_package_id_idx" ON "handoff_activation"("package_id");

-- CreateIndex
CREATE INDEX "handoff_activation_expires_at_idx" ON "handoff_activation"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "patient_access_token_token_hash_key" ON "patient_access_token"("token_hash");

-- CreateIndex
CREATE INDEX "patient_access_token_practice_id_idx" ON "patient_access_token"("practice_id");

-- CreateIndex
CREATE INDEX "patient_access_token_package_id_idx" ON "patient_access_token"("package_id");

-- CreateIndex
CREATE INDEX "patient_access_token_expires_at_idx" ON "patient_access_token"("expires_at");

-- CreateIndex
CREATE INDEX "email_dispatch_practice_id_created_at_idx" ON "email_dispatch"("practice_id", "created_at");

-- CreateIndex
CREATE INDEX "email_dispatch_package_id_idx" ON "email_dispatch"("package_id");

-- CreateIndex
CREATE INDEX "audit_log_practice_id_created_at_idx" ON "audit_log"("practice_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_package_id_idx" ON "audit_log"("package_id");

-- CreateIndex
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log"("action", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_practice_id_seq_key" ON "audit_log"("practice_id", "seq");

-- CreateIndex
CREATE INDEX "rate_limit_expires_at_idx" ON "rate_limit"("expires_at");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nfc_tag" ADD CONSTRAINT "nfc_tag_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nfc_tag" ADD CONSTRAINT "nfc_tag_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem" ADD CONSTRAINT "problem_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document" ADD CONSTRAINT "template_document_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document" ADD CONSTRAINT "template_document_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document" ADD CONSTRAINT "template_document_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "template_document_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document_version" ADD CONSTRAINT "template_document_version_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document_version" ADD CONSTRAINT "template_document_version_template_document_id_fkey" FOREIGN KEY ("template_document_id") REFERENCES "template_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document_version" ADD CONSTRAINT "template_document_version_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_document" ADD CONSTRAINT "package_document_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_document" ADD CONSTRAINT "package_document_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_document" ADD CONSTRAINT "package_document_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_document_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_document" ADD CONSTRAINT "package_document_uploaded_file_id_fkey" FOREIGN KEY ("uploaded_file_id") REFERENCES "uploaded_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_file" ADD CONSTRAINT "uploaded_file_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_file" ADD CONSTRAINT "uploaded_file_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_file" ADD CONSTRAINT "uploaded_file_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_activation" ADD CONSTRAINT "handoff_activation_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_activation" ADD CONSTRAINT "handoff_activation_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_activation" ADD CONSTRAINT "handoff_activation_nfc_tag_id_fkey" FOREIGN KEY ("nfc_tag_id") REFERENCES "nfc_tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_activation" ADD CONSTRAINT "handoff_activation_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_activation" ADD CONSTRAINT "handoff_activation_patient_access_token_id_fkey" FOREIGN KEY ("patient_access_token_id") REFERENCES "patient_access_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_access_token" ADD CONSTRAINT "patient_access_token_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_access_token" ADD CONSTRAINT "patient_access_token_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_access_token" ADD CONSTRAINT "patient_access_token_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_patient_access_token_id_fkey" FOREIGN KEY ("patient_access_token_id") REFERENCES "patient_access_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
