import argon2 from 'argon2';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sample = (arr: readonly string[]) => arr[Math.floor(Math.random() * arr.length)]!;
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const BRANDS = ['Acne Studios', 'Maison Margiela', 'Rick Owens', 'Comme des Garçons', 'Dries Van Noten', 'Stone Island', 'Visvim', 'Issey Miyake', 'Yohji Yamamoto', 'Lemaire'] as const;
const CATEGORIES = [
  'Antiques',
  'Collectibles & Art',
  'Clothing & Fashion',
  'Footwear & Sneakers',
  'Watches & Jewellery',
  'Bags & Accessories',
  'Electronics & Gadgets',
  'Home & Furniture',
  'Books & Media',
  'Automobilia & Vehicle Parts',
  'Other',
] as const;
const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'] as const;
const SIZES = ['S', 'M', 'L', 'XL', '32', '34'] as const;

// Curated free editorial-style images.
const IMAGES = [
  'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?w=1200&q=80',
  'https://images.unsplash.com/photo-1551488831-00ddcb6c6bd3?w=1200&q=80',
  'https://images.unsplash.com/photo-1542272604-787c3835535d?w=1200&q=80',
  'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=1200&q=80',
  'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1200&q=80',
  'https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?w=1200&q=80',
  'https://images.unsplash.com/photo-1564859228273-274232fdb516?w=1200&q=80',
  'https://images.unsplash.com/photo-1539109136881-3be0616acf4b?w=1200&q=80',
  'https://images.unsplash.com/photo-1485518882345-15568b007407?w=1200&q=80',
  'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=1200&q=80',
] as const;

const TITLES = [
  'Felted Wool Field Coat',
  'Garment-Dyed Selvedge Trousers',
  'Reverse-Weave Crewneck',
  'Calf Leather Derby',
  'Hand-Knit Mohair Cardigan',
  'Raw Denim Five-Pocket',
  'Linen Camp Collar Shirt',
  'Boiled Wool Bomber',
  'Suede Chelsea Boot',
  'Cotton Poplin Trench',
] as const;

const DESCRIPTIONS = [
  'Sourced from a Tokyo collector. Lightly worn, no flaws. Reinforced shoulder seams and a faint patina at the cuffs that only adds to it.',
  'Deadstock from the FW19 production run. Tags off, never worn. Stored flat in a climate-controlled archive.',
  'Personal piece from my rotation. Loved hard and showing it — soft hand, cracked indigo, broken in to perfection.',
  'Pulled from a press sample sale. Inside tag intact. Color is closer to the second image — warm umber, not the cooler tone the gallery suggests.',
] as const;

async function main() {
  console.log('Seeding database…');

  // Wipe (dev only).
  await prisma.transaction.deleteMany();
  await prisma.auctionSettlement.deleteMany();
  await prisma.bid.deleteMany();
  await prisma.watchlist.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.auctionImage.deleteMany();
  await prisma.auction.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await argon2.hash('password123', { type: argon2.argon2id });

  const sellers = await Promise.all(
    Array.from({ length: 4 }).map((_, i) =>
      prisma.user.create({
        data: {
          email: `seller${i + 1}@aurene.test`,
          name: ['Naomi Park', 'Ezra Lévi', 'Sasha Volkov', 'Mariko Aoki'][i]!,
          passwordHash,
          role: 'USER',
        },
      }),
    ),
  );

  const buyers = await Promise.all(
    Array.from({ length: 6 }).map((_, i) =>
      prisma.user.create({
        data: {
          email: `buyer${i + 1}@aurene.test`,
          name: ['Theo Bell', 'Ava Mori', 'Jonas Reiter', 'Iris Chen', 'Kofi Mensah', 'Lila Russo'][i]!,
          passwordHash,
          role: 'USER',
        },
      }),
    ),
  );

  const demoUser = await prisma.user.create({
    data: {
      email: 'demo@aurene.test',
      name: 'Demo Account',
      passwordHash,
      role: 'USER',
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@aurene.test',
      name: 'Admin Account',
      passwordHash,
      role: 'ADMIN',
    },
  });

  const now = Date.now();
  const auctions: { id: string }[] = [];

  for (let i = 0; i < 14; i++) {
    const seller = sellers[i % sellers.length]!;
    const startsAt = new Date(now - randInt(2, 24) * 60 * 60 * 1000);
    const endsAt = new Date(now + randInt(2, 96) * 60 * 60 * 1000);
    const basePrice = new Prisma.Decimal(randInt(40, 600));
    const hasBuyNow = i % 2 === 0; // every other auction gets a buy-now price
    const buyNowPrice = hasBuyNow ? basePrice.mul(2) : null;
    const auction = await prisma.auction.create({
      data: {
        sellerId: seller.id,
        title: sample(TITLES),
        description: sample(DESCRIPTIONS),
        category: sample(CATEGORIES),
        brand: sample(BRANDS),
        condition: sample(CONDITIONS) as 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR',
        size: sample(SIZES),
        basePrice,
        buyNowPrice,
        minIncrement: new Prisma.Decimal(randInt(5, 25)),
        startsAt,
        endsAt,
        status: 'LIVE',
        tags: ['archive', 'curated'],
        images: {
          create: [0, 1, 2].map((idx) => ({
            url: IMAGES[(i + idx) % IMAGES.length]!,
            sortOrder: idx,
            isCover: idx === 0,
          })),
        },
      },
    });
    auctions.push({ id: auction.id });

    // Seed a few bids.
    let current = basePrice;
    const numBids = randInt(2, 6);
    for (let b = 0; b < numBids; b++) {
      const bidder = buyers[(i + b) % buyers.length]!;
      const inc = new Prisma.Decimal(randInt(5, 30));
      current = current.plus(inc);
      const bid = await prisma.bid.create({
        data: {
          auctionId: auction.id,
          bidderId: bidder.id,
          amount: current,
          status: b === numBids - 1 ? 'ACTIVE' : 'OUTBID',
          placedAt: new Date(startsAt.getTime() + (b + 1) * 60 * 60 * 1000),
        },
      });
      if (b === numBids - 1) {
        await prisma.auction.update({
          where: { id: auction.id },
          data: { currentBidId: bid.id, bidCount: numBids },
        });
      }
    }

    if (auctions.length >= 14) break;
  }

  // Add a few items to demo user's watchlist.
  for (const a of auctions.slice(0, 3)) {
    await prisma.watchlist.create({ data: { userId: demoUser.id, auctionId: a.id } });
  }

  console.log(`Done. Demo login: demo@aurene.test / password123 | Admin login: admin@aurene.test / password123`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
