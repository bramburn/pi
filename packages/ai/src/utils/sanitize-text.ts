/**
 * Sanitize text content before it is sent to an LLM provider.
 *
 * Some providers reject requests that contain certain characters with a 400
 * "invalid params" error (e.g. MiniMax returns sub-code 2013). The two common
 * culprits in user-typed text are:
 *
 * - Unpaired UTF-16 surrogates (U+D800-U+DFFF): usually appear from a `String`
 *   built via `String.fromCharCode` with high values, or from a JSON parser
 *   that mishandled a 4-byte UTF-8 sequence. A surrogate that is NOT followed
 *   by a matching low surrogate (or vice versa) is invalid UTF-16 and can
 *   break tokenizers.
 * - U+FFFD REPLACEMENT CHARACTER: the standard "could not decode" marker. It
 *   shows up when source bytes were decoded as a non-matching encoding
 *   (e.g. UTF-8 read as Latin-1 then re-encoded) and the original character is
 *   unrecoverable.
 *
 * Both classes are replaced with a single space and any run of 2+ spaces that
 * the replacement leaves behind is collapsed to a single space. This keeps
 * surrounding tokens separated while producing a string the provider will
 * accept.
 *
 * Valid surrogate pairs (e.g. emoji, supplementary plane characters) are
 * preserved by walking the string by code point rather than by code unit.
 *
 * Tool call IDs and structured fields are NOT sanitized here; they go through
 * a separate path (e.g. Anthropic toolCallId normalization in
 * `api/transform-messages.ts`).
 *
 * The sanitizer is intentionally conservative: it touches only the two
 * character classes above. Control characters, format characters, and the
 * other Unicode "non-characters" (U+FFFE, U+FFFF, U+FDD0-U+FDEF) are left
 * alone — they are not a known source of provider 400s in pi and changing
 * them would risk corrupting legitimate content (e.g. zero-width joiners in
 * user-pasted text, ANSI escape sequences in tool output).
 */
export function sanitizeRequestText(text: string): string {
	if (text.length === 0) return text;

	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);

		// Preserve valid surrogate pairs (e.g. emoji, supplementary plane chars).
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += text[i] + text[i + 1];
				i++;
				continue;
			}
		}

		// Unpaired surrogate or U+FFFD -> single space.
		if ((code >= 0xd800 && code <= 0xdfff) || code === 0xfffd) {
			out += " ";
			continue;
		}

		out += text[i];
	}

	return out.replace(/ {2,}/g, " ");
}
