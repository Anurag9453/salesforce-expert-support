import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms",
  description: "The rules for using this site, for customers and for experts.",
};

/**
 * Terms of use.
 *
 * Two things this deliberately does not do.
 *
 * It does not claim the intermediary structure has any particular legal or tax
 * treatment. Calling something a marketplace does not make it one in the eyes of
 * a regulator, and this page describes the arrangement plainly rather than
 * asserting a conclusion nobody qualified has signed off.
 *
 * And it does not promise things the product does not do. There is no response-time
 * guarantee, no uptime commitment, and no claim that payment is handled here — all
 * of which would be easy to write and false today.
 */
export default function TermsPage() {
  return (
    <LegalPage
      kind="Terms"
      title="The rules, in plain terms"
      summary="We introduce you to independent Salesforce experts. We are not the expert, and we do not employ them. What follows is what each side can expect."
      updated="18 August 2026"
    >
      <LegalSection heading="Who you are contracting with">
        <p>
          This site is operated by [LEGAL ENTITY NAME], registered in [JURISDICTION] at [REGISTERED
          ADDRESS]. Using the site means accepting what is on this page.
        </p>
      </LegalSection>

      <LegalSection heading="What we do, and what we are not">
        <p>
          We are an intermediary. We take a description of a problem, find a suitable independent
          expert, and introduce you. The expert does the work; we are not a party to it and we do
          not supervise how it is done.
        </p>
        <p>
          Experts are independent contractors, not our employees. Describing this arrangement as a
          marketplace is a description, not a legal conclusion — how it is treated for employment,
          tax or payment-regulation purposes depends on the jurisdiction and on facts a court or
          regulator would assess, not on the word we choose.
        </p>
      </LegalSection>

      <LegalSection heading="What you must not put on this site">
        <p>This is the rule we care most about, and it is not negotiable:</p>
        <ul className="ml-4 list-disc space-y-1.5">
          <li>No passwords, access tokens, API keys, private keys or session identifiers.</li>
          <li>No production customer data.</li>
          <li>
            No patient or health information. Health Cloud <em>technical</em> questions are in scope
            — how an object is configured, why a flow fails — but actual patient records are not, on
            this site or in a session.
          </li>
          <li>No payment card numbers, CVVs or bank credentials. We never ask for them.</li>
        </ul>
        <p>
          The description box is scanned for credentials and redacts what it recognises, but it is a
          net with holes and not a permission slip. Sharing any of the above may end your access,
          and we may delete the content.
        </p>
      </LegalSection>

      <LegalSection heading="What we do not promise">
        <p>
          We will try to find you the right person, and we may not be able to. There is no
          guaranteed response time, no guarantee that an expert is available for a slot you asked
          for, and no guarantee that your problem is solvable in the time booked.
        </p>
        <p>
          Advice from an expert is their professional judgement, not ours. Test changes before you
          apply them to a production org. Take a backup. Nobody on either side of this can undo a
          deploy for you.
        </p>
        <p>
          The site is provided as it is, without a warranty that it will be uninterrupted or
          error-free.
        </p>
      </LegalSection>

      <LegalSection heading="Money">
        <p>
          No payment is taken through this site today. Session prices are published so you know the
          figure in advance — $21 for 30 minutes, $36.35 for an hour, $51.80 for two, including card
          processing — but the arrangement is agreed with you directly before any work happens.
        </p>
        <p>
          When paid work does go through the platform, the expert receives the large majority of
          what you pay and we retain a percentage as our fee. Prices are quoted in your currency,
          not converted at an exchange rate we picked.
        </p>
      </LegalSection>

      <LegalSection heading="If you are an expert">
        <p>
          You need an account, and you must give us a verifiable email, a working phone number, a
          public Trailhead profile, and a photo. We check them. Misrepresenting your certifications
          or experience ends the relationship.
        </p>
        <p>
          You take the work you accept, and you are responsible for delivering it and for your own
          tax. Accepting a request and not appearing for it affects whether you are offered more.
        </p>
        <p>
          Anything a customer tells you is theirs and confidential. Do not keep it, do not reuse it,
          and do not share it.
        </p>
      </LegalSection>

      <LegalSection heading="Intellectual property">
        <p>
          The site and its content are ours. What you write in a request is yours; you give us
          permission to store it and show it to the expert we match you with, and nothing more.
        </p>
        <p>
          We are not affiliated with, endorsed by, or sponsored by Salesforce, Inc. We use the name
          to describe the expertise on offer, which is the only way to describe it.
        </p>
      </LegalSection>

      <LegalSection heading="Ending it">
        <p>
          You can stop using the site whenever you like and ask us to delete your information. We
          may suspend access for anyone who breaks the rules above, particularly the one about
          credentials and customer data.
        </p>
      </LegalSection>

      <LegalSection heading="Changes and disputes">
        <p>
          If these terms change materially we will update the date at the top and say what changed.
        </p>
        <p>
          Which law governs this and where disputes are heard depends on the entity above, which is
          not settled yet. That gap is real and will be filled before the site is advertised or
          takes money.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
