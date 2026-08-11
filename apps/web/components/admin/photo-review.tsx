"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardBody, Field, Textarea } from "@/components/ui";

/**
 * The photo moderation queue.
 *
 * Deliberately plain: a photo, an Approve button, and a Reject that demands a
 * reason. Reviewing faces is a task where the reviewer should be looking at the
 * image rather than at the interface.
 *
 * Oldest first, because someone whose photo has been pending for three days is
 * the person actually being kept waiting.
 */

interface PendingPhoto {
  id: string;
  expertProfileId: string;
  url: string;
  sizeBytes: number;
  contentType: string;
  uploadedAt: string | null;
}

export function PhotoReview() {
  const [items, setItems] = useState<PendingPhoto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/admin/photos");
      const body = await response.json();
      if (body.ok) setItems(body.data.items as PendingPhoto[]);
    } catch {
      setError("Could not load the queue.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: "approve" | "reject") {
    if (decision === "reject" && note.trim() === "") {
      setError("Tell them what to change.");
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/v1/admin/photos/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          decision === "approve" ? { decision } : { decision, note: note.trim() },
        ),
      });
      const body = await response.json();
      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      // Drop it locally rather than refetching — the reviewer's place in a long
      // queue should not jump because someone else uploaded meanwhile.
      setItems((current) => current.filter((item) => item.id !== id));
      setRejecting(null);
      setNote("");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded) return <p className="text-sm text-ink-muted">Loading…</p>;

  if (items.length === 0) {
    return (
      <Alert tone="success" title="Nothing waiting">
        Every uploaded photo has been reviewed.
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="text-sm text-ink-muted">
        {items.length} photo{items.length === 1 ? "" : "s"} waiting. Customers cannot see any of
        them until approved.
      </p>

      <ul className="stagger grid gap-4 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.id}>
            <Card>
              <CardBody className="space-y-3">
                <div className="flex gap-4">
                  {/* Signed, short-lived URL — next/image cannot fetch it. */}
                  <img
                    src={item.url}
                    alt="Awaiting review"
                    className="size-28 shrink-0 rounded-lg border border-border object-cover"
                  />
                  <div className="min-w-0 space-y-1.5">
                    <Badge tone="warning" dot>
                      Pending
                    </Badge>
                    <p className="text-xs text-ink-subtle">
                      {item.contentType.replace("image/", "").toUpperCase()} ·{" "}
                      {(item.sizeBytes / 1024).toFixed(0)} KB
                    </p>
                    {item.uploadedAt && (
                      <p className="text-xs text-ink-subtle">
                        <time dateTime={item.uploadedAt}>
                          {new Date(item.uploadedAt).toLocaleString()}
                        </time>
                      </p>
                    )}
                  </div>
                </div>

                {rejecting === item.id ? (
                  <div className="space-y-2">
                    <Field
                      id={`note-${item.id}`}
                      label="What should they change?"
                      hint="The expert sees this verbatim."
                      required
                    >
                      <Textarea
                        id={`note-${item.id}`}
                        rows={2}
                        value={note}
                        maxLength={500}
                        onChange={(event) => setNote(event.target.value)}
                      />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busyId === item.id}
                        onClick={() => void decide(item.id, "reject")}
                      >
                        Confirm rejection
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRejecting(null);
                          setNote("");
                        }}
                      >
                        Back
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busyId === item.id}
                      onClick={() => void decide(item.id, "approve")}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyId === item.id}
                      onClick={() => {
                        setRejecting(item.id);
                        setNote("");
                        setError(null);
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
