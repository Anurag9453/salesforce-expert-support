import { z } from "zod";

/**
 * The Salesforce certification catalogue, as a customer would pick from it.
 *
 * ## Why this is data and not a database table
 *
 * Salesforce owns this list and changes it: credentials are retired, renamed and
 * added every year, and the 2025 rebrand renamed most of them at once (what was
 * "Administrator" is now "Platform Administrator", and the Sales and Service
 * Cloud consultant exams became Agentforce ones). A table would need an admin
 * screen and a migration for each of those; a constant needs an edit here and a
 * deploy, which is the right amount of ceremony for a list nobody in the product
 * derives behaviour from.
 *
 * ## Names are display strings, not identifiers
 *
 * Nothing keys off these — they are what the customer chose, passed to the sales
 * team verbatim. That is deliberate: a renamed credential should show its new
 * name on new enquiries without rewriting the old ones, which would falsify what
 * the customer actually asked for.
 *
 * The "Salesforce Certified" prefix is dropped throughout, because every option
 * in the list carries it and repeating it forty-eight times makes the list
 * harder to scan rather than more precise.
 */

export interface CertificationTrack {
  /** The grouping label, used as an `<optgroup>` heading. */
  readonly track: string;
  readonly certifications: readonly string[];
}

export const CERTIFICATION_TRACKS: readonly CertificationTrack[] = [
  {
    track: "Foundations and associate",
    certifications: [
      "Platform Foundations",
      "Platform Associate",
      "AI Associate",
      "Agentforce Sales Foundations",
      "Marketing Cloud Engagement Foundations",
      "Marketing Cloud Account Engagement Foundations",
      "MuleSoft Integration Foundations",
      "Tableau Desktop Foundations",
    ],
  },
  {
    track: "Administrator",
    certifications: [
      "Platform Administrator",
      "Platform Administrator II",
      "Platform App Builder",
      "Business Analyst",
      "CPQ Administrator",
      "Marketing Cloud Engagement Administrator",
      "Slack Administrator",
      "Tableau Server Administrator",
    ],
  },
  {
    track: "Developer",
    certifications: [
      "Platform Developer",
      "Platform Developer II",
      "JavaScript Developer",
      "OmniStudio Developer",
      "Industries CPQ Developer",
      "B2C Commerce Developer",
      "Marketing Cloud Engagement Developer",
      "MuleSoft Developer",
      "MuleSoft Developer II",
      "MuleSoft Hyperautomation Developer",
      "Slack Developer",
    ],
  },
  {
    track: "Consultant",
    certifications: [
      "Agentforce Sales Consultant",
      "Agentforce Service Consultant",
      "Agentforce Field Service and Operations Consultant",
      "Agentforce Nonprofit Consultant",
      "Experience Cloud Consultant",
      "Data Cloud Consultant",
      "Education Cloud Consultant",
      "Nonprofit Success Pack Consultant",
      "OmniStudio Consultant",
      "Revenue Management Consultant",
      "CRM Analytics and Einstein Discovery Consultant",
      "Marketing Cloud Engagement Consultant",
      "Marketing Cloud Account Engagement Consultant",
      "MuleSoft Catalyst Consultant",
      "Slack Consultant",
      "Tableau Consultant",
      "Tableau Data Analyst",
    ],
  },
  {
    track: "Architect",
    certifications: [
      "Platform Data Architect",
      "Platform Sharing and Visibility Architect",
      "Platform Integration Architect",
      "Platform Identity and Access Management Architect",
      "Platform Development Lifecycle and Deployment Architect",
      "Application Architect",
      "System Architect",
      "B2B Solution Architect",
      "B2C Solution Architect",
      "B2C Commerce Architect",
      "Heroku Architect",
      "MuleSoft Platform Architect",
      "MuleSoft Integration Architect",
      "Tableau Architect",
      "Technical Architect",
    ],
  },
  {
    track: "Designer",
    certifications: ["Platform User Experience Designer", "Platform Strategy Designer"],
  },
  {
    track: "Marketing and AI",
    certifications: [
      "Agentforce Specialist",
      "Marketing Cloud Engagement Specialist",
      "Marketing Cloud Account Engagement Specialist",
    ],
  },
];

/**
 * For somebody who wants certification help but not one specific exam.
 *
 * Kept as an explicit option rather than left to a free-text box. Plenty of
 * people arrive knowing they want to certify and not yet which one — that is a
 * perfectly good enquiry, and forcing a choice would make them either guess or
 * leave. Both are worse than telling the sales team "not sure yet".
 */
export const CERTIFICATION_UNDECIDED = "Not sure yet — help me choose";

/** Every accepted value, flattened. The order is the display order. */
export const CERTIFICATION_OPTIONS: readonly string[] = [
  ...CERTIFICATION_TRACKS.flatMap((group) => group.certifications),
  CERTIFICATION_UNDECIDED,
];

const ACCEPTED = new Set(CERTIFICATION_OPTIONS);

/**
 * Validated against the catalogue rather than accepted as free text.
 *
 * The form only offers these, so anything else is either a stale client or
 * somebody posting by hand — and in both cases the honest answer is to reject it
 * rather than file an enquiry naming a credential that does not exist.
 *
 * The trade-off is that retiring a name here rejects a form still open in a
 * browser somewhere. That is acceptable: the message says what to do, and the
 * alternative is silently accepting names we have decided we do not support.
 */
export const certificationSchema = z
  .string()
  .trim()
  .refine((value) => ACCEPTED.has(value), "Please pick a certification from the list.");

/**
 * What kind of help they want, as distinct from which exam.
 *
 * A fixed set of checkboxes rather than a second free-text box, because these
 * are different engagements: a study plan is a conversation, a weak topic is a
 * tutorial, a mock exam is an afternoon, and a retake after failing needs
 * someone who will ask what went wrong first. The sales team routes on this, so
 * it has to be answerable in one glance and countable afterwards.
 *
 * The `value` is what gets stored and what Salesforce's picklist holds; the
 * `label` is what the customer reads. Two strings rather than one because the
 * useful phrasing for a person ("I keep failing specific topics") makes a poor
 * report axis, and the reportable phrasing makes a cold checkbox.
 */
export interface CertificationHelpOption {
  readonly value: string;
  readonly label: string;
}

export const CERTIFICATION_HELP_OPTIONS: readonly CertificationHelpOption[] = [
  { value: "Study plan", label: "A study plan — where to start and in what order" },
  { value: "Weak topics", label: "Specific topics that are not landing" },
  { value: "Hands-on practice", label: "Hands-on practice in a real org" },
  { value: "Mock exams", label: "Mock exams and practice questions" },
  { value: "Retake after failing", label: "I have sat it and failed — help me pass it" },
  { value: "Exam-day strategy", label: "Exam-day strategy and timing" },
];

const ACCEPTED_HELP = new Set(CERTIFICATION_HELP_OPTIONS.map((option) => option.value));

/**
 * At least one, because the whole point of asking is to know.
 *
 * Capped at the length of the list rather than left unbounded: the form cannot
 * produce more, so a longer array is a hand-rolled request and there is no
 * reading of it that helps anyone.
 */
export const certificationHelpSchema = z
  .array(
    z
      .string()
      .trim()
      .refine((value) => ACCEPTED_HELP.has(value), "not an option we offer"),
  )
  .min(1, "Tell us what you need help with.")
  .max(CERTIFICATION_HELP_OPTIONS.length);
