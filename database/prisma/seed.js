import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
async function main() {
    console.log("Seeding initial data...");
    const buyer = await prisma.user.upsert({
        where: { email: "buyer1@example.com" },
        update: {},
        create: {
            name: "Alice Buyer",
            email: "buyer1@example.com",
            passwordHash: "$2b$10$YourHashedPasswordHere",
            physicalAddress: "123 Main St, Montreal",
            xKm: 10.5,
            yKm: 20.2,
            preferredEnergyType: "SOLAR",
            reputation: 100,
        },
    });
    const seller = await prisma.user.upsert({
        where: { email: "seller1@example.com" },
        update: {},
        create: {
            name: "Bob Solar Producer",
            email: "seller1@example.com",
            passwordHash: "$2b$10$YourHashedPasswordHere",
            physicalAddress: "456 Green Rd, Montreal",
            xKm: 12.0,
            yKm: 21.5,
            preferredEnergyType: "SOLAR",
            reputation: 95,
        },
    });
    console.log("Seeded users:", { buyer: buyer.id, seller: seller.id });
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
});
