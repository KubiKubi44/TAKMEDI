-- Kdy pacient prošel ověřením u odkazu poslaného e-mailem.
-- Dokud je prázdné, vidí jen výzvu k zadání PINu nebo data narození.

-- AlterTable
ALTER TABLE "patient_access_token" ADD COLUMN     "verified_at" TIMESTAMPTZ(6);

