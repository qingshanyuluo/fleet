import type { CardState, ToolCall, PendingQuestion } from './types.js';
import type { ProjectInfo } from './projects.js';

const MAX_RESPONSE_LENGTH = 28000;

function colorForStatus(status: string): string {
  switch (status) {
    case 'thinking': return 'blue';
    case 'running': return 'blue';
    case 'complete': return 'green';
    case 'error': return 'red';
    case 'waiting_for_input': return 'yellow';
    default: return 'grey';
  }
}

function iconForStatus(status: string): string {
  switch (status) {
    case 'thinking': return '…';
    case 'running': return '▶';
    case 'complete': return '✓';
    case 'error': return '✗';
    case 'waiting_for_input': return '?';
    default: return '•';
  }
}

function truncate(text: string, maxLen: number = MAX_RESPONSE_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n... (truncated)';
}

function toolCallLine(tc: ToolCall): string {
  return `${tc.status === 'done' ? '✓' : '⟳'} **${tc.name}** — ${tc.detail}`;
}

function questionBlock(q: PendingQuestion): any[] {
  const currentQ = q.questions[0];
  if (!currentQ) return [{ tag: 'div', text: { tag: 'lark_md', content: '_Waiting..._' } }];
  const options = currentQ.options.map((opt, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${i + 1}. ${opt.label}` },
    type: 'default',
    value: { action: 'answer_question', toolUseId: q.toolUseId, optionIndex: i },
  }));
  return [
    { tag: 'div', text: { tag: 'lark_md', content: `**${currentQ.question || currentQ.header}**` } },
    { tag: 'action', actions: options },
  ];
}

export function buildCard(state: CardState): string {
  const elements: any[] = [];

  if (state.userPrompt) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**You:** ${state.userPrompt.slice(0, 500)}` } });
    elements.push({ tag: 'hr' });
  }

  if (state.toolCalls.length > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**Tools:**\n${state.toolCalls.map(toolCallLine).join('\n')}` } });
    elements.push({ tag: 'hr' });
  }

  if (state.responseText) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: truncate(state.responseText) } });
  } else if (state.status === 'thinking') {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_Thinking..._' } });
  }

  if (state.pendingQuestion && state.status === 'waiting_for_input') {
    elements.push({ tag: 'hr' });
    elements.push(...questionBlock(state.pendingQuestion));
  }

  if (state.errorMessage) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `❌ **Error:** ${state.errorMessage}` } });
  }

  const statsParts: string[] = [];
  if (state.costUsd) statsParts.push(`$${state.costUsd.toFixed(3)}`);
  if (state.durationMs) statsParts.push(state.durationMs >= 60_000 ? `${(state.durationMs / 60_000).toFixed(1)}min` : `${(state.durationMs / 1000).toFixed(0)}s`);
  if (state.model) statsParts.push(state.model.replace(/^claude-/, ''));
  if (state.totalTokens && state.contextWindow) statsParts.push(`${Math.round((state.totalTokens / state.contextWindow) * 100)}% ctx`);
  if (statsParts.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: statsParts.join(' · ') }] });
  }

  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${iconForStatus(state.status)} ${state.status === 'waiting_for_input' ? 'Waiting' : state.status === 'thinking' ? 'Thinking' : state.status === 'running' ? 'Running' : state.status === 'complete' ? 'Done' : 'Error'}` },
      template: colorForStatus(state.status),
    },
    elements,
  });
}

export function buildTextCard(title: string, content: string, color: string = 'blue'): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: color },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: content } }],
  });
}

// Minimal session type for card display (no DB dependency)
interface SessionItem {
  id: string; rootMessageId: string | null; claudeSessionId: string | null;
  folder: string; title: string; status: string; updatedAt: number;
}

export function buildSessionListCard(
  sessions: SessionItem[],
  folder: string,
  claudeSessions?: Array<{ title: string; time: number; sessionId: string }>,
  workingDir?: string,
  activeSessions?: Set<string>,
): string {
  const elements: any[] = [];
  const total = sessions.length + (claudeSessions?.length || 0);

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `📁 **Folder:** \`${folder}\`\n${total} session(s) — ${sessions.length} fleet, ${claudeSessions?.length || 0} Claude` },
  });
  elements.push({ tag: 'hr' });

  for (const s of sessions) {
    const time = new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const title = (s.title || '(untitled)').slice(0, 40);
    const fleetActive = s.claudeSessionId && activeSessions?.has(s.claudeSessionId);

    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `${fleetActive ? '🟢' : '●'} **${title}**\n${time} · fleet${fleetActive ? ' (active elsewhere)' : ''}` },
    });
    elements.push({
      tag: 'action',
      actions: fleetActive
        ? [{ tag: 'button', text: { tag: 'plain_text', content: '🟢 In use — Fork' }, type: 'default', value: { action: 'fork', sessionId: s.id } }]
        : [
          { tag: 'button', text: { tag: 'plain_text', content: '⑂ Fork' }, type: 'default', value: { action: 'fork', sessionId: s.id } },
          { tag: 'button', text: { tag: 'plain_text', content: '✕ Archive' }, type: 'danger', value: { action: 'archive', sessionId: s.id } },
        ],
    });
    elements.push({ tag: 'hr' });
  }

  if (claudeSessions && claudeSessions.length > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**Claude History (${claudeSessions.length}):**` } });
    elements.push({ tag: 'hr' });

    const withButtons = claudeSessions.slice(0, 20);
    for (const cs of withButtons) {
      const title = (cs.title || '(no prompt)').slice(0, 80);
      const timeStr = cs.time > 0 ? new Date(cs.time).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const isRunning = activeSessions?.has(cs.sessionId) ?? false;

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${isRunning ? '🟢' : ''} **${title}**\n${timeStr} · \`${cs.sessionId.slice(0, 8)}...\`` },
      });
      elements.push({
        tag: 'action',
        actions: isRunning
          ? [{ tag: 'button', text: { tag: 'plain_text', content: '🟢 Running — Fork' }, type: 'default', value: { action: 'fork_claude', sessionId: cs.sessionId, title, workingDir: workingDir || '' } }]
          : [{ tag: 'button', text: { tag: 'plain_text', content: '▶ Resume' }, type: 'primary', value: { action: 'resume_claude', sessionId: cs.sessionId, title, workingDir: workingDir || '' } }],
      });
      elements.push({ tag: 'hr' });
    }

    const totalShown = withButtons.length;
    if (claudeSessions.length > totalShown) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `_... and ${claudeSessions.length - totalShown} more sessions_` } });
    }
  }

  if (sessions.length === 0 && (!claudeSessions || claudeSessions.length === 0)) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_No sessions. Send a message to start one._' } });
  }

  // Quick actions
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '➕ New Session' }, type: 'primary', value: { action: 'new_session' } },
      { tag: 'button', text: { tag: 'plain_text', content: '📂 Projects' }, type: 'default', value: { action: 'cmd', cmd: 'projects' } },
    ],
  });

  return JSON.stringify({
    config: { update_multi: false, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📋 Sessions' }, template: 'blue' },
    elements,
  });
}

export function buildProjectListCard(projects: ProjectInfo[], currentDir: string): string {
  const elements: any[] = [];
  if (projects.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_No Claude Code projects found._' } });
  } else {
    const withButtons = projects.slice(0, 12);
    for (const p of withButtons) {
      const isCurrent = p.dir === currentDir;
      const timeStr = p.lastActivity > 0 ? new Date(p.lastActivity).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${isCurrent ? '●' : ''} **${p.name}**\n\`${p.dir}\` · ${p.sessionCount} sessions · ${timeStr}` },
      });
      if (!isCurrent) {
        elements.push({
          tag: 'action',
          actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📁 Switch' }, type: 'primary', value: { action: 'cmd', cmd: `folder ${p.name}` } }],
        });
      }
      elements.push({ tag: 'hr' });
    }
    const remaining = projects.slice(12);
    if (remaining.length > 0) {
      const lines = remaining.map(p => `· **${p.name}** — ${p.sessionCount} sessions · \`/folder ${p.name}\``);
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } });
    }
  }
  // Quick actions at the bottom
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '➕ New' }, type: 'primary', value: { action: 'new_session' } },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `📂 Claude Projects (${projects.length})` }, template: 'blue' },
    elements,
  });
}

export function buildDashCard(
  folder: string, workingDir: string,
  recentSessions: SessionItem[],
  folderNames: string[],
): string {
  const elements: any[] = [];
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `📁 **${folder}**\n\`${workingDir}\`` } });
  elements.push({ tag: 'hr' });

  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '➕ New' }, type: 'primary', value: { action: 'new_session' } },
      { tag: 'button', text: { tag: 'plain_text', content: '📂 Projects' }, type: 'default', value: { action: 'cmd', cmd: 'projects' } },
      { tag: 'button', text: { tag: 'plain_text', content: '📋 Sessions' }, type: 'default', value: { action: 'cmd', cmd: 'list' } },
    ],
  });

  const shown = folderNames.filter(f => f !== folder).slice(0, 6);
  if (shown.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**Quick Switch:**' } });
    const buttons = shown.map(f => ({ tag: 'button', text: { tag: 'plain_text', content: f }, type: 'default' as const, value: { action: 'cmd', cmd: `folder ${f}` } }));
    for (let i = 0; i < buttons.length; i += 3) {
      elements.push({ tag: 'action', actions: buttons.slice(i, i + 3) });
    }
  }

  if (recentSessions.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**Recent:**' } });
    for (const s of recentSessions.slice(0, 3)) {
      const time = new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `· ${s.title || '(untitled)'} — ${time}` } });
    }
  }

  return JSON.stringify({
    config: { update_multi: false, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🏠 Fleet' }, template: 'blue' },
    elements,
  });
}

export function buildForkCard(parentTitle: string, workingDir: string, folder: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '⑂ Forked Session' }, template: 'blue' },
    elements: [{
      tag: 'div',
      text: { tag: 'lark_md', content: `**Forked from:** ${parentTitle}\n**Working directory:** \`${workingDir}\`\n**Folder:** \`${folder}\`\n\nReply to continue.` },
    }],
  });
}
