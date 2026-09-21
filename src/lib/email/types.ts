export type EmailMessage = {
  to: string
  subject: string
  /** Prostý text. Posílá se vždy – ne každý klient umí nebo chce HTML. */
  text: string
  html?: string
}

export type SendResult = {
  /** Identifikátor od poskytovatele, když nějaký vrátí. Jde do auditu. */
  messageId: string | null
}

export interface EmailSender {
  send(message: EmailMessage): Promise<SendResult>
}
