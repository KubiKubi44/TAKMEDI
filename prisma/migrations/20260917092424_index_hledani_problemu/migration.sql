-- CreateIndex
CREATE INDEX "problem_name_trgm" ON "problem" USING GIN ("name" gin_trgm_ops);
