/**
 * The Component Library logo: a pink pixel-art puzzle piece with Pac-Man
 * ghost eyes and a white pixel star, in a 2001 8-bit style. One drawing,
 * used wherever the logo appears.
 */
const PIECE = ["..XX....", "..XX....", "XXXXXX..", "XXXXXXXX", "XXXXXX..", "..XX....", "..XX...."];
const STAR: [number, number][] = [[24, 0], [22, 2], [24, 2], [26, 2], [24, 4]];
// Ghost eyes, drawn in finer pixels (1 unit): white with the corners cut, blue pupils looking right.
const EYE = [".XX.", "XXXX", "XXXX", "XXXX", ".XX."];
const EYES: [number, number][] = [[3, 10], [10, 10]];

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="-2 -2 30 30" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {PIECE.flatMap((row, y) => [...row].map((c, x) => c === "X" && (
        <rect key={`${x}-${y}`} x={x * 3} y={y * 3 + 3} width={3} height={3} fill={(x + y) % 3 ? "#ff4fb8" : "#ff8fd0"} />
      )))}
      {EYES.flatMap(([ex, ey]) => [
        ...EYE.flatMap((row, y) => [...row].map((c, x) => c === "X" && <rect key={`e${ex}-${x}-${y}`} x={ex + x} y={ey + y} width={1} height={1} fill="#fff" />)),
        <rect key={`p${ex}`} x={ex + 2} y={ey + 2} width={2} height={2} fill="#2121ff" />,
      ])}
      {STAR.map(([x, y]) => <rect key={`s${x}-${y}`} x={x} y={y} width={2} height={2} fill="#fff" />)}
    </svg>
  );
}
