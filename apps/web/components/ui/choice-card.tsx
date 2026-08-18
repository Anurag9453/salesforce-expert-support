import Link from "next/link";
import type { ReactNode } from "react";
import { Button, buttonClasses } from "./button.js";
import { Card, CardBody } from "./card.js";
import { LinkPending } from "./pending-link.js";

/**
 * A card presenting one option: badge, title, one-line lede, body, full-width
 * action.
 *
 * Shared rather than duplicated. The landing page and the intake wizard both
 * offer "here are your options, pick one", and they had drifted into two
 * different-looking answers to the same question — the landing page's version
 * used an eyebrow and a bordered panel, the wizard's a badge and a filled button.
 * Two visual languages for one idea, on consecutive screens.
 *
 * Vertical, and two to a row wherever it is used. `flex-1` on the body is what
 * makes the buttons line up: the text absorbs the height difference between a
 * two-line description and a four-line one, so cards side by side end level.
 *
 * ## Link or button
 *
 * `href` navigates; `onSelect` advances client-side state. Exactly one is
 * expected — the wizard's cards move between steps without a URL change, the
 * landing page's go to another route. Rendering a `<Link>` for a route and a
 * `<button>` for a callback keeps middle-click, right-click and prefetch working
 * where they should, which a div with an onClick would quietly break.
 */
type Common = {
  title: string;
  lede: string;
  body: string;
  badge: ReactNode;
  action: string;
};

export function ChoiceCard(
  props: Common & ({ href: string; onSelect?: never } | { onSelect: () => void; href?: never }),
) {
  const { title, lede, body, badge, action } = props;

  const content = (
    <>
      {badge}
      <h2 className="font-display mt-3 text-xl font-medium text-ink">{title}</h2>
      <p className="mt-1 text-sm font-medium text-ink-muted">{lede}</p>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-muted">{body}</p>
    </>
  );

  if (props.href !== undefined) {
    return (
      <Card interactive accent className="flex flex-col">
        {/*
          The whole card is the link, not just the button — a card that looks
          pressable should be pressable anywhere. The action below is styled as a
          button rather than being one, since a button inside a link is invalid
          markup and browsers disagree about what to do with it.
        */}
        <Link href={props.href} className="flex flex-1 flex-col">
          <CardBody className="flex flex-1 flex-col p-6">
            {content}
            <span className={buttonClasses({ size: "lg", className: "mt-5 w-full" })}>
              {action}
              <LinkPending />
            </span>
          </CardBody>
        </Link>
      </Card>
    );
  }

  return (
    <Card interactive accent className="flex flex-col">
      <CardBody className="flex flex-1 flex-col p-6">
        {content}
        <Button size="lg" className="mt-5 w-full" onClick={props.onSelect}>
          {action}
        </Button>
      </CardBody>
    </Card>
  );
}
