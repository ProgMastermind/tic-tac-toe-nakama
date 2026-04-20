import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/Button";
import { ModeToggle } from "@/components/ui/ModeToggle";
import { Rule } from "@/components/ui/Rule";
import { SectionHead } from "@/components/ui/SectionHead";
import { TextInput } from "@/components/ui/TextInput";
import { useNakama } from "@/context/NakamaProvider";
import { useStats } from "@/hooks/useStats";
import type {
  CreatePrivateMatchRequest,
  CreatePrivateMatchResponse,
  GameMode,
  JoinPrivateMatchRequest,
  JoinPrivateMatchResponse,
  StatsSummary,
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
    status,
    displayName,
    setDisplayName,
    registerMatchmakerMatchedHandler,
  } = useNakama();
  const { stats } = useStats();
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

  const connected = status === "ready";

  return (
    <main className={`app-shell ${styles.screen}`}>
      <div className={styles.brandbar}>
        <Wordmark size="md" />
        <div className={styles.brandbarMeta}>
          <DisplayNameStrip displayName={displayName} onSave={setDisplayName} />
          <span className={styles.connectedDot}>
            <span className={styles.connectedDotMark} aria-hidden />
            {connected ? "connected" : "connecting…"}
          </span>
        </div>
      </div>

      <Rule />

      <div className={styles.layout}>
        <header className={styles.masthead}>
          <SectionHead numeral="I" eyebrow="A classic, reimagined" />
          <h1 className={styles.title}>
            Tic tac toe,
            <br />
            <span className={styles.titleItalic}>played properly.</span>
          </h1>
          <p className={`${styles.subtitle} dropCap`}>
            A two-player board built on a server-authoritative backend. Every
            move is validated on Nakama before the board updates — no turns
            stolen, no cells overwritten, no ghosts on the wire.
          </p>
        </header>

        <section className={styles.card} aria-label="Start playing">
          <SectionHead
            numeral="II"
            eyebrow="Start a game"
            title="Pick a mode"
          />
          <p className={styles.cardLead}>
            Classic is turn-based. Timed adds a 30-second clock per move —
            dawdle and the server hands the board to your opponent.
          </p>

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

          <Rule label="or play with a friend" />

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

        <RecordCard stats={stats} />
      </div>

      <footer className={styles.footer}>
        <Wordmark size="sm" />
        <nav className={styles.footerNav} aria-label="Secondary">
          <Link to="/leaderboard" className={styles.footerLink}>
            Leaderboard →
          </Link>
          <a
            className={styles.footerLink}
            href="https://github.com/ProgMastermind"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>
        <span>© Tic Tac Toe · Nakama</span>
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

/**
 * RecordCard replaces the old flat stats strip. Three column-blocks —
 * totals, streak, and mode split — separated by hairlines on desktop and
 * stacked with top-borders on mobile. Streak is accent-coloured only
 * while it's actually alive (>0) so the strip doesn't misrepresent a
 * cold start as a fresh streak. A "Streak live" chip surfaces the same
 * state at the card header for a second visual read.
 */
function RecordCard({ stats }: { stats: StatsSummary }) {
  const streakAlive = stats.currentStreak > 0;
  return (
    <aside className={styles.record} aria-label="Your record">
      <header className={styles.recordHead}>
        <span className={styles.recordEyebrow}>Your record</span>
        {streakAlive ? (
          <span className={styles.recordFlame}>
            <span className={styles.recordFlameDot} aria-hidden />
            Streak live
          </span>
        ) : null}
      </header>
      <div className={styles.recordGrid}>
        <div className={styles.recordCell}>
          <span className={styles.recordLabel}>Totals</span>
          <div className={styles.recordNumRow}>
            <span className={styles.recordNumStrong}>{stats.wins}</span>
            <span className={styles.recordNumSep}>·</span>
            <span className={styles.recordNum}>{stats.losses}</span>
            <span className={styles.recordNumSep}>·</span>
            <span className={styles.recordNum}>{stats.draws}</span>
          </div>
          <span className={styles.recordSubLabel}>wins · losses · draws</span>
        </div>
        <div className={styles.recordCell}>
          <span className={styles.recordLabel}>Streak</span>
          <div className={styles.recordNumRow}>
            <span
              className={`${styles.recordNumStrong} ${streakAlive ? styles.recordNumAccent : ""}`}
            >
              {stats.currentStreak}
            </span>
            <span className={styles.recordNumSep}>/</span>
            <span className={styles.recordNum}>{stats.bestStreak}</span>
          </div>
          <span className={styles.recordSubLabel}>current · best</span>
        </div>
        <div className={styles.recordCell}>
          <span className={styles.recordLabel}>By mode</span>
          <div className={styles.recordNumRow}>
            <span className={styles.recordNumStrong}>{stats.classicWins}</span>
            <span className={styles.recordNumSep}>/</span>
            <span className={styles.recordNum}>{stats.timedWins}</span>
          </div>
          <span className={styles.recordSubLabel}>classic · timed</span>
        </div>
      </div>
    </aside>
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
