-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_user_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_practice_id_fkey";

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "actor_name" VARCHAR(200);
