import { useMemo } from "react";

import type { MatchStateMessage } from "@/types/match";

import { Cell } from "./Cell";
import styles from "./Board.module.css";

interface BoardProps {
  state: MatchStateMessage;
  interactive: boolean;
  onPlay(index: number): void;
}

export function Board({ state, interactive, onPlay }: BoardProps) {
  const winningSet = useMemo(() => new Set(state.winningLine ?? []), [state.winningLine]);

  return (
    <div className={styles.wrap}>
      <div className={styles.grid} role="grid" aria-label="Tic tac toe board">
        {state.board.map((mark, i) => (
          <Cell
            key={i}
            index={i}
            mark={mark}
            interactive={interactive}
            winning={winningSet.has(i)}
            onPlay={onPlay}
          />
        ))}
      </div>
      {state.winningLine && state.winningLine.length === 3 ? (
        <WinningLineOverlay line={state.winningLine as [number, number, number]} />
      ) : null}
    </div>
  );
}

function WinningLineOverlay({ line }: { line: [number, number, number] }) {
  const [from, , to] = line;
  const start = cellCenter(from);
  const end = cellCenter(to);
  return (
    <svg className={styles.line} viewBox="0 0 100 100" preserveAspectRatio="none">
      <path
        className={styles.linePath}
        d={`M ${start.x} ${start.y} L ${end.x} ${end.y}`}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function cellCenter(index: number): { x: number; y: number } {
  const col = index % 3;
  const row = Math.floor(index / 3);
  const step = 100 / 3;
  return {
    x: step * col + step / 2,
    y: step * row + step / 2,
  };
}
