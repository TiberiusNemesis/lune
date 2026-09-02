/**
 * lune branding: crescent moon header and a one-line identity in the system prompt.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText, rawKeyHint, VERSION } from "@earendil-works/pi-coding-agent";

const MOON = ["               ⠐⣄","                ⢸⣷⡀","                ⢘⣿⣷⡀","                ⢸⣿⣿⡇","               ⢀⣾⣿⣿⡗","              ⢀⣾⣿⣿⣿⡇","            ⢀⣴⣿⣿⣿⣿⡟","⢄⣀      ⢀⣀⣤⣶⣿⣿⣿⣿⣿⠟"," ⠙⠻⣿⣿⣾⣿⣿⣿⣿⣿⣿⣿⣿⡿⠛⠁","    ⠉⠙⠛⠛⠻⠛⠛⠛⠉⠁"];
// Dim stars drawn only where the moon leaves empty cells.
const STARS = ["   ·        ✦","✦        ·","      ·","  ✦","        ·","   ·","✦","","","                 ·"];
const MOON_WIDTH = 23;

function sky(theme: Theme, row: number): string {
	let out = "";
	for (let col = 0; col < MOON_WIDTH; col++) {
		const m = MOON[row]?.[col] ?? " ";
		const s = STARS[row]?.[col] ?? " ";
		out += m !== " " ? theme.fg("accent", m) : s !== " " ? theme.fg("dim", s) : " ";
	}
	return out;
}

function header(theme: Theme): string[] {
	const hints = [
		keyHint("app.interrupt", "interrupt"),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
	].join(theme.fg("muted", " · "));
	const beside = new Map([
		[3, theme.bold(theme.fg("accent", "lune")) + theme.fg("dim", ` v${VERSION}`)],
		[4, hints],
	]);
	return MOON.map((_, i) => sky(theme, i) + (beside.get(i) ?? ""));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render: () => header(theme),
			invalidate() {},
		}));
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `You are lune, the Hexweavers coding agent, built on pi. Refer to yourself as lune.\n\n${event.systemPrompt}`,
	}));
}
