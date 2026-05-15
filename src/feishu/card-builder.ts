import type { CardState, ToolCall, PendingQuestion } from '../types.js';
import type { ProjectInfo } from '../core/projects.js';

const MAX_RESPONSE_LENGTH = 28000;

/** A Feishu card component (simplified type for card building) */
interface CardComponent {
  tag: string;
  text?: Record<string, unknown>;
  content?: string;
  actions?: CardComponent[];
  elements?: CardComponent[];
  title?: Record<string, unknown>;
  template?: string;
  config?: Record<string, unknown>;
  header?: Record<string, unknown>;
  type?: string;
  value?: Record<string, unknown>;
  overflow?: Record<string, unknown>;
  options?: Record<string, unknown>[];
  layout?: string;
}

function colorForStatus(status: string): string {
  switch (status) {
    case 'thinking':
      return 'blue';
    case 'running':
      return 'blue';
    case 'complete':
      return 'green';
    case 'error':
      return 'red';
    case 'waiting_for_input':
      return 'yellow';
    default:
      return 'grey';
  }
}

function iconForStatus(status: string): string {
  switch (status) {
    case 'thinking':
      return '…';
    case 'running':
      return '▶';
    case 'complete':
      return '✓';
    case 'error':
      return '✗';
    case 'waiting_for_input':
      return '?';
    default:
      return '•';
  }
}

function truncate(text: string, maxLen: number = MAX_RESPONSE_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n... (truncated)';
}

function toolCallLine(tc: ToolCall): string {
  return `${tc.status === 'done' ? '✓' : '⟳'} **${tc.name}** — ${tc.detail}`;
}

function questionBlock(q: PendingQuestion): CardComponent[] {
  const currentQ = q.questions[0];
  if (!currentQ) return [{ tag: 'div', text: { tag: 'lark_md', content: '_Waiting..._' } }];
  const options: CardComponent[] = currentQ.options.map((opt, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${i + 1}. ${opt.label}` },
    type: 'default',
    value: { action: 'answer_question', toolUseId: q.toolUseId, optionIndex: i, sessionId: q.sessionId || '' },
  }));
  return [
    { tag: 'div', text: { tag: 'lark_md', content: `**${currentQ.question || currentQ.header}**` } },
    { tag: 'action', actions: options },
  ];
}

/** Parse markdown table into JSON 2.0 table component */
function parseMarkdownTable(text: string): { before: string; table: Record<string, unknown>; after: string } | null {
  const lines = text.split('\n');
  let tableStart = -1;
  let tableEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|') && line.includes('|')) {
      if (tableStart === -1) tableStart = i;
      tableEnd = i;
    } else if (tableStart !== -1) {
      break;
    }
  }

  if (tableStart === -1 || tableEnd - tableStart < 2) return null;

  const tableLines = lines.slice(tableStart, tableEnd + 1);
  const headerLine = tableLines[0];
  const separatorLine = tableLines[1];

  // Validate separator (must be |---|---|)
  if (!separatorLine.replace(/[\s|:-]/g, '').length === false && !/\|[\s:-]+\|/.test(separatorLine)) return null;

  const parseRow = (line: string) =>
    line.split('|').slice(1, -1).map((cell) => cell.trim());

  const headers = parseRow(headerLine);
  if (headers.length < 2) return null;

  const columns = headers.map((h, i) => ({
    name: `col_${i}`,
    display_name: h,
    data_type: 'text' as const,
    width: 'auto' as const,
  }));

  const rows = tableLines.slice(2).map((line) => {
    const cells = parseRow(line);
    const row: Record<string, string> = {};
    headers.forEach((_, i) => {
      row[`col_${i}`] = cells[i] || '';
    });
    return row;
  });

  if (rows.length === 0) return null;

  return {
    before: lines.slice(0, tableStart).join('\n').trim(),
    table: {
      tag: 'table',
      columns,
      rows,
      row_height: 'low',
      header_style: { bold: true },
    },
    after: lines.slice(tableEnd + 1).join('\n').trim(),
  };
}

export function buildCard(state: CardState): string {
  const elements: Record<string, unknown>[] = [];

  if (state.userPrompt) {
    elements.push({ tag: 'markdown', content: `**You:** ${state.userPrompt.slice(0, 500)}` });
    elements.push({ tag: 'hr' });
  }

  if (state.toolCalls.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `**Tools:**\n${state.toolCalls.map(toolCallLine).join('\n')}`,
    });
    elements.push({ tag: 'hr' });
  }

  if (state.responseText) {
    const text = truncate(state.responseText);
    const parsed = parseMarkdownTable(text);
    if (parsed) {
      if (parsed.before) elements.push({ tag: 'markdown', content: parsed.before });
      elements.push(parsed.table);
      if (parsed.after) elements.push({ tag: 'markdown', content: parsed.after });
    } else {
      elements.push({ tag: 'markdown', content: text });
    }
  } else if (state.status === 'thinking') {
    elements.push({ tag: 'markdown', content: '_Thinking..._' });
  }

  if (state.pendingQuestion && state.status === 'waiting_for_input') {
    elements.push({ tag: 'hr' });
    const q = state.pendingQuestion;
    const currentQ = q.questions[0];
    if (currentQ) {
      elements.push({ tag: 'markdown', content: `**${currentQ.question || currentQ.header}**` });
      for (let i = 0; i < currentQ.options.length; i++) {
        const opt = currentQ.options[i];
        elements.push({
          tag: 'button',
          text: { tag: 'plain_text', content: `${opt.label}` },
          type: i === 0 ? 'primary' : 'default',
          behaviors: [{ type: 'callback', value: { action: 'answer_question', toolUseId: q.toolUseId, optionIndex: i, sessionId: q.sessionId || '' } }],
        });
      }
    }
  }

  if (state.errorMessage) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `❌ **Error:** ${state.errorMessage}` });
  }

  const statsParts: string[] = [];
  if (state.costUsd) statsParts.push(`$${state.costUsd.toFixed(3)}`);
  if (state.durationMs)
    statsParts.push(
      state.durationMs >= 60_000
        ? `${(state.durationMs / 60_000).toFixed(1)}min`
        : `${(state.durationMs / 1000).toFixed(0)}s`,
    );
  if (state.model) statsParts.push(state.model.replace(/^claude-/, ''));
  if (state.totalTokens && state.contextWindow)
    statsParts.push(`${Math.round((state.totalTokens / state.contextWindow) * 100)}% ctx`);
  if (statsParts.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `_${statsParts.join(' · ')}_` });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: {
        tag: 'plain_text',
        content:
          state.status === 'thinking'
            ? state.userPrompt.slice(0, 50)
            : `${iconForStatus(state.status)} ${
                state.status === 'waiting_for_input'
                  ? 'Waiting'
                  : state.status === 'running'
                    ? 'Running'
                    : state.status === 'complete'
                      ? 'Done'
                      : 'Error'
              }`,
      },
      template: colorForStatus(state.status),
    },
    body: { elements },
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
  id: string;
  rootMessageId: string | null;
  claudeSessionId: string | null;
  folder: string;
  title: string;
  status: string;
  updatedAt: number;
}

export function buildSessionListCard(
  sessions: SessionItem[],
  folder: string,
  claudeSessions?: Array<{ title: string; time: number; sessionId: string }>,
  workingDir?: string,
  activeSessions?: Set<string>,
  sessionPreviews?: Map<string, string>,
  page: number = 0,
): string {
  const PAGE_SIZE = 5;
  const allClaude = claudeSessions || [];
  const total = sessions.length + allClaude.length;
  const elements: Record<string, unknown>[] = [];

  // Merge fleet + claude into one list, fleet first
  const merged: Array<{ type: 'fleet' | 'claude'; id: string; claudeId: string | null; title: string; time: number; isRunning: boolean }> = [];
  for (const s of sessions) {
    const fleetActive = !!(s.claudeSessionId && activeSessions?.has(s.claudeSessionId));
    merged.push({ type: 'fleet', id: s.id, claudeId: s.claudeSessionId, title: s.title || '(untitled)', time: s.updatedAt, isRunning: fleetActive });
  }
  for (const cs of allClaude) {
    const isRunning = activeSessions?.has(cs.sessionId) ?? false;
    merged.push({ type: 'claude', id: cs.sessionId, claudeId: cs.sessionId, title: cs.title || '(no prompt)', time: cs.time, isRunning });
  }

  const totalPages = Math.max(1, Math.ceil(merged.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageItems = merged.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  elements.push({ tag: 'markdown', content: `📁 **\`${folder}\`** · ${total} session(s) · page ${currentPage + 1}/${totalPages}` });

  for (const item of pageItems) {
    const timeStr = item.time > 0
      ? new Date(item.time).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const label = `${item.isRunning ? '🟢' : '●'} ${item.title.slice(0, 55)} · ${timeStr}`.trim();
    const preview = (item.claudeId && sessionPreviews?.get(item.claudeId)) || '';

    const panelElements: Record<string, unknown>[] = [];
    if (preview) {
      panelElements.push({ tag: 'markdown', content: preview });
    }

    if (item.type === 'fleet') {
      panelElements.push({ tag: 'button', text: { tag: 'plain_text', content: '⑂ Fork' }, type: 'default', behaviors: [{ type: 'callback', value: { action: 'fork', sessionId: item.id } }] });
      if (!item.isRunning) {
        panelElements.push({ tag: 'button', text: { tag: 'plain_text', content: '✕ Archive' }, type: 'danger', behaviors: [{ type: 'callback', value: { action: 'archive', sessionId: item.id } }] });
      }
    } else {
      if (item.isRunning) {
        panelElements.push({ tag: 'button', text: { tag: 'plain_text', content: '👀 Watch' }, type: 'primary', behaviors: [{ type: 'callback', value: { action: 'watch_session', sessionId: item.id, title: item.title, workingDir: workingDir || '' } }] });
        panelElements.push({ tag: 'button', text: { tag: 'plain_text', content: '🟢 Fork' }, type: 'default', behaviors: [{ type: 'callback', value: { action: 'fork_claude', sessionId: item.id, title: item.title, workingDir: workingDir || '' } }] });
      } else {
        panelElements.push({ tag: 'button', text: { tag: 'plain_text', content: '▶ Resume' }, type: 'primary', behaviors: [{ type: 'callback', value: { action: 'resume_claude', sessionId: item.id, title: item.title, workingDir: workingDir || '' } }] });
      }
    }

    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: label },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      elements: panelElements,
    });
  }

  if (total === 0) {
    elements.push({ tag: 'markdown', content: '_No sessions. Send a message to start one._' });
  }

  // Pagination + quick actions
  elements.push({ tag: 'hr' });
  if (currentPage > 0) {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '← Prev' }, type: 'default', behaviors: [{ type: 'callback', value: { action: 'list_page', page: currentPage - 1 } }] });
  }
  if (currentPage < totalPages - 1) {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: 'Next →' }, type: 'default', behaviors: [{ type: 'callback', value: { action: 'list_page', page: currentPage + 1 } }] });
  }
  elements.push({ tag: 'button', text: { tag: 'plain_text', content: '➕ New Session' }, type: 'primary', behaviors: [{ type: 'callback', value: { action: 'new_session' } }] });
  elements.push({ tag: 'button', text: { tag: 'plain_text', content: '📂 Projects' }, type: 'default', behaviors: [{ type: 'callback', value: { action: 'cmd', cmd: 'projects' } }] });

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '📋 Sessions' }, template: 'blue' },
    body: { elements },
  });
}

export function buildProjectListCard(projects: ProjectInfo[], currentDir: string): string {
  const elements: CardComponent[] = [];
  if (projects.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_No Claude Code projects found._' } });
  } else {
    const withButtons = projects.slice(0, 12);
    for (const p of withButtons) {
      const isCurrent = p.dir === currentDir;
      const timeStr =
        p.lastActivity > 0
          ? new Date(p.lastActivity).toLocaleString('zh-CN', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '';
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${isCurrent ? '●' : ''} **${p.name}**\n\`${p.dir}\` · ${p.sessionCount} sessions · ${timeStr}`,
        },
      });
      if (!isCurrent) {
        elements.push({
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '📁 Switch' },
              type: 'primary',
              value: { action: 'cmd', cmd: `folder ${p.name}` },
            },
          ],
        });
      }
      elements.push({ tag: 'hr' });
    }
    const remaining = projects.slice(12);
    if (remaining.length > 0) {
      const lines = remaining.map(
        (p) => `· **${p.name}** — ${p.sessionCount} sessions · \`/folder ${p.name}\``,
      );
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } });
    }
  }
  // Quick actions at the bottom
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '➕ New' },
        type: 'primary',
        value: { action: 'new_session' },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📂 Claude Projects (${projects.length})` },
      template: 'blue',
    },
    elements,
  });
}

export function buildDashCard(
  folder: string,
  workingDir: string,
  recentSessions: SessionItem[],
  folderNames: string[],
): string {
  const elements: CardComponent[] = [];
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `📁 **${folder}**\n\`${workingDir}\`` } });
  elements.push({ tag: 'hr' });

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '➕ New' },
        type: 'primary',
        value: { action: 'new_session' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📂 Projects' },
        type: 'default',
        value: { action: 'cmd', cmd: 'projects' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📋 Sessions' },
        type: 'default',
        value: { action: 'cmd', cmd: 'list' },
      },
    ],
  });

  const shown = folderNames.filter((f) => f !== folder).slice(0, 6);
  if (shown.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**Quick Switch:**' } });
    const buttons: CardComponent[] = shown.map((f) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: f },
      type: 'default' as const,
      value: { action: 'cmd', cmd: `folder ${f}` },
    }));
    for (let i = 0; i < buttons.length; i += 3) {
      elements.push({ tag: 'action', actions: buttons.slice(i, i + 3) });
    }
  }

  if (recentSessions.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**Recent:**' } });
    for (const s of recentSessions.slice(0, 3)) {
      const time = new Date(s.updatedAt).toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `· ${s.title || '(untitled)'} — ${time}` },
      });
    }
  }

  return JSON.stringify({
    config: { update_multi: false, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🏠 Fleet' }, template: 'blue' },
    elements,
  });
}

export function buildForkCard(parentTitle: string, workingDir: string, folder: string): string {
  const shortTitle = parentTitle.slice(0, 30);
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: shortTitle }, template: 'blue' },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `Forked from: ${parentTitle}\n📁 \`${folder}\` → \`${workingDir}\`\n\nReply to continue.`,
        },
      },
    ],
  });
}

export function buildWatchCard(
  title: string,
  workingDir: string,
  sessionId: string,
  messages: Array<{ role: string; summary: string }>,
): string {
  const elements: CardComponent[] = [];

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `📁 \`${workingDir}\`\n🟢 **Running** — last ${messages.length} messages:` },
  });
  elements.push({ tag: 'hr' });

  if (messages.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '_No recent messages to show. The session may have just started._' },
    });
  } else {
    for (const m of messages) {
      const icon = m.role === 'user' ? '💬' : m.role === 'assistant' ? '🤖' : '📊';
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${icon} **${m.role}:** ${m.summary.slice(0, 300)}` },
      });
      elements.push({ tag: 'hr' });
    }
  }

  // Fork button
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '⑂ Fork & Continue' },
        type: 'primary',
        value: {
          action: 'fork_claude',
          sessionId,
          title,
          workingDir,
        },
      },
    ],
  });

  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `👀 ${title.slice(0, 40)}` }, template: 'green' },
    elements,
  });
}
