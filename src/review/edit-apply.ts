/**
 * Pure helper that applies one or more exact oldText → newText replacements
 * to file content. Ported from Pi's `edit` tool semantics:
 *  - edits are matched against the ORIGINAL content (not incrementally)
 *  - each oldText must be unique
 *  - edits must not overlap
 *  - replacements are applied in reverse order so offsets stay stable
 */

export interface TextEditOp {
	oldText: string;
	newText: string;
}

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlf = content.indexOf("\r\n");
	const lf = content.indexOf("\n");
	if (lf === -1) return "\n";
	if (crlf === -1) return "\n";
	return crlf < lf ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

export interface ApplyEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Apply edits to `originalContent`, throwing descriptive errors (mirroring
 * Pi's messages) when an edit cannot be matched uniquely or overlaps.
 *
 * Line endings: matching happens in LF-normalized space (so the model's LF
 * oldText matches CRLF files). Unchanged original segments keep their original
 * line endings; only new text introduced by `newText` stays LF (the model's
 * replacement bytes are preserved verbatim).
 */
export function applyEditsToContent(
	originalContent: string,
	edits: TextEditOp[],
	path: string,
): string {
	const { bom, text } = stripBom(originalContent);
	const ending = detectLineEnding(text);
	const normalized = normalizeToLF(text);

	const normEdits = edits.map((e) => ({
		oldText: normalizeToLF(e.oldText),
		newText: normalizeToLF(e.newText),
	}));

	for (let i = 0; i < normEdits.length; i++) {
		if (normEdits[i].oldText.length === 0) {
			throw new Error(
				normEdits.length === 1
					? `oldText must not be empty in ${path}.`
					: `edits[${i}].oldText must not be empty in ${path}.`,
			);
		}
	}

	// Find each oldText in the normalized original; require uniqueness.
	// `matches` offsets are in NORMALIZED space; we later map them back to
	// original byte offsets so CRLF is preserved in untouched segments.
	const matches: Array<{ index: number; len: number; newText: string }> = [];
	for (let i = 0; i < normEdits.length; i++) {
		const oldText = normEdits[i].oldText;
		let idx = normalized.indexOf(oldText);
		if (idx === -1) {
			throw new Error(
				normEdits.length === 1
					? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
					: `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
			);
		}
		let count = 0;
		let from = 0;
		for (;;) {
			const at = normalized.indexOf(oldText, from);
			if (at === -1) break;
			count++;
			from = at + oldText.length;
		}
		if (count > 1) {
			throw new Error(
				normEdits.length === 1
					? `Found ${count} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
					: `Found ${count} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
			);
		}
		matches.push({ index: idx, len: oldText.length, newText: normEdits[i].newText });
	}

	// Detect overlap (normalized space).
	matches.sort((a, b) => a.index - b.index);
	for (let i = 1; i < matches.length; i++) {
		const prev = matches[i - 1];
		const cur = matches[i];
		if (prev.index + prev.len > cur.index) {
			throw new Error(
				`edits[${i - 1}] and edits[${i}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	// Map normalized offsets → original offsets. Normalization only rewrites
	// line-ending bytes (CRLF→LF, CR→LF), so we can walk both strings: every
	// normalized character is either identical to the original character or the
	// LF half of a rewritten CRLF/CR. origPos[i] = original offset where
	// normalized[i] starts.
	const origPos: number[] = new Array(normalized.length);
	{
		let o = 0;
		for (let i = 0; i < normalized.length; i++) {
			origPos[i] = o;
			if (text.charCodeAt(o) === 0x0d) {
				// CR in original; normalized has just the LF (or a lone LF for CR).
				o += text.charCodeAt(o + 1) === 0x0a ? 2 : 1;
			} else {
				o += 1;
			}
		}
	}
	function toOriginal(offset: number): number {
		if (offset < origPos.length) return origPos[offset];
		return text.length; // end of content
	}

	// Build the result directly: keep ORIGINAL bytes for untouched segments
	// (preserving CRLF), splice in the model's newText for matched regions.
	const parts: string[] = [];
	let cursor = 0; // original-space cursor
	let changed = false;
	for (const m of matches) {
		const start = toOriginal(m.index);
		const end = toOriginal(m.index + m.len);
		parts.push(text.slice(cursor, start));
		parts.push(m.newText);
		cursor = end;
		if (m.newText !== text.slice(start, end)) changed = true;
	}
	parts.push(text.slice(cursor));
	const result = parts.join("");

	if (!changed) {
		throw new Error(
			`No changes made to ${path}. The replacements produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}

	return bom + result;
}
