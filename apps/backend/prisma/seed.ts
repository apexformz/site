import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create demo users
  const demoUsers = [
    { email: 'virat@smartcoach.ai', name: 'Virat Sharma', sport: 'cricket' },
    { email: 'serena@smartcoach.ai', name: 'Serena Chen', sport: 'tennis' },
    { email: 'arjun@smartcoach.ai', name: 'Arjun Patel', sport: 'yoga' },
    { email: 'usain@smartcoach.ai', name: 'Usain Brooks', sport: 'running' },
    { email: 'priya@smartcoach.ai', name: 'Priya Singh', sport: 'cricket' },
  ];

  const hashedPassword = await bcrypt.hash('Demo@123456', 12);

  for (const userData of demoUsers) {
    const existing = await prisma.user.findUnique({ where: { email: userData.email } });
    if (existing) continue;

    const user = await prisma.user.create({
      data: {
        email: userData.email,
        password_hash: hashedPassword,
        name: userData.name,
        preferred_sport: userData.sport,
      },
    });

    // Create stats with realistic values
    const xp = Math.floor(Math.random() * 3000) + 500;
    await prisma.userStats.create({
      data: {
        user_id: user.id,
        xp,
        level: Math.floor(xp / 200) + 1,
        streak: Math.floor(Math.random() * 15),
        longest_streak: Math.floor(Math.random() * 30),
        total_sessions: Math.floor(Math.random() * 40) + 5,
        best_score: Math.random() * 40 + 60,
      },
    });

    // Seed leaderboard entries
    await prisma.leaderboardEntry.create({
      data: {
        user_id: user.id,
        sport: userData.sport,
        weekly_xp: Math.floor(Math.random() * 500) + 50,
        all_time_xp: xp,
      },
    });

    // Add some achievements
    await prisma.achievement.create({
      data: { user_id: user.id, type: 'first_session' },
    });
  }

  console.log('✅ Database seeded successfully');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
