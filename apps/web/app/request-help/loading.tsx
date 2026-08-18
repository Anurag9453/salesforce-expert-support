import { LoadingState } from "@/components/ui";

/**
 * The intake page reads pricing tiers before it can render, so there is a real
 * gap between the click and the form.
 *
 * Worth a specific message rather than a bare "Loading…": this is the first
 * thing a customer sees after deciding to ask for help, and it should look like
 * the product is doing something for them.
 */
export default function Loading() {
  return <LoadingState label="Getting things ready…" />;
}
