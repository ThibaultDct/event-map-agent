/**
 * Matching de routing key AMQP topic.
 *
 * Les règles RabbitMQ opèrent au niveau du *mot* (séparateur `.`) :
 *   `*` remplace exactement un mot
 *   `#` remplace zéro, un ou plusieurs mots
 *
 * L'approche naïve par regex casse sur les cas limites — notamment `a.#`, qui
 * matche `a` tout court chez RabbitMQ mais pas avec un `^a\..*$`. On fait donc
 * une programmation dynamique sur les mots, équivalente à un glob où `#` joue
 * le rôle de `*` et `*` celui de `?`.
 */
export function amqpMatch(pattern: string, key: string): boolean {
  const p = pattern.split('.');
  const k = key.split('.');

  // dp[j] = "les tokens de pattern consommés jusqu'ici couvrent exactement k[0..j)"
  let dp: boolean[] = new Array(k.length + 1).fill(false);
  dp[0] = true;

  for (const tok of p) {
    const next: boolean[] = new Array(k.length + 1).fill(false);
    for (let j = 0; j <= k.length; j++) {
      if (!dp[j]) continue;
      if (tok === '#') {
        // `#` absorbe de 0 à tous les mots restants.
        for (let n = j; n <= k.length; n++) next[n] = true;
      } else if (j < k.length && (tok === '*' || tok === k[j])) {
        next[j + 1] = true;
      }
    }
    dp = next;
  }

  return dp[k.length] === true;
}

/**
 * Vrai si la routing key contient un caractère de substitution, c'est-à-dire si
 * ce qu'on croit être une clé émise est en fait un pattern (erreur de collecte
 * fréquente quand on confond binding et publication).
 */
export function isPattern(key: string): boolean {
  return key.split('.').some((t) => t === '*' || t === '#');
}

/**
 * Spécificité d'un pattern, pour trier les bindings du plus précis au plus large
 * à l'affichage. Un mot littéral vaut plus qu'un `*`, qui vaut plus qu'un `#`.
 */
export function patternSpecificity(pattern: string): number {
  return pattern
    .split('.')
    .reduce((acc, t) => acc + (t === '#' ? 0 : t === '*' ? 1 : 3), 0);
}

/** Normalise un vhost pour l'URL de l'API management (`/` → `%2F`). */
export function encodeVhost(vhost: string): string {
  return encodeURIComponent(vhost);
}
