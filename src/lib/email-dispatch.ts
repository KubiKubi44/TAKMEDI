import 'server-only'

import { createHash } from 'node:crypto'

import { writeAudit } from './audit'
import { encryptField, generateAccessToken, generatePin, hashToken, hmacSecret } from './crypto'
import { withPractice } from './db'
import { emailSender } from './email'
import { env } from './env'
import type { RequestInfo } from './request-context'

/**
 * Odeslání balíčku e-mailem.
 *
 * E-mail obsahuje JEN ODKAZ, nikdy přílohu se zdravotními údaji – poštovní
 * schránka je cizí úložiště, ke kterému ordinace nemá přístup a nemůže z něj
 * nic smazat.
 *
 * Odkaz sám nestačí: schránka bývá otevřená na sdíleném počítači a e-mail se
 * dá přeposlat omylem. Proto se k němu vydává PIN, který lékař řekne pacientovi
 * ÚSTNĚ. Jde tedy jinou cestou než odkaz a znalost jedné z nich nestačí.
 */

export class EmailDispatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailDispatchError'
  }
}

export type DispatchResult = {
  /** PIN, který lékař řekne pacientovi. Ukáže se jednou a nikde se neukládá. */
  pin: string
  dispatchId: string
}

export async function sendPackageByEmail(params: {
  practiceId: string
  practiceName: string
  userId: string
  userName: string
  packageId: string
  recipient: string
  linkTtlDays: number
  context: RequestInfo
}): Promise<DispatchResult> {
  const token = generateAccessToken()
  const pin = generatePin()
  const expiresAt = new Date(Date.now() + params.linkTtlDays * 24 * 60 * 60 * 1000)

  const { dispatchId } = await withPractice(params.practiceId, async (db) => {
    const balicek = await db.package.findUnique({
      where: { id: params.packageId },
      select: { status: true, _count: { select: { documents: true } } },
    })
    if (!balicek) throw new EmailDispatchError('Balíček se nepodařilo najít.')
    if (balicek._count.documents === 0) {
      throw new EmailDispatchError('Balíček neobsahuje žádný dokument.')
    }

    const vydany = await db.patientAccessToken.create({
      data: {
        practiceId: params.practiceId,
        packageId: params.packageId,
        tokenHash: hashToken(token),
        channel: 'EMAIL',
        // Ověření je u e-mailu POVINNÉ – odkaz sám by stačil komukoli, kdo se
        // k e-mailu dostane.
        verificationType: 'PIN',
        verificationHmac: hmacSecret(pin),
        expiresAt,
      },
      select: { id: true },
    })

    const dispatch = await db.emailDispatch.create({
      data: {
        practiceId: params.practiceId,
        packageId: params.packageId,
        patientAccessTokenId: vydany.id,
        // Adresa se ukládá zašifrovaně a při expiraci se maže. Hash zůstane,
        // aby audit dával smysl i potom.
        recipientEnc: encryptField(params.recipient),
        recipientHash: createHash('sha256').update(params.recipient.toLowerCase()).digest('hex'),
        status: 'QUEUED',
        sentById: params.userId,
      },
      select: { id: true },
    })

    await db.package.update({
      where: { id: params.packageId },
      data: { status: 'HANDED', expiresAt },
    })

    await writeAudit(db, params.practiceId, {
      action: 'TOKEN_ISSUED',
      actorType: 'USER',
      actorUserId: params.userId,
      actorName: params.userName,
      packageId: params.packageId,
      tokenId: vydany.id,
      metadata: { kanal: 'EMAIL', platnostDni: params.linkTtlDays },
      context: params.context,
    })

    return { dispatchId: dispatch.id }
  })

  // Odesílání běží MIMO transakci: je to síťová operace a držet kvůli ní
  // databázové spojení by bylo zbytečné. Když selže, token zůstane vydaný
  // a lékař může odeslání zopakovat nebo použít jiný kanál.
  const odkaz = `${env.APP_URL.replace(/\/$/, '')}/d/${token}`

  try {
    const { messageId } = await (
      await emailSender()
    ).send({
      to: params.recipient,
      subject: `Dokumenty z ordinace ${params.practiceName}`,
      text: sestavText(params.practiceName, odkaz, params.linkTtlDays),
    })

    await withPractice(params.practiceId, async (db) => {
      await db.emailDispatch.update({
        where: { id: dispatchId },
        data: { status: 'SENT', sentAt: new Date(), providerMessageId: messageId },
      })
      await writeAudit(db, params.practiceId, {
        action: 'EMAIL_SENT',
        actorType: 'USER',
        actorUserId: params.userId,
        actorName: params.userName,
        packageId: params.packageId,
        metadata: { dispatchId },
        context: params.context,
      })
    })
  } catch (error) {
    const duvod = error instanceof Error ? error.message.slice(0, 500) : 'neznámá chyba'

    await withPractice(params.practiceId, async (db) => {
      await db.emailDispatch.update({
        where: { id: dispatchId },
        data: { status: 'FAILED', error: duvod },
      })
      await writeAudit(db, params.practiceId, {
        action: 'EMAIL_FAILED',
        actorType: 'USER',
        actorUserId: params.userId,
        actorName: params.userName,
        packageId: params.packageId,
        metadata: { dispatchId },
        context: params.context,
      })
    })

    throw new EmailDispatchError(
      'E-mail se nepodařilo odeslat. Zkuste to prosím znovu, nebo dokumenty předejte jinak.',
    )
  }

  return { pin, dispatchId }
}

/**
 * Text e-mailu.
 *
 * Schválně neobsahuje jméno pacienta ani nic o diagnóze: e-mail putuje přes
 * cizí servery a zůstává ve schránce, ke které ordinace nemá přístup.
 * Nezmiňuje se v něm ani PIN – ten jde jinou cestou, v tom je celý smysl.
 */
function sestavText(practiceName: string, odkaz: string, dni: number): string {
  return [
    `Dobrý den,`,
    ``,
    `ordinace ${practiceName} pro vás připravila dokumenty.`,
    ``,
    `Otevřete je tímto odkazem:`,
    odkaz,
    ``,
    `Aplikace se zeptá na šestimístný kód, který vám lékař řekl v ordinaci.`,
    ``,
    `Odkaz platí ${dni} dní. Potom se dokumenty smažou.`,
    `Odkaz je osobní – neposílejte ho prosím dál.`,
    ``,
    `Na tento e-mail neodpovídejte, je odesílán automaticky.`,
  ].join('\n')
}
