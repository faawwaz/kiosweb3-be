/*
  Warnings:

  - You are about to drop the `saved_wallets` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "saved_wallets" DROP CONSTRAINT "saved_wallets_user_id_fkey";

-- DropTable
DROP TABLE "saved_wallets";
