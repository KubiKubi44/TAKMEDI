import nodemailer, { type Transporter } from 'nodemailer'

import { env } from '../env'
import type { EmailMessage, EmailSender, SendResult } from './types'

/**
 * Odesílání přes SMTP.
 *
 * Poskytovatel musí být v EU – e-mail sice nenese zdravotní údaje (jen odkaz),
 * ale adresa pacienta osobní údaj je.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter

  constructor() {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      // Port 465 je šifrovaný od začátku, 587 se šifruje až příkazem STARTTLS.
      secure: (env.SMTP_PORT ?? 587) === 465,
      requireTLS: true,
      auth: env.SMTP_USER
        ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' }
        : undefined,
      // Bez limitu by nedostupný server držel obsluhu požadavku donekonečna.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })

    return { messageId: info.messageId ?? null }
  }
}
