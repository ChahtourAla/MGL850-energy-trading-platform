-- AlterTable
ALTER TABLE "users" ADD COLUMN     "account_origin" VARCHAR(16) NOT NULL DEFAULT 'REGISTERED';

ALTER TABLE "users"
ADD CONSTRAINT "users_account_origin_allowed"
CHECK ("account_origin" IN ('REGISTERED', 'SIMULATED'));