import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/Button";
import { ModeToggle } from "@/components/ui/ModeToggle";
import { Rule } from "@/components/ui/Rule";
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
  const [searchParams] = useSearchParams();

  // `?mode=classic|timed` preselects the toggle when arriving from EndOverlay's "Play again".
  const initialMode: GameMode =
    searchParams.get("mode") === "timed" ? "timed" : "classic";
  const [mode, setMode] = useState<GameMode>(initialMode);

  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  // Ref mirror of `ticket` so unmount cleanup and the matched callback
  // read the live value without stale-closure gymnastics.
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

  useEffect(() => {
    const unsubscribe = registerMatchmakerMatchedHandler((matched) => {
      const matchId = (matched as { match_id?: string }).match_id;
      const token = (matched as { token?: string }).token;
      if (!matchId) return;

      ticketRef.current = null;
      setTicket(null);
      setMatchmaking(false);

      const params = new URLSearchParams();
      if (token) params.set("t", token);
      params.set("mm", "1");
      const query = params.toString();
      navigate(`/game/${matchId}${query ? `?${query}` : ""}`);
    });
    return unsubscribe;
  }, [navigate, registerMatchmakerMatchedHandler]);

  // Cancel the matchmaker ticket on unmount so a stale pairing doesn't
  // land the user in a match after they've left the lobby.
  useEffect(() => {
    return () => {
      const stale = ticketRef.current;
      if (stale && socket) {
        socket.removeMatchmaker(stale).catch(() => {});
      }
    };
  }, [socket]);

  const handleFindMatch = useCallback(async () => {
    if (!socket) return;
    setLobbyError(null);
    setMatchmaking(true);
    try {
      const resp = await socket.addMatchmaker(
        `+properties.mode:${mode}`,
        2,
        2,
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
      // Ticket may have matched between click and remove — client state wins.
    } finally {
      ticketRef.current = null;
      setTicket(null);
    }
  }, [socket]);

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

      <header className={styles.masthead}>
        <span className={styles.eyebrow}>A classic, reimagined</span>
        <h1 className={styles.title}>
          Tic tac toe,
          <br />
          <span className={styles.titleItalic}>played properly.</span>
        </h1>
        <p className={styles.subtitle}>
          A two-player board built on a server-authoritative backend. Every
          move is validated on Nakama before the board updates.
        </p>
      </header>

      <section className={styles.card} aria-label="Start playing">
        <div className={styles.cardHead}>
          <span className={styles.cardEyebrow}>Start a game</span>
          <p className={styles.cardLead}>
            Classic is turn-based. Timed adds a 30-second clock per move —
            dawdle and the server hands the board to your opponent.
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
            <Button variant="ghost" size="md" onClick={handleCancelMatchmaking}>
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

function RecordCard({ stats }: { stats: StatsSummary }) {
  const streakAlive = stats.currentStreak > 0;
  return (
    <aside className={styles.record} aria-label="Your record">
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
      <Link to="/leaderboard" className={styles.recordLink}>
        <span className={styles.recordLinkEyebrow}>Global standings</span>
        <span>
          See the top players{" "}
          <span className={styles.recordLinkArrow} aria-hidden>
            →
          </span>
        </span>
      </Link>
    </aside>
  );
}

function parseRpc<T>(payload: object | string | undefined): T {
  if (payload == null) throw new Error("empty response");
  if (typeof payload === "string") return JSON.parse(payload) as T;
  return payload as T;
}

async function formatRpcError(err: unknown, fallback: string): Promise<string> {
  if (err && typeof err === "object" && "json" in err) {
    try {
      const body = (await (err as { json: () => Promise<{ message?: string }> }).json()) ?? {};
      if (body?.message) return body.message;
    } catch {}
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
