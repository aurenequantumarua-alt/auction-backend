import argon2 from 'argon2';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sample = (arr: readonly string[]) => arr[Math.floor(Math.random() * arr.length)]!;
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const BRANDS = [
  'Breguet & Fils',
  'Cartier Horlogerie',
  'Meiji Imperial Workshop',
  'Edo Goldsmith Guild',
  'Ming Dynasty Atelier',
  'Patek & Cie',
  'Tiffany & Co. Makers',
  'Baccarat Cristallerie',
  'Murano Maestri',
  'Georgian Silversmiths',
] as const;
const CATEGORIES = [
  'Antiques',
  'Collectibles & Art',
  'Watches & Horology',
  'Jewellery & Relics',
  'Ceramics & Porcelain',
  'Sculpture & Bronze',
  'Rare Books & Manuscripts',
  'Other',
] as const;
const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'] as const;
const SIZES = [
  '12 × 8 × 4 in',
  '32 cm height',
  '40 mm case',
  '18 × 24 in framed',
  '2.4 kg solid bronze',
  'Height: 45 cm',
  '9 × 6 in folio',
  'Diameter: 28 cm',
] as const;

// Curated high-resolution museum, horology, and antique sculpture images.
const IMAGES = [
  'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=1200&q=80',
  'https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=1200&q=80',
  'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=1200&q=80',
  'https://images.unsplash.com/photo-1577083552431-6e5fd01aa342?w=1200&q=80',
  'https://images.unsplash.com/photo-1615529328331-f8917597711f?w=1200&q=80',
  'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=1200&q=80',
  'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=1200&q=80',
  'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=1200&q=80',
] as const;

const TITLES = [
  'Late Edo Period Shakudo & Gilt Tsuba',
  '19th-Century Marine Chronometer by Breguet',
  'Ming Dynasty Celadon Jade Libation Vessel',
  'Meiji Era Bronze Dragon Incense Burner',
  'Victorian Hand-Engraved Sterling Silver Goblet',
  'Imperial Cloisonné Enamel Baluster Vase',
  'Early 20th-Century Enamelled Cartier Pocket Watch',
  'Ottoman Gilt-Brass Astrolabe & Calendar Plate',
  'Song Dynasty Jian Ware "Hare\'s Fur" Tea Bowl',
  'Gothic Revival Hand-Carved Oak Reliquary',
] as const;

const DESCRIPTIONS = [
  'Sourced from an esteemed Kyoto private collection. Features exquisite period patina and original maker hallmark. Complete with documented provenance and authentication certificate.',
  'Preserved in exceptional condition within a mahogany deck box. Original balance spring intact, exhibiting consistent horological precision.',
  'Carved from a single boulder of mutton-fat celadon nephrite jade. Subtly polished surface showing characteristic Russet skin inclusions consistent with period lapidary craftsmanship.',
  'Cast in solid patinated bronze with lost-wax technique. Accompanied by archival records tracing ownership across European and East Asian collections.',
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
        tags: ['antique', 'provenance-verified', 'curated'],
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
