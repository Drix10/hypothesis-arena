/*
  Warnings:

  - A unique constraint covering the columns `[portfolio_id,timestamp]` on the table `performance_snapshots` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "performance_snapshots_portfolio_id_timestamp_key" ON "performance_snapshots"("portfolio_id", "timestamp");
