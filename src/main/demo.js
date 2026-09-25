'use strict';
// `npm run demo` — a ~30 s scripted showcase for recording a GIF or showing
// the cat to someone. Runs on a throwaway profile (none of your history,
// memory or config), with random idle animations off and a scripted chat,
// so every take is identical and nothing private or billable happens.

const TIMELINE = [
  // [ms from start, step]
  [2000, { cat: 'blink' }],
  [3800, { cat: 'blink' }],
  [4150, { cat: 'blink' }],
  [6000, { cat: 'yawn' }],
  [9000, { cat: 'smile' }],
  [12000, { cat: 'say', key: 'quip' }],
  [16500, { cat: 'phase' }],
  [18600, { cat: 'menuOpen' }],   // shows off fur, claws, model, language…
  [21600, { cat: 'menuClose' }],
  [22200, { chat: 'open' }],
  [23000, { chat: 'user', turn: 0 }],
  [23400, { chat: 'thinking', turn: 0 }],
  [25000, { chat: 'reply', turn: 0 }],
  [26200, { chat: 'user', turn: 1 }],
  [26600, { chat: 'thinking', turn: 1 }],
  [28300, { chat: 'reply', turn: 1 }],
];

function runDemo({ persona, catAction, emitChat, openChat }) {
  const timers = TIMELINE.map(([at, step]) => setTimeout(() => {
    const d = persona().demo;
    if (step.cat === 'say') return catAction({ action: 'say', text: d[step.key], duration: 4000 });
    if (step.cat) return catAction({ action: step.cat });
    if (step.chat === 'open') return openChat();
    const turn = d.chat[step.turn];
    const id = 1000 + step.turn;
    if (step.chat === 'user') emitChat({ type: 'user', origin: 'chat', text: turn.user, image: null });
    if (step.chat === 'thinking') emitChat({ type: 'thinking', id, text: persona().lines.thinking });
    if (step.chat === 'reply') {
      const cmd = turn.reply.match(/^\s*CMD:\s*(.+)$/im);
      emitChat({ type: 'reply', id, text: turn.reply, cmd: cmd ? cmd[1].trim() : null });
    }
  }, at));
  return () => timers.forEach(clearTimeout);
}

module.exports = { runDemo, TIMELINE };
