/**
 * The root prompt of a session — the human turn that started it — read from the
 * JSONL on demand.
 *
 * The index keeps only a 300-char label copy of that turn (`sessions.first_prompt`),
 * which is enough to name a session in a list and useless for reading it. The
 * full text is read here, for the one session actually opened, on the same rule
 * as `runs.ts`: counters live in the index, content stays on disk.
 *
 * Two shapes of first turn exist in the logs and they mean different things:
 * free text the person typed, and a slash-command envelope
 * (`<command-name>/foo</command-name>`) whose real body arrives on the NEXT
 * user line, flagged `isMeta`. For a spend analyzer the expansion is the
 * interesting half — it is what the model was actually charged for — so both
 * are returned and the caller decides what to show.
 */

import fs from 'node:fs';
import readline from 'node:readline';

import { textOf } from './parse.ts';

/** Enough to read any real prompt; a guard against a pasted megabyte. */
const CAP = 20000;

export interface PromptText {
  text: string;
  /** Length before clipping — a prompt cut here still reports its real size. */
  chars: number;
  truncated: boolean;
}

export interface RootPrompt extends PromptText {
  ts: number;
  /** Set when the session opened with a slash command instead of free text. */
  command: string | null;
  /** Everything typed after the command — often the actual request. */
  args: string | null;
  /** What that command expanded into: the text the model actually received. */
  expansion: PromptText | null;
}

function clip(s: string): PromptText {
  const t = s.trim();
  return t.length > CAP
    ? { text: t.slice(0, CAP) + '…', chars: t.length, truncated: true }
    : { text: t, chars: t.length, truncated: false };
}

const tag = (s: string, name: string): string | null => {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  const v = m?.[1]?.trim();
  return v ? v : null;
};

/**
 * Strip the wrappers the harness adds around a turn. What is left is what the
 * person meant to say — an empty result means this line carried no prompt at
 * all (a lone system reminder, a command echo) and is not the root.
 */
function stripEnvelope(s: string): string {
  return s
    .replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replaceAll(/<command-(message|name|args)>[\s\S]*?<\/command-\1>/g, '')
    .replaceAll(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, '')
    .trim();
}

/** The first human turn of one file, plus the expansion that followed it. */
async function firstPromptOf(file: string): Promise<RootPrompt | null> {
  if (!fs.existsSync(file)) return null;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let found: RootPrompt | null = null;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'user' || o.isSidechain) continue;

      const raw = textOf(o.message?.content);
      if (!raw) continue;

      if (found) {
        // What follows a slash command says which kind of command it was: an
        // `isMeta` body means it expanded into the context, a local-command
        // stdout means the harness handled it (`/model`, `/clear`) and nothing
        // was ever sent — so that line was not the session's prompt after all.
        if (o.isMeta) {
          found.expansion = clip(raw);
          break;
        }
        if (/^\s*<local-command-(stdout|stderr)>/.test(raw)) {
          found = null;
          continue;
        }
        break;
      }

      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
      const command = tag(raw, 'command-name');
      const args = command ? tag(raw, 'command-args') : null;
      const body = stripEnvelope(raw);
      if (!command && !body) continue; // a bare tool result or reminder line

      found = {
        // `text` is the line as typed — command and arguments together — so a
        // copy of it reproduces what started the session; the UI splits them.
        ...clip(command ? [command, args, body].filter(Boolean).join(' ') : body),
        ts: Number.isFinite(ts) ? ts : 0,
        command,
        args: args ? clip(args).text : null,
        expansion: null,
      };
      // A free-text prompt has nothing following it worth pairing up.
      if (!command) break;
    }
  } finally {
    rl.close();
  }
  return found;
}

/**
 * Root prompt across a session's main-thread files. Normally that is one file;
 * when a session was resumed into a second one, the earliest turn wins.
 */
export async function rootPrompt(files: string[]): Promise<RootPrompt | null> {
  const found = (await Promise.all(files.map(firstPromptOf))).filter(
    (p): p is RootPrompt => p != null
  );
  if (!found.length) return null;
  return found.reduce((a, b) => (b.ts && b.ts < a.ts ? b : a));
}
