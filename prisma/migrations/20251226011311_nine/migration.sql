/*
  Warnings:

  - You are about to drop the column `order_id` on the `vouchers` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "vouchers" DROP CONSTRAINT "vouchers_user_id_fkey";

-- AlterTable
ALTER TABLE "vouchers" DROP COLUMN "order_id",
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "max_usage" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "min_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "usage_count" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "saved_wallets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chainType" TEXT NOT NULL DEFAULT 'EVM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_wallets_user_id_idx" ON "saved_wallets"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_idx" ON "audit_logs"("admin_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "orders_completed_at_idx" ON "orders"("completed_at");

-- CreateIndex
CREATE INDEX "orders_chain_idx" ON "orders"("chain");

-- CreateIndex
CREATE INDEX "users_name_idx" ON "users"("name");

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_wallets" ADD CONSTRAINT "saved_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
