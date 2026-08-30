import { describe, expect, it } from "vitest";
import { sanitizeRequestText } from "../src/utils/sanitize-text.ts";

const FFFD = "\uFFFD";

describe("sanitizeRequestText", () => {
	it("returns empty string unchanged", () => {
		expect(sanitizeRequestText("")).toBe("");
	});

	it("passes plain ASCII through unchanged", () => {
		const input = "Puppy Vaccination Schedule UK — A First-Year Vaccine Plan for New Puppy Owners";
		expect(sanitizeRequestText(input)).toBe(input);
	});

	it("replaces a single U+FFFD with a single space and collapses the result", () => {
		// "Puppy Vaccination UK � A First-Year..." -> FFFD becomes " " ->
		// "Puppy Vaccination UK   A First-Year..." (3 spaces) -> collapse ->
		// "Puppy Vaccination UK A First-Year..."
		expect(sanitizeRequestText(`Puppy Vaccination UK ${FFFD} A First-Year Vaccine Plan`)).toBe(
			"Puppy Vaccination UK A First-Year Vaccine Plan",
		);
	});

	it("collapses the extra space that a single FFFD replacement leaves behind", () => {
		// "X � Y" -> "X  Y" (FFFD -> " ") then collapse -> "X Y"
		expect(sanitizeRequestText(`X ${FFFD} Y`)).toBe("X Y");
	});

	it("collapses runs of consecutive U+FFFD into a single space", () => {
		// 3x FFFD -> 1 space, no extra spaces left over
		expect(sanitizeRequestText(`X ${FFFD.repeat(3)} Y`)).toBe("X Y");
	});

	it("collapses the original surrounding spaces together with the replacement", () => {
		// "X  �  Y" -> "X       Y" after FFFD->" " -> "X Y" after collapse
		expect(sanitizeRequestText(`X  ${FFFD}  Y`)).toBe("X Y");
	});

	it("does not touch tab or newline characters", () => {
		const input = "line1\nline2\tindented";
		expect(sanitizeRequestText(input)).toBe(input);
	});

	it("replaces an unpaired high surrogate (U+D800) with a space", () => {
		expect(sanitizeRequestText(`before\uD800after`)).toBe("before after");
	});

	it("replaces an unpaired low surrogate (U+DC00) with a space", () => {
		expect(sanitizeRequestText(`before\uDC00after`)).toBe("before after");
	});

	it("preserves a valid surrogate pair (e.g. a 4-byte UTF-8 character)", () => {
		// 𝄞 (U+1D11E, MUSICAL SYMBOL G CLEF) is encoded in JS as the surrogate
		// pair "\uD834\uDD1E". The sanitizer must not split it.
		const input = "before \uD834\uDD1E after";
		expect(sanitizeRequestText(input)).toBe(input);
	});

	it("does not touch U+FFFE / U+FFFF (out of scope by design)", () => {
		// U+FFFE and U+FFFF are Unicode "non-characters" but they are not a
		// known source of provider 400s. The sanitizer is conservative and
		// leaves them alone.
		const input = "X \uFFFE Y \uFFFF Z";
		expect(sanitizeRequestText(input)).toBe(input);
	});

	it("handles a long string with many U+FFFD without quadratic behaviour", () => {
		// 10k FFFDs, each replaced with " ", then collapsed. Should be O(n),
		// not O(n^2). This is a smoke test against an accidental nested-loop
		// implementation; we just assert the result is correct.
		const input = FFFD.repeat(10_000);
		expect(sanitizeRequestText(input)).toBe(" ");
	});

	it("reproduces the original 'Puppy Vaccination UK ... for New' title fix", () => {
		// Exact shape of the user-reported 400: a real em-dash decoded as
		// Latin-1 twice produced U+FFFD. The pipeline should produce a
		// readable title that the provider will accept.
		const input = `Puppy Vaccination Schedule UK ${FFFD} A First-Year Vaccine Plan for New Puppy Owners`;
		expect(sanitizeRequestText(input)).toBe(
			"Puppy Vaccination Schedule UK A First-Year Vaccine Plan for New Puppy Owners",
		);
	});
});
