export const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l";
export const EXIT_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";
export const HOME_AND_CLEAR = "\x1b[H\x1b[2J";

interface TerminalWriter {
	write: (chunk: string) => void;
}

export class TerminalViewport {
	private entered = false;
	private lastFrame = "";

	public constructor(private readonly writer: TerminalWriter) {}

	public enter(): void {
		if (this.entered) return;
		this.entered = true;
		this.writer.write(ENTER_ALT_SCREEN);
	}

	public render(frame: string, options: { force?: boolean } = {}): boolean {
		if (!this.entered) this.enter();
		const force = options.force === true;
		if (!force && frame === this.lastFrame) return false;
		this.lastFrame = frame;
		this.writer.write(`${HOME_AND_CLEAR}${frame}`);
		return true;
	}

	public exit(): void {
		if (!this.entered) return;
		this.entered = false;
		this.lastFrame = "";
		this.writer.write(EXIT_ALT_SCREEN);
	}
}
