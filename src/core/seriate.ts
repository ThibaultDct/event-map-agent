/**
 * Sériation : réordonne les lignes/colonnes d'une matrice d'adjacence pour
 * rapprocher les nœuds qui échangent entre eux.
 *
 * C'est ce qui distingue une matrice utile d'un damier. Dans l'ordre naturel
 * (alphabétique, ou d'arrivée de l'API), les cellules pleines sont dispersées et
 * l'œil ne voit rien. Après sériation, les groupes fortement couplés — les
 * contextes bornés — forment des blocs sur la diagonale, et les consommateurs
 * transverses se lisent comme des colonnes pleines.
 *
 * L'optimum est NP-difficile ; on utilise l'heuristique classique du plus proche
 * voisin sur la similarité cosinus des vecteurs de voisinage, amorcée par le
 * nœud de plus haut degré. Déterministe, O(n²·d), largement suffisant jusqu'à
 * quelques centaines de services.
 */
export interface SeriationInput {
  ids: string[];
  /** Poids de l'arête from→to. 0 ou absent = pas d'arête. */
  weight: (from: string, to: string) => number;
}

export function seriate({ ids, weight }: SeriationInput): string[] {
  if (ids.length <= 2) return [...ids];

  // Vecteur de voisinage non orienté : deux services qui parlent aux mêmes
  // tiers doivent se retrouver côte à côte, même s'ils ne se parlent pas.
  const vectors = new Map<string, Float64Array>();
  const norms = new Map<string, number>();
  for (const a of ids) {
    const v = new Float64Array(ids.length);
    ids.forEach((b, i) => {
      v[i] = (weight(a, b) > 0 ? 1 : 0) + (weight(b, a) > 0 ? 1 : 0);
    });
    vectors.set(a, v);
    let n = 0;
    for (const x of v) n += x * x;
    norms.set(a, Math.sqrt(n));
  }

  const similarity = (a: string, b: string): number => {
    const va = vectors.get(a)!;
    const vb = vectors.get(b)!;
    const denom = norms.get(a)! * norms.get(b)!;
    if (denom === 0) return 0;
    let dot = 0;
    for (let i = 0; i < va.length; i++) dot += va[i]! * vb[i]!;
    return dot / denom;
  };

  const degree = (a: string): number => {
    let d = 0;
    for (const b of ids) {
      if (a === b) continue;
      if (weight(a, b) > 0) d++;
      if (weight(b, a) > 0) d++;
    }
    return d;
  };

  // Départ sur le nœud le plus connecté : il ancre l'ordre. À degré égal, on
  // départage par identifiant pour que deux runs donnent le même résultat —
  // sinon la matrice se réorganiserait à chaque scan et le diff serait inutile.
  const remaining = [...ids].sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));
  const out: string[] = [remaining.shift()!];

  while (remaining.length > 0) {
    const last = out[out.length - 1]!;
    let bestIdx = 0;
    let bestSim = -1;
    for (let i = 0; i < remaining.length; i++) {
      const s = similarity(last, remaining[i]!);
      if (s > bestSim) {
        bestSim = s;
        bestIdx = i;
      }
    }
    out.push(remaining.splice(bestIdx, 1)[0]!);
  }

  return out;
}
