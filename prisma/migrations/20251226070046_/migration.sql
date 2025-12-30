-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('QRIS', 'EWALLET');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "fee_idr" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payment_method" "PaymentMethod",
ADD COLUMN     "total_pay" INTEGER NOT NULL DEFAULT 0;
