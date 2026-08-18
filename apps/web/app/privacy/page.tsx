import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What we collect, why, where it goes, and how to get it back or deleted.",
};

/**
 * The privacy notice.
 *
 * Written from what the code actually does rather than from a template: the fields
 * are the columns on `support_leads`, the third parties are the ones the container
 * really wires up, and the retention periods are the ones nothing currently
 * enforces — which is why they are described as intentions and flagged as such.
 *
 * Every claim here should be checkable against the repository. If a statement
 * stops being true, it is a bug in this page as much as in the code.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      kind="Privacy"
      title="What we do with your information"
      summary="Short version: we ask for your name, email, phone number and a description of your problem, so that a person can call you back about it. It goes to our own database and to our CRM. We do not sell it."
      updated="18 August 2026"
    >
      <LegalSection heading="Who is asking">
        <p>
          Salesforce Expert Support is operated by [LEGAL ENTITY NAME], registered in [JURISDICTION]
          at [REGISTERED ADDRESS]. For anything on this page, write to privacy@[DOMAIN].
        </p>
      </LegalSection>

      <LegalSection heading="What we collect, and why">
        <p>When you ask for help, the form asks for:</p>
        <ul className="ml-4 list-disc space-y-1.5">
          <li>
            <span className="font-medium text-ink">Your name, email and phone number.</span> All
            three are required, because a request nobody can respond to is not a request. The phone
            number is how we reach you when a call is about to start.
          </li>
          <li>
            <span className="font-medium text-ink">A description of the problem.</span> In your own
            words. This is the only thing that lets us pick the right expert.
          </li>
          <li>
            <span className="font-medium text-ink">What kind of help, and how much.</span> Whether
            it is instant, scheduled, long-term or certification work; the session length; a
            preferred time and time zone; a budget range, for ongoing work.
          </li>
        </ul>
        <p>
          We do not ask for a password, and there is no account. If you are an expert, we ask for
          more — a photo, a Trailhead profile, your declared skills — because you are being paid and
          customers are entitled to know who they are talking to.
        </p>
      </LegalSection>

      <LegalSection heading="What we try not to collect">
        <p>
          The description box is scanned before it is stored, and things that look like credentials
          — API keys, connection strings, private keys, session identifiers, `password=` style pairs
          — are replaced with a marker rather than saved.
        </p>
        <p>
          That scanner is a safety net with real holes in it. It matches patterns, so it will not
          catch a password written out in a sentence, and it is not a reason to relax. Please do not
          put credentials, access tokens, private keys or production customer data into any field on
          this site. Health Cloud technical questions are welcome; actual patient data is not.
        </p>
      </LegalSection>

      <LegalSection heading="Where it goes">
        <p>Your information is stored and shared with these services, and no others:</p>
        <ul className="ml-4 list-disc space-y-1.5">
          <li>
            <span className="font-medium text-ink">Supabase</span> hosts our database. It currently
            sits in their Seoul region, which means your information is stored in South Korea.
          </li>
          <li>
            <span className="font-medium text-ink">Vercel</span> runs the website itself and
            processes requests as they pass through.
          </li>
          <li>
            <span className="font-medium text-ink">Salesforce</span> is our CRM. Your request is
            copied there so the team handling it can work from one place.
          </li>
          <li>
            <span className="font-medium text-ink">The expert we match you with</span> sees what you
            wrote about the problem, and your name. They need it to help you.
          </li>
        </ul>
        <p>
          We do not sell your information, and we do not use it to advertise to you. There is no
          analytics or advertising tracker on this site at the time of writing.
        </p>
      </LegalSection>

      <LegalSection heading="Cookies">
        <p>
          There is no tracking cookie and no consent banner, because there is nothing to consent to.
          The only cookie this site sets is a session cookie for signed-in experts, which exists to
          keep them signed in. Customers never sign in, so a customer never receives one.
        </p>
      </LegalSection>

      <LegalSection heading="How long we keep it">
        <p>
          Intended retention is two years for an enquiry that does not become work, and seven years
          for one that does, because a paid engagement leaves records a business is required to
          keep.
        </p>
        <p>
          Being straight about this: nothing in the system deletes anything automatically today.
          Those periods are the policy we are building towards, not a mechanism already running. If
          you ask us to delete your information we will do it by hand.
        </p>
      </LegalSection>

      <LegalSection heading="What you can ask for">
        <p>
          Write to privacy@[DOMAIN] and we will act on any of these without charge, normally within
          thirty days:
        </p>
        <ul className="ml-4 list-disc space-y-1.5">
          <li>A copy of everything we hold about you.</li>
          <li>A correction, if something is wrong.</li>
          <li>Deletion, unless we are required to keep a record of a completed engagement.</li>
          <li>An explanation of why we hold something, if that is not clear from this page.</li>
        </ul>
        <p>
          Depending on where you live, you may have these rights under the UK or EU GDPR,
          India&rsquo;s Digital Personal Data Protection Act, or comparable law elsewhere. We would
          rather honour the request than argue about which statute applies.
        </p>
      </LegalSection>

      <LegalSection heading="Children">
        <p>
          This is a service for people buying and doing professional work. It is not intended for
          anyone under 18, and we do not knowingly collect their information.
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          If this notice changes in a way that affects what we do with information already given to
          us, we will say so here and update the date at the top rather than change it quietly.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
