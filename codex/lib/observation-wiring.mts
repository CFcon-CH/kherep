/** Validate the observation-owned native hook entries without rewriting other groups. */
import path from 'node:path';
import { command, contextCommand, hookGroup } from './parity-config.mts';
import { managedNodePaths } from './node-path.mts';
import { isToolApprovalTable } from './tool-approval-tables.mts';
import { scanDocument, structure, type ScannedTable, type Span } from './toml-block-structure.mts';
const START = '# >>> Kherep Codex Maestro >>>', END = '# <<< Kherep Codex Maestro <<<';
export interface ContextCommandEdit extends Span {
    before: string;
    after: string;
    tableSpan: Span;
}
export function observationWiring(config: string, home: string, node: string, workspace: string): {
    contextEdits: ContextCommandEdit[];
    messagingStart?: number;
    node: string;
} {
    const doc = scanDocument(config);
    structure(doc, new Set());
    const start = config.indexOf(START), end = config.indexOf(END);
    const inside = (table: ScannedTable) => table.span.start > start && table.span.start < end;
    const nodes = [node, ...managedNodePaths(config, START, END, node)];
    const hookDir = path.join(home, 'hooks', 'kherep-maestro');
    const context = path.join(home, 'hooks', 'kherep-maestro-context.mts');
    const events = ['UserPromptSubmit', 'SessionStart'];
    const entries = events.map(event => {
        const found = doc.tables.filter(t => t.array && t.path.join('.') === `hooks.${event}.hooks`
            && t.payload.some(line => line.includes('kherep-maestro-context.mts')));
        if (found.length !== 1 || !inside(found[0])) throw new Error('observation-context-wiring-drift');
        return found[0];
    });
    // The whole pair must have one generation, executable and platform form.
    const variants = nodes.flatMap(executable => [true, false].flatMap(windows =>
        [undefined, workspace].map(binding => ({ executable, windows, binding }))));
    const selected = variants.find(({ executable, windows, binding }) => entries.every((entry, index) => {
        const cmd = contextCommand(executable, context, binding);
        const expected = scanDocument(hookGroup(events[index], '', [{ command: cmd,
            ...(windows ? { commandWindows: `& ${cmd}` } : {}),
            status: events[index] === 'SessionStart' ? 'Loading Kherep Maestro' : 'Applying evidence-first routing' }])).tables[1].payload;
        return JSON.stringify(expected) === JSON.stringify(entry.payload);
    }));
    if (!selected) throw new Error('observation-context-wiring-drift');
    const selectedNode = selected.executable;
    const contextEdits: ContextCommandEdit[] = [];
    if (selected.binding === undefined) for (const entry of entries) {
        const old = contextCommand(selectedNode, context), next = contextCommand(selectedNode, context, workspace);
        for (const [key, prefix] of [['command', ''], ...(selected.windows ? [['commandWindows', '& ']] : [])]) {
            const before = `${key} = ${JSON.stringify(prefix + old)}`, after = `${key} = ${JSON.stringify(prefix + next)}`;
            const text = config.slice(entry.span.start, entry.span.end);
            const offset = text.indexOf(before);
            if (offset < 0 || text.indexOf(before, offset + before.length) >= 0) throw new Error('observation-context-wiring-drift');
            const start = entry.span.start + offset;
            contextEdits.push({ start, end: start + before.length, before, after, tableSpan: entry.span });
        }
    }
    contextEdits.sort((a, b) => a.start - b.start);
    const resultGroups = doc.tables.filter(t => t.array && t.path.join('.') === 'hooks.SubagentStop'
        && t.payload.some(line => /^matcher\s*=\s*["']codex-obs["']\s*$/.test(line)));
    if (resultGroups.length !== 1 || !inside(resultGroups[0]))
        throw new Error('observation-result-wiring-drift');
    const group = resultGroups[0];
    const next = doc.tables.find(t => t.span.start > group.span.start && !(t.path[0] === 'hooks' && t.path[1] === 'SubagentStop' && t.path.length > 2));
    const fragment = config.slice(group.span.start, Math.min(next?.span.start ?? end, end)).trim();
    const executable = selectedNode!;
    const resultVariants = [true, false].map(windows => {
        const cmd = command(executable, path.join(hookDir, 'codex-obs-result-check.mts'));
        return hookGroup('SubagentStop', 'codex-obs', [{ command: cmd, ...(windows ? { commandWindows: `& ${cmd}` } : {}) }]);
    });
    if (!resultVariants.includes(fragment))
        throw new Error('observation-result-wiring-drift');
    // Issue #921: a tool approval table the Codex app wrote is the operator's, not drift.
    const tables = doc.tables.filter(t => t.path[0] === 'mcp_servers' && t.path[1] === 'kherep_observations' && !isToolApprovalTable(t));
    if (tables.some(t => t.path.length !== 2 || t.array || t.payload[0] !== '[mcp_servers.kherep_observations]') || tables.length > 1)
        throw new Error('observation-tool-table-drift');
    const messaging = doc.tables.filter(t => inside(t) && t.path.join('.') === 'mcp_servers.kherep_messaging');
    if (messaging.length > 1)
        throw new Error('observation-tool-table-drift');
    return { messagingStart: messaging[0]?.span.start, node: selectedNode, contextEdits };
}
