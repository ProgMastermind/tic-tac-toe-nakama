import { useMemo } from "react";

import type { MatchStateMessage } from "@/types/match";

import { Cell } from "./Cell";
import styles from "./Board.module.css";

interface BoardProps {
  state: MatchStateMessage;
  interactive: boolean;
  onPlay(index: number): void;
}

/**
 * Board renders the 3x3 grid and the winning-line overlay. Interactivity
 * is driven externally — the Game page computes whether it's this
 * player's turn and passes `interactive` through. The board does not
 * guess the rules.
 */
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

/**
 * WinningLineOverlay draws a single stroke from the first cell of the
 * winning line to the last, through the centre of each. Coordinates are
 * percentages so the SVG scales with the board.
 */
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

// Centre of a cell on a 0..100 viewbox. Cells are laid out row-major
// with some padding; we approximate with equal thirds because the
// winning line sits on top of the grid, not inside it.
function cellCenter(index: number): { x: number; y: number } {
  const col = index % 3;
  const row = Math.floor(index / 3);
  const step = 100 / 3;
  return {
    x: step * col + step / 2,
    y: step * row + step / 2,
  };
}
