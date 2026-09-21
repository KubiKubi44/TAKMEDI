import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '@/generated/prisma/client'

/**
 * Klient pod rolí vlastníka schématu.
 *
 * Používá se JEN v testech k přípravě výchozího stavu – zakládá ordinace, které
 * by aplikační role zakládat neuměla. Nic z aplikace tuhle roli nepoužívá.
 */
export const ownerClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

let counter = 0

export async function createPractice(name: string) {
  counter += 1
  const slug = `test-${Date.now()}-${counter}`

  const practice = await ownerClient.practice.create({
    data: { slug, name },
  })

  const user = await ownerClient.user.create({
    data: {
      practiceId: practice.id,
      email: `${slug}@test.invalid`,
      passwordHash: 'x',
      name: `Lékař ${name}`,
      roles: ['DOCTOR'],
    },
  })

  return { practice, user }
}

/**
 * Úklid po testu.
 *
 * Audit se maže schválně nechává – tabulka je přidávací a nejde z ní mazat ani
 * pod rolí vlastníka. Testy proto nikdy nespoléhají na to, že je prázdná, a
 * vždycky se ptají na konkrétní ordinaci.
 */
export async function removePractice(practiceId: string) {
  await ownerClient.practice.delete({ where: { id: practiceId } }).catch(() => {})
}
