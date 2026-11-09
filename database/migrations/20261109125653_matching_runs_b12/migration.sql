-- CreateTable
CREATE TABLE "matching_runs" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "time_slot" TIMESTAMPTZ(3) NOT NULL,
    "algorithm_version" VARCHAR(32) NOT NULL,
    "config_sha256" CHAR(64) NOT NULL,
    "result_sha256" CHAR(64) NOT NULL,
    "match_count" INTEGER NOT NULL,
    "unmatched_buyer_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matching_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "matching_runs_time_slot_key" ON "matching_runs"("time_slot");

-- CreateIndex
CREATE INDEX "matching_runs_snapshot_id_idx" ON "matching_runs"("snapshot_id");
