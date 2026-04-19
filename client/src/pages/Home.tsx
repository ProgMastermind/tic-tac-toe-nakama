import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { ModeToggle } from "@/components/ui/ModeToggle";
import { TextInput } from "@/components/ui/TextInput";
import { useNakama } from "@/context/NakamaProvider";
import type {
  CreatePrivateMatchRequest,
  CreatePrivateMatchResponse,
  GameMode,
  JoinPrivateMatchRequest,
  JoinPrivateMatchResponse,
} from "@/types/match";

import styles from "./Home.module.css";

/**
 * Home is the lobby. Three entry points into a match:
 *
 *   1. Find a match → the Nakama matchmaker pairs the caller with another
 *      random player on the same mode and auto-navigates both into the
 *      new authoritative match when the pairing resolves.
 *   2. Create a private room → opens an authoritative match with a
 *      shareable 4-character code.
 *   3. Join with a code → hops into an existing private room.
 */
export default function Home() {
  const {
    client,
    session,
    socket,
    displayName,
    setDisplayName,
    registerMatchmakerMatchedHandler,
  } = useNakama();
  const navigate = useNavigate();

  const [mode, setMode] = useState<GameMode>("classic");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  // Matchmaker flow state. `ticket` is non-null while a search is in
  // progress. A ref mirrors it so the unmount cleanup and the matched
  // callback both see the live value without stale-closure gymnastics.
  const [ticket, setTicket] = useState<string | null>(null);
  const [matchmaking, setMatchmaking] = useState(false);
  const ticketRef = useRef<string | null>(null);
  const modeRef = useRef<GameMode>(mode);

  useEffect(() => {
    ticketRef.current = ticket;
  }, [ticket]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const searching = ticket !== null;
  const anyBusy = creating || joining || matchmaking || searching;

  // ---- Matchmaker: subscribe to matched notifications ----------------
  //
  // We register once on mount; the handler navigates whenever a match
  // arrives that corresponds to our outstanding ticket. The server is
  // the source of truth for match assignment, so we don't try to match
  // ticket ids too defensively — any matched notification while we're
  // still subscribed was meant for us.
  useEffect(() => {
    const unsubscribe = registerMatchmakerMatchedHandler((matched) => {
      // nakama-js exposes snake_case on event payloads.
      const matchId = (matched as { match_id?: string }).match_id;
      const token = (matched as { token?: string }).token;
      if (!matchId) return;

      ticketRef.current = null;
      setTicket(null);
      setMatchmaking(false);

      const params = new URLSearchParams();
      if (token) params.set("t", token);
      params.set("mm", "1"); // flag that this was a matchmaker origin
      const query = params.toString();
      navigate(`/game/${matchId}${query ? `?${query}` : ""}`);
    });
    return unsubscribe;
  }, [navigate, registerMatchmakerMatchedHandler]);

  // ---- Unmount safety: if the user navigates away mid-search, cancel
  //      the ticket so they don't get dropped into a stale match later.
  useEffect(() => {
    return () => {
      const stale = ticketRef.current;
      if (stale && socket) {
        socket.removeMatchmaker(stale).catch(() => {});
      }
    };
  }, [socket]);

  // ---- Find a match --------------------------------------------------
  const handleFindMatch = useCallback(async () => {
    if (!socket) return;
    setLobbyError(null);
    setMatchmaking(true);
    try {
      // String properties surface under `properties.*` in the query DSL.
      // Pinning +properties.mode:<mode> on both sides guarantees the
      // server only matches compatible players.
      const resp = await socket.addMatchmaker(
        `+properties.mode:${mode}`,
        /*minCount*/ 2,
        /*maxCount*/ 2,
        { mode },
        {},
      );
      ticketRef.current = resp.ticket;
      setTicket(resp.ticket);
    } catch (err) {
      setLobbyError(await formatRpcError(err, "Matchmaker is unreachable."));
    } finally {
      setMatchmaking(false);
    }
  }, [socket, mode]);

  const handleCancelMatchmaking = useCallback(async () => {
    const current = ticketRef.current;
    if (!socket || !current) return;
    try {
      await socket.removeMatchmaker(current);
    } catch {
      // Ticket may have already matched between click and remove; treat
      // the client-side state as the source of truth for UI.
    } finally {
      ticketRef.current = null;
      setTicket(null);
    }
  }, [socket]);

  // ---- Create private room ------------------------------------------
  const handleCreate = useCallback(async () => {
    if (!session) return;
    setLobbyError(null);
    setCreating(true);
    try {
      const req: CreatePrivateMatchRequest = { mode };
      const response = await client.rpc(session, "create_private_match", req);
      const parsed = parseRpc<CreatePrivateMatchResponse>(response.payload);
      navigate(`/game/${parsed.matchId}?code=${parsed.code}`);
    } catch (err) {
      setLobbyError(await formatRpcError(err, "Couldn't open a new room."));
    } finally {
      setCreating(false);
    }
  }, [client, session, mode, navigate]);

  // ---- Join with code ------------------------------------------------
  const handleJoin = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!session) return;
      setLobbyError(null);
      setCodeError(null);
      const trimmed = code.trim().toUpperCase();
      if (trimmed.length !== 4) {
        setCodeError("Room codes are 4 characters.");
        return;
      }
      setJoining(true);
      try {
        const req: JoinPrivateMatchRequest = { code: trimmed };
        const response = await client.rpc(session, "join_private_match", req);
        const parsed = parseRpc<JoinPrivateMatchResponse>(response.payload);
        navigate(`/game/${parsed.matchId}`);
      } catch (err) {
        setCodeError(await formatRpcError(err, "No open room with that code."));
      } finally {
        setJoining(false);
      }
    },
    [client, session, code, navigate],
  );

  return (
    <main className={`app-shell ${styles.screen}`}>
      <header className={styles.masthead}>
        <span className={`eyebrow ${styles.eyebrow}`}>
          <span className={styles.eyebrowDot} aria-hidden />
          A classic, reimagined
        </span>
        <h1 className={styles.title}>
          Tic tac toe,
          <br />
          <span className={styles.titleItalic}>played properly.</span>
        </h1>
        <p className={styles.subtitle}>
          A two-player board built on a server-authoritative backend. Every
          move is validated on Nakama before the board updates — no turns
          stolen, no cells overwritten, no ghosts on the wire.
        </p>
        <DisplayNameStrip
          displayName={displayName}
          onSave={setDisplayName}
        />
      </header>

      <section className={styles.card} aria-label="Start playing">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Start a game</h2>
          <p className={styles.cardLead}>
            Pick a mode and find an opponent — or spin up a private room
            to play with a specific friend.
          </p>
        </div>

        <ModeToggle value={mode} onChange={setMode} disabled={anyBusy} />

        {searching ? (
          <div className={styles.searching} role="status" aria-live="polite">
            <span className={styles.searchingDot} aria-hidden />
            <span className={styles.searchingText}>
              <span className={styles.searchingTitle}>
                Finding a {mode} opponent…
              </span>
              <span className={styles.searchingSub}>
                Matchmaker is live. You&rsquo;ll be dropped in automatically.
              </span>
            </span>
            <Button
              variant="ghost"
              size="md"
              onClick={handleCancelMatchmaking}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="lg"
            block
            onClick={handleFindMatch}
            loading={matchmaking}
            disabled={!socket || !session || anyBusy}
          >
            Find a match
          </Button>
        )}

        {lobbyError ? (
          <p role="alert" className={styles.cardError}>
            {lobbyError}
          </p>
        ) : null}

        <div className={styles.divider}>or play with a friend</div>

        <Button
          variant="secondary"
          size="lg"
          block
          onClick={handleCreate}
          loading={creating}
          disabled={!session || joining || searching || matchmaking}
        >
          Create a private room
        </Button>

        <form onSubmit={handleJoin} noValidate>
          <div className={styles.joinRow}>
            <TextInput
              mono
              label="Join with a code"
              placeholder="ABCD"
              maxLength={4}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeError(null);
              }}
              error={codeError}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
            <Button
              variant="secondary"
              size="lg"
              type="submit"
              loading={joining}
              disabled={
                !session ||
                creating ||
                searching ||
                matchmaking ||
                code.trim().length !== 4
              }
            >
              Join
            </Button>
          </div>
        </form>
      </section>

      <footer className={styles.footer}>
        <span>© Tic Tac Toe · Nakama authoritative backend</span>
        <span className={styles.statusDot}>
          <span className={styles.statusDotMark} aria-hidden />
          connected
        </span>
      </footer>
    </main>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Inline display-name editor. Collapsed into a tag showing the current
 * name; clicking opens a small form. Kept out of a modal because a modal
 * here would feel disproportionate for one field.
 */
function DisplayNameStrip({
  displayName,
  onSave,
}: {
  displayName: string;
  onSave(name: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSave(value);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className={styles.mastheadMeta}>
        <span>playing as</span>
        <button
          type="button"
          className={styles.mastheadMetaEdit}
          onClick={() => {
            setValue(displayName);
            setEditing(true);
          }}
        >
          {displayName || "Set a name"}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={styles.nameForm}>
      <TextInput
        label="Display name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={24}
        autoFocus
        error={error}
      />
      <Button type="submit" size="md" loading={saving}>
        Save
      </Button>
      <Button
        type="button"
        size="md"
        variant="ghost"
        onClick={() => {
          setValue(displayName);
          setError(null);
          setEditing(false);
        }}
      >
        Cancel
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* RPC helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * client.rpc returns payload typed as `object | undefined` on success —
 * but server-side our handlers return a JSON *string*, which nakama-js
 * forwards verbatim. Handle both shapes so we're resilient to a future
 * SDK behaviour change.
 */
function parseRpc<T>(payload: object | string | undefined): T {
  if (payload == null) throw new Error("empty response");
  if (typeof payload === "string") return JSON.parse(payload) as T;
  return payload as T;
}

/**
 * Nakama errors bubble through .json() on the HTTP client. Fall back to
 * the default message if we can't extract a server-side message.
 */
async function formatRpcError(err: unknown, fallback: string): Promise<string> {
  if (err && typeof err === "object" && "json" in err) {
    try {
      const body = (await (err as { json: () => Promise<{ message?: string }> }).json()) ?? {};
      if (body?.message) return body.message;
    } catch {
      // fall through
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
