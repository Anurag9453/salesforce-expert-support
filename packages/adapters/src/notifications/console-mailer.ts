import type { EmailMessage, Logger, Mailer } from "@sfx/domain";

/**
 * The mailer, and a deliberate statement about what email is for (requirement 9).
 *
 * **Email is awareness, never delivery.** An offer lives for 60 seconds; SMTP
 * queues, greylisting, spam filtering and inbox polling routinely take longer
 * than that, and an expert who learns about an offer from an email has almost
 * certainly learned about it too late. So no email is sent on the critical path,
 * nothing waits for one, and the copy never implies the offer is still open.
 *
 * What email is genuinely good for is the thing realtime cannot do: reaching
 * someone who is not looking at the app. Two cases in V1, both after the fact —
 * "you were offered work while you were away" and "your request could not be
 * matched".
 */

/**
 * Writes the message to the log instead of sending it.
 *
 * The default until a provider is chosen. Not a silent no-op: it logs what would
 * have gone out, so the walkthrough can show that email happened without needing
 * an API key or a real inbox.
 */
export class ConsoleMailer implements Mailer {
  readonly name = "console";
  readonly sent: EmailMessage[] = [];

  constructor(private readonly logger: Logger) {}

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    /*
      The body is logged, not just the metadata.

      This mailer never sends anything, so the terminal is the only place the
      email exists — and an email you cannot read is an email you cannot act on.
      Without this, turning on email verification silently made it impossible to
      register at all: the link was generated, addressed, and thrown away.

      It follows that this must never be the production mailer. Verification
      links and password resets are bearer tokens, and a real deployment putting
      them in its logs has published them to everyone with log access.
    */
    this.logger.info("email (not sent — console mailer)", {
      to: message.to,
      subject: message.subject,
      idempotencyKey: message.idempotencyKey,
      body: message.text,
    });
  }
}

/**
 * The two messages Phase 6 sends, both written to be true when read late.
 *
 * Note what neither of them contains: the customer's problem description. An
 * email is stored indefinitely on servers we do not control, forwarded, and
 * indexed — the same reasoning as the browser notification (requirement 7), with
 * more permanence.
 */
export const OFFER_MISSED_EMAIL = (params: {
  readonly to: string;
  readonly skills: readonly string[];
  readonly appUrl: string;
}): EmailMessage => {
  const summary = params.skills.slice(0, 3).join(" · ");
  // Deliberately past tense. Writing "a request is waiting for you" would be a
  // lie by the time most people read it.
  const subject = summary
    ? `You missed a Salesforce request — ${summary}`
    : "You missed a Salesforce request";
  const body = [
    "A support request was offered to you and the 60-second window closed before you answered.",
    summary ? `It needed: ${summary}.` : "",
    "",
    "Nothing is waiting for you now — it went to another expert. If you want to catch the next one,",
    `keep your dashboard open and turn on sound and notifications: ${params.appUrl}/expert`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    to: params.to,
    subject,
    text: body,
    html: `<p>${body.replace(/\n\n/g, "</p><p>").replace(/\n/g, " ")}</p>`,
    // One email per attempt, ever, however many times the job is delivered.
    idempotencyKey: `offer-missed:${params.to}:${summary}`,
  };
};

export const NO_EXPERT_FOUND_EMAIL = (params: {
  readonly to: string;
  readonly appUrl: string;
  readonly requestId: string;
}): EmailMessage => {
  const body = [
    "We could not find the right Salesforce expert for your request within 15 minutes.",
    "",
    "Rather than connect you with someone who was not a good fit, we stopped. Your payment",
    "authorization has been released and nothing has been charged.",
    "",
    `You can submit it again here: ${params.appUrl}/request-help`,
  ].join("\n");

  return {
    to: params.to,
    subject: "We could not find the right expert",
    text: body,
    html: `<p>${body.replace(/\n\n/g, "</p><p>").replace(/\n/g, " ")}</p>`,
    idempotencyKey: `no-expert-found:${params.requestId}`,
  };
};
