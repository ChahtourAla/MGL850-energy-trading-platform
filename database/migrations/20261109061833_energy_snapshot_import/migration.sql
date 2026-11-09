-- AlterTable
ALTER TABLE "energy_records" ADD COLUMN     "snapshot_id" UUID;

-- CreateTable
CREATE TABLE "energy_snapshot_imports" (
    "id" UUID NOT NULL,
    "time_slot" TIMESTAMPTZ(3) NOT NULL,
    "schema_version" VARCHAR(32) NOT NULL,
    "generator_version" VARCHAR(32) NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "record_count" INTEGER NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "energy_snapshot_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "energy_snapshot_imports_time_slot_key" ON "energy_snapshot_imports"("time_slot");

-- CreateIndex
CREATE INDEX "energy_records_snapshot_id_idx" ON "energy_records"("snapshot_id");

-- AddForeignKey
ALTER TABLE "energy_records" ADD CONSTRAINT "energy_records_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "energy_snapshot_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
