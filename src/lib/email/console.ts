import type { EmailMessage, EmailSender, SendResult } from './types'

/**
 * Vývojový odesílatel – vypíše zprávu do konzole místo odeslání.
 *
 * Adresa příjemce se vypisuje jen částečně. I ve vývoji se do logu snadno
 * dostanou skutečné adresy z testovacího provozu a log bývá na horších místech
 * než databáze.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<SendResult> {
    console.info(
      [
        '',
        '─── e-mail (vývojový režim, neodeslán) ───',
        `komu:    ${maskEmail(message.to)}`,
        `předmět: ${message.subject}`,
        '',
        message.text,
        '──────────────────────────────────────────',
        '',
      ].join('\n'),
    )

    return { messageId: null }
  }
}

function maskEmail(email: string): string {
  const [jmeno = '', domena = ''] = email.split('@')
  const zacatek = jmeno.slice(0, 2)
  return `${zacatek}${'*'.repeat(Math.max(1, jmeno.length - 2))}@${domena}`
}
