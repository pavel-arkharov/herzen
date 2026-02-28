const ANSI_RESET = "\x1b[0m";

export function printableWidth(value: string): number {
	let width = 0;
	let cursor = 0;
	while (cursor < value.length) {
		const ansi = readAnsiSequence(value, cursor);
		if (ansi) {
			cursor = ansi.next;
			continue;
		}
		const codePoint = value.codePointAt(cursor);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		width += codePointWidth(codePoint, char);
		cursor += char.length;
	}
	return width;
}

export function truncateAnsi(value: string, maxWidth: number, ellipsis = "..."): string {
	if (!Number.isFinite(maxWidth) || maxWidth <= 0) return "";
	const fullWidth = printableWidth(value);
	if (fullWidth <= maxWidth) return value;

	const ellipsisWidth = printableWidth(ellipsis);
	if (maxWidth <= ellipsisWidth) {
		return ellipsis.slice(0, Math.max(0, maxWidth));
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let width = 0;
	let cursor = 0;
	let output = "";
	let hasAnsi = false;

	while (cursor < value.length) {
		const ansi = readAnsiSequence(value, cursor);
		if (ansi) {
			hasAnsi = true;
			output += ansi.sequence;
			cursor = ansi.next;
			continue;
		}

		const codePoint = value.codePointAt(cursor);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		const charWidth = codePointWidth(codePoint, char);
		if (charWidth > 0 && width + charWidth > targetWidth) break;
		output += char;
		width += charWidth;
		cursor += char.length;
	}

	output += ellipsis;
	if (hasAnsi && !output.endsWith(ANSI_RESET)) {
		output += ANSI_RESET;
	}
	return output;
}

export function wrapAnsi(value: string, maxWidth: number): string[] {
	if (!Number.isFinite(maxWidth) || maxWidth <= 0) return [""];
	if (value.length === 0) return [""];

	const lines: string[] = [];
	let cursor = 0;
	let current = "";
	let currentWidth = 0;
	let hasAnsiInCurrent = false;
	const activeSgr: string[] = [];

	const pushLine = () => {
		let line = current;
		if (hasAnsiInCurrent && !line.endsWith(ANSI_RESET)) {
			line += ANSI_RESET;
		}
		lines.push(line);
		current = activeSgr.join("");
		currentWidth = 0;
		hasAnsiInCurrent = current.length > 0;
	};

	while (cursor < value.length) {
		const ansi = readAnsiSequence(value, cursor);
		if (ansi) {
			current += ansi.sequence;
			hasAnsiInCurrent = true;
			cursor = ansi.next;
			if (isSgrSequence(ansi.sequence)) {
				const payload = ansi.sequence.slice(2, -1);
				if (!payload || payload === "0") {
					activeSgr.length = 0;
				} else {
					activeSgr.push(ansi.sequence);
				}
			}
			continue;
		}

		const codePoint = value.codePointAt(cursor);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		if (char === "\n") {
			pushLine();
			cursor += char.length;
			continue;
		}

		const charWidth = codePointWidth(codePoint, char);
		if (charWidth > 0 && currentWidth + charWidth > maxWidth) {
			pushLine();
			continue;
		}

		current += char;
		currentWidth += charWidth;
		cursor += char.length;
	}

	if (current.length > 0 || lines.length === 0) {
		let line = current;
		if (hasAnsiInCurrent && !line.endsWith(ANSI_RESET)) {
			line += ANSI_RESET;
		}
		lines.push(line);
	}

	return lines;
}

function readAnsiSequence(
	value: string,
	start: number,
): { sequence: string; next: number } | null {
	if (value.charCodeAt(start) !== 0x1b) return null;
	if (value.charCodeAt(start + 1) !== 0x5b) return null;
	let cursor = start + 2;
	while (cursor < value.length) {
		const code = value.charCodeAt(cursor);
		if (code >= 0x40 && code <= 0x7e) {
			return {
				sequence: value.slice(start, cursor + 1),
				next: cursor + 1,
			};
		}
		cursor += 1;
	}
	return {
		sequence: value.slice(start),
		next: value.length,
	};
}

function isSgrSequence(sequence: string): boolean {
	return sequence.endsWith("m");
}

function codePointWidth(codePoint: number, char: string): number {
	if (codePoint === 0x0a || codePoint === 0x0d) return 0;
	if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
	if (/\p{Mark}/u.test(char)) return 0;
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2329 && codePoint <= 0x232a) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6)
	) {
		return 2;
	}
	return 1;
}
