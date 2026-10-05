// A brief acceleration, steady canopy-supported descent, then a short touchdown approach.
// Integrating smooth velocity ramps gives continuous velocity AND acceleration at both joins.
export function canopyDescent(t) {
  t = Math.max(0, Math.min(1, t));
  const start = 0.10, stop = 0.22;
  let distance;
  if (t < start) {
    const u = t / start;
    distance = start * (u ** 3 - u ** 4 / 2);
  } else if (t <= 1 - stop) distance = t - start / 2;
  else {
    const u = (t - (1 - stop)) / stop;
    distance = 1 - stop - start / 2 + stop * (u - u ** 3 + u ** 4 / 2);
  }
  return distance / (1 - (start + stop) / 2);
}

// The sway and its derivative both vanish at the endpoints; arriving never snaps to centre.
export function canopySway(t) {
  t = Math.max(0, Math.min(1, t));
  const envelope = Math.sin(Math.PI * t) ** 2;
  const phase = t * Math.PI * 2;
  return { offset: Math.sin(phase) * envelope, roll: Math.sin(phase - 0.35) * envelope };
}
