-- Složené cizí klíče včetně practice_id.
--
-- Kontroly cizích klíčů v PostgreSQL OBCHÁZEJÍ row-level security – běží mimo
-- ni. Bez practice_id ve vazbě tedy šlo založit dokument v ordinaci A a ukázat
-- jím na problém ordinace B. Čtení by data neprozradilo (tam RLS platí), ale
-- vznikl by nesmyslný odkaz napříč ordinacemi.
--
-- Odhaleno testem „nahrání do problému cizí ordinace neprojde" v
-- tests/library-documents.test.ts, který bez téhle migrace padá.
--
-- U package → problem je ON DELETE NO ACTION, ne SET NULL: vynulovat by šlo
-- jen problem_id, ne practice_id. NO ACTION se navíc kontroluje až na konci
-- příkazu, takže smazání celé ordinace (kaskáda na problémy i balíčky
-- současně) projde, kdežto smazání samotného problému, na kterém visí
-- balíčky, databáze odmítne. Historie předaných balíčků se nemá tiše ztratit.

-- DropForeignKey
ALTER TABLE "email_dispatch" DROP CONSTRAINT "email_dispatch_package_id_fkey";

-- DropForeignKey
ALTER TABLE "handoff_activation" DROP CONSTRAINT "handoff_activation_package_id_fkey";

-- DropForeignKey
ALTER TABLE "package" DROP CONSTRAINT "package_problem_id_fkey";

-- DropForeignKey
ALTER TABLE "package_document" DROP CONSTRAINT "package_document_package_id_fkey";

-- DropForeignKey
ALTER TABLE "package_document" DROP CONSTRAINT "package_document_template_version_id_fkey";

-- DropForeignKey
ALTER TABLE "package_document" DROP CONSTRAINT "package_document_uploaded_file_id_fkey";

-- DropForeignKey
ALTER TABLE "patient_access_token" DROP CONSTRAINT "patient_access_token_package_id_fkey";

-- DropForeignKey
ALTER TABLE "template_document" DROP CONSTRAINT "template_document_current_version_id_fkey";

-- DropForeignKey
ALTER TABLE "template_document" DROP CONSTRAINT "template_document_problem_id_fkey";

-- DropForeignKey
ALTER TABLE "template_document_version" DROP CONSTRAINT "template_document_version_template_document_id_fkey";

-- DropForeignKey
ALTER TABLE "uploaded_file" DROP CONSTRAINT "uploaded_file_package_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "package_practice_id_id_key" ON "package"("practice_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "problem_practice_id_id_key" ON "problem"("practice_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "template_document_practice_id_id_key" ON "template_document"("practice_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "template_document_practice_id_current_version_id_key" ON "template_document"("practice_id", "current_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_document_version_practice_id_id_key" ON "template_document_version"("practice_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_file_practice_id_id_key" ON "uploaded_file"("practice_id", "id");

-- AddForeignKey
ALTER TABLE "template_document" ADD CONSTRAINT "template_document_practice_id_problem_id_fkey" FOREIGN KEY ("practice_id", "problem_id") REFERENCES "problem"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document" ADD CONSTRAINT "template_document_practice_id_current_version_id_fkey" FOREIGN KEY ("practice_id", "current_version_id") REFERENCES "template_document_version"("practice_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_document_version" ADD CONSTRAINT "template_document_version_practice_id_template_document_id_fkey" FOREIGN KEY ("practice_id", "template_document_id") REFERENCES "template_document"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_practice_id_problem_id_fkey" FOREIGN KEY ("practice_id", "problem_id") REFERENCES "problem"("practice_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_document" ADD CONSTRAINT "package_document_practice_id_package_id_fkey" FOREIGN KEY ("practice_id", "package_id") REFERENCES "package"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_document" ADD CONSTRAINT "package_document_practice_id_template_version_id_fkey" FOREIGN KEY ("practice_id", "template_version_id") REFERENCES "template_document_version"("practice_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_document" ADD CONSTRAINT "package_document_practice_id_uploaded_file_id_fkey" FOREIGN KEY ("practice_id", "uploaded_file_id") REFERENCES "uploaded_file"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploaded_file" ADD CONSTRAINT "uploaded_file_practice_id_package_id_fkey" FOREIGN KEY ("practice_id", "package_id") REFERENCES "package"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_activation" ADD CONSTRAINT "handoff_activation_practice_id_package_id_fkey" FOREIGN KEY ("practice_id", "package_id") REFERENCES "package"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_access_token" ADD CONSTRAINT "patient_access_token_practice_id_package_id_fkey" FOREIGN KEY ("practice_id", "package_id") REFERENCES "package"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_practice_id_package_id_fkey" FOREIGN KEY ("practice_id", "package_id") REFERENCES "package"("practice_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

