// What worker agents deliver for the demo's slugify task (clients/verifiers/slugify.py).

/** Worker A's delivery: folds accents, keeps ASCII letter/digit runs, joins them with single hyphens. */
export const SLUGIFY_PY = `import re
import unicodedata


def slugify(title):
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    return "-".join(re.findall(r"[a-z0-9]+", ascii_title.lower()))
`;

/** The failure beat: looks finished, but only swaps spaces for hyphens, so punctuation and accents leak through. */
export const BROKEN_SLUGIFY_PY = `def slugify(title):
    return title.strip().lower().replace(" ", "-")
`;

export const slugifyDeliverable = () => ({ code: SLUGIFY_PY });
export const brokenSlugify = () => ({ code: BROKEN_SLUGIFY_PY });

/** True when a task's verifier is the slugify test suite. */
export const isSlugifyTask = (verifier: { type: string; code?: string }) => verifier.type === 'python' && /\bslugify\b/.test(verifier.code ?? '');
