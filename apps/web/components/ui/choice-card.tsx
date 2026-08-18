"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button, buttonClasses } from "./button.js";
import { Card, CardBody } from "./card.js";
import { Spinner } from "./spinner.js";

/**
 * A card presenting one option: badge, title, one-line lede, body, full-width
 * action.
 *
 * Shared rather than duplicated. The landing page and the intake wizard both
 * offer "here are your options, pick one", and they had drifted into two
 * different-looking answers to the same question on consecutive screens.
 *
 * Vertical, and two to a row wherever it is used. `flex-1` on the body is what
 * makes the buttons line up: the text absorbs the height difference between a
 * two-line description and a four-line one, so cards side by side end level.
 *
 * ## Link or button
 *
 * `href` navigates; `onSelect` advances client-side state. Exactly one is
 * expected, enforced by the type. A `<Link>` for a route and a `<button>` for a
 * callback keeps middle-click, right-click and prefetch working where they
 * should, which a div with an onClick would quietly break.
 *
 * ## Why the pending state is tracked here rather than by the framework
 *
 * `useLinkStatus` and `loading.tsx` should both cover this, and neither showed
 * anything in production. The destination takes about three and a half seconds —
 * measured, not guessed — so the window is not the problem. Rather than keep
 * guessing at prefetch heuristics and router internals, this tracks the click
 * itself: `onClick` fires before the navigation starts, and the component
 * unmounts when the next page renders, so the spinner covers exactly the wait.
 *
 * The cost of being wrong here is small and self-correcting — a spinner that
 * appears on a click that turns out to be instant just flashes — while the cost
 * of showing nothing is a button that looks broken for three seconds.
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
  const [navigating, setNavigating] = useState(false);

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
          pressable should be pressable anywhere. The action is styled as a button
          rather than being one, because a <button> inside a link is invalid markup
          that browsers disagree about.
        */}
        <Link
          href={props.href}
          className="flex flex-1 flex-col"
          onClick={() => setNavigating(true)}
          aria-busy={navigating ? true : undefined}
        >
          <CardBody className="flex flex-1 flex-col p-6">
            {content}
            <span className={buttonClasses({ size: "lg", className: "mt-5 w-full" })}>
              {navigating ? <Spinner size="sm" /> : null}
              {navigating ? "Opening…" : action}
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
