import 'server-only'

import { ConsoleEmailSender } from './console'
import { env } from '../env'
import type { EmailSender } from './types'

export type { EmailMessage, EmailSender, SendResult } from './types'

let cached: EmailSender | null = null

/**
 * Odesílatel e-mailů.
 *
 * Asynchronní kvůli línému načtení SMTP klienta: na vývoji se nodemailer
 * vůbec nezavádí. Synchronní require() by tu byl chyba – projekt běží jako
 * ESM modul, kde require neexistuje.
 */
export async function emailSender(): Promise<EmailSender> {
  if (cached) return cached

  if (env.EMAIL_DRIVER === 'smtp') {
    const { SmtpEmailSender } = await import('./smtp')
    cached = new SmtpEmailSender()
  } else {
    cached = new ConsoleEmailSender()
  }

  return cached
}
